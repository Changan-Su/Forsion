/**
 * 上下文预算与压缩(参考 Hermes Agent 的工程做法):
 *
 *  - estimateTokensRough:CJK 感知的粗估(ASCII ~4 字符/token,非 ASCII ~1 token/字符)。
 *    比 length/4 对中文/二进制垃圾准一个量级——77 万 token 事故的 prompt 用 length/4 会低估 4 倍。
 *  - 入站闸门(对齐 Hermes context_references 的窗口相对预算):估算 > 窗口 50% 拒绝、> 25% 警告。
 *  - compactionThreshold:LLM 摘要压缩的触发线 = 窗口 − 预留(借 pi reserveTokens 的绝对余量口径,
 *    不再是 95% 这种比例)。平时历史 append-only;09-15 起**不再有 50% 的机械折叠档**——它每轮改写
 *    最近 ~20 条之外的消息,前缀缓存从改写点起每轮都断,且在还远没满载时就把工具输出绞成 450 字符,
 *    对缓存计价的供应商是净亏;单条工具结果的 48k 硬帽已兜住「77 万 token」那类事故。
 *  - compactContext:机械批量折叠(保头 3 + 尾 20,中段定型),幂等——现在**只作 LLM 摘要失败时的兜底**。
 *  - capToolResult:工具结果入列硬帽,兜底未封顶路径(host list_dir 大目录、custom provider 等)。
 *
 * 模型上下文窗口:见 modelContextWindowInfo 的优先级链 —— 人填的(env 覆盖 / 用户本机 modelOverrides /
 *    admin 在模型上填的 context_window)> 上游实测的(contextWindowStore 从超长报错里回学)> 手写族表 > 272k 兜底。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tanguHome } from '../core/tanguHome.js';
import type { ChatMessage, ToolCall } from '../core/types.js';
import { learnedWindow } from './contextWindowStore.js';
import { modelOverrides } from './modelOverrides.js';

/**
 * 锚定消息(借 Codex「reference context item」):注入的 system/skills/memory 块等——compactContext 永不折叠。
 * 用对象身份(WeakSet)而非消息上的可枚举字段标记,确保不泄漏到发给 provider 的 wire payload、不破坏前缀缓存。
 */
const pinnedMessages = new WeakSet<object>();
export function pinMessage<T extends object>(m: T): T {
  if (m) pinnedMessages.add(m);
  return m;
}

/**
 * 有损消息(09-15):内容已被机械折叠(compactContext)或 hydrate 时按单条硬帽截断过,与落库原文不再等价。
 * 压缩边界看到范围里有它就**不落持久检查点**(只留 run 内摘要)—— 否则摘要只见过 450 字符的折叠文本,
 * 却把整行标成「已覆盖」,原文从此再也回放不到(Codex 09-15 评审 #4/#5)。同 pinMessage:对象身份,不进 wire。
 */
const lossyMessages = new WeakSet<object>();
export function markLossy<T extends object>(m: T): T {
  if (m) lossyMessages.add(m);
  return m;
}
export function isLossy(m: unknown): boolean {
  return !!m && typeof m === 'object' && lossyMessages.has(m);
}

/**
 * 未知模型的窗口兜底。2026-09-11 起 272k(原 128k):主流模型都到 200k+ 了,128k 让每个族表没收录的模型
 * 在 64k 就开始机械折叠。报大了的那一头由 contextWindowStore 兜:撞一次上游溢出就回学到真实上限,只调小。
 */
export const CONTEXT_WINDOW_TOKENS = (() => {
  const v = Number(process.env.TANGU_CONTEXT_WINDOW_TOKENS);
  return Number.isFinite(v) && v >= 4_000 ? Math.floor(v) : 272_000;
})();

/** 入站 user 消息:估算超窗口 50% → 拒绝(run 直接失败,消息不落库)。 */
export const INPUT_HARD_RATIO = 0.5;
/** 入站 user 消息:估算超窗口 25% → 放行但发警告事件。 */
export const INPUT_WARN_RATIO = 0.25;
/** 预留至少占窗口的比例:粗估误差 + 下一轮输出 + 摘要本身都要从这里出;1M 窗口按 16k 预留太薄。 */
const RESERVE_MIN_RATIO = 0.05;
/**
 * LLM 摘要压缩的触发线(token):窗口 − max(reserveTokens, 5% 窗口),且不低于窗口一半——
 * 小窗口(测试台架 4k / 台架故意设的 8k)下预留不能吃掉整个窗口,否则每轮都压。
 * 272k 窗 → 255.6k;200k → 183.6k;1M → 950k;4k → 2k。
 */
