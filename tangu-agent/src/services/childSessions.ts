/**
 * 父子会话(方案「子会话与任务卡」2026-10-17,第 1、2 步):主会话用 start_session 开出**可见**的子会话(kind='user' + parent_session_id,
 * 会话列表里挂在主会话下面),子会话自己跑;主会话起的那一轮跑完,结果送回主会话,主会话空闲且名下没有子会话在跑时自己接着做。
 *
 *  - 回报挂起:子会话里 input.fromParent 的那一轮**起跑**时 → chat_sessions.report_run_id = 那一轮(起跑就记:退出 / 崩溃时 finally 不跑,
 *    重启后 deliverPendingChildReports 照样认得);那一轮到终态后送达,送达落库后按 (id, run) 比对清空。
 *    用户自己点进子会话聊的轮次不回报(那是用户在驱动,主会话不该被它叫醒)。摘要只取挂起那一轮自己的回答(assistant_message_id)。
 *  - 送达(deliverChildReports):主会话空闲 + 名下没有子会话在跑 → 一条 `<child_sessions_update>` 用户行(界面画成系统行)+ 起一轮。
 *    连续自动接着做 AUTO_CONTINUE_MAX 次后只写行不起轮,等用户下一句;主会话或子会话有远程污点(remoteTaint.sessionRemoteTainted)
 *    而这批回报又没有可抄的 input.remote 时也只写行(不替用户在本机无污点地自动起轮);重启补送一律只写行。
 *  - 等你:交互 / 父子派生的一轮正常收尾、最后一句以问号结尾 → awaiting_user(markIfAsked;起初是模型调 wait_for_user 声明,
 *    live 10-17 GPT 6 Luna 三次都没调、一次误用,删了)。子会话在跑 / 结果没送回时不置;任何一轮开始时清掉(onRunStart)。
 *    阻塞的询问(ask_user)界面另按 attention 画等你;子会话那一轮里 ask_user 不阻塞(inquiries.INQUIRY_CHILD_ANSWER),问题收尾送回主会话。
 *  - 只一层:子会话不能再开子会话(列表的树只画一层;10-28 用户定:别层层叠叠,不放开)。
 *  - fork(start_session context:"fork",10-28 对齐 Claude):主会话此刻的转写(buildTranscript,封顶 FORK_MAX_TOKENS)
 *    落成子会话的一条压缩检查点(through_timestamp=1,一行都不覆盖)—— hydrateHistory 每轮自动把它注入成开头那条摘要,
 *    以后子会话自己压缩时当「已有摘要」并进去;不拷行(界面不重画主会话)、不进用户消息(Historian / 标题 / 搜索不吃它)。
 *  - 会话互发(sendSessionMessage,10-28):同一棵树里 —— 子会话 → 主会话、兄弟之间。落成对方的一条 <session_message> 用户行并起一轮
 *    (在跑就排队);回不回由对方自己 send_to_session,不自动回传(自动回传 = 两边互相叫醒)。防回环:收方连续被消息叫醒
 *    AUTO_CONTINUE_MAX 次后只写行不起轮,用户发一句 / 主会话派一轮归零。主会话 → 自己的子会话照旧走 sendToChildSession(会回报)。
 *  - 分支(/branch,fork_message_id 有值)也挂 parent_session_id,但不是子会话:下面认子会话的查询一律带 `fork_message_id IS NULL`。
 *
 * 唯一触发点 = agentLoop.startRun 的 finally(onRunSettled):子会话收尾试着送给主会话,主会话收尾试着收它名下积着的回报。
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';
import { getRawSection } from '../core/config.js';
import { deps } from '../seams/runtime.js';
import { createRun, getRun } from './runStore.js';
import { remoteOriginMarker, type RemoteInfo } from './remoteOrigin.js';
import { sessionRemoteTainted } from './remoteTaint.js';
import { buildTranscript } from './compaction.js';
import { modelContextWindow } from './contextBudget.js';
import { clearChildQuestions, peekChildQuestions } from './inquiries.js';

export const CHILD_UPDATE_OPEN = '<child_sessions_update>';
export const CHILD_UPDATE_CLOSE = '</child_sessions_update>';
const AUTO_CONTINUE_MAX = 3;
const MAX_RUNNING_CHILDREN = 4;
const EXCERPT_CHARS = 1500;
/** fork 时带给子会话的主会话转写上限(token 粗估;另不超过模型窗口的 1/4)。它当「已有摘要」存,以后压缩时整段保留不裁,所以要小。
 *  ponytail: 子会话事后换成窗口 < ~4× 种子的模型仍可能撑窗;要彻底得让压缩能重压种子。 */
