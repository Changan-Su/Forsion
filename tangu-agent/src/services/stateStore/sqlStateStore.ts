/**
 * SqlStateStore —— StateStore 的直连 SQL 实现(经 deps().host.query)。
 *
 * 这里的 SQL **原样**来自原 runStore / eventBus / agentLoop 内联 / todo / interaction / runs.ts;迁来收敛成
 * 单一状态层,**行为零变化**。microserver / standalone / TUI / 网关 / server 状态端点 都用它。
 * 事件的 seq/emit/持久化机制仍在 eventBus(appendEventLocal/drainLocal),本实现透传——保留其内存订阅扇出
 * (SSE)与跨重启 seq 播种不动。
 */
import { query, getOlderThanSql, getDbType, messageTimeOrder } from '../../core/db.js';
import { deps } from '../../seams/runtime.js';
import { SELF_OWNER } from '../runOwner.js';
import { appendEventLocal, drainLocal, type AgentEvent } from '../eventBus.js';
import { readSessionTranscriptInDb, searchSessionsInDb } from '../sessionSearchSql.js';
import type { AgentRun } from '../runStore.js';
import type {
  ActiveRunRow,
  FinalizeMessageInput,
  MessageStepRow,
  RawMessageRow,
  StateStore,
  StepInput,
  StepRow,
} from '../../seams/stateStore.js';

/** run 落成 done 的旁路通知。网关的云端 Historian(web/安卓按轮维护)在 startHistorian 时注册:
 *  thin worker 跑完一轮经 state-API 把 done 写进这里,是云端唯一能看到「一轮结束」的地方。
 *  worker(HttpStateStore)与 standalone(不启动云端 Historian)都不会有监听。 */
let runDoneListener: ((runId: string) => void) | null = null;
export function setRunDoneListener(fn: ((runId: string) => void) | null): void { runDoneListener = fn; }

function safeParse(s: any): any {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return s; }
}

/** 一条 SQL 语句。下面几个构造函数让 async 路径与本机 SQLite 的同步事务(host.transactionSync)共用同一份 SQL。 */
export interface SqlStmt { sql: string; params: any[] }

export function createRunStmt(run: { id: string; sessionId: string; userId: string; appId: string; modelId: string; assistantMessageId: string; input: any }): SqlStmt {
  // 本机共享库(SQLite,TUI 与桌面同指 state.db)记下持有进程:重启自愈据此不碰别的活着的引擎的 run(PI-DSH 评审 R2)。
  // ponytail: 只 SQLite 写 —— 恢复只在本机跑;云库未必迁过这一列;PGlite 回退档本就不与他端共享。
  const owner = getDbType() === 'sqlite' ? [SELF_OWNER] : [];
  return {
    sql: `INSERT INTO agent_runs (id, session_id, user_id, app_id, status, model_id, assistant_message_id, input${owner.length ? ', owner' : ''})
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?${owner.length ? ', ?' : ''})`,
    params: [run.id, run.sessionId, run.userId, run.appId, run.modelId, run.assistantMessageId, JSON.stringify(run.input ?? null), ...owner],
  };
}

/** 用户行;ON CONFLICT DO NOTHING + RETURNING:回行 = 新插的(会话活动只随新消息推进)。 */
export function insertUserRowStmt(m: { id: string; sessionId: string; content: string; modelId: string; attachments: any[] | null; timestamp?: number }): SqlStmt {
  return {
    sql: `INSERT INTO chat_messages (id, session_id, role, content, timestamp, model_id, is_error, attachments)
         VALUES (?, ?, 'user', ?, ?, ?, FALSE, ?)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
    params: [
      m.id, m.sessionId, m.content, m.timestamp ?? Date.now(), m.modelId,
      Array.isArray(m.attachments) && m.attachments.length ? JSON.stringify(m.attachments) : null,
    ],
  };
}

export const bumpSessionStmt = (sessionId: string): SqlStmt => ({ sql: `UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, params: [sessionId] });

