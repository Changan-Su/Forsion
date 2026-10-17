/**
 * 父子会话(方案「子会话与任务卡」2026-10-17,第 1、2 步):主会话用 start_session 开出**可见**的子会话(kind='user' + parent_session_id,
 * 会话列表里挂在主会话下面),子会话自己跑;主会话起的那一轮跑完,结果送回主会话,主会话空闲且名下没有子会话在跑时自己接着做。
 *
 *  - 回报挂起:子会话里 input.fromParent 的那一轮收尾 → chat_sessions.report_run_id = 那一轮;送达时清空。
 *    用户自己点进子会话聊的轮次不回报(那是用户在驱动,主会话不该被它叫醒)。
 *  - 送达(deliverChildReports):主会话空闲 + 名下没有子会话在跑 → 一条 `<child_sessions_update>` 用户行(界面画成系统行)+ 起一轮。
 *    连续自动接着做 AUTO_CONTINUE_MAX 次后只写行不起轮,等用户下一句;远程污点子会话的结果也只写行(不替用户在本机自动起轮)。
 *  - 等你:wait_for_user 置 awaiting_user;任何一轮开始时清掉(onRunStart)。
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

/** wait_for_user:这一轮停下来是在等用户回答 / 拍板。 */
export async function markAwaitingUser(sessionId: string, userId: string): Promise<void> {
  await query(`UPDATE chat_sessions SET awaiting_user = TRUE WHERE id = ? AND user_id = ?`, [sessionId, userId]);
}

/** 每一轮开始:清「等你」;用户自己发的一轮 → 连续自动接着做的计数归零。 */
export async function onRunStart(sessionId: string, input: any): Promise<void> {
  if (!deps().profile.capabilities.hostExec) return; // 父子会话只在本机引擎(云端 thin worker 不直连库)
  if (input?.origin === 'client') autoRuns.delete(sessionId);
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
  if (s.parent_session_id) {
    if (input.fromParent === true) await query(`UPDATE chat_sessions SET report_run_id = ? WHERE id = ?`, [runId, sid]);
    await deliverChildReports(String(s.parent_session_id));
  } else {
    await deliverChildReports(sid);
  }
}

const chains = new Map<string, Promise<void>>();
/** 同一主会话的送达串行(两个子会话同时收尾不会各起一轮)。 */
export function deliverChildReports(parentId: string): Promise<void> {
  const next = (chains.get(parentId) || Promise.resolve()).catch(() => {}).then(() => deliverNow(parentId));
  chains.set(parentId, next);
  void next.finally(() => { if (chains.get(parentId) === next) chains.delete(parentId); }).catch(() => {});
  return next;
}

const STATUS: Record<string, string> = { done: 'finished', failed: 'failed', aborted: 'stopped' };

async function deliverNow(parentId: string): Promise<void> {
  const { activeSessionIds, enqueueRun } = await loop();
  const busy = activeSessionIds();
  if (busy.has(parentId)) return; // 主会话在跑:等它这一轮收尾再送
  const kids = await query<any[]>(
    `SELECT id, title, awaiting_user, report_run_id FROM chat_sessions WHERE parent_session_id = ? AND kind = 'user'`,
    [parentId],
  );
  if (!kids.length || kids.some((k) => busy.has(String(k.id)))) return; // 还有子会话在跑:等最后一个
  const due = kids.filter((k) => k.report_run_id);
  if (!due.length) return;
  const [parent] = await query<any[]>(`SELECT id, user_id, app_id, model_id, agent_config, kind FROM chat_sessions WHERE id = ?`, [parentId]);
  if (!parent || parent.kind !== 'user') return;
  const parts: string[] = [];
  let remote: RemoteInfo | undefined;
  let tainted = false;
  for (const k of due) {
    const run = await getRun(String(k.report_run_id));
    const input = decode(run?.input);
    if (input.remote) remote = remote || input.remote;
    else if (input.remoteTainted) tainted = true;
    const status = run?.status === 'done' && k.awaiting_user ? 'waiting_for_user' : STATUS[String(run?.status)] || 'finished';
    const [msg] = await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = ? AND role = 'model' ORDER BY timestamp DESC LIMIT 1`, [k.id]);
    const text = String(msg?.content || run?.error || '').trim();
    const excerpt = text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}… [truncated; read_session for the rest]` : text || '(no reply)';
    parts.push(`<child id="${attr(String(k.id))}" title="${attr(String(k.title || ''))}" status="${status}">\n${excerpt}\n</child>`);
  }
  // 先清挂起再起轮:否则主会话那一轮收尾时又看见同一批回报(送达循环)。
  await query(`UPDATE chat_sessions SET report_run_id = NULL WHERE id IN (${due.map(() => '?').join(',')})`, due.map((k) => k.id));
  const text = [
    CHILD_UPDATE_OPEN,
    'Child sessions you started have reported back. The user can see and open them in their session list.',
    ...parts,
    'Next: if an excerpt is not enough, read the whole session with read_session. A child that is waiting_for_user asked something — answer it yourself with send_to_session when you can; ask the user only when it is genuinely their call. When the work is in, carry on with the user\'s task.',
    CHILD_UPDATE_CLOSE,
  ].join('\n');
  const modelId = String(parent.model_id || deps().profile.defaultModelId || '');
  const n = autoRuns.get(parentId) || 0;
  if (n >= AUTO_CONTINUE_MAX || tainted || !autoContinueEnabled()) {
    // 只写行不起轮:用户下一句那一轮的历史里看得到它。
    await deps().state.insertUserMessage({ id: uuidv4(), sessionId: parentId, content: text, modelId, attachments: null });
    await query(`UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [parentId]);
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
  enqueueRun(parentId, runId);
}