const FORK_MAX_TOKENS = 24_000;
export const SESSION_MESSAGE_OPEN = '<session_message ';
/** 子会话从主会话的存值里继承的配置键(工作目录、人格、档位);团队 / 私聊引擎 / 计划模式这类会话事实不抄。 */
const INHERIT_KEYS = ['preset', 'execMode', 'cwd', 'extraRoots', 'workspaceProject', 'agentSlug', 'approvalMode', 'thinkingLevel'];

const decode = (x: unknown): any => {
  if (typeof x === 'string') { try { return JSON.parse(x) || {}; } catch { return {}; } }
  return x && typeof x === 'object' ? x : {};
};
const loop = () => import('./agentLoop.js');
const attr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** config.json `childSessions.autoContinue`(缺省开):关掉后回报只写进主会话,等用户下一句再看。 */
export function autoContinueEnabled(): boolean {
  return (getRawSection('childSessions') as any)?.autoContinue !== false;
}

// ponytail: 连续自动接着做的计数只在内存里,引擎重启归零(最坏多接着做 3 轮);要跨重启得落列。
const autoRuns = new Map<string, number>();

/** 在主会话下开一个子会话并起它的第一轮。错误抛英文串(工具原样回给模型)。 */
export async function startChildSession(p: {
  parentId: string; userId: string; modelId: string; title: string; message: string; remote?: RemoteInfo;
  /** 主会话这一轮实际在用的配置(工具从 ctx 传):压过存值 —— 存值可能是空的(客户端每轮带配置、没 PUT 过的会话)。 */
  inherit?: Record<string, unknown>;
  /** true = 带上主会话此刻的对话(context:"fork")。 */
  fork?: boolean;
  /** 主会话这一轮在飞的工作消息(ctx.getWorkingMessages):这一轮刚读到的东西还没落库,只从库里读会漏(Codex 10-28 P2)。 */
  parentMessages?: any[];
}): Promise<{ sessionId: string; runId: string; title: string; forked: boolean }> {
  const [parent] = await query<any[]>(
    `SELECT id, user_id, app_id, kind, parent_session_id, fork_message_id, project_path, project_name, projectless, agent_config, model_id, title FROM chat_sessions WHERE id = ?`,
    [p.parentId],
  );
  if (!parent || parent.user_id !== p.userId || parent.kind !== 'user') throw new Error('This conversation cannot start child sessions.');
  if (parent.parent_session_id && !parent.fork_message_id) throw new Error('This is already a child session, and child sessions cannot start their own. Do the work here, or finish and let the main session decide.');
  const { activeSessionIds } = await loop();
  const busy = activeSessionIds();
  const kids = await query<any[]>(`SELECT id FROM chat_sessions WHERE parent_session_id = ? AND kind = 'user' AND fork_message_id IS NULL`, [p.parentId]);
  if (kids.filter((k) => busy.has(String(k.id))).length >= MAX_RUNNING_CHILDREN) {
    throw new Error(`${MAX_RUNNING_CHILDREN} child sessions are already running. Wait for them to report back before starting more.`);
  }
  const cfg = { ...decode(parent.agent_config), ...Object.fromEntries(Object.entries(p.inherit || {}).filter(([, v]) => v !== undefined)) };
  const runConfig: Record<string, unknown> = {};
  for (const k of INHERIT_KEYS) if (cfg[k] !== undefined) runConfig[k] = cfg[k];
  // 远程污点的调用方开出的子会话:存值盖远程标记(同 dispatchProjectSession / 远程 POST /agent/sessions),首个 run 抄 input.remote。
  const stored = p.remote ? { ...runConfig, remoteOrigin: remoteOriginMarker(p.remote) } : runConfig;
  const sessionId = uuidv4();
  const title = p.title.replace(/\s+/g, ' ').trim().slice(0, 80) || p.message.replace(/\s+/g, ' ').trim().slice(0, 80) || 'New Chat';
  const modelId = p.modelId || parent.model_id || deps().profile.defaultModelId || '';
  await query(
    `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, project_path, project_name, projectless, agent_config, parent_session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, p.userId, parent.app_id, title, modelId || null, parent.project_path, parent.project_name, !!parent.projectless, JSON.stringify(stored), p.parentId],
  );
  const forked = p.fork ? await seedForkContext(sessionId, p.parentId, String(parent.title || ''), modelId, p.parentMessages).catch(() => false) : false;
  const runId = await queueFromParent({ sessionId, userId: p.userId, appId: parent.app_id, modelId, message: p.message, agentConfig: runConfig, remote: p.remote });
  return { sessionId, runId, title, forked };
}

/** 主会话此刻的转写 → 子会话的开头摘要(压缩检查点,through_timestamp=1:不覆盖任何一行,hydrateHistory 照样注入)。 */
async function seedForkContext(childId: string, parentId: string, parentTitle: string, modelId: string, inFlight?: any[]): Promise<boolean> {
  const messages = inFlight?.length ? inFlight : (await (await loop()).hydrateHistory(parentId, '', undefined, undefined, undefined, false)).messages;
  let model: any;
  try { model = (await deps().brain.llm.resolveModelAndKey(modelId))?.model; } catch { /* 窗口按 id 估 */ }
  const budget = Math.min(FORK_MAX_TOKENS, Math.floor(modelContextWindow(modelId, model) / 4));
  const { text } = buildTranscript(messages, { read: new Set(), modified: new Set() }, budget);
  if (!text.trim()) return false;
  const summary = [
    '[Forked context — this is NOT work done in this session.] You are a child session. Below is the conversation of the session that started you, '
      + 'up to the moment it started you, so you share its context. Treat it as background only: do not continue that conversation\'s own task or redo its work. '
      + 'Your task is the brief in the first user message of this session.',
    '',
    `<parent_conversation title="${attr(parentTitle)}">`,
    text,
    '</parent_conversation>',
  ].join('\n');
  await query(`INSERT INTO session_summaries (id, session_id, summary, through_timestamp) VALUES (?, ?, ?, 1)`, [uuidv4(), childId, summary]);
  return true;
}

/** 主会话给自己的子会话再说一句(回答它的问题、补一个要求):子会话在跑就排在后面。 */
export async function sendToChildSession(p: { parentId: string; userId: string; childId: string; message: string; remote?: RemoteInfo }): Promise<{ runId: string; queued: boolean; title: string }> {
  const [child] = await query<any[]>(
    `SELECT id, user_id, app_id, kind, parent_session_id, fork_message_id, agent_config, model_id, title FROM chat_sessions WHERE id = ?`,
    [p.childId],
  );
  if (!child || child.user_id !== p.userId || child.kind !== 'user' || child.parent_session_id !== p.parentId || child.fork_message_id) {
    throw new Error('No such child session of this conversation. Only sessions you started with start_session can be messaged.');
  }
  const { activeSessionIds } = await loop();
  const queued = activeSessionIds().has(p.childId);
  const cfg = decode(child.agent_config);
  delete cfg.remoteOrigin; // 标记只在会话存值里,run 的污点是 input.remote
  const runId = await queueFromParent({ sessionId: p.childId, userId: p.userId, appId: child.app_id, modelId: child.model_id || '', message: p.message, agentConfig: cfg, remote: p.remote });
  return { runId, queued, title: String(child.title || '') };
}

type Rel = 'child' | 'parent' | 'sibling';
const isChildRow = (r: any): boolean => !!r?.parent_session_id && !r?.fork_message_id;

/** to 相对 from 是什么:from 的子会话 / from 的主会话 / 同一个主会话下的兄弟;别的(含分支、别人的会话)= null。 */
function relationOf(from: any, to: any): Rel | null {
  if (!from || !to || from.id === to.id || from.user_id !== to.user_id || from.kind !== 'user' || to.kind !== 'user') return null;
  if (isChildRow(to) && to.parent_session_id === from.id) return 'child';
  if (isChildRow(from) && from.parent_session_id === to.id) return 'parent';
  if (isChildRow(from) && isChildRow(to) && from.parent_session_id === to.parent_session_id) return 'sibling';
  return null;
}

const SESSION_COLS = 'id, user_id, app_id, kind, parent_session_id, fork_message_id, agent_config, model_id, title';

/** 给同一棵树里的会话发一句(send_to_session):自己的子会话走 sendToChildSession(会回报);主会话 / 兄弟落成一条 <session_message> 并起一轮。
 *  toId 可写 "parent"。错误抛英文串(工具原样回给模型)。 */
export async function sendSessionMessage(p: { fromId: string; userId: string; toId: string; message: string; remote?: RemoteInfo }): Promise<{ title: string; queued: boolean; rowOnly: boolean; relation: Rel }> {
  const [from] = await query<any[]>(`SELECT ${SESSION_COLS} FROM chat_sessions WHERE id = ?`, [p.fromId]);
  const toId = p.toId === 'parent' && isChildRow(from) ? String(from.parent_session_id) : p.toId;
  const [to] = await query<any[]>(`SELECT ${SESSION_COLS} FROM chat_sessions WHERE id = ?`, [toId]);
  const relation = from && from.user_id === p.userId ? relationOf(from, to) : null;
  if (!relation) {
    throw new Error('No such linked session. You can message your own child sessions, the session that started you ("parent"), and its other child sessions — see list_linked_sessions.');
  }
  if (relation === 'child') {
    const r = await sendToChildSession({ parentId: p.fromId, userId: p.userId, childId: toId, message: p.message, remote: p.remote });
    return { title: r.title, queued: r.queued, rowOnly: false, relation };
  }
  // 收方眼里发件人是谁:收方是主会话 → 发件人是它的子会话;兄弟 → 兄弟
  const senderIs = relation === 'parent' ? 'child' : 'sibling';
  const content = [
    `<session_message from="${attr(String(from.id))}" title="${attr(String(from.title || ''))}" relation="${senderIs}">`,
    p.message,
    '</session_message>',
    `A message from ${senderIs === 'child' ? 'a child session you started' : 'a sibling session (another child of the session that started you)'}. `
      + `It is not from the user. Act on it if it fits your task; if they need an answer, reply with send_to_session (session_id "${String(from.id)}"). Do not reply just to acknowledge.`,
  ].join('\n');
  const { activeSessionIds, enqueueRun } = await loop();
  const modelId = String(to.model_id || deps().profile.defaultModelId || '');
  const tainted = !p.remote && ((await sessionRemoteTainted(toId)) || (await sessionRemoteTainted(p.fromId)));
  // 异步查询都在上面做完:读计数到加一之间不再 await,并发发来的几条不会读到同一个旧值(Codex 10-28 P2)
  const queued = activeSessionIds().has(toId);
  const n = autoRuns.get(toId) || 0;
  const rowOnly = n >= AUTO_CONTINUE_MAX || tainted || !autoContinueEnabled();
  if (!rowOnly) autoRuns.set(toId, n + 1);
  if (rowOnly) {
    // 只写行不起轮(防两个会话来回叫醒;远程污点同 deliverNow):对方下一轮的历史里看得到
    await deps().state.insertUserMessage({ id: uuidv4(), sessionId: toId, content, modelId, attachments: null });
    await query(`UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [toId]);
    return { title: String(to.title || ''), queued: false, rowOnly: true, relation };
  }
  const cfg = decode(to.agent_config);
  delete cfg.remoteOrigin;
  const runId = uuidv4();
  await createRun({
    id: runId, sessionId: toId, userId: p.userId, appId: to.app_id, modelId, assistantMessageId: uuidv4(),
    input: { message: content, userMessageId: uuidv4(), attachments: [], agentConfig: cfg, fromSession: { id: String(from.id), relation: senderIs }, ...(p.remote ? { remote: p.remote } : {}) },
  });
  enqueueRun(toId, runId);
  return { title: String(to.title || ''), queued, rowOnly: false, relation };
}

