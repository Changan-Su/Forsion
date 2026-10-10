/**
 * 输入建议:一轮结束后,猜用户下一句最可能发什么,客户端在空输入框里用灰字给出,Tab 采用。
 * 对标 Claude Code 的 prompt suggestions(2026-10-10)。客户端默认关,开了才来拉。
 *
 * 成本只有「多读一次缓存」的前提是**请求前缀与主循环逐字节相同**,所以走 Historian 分身判官那条管线
 * (localHistorian.ts forkJudge),不走旁聊那条(aside.ts 把转写塞进系统提示,与主循环零共享):
 *   run 收尾时的 workingMessages 快照 + 收尾正文 + 一条尾部指令,同工具面、同思考档、cacheKey = sessionId。
 *
 * 拉而不推:run 事件流在 done 就关了,收尾后没有通道可推;把 done 往后拖一次模型往返又是肉眼可见的回归。
 * 所以引擎只在收尾时**存一份快照的引用**(不发请求,客户端没开就是零 token),客户端收到 done 后
 * POST /agent/sessions/:id/suggest 才真的调一次。快照一次性、短命:过期 / 进程重启 / 落到别的进程 → 回空串。
 * 「没有建议」是正常结果,任何一步拿不准都回空,不退回「重建上下文再问」(那就是整份上下文按原价重进)。
 *
 * 只在本机引擎(hostExec)存快照:云端一个进程服务很多用户,而这条路由到不了跑那一轮的执行节点。
 */
import { deps } from '../seams/runtime.js';
import type { ChatMessage } from '../core/types.js';
import type { HistorianForkSeed } from './localHistorian.js';
import { buildSharedPrefix } from './selfBrainstorm.js';
import { effectiveContextWindowInfo, estimateMessageTokens } from './contextBudget.js';
import { thinkingHeadroom } from '../llm/openaiCompat.js';
import { looksLikeToolCallText } from '../llm/textToolCalls.js';

/** 快照留多久。客户端是收到 done 立刻来拉的;留长了只是多攥一会儿 workingMessages(可能带截图)。 */
const SEED_TTL_MS = 90_000;
/** 同时留几个会话的快照(最旧的先丢)。 */
const SEED_MAX = 4;
/** 与分身判官同款护栏:前缀估算超过窗口这个比例就不问了。 */
const CONTEXT_HEADROOM = 0.75;
/** 正文上限。思考的 token 另由 thinkingHeadroom 留(见 docs/direct-model-calls.md「输出上限要跟着留」)。 */
const SUGGEST_MAX_TOKENS = 120;
/** 建议最长多少个字符;再长就不是「下一句」了,整个不要。 */
export const SUGGEST_MAX_CHARS = 100;
const SUGGEST_TIMEOUT_MS = 20_000;

export const SUGGEST_INSTRUCTION = [
  '[SUGGESTION MODE: this message comes from the app, not from the user. Do not continue the conversation.]',
  'Predict the single message the user is most likely to send next. The app shows it as greyed-out text in the empty input box, and the user can press Tab to use it.',
  '',
  'Output rules:',
  '- Output only the predicted message on one line. No quotes, no label, no explanation.',
  "- Write it in the user's voice and language, the way they have been writing in this conversation. Keep it short: about 2 to 12 words.",
  '- Good predictions: the answer to a question you just asked them (pick the option they most plausibly want), the obvious next step you offered or that their plan implies, or the follow-up they have been building toward.',
  '- Never predict praise, thanks or filler ("looks good", "thanks", "ok"). Never write something only the assistant would say. Never start a new topic.',
  '- If you cannot predict it with reasonable confidence, output exactly: NONE',
  '- Do not call tools. Any tool call is discarded.',
].join('\n');

interface Stashed { runId: string; seed: HistorianForkSeed; at: number }
const seeds = new Map<string, Stashed>();

/** agentLoop 主路径收尾时调(发 done 之前):只存引用,不发请求。 */
export function stashSuggestionSeed(sessionId: string, runId: string, seed: HistorianForkSeed): void {
  if (!deps().profile.capabilities.hostExec) return;
  const now = Date.now();
  for (const [sid, s] of seeds) if (now - s.at >= SEED_TTL_MS) seeds.delete(sid);
  seeds.delete(sessionId); // 重新插到队尾:Map 的迭代序就是新旧序
  seeds.set(sessionId, { runId, seed, at: now });
  while (seeds.size > SEED_MAX) seeds.delete(seeds.keys().next().value as string);
}

/** 取走即删:一轮最多问一次(同一个 done 被两个窗口各拉一次,第二个拿空)。 */
function takeSeed(sessionId: string, runId?: string): HistorianForkSeed | null {
  const s = seeds.get(sessionId);
  if (!s) return null;
  if (runId && s.runId !== runId) return null; // 客户端问的是更早那一轮:留着这份给对的人
  seeds.delete(sessionId);
  return Date.now() - s.at < SEED_TTL_MS ? s.seed : null;
}

