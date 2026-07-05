/**
 * @讨论(Mode B):主 agent「分身」一个自己进**后台 2 人群聊**,和被 @ 的对象 agent 来回讨论到投票结束,
 * 把综合结论带回。复用 muse 的「独立 session + 自有 run + enqueueRun」后台范式(同会话 run 串行 → 后台讨论
 * 必须独立 session,否则排在主 run 队列后面等它结束)+ runGroupChat 编排(经 agentLoop 的 groupChat 闸自动路由)。
 *
 * start → 立即返回 discRunId 句柄(后台跑,主 run 不阻塞);wait(discRunId) → 跑完直接读结论,
 * 没跑完就订阅 eventBus 等 done。状态/结论全在 DB(agent_runs + chat_messages),**不建内存注册表**。
 *
 * 「分身」= 主 agent 的**人设**(getAgent(selfSlug):systemPrompt+SOUL)+ 主 agent 框定的**话题**(群聊开场白)。
 * ponytail: 不播种主对话全历史 —— 主 agent 是调用方、握有全上下文,自己框定话题足矣(= delegate 模型)。
 * 仅 host 形态(discuss 工具 hostExec 闸)触达 → 云端不可达,直接走本地 core/db(同 muse/sessionBranch)。
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';
import { createRun, getRun } from './runStore.js';
import { subscribe } from './eventBus.js';
import { getAgent } from '../agents/agentRegistry.js';
// enqueueRun 走动态 import(见 startDiscussion):静态 import 会成环 discussion←discuss←registry←agentLoop,
// 令 registry 初始化时 discussProvider 尚未定义而崩。仅运行时调用,延迟加载无碍(muse 可静态因它不在 registry 环上)。

const DISCUSSION_RESULT_CAP = 12_000;
// 讨论可能多轮、较久;等待上限默认 10 分钟,超时返回当前转录 + 「仍在进行」提示(主 agent 可再 wait)。
const WAIT_TIMEOUT_MS = Math.max(30_000, Number(process.env.TANGU_DISCUSSION_WAIT_TIMEOUT_MS) || 600_000);

export interface StartDiscussionParams {
  userId: string;
  appId: string;
  modelId: string;
  /** 主 agent(分身)的定义 slug —— 群聊里以它的人设参与。 */
  selfSlug: string;
  /** 对象:已存盘 agent slug(与 peerInstructions 二选一)。 */
  peerSlug?: string;
  /** 对象:内联临时人设(主 agent 自建一个临时对象);与 peerSlug 二选一。 */
  peerInstructions?: string;
  peerName?: string;
  /** 讨论话题(自包含——对象看不到主对话)。 */
  topic: string;
  context?: string;
  /** 讨论深度(轮数;默认 7,封顶 30,投票可提前结束)。 */
  maxRounds?: number;
  /** Background Session 父链接:发起讨论的主会话 id(右栏「子聊天」经 /background 端点持久列出)。 */
  parentSessionId?: string;
}

function isTerminal(status: string): boolean {
  return status === 'done' || status === 'failed' || status === 'aborted';
}

