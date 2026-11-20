/**
 * 启动恢复里「被停下的 run 要不要自动接着做」的判定与续跑 run 的构造(2026-11-20 中断任务续跑方案 B · E4,方案 6.4 / 6.5)。
 * 编排在 agentLoop.recoverQueuedRuns(要 enqueueRun);这里只放不依赖 agentLoop 的库查询与纯逻辑,免得成环。
 *
 * 底线(与 Claude 的 reply_not_ended、Codex 的「核对没有结束标记」同一条):只在**明确记下**是非用户原因时才续,
 * 记不清的一律不续 —— 不续 = 补一条说明原因的中断行(interruptedNoticeMarker),界面给「继续生成」。
 * 绝不从原始输入重跑(10-02 R2):续跑是新的一轮,消息是 autoResumeMarker,历史里是上一轮落库的现场。
 */
import { query, getOlderThanSql } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { AUTO_RESUMABLE, isContinuationRow, isInterruptReason, type InterruptReason } from '../contracts/turnResume.js';
import type { ShutdownIntent } from '../contracts/shutdownIntent.js';
import { agentEngineOf, getAgent, isValidSlug } from '../agents/agentRegistry.js';

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

/** 距上次动静(updated_at)是否已超过 2 小时 / 24 小时。在 SQL 里比:CURRENT_TIMESTAMP 是 UTC 文本,拿到 JS 里 Date.parse 会按本地时间读。
 *  ⚠️ 要在把行标成 interrupted **之前**读(标记会刷新 updated_at)。读不出 → 按「太久」算(不续)。 */
export async function runAgeFlags(runId: string): Promise<{ over2h: boolean; over24h: boolean }> {
  try {
    const rows = await query<any[]>(
      `SELECT CASE WHEN ${getOlderThanSql('updated_at', CRASH_MAX_MINUTES)} THEN 1 ELSE 0 END AS o2,
              CASE WHEN ${getOlderThanSql('updated_at', PLANNED_MAX_MINUTES)} THEN 1 ELSE 0 END AS o24
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

/** 机器写的 user 行(续跑 / 中断说明 / 审批与提问的回灌):不算「用户又说了新话」。 */
function machineRow(content: string): boolean {
  return isContinuationRow(content) || content.startsWith('<approval_update>') || content.startsWith('<inquiry_update>');
}

export interface ResumeRun {
  id: string; session_id: string; user_id: string; app_id: string; model_id: string | null;
  assistant_message_id: string | null; input: any;
}

/**
 * 方案 6.5 的门控,全部过才自动续。返回第一道没过的门(给日志 / 测试);全过 = null。
 * age:标记之前读的 runAgeFlags。kind:chat_sessions.kind。
 */
export async function resumeBlocker(run: ResumeRun, reason: InterruptReason, age: { over2h: boolean; over24h: boolean }, kind: string): Promise<string | null> {
  const input = runInput(run);
  const ac = input.agentConfig && typeof input.agentConfig === 'object' ? input.agentConfig : {};
  // 1. 原因明确是非用户的、且在可续那张表里(换账号 / 没打招呼的停不续)
  if (!AUTO_RESUMABLE.has(reason)) return 'reason';
  // 2. 设置开关(缺省开;桌面「重启后自动接着做未完成的任务」关掉时以 TANGU_AUTO_RESUME=0 拉起引擎)
  if (process.env.TANGU_AUTO_RESUME === '0') return 'disabled';
  // 3. 没过期:计划内 24 小时,崩溃 2 小时
  if (reason === 'crash' ? age.over2h : age.over24h) return 'expired';
  // 4. 同一条任务链最多自动续 MAX_AUTO_RESUMES 次
  const attempt = Number.isFinite(Number(input.resumeAttempt)) ? Number(input.resumeAttempt) : 0;
  if (attempt >= MAX_AUTO_RESUMES) return 'attempts';
  // 5. 1 小时内这个会话崩了 CRASH_LOOP_LIMIT 次:停下等用户
  if (reason === 'crash') {
    const n = await query<any[]>(
      `SELECT COUNT(*) AS n FROM agent_runs WHERE session_id = ? AND error = 'interrupted:crash' AND NOT (${getOlderThanSql('updated_at', 60)})`,
      [run.session_id],
    ).catch(() => [{ n: CRASH_LOOP_LIMIT }]);
    if (Number(n[0]?.n || 0) >= CRASH_LOOP_LIMIT) return 'crash_loop';
  }
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
  // 7. 会话里有更新的东西:排队中的 / 在它之后建的 run,或它之后用户又说了话 —— 那些先跑,它们看得到中断那条线
  const newer = await query<any[]>(
    `SELECT 1 FROM agent_runs WHERE session_id = ? AND id <> ?
       AND (status = 'queued' OR created_at > (SELECT created_at FROM agent_runs WHERE id = ?)) LIMIT 1`,
    [run.session_id, run.id, run.id],
  ).catch(() => [{}]);
  if (newer.length) return 'newer_run';
  if (await newerUserMessage(run, input)) return 'newer_message';
  return null;
}

/**
 * 它之后用户又说了话吗。基准 = 这一轮最后落库的那一行(本轮用户消息、之后的各段回答;插话行夹在两段回答之间,不算「之后」)。
 * 插话之后、下一段回答还没来得及落库就停了 → 那句插话排在最后,按「又说了话」算(宁可不续,给按钮)。
 */
async function newerUserMessage(run: ResumeRun, input: any): Promise<boolean> {
  const userId = typeof input.userMessageId === 'string' ? input.userMessageId : '';
  const anchorId = userId || run.assistant_message_id || '';
  if (!anchorId) return false;
  const anchor = await query<any[]>(`SELECT timestamp FROM chat_messages WHERE id = ? AND session_id = ?`, [anchorId, run.session_id]).catch(() => []);
  if (!anchor[0]) return false;
  const base = Number(anchor[0].timestamp) || 0;
  const lastModel = await query<any[]>(
    `SELECT MAX(timestamp) AS t FROM chat_messages WHERE session_id = ? AND role = 'model' AND timestamp >= ?`, [run.session_id, base],
  ).catch(() => []);
  const watermark = Math.max(base, Number(lastModel[0]?.t) || 0);
  const later = await query<any[]>(
    `SELECT id, content FROM chat_messages WHERE session_id = ? AND role = 'user' AND timestamp > ? AND id <> ?`, [run.session_id, watermark, userId],
  ).catch(() => [{ id: '?', content: '' }]);
  return later.some((r) => !machineRow(String(r.content || '')));
}

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