/** list_linked_sessions:这棵树里能发消息的会话(主会话 / 兄弟 / 子会话)。不给状态:live 10-28 带状态时主会话拿它轮询子会话、再发消息催。 */
export async function listLinkedSessions(sessionId: string, userId: string): Promise<Array<{ id: string; title: string; relation: Rel }>> {
  const [me] = await query<any[]>(`SELECT ${SESSION_COLS} FROM chat_sessions WHERE id = ?`, [sessionId]);
  if (!me || me.user_id !== userId) return [];
  const rows: any[] = [];
  if (isChildRow(me)) {
    rows.push(...await query<any[]>(`SELECT id, user_id, kind, parent_session_id, fork_message_id, title FROM chat_sessions WHERE id = ?`, [me.parent_session_id]));
    rows.push(...await query<any[]>(`SELECT id, user_id, kind, parent_session_id, fork_message_id, title FROM chat_sessions WHERE parent_session_id = ? AND fork_message_id IS NULL`, [me.parent_session_id]));
  }
  rows.push(...await query<any[]>(`SELECT id, user_id, kind, parent_session_id, fork_message_id, title FROM chat_sessions WHERE parent_session_id = ? AND fork_message_id IS NULL`, [sessionId]));
  const out: Array<{ id: string; title: string; relation: Rel }> = [];
  for (const r of rows) {
    const relation = relationOf(me, r);
    if (!relation || out.some((o) => o.id === r.id)) continue;
    out.push({ id: String(r.id), title: String(r.title || ''), relation });
  }
  return out;
}