export function finalizeMessageStmt(m: FinalizeMessageInput): SqlStmt {
  const displayFiles = Array.isArray(m.displayFiles) && m.displayFiles.length ? JSON.stringify(m.displayFiles) : null;
  return {
    sql: `INSERT INTO chat_messages (id, session_id, role, content, timestamp, model_id, reasoning, is_error, tool_calls, tool_results, attachments, display_files, agent_slug, origin)
         VALUES (?, ?, 'model', ?, ?, ?, ?, FALSE, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET ${m.restamp ? 'timestamp=EXCLUDED.timestamp, ' : ''}content=EXCLUDED.content, model_id=CASE WHEN EXCLUDED.origin IS NOT NULL THEN EXCLUDED.model_id ELSE chat_messages.model_id END, reasoning=EXCLUDED.reasoning, tool_calls=EXCLUDED.tool_calls, tool_results=EXCLUDED.tool_results, display_files=EXCLUDED.display_files, agent_slug=EXCLUDED.agent_slug, origin=COALESCE(EXCLUDED.origin, chat_messages.origin), updated_at=CURRENT_TIMESTAMP`,
    params: [
      m.messageId, m.sessionId, m.content, m.timestamp ?? Date.now(), m.modelId,
      m.reasoning || null,
      m.toolCalls.length ? JSON.stringify(m.toolCalls) : null,
      m.toolResults.length ? JSON.stringify(m.toolResults) : null,
      displayFiles,
      m.agentSlug || null,
      m.origin || null,
    ],
  };
}

export function runStatusStmt(id: string, status: string, extra?: { result?: any; error?: string; currentStep?: number; tokensTotal?: number }): SqlStmt {
  const sets: string[] = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
  const params: any[] = [status];
  if (extra?.result !== undefined) { sets.push('result = ?'); params.push(JSON.stringify(extra.result)); }
  if (extra?.error !== undefined) { sets.push('error = ?'); params.push(extra.error); }
  if (extra?.currentStep !== undefined) { sets.push('current_step = ?'); params.push(extra.currentStep); }
  if (extra?.tokensTotal !== undefined) { sets.push('tokens_total = ?'); params.push(extra.tokensTotal); }
  // 被停下那一刻(评审 #10):过期 / 崩溃计数按它算,之后再改这一行(认领、补说明)不挪动基准。interrupted 只在本机恢复宿主上出现。
  if (status === 'interrupted') sets.push('interrupted_at = COALESCE(interrupted_at, CURRENT_TIMESTAMP)');
  params.push(id);
  return { sql: `UPDATE agent_runs SET ${sets.join(', ')} WHERE id = ?`, params };
}

/** 本机 SQLite 的同步事务;别的库没有 → null(调用方逐条写)。 */
function syncTx(): (<T>(fn: (run: (sql: string, params?: any[]) => any[]) => T) => T) | null {
  const h = deps().host;
  return typeof h.transactionSync === 'function' ? h.transactionSync.bind(h) as any : null;
}

/** tool_results 里按 tool_call_id 换掉对应项(没有的不加)。 */
function patchResults(raw: unknown, entries: any[]): any[] | null {
  let list: any;
  try { list = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!Array.isArray(list)) return null;
  const byId = new Map(entries.filter((e) => e && typeof e.tool_call_id === 'string').map((e) => [e.tool_call_id, e]));
  return list.map((r: any) => (r && byId.has(r.tool_call_id) ? byId.get(r.tool_call_id) : r));
}

