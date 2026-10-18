/**
 * 旁聊(/btw):带着主会话的上下文问一句题外话 —— 不进主会话历史、不用工具、不排主 run 的队。
 *
 * 口径对齐 Claude Code 的 /btw(2026-09-22 调研,见 docs/Log 同日条目):
 *  - 上下文 = 主 agent 此刻看得到的那份(hydrateHistory:压缩检查点摘要 + 最近窗口,含工具调用与结果),
 *    渲染成转写放进系统提示。**正在生成的那条回复还没落库,旁聊看不到** —— 与 Claude Code 同口径;
 *    提示词里专门交代「最后那条用户消息可能还在处理中,别去答它」(Claude Code 2.1.79 栽过:拿主线的问题当旁问答)。
 *  - 旁聊自己的往返由客户端每次带上(thread,最近 ASIDE_MAX_TURNS 轮)当模型上下文。
 *  - 落库(10-18 用户定「顺便问留下来」):每答完一问,整段线程写进 chat_asides,挂在 (会话, 消息) 上 ——
 *    「从这里分出」里能重开。仍**不进主会话历史**(不在 chat_messages,主 agent / 会话搜索 / Historian 都看不到)。
 *  - 无工具:payload 不带 tools。模型仍把工具调用写成文本时,done 带 toolCallText 让客户端补一句「什么都没执行」
 *    (Claude Code 2.1.269 的坑)。
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import type { ChatMessage } from '../core/types.js';
import { hydrateHistory } from './agentLoop.js';
import { buildTranscript } from './compaction.js';
import { estimateMessagesTokens, estimateTokensRough, modelContextWindow } from './contextBudget.js';
import { looksLikeToolCallText } from '../llm/textToolCalls.js';

/** 每次带上的旁聊往返上限(Claude Code 同为 20)。 */
export const ASIDE_MAX_TURNS = 20;
const QUESTION_MAX = 8_000;
const QUOTE_MAX = 8_000;
const ANSWER_MAX = 20_000;
const ANSWER_MAX_TOKENS = 4_096;
const PROMPT_OVERHEAD_TOKENS = 1_500;

export interface AsideTurn { question: string; quote?: string; answer: string }
export interface AsideInput { question: string; quote?: string; thread: AsideTurn[] }

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** 请求体 → 旁聊输入(信任边界:全是客户端给的,逐项封顶)。没有问题 → null。 */
export function normalizeAsideInput(body: any): AsideInput | null {
  const question = text(body?.question, QUESTION_MAX);
  if (!question) return null;
  const rows: any[] = Array.isArray(body?.thread) ? body.thread.slice(-ASIDE_MAX_TURNS) : [];
  const thread = rows
    .map((t) => ({ question: text(t?.question, QUESTION_MAX), quote: text(t?.quote, QUOTE_MAX) || undefined, answer: text(t?.answer, ANSWER_MAX) }))
    .filter((t) => t.question && t.answer);
  return { question, quote: text(body?.quote, QUOTE_MAX) || undefined, thread };
}

export const ASIDE_SYSTEM_PROMPT = [
  'You are answering a quick side question (a "by the way") that the user asks next to their main conversation with an AI agent.',
  'The main conversation is included below for reference only. You are not the main agent: nothing in this side chat is added to the main conversation or seen by the main agent.',
  '',
  'Rules:',
  '- Answer only the side question, directly and concisely. Use the main conversation as context; do not continue, redo or take over the main task.',
  '- The last user message in the main conversation may still be in progress: the main agent may be working on it right now and its reply is not shown. Do not answer that message unless the side question asks about it.',
  '- You have no tools here. Never write tool calls, and never claim to have run commands, read files, searched or changed anything. If something needs an action, say what the user could ask the main agent to do.',
  '- If the main conversation does not contain what you need, say so briefly instead of guessing.',
  '- Reply in the language of the side question.',
].join('\n');

const asked = (question: string, quote?: string): string =>
  quote ? `About this excerpt:\n${quote.split('\n').map((l) => `> ${l}`).join('\n')}\n\n${question}` : question;