async function queueFromParent(p: { sessionId: string; userId: string; appId: string; modelId: string; message: string; agentConfig: Record<string, unknown>; remote?: RemoteInfo }): Promise<string> {
  const runId = uuidv4();
  await createRun({
    id: runId, sessionId: p.sessionId, userId: p.userId, appId: p.appId, modelId: p.modelId, assistantMessageId: uuidv4(),
    input: { message: p.message, userMessageId: uuidv4(), attachments: [], agentConfig: p.agentConfig, fromParent: true, ...(p.remote ? { remote: p.remote } : {}) },
  });
  (await loop()).enqueueRun(p.sessionId, runId);
  return runId;
}

/** 置「等你」。子会话还在跑 / 结果还没送回时不置(live 10-17:模型把「等子会话」当成「等你」)。
 *  ponytail: 子会话在跑时真要问用户也标不上,行尾照样显示在跑;要分开再按问句判断。 */
export async function markAwaitingUser(sessionId: string, userId: string): Promise<boolean> {
  const { activeSessionIds } = await loop();
  const busy = activeSessionIds();
  const kids = await query<any[]>(
    `SELECT id, report_run_id FROM chat_sessions WHERE parent_session_id = ? AND user_id = ? AND kind = 'user' AND fork_message_id IS NULL`, [sessionId, userId]);
  if (kids.some((k: any) => busy.has(k.id) || k.report_run_id)) return false;
  await query(`UPDATE chat_sessions SET awaiting_user = TRUE WHERE id = ? AND user_id = ?`, [sessionId, userId]);
  return true;
}