export function compactionThreshold(windowTokens: number, reserveTokens: number): number {
  const w = Math.max(0, Math.floor(windowTokens));
  const reserve = Math.min(Math.max(Math.floor(reserveTokens) || 0, Math.ceil(w * RESERVE_MIN_RATIO)), Math.floor(w / 2));
  return w - reserve;
}

/**
 * 已知模型族的窗口兜底(input 预算口径,保守值):模型对象没带 context_window 时按 id 匹配。
 * 128k 全局默认对 400k 族(gpt-5 等)意味着 64k 就触发机械折叠——绞碎上下文+打断前缀缓存
 * (WB-Bench 取证:44 次中途缓存整体断裂,约占 uncached 输入 28%)。
 * 匹配同时试模型对象上的 apiModelId(上游模型名):托管目录导入的模型 id 是 pr-<hash>,只按 id 匹配永远落空。
 * ponytail: 手写小表只收录确定安全的族;不认识 → 维持全局默认。
 */
const FAMILY_WINDOWS: Array<[RegExp, number]> = [
  [/codex-mini/i, 200_000], // 先于 gpt-5|codex:codex-mini 是 o4-mini 底,272k 会溢出
  [/(^|\/)gpt-6-astra$/i, 272_000], // Codex 2026-09-06 目录的默认输入预算;长上下文仍由显式覆盖启用
  [/gpt-5|codex/i, 272_000], // GPT-5 家族 400k 总窗,input 上限 272k(codex 模型目录同值)
  [/gpt-4\.1/i, 1_000_000],
  // Claude 5 家族(Sonnet/Opus/Fable)与 Opus 4.7 起是 1M(官方模型表);必须排在下面那条
  // claude 泛规则**之前**(数组首命中)。4.6 及更早、Haiku 4.5 仍是 200k,继续走泛规则。
  [/(sonnet|opus|fable|mythos)-([5-9]|\d\d)|opus-4[-.]([7-9]|\d\d)/i, 1_000_000],
  [/claude|sonnet|opus|haiku/i, 200_000],
  [/gemini-[23]/i, 1_000_000], // 只认主线 2.x/3 聊天族;其余 gemini 变体窗口不一,留 128k 保守值
  [/deepseek-v4/i, 1_000_000], // V4 flash/pro 都是 1M;老 chat/reasoner 线窗口小得多,不收
  [/kimi-k3/i, 1_000_000], // K3 官方 1M(K2 线 256k 以下,不收)
  [/glm-5\.3/i, 1_000_000], // 官方 GLM-5.3 页写 1M(5.3-flash 同族);GLM-5 是 200k,故不扩到整族
  // 百炼「推荐模型」表里 qwen3.8-max = 1M。3.8 的小尺寸变体窗口未核实,故刻意只收 -max:
  // 窗口报大了会跳过折叠、直接撞 provider 溢出,比 128k 默认的早折叠更糟。
  [/qwen3\.8-max/i, 1_000_000],
];

/**
 * per-model 上下文窗口覆盖表(env `TANGU_MODEL_CONTEXT_WINDOWS` = {modelId: tokens} JSON;解析一次)。
 * 模型库暂无 window 字段——这是把「每个模型窗口」喂给客户端进度条的最小接缝。
 */
const MODEL_WINDOW_OVERRIDES: Record<string, number> = (() => {
  try {
    const raw = process.env.TANGU_MODEL_CONTEXT_WINDOWS;
    if (!raw) return {};
    const o = JSON.parse(raw);
    const out: Record<string, number> = {};
    for (const k of Object.keys(o || {})) {
      const v = Number(o[k]);
      if (Number.isFinite(v) && v >= 4_000) out[k] = Math.floor(v);
    }
    return out;
  } catch {
    return {};
  }
})();

/**
 * 解析某模型的上下文窗口。优先级 = **人说的 > 上游说的 > 我们猜的**:
 *   override  env `TANGU_MODEL_CONTEXT_WINDOWS` 覆盖表(运维逃生口,最高)> 用户本机 config.json modelOverrides
 *   model     模型元数据自带(托管面 admin 在模型上填的窗口 / provider 返回的字段)
 *   learned   从上游「超长被拒」的报错里回学到的真实上限(自动识别,见 contextWindowStore)
 *   family    手写模型族表(猜的;id 与 apiModelId 都试)
 *   default   272k 兜底(猜的)
 *
 * learned 排在 family 之前、model 之后:它是上游亲口说的实测值,比手写族表准;但人明确填过的
 * 值不被它推翻(冲突只体现在 source 标注上,不静默改配置)。
 */