/** 模型原话 → 能放进输入框的一句;不合规就是空串(不取首行硬凑)。 */
export function cleanSuggestion(raw: unknown): string {
  let s = String(raw ?? '').trim();
  if (!s || /[\r\n]/.test(s)) return ''; // 多行 = 没照「只出一句」做(解释 / 列表 / 把对话接着答了下去)
  s = s.replace(/^["'`“”‘’「『]+|["'`“”‘’」』]+$/g, '').trim();
  if (!s || /^none[.。!！]?$/i.test(s)) return '';
  if ([...s].length > SUGGEST_MAX_CHARS) return '';
  if (looksLikeToolCallText(s)) return '';
  return s;
}

export interface SuggestionResult {
  suggestion: string
  /** 这次调用的用量(没调模型就没有)。cached 与 prompt 同量级 = 前缀缓存命中,这功能的成本就靠它。 */
  usage?: { prompt: number; cached: number; completion: number }
}

/** 拿这个会话刚结束那一轮的快照问一次。任何拿不准 / 失败都回空建议,不抛。 */
export async function suggestNextPrompt(opts: {
  sessionId: string
  userId: string
  appId: string
  /** 客户端刚看到收尾的那个 run;对不上快照就不问。 */
  runId?: string
  client?: string
  signal?: AbortSignal
}): Promise<SuggestionResult> {
  const seed = takeSeed(opts.sessionId, opts.runId);
  if (!seed) return { suggestion: '' };
  const timeout = AbortSignal.timeout(SUGGEST_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    const prefix = buildSharedPrefix(seed.getMessages());
    const last: any = prefix[prefix.length - 1];
    // 收尾不是一段模型正文(额度 / 截断 / 步数耗尽等异常出口)→ 没有可接的话头
    if (last?.role !== 'assistant' || !String(last.content || '').trim()) return { suggestion: '' };
    const llm = deps().brain.llm;
    const billing = deps().billing;
    const { model, apiKey, baseUrl, apiModelId } = await llm.resolveModelAndKey(seed.modelId);
    const est = prefix.reduce((n, m) => n + estimateMessageTokens(m), 0);
    const win = seed.contextWindow || effectiveContextWindowInfo(seed.modelId, model).tokens;
    if (est > win * CONTEXT_HEADROOM) return { suggestion: '' };
    // 与父 run 同档:没有原生思考的模型,档位是注进 system 的一句话,档不同前缀就不同(forkJudge 同款)。
    const thinkingLevel = (seed.thinkingLevel as any) || 'medium';
    const maxTokens = SUGGEST_MAX_TOKENS + thinkingHeadroom({ model, baseUrl, apiModelId }, thinkingLevel);
    // 额度口径同旁聊:先按估算预检(额度用尽不许从这里绕),完了按实际用量扣、记。本机直连时 billing 是空操作。
    const user = (await deps().brain.users.getUserById(opts.userId).catch(() => null)) ?? { id: opts.userId, username: 'local' };
    const estCost = await billing.calculateCost(seed.modelId, est, maxTokens, model);
    if (!(await billing.canConsumeTokenPoints(user.id, estCost)).ok) return { suggestion: '' };
    const payload = await llm.buildProviderPayload({
      model, apiModelId,
      // 逐请求深拷贝:构建器会原地改消息,不拷就污染 Historian 也在用的那份快照。
      messages: structuredClone([...prefix, { role: 'user', content: SUGGEST_INSTRUCTION } as ChatMessage]),
      projectSource: opts.appId,
      usageSource: 'tangu',
      client: opts.client,
      temperature: 0.3,
      thinkingLevel,
      tools: seed.tools, // 工具头参与前缀缓存,必须带同一份;不执行靠指令 + 结果侧丢弃
      toolChoice: 'auto',
      attachments: [],
      stream: true,
      maxTokens,
      signal,
      cacheKey: opts.sessionId, // 与主循环同键:同前缀必须同键
    } as any);
    signal.throwIfAborted();
    const res = await llm.streamProviderCompletion({ apiKey, baseUrl, payload, provider: (model as any)?.provider, signal });
    const u: any = res?.usage || {};
    const usage = { prompt: Number(u.prompt_tokens) || 0, cached: Number(u.cached_tokens) || 0, completion: Number(u.completion_tokens) || 0 };
    try {
      const cost = await billing.calculateCost(seed.modelId, usage.prompt, usage.completion, model, usage.cached);
      await billing.consumeTokenPoints(user.id, cost);
      await (billing.logApiUsage as any)(
        (user as any).username || 'local', seed.modelId, (model as any)?.name, (model as any)?.provider,
        usage.prompt, usage.completion, true, undefined, 'tangu-suggest', cost, usage.cached, opts.client,
      );
    } catch { /* 记账失败不该把已经拿到的建议丢掉 */ }
    // 截断的半句不给:用户按 Tab 拿到的得是一句完整的话
    const suggestion = (res as any)?.finishReason === 'length' ? '' : cleanSuggestion(res?.content);
    return { suggestion, usage };
  } catch (e: any) {
    if (!signal.aborted) console.warn(`[agent-core] session=${opts.sessionId} 输入建议失败(按没有建议处理):`, e?.message || e);
    return { suggestion: '' };
  }
}

/** 测试用:清空快照。 */
export function __resetSuggestionSeedsForTests(): void { seeds.clear(); }