/** 系统提示(规则 + 主会话转写)→ 旁聊往返 → 本次问题。纯函数,导出供测试。
 *  ponytail: 转写塞进系统提示 = 与主 run 的前缀缓存零共享,每问一次整份上下文重进一遍(同一旁聊线程的追问之间
 *  system + 转写前缀不变,能命中)。长会话每问 ≈ 主会话上下文那么多输入 token。要省就改成回放主 run 的原始消息数组、
 *  旁问作尾部 user 轮(Claude Code 的做法),但得逐字节复刻主 agent 的系统提示与工具头才吃得到它的缓存。 */
export function buildAsideMessages(transcript: string, input: AsideInput): ChatMessage[] {
  return [
    { role: 'system', content: `${ASIDE_SYSTEM_PROMPT}\n\n<main_conversation>\n${transcript.trim() || '(no messages yet)'}\n</main_conversation>` },
    ...input.thread.flatMap((t) => [
      { role: 'user', content: asked(t.question, t.quote) },
      { role: 'assistant', content: t.answer },
    ]),
    { role: 'user', content: asked(input.question, input.quote) },
  ] as ChatMessage[];
}

export interface AsideAnswer { content: string; toolCallText: boolean }

export async function answerAside(opts: {
  sessionId: string
  userId: string
  modelId: string
  appId: string
  client?: string
  input: AsideInput
  signal: AbortSignal
  onToken: (delta: string) => void
}): Promise<AsideAnswer> {
  const llm = deps().brain.llm;
  const billing = deps().billing;
  const { model, apiKey, baseUrl, apiModelId } = await llm.resolveModelAndKey(opts.modelId);
  opts.signal.throwIfAborted();
  const { messages } = await hydrateHistory(opts.sessionId, '', undefined, undefined, undefined, false);
  // 转写预算:模型窗口 − 回答上限 − 旁聊往返 − 规则开销;超了由 buildTranscript 从最旧处丢(摘要块永不截)。
  const windowTokens = modelContextWindow(opts.modelId, model);
  const maxTokens = Math.max(512, Math.min(ANSWER_MAX_TOKENS, Math.floor(windowTokens / 4)));
  const budget = windowTokens - maxTokens - PROMPT_OVERHEAD_TOKENS - estimateTokensRough(JSON.stringify(opts.input));
  const { text: transcript } = buildTranscript(messages, { read: new Set(), modified: new Set() }, budget);
  const asideMessages = buildAsideMessages(transcript, opts.input);
  // 额度与记账同主循环 / 图像识别一个口径:先按估算预检(额度用尽不许绕道旁聊),完了按实际 usage 扣费、记用量。
  // standalone 的 billing 是 no-op;直连(BYOK / 订阅)模型取不到云端用户时降级成本地桩用户(同 visionService)。
  const user = (await deps().brain.users.getUserById(opts.userId).catch(() => null)) ?? { id: opts.userId, username: 'local' };
  const estCost = await billing.calculateCost(opts.modelId, estimateMessagesTokens(asideMessages), maxTokens, model);
  if (!(await billing.canConsumeTokenPoints(user.id, estCost)).ok) throw new Error('token_quota_exceeded');
  const payload = await llm.buildProviderPayload({
    model, apiModelId, messages: asideMessages,
    projectSource: '', usageSource: opts.appId, client: opts.client,
    maxTokens, stream: true, signal: opts.signal,
    cacheKey: `btw:${opts.sessionId}`, // 同一条旁聊线程的连续追问共用 system+转写前缀
  });
  opts.signal.throwIfAborted();
  const res = await llm.streamProviderCompletion({ apiKey, baseUrl, payload, provider: (model as any)?.provider, signal: opts.signal, onToken: opts.onToken });
  const usage: any = res?.usage || {};
  const cached = Number(usage.cached_tokens) || 0;
  const cost = await billing.calculateCost(opts.modelId, Number(usage.prompt_tokens) || 0, Number(usage.completion_tokens) || 0, model, cached);
  await billing.consumeTokenPoints(user.id, cost).catch(() => {});
  await (billing.logApiUsage as any)(
    (user as any).username || 'local', opts.modelId, (model as any)?.name, (model as any)?.provider,
    Number(usage.prompt_tokens) || 0, Number(usage.completion_tokens) || 0, true, undefined, opts.appId, cost, cached, opts.client,
  ).catch(() => {});
  const content = String(res?.content || '').trim();
  return { content, toolCallText: looksLikeToolCallText(content) };
}