export type CtxWindowSource = 'override' | 'model' | 'learned' | 'family' | 'default';

/** modelContextWindow 的带来源版本:值与来源一起给,供 context 视图如实标注。 */
export function modelContextWindowInfo(modelId?: string | null, modelObj?: any): { tokens: number; source: CtxWindowSource } {
  if (modelId && MODEL_WINDOW_OVERRIDES[modelId]) return { tokens: MODEL_WINDOW_OVERRIDES[modelId], source: 'override' };
  const user = modelId ? modelOverrides()[modelId]?.contextWindow : undefined;
  if (user) return { tokens: user, source: 'override' };
  const fromObj = Number(modelObj?.context_window ?? modelObj?.contextWindow);
  if (Number.isFinite(fromObj) && fromObj >= 4_000) return { tokens: Math.floor(fromObj), source: 'model' };
  const learned = modelId ? learnedWindow(modelId) : undefined;
  if (learned) return { tokens: learned, source: 'learned' };
  const apiModelId = modelObj?.apiModelId ?? modelObj?.api_model_id;
  for (const candidate of [modelId, apiModelId]) {
    if (!candidate || typeof candidate !== 'string') continue;
    for (const [re, win] of FAMILY_WINDOWS) if (re.test(candidate)) return { tokens: win, source: 'family' };
  }
  return { tokens: CONTEXT_WINDOW_TOKENS, source: 'default' };
}

export function modelContextWindow(modelId?: string | null, modelObj?: any): number {
  return modelContextWindowInfo(modelId, modelObj).tokens;
}

const PROTECT_FIRST = 3; // system 之后的前 N 条不折叠(任务定义锚点)
const PROTECT_LAST = 20; // 最近 N 条不折叠(模型工作记忆)
const TOOL_FOLD_THRESHOLD = 600; // 中段 tool 消息超此长度折叠
const TOOL_FOLD_HEAD = 300;
const TOOL_FOLD_TAIL = 150; // 尾部必须保留:命令输出的错误/测试汇总/最终状态几乎都在结尾(Codex 评审)
const MSG_TRUNC_THRESHOLD = 8_000; // 中段 user/assistant 消息超此长度截断
const MSG_TRUNC_HEAD = 2_000;
const MSG_TRUNC_TAIL = 500;

/**
 * 单条工具结果入列硬帽:48k 字符 ≈ 12k token,对齐 Codex 的模型可见输出上限(报告 E4)。
 * 原值 100k 只兜「炸穿上下文」,一条结果仍能独吞窗口的 1/6;12k token 是上游实测的收益拐点。
 * 中段截断:头 34k + 尾 12k(尾必须厚 —— 报错/测试汇总/最终状态几乎都在结尾),全文落盘给路径,
 * 截掉的部分模型可以 read_file/grep 回去取,截断不再是信息湮灭。
 */
const TOOL_RESULT_MAX_CHARS = 48_000;
const TOOL_RESULT_HEAD = 34_000;
const TOOL_RESULT_TAIL = 12_000;
/** 历史单条消息硬帽:与工具结果帽解耦,维持 100k(与 host read_file 上限对齐)。 */
export const HISTORY_MSG_MAX_CHARS = 100_000;

/** CJK 感知粗估:ASCII ≈4 字符/token,其余(CJK/二进制替换符)≈1 token/字符。 */
export function estimateTokensRough(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
  }
  return Math.ceil(ascii / 4) + (text.length - ascii);
}

// 图片是独立模态,base64 只是传输编码,绝不能按字符当正文计费。
// 未获得 provider usage 时用有界启发值(不是各模型精确价格);实际用量由 ContextUsageTracker 校准。
const IMAGE_TOKEN_ESTIMATE = 4096;

function isImagePart(value: any): boolean {
  return value && ['image_url', 'input_image', 'image'].includes(value.type);
}

/** 同时覆盖 user parts 与 Responses 工具图片;只替换估算副本,不改发送/落盘内容。 */
function estimateStructuredTokens(value: unknown): number {
  let images = 0;
  const json = JSON.stringify(value, (_key, part) => {
    if (isImagePart(part)) {
      images++;
      return { type: 'image' };
    }
    return part;
  });
  return estimateTokensRough(json || '') + images * IMAGE_TOKEN_ESTIMATE;
}