export function createSqlStateStore(): StateStore {
  return {
    // ── runs ──
    async createRun(run) {
      const st = createRunStmt(run);
      await query(st.sql, st.params);
    },
    async getRun(id): Promise<AgentRun | null> {
      const rows = await query<any[]>(`SELECT * FROM agent_runs WHERE id = ? LIMIT 1`, [id]);
      return rows[0] || null;
    },
    async getRunForUser(id, userId): Promise<AgentRun | null> {
      const rows = await query<any[]>(`SELECT * FROM agent_runs WHERE id = ? AND user_id = ? LIMIT 1`, [id, userId]);
      return rows[0] || null;
    },
    async updateRunStatus(id, status, extra) {
      const st = runStatusStmt(id, status, extra);
      await query(st.sql, st.params);
      if (status === 'done') { try { runDoneListener?.(id); } catch { /* 监听方自己兜底,绝不影响 run 收尾 */ } }
    },
    async claimRunStart(runId) {
      const rows = await query<any[]>(
        `UPDATE agent_runs SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued' RETURNING id`, [runId],
      );
      return Array.isArray(rows) && rows.length > 0;
    },
    async completeRun(m, done) {
      const fin = finalizeMessageStmt(m);
      const bump = bumpSessionStmt(m.sessionId);
      const st = runStatusStmt(done.runId, 'done', { result: done.result, tokensTotal: done.tokensTotal });
      const tx = syncTx();
      if (tx) {
        tx((run) => { run(fin.sql, fin.params); run(bump.sql, bump.params); run(st.sql, st.params); });
      } else {
        await query(fin.sql, fin.params);
        await query(bump.sql, bump.params).catch(() => {});
        await query(st.sql, st.params);
      }
      try { runDoneListener?.(done.runId); } catch { /* 同 updateRunStatus */ }
    },
    async listActiveRunsBySession(sessionId, userId): Promise<ActiveRunRow[]> {
      return await query<any[]>(
        `SELECT id, status, assistant_message_id FROM agent_runs
         WHERE session_id = ? AND user_id = ?
         ORDER BY (status IN ('queued','running')) DESC, updated_at DESC
         LIMIT 5`,
        [sessionId, userId],
      );
    },
    async listPendingRunsForRecovery() {
      const rows = await query<any[]>(
        `SELECT id, session_id, status, owner FROM agent_runs
         WHERE status IN ('queued','running')
         ORDER BY session_id ASC, created_at ASC`,
      );
      return rows.map((r) => ({ id: r.id, session_id: r.session_id, status: r.status, owner: r.owner ?? null }));
    },
    async failStaleRuns(olderThanMinutes = 30, keepOwners: string[] = []) {
      const keep = keepOwners.length ? `AND (owner IS NULL OR owner NOT IN (${keepOwners.map(() => '?').join(',')}))` : '';
      const rows = await query<any[]>(
        `UPDATE agent_runs SET status = 'failed', error = 'stale: process restarted', updated_at = CURRENT_TIMESTAMP
         WHERE status IN ('queued','running')
           AND ${getOlderThanSql('updated_at', olderThanMinutes)}
           ${keep}
         RETURNING id`,
        keepOwners,
      );
      return Array.isArray(rows) ? rows.length : 0;
    },

    // ── steps ──
    async appendStep(step: StepInput) {
      await query(
        `INSERT INTO agent_steps (id, run_id, step_no, llm_request, llm_response, tool_calls, tool_results, state_delta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, step_no) DO NOTHING`,
        [
          step.id, step.runId, step.stepNo,
          JSON.stringify(step.llmRequest ?? null),
          JSON.stringify(step.llmResponse ?? null),
          JSON.stringify(step.toolCalls ?? null),
          JSON.stringify(step.toolResults ?? null),
          JSON.stringify(step.stateDelta ?? null),
        ],
      );
      // run 上的 current_step 是「已落步数」缓存,过去无人维护(agentLoop 终态不传 currentStep)→ 监控里
      // 步数恒 0、且 updated_at 不随步刷新致「最近」陈旧。这里在每步落库后同步缓存(取真实 COUNT,
      // 幂等于 ON CONFLICT 重放)并刷新 updated_at。是 in-process 与 thin-worker(经 stateApi 流端点)
      // 的共同汇聚点,一处修两路径;顺带让活跃 run 的 updated_at 保鲜,避免被 failStaleRuns 误判陈旧。
      await query(
        `UPDATE agent_runs
            SET current_step = (SELECT COUNT(*) FROM agent_steps WHERE run_id = ?),
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
        [step.runId, step.runId],
      );
    },
    async listSteps(runId): Promise<StepRow[]> {
      const rows = await query<any[]>(
        `SELECT step_no, llm_response, tool_calls, tool_results, created_at
         FROM agent_steps WHERE run_id = ? ORDER BY step_no ASC`,
        [runId],
      );
      return rows.map((r) => ({
        stepNo: Number(r.step_no) || 0,
        llmResponse: safeParse(r.llm_response),
        toolCalls: safeParse(r.tool_calls),
        toolResults: safeParse(r.tool_results),
        createdAt: r.created_at || null,
      }));
    },

    async listStepsForMessages(sessionId, messageIds): Promise<MessageStepRow[]> {
      if (!Array.isArray(messageIds) || !messageIds.length) return [];
      const rows = await query<any[]>(
        `SELECT r.assistant_message_id AS message_id, s.step_no, s.llm_response, s.tool_calls
           FROM agent_steps s JOIN agent_runs r ON r.id = s.run_id
          WHERE r.session_id = ? AND (r.assistant_message_id IN (${messageIds.map(() => '?').join(',')})
            OR (s.llm_response -> 'turnContext' ->> 'sourceMessageId') IN (${messageIds.map(() => '?').join(',')}))
          ORDER BY s.step_no ASC`,
        [sessionId, ...messageIds, ...messageIds],
      );
      return rows.map((r) => ({
        messageId: String(r.message_id),
        stepNo: Number(r.step_no) || 0,
        llmResponse: safeParse(r.llm_response),
        toolCalls: safeParse(r.tool_calls),
      }));
    },

    // ── events ── (透传 eventBus 本地机制:seq 播种 + emit + per-run 写链)
    appendEvent(runId, type, payload) { return appendEventLocal(runId, type, payload); },
    async purgeStreamFrames(runId) { await query(`DELETE FROM agent_run_events WHERE run_id = ? AND type IN ('token', 'reasoning')`, [runId]); },
    drain(runId) { return drainLocal(runId); },
    async listEventsFrom(runId, fromSeq): Promise<AgentEvent[]> {
      const rows = await query<any[]>(
        `SELECT seq, type, payload FROM agent_run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC`,
        [runId, fromSeq],
      );
      return rows.map((r) => ({ seq: r.seq, type: r.type, payload: safeParse(r.payload) }));
    },

    // ── messages ──
    async countSessionMessages(sessionId) {
      const rows = await query<any[]>(`SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?`, [sessionId]);
      return Number(rows[0]?.n || 0);
    },
    // 同一毫秒的几行按落库先后补排(11-20):hydrate 先数行数再按 OFFSET 取窗口,并列先后不稳定时窗口边上的那一毫秒可能取漏 / 取重
    async listSessionMessagesWindow(sessionId, limit, offset): Promise<RawMessageRow[]> {
      return await query<any[]>(
        `SELECT id, role, content, tool_calls, tool_results, attachments, timestamp FROM chat_messages
         WHERE session_id = ? ORDER BY ${messageTimeOrder('ASC')} LIMIT ? OFFSET ?`,
        [sessionId, limit, offset],
      );
    },
    async listSessionDisplayFiles(sessionId, limit) {
      const rows = await query<any[]>(
        `SELECT display_files FROM chat_messages WHERE session_id = ? AND display_files IS NOT NULL ORDER BY timestamp DESC LIMIT ?`,
        [sessionId, limit],
      );
      return rows.flatMap((r) => {
        let files = r.display_files; // PG 回对象,SQLite 回字符串
        if (typeof files === 'string') try { files = JSON.parse(files); } catch { files = null; }
        return Array.isArray(files) ? [...files].reverse() : [];
      });
    },
    async hasImageDelivery(userId, _sessionId, delivery) {
      // Query the small receipt only, never load historical base64 payloads into memory.
      const proof = getDbType() === 'sqlite'
        ? `EXISTS (SELECT 1 FROM json_each(m.display_files) f WHERE json_extract(f.value, '$.imageDelivery.id') = ? AND json_extract(f.value, '$.imageDelivery.receipt') = ?)`
        : `EXISTS (SELECT 1 FROM jsonb_array_elements(m.display_files) f WHERE f->'imageDelivery'->>'id' = ? AND f->'imageDelivery'->>'receipt' = ?)`;
      const rows = await query<any[]>(`SELECT m.id FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
        WHERE s.user_id = ? AND m.display_files IS NOT NULL AND ${proof} LIMIT 1`, [userId, delivery.id, delivery.receipt]);
      return rows.length > 0;
    },
    async correctUserMessage(m) {
      const rows = await query<any[]>(
        `UPDATE chat_messages SET content = ? WHERE id = ? AND session_id = ? AND role = 'user' AND content <> ? RETURNING id`,
        [m.content, m.id, m.sessionId, m.content],
      );
      return rows.length > 0;
    },

    async insertUserMessage(m) {
      const st = insertUserRowStmt(m);
      const inserted = await query<any[]>(st.sql, st.params);
      // 会话活动只随**新**消息推进:恢复/重试把同一 message id 再写一遍时不冒充新活动。
      if (inserted.length) { const b = bumpSessionStmt(m.sessionId); await query(b.sql, b.params).catch(() => {}); }
    },
    async finalizeAssistantMessage(m: FinalizeMessageInput) {
      const st = finalizeMessageStmt(m);
      await query(st.sql, st.params);
      const b = bumpSessionStmt(m.sessionId);
      await query(b.sql, b.params).catch(() => {});
    },
    async patchToolResults(messageId, entries) {
      const read = `SELECT tool_results FROM chat_messages WHERE id = ?`;
      const write = `UPDATE chat_messages SET tool_results = ? WHERE id = ?`;
      const tx = syncTx();
      if (tx) {
        return tx((run) => {
          const row = run(read, [messageId])[0];
          const next = row ? patchResults(row.tool_results, entries) : null;
          if (!next) return false;
          run(write, [JSON.stringify(next), messageId]);
          return true;
        });
      }
      const row = (await query<any[]>(read, [messageId]))[0];
      const next = row ? patchResults(row.tool_results, entries) : null;
      if (!next) return false;
      await query(write, [JSON.stringify(next), messageId]);
      return true;
    },
    async persistAssistantProgress(m) {
      const displayFiles = Array.isArray(m.displayFiles) && m.displayFiles.length ? JSON.stringify(m.displayFiles) : null;
      await query(
        `INSERT INTO chat_messages (id, session_id, role, content, timestamp, model_id, reasoning, is_error, tool_calls, tool_results, attachments, display_files, agent_slug, origin)
         VALUES (?, ?, 'model', ?, ?, ?, ?, FALSE, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET content=EXCLUDED.content, model_id=CASE WHEN EXCLUDED.origin IS NOT NULL THEN EXCLUDED.model_id ELSE chat_messages.model_id END, reasoning=EXCLUDED.reasoning, tool_calls=EXCLUDED.tool_calls, tool_results=EXCLUDED.tool_results, display_files=COALESCE(EXCLUDED.display_files, chat_messages.display_files), agent_slug=EXCLUDED.agent_slug, origin=COALESCE(EXCLUDED.origin, chat_messages.origin), updated_at=CURRENT_TIMESTAMP`,
        [
          m.messageId, m.sessionId, m.content, m.timestamp ?? Date.now(), m.modelId,
          m.reasoning || null,
          m.toolCalls.length ? JSON.stringify(m.toolCalls) : null,
          m.toolResults.length ? JSON.stringify(m.toolResults) : null,
          displayFiles,
          m.agentSlug || null,
          m.origin || null,
        ],
      );
      await query(`UPDATE agent_runs SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'`, [m.runId]).catch(() => {});
    },

    // ── sessions ──
    async getSessionOwner(sessionId) {
      const rows = await query<any[]>(`SELECT user_id FROM chat_sessions WHERE id = ? LIMIT 1`, [sessionId]);
      return rows[0] ? rows[0].user_id : null;
    },
    async autoCreateSession(s) {
      await query(
        `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        [s.id, s.userId, s.appId, s.title, s.modelId],
      );
    },
    async loadTodos(sessionId) {
      const rows = await query<any[]>(`SELECT todos FROM chat_sessions WHERE id = ?`, [sessionId]);
      return rows?.[0]?.todos;
    },
    async writeTodos(sessionId, todosJson) {
      await query(`UPDATE chat_sessions SET todos = ? WHERE id = ?`, [todosJson, sessionId]);
    },
    async getAgentConfig(sessionId) {
      const rows = await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ?`, [sessionId]);
      return rows?.[0]?.agent_config;
    },
    async setAgentConfig(sessionId, agentConfigJson) {
      await query(`UPDATE chat_sessions SET agent_config = ? WHERE id = ?`, [agentConfigJson, sessionId]);
    },

    // ── session recall(SQL 本体见 sessionSearchSql.ts:两方言同一条 SQL,原样从 sessionSearch.ts / readSession.ts 搬来)──
    searchSessions: (input) => searchSessionsInDb(input),
    readSessionTranscript: (input) => readSessionTranscriptInDb(input),
  };
}