/** 一条记录最多存的往返(更早的丢掉;模型上下文另由 ASIDE_MAX_TURNS 封顶)。 */
const SAVED_MAX_TURNS = 50;

const parseTurns = (v: unknown): AsideTurn[] => {
  try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a : []; } catch { return []; }
};

/** 答完一问 → 写回记录,返回它的 id 和实际挂上的消息。asideId 不是本人本会话的(删掉了 / 伪造)→ 另开一条;
 *  messageId 没给 / 不属于本会话 → 挂在本会话最近一条回答上(输入框 /btw、浮窗里问的不知道挂哪);一条回答都没有 → 不存(null)。
 *  已有记录以库里的往返为准(客户端只带最近 20 轮),只追加这一问。 */
export async function saveAside(p: { asideId?: string; sessionId: string; userId: string; messageId?: string; turn: AsideTurn; thread: AsideTurn[] }): Promise<{ id: string; messageId: string | null } | null> {
  // 续写:比对旧值再写(两扇窗同时续同一段,读到同一份 turns 各自覆盖会丢一问 —— Codex 10-18 #2);被抢了就重读再追加。
  for (let attempt = 0; p.asideId && attempt < 5; attempt++) {
    const [row] = await query<any[]>(`SELECT id, message_id, turns FROM chat_asides WHERE id = ? AND session_id = ? AND user_id = ? LIMIT 1`, [p.asideId, p.sessionId, p.userId]);
    if (!row) break;
    const turns = [...parseTurns(row.turns), p.turn].slice(-SAVED_MAX_TURNS);
    const hit = await query<any[]>(`UPDATE chat_asides SET turns = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND turns = ? RETURNING id`, [JSON.stringify(turns), row.id, row.turns]);
    if (hit.length) return { id: String(row.id), messageId: row.message_id ? String(row.message_id) : null };
  }
  // ponytail: 5 次都被抢就落到下面另开一条;真撞上再改成抛错 / 串行写
  const [m] = p.messageId ? await query<any[]>(`SELECT id FROM chat_messages WHERE id = ? AND session_id = ? LIMIT 1`, [p.messageId, p.sessionId]) : [];
  const [latest] = m ? [m] : await query<any[]>(
    `SELECT id FROM chat_messages WHERE session_id = ? AND role = 'model' ORDER BY timestamp DESC LIMIT 1`, [p.sessionId]);
  // 还没有回答可挂(空会话里问的):不存 —— 存了也没有地方重开(Codex 10-18 #5),照旧只在本次面板里
  if (!latest) return null;
  const id = uuidv4();
  await query(`INSERT INTO chat_asides (id, session_id, user_id, message_id, turns) VALUES (?, ?, ?, ?, ?)`,
    [id, p.sessionId, p.userId, String(latest.id), JSON.stringify([...p.thread, p.turn].slice(-SAVED_MAX_TURNS))]);
  return { id, messageId: String(latest.id) };
}

export async function listAsides(sessionId: string, userId: string): Promise<Array<{ id: string; message_id: string | null; turns: AsideTurn[]; created_at: string; updated_at: string }>> {
  const rows = await query<any[]>(
    `SELECT id, message_id, turns, created_at, updated_at FROM chat_asides WHERE session_id = ? AND user_id = ? ORDER BY created_at ASC LIMIT 200`,
    [sessionId, userId],
  );
  return rows.map((r) => ({ id: String(r.id), message_id: r.message_id ? String(r.message_id) : null, turns: parseTurns(r.turns), created_at: r.created_at, updated_at: r.updated_at }));
}

export async function deleteAside(id: string, sessionId: string, userId: string): Promise<void> {
  await query(`DELETE FROM chat_asides WHERE id = ? AND session_id = ? AND user_id = ?`, [id, sessionId, userId]);
}