/** 单条消息的粗估(文本 + 独立图片预算 + tool_calls;不重复计算 Responses 重放正文)。 */
export function estimateMessageTokens(m: any): number {
  let n = 8; // 角色/分隔开销
  const c = m?.content;
  if (typeof c === 'string') {
    n += estimateTokensRough(c);
  } else if (Array.isArray(c)) {
    for (const p of c) {
      if (p?.type === 'text' || p?.type === 'input_text') n += estimateTokensRough(String(p.text ?? ''));
      else if (isImagePart(p)) n += IMAGE_TOKEN_ESTIMATE;
      else n += estimateStructuredTokens(p);
    }
  }
  if (Array.isArray(m?.tool_calls)) {
    for (const t of m.tool_calls) n += estimateTokensRough(String(t?.function?.arguments ?? ''));
  }
  // D1:deepseek/zai/qwen(思考)格式会把 reasoning_content 回灌上线;其余格式在 wire 层剥掉。
  // ponytail: 估算器不知道格式,一律计入(codex/* 只是几百字节的摘要,过估可忽略);要精确就按 cap.format 门控。
  if (typeof m?.reasoning_content === 'string' && m.reasoning_content) n += estimateTokensRough(m.reasoning_content);
  // Responses 使用 providerItems 替代正文/tool_calls,不是把两份都发送;取较大者保守兜底。
  if (Array.isArray(m?.providerItems) && m.providerItems.length) {
    try { n = Math.max(n, 8 + estimateStructuredTokens(m.providerItems)); } catch { /* ignore */ }
  }
  return n;
}

export function estimateMessagesTokens(msgs: ChatMessage[]): number {
  let n = 0;
  for (const m of msgs) n += estimateMessageTokens(m);
  return n;
}

/** provider 实测输入 + 该输入之后新增的消息。压缩/前缀改写后旧基准不可复用。 */
export class ContextUsageTracker {
  private baseline?: { tokens: number; prefix: Array<{ message: ChatMessage; estimate: number }> };

  observe(messages: ChatMessage[], promptTokens: number): void {
    this.baseline = Number.isFinite(promptTokens) && promptTokens > 0
      ? { tokens: promptTokens, prefix: messages.map((message) => ({ message, estimate: estimateMessageTokens(message) })) }
      : undefined;
  }

  invalidate(): void { this.baseline = undefined; }

  /** 实测口径的用量(基准前缀仍完整时 = 上次 prompt_tokens + 之后新增的粗估);没有可用基准 → undefined。
   *  与 estimate 的区别:这里绝不拿纯粗估冒充实测 —— 压缩时按「实测/粗估」换算保留预算,粗估冒充会把
   *  固定的工具头当成消息膨胀比例(Codex 09-15 评审 #9)。 */
  measured(messages: ChatMessage[]): number | undefined {
    const base = this.baseline;
    if (!base || messages.length < base.prefix.length || base.prefix.some((p, i) =>
      p.message !== messages[i] || p.estimate !== estimateMessageTokens(messages[i]))) return undefined;
    return base.tokens + estimateMessagesTokens(messages.slice(base.prefix.length));
  }

  /** roughExtra:没有可用实测基准、只能粗估时额外计入的开销(工具定义头 —— 它在 prompt_tokens 里、不在消息里;
   *  run 首轮的触发判断若漏掉它,会比实测少算几千 token,压缩晚一轮才来)。有基准时它已含在实测里,不重复加。 */
  estimate(messages: ChatMessage[], roughExtra = 0): number {
    const base = this.baseline;
    if (!base || messages.length < base.prefix.length || base.prefix.some((p, i) =>
      p.message !== messages[i] || p.estimate !== estimateMessageTokens(messages[i]))) {
      return estimateMessagesTokens(messages) + Math.max(0, roughExtra);
    }
    return base.tokens + estimateMessagesTokens(messages.slice(base.prefix.length));
  }
}

