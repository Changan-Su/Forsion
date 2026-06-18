/**
 * 上下文预算与压缩(参考 Hermes Agent 的工程做法):
 *
 *  - estimateTokensRough:CJK 感知的粗估(ASCII ~4 字符/token,非 ASCII ~1 token/字符)。
 *    比 length/4 对中文/二进制垃圾准一个量级——77 万 token 事故的 prompt 用 length/4 会低估 4 倍。
 *  - 入站闸门(对齐 Hermes context_references 的窗口相对预算):估算 > 窗口 50% 拒绝、> 25% 警告。
 *  - compactContext:阈值触发的**一次性批量折叠**(保头 3 + 尾 20,中段定型),幂等——
 *    替代旧 trimStaleToolMessages 的每轮就地改写(那会让前缀缓存逐轮清零,见 2026-06-10 审计)。
 *    平时历史 append-only;只有越过 COMPACT_TRIGGER_RATIO 才折叠一次,缓存 miss 摊薄成偶发。
 *  - capToolResult:工具结果入列硬帽,兜底未封顶路径(host list_dir 大目录、custom provider 等)。
 *
 * 模型上下文窗口:模型库暂无 per-model 窗口字段,用 TANGU_CONTEXT_WINDOW_TOKENS(默认 128k)。
 */
import type { ChatMessage } from '../core/types.js';

export const CONTEXT_WINDOW_TOKENS = (() => {
  const v = Number(process.env.TANGU_CONTEXT_WINDOW_TOKENS);
  return Number.isFinite(v) && v >= 4_000 ? Math.floor(v) : 128_000;
})();

/** 入站 user 消息:估算超窗口 50% → 拒绝(run 直接失败,消息不落库)。 */
export const INPUT_HARD_RATIO = 0.5;
/** 入站 user 消息:估算超窗口 25% → 放行但发警告事件。 */
export const INPUT_WARN_RATIO = 0.25;
/** 真实 prompt 用量(或粗估)超窗口 50% → 触发一次 compactContext(机械折叠安全网)。 */
export const COMPACT_TRIGGER_RATIO = 0.5;
/** 实时上下文用量超窗口此比例(0.95) → 强制一次 compactSession(满载兜底,持久化总结)。 */
export const FORCE_COMPACT_RATIO = 0.95;

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

/** 解析某模型的上下文窗口:覆盖表 > 模型对象自带(context_window/contextWindow) > 全局默认。 */
export function modelContextWindow(modelId?: string | null, modelObj?: any): number {
  if (modelId && MODEL_WINDOW_OVERRIDES[modelId]) return MODEL_WINDOW_OVERRIDES[modelId];
  const fromObj = Number(modelObj?.context_window ?? modelObj?.contextWindow);
  if (Number.isFinite(fromObj) && fromObj >= 4_000) return Math.floor(fromObj);
  return CONTEXT_WINDOW_TOKENS;
}

const PROTECT_FIRST = 3; // system 之后的前 N 条不折叠(任务定义锚点)
const PROTECT_LAST = 20; // 最近 N 条不折叠(模型工作记忆)
const TOOL_FOLD_THRESHOLD = 600; // 中段 tool 消息超此长度折叠
const TOOL_FOLD_HEAD = 300;
const MSG_TRUNC_THRESHOLD = 8_000; // 中段 user/assistant 消息超此长度截断
const MSG_TRUNC_HEAD = 2_000;
const MSG_TRUNC_TAIL = 500;

/** 单条工具结果入列硬帽(与 host read_file 的 100k 上限对齐;头+尾保留 traceback)。 */
const TOOL_RESULT_MAX_CHARS = 100_000;
const TOOL_RESULT_HEAD = 4_000;
const TOOL_RESULT_TAIL = 1_500;

/** CJK 感知粗估:ASCII ≈4 字符/token,其余(CJK/二进制替换符)≈1 token/字符。 */
export function estimateTokensRough(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
  }
  return Math.ceil(ascii / 4) + (text.length - ascii);
}

/** 单条消息的粗估(含 parts 数组与 tool_calls 参数;image_url 按 URL 长度/8 折算,仅作预算用)。 */
export function estimateMessageTokens(m: any): number {
  let n = 8; // 角色/分隔开销
  const c = m?.content;
  if (typeof c === 'string') {
    n += estimateTokensRough(c);
  } else if (Array.isArray(c)) {
    for (const p of c) {
      if (p?.type === 'text') n += estimateTokensRough(String(p.text ?? ''));
      else if (p?.type === 'image_url') n += Math.ceil(String(p.image_url?.url ?? '').length / 8);
    }
  }
  if (Array.isArray(m?.tool_calls)) {
    for (const t of m.tool_calls) n += estimateTokensRough(String(t?.function?.arguments ?? ''));
  }
  return n;
}

export function estimateMessagesTokens(msgs: ChatMessage[]): number {
  let n = 0;
  for (const m of msgs) n += estimateMessageTokens(m);
  return n;
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
    if (typeof m?.content !== 'string') continue;
    const len = m.content.length;
    if (m.role === 'tool' && len > TOOL_FOLD_THRESHOLD) {
      m.content =
        m.content.slice(0, TOOL_FOLD_HEAD) +
        `\n…[上下文压缩:工具输出已折叠,原 ${len} 字符]`;
      savedChars += len - m.content.length;
    } else if ((m.role === 'user' || m.role === 'assistant') && len > MSG_TRUNC_THRESHOLD) {
      m.content =
        m.content.slice(0, MSG_TRUNC_HEAD) +
        `\n…[上下文压缩:省略 ${len - MSG_TRUNC_HEAD - MSG_TRUNC_TAIL} 字符]…\n` +
        m.content.slice(-MSG_TRUNC_TAIL);
      savedChars += len - m.content.length;
    }
  }
  return { changed: savedChars > 0, savedChars, breakdown };
}

/** 工具结果入列硬帽:超 100k 字符截头留尾。正常工具自身已有更小的帽,这里只兜未封顶路径。 */
export function capToolResult(text: string): string {
  if (typeof text !== 'string' || text.length <= TOOL_RESULT_MAX_CHARS) return text;
  const omitted = text.length - TOOL_RESULT_HEAD - TOOL_RESULT_TAIL;
  return (
    text.slice(0, TOOL_RESULT_HEAD) +
    `\n…[单条工具输出超限,省略 ${omitted} 字符]…\n` +
    text.slice(-TOOL_RESULT_TAIL)
  );
}

/** 历史单条消息硬帽(hydrate 时用,防被巨型消息毒化的会话永久不可用;确定性 → 跨 run 前缀稳定)。 */
export function capHistoryContent(text: string): string {
  if (typeof text !== 'string' || text.length <= TOOL_RESULT_MAX_CHARS) return text;
  const omitted = text.length - MSG_TRUNC_HEAD - MSG_TRUNC_TAIL;
  return (
    text.slice(0, MSG_TRUNC_HEAD) +
    `\n…[历史消息超限,省略 ${omitted} 字符]…\n` +
    text.slice(-MSG_TRUNC_TAIL)
  );
}
