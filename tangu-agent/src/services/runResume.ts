/**
 * 启动恢复里「被停下的 run 要不要自动接着做」的判定与续跑 run 的构造(2026-11-20 中断任务续跑方案 B · E4,方案 6.4 / 6.5)。
 * 编排在 agentLoop.recoverQueuedRuns(要 enqueueRun);这里只放不依赖 agentLoop 的库查询与纯逻辑,免得成环。
 *
 * 底线(与 Claude 的 reply_not_ended、Codex 的「核对没有结束标记」同一条):只在**明确记下**是非用户原因时才续,
 * 记不清的一律不续 —— 不续 = 补一条说明原因的中断行(interruptedNoticeMarker),界面给「继续生成」。
 * 绝不从原始输入重跑(10-02 R2):续跑是新的一轮,消息是 autoResumeMarker,历史里是上一轮落库的现场。
 */
import { createHash } from 'node:crypto';
import { query, getOlderThanSql, getDbType } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { AUTO_RESUMABLE, isInterruptReason, autoResumeMarker, interruptedNoticeMarker, type InterruptReason } from '../contracts/turnResume.js';
import type { ShutdownIntent } from '../contracts/shutdownIntent.js';
import { agentEngineOf, getAgent, isValidSlug } from '../agents/agentRegistry.js';
import { accountChanged } from './cloudAccount.js';
import { bumpSessionStmt, createRunStmt, insertUserRowStmt, type SqlStmt } from './stateStore/sqlStateStore.js';

/** 同一条任务链最多自动续几次(原 run 的 resumeAttempt 从 0 起,续出来的 +1)。 */
export const MAX_AUTO_RESUMES = 2;
/** 1 小时内这个会话崩了这么多次就停下等用户(Claude 的 crash_loop_parked)。 */
export const CRASH_LOOP_LIMIT = 3;
const PLANNED_MAX_MINUTES = 24 * 60;
const CRASH_MAX_MINUTES = 2 * 60;
/** 能自动续的会话种类:普通会话、Muse、自动化。团队成员会话由团队 run 重新激活;delegate 子会话由父任务接回。 */
const RESUMABLE_KINDS = new Set(['user', 'muse', 'automation']);

const json = (v: unknown): any => {
  if (typeof v !== 'string') return v && typeof v === 'object' ? v : {};
  try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
};
export const runInput = (run: { input?: unknown } | null | undefined): any => json(run?.input);

/** 持有者 `<pid>:<启动时刻秒>` 与停引擎意图对得上:同一个 pid、意图写在那个进程启动之后。启动时不看意图的新旧 ——
 *  晚上退出、早上再开,隔夜的意图照样作数(否则落进 crash,过不了 2 小时那道门)。 */
export function intentReasonForOwner(intent: ShutdownIntent | null, owner: string | null | undefined): InterruptReason | null {
  if (!intent || !owner) return null;
  const [pidText, startText] = owner.split(':');
  const pid = Number(pidText);
  const startedAt = Number(startText);
  if (!Number.isInteger(pid) || pid !== intent.pid || !Number.isFinite(startedAt)) return null;
  return intent.at >= startedAt * 1000 - 3000 ? intent.reason : null;
}

/** error 列 `interrupted:<原因>` → 原因。 */
export function reasonFromError(error: unknown): InterruptReason | null {
  const m = /^interrupted:([a-z_]+)$/.exec(String(error || ''));
  return m && isInterruptReason(m[1]) ? m[1] : null;
}

/** 被停下那一刻(interrupted_at;老行没有就用 updated_at):过期与崩溃计数的时间基准(评审 #10)。
 *  启动恢复补标的行记的是它最后一次动静的时间,之后认领、补说明都不挪它 —— 三小时前崩的,换哪个进程来判都是三小时前。 */
const STOPPED_AT = 'COALESCE(interrupted_at, updated_at)';