/** 压缩后仍处于高水位时,没有实质新增内容就不再重复摘要(包括失败/no-op)。 */
export class CompactionAttemptGuard {
  private retryAt = 0;
  private context?: { prefix: ChatMessage[]; tokens: number; minimumGrowth: number };
  shouldAttempt(tokens: number, messages?: ChatMessage[]): boolean {
    const previous = this.context;
    if (previous && messages && previous.prefix.every((m, i) => messages[i] === m) &&
      estimateMessagesTokens(messages) - previous.tokens < previous.minimumGrowth) return false;
    return tokens >= this.retryAt;
  }
  /** thresholdTokens 缺省按预留缺省值算;压缩后仍在触发线之上时,要再涨 minimumGrowth 才允许再试。 */
  record(afterTokens: number, windowTokens: number, messages?: ChatMessage[], thresholdTokens = compactionThreshold(windowTokens, 16_384)): void {
    const minimumGrowth = Math.max(1024, Math.ceil(windowTokens * 0.02));
    this.context = messages ? { prefix: messages.slice(), tokens: estimateMessagesTokens(messages), minimumGrowth } : undefined;
    this.retryAt = afterTokens > thresholdTokens ? afterTokens + minimumGrowth : 0;
  }
}

export interface CompactResult {
  changed: boolean;
  savedChars: number;
  /** 折叠前最大的三条消息(role+字符数),用于事后取证——别再出现"77 万 token 不知从哪来"。 */
  breakdown: Array<{ index: number; role: string; chars: number }>;
}

/**
 * 一次性批量折叠中段消息(幂等:折叠产物都低于各自阈值,重复调用是 no-op):
 *   - 保护 system(index 0)、system 后前 PROTECT_FIRST 条、最后 PROTECT_LAST 条;
 *   - 中段 tool 消息 > TOOL_FOLD_THRESHOLD → 头 300 + 折叠标记;
 *   - 中段 user/assistant > MSG_TRUNC_THRESHOLD → 头 2000 + 尾 500 + 标记。
 * 只在越过预算阈值时由调用方触发;每条消息一生最多变一次字节。
 */
export function compactContext(msgs: ChatMessage[]): CompactResult {
  const sizes = msgs.map((m: any, i) => ({
    index: i,
    role: String(m?.role ?? ''),
    chars: typeof m?.content === 'string' ? m.content.length : 0,
  }));
  const breakdown = [...sizes].sort((a, b) => b.chars - a.chars).slice(0, 3);

  const startProtectEnd = (msgs[0] as any)?.role === 'system' ? 1 + PROTECT_FIRST : PROTECT_FIRST;
  const lastProtectStart = Math.max(0, msgs.length - PROTECT_LAST);

  let savedChars = 0;
  for (let i = startProtectEnd; i < lastProtectStart; i++) {
    const m = msgs[i] as any;
    if (m && pinnedMessages.has(m)) continue; // 锚定消息永不折叠(注入上下文/任务定义)
    if (typeof m?.content !== 'string') continue;
    const len = m.content.length;
    if (m.role === 'tool' && len > TOOL_FOLD_THRESHOLD) {
      m.content =
        m.content.slice(0, TOOL_FOLD_HEAD) +
        `\n…[context compacted: tool output folded, was ${len} chars]…\n` +
        m.content.slice(-TOOL_FOLD_TAIL);
      savedChars += len - m.content.length;
      markLossy(m); // 折叠过的消息不许被后续摘要「当作原文」推进持久检查点
    } else if ((m.role === 'user' || m.role === 'assistant') && len > MSG_TRUNC_THRESHOLD) {
      m.content =
        m.content.slice(0, MSG_TRUNC_HEAD) +
        `\n…[context compacted: omitted ${len - MSG_TRUNC_HEAD - MSG_TRUNC_TAIL} chars]…\n` +
        m.content.slice(-MSG_TRUNC_TAIL);
      savedChars += len - m.content.length;
      markLossy(m);
      // 折叠改写了正文 → 挂着的 Responses 原始 items(含旧全文)不再对应,退回文本重建,防止把
      // 被折叠掉的内容原样回灌(providerItems 仅 in-memory,删除只影响本 run 的续轮)。
      delete (m as any).providerItems;
    }
  }
  return { changed: savedChars > 0, savedChars, breakdown };
}

/**
 * 超帽工具结果全文落盘,返回路径(落不下去返回 '' —— 只退化为纯截断,绝不因此报错)。
 * 文件名取内容 sha256:**确定性**是硬要求 —— capToolResult 也跑在 historyReplay 的重建路径上,
 * 随机名会让同一条历史每次 hydrate 出不同字节,provider 前缀缓存逐轮清零(2026-06-10 审计同款坑)。
 * 内容相同即同一个文件,天然去重、重复调用幂等。
 * 落点是**引擎家目录**(`<TANGU_HOME>/tool-spill`)而不是 os.tmpdir():tmpdir 会被系统/重启回收,
 * 而这条路径要在**历史回放**里仍然可达(同一条工具结果几天后 hydrate 出来,标记里的路径还得有文件)。
 * ponytail: 不做清理/配额 —— 上限就是「超 48k 的工具结果各存一份」,按内容去重;要收割再单开一个 GC。
 */
