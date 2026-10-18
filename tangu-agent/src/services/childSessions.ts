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
 *  - 只一层:子会话不能再开子会话(列表的树只画一层)。
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

export const CHILD_UPDATE_OPEN = '<child_sessions_update>';
export const CHILD_UPDATE_CLOSE = '</child_sessions_update>';
const AUTO_CONTINUE_MAX = 3;
const MAX_RUNNING_CHILDREN = 4;
const EXCERPT_CHARS = 1500;
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
}): Promise<{ sessionId: string; runId: string; title: string }> {
  const [parent] = await query<any[]>(
    `SELECT id, user_id, app_id, kind, parent_session_id, project_path, project_name, projectless, agent_config, model_id FROM chat_sessions WHERE id = ?`,
    [p.parentId],
  );
  if (!parent || parent.user_id !== p.userId || parent.kind !== 'user') throw new Error('This conversation cannot start child sessions.');
  if (parent.parent_session_id) throw new Error('This is already a child session, and child sessions cannot start their own. Do the work here, or finish and let the main session decide.');
  const { activeSessionIds } = await loop();
  const busy = activeSessionIds();
  const kids = await query<any[]>(`SELECT id FROM chat_sessions WHERE parent_session_id = ? AND kind = 'user'`, [p.parentId]);
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
  const runId = await queueFromParent({ sessionId, userId: p.userId, appId: parent.app_id, modelId, message: p.message, agentConfig: runConfig, remote: p.remote });
  return { sessionId, runId, title };
}

/** 主会话给自己的子会话再说一句(回答它的问题、补一个要求):子会话在跑就排在后面。 */
export async function sendToChildSession(p: { parentId: string; userId: string; childId: string; message: string; remote?: RemoteInfo }): Promise<{ runId: string; queued: boolean; title: string }> {
  const [child] = await query<any[]>(
    `SELECT id, user_id, app_id, kind, parent_session_id, agent_config, model_id, title FROM chat_sessions WHERE id = ?`,
    [p.childId],
  );
  if (!child || child.user_id !== p.userId || child.kind !== 'user' || child.parent_session_id !== p.parentId) {
    throw new Error('No such child session of this conversation. Only sessions you started with start_session can be messaged.');
  }
  const { activeSessionIds } = await loop();
  const queued = activeSessionIds().has(p.childId);
  const cfg = decode(child.agent_config);
  delete cfg.remoteOrigin; // 标记只在会话存值里,run 的污点是 input.remote
  const runId = await queueFromParent({ sessionId: p.childId, userId: p.userId, appId: child.app_id, modelId: child.model_id || '', message: p.message, agentConfig: cfg, remote: p.remote });
  return { runId, queued, title: String(child.title || '') };
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
    `SELECT id, report_run_id FROM chat_sessions WHERE parent_session_id = ? AND user_id = ? AND kind = 'user'`, [sessionId, userId]);
  if (kids.some((k: any) => busy.has(k.id) || k.report_run_id)) return false;
  await query(`UPDATE chat_sessions SET awaiting_user = TRUE WHERE id = ? AND user_id = ?`, [sessionId, userId]);
  return true;
}

/** 每一轮开始:清「等你」;用户自己发的一轮 → 连续自动接着做的计数归零。 */
export async function onRunStart(sessionId: string, input: any, runId: string): Promise<void> {
  if (!deps().profile.capabilities.hostExec) return; // 父子会话只在本机引擎(云端 thin worker 不直连库)
  if (input?.origin === 'client') autoRuns.delete(sessionId);
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
  const [s] = await query<any[]>(`SELECT kind, parent_session_id FROM chat_sessions WHERE id = ?`, [sid]);
  if (!s || s.kind !== 'user') return;
  await deliverChildReports(s.parent_session_id ? String(s.parent_session_id) : sid);
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
  if (!(input?.origin === 'client' || input?.fromParent === true || input?.childReport === true)) return;
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
    `SELECT id, title, awaiting_user, report_run_id FROM chat_sessions WHERE parent_session_id = ? AND kind = 'user'`,
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
    const status = run?.status === 'done' && k.awaiting_user ? 'waiting_for_user' : STATUS[String(run?.status)] || 'stopped';
    // 只取挂起那一轮自己的回答:之后用户在子会话里(可能从手机)接着聊的不算(Codex 10-17 #1)。
    // ponytail: 那一轮被 steer 拆成几条时只取第一条;要全量得按时间窗取。
    const [msg] = run?.assistant_message_id ? await query<any[]>(`SELECT content FROM chat_messages WHERE id = ? LIMIT 1`, [run.assistant_message_id]) : [];
    const text = String(msg?.content || run?.error || '').trim();
    const excerpt = text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}… [truncated; read_session for the rest]` : text || '(no reply)';
    parts.push(`<child id="${attr(String(k.id))}" title="${attr(String(k.title || ''))}" status="${status}">\n${excerpt}\n</child>`);
  }
  if (!delivered.length) return;
  // 送达先落库(行 / run),再按 (id, run) 比对清挂起,最后才入队:清早了一失败就永久漏送;按 id 清会吞掉链外新记下的回报(Codex 10-17 #3/#4)。
  // ponytail: 落库与清挂起不在一个事务里,两步之间崩溃 → 重启后补送一行重复的回报;要零重复得包事务。
  const clear = async (): Promise<void> => {
    for (const [id, run] of delivered) await query(`UPDATE chat_sessions SET report_run_id = NULL WHERE id = ? AND report_run_id = ?`, [id, run]);
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