/** 停下至今是否已超过 2 小时 / 24 小时。在 SQL 里比:CURRENT_TIMESTAMP 是 UTC 文本,拿到 JS 里 Date.parse 会按本地时间读。
 *  读不出 → 按「太久」算(不续)。 */
export async function runAgeFlags(runId: string): Promise<{ over2h: boolean; over24h: boolean }> {
  try {
    const rows = await query<any[]>(
      `SELECT CASE WHEN ${getOlderThanSql(STOPPED_AT, CRASH_MAX_MINUTES)} THEN 1 ELSE 0 END AS o2,
              CASE WHEN ${getOlderThanSql(STOPPED_AT, PLANNED_MAX_MINUTES)} THEN 1 ELSE 0 END AS o24
         FROM agent_runs WHERE id = ?`, [runId]);
    if (!rows[0]) return { over2h: true, over24h: true };
    return { over2h: Number(rows[0].o2) === 1, over24h: Number(rows[0].o24) === 1 };
  } catch {
    return { over2h: true, over24h: true };
  }
}

/** 抢下这一行(只成功一次):TUI 与桌面共用 state.db、两个引擎可能同时启动。by = 续跑 run 的 id,只补说明行时是 '-'。 */
export async function claimInterruptedRun(runId: string, by: string): Promise<boolean> {
  const rows = await query<any[]>(
    `UPDATE agent_runs SET resumed_by = ? WHERE id = ? AND status = 'interrupted' AND resumed_by IS NULL RETURNING id`,
    [by, runId],
  ).catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

/** 本轮用户消息在 run 真正开跑时才落库;崩在那之前,库里没有这一句,续跑的模型就不知道要做什么 —— 补回来(幂等)。 */
export async function ensureUserRow(run: { session_id: string; model_id?: string | null }, input: any): Promise<void> {
  const id = typeof input?.userMessageId === 'string' ? input.userMessageId : '';
  const said = String(input?.message || '');
  const atts = Array.isArray(input?.attachments) ? input.attachments : [];
  if (!id || (!said && !atts.length)) return;
  await deps().state.insertUserMessage({ id, sessionId: run.session_id, content: said, modelId: run.model_id || '', attachments: atts.length ? atts : null }).catch(() => {});
}

export interface ResumeRun {
  id: string; session_id: string; user_id: string; app_id: string; model_id: string | null;
  assistant_message_id: string | null; input: any; cancel_requested?: string | null;
}

/**
 * 门控里不看时间、不看会话里有没有更新动静的那几道(方案 6.5 的 1 / 2 / 4 / 6 / 8,外加取消请求与账号)。
 * restart-status 的 resumable(「此刻停机会自动续的任务数」,D10)也用它。全过 = null。
 * 'account' = 建 run 时的云端账号和现在的对不上(评审 #3):不续,说明行按 account_change 写。
 */
export async function staticResumeBlocker(run: ResumeRun, reason: InterruptReason, kind: string): Promise<string | null> {
  const input = runInput(run);
  const ac = input.agentConfig && typeof input.agentConfig === 'object' ? input.agentConfig : {};
  // 有人要它停(用户按停 / 急停 / 级联取消,评审 #2):绝不续
  if (run.cancel_requested) return 'cancelled';
  // 换了账号:A 的任务不在 B 的凭据下接着做
  if (accountChanged(input)) return 'account';
  // 1. 原因明确是非用户的、且在可续那张表里(换账号 / 没打招呼的停不续)
  if (!AUTO_RESUMABLE.has(reason)) return 'reason';
  // 2. 设置开关(缺省开;桌面「重启后自动接着做未完成的任务」关掉时以 TANGU_AUTO_RESUME=0 拉起引擎)
  if (process.env.TANGU_AUTO_RESUME === '0') return 'disabled';
  // 4. 同一条任务链最多自动续 MAX_AUTO_RESUMES 次
  const attempt = Number.isFinite(Number(input.resumeAttempt)) ? Number(input.resumeAttempt) : 0;
  if (attempt >= MAX_AUTO_RESUMES) return 'attempts';
  // 6. 面向用户的会话:团队成员 / delegate 子会话不单独续;群聊编排、外部引擎(ACP / 跑在引擎上的 Agent)也不续
  if (!RESUMABLE_KINDS.has(kind)) return 'session_kind';
  if (ac.groupChat || ac.teamMember || (typeof ac.engineId === 'string' && ac.engineId)) return 'not_tangu_loop';
  try {
    const raw = await deps().state.getAgentConfig(run.session_id);
    const stored = json(raw);
    if (stored.teamSlug || stored.soloEngineId) return 'not_tangu_loop';
    const slug = typeof stored.soloAgentSlug === 'string' && stored.soloAgentSlug ? stored.soloAgentSlug : ac.agentSlug;
    if (typeof slug === 'string' && isValidSlug(slug) && agentEngineOf(await getAgent(slug).catch(() => null))) return 'not_tangu_loop';
  } catch { /* 读不到会话配置:照下面的判 */ }
  // 8. 只续会做启动恢复的引擎建的 run(input.hostRecovery,见 runProgress.markRecoveryHost):TUI 与桌面共用 state.db,
  //    TUI 起的 run 不带这个戳,桌面引擎永远不替它自动续
  if (input.hostRecovery !== true) return 'not_recovery_host';
  return null;
}

/**
 * 方案 6.5 的门控,全部过才自动续。返回第一道没过的门(给日志 / 测试);全过 = null。
 * age:runAgeFlags(按被停下那一刻算)。kind:chat_sessions.kind。
 */
export async function resumeBlocker(run: ResumeRun, reason: InterruptReason, age: { over2h: boolean; over24h: boolean }, kind: string): Promise<string | null> {
  const fixed = await staticResumeBlocker(run, reason, kind);
  if (fixed) return fixed;
  // 3. 没过期:计划内 24 小时,崩溃 2 小时
  if (reason === 'crash' ? age.over2h : age.over24h) return 'expired';
  // 5. 1 小时内这个会话崩了 CRASH_LOOP_LIMIT 次:停下等用户
  if (reason === 'crash') {
    const n = await query<any[]>(
      `SELECT COUNT(*) AS n FROM agent_runs WHERE session_id = ? AND error = 'interrupted:crash' AND NOT (${getOlderThanSql(STOPPED_AT, 60)})`,
      [run.session_id],
    ).catch(() => [{ n: CRASH_LOOP_LIMIT }]);
    if (Number(n[0]?.n || 0) >= CRASH_LOOP_LIMIT) return 'crash_loop';
  }
  // 7. 会话里有更新的东西:排队中的 / 在它之后建的 run,或它之后用户又说了话 —— 那些先跑,它们看得到中断那条线
  for (const st of newerStatements(run)) {
    const rows = await query<any[]>(st.sql, st.params).catch(() => [{ n: 1 }]);
    if (Number(rows[0]?.n || 0) > 0) return st.kind;
  }
  return null;
}

/**
 * 门控 7 的两条查询(评审 #9):用稳定的会话内顺序判先后 —— 本机 SQLite 用插入顺序 rowid(回答行的 upsert 不改它),
 * 不用只到秒的 created_at(同一秒建的更新的 run 会漏过);外部 PG 的 created_at / timestamp 本身够细。
 * 计数 > 0 = 有更新的。提交续跑的事务里会再跑一遍(建 run 前重验,判定之后插进来的也算)。
 * 「之后又说了话」的基准 = 这一轮最后落库的那一行(本轮用户消息、之后的各段回答;插话行夹在两段回答之间,不算「之后」)。
 * 插话之后、下一段回答还没来得及落库就停了 → 那句插话排在最后,按「又说了话」算(宁可不续,给按钮)。机器写的 user 行不算。
 */
export function newerStatements(run: ResumeRun): Array<SqlStmt & { kind: 'newer_run' | 'newer_message' }> {
  const input = runInput(run);
  const sqlite = getDbType() === 'sqlite';
  const runOrd = sqlite ? 'rowid' : 'created_at';
  const msgOrd = sqlite ? 'rowid' : 'timestamp';
  const userId = typeof input.userMessageId === 'string' ? input.userMessageId : '';
  const anchorId = userId || run.assistant_message_id || '';
  const machine = MACHINE_PREFIXES.map(() => `c.content NOT LIKE ?`).join(' AND ');
  return [
    {
      kind: 'newer_run',
      sql: `SELECT COUNT(*) AS n FROM agent_runs WHERE session_id = ? AND id <> ?
              AND (status = 'queued' OR ${runOrd} > (SELECT ${runOrd} FROM agent_runs WHERE id = ?))`,
      params: [run.session_id, run.id, run.id],
    },
    {
      kind: 'newer_message',
      sql: `SELECT COUNT(*) AS n FROM chat_messages c
             WHERE c.session_id = ? AND c.role = 'user' AND c.id <> ?
               AND c.${msgOrd} > (
                 SELECT MAX(o) FROM (
                   SELECT a.${msgOrd} AS o FROM chat_messages a WHERE a.id = ? AND a.session_id = ?
                   UNION ALL
                   SELECT m.${msgOrd} AS o FROM chat_messages m WHERE m.session_id = ? AND m.role = 'model'
                     AND m.${msgOrd} >= (SELECT b.${msgOrd} FROM chat_messages b WHERE b.id = ? AND b.session_id = ?)
                 ) w
               )
               AND ${machine}`,
      params: [run.session_id, userId, anchorId, run.session_id, run.session_id, anchorId, run.session_id, ...MACHINE_PREFIXES.map((p) => `${p}%`)],
    },
  ];
}

/** 机器写的 user 行的开头(续跑 / 中断说明 / 审批与提问的回灌,同 isContinuationRow 再加两种回灌):不算「用户又说了新话」。 */
const MACHINE_PREFIXES = ['<turn_resume>', '<turn_interrupted>', '<approval_update>', '<inquiry_update>'];

/** 续跑沿用旧 run 那一份输入(同一个 Agent / 模型 / 审批档 / 计划模式 / 托盘握手 / cwd / 远程污点…),只换消息与续跑标记;
 *  附件、一次性的语音提示与「这一轮改用后备」不带。审批档只会更窄:没有上限的,按旧 run 启动时的档设上限。 */
export function buildResumeInput(oldInput: any, oldRunId: string, markerId: string, marker: string): any {
  const next: any = { ...oldInput };
  delete next.ephemeralHint;
  delete next.quotaFallbackNow;
  next.message = marker;
  next.userMessageId = markerId;
  next.attachments = [];
  next.trigger = 'recovery';
  next.resumeOf = oldRunId;
  next.resumeAttempt = (Number.isFinite(Number(oldInput.resumeAttempt)) ? Number(oldInput.resumeAttempt) : 0) + 1;
  // 记忆 / 会话召回用原来的那句(续跑行本身没有话题);续了又续沿用最初那句
  next.resumeQuery = typeof oldInput.resumeQuery === 'string' ? oldInput.resumeQuery : String(oldInput.message || '');
  const mode = oldInput.agentConfig?.approvalMode;
  if (next.approvalCap == null && (mode === 'readonly' || mode === 'auto-edit' || mode === 'full-auto')) next.approvalCap = mode;
  return next;
}

/** 续跑用哪个模型:旧 run 的;它解析不出来了(引擎正是因为改了模型配置才重启的)就换用会话现在选的。探不出(超时)照用旧的。 */
export async function pickResumeModel(oldModel: string, sessionId: string): Promise<string> {
  const sessionModel = String((await query<any[]>(`SELECT model_id FROM chat_sessions WHERE id = ?`, [sessionId]).catch(() => []))[0]?.model_id || '');
  if (!oldModel) return sessionModel;
  if (!sessionModel || sessionModel === oldModel) return oldModel;
  const verdict = await Promise.race([
    deps().brain.llm.resolveModelAndKey(oldModel).then(() => 'ok', () => 'gone'),
    new Promise<string>((r) => setTimeout(() => r('unknown'), 5000).unref?.()),
  ]);
  return verdict === 'gone' ? sessionModel : oldModel;
}

// ── 认领 + 写行 + 建 run 一起提交(评审 #8)──

/** 由一个 id 派生的确定性 UUID(v5 形)。认领后写到一半崩了,下次照同一个 id 补齐,不会多出第二行 / 第二个 run。 */
export function derivedId(kind: string, id: string): string {
  const h = createHash('sha1').update(`tangu-run-recovery:${kind}:${id}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type SyncRun = (sql: string, params?: any[]) => any[];
const syncTx = (): (<T>(fn: (run: SyncRun) => T) => T) | null => {
  const h = deps().host;
  return typeof h.transactionSync === 'function' ? h.transactionSync.bind(h) as any : null;
};
const CLAIM_SQL = `UPDATE agent_runs SET resumed_by = ? WHERE id = ? AND status = 'interrupted' AND resumed_by IS NULL RETURNING id`;

export interface ResumePlan {
  run: ResumeRun; reason: InterruptReason; modelId: string;
  /** 续跑 run 的 id(也记在旧行的 resumed_by 上);续跑行与回答行的 id 由它派生。 */
  resumeRunId: string;
}

/** 续跑 run 的那几样:续跑行、建 run 的参数。重放补齐时(repairDanglingResumes)按同一个 resumeRunId 算出一模一样的。 */
function resumeParts(p: ResumePlan): { row: Parameters<typeof insertUserRowStmt>[0]; create: Parameters<typeof createRunStmt>[0] } {
  const marker = autoResumeMarker(p.reason);
  const markerId = derivedId('marker', p.resumeRunId);
  return {
    // 续跑行先落库(runLoop 起跑时按同一个 id 再插一次是空操作):续跑 run 起不来,这一行也在,界面照样画得出那条线
    row: { id: markerId, sessionId: p.run.session_id, content: marker, modelId: p.modelId, attachments: null },
    create: {
      id: p.resumeRunId, sessionId: p.run.session_id, userId: p.run.user_id, appId: p.run.app_id, modelId: p.modelId,
      assistantMessageId: derivedId('answer', p.resumeRunId), input: buildResumeInput(runInput(p.run), p.run.id, markerId, marker),
    },
  };
}

/**
 * 认领旧行(resumed_by = 续跑 id)+ 写续跑行 + 建续跑 run。本机 SQLite 在一个事务里,并在事务里把门控 7 再验一遍(评审 #9:
 * 判定之后、提交之前插进来的新 run / 新消息也算)。没有事务的库:先认领、再按派生 id 补行建 run —— 中途崩了,
 * 下次启动 repairDanglingResumes 照同一个 id 补齐。返回 'ok' = 建好了(调用方入队);'lost' = 别人先认领了;
 * newer_run / newer_message = 重验没过(调用方改补说明行)。
 */
export async function commitResume(p: ResumePlan): Promise<'ok' | 'lost' | 'newer_run' | 'newer_message'> {
  const { row, create } = resumeParts(p);
  const userRow = insertUserRowStmt(row);
  const bump = bumpSessionStmt(p.run.session_id);
  const runRow = createRunStmt(create);
  const tx = syncTx();
  if (tx) {
    return tx((run) => {
      for (const st of newerStatements(p.run)) if (Number(run(st.sql, st.params)[0]?.n || 0) > 0) return st.kind;
      if (!run(CLAIM_SQL, [p.resumeRunId, p.run.id]).length) return 'lost';
      if (run(userRow.sql, userRow.params).length) run(bump.sql, bump.params);
      run(runRow.sql, runRow.params);
      return 'ok';
    });
  }
  for (const st of newerStatements(p.run)) {
    if (Number((await query<any[]>(st.sql, st.params).catch(() => [{ n: 1 }]))[0]?.n || 0) > 0) return st.kind;
  }
  if (!(await claimInterruptedRun(p.run.id, p.resumeRunId))) return 'lost';
  await materialize(row, create);
  return 'ok';
}

async function materialize(row: Parameters<typeof insertUserRowStmt>[0], create: Parameters<typeof createRunStmt>[0]): Promise<void> {
  await deps().state.insertUserMessage(row);
  const had = await query<any[]>(`SELECT 1 FROM agent_runs WHERE id = ?`, [create.id]);
  if (!had.length) { const st = createRunStmt(create); await query(st.sql, st.params); }
}

/**
 * 不续、补一条说明原因的中断行:认领(resumed_by = '-')+ 写行在一个事务里;没有事务的库先写行(id 由旧 run 派生,重来不会多一行)再认领。
 * errorReason:说明行的原因与 error 列不同时(换了账号)顺带把 error 改成 interrupted:<它>,界面和说明行说的是同一件事。返回是否由本进程处理。
 */
export async function commitNotice(run: ResumeRun, reason: InterruptReason, opts?: { rewriteError?: boolean }): Promise<boolean> {
  const row = insertUserRowStmt({ id: derivedId('notice', run.id), sessionId: run.session_id, content: interruptedNoticeMarker(reason), modelId: run.model_id || '', attachments: null });
  const bump = bumpSessionStmt(run.session_id);
  const fix: SqlStmt | null = opts?.rewriteError ? { sql: `UPDATE agent_runs SET error = ? WHERE id = ?`, params: [`interrupted:${reason}`, run.id] } : null;
  const tx = syncTx();
  if (tx) {
    return tx((exec) => {
      if (!exec(CLAIM_SQL, ['-', run.id]).length) return false;
      if (exec(row.sql, row.params).length) exec(bump.sql, bump.params);
      if (fix) exec(fix.sql, fix.params);
      return true;
    });
  }
  const inserted = await query<any[]>(row.sql, row.params);
  if (inserted.length) await query(bump.sql, bump.params).catch(() => {});
  if (!(await claimInterruptedRun(run.id, '-'))) return false;
  if (fix) await query(fix.sql, fix.params).catch(() => {});
  return true;
}

/**
 * 认领了续跑、续跑 run 却不在(没有事务的库,认领后崩了):按旧行 resumed_by 里的那个 id 补齐续跑行与 run。返回补齐的 (会话, run) 供入队。
 * 本机 SQLite 走事务,不会有这种行;这里照样扫一遍,无害。
 */
export async function repairDanglingResumes(pickModel: (oldModel: string, sessionId: string) => Promise<string>): Promise<Array<{ sessionId: string; runId: string }>> {
  const rows = await query<any[]>(
    `SELECT r.* FROM agent_runs r WHERE r.status = 'interrupted' AND r.resumed_by IS NOT NULL AND r.resumed_by <> '-'
       AND NOT EXISTS (SELECT 1 FROM agent_runs x WHERE x.id = r.resumed_by)`,
  ).catch(() => []);
  const out: Array<{ sessionId: string; runId: string }> = [];
  for (const r of rows) {
    try {
      const reason = reasonFromError(r.error) ?? 'engine_stop';
      const { row, create } = resumeParts({ run: r, reason, modelId: await pickModel(r.model_id || '', r.session_id), resumeRunId: String(r.resumed_by) });
      await materialize(row, create);
      out.push({ sessionId: r.session_id, runId: create.id });
    } catch (e: any) {
      console.warn(`[agent-core] repair of the resume of ${r.id} failed:`, e?.message || e);
    }
  }
  return out;
}