function spillToolResult(text: string): string {
  try {
    const dir = path.join(tanguHome(), 'tool-spill');
    const file = path.join(dir, `tool-${createHash('sha256').update(text).digest('hex').slice(0, 16)}.txt`);
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, text, 'utf-8');
    }
    return file;
  } catch {
    return '';
  }
}

/** 工具结果入列硬帽:超 48k 字符中段截断(头+尾),全文落盘并把路径写进标记。
 *  正常工具自身已有更小的帽,这里既兜未封顶路径,也给所有路径一条「回去取全文」的出口。 */
export function capToolResult(text: string): string {
  if (typeof text !== 'string' || text.length <= TOOL_RESULT_MAX_CHARS) return text;
  const omitted = text.length - TOOL_RESULT_HEAD - TOOL_RESULT_TAIL;
  const file = spillToolResult(text);
  // 路径是**宿主机**上的:sandbox execMode 下模型的 read_file/grep 看不到它 —— 与其让模型白试一轮,
  // 不如在标记里说清楚(诚实的仪器 > 好看的承诺)。
  const where = file
    ? ` full output saved on the host at ${file} (host filesystem only; not reachable from a sandboxed execution mode)`
      + ` — read_file or grep that file for the omitted part;`
    : '';
  return (
    text.slice(0, TOOL_RESULT_HEAD) +
    `\n…[tool output too large: omitted ${omitted} chars of ${text.length} total;${where} showing head+tail]…\n` +
    text.slice(-TOOL_RESULT_TAIL)
  );
}

/** 历史单条消息硬帽(hydrate 时用,防被巨型消息毒化的会话永久不可用;确定性 → 跨 run 前缀稳定)。 */
export function capHistoryContent(text: string): string {
  if (typeof text !== 'string' || text.length <= HISTORY_MSG_MAX_CHARS) return text;
  const omitted = text.length - MSG_TRUNC_HEAD - MSG_TRUNC_TAIL;
  return (
    text.slice(0, MSG_TRUNC_HEAD) +
    `\n…[history message too large, omitted ${omitted} chars]…\n` +
    text.slice(-MSG_TRUNC_TAIL)
  );
}

/** 本轮 response → assistant 历史消息。凡是**还会发起下一次请求**的分支(主循环的工具轮/审计/verify/
 *  steer/Stop-hook 续跑/文本工具调用纠正,以及 delegate 子代理的工具轮)都必须经此构造:
 *  providerItems(Responses 原始 items,含 encrypted reasoning)一并挂上,否则续跑轮把 reasoning
 *  延续性弄丢(Codex 评审二轮 #2);reasoning_content 缺失还会让 DeepSeek/ZAI/带思考的 Qwen
 *  在工具轮之后直接 400(Codex 评审三轮 #2 —— 子代理那条调用点原先是手搓的)。
 *  真·收尾(不再续轮)不需要。仅 in-memory,finalize 落库走显式字段,不入 DB。
 *  住在 contextBudget 而不是 agentLoop:subAgent 也要用,而 agentLoop → registry → delegate →
 *  subAgent 已是一条链,反向 import 会成环。 */
export function assistantTurnOf(
  res: { outputItems?: any[]; reasoning?: string },
  content: string,
  toolCalls?: ToolCall[],
): ChatMessage {
  return {
    role: 'assistant',
    content,
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
    ...(Array.isArray(res.outputItems) && res.outputItems.length ? { providerItems: res.outputItems } : {}),
    // D1:chat-completions 的同轮内思考回灌载体。这里**无条件挂上**,上 wire 与否由各客户端把关:
    // 直连 chat-completions 走 compatWireMessages 的能力表门控(默认剥,只对 deepseek/zai/带思考的
    // qwen 放行),Responses/Anthropic 白名单重建 body 天然不带,托管面由 server llmService 默认剥。
    // 不落库、不进跨 run 水合(本函数产物只进 workingMessages)。
    ...(res.reasoning ? { reasoning_content: res.reasoning } : {}),
  } as ChatMessage;
}