/** 起一个后台讨论 run,返回它的 runId(句柄)。不阻塞——讨论在独立 session 异步跑。 */
export async function startDiscussion(p: StartDiscussionParams): Promise<string> {
  const selfSlug = (p.selfSlug || '').trim();
  // 分身要主 agent 的人设:拿不到就没法跑(默认 agent 始终存在;自定义 agent 须已存盘)。
  const selfDef = await getAgent(selfSlug).catch(() => null);
  if (!selfDef) throw new Error(`current agent "${selfSlug}" not found — cannot start a discussion`);

  // 对象:已存盘 slug,或内联临时 agent(随 agentConfig.groupTempAgents 传给群聊,不落盘)。
  let peerSlug = (p.peerSlug || '').trim();
  const groupTempAgents: any[] = [];
  const instructions = (p.peerInstructions || '').trim();
  if (peerSlug) {
    const peerDef = await getAgent(peerSlug).catch(() => null);
    if (!peerDef) throw new Error(`peer agent "${peerSlug}" not found`);
  } else if (instructions) {
    peerSlug = `peer-${uuidv4().slice(0, 8)}`;
    groupTempAgents.push({
      slug: peerSlug,
      name: (p.peerName || 'Peer').slice(0, 120),
      description: '',
      systemPrompt: instructions.slice(0, 100_000),
    });
  }
  if (!peerSlug) throw new Error('discussion requires a peer (a named agent slug, or inline instructions)');
  if (peerSlug === selfSlug) throw new Error('cannot start a discussion with yourself');

  // 独立讨论 session(kind='discussion' → 不进用户会话列表;独立 → 不排主 run 的队)。
  // parent_session_id 指回主会话 → 子聊天面板经 /background 端点持久可见(reload 后仍能列出/回放)。
  const sessionId = uuidv4();
  const title = `讨论:${p.topic.slice(0, 60)}`;
  await query(
    `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, parent_session_id) VALUES (?, ?, ?, ?, ?, 'discussion', ?)`,
    [sessionId, p.userId, p.appId, title, p.modelId, p.parentSessionId || null],
  );

  const runId = uuidv4();
  await createRun({
    id: runId,
    sessionId,
    userId: p.userId,
    appId: p.appId,
    modelId: p.modelId,
    assistantMessageId: uuidv4(),
    input: {
      message: p.context ? `${p.topic}\n\n## Context\n${p.context}` : p.topic,
      userMessageId: uuidv4(),
      attachments: [],
      agentConfig: {
        groupChat: true,
        groupAgents: [selfSlug, peerSlug],
        groupTempAgents,
        priorityAgent: peerSlug, // 对象先发(回应主 agent 抛出的话题),主 agent 分身随后接
        groupMaxRounds: p.maxRounds,
        groupAutoSummary: true, // 后台无交互用户 → 直接出主持人总结作结论(不问 ask_user)
        _discussion: true, // 标记:此 run 内禁再起讨论(防递归)
        execMode: 'host',
      },
    },
  });
  const { enqueueRun } = await import('./agentLoop.js');
  enqueueRun(sessionId, runId);
  return runId;
}

/** 取讨论结论:跑完直接读;没跑完订阅 eventBus 等 done(带超时 + 父中止),再读。 */
export async function waitDiscussion(discRunId: string, userId: string, signal?: AbortSignal): Promise<string> {
  const run = await getRun(discRunId);
  if (!run || run.user_id !== userId) return `Error: discussion "${discRunId}" not found`;
  if (!isTerminal(run.status)) {
    await waitForTerminal(discRunId, signal);
  }
  const after = (await getRun(discRunId)) || run;
  return readConclusion(after.session_id, after.status);
}

/** 订阅讨论 run 的事件,等 done/error;带超时与父中止(任一即返回,不抛)。 */
function waitForTerminal(discRunId: string, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      off();
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const off = subscribe(discRunId, (ev) => {
      if (ev.type === 'done' || ev.type === 'error') finish();
    });
    const onAbort = (): void => finish();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(finish, WAIT_TIMEOUT_MS);
    // 订阅后再查一次状态:防 done 在 subscribe 之前就已发布(竞态)。
    getRun(discRunId).then((r) => { if (r && isTerminal(r.status)) finish(); }).catch(() => {});
  });
}

/** 读讨论 session 的发言并格式化结论(主持人总结优先,否则完整转录)。 */
async function readConclusion(sessionId: string, status: string): Promise<string> {
  let rows: any[] = [];
  try {
    // 助手消息在 chat_messages 里 role='model'(非 'assistant'——见 sqlStateStore.finalizeAssistantMessage)。
    rows = await query<any[]>(
      `SELECT content FROM chat_messages WHERE session_id = ? AND role = 'model' ORDER BY timestamp ASC`,
      [sessionId],
    );
  } catch { /* 读失败按空处理 */ }
  const msgs = (rows || []).map((r) => String(r?.content || '').trim()).filter(Boolean);
  return formatConclusion(msgs, status);
}

/**
 * 纯函数:把讨论发言列表 + run 终态格式化成给主 agent 的结论字符串。
 * 主持人总结(groupAutoSummary 末尾产出,含「主持人」)= 结论;无则退回完整转录;空则按状态give提示。
 * 非 done 终态前缀状态说明。提取出来便于单测(无 DB)。
 */
export function formatConclusion(msgs: string[], status: string): string {
  const clean = (msgs || []).map((m) => String(m || '').trim()).filter(Boolean);
  if (!clean.length) {
    if (!isTerminal(status)) return '(discussion still in progress — no conclusion yet; call wait_discussion again later)';
    return `(discussion ${status} with no output)`;
  }
  const summary = [...clean].reverse().find((m) => m.includes('主持人'));
  const body = summary || clean.join('\n\n');
  const prefix = status === 'done' ? '' : `(discussion ended: ${status})\n\n`;
  return (prefix + body).slice(0, DISCUSSION_RESULT_CAP);
}