/** 每一轮开始:清「等你」;用户自己发的一轮 → 连续自动接着做的计数归零。 */
export async function onRunStart(sessionId: string, input: any, runId: string): Promise<void> {
  if (!deps().profile.capabilities.hostExec) return; // 父子会话只在本机引擎(云端 thin worker 不直连库)
  if (input?.origin === 'client' || input?.fromParent === true) autoRuns.delete(sessionId);
  if (input?.fromParent === true) {
    await query(`UPDATE chat_sessions SET report_run_id = ? WHERE id = ? AND parent_session_id IS NOT NULL`, [runId, sessionId]);
  }
  await query(`UPDATE chat_sessions SET awaiting_user = FALSE WHERE id = ? AND awaiting_user = TRUE`, [sessionId]);
}

/** run 收尾(startRun 的 finally,终态已落库、会话队列已推进)。尽力而为:失败只记日志,绝不影响 run 收尾。 */
export async function onRunSettled(runId: string): Promise<void> {
  if (!deps().profile.capabilities.hostExec) return;
  const run = await getRun(runId);
  if (!run) return;
  const sid = String(run.session_id);
  const input = decode(run.input);
  const [s] = await query<any[]>(`SELECT kind, parent_session_id, fork_message_id FROM chat_sessions WHERE id = ?`, [sid]);
  if (!s || s.kind !== 'user') return;
  await deliverChildReports(s.parent_session_id && !s.fork_message_id ? String(s.parent_session_id) : sid);
}

