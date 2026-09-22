/**
 * 旁聊(/btw):带着主会话的上下文问一句题外话 —— 不进主会话历史、不用工具、不排主 run 的队。
 *
 * 口径对齐 Claude Code 的 /btw(2026-09-22 调研,见 docs/Log 同日条目):
 *  - 上下文 = 主 agent 此刻看得到的那份(hydrateHistory:压缩检查点摘要 + 最近窗口,含工具调用与结果),
 *    渲染成转写放进系统提示。**正在生成的那条回复还没落库,旁聊看不到** —— 与 Claude Code 同口径;
 *    提示词里专门交代「最后那条用户消息可能还在处理中,别去答它」(Claude Code 2.1.79 栽过:拿主线的问题当旁问答)。
 *  - 旁聊自己的往返由客户端每次带上(thread,最近 ASIDE_MAX_TURNS 轮),服务端一个字节都不落。
 *  - 无工具:payload 不带 tools。模型仍把工具调用写成文本时,done 带 toolCallText 让客户端补一句「什么都没执行」
 *    (Claude Code 2.1.269 的坑)。
 */
import { deps } from '../seams/runtime.js';
import type { ChatMessage } from '../core/types.js';
import { hydrateHistory } from './agentLoop.js';
import { buildTranscript } from './compaction.js';
import { estimateTokensRough, modelContextWindow } from './contextBudget.js';
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
  modelId: string
  appId: string
  client?: string
  input: AsideInput
  signal: AbortSignal
  onToken: (delta: string) => void
}): Promise<AsideAnswer> {
  const llm = deps().brain.llm;
  const { model, apiKey, baseUrl, apiModelId } = await llm.resolveModelAndKey(opts.modelId);
  opts.signal.throwIfAborted();
  const { messages } = await hydrateHistory(opts.sessionId, '', undefined, undefined, undefined, false);
  // 转写预算:模型窗口 − 回答上限 − 旁聊往返 − 规则开销;超了由 buildTranscript 从最旧处丢(摘要块永不截)。
  const windowTokens = modelContextWindow(opts.modelId, model);
  const maxTokens = Math.max(512, Math.min(ANSWER_MAX_TOKENS, Math.floor(windowTokens / 4)));
  const budget = windowTokens - maxTokens - PROMPT_OVERHEAD_TOKENS - estimateTokensRough(JSON.stringify(opts.input));
  const { text: transcript } = buildTranscript(messages, { read: new Set(), modified: new Set() }, budget);
  const payload = await llm.buildProviderPayload({
    model, apiModelId, messages: buildAsideMessages(transcript, opts.input),
    projectSource: '', usageSource: opts.appId, client: opts.client,
    maxTokens, stream: true, signal: opts.signal,
    cacheKey: `btw:${opts.sessionId}`, // 同一条旁聊线程的连续追问共用 system+转写前缀
  });
  opts.signal.throwIfAborted();
  const res = await llm.streamProviderCompletion({ apiKey, baseUrl, payload, provider: (model as any)?.provider, signal: opts.signal, onToken: opts.onToken });
  const content = String(res?.content || '').trim();
  return { content, toolCallText: looksLikeToolCallText(content) };
}
