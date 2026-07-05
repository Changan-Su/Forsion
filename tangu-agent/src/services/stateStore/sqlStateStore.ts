/**
 * SqlStateStore —— StateStore 的直连 SQL 实现(经 deps().host.query)。
 *
 * 这里的 SQL **原样**来自原 runStore / eventBus / agentLoop 内联 / todo / interaction / runs.ts;迁来收敛成
 * 单一状态层,**行为零变化**。microserver / standalone / TUI / 网关 / server 状态端点 都用它。
 * 事件的 seq/emit/持久化机制仍在 eventBus(appendEventLocal/drainLocal),本实现透传——保留其内存订阅扇出
 * (SSE)与跨重启 seq 播种不动。
 */
import { query, getOlderThanSql } from '../../core/db.js';
import { appendEventLocal, drainLocal, type AgentEvent } from '../eventBus.js';
import type { AgentRun } from '../runStore.js';
import type {
  ActiveRunRow,
  FinalizeMessageInput,
  RawMessageRow,
  StateStore,
  StepInput,
  StepRow,
} from '../../seams/stateStore.js';

function safeParse(s: any): any {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return s; }
}

export function createSqlStateStore(): StateStore {
  return {
    // ── runs ──
    async createRun(run) {
      await query(
        `INSERT INTO agent_runs (id, session_id, user_id, app_id, status, model_id, assistant_message_id, input)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
        [run.id, run.sessionId, run.userId, run.appId, run.modelId, run.assistantMessageId, JSON.stringify(run.input ?? null)],
      );
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
      const sets: string[] = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
      const params: any[] = [status];
      if (extra?.result !== undefined) { sets.push('result = ?'); params.push(JSON.stringify(extra.result)); }
      if (extra?.error !== undefined) { sets.push('error = ?'); params.push(extra.error); }
      if (extra?.currentStep !== undefined) { sets.push('current_step = ?'); params.push(extra.currentStep); }
      if (extra?.tokensTotal !== undefined) { sets.push('tokens_total = ?'); params.push(extra.tokensTotal); }
      params.push(id);
      await query(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = ?`, params);
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
        `SELECT id, session_id FROM agent_runs
         WHERE status IN ('queued','running')
         ORDER BY session_id ASC, created_at ASC`,
      );
      return rows.map((r) => ({ id: r.id, session_id: r.session_id }));
    },
    async failStaleRuns(olderThanMinutes = 30) {
      const rows = await query<any[]>(
        `UPDATE agent_runs SET status = 'failed', error = 'stale: process restarted', updated_at = CURRENT_TIMESTAMP
         WHERE status IN ('queued','running')
           AND ${getOlderThanSql('updated_at', olderThanMinutes)}
         RETURNING id`,
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

    // ── events ── (透传 eventBus 本地机制:seq 播种 + emit + per-run 写链)
    appendEvent(runId, type, payload) { return appendEventLocal(runId, type, payload); },
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
    async listSessionMessagesWindow(sessionId, limit, offset): Promise<RawMessageRow[]> {
      return await query<any[]>(
        `SELECT id, role, content, tool_calls, attachments, timestamp FROM chat_messages
         WHERE session_id = ? ORDER BY timestamp ASC LIMIT ? OFFSET ?`,
        [sessionId, limit, offset],
      );
    },
    async insertUserMessage(m) {
      await query(
        `INSERT INTO chat_messages (id, session_id, role, content, timestamp, model_id, is_error, attachments)
         VALUES (?, ?, 'user', ?, ?, ?, FALSE, ?)
         ON CONFLICT (id) DO NOTHING`,
        [
          m.id, m.sessionId, m.content, Date.now(), m.modelId,
          Array.isArray(m.attachments) && m.attachments.length ? JSON.stringify(m.attachments) : null,
        ],
      );
    },
    async finalizeAssistantMessage(m: FinalizeMessageInput) {
      const displayFiles = Array.isArray(m.displayFiles) && m.displayFiles.length ? JSON.stringify(m.displayFiles) : null;
      await query(
        `INSERT INTO chat_messages (id, session_id, role, content, timestamp, model_id, reasoning, is_error, tool_calls, tool_results, attachments, display_files, agent_slug)
         VALUES (?, ?, 'model', ?, ?, ?, ?, FALSE, ?, ?, NULL, ?, ?)
         ON CONFLICT (id) DO UPDATE SET content=EXCLUDED.content, reasoning=EXCLUDED.reasoning, tool_calls=EXCLUDED.tool_calls, tool_results=EXCLUDED.tool_results, display_files=EXCLUDED.display_files, agent_slug=EXCLUDED.agent_slug, updated_at=CURRENT_TIMESTAMP`,
        [
          m.messageId, m.sessionId, m.content, Date.now(), m.modelId,
          m.reasoning || null,
          m.toolCalls.length ? JSON.stringify(m.toolCalls) : null,
          m.toolResults.length ? JSON.stringify(m.toolResults) : null,
          displayFiles,
          m.agentSlug || null,
        ],
      );
      await query(`UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [m.sessionId]).catch(() => {});
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
  };
}