/** 最后一句以问号结尾(去掉收尾的空白 / 引号 / 括号 / markdown 记号)。 */
export function endsWithQuestion(text: string): boolean {
  return /[?？]$/.test(text.replace(/[\s*_`"'”’」』)）\]>~]+$/u, ''));
}

/** 兜底「等你」(agentLoop 正常收尾、发 done **之前**调:客户端收到 done 立刻刷新列表,晚一步就读不到)。
 *  只认用户在场的一轮(输入区发起)和父子派生的轮 —— Muse / 通道 / 自动化 / 团队派生的收尾问句不算。
 *  ponytail: 按问号判,「要不要我再…?」这类可选提议也算等你(Claude 的 waiting for input 同口径)。 */
export async function markIfAsked(sessionId: string, userId: string, input: any, finalText: string): Promise<void> {
  if (!deps().profile.capabilities.hostExec) return;
  if (!(input?.origin === 'client' || input?.fromParent === true || input?.childReport === true || input?.fromSession?.relation === 'child')) return; // 兄弟发来的那一轮在等发件人,不是等你
  if (endsWithQuestion(String(finalText || ''))) await markAwaitingUser(sessionId, userId);
}

/** 引擎启动(recoverQueuedRuns 之后):上次退出 / 崩溃时没送出去的回报补成主会话里的一行(不起轮 —— 别一开 app 主会话就自己跑起来)。 */
export async function deliverPendingChildReports(): Promise<void> {
  if (!deps().profile.capabilities.hostExec) return;
  const rows = await query<any[]>(`SELECT DISTINCT parent_session_id AS p FROM chat_sessions WHERE report_run_id IS NOT NULL AND parent_session_id IS NOT NULL`);
  for (const r of rows) await deliverChildReports(String(r.p), { rowOnly: true }).catch(() => {});
}

const chains = new Map<string, Promise<void>>();
/** 同一主会话的送达串行(两个子会话同时收尾不会各起一轮)。 */
export function deliverChildReports(parentId: string, opts: { rowOnly?: boolean } = {}): Promise<void> {
  const next = (chains.get(parentId) || Promise.resolve()).catch(() => {}).then(() => deliverNow(parentId, opts));
  chains.set(parentId, next);
  void next.finally(() => { if (chains.get(parentId) === next) chains.delete(parentId); }).catch(() => {});
  return next;
}

const STATUS: Record<string, string> = { done: 'finished', failed: 'failed', aborted: 'stopped' };

async function deliverNow(parentId: string, opts: { rowOnly?: boolean }): Promise<void> {
  const { activeSessionIds, enqueueRun } = await loop();
  const busy = activeSessionIds();
  if (busy.has(parentId)) return; // 主会话在跑:等它这一轮收尾再送
  const kids = await query<any[]>(
    `SELECT id, title, awaiting_user, report_run_id FROM chat_sessions WHERE parent_session_id = ? AND kind = 'user' AND fork_message_id IS NULL`,
    [parentId],
  );
  if (!kids.length || kids.some((k) => busy.has(String(k.id)))) return; // 还有子会话在跑:等最后一个
  const [parent] = await query<any[]>(`SELECT id, user_id, app_id, model_id, agent_config, kind FROM chat_sessions WHERE id = ?`, [parentId]);
  if (!parent || parent.kind !== 'user') return;
  const parts: string[] = [];
  const delivered: Array<[string, string]> = [];
  let remote: RemoteInfo | undefined;
  let tainted = await sessionRemoteTainted(parentId);
  for (const k of kids) {
    if (!k.report_run_id) continue;
    const run = await getRun(String(k.report_run_id));
    if (run && !STATUS[String(run.status)]) continue; // 还没到终态(别的引擎进程持有 / 等认领):下次再送
    delivered.push([String(k.id), String(k.report_run_id)]);
    const input = decode(run?.input);
    if (input.remote) remote = remote || input.remote;
    if (input.remoteTainted || (await sessionRemoteTainted(String(k.id)))) tainted = true;
    // 那一轮里 ask_user 短路掉的问题(inquiries.INQUIRY_CHILD_ANSWER):模型之后失败 / 被停 / 没把问题写进收尾,也照样送回(Codex P2)
    const asked = peekChildQuestions(String(k.report_run_id));
    const status = run?.status === 'done' && (k.awaiting_user || asked.length) ? 'waiting_for_user' : STATUS[String(run?.status)] || 'stopped';
    // 只取挂起那一轮自己的回答:之后用户在子会话里(可能从手机)接着聊的不算(Codex 10-17 #1)。
    // ponytail: 那一轮被 steer 拆成几条时只取第一条;要全量得按时间窗取。
    const [msg] = run?.assistant_message_id ? await query<any[]>(`SELECT content FROM chat_messages WHERE id = ? LIMIT 1`, [run.assistant_message_id]) : [];
    const text = String(msg?.content || run?.error || '').trim();
    const excerpt = text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}… [truncated; read_session for the rest]` : text || '(no reply)';
    const askedBlock = asked.length ? `\nIt asked (ask_user, not answered yet):\n${asked.map((q) => `- ${q}`).join('\n')}` : '';
    parts.push(`<child id="${attr(String(k.id))}" title="${attr(String(k.title || ''))}" status="${status}">\n${excerpt}${askedBlock}\n</child>`);
  }
  if (!delivered.length) return;
  // 送达先落库(行 / run),再按 (id, run) 比对清挂起,最后才入队:清早了一失败就永久漏送;按 id 清会吞掉链外新记下的回报(Codex 10-17 #3/#4)。
  // ponytail: 落库与清挂起不在一个事务里,两步之间崩溃 → 重启后补送一行重复的回报;要零重复得包事务。
  const clear = async (): Promise<void> => {
    for (const [id, run] of delivered) {
      await query(`UPDATE chat_sessions SET report_run_id = NULL WHERE id = ? AND report_run_id = ?`, [id, run]);
      clearChildQuestions(run); // 回报已落库才清:中途失败重送时问题还在(Codex 10-28 P2)
    }
  };
  const text = [
    CHILD_UPDATE_OPEN,
    'Child sessions you started have reported back. The user can see and open them in their session list.',
    ...parts,
    'Next: if an excerpt is not enough, read the whole session with read_session. A child that is waiting_for_user asked something — answer it yourself with send_to_session when you can; ask the user only when it is genuinely their call. When the work is in, carry on with the user\'s task.',
    CHILD_UPDATE_CLOSE,
  ].join('\n');
  const modelId = String(parent.model_id || deps().profile.defaultModelId || '');
  const n = autoRuns.get(parentId) || 0;
  if (opts.rowOnly || n >= AUTO_CONTINUE_MAX || (tainted && !remote) || !autoContinueEnabled()) {
    // 只写行不起轮:用户下一句那一轮的历史里看得到它。
    await deps().state.insertUserMessage({ id: uuidv4(), sessionId: parentId, content: text, modelId, attachments: null });
    await query(`UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [parentId]);
    await clear();
    return;
  }
  autoRuns.set(parentId, n + 1);
  const cfg = decode(parent.agent_config);
  delete cfg.remoteOrigin;
  const runId = uuidv4();
  await createRun({
    id: runId, sessionId: parentId, userId: parent.user_id, appId: parent.app_id, modelId, assistantMessageId: uuidv4(),
    input: { message: text, userMessageId: uuidv4(), attachments: [], agentConfig: cfg, childReport: true, ...(remote ? { remote } : {}) },
  });
  await clear(); // 先清再入队:主会话这一轮收尾时不能再看见同一批回报(送达循环)
  enqueueRun(parentId, runId);
}
