/**
 * Anthropic 原生 Messages API 客户端 —— 用户自有 API key(`sk-ant-api…`)的直连推理通道。
 *
 * 与 openaiCompat 并列的第二条直连面:端点是 /v1/messages(非 OpenAI 兼容 /chat/completions)。
 * multiBrain 据 payload 上的 PROTOCOL_MARK='anthropic-messages' 把流分发到这里。
 *
 * 两件事:
 *   1. openaiToAnthropicBody —— 把 buildOpenAiCompatPayload 产出的 OpenAI 形态 payload(system 进
 *      messages[0]、assistant.tool_calls、role:'tool'、OpenAI tools)翻译成严格 Messages 请求体:
 *      system 提升到顶层、tool_calls→tool_use、role:'tool'→tool_result(相邻合并)、
 *      OpenAI tools→{name,description,input_schema}。
 *   2. streamAnthropicMessages —— x-api-key 直连 /v1/messages,SSE 解析搬自
 *      server/src/services/anthropicStream.ts,归一回 OpenAI 形态 StreamResult(loop 零改动)。
 *
 * ⛔ 这里**没有**订阅 OAuth 分支,是有意的(2026-07-31 随 OAUTH_PROVIDERS.claude 一并删,勿再加回)。
 *    那条要求首个 system 块必须正好是「You are Claude Code, Anthropic's official CLI for Claude.」
 *    才不被官方拒 —— 即拿 Claude Code 的身份去消费订阅额度。要用订阅走 `src/engines/`(ACP,直接
 *    跑真的 Claude Code,鉴权是它自己的)。
 */
import type { StreamOpts, StreamResult } from '../seams/cloudBrain.js';
import { LlmError } from '../core/types.js';
import { PROTOCOL_MARK } from './openaiCompat.js';
import { withStreamIdle, type StreamIdleGuard } from './streamIdle.js';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 8192;
/** Anthropic 硬上限:一次请求最多 4 个 cache_control 断点(多发即 400)。 */
const MAX_CACHE_BREAKPOINTS = 4;

/** thinking / redacted_thinking 块不做缓存断点载体(可缓存块是 text/image/tool_use/tool_result 一族)。 */
function lastCacheableBlock(content: unknown): any {
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i--) {
    const b: any = content[i];
    if (b && typeof b === 'object' && b.type !== 'thinking' && b.type !== 'redacted_thinking') return b;
  }
  return null;
}

/**
 * 打 ≤4 个 cache_control 断点:tools 尾 → system 尾 → 最后几条消息(新→旧)。
 *
 * 断点是 Anthropic 唯一的缓存入口(不打就每轮全价重读 20k 固定头)。写 1.25× / 读 0.1×,
 * agent 循环里同一前缀至少被读一次就回本。**按协议门控**(不是按思考格式):能收这个字段的是
 * 原生 /v1/messages,与模型思不思考无关。
 * ponytail: 优先级与上限写死 —— 4 是协议定死的,顺序只有这一种正确解,没有第二种取法可配。
 */
function applyCacheBreakpoints(body: any): void {
  const targets: any[] = [];
  const tools: any[] = Array.isArray(body.tools) ? body.tools : [];
  if (tools.length) targets.push(tools[tools.length - 1]);
  const system: any[] = Array.isArray(body.system) ? body.system : [];
  if (system.length) targets.push(system[system.length - 1]);
  const msgs: any[] = Array.isArray(body.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0 && targets.length < MAX_CACHE_BREAKPOINTS && msgs.length - i <= 3; i--) {
    const block = lastCacheableBlock(msgs[i]?.content);
    if (block) targets.push(block);
  }
  for (const t of targets.slice(0, MAX_CACHE_BREAKPOINTS)) t.cache_control = { type: 'ephemeral' };
}

/** {baseUrl}(可能带或不带 /v1)→ /v1/messages 完整端点。 */
export function anthropicMessagesUrl(baseUrl: string): string {
  const base = (baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
}

function safeJsonObject(s: unknown): Record<string, unknown> {
  if (s && typeof s === 'object') return s as Record<string, unknown>;
  if (typeof s !== 'string' || !s.trim()) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** 任意 message.content(字符串 / OpenAI parts 数组)→ 纯文本(tool_result / system 用)。 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (p?.type === 'text' ? String(p.text ?? '') : typeof p === 'string' ? p : ''))
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : String(content);
}

/** OpenAI 形态 image_url data-URL → Anthropic image 块;text → text 块(保留 cache_control)。搬自服务端。 */
function convertContentParts(parts: any[]): any[] {
  return parts
    .map((p) => {
      if (!p || typeof p !== 'object') return p ? { type: 'text', text: String(p) } : null;
      if (p.type === 'text') {
        const out: any = { type: 'text', text: String(p.text ?? '') };
        if (p.cache_control) out.cache_control = p.cache_control;
        return out;
      }
      if (p.type === 'image_url') {
        const url = String(p.image_url?.url ?? '');
        const m = url.match(/^data:([^;]+);base64,(.*)$/s);
        if (m) {
          const out: any = { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
          if (p.cache_control) out.cache_control = p.cache_control;
          return out;
        }
        if (/^https?:\/\//.test(url)) return { type: 'image', source: { type: 'url', url } };
        return null; // 不可识别的图片引用:丢弃该 part
      }
      // 已是 Anthropic 块:**拷一层**再透传 —— 断点会往块上写 cache_control,原样透传就写进了调用方
      // 的共享历史,下一轮那些旧断点还在,累积超过 4 个即 400(与 B5 的 system 深拷贝同一类事故)。
      return { ...p };
    })
    .filter(Boolean);
}

/** OpenAI tools[{type:'function',function:{name,description,parameters}}] → Anthropic [{name,description,input_schema}]。 */
function convertTools(tools: any[]): any[] | undefined {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const out = tools
    .map((t) => {
      const fn = t?.function ?? t;
      const name = fn?.name;
      if (!name) return null;
      return {
        name,
        description: fn?.description ?? '',
        input_schema: fn?.parameters ?? fn?.input_schema ?? { type: 'object', properties: {} },
      };
    })
    .filter(Boolean) as any[];
  return out.length ? out : undefined;
}

/**
 * OpenAI 形态 payload → 严格 Anthropic Messages 请求体。
 * 关键:role:'system' 提升顶层;assistant.tool_calls→tool_use;
 * 相邻 role:'tool' 合并成一条 user(tool_result 块);OpenAI tools→input_schema。
 */
export function openaiToAnthropicBody(payload: any): any {
  const sysTexts: string[] = [];
  const messages: any[] = [];
  const think = payload.thinking;
  const thinkOn = think?.type === 'enabled' || think?.type === 'adaptive';
  let pendingToolResults: any[] = [];
  const flush = (): void => {
    if (pendingToolResults.length) {
      messages.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const m of Array.isArray(payload.messages) ? payload.messages : []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system') {
      const t = contentToText(m.content);
      if (t) sysTexts.push(t);
      continue;
    }
    if (m.role === 'tool') {
      pendingToolResults.push({ type: 'tool_result', tool_use_id: m.tool_call_id, content: contentToText(m.content) });
      continue;
    }
    flush(); // 非 tool 消息前,先收尾累积的 tool_result 成一条 user
    if (m.role === 'assistant') {
      const blocks: any[] = [];
      // 思考延续性:本 run 内该轮的 thinking 块(带 signature)原样排在最前回灌 —— Anthropic 契约
      // 要求工具轮带回当轮思考块,少了要么被拒、要么模型从零重推理。只在本次请求确实开着思考时回
      // (关思考还发思考块是未定义行为);跨 run 水合的历史没有 providerItems,自然降级。
      if (thinkOn) {
        for (const it of Array.isArray(m.providerItems) ? m.providerItems : []) {
          if (it?.type === 'thinking' && typeof it.signature === 'string' && it.signature) {
            blocks.push({ type: 'thinking', thinking: String(it.thinking ?? ''), signature: it.signature });
          } else if (it?.type === 'redacted_thinking' && it.data) {
            blocks.push({ type: 'redacted_thinking', data: it.data });
          }
        }
      }
      const text = typeof m.content === 'string' ? m.content : contentToText(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input: safeJsonObject(tc.function?.arguments) });
      }
      if (!blocks.length) blocks.push({ type: 'text', text: '' }); // Anthropic 不接受空 content
      messages.push({ role: 'assistant', content: blocks });
    } else {
      // user(可能带图片 parts)
      const parts = Array.isArray(m.content) ? convertContentParts(m.content) : [{ type: 'text', text: contentToText(m.content) }];
      messages.push({ role: 'user', content: parts.length ? parts : [{ type: 'text', text: '' }] });
    }
  }
  flush();

  const system: any[] = [];
  const joined = sysTexts.join('\n\n');
  if (joined) system.push({ type: 'text', text: joined });

  const body: any = {
    model: payload.model,
    max_tokens: typeof payload.max_tokens === 'number' && payload.max_tokens > 0 ? payload.max_tokens : DEFAULT_MAX_TOKENS,
    stream: true,
    messages,
  };
  if (system.length) body.system = system; // 无系统提示 → 整个字段不发,别塞空数组

  const tools = convertTools(payload.tools);
  if (tools) body.tools = tools;
  const tc = payload.tool_choice;
  if (tc === 'none') body.tool_choice = { type: 'none' };
  else if (tc === 'auto') body.tool_choice = tools ? { type: 'auto' } : undefined;
  else if (tc && typeof tc === 'object' && tc.type === 'function') body.tool_choice = { type: 'tool', name: tc.function?.name };
  // 扩展思考:tuneOpenAiDirectPayload 按能力表把档位写成 payload.thinking(+ 自适应档的 output_config),
  // 这里原样透传。Anthropic 强制 max_tokens > budget_tokens —— 能力表已夹紧,此处兜底再抬一次。
  if (thinkOn || think?.type === 'disabled') {
    body.thinking = think;
    if (think.type === 'enabled' && typeof think.budget_tokens === 'number' && body.max_tokens <= think.budget_tokens) {
      body.max_tokens = think.budget_tokens + 1024;
    }
    if (think.type === 'adaptive' && payload.output_config) body.output_config = payload.output_config;
  }
  // 思考开时 Anthropic 拒 temperature≠1,索性不发。
  if (!thinkOn && typeof payload.temperature === 'number') body.temperature = payload.temperature;
  if (payload[PROTOCOL_MARK] === 'anthropic-messages') applyCacheBreakpoints(body);
  return body;
}

/** 原生 Messages 流式调用;签名/回调与 streamOpenAiCompat 一致,归一回 OpenAI 形态。 */
export async function streamAnthropicMessages(opts: StreamOpts): Promise<StreamResult> {
  return withStreamIdle(opts.signal, (guard) => runAnthropicStream(opts, guard));
}

async function runAnthropicStream(opts: StreamOpts, guard: StreamIdleGuard): Promise<StreamResult> {
  const { apiKey, baseUrl, payload, onToken, onReasoning, onToolCallDelta } = opts;
  const body = openaiToAnthropicBody(payload);

  const response = await fetch(anthropicMessagesUrl(baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
    signal: guard.signal,
  });
  opts.onResponseStart?.();

  if (!response.ok || !response.body) {
    let detail = '';
    try {
      const j: any = await response.json();
      detail = j?.error?.message || JSON.stringify(j).slice(0, 300);
    } catch { /* keep empty */ }
    const status = response.status === 401 || response.status === 403 ? 502 : response.status || 502;
    throw new LlmError(status, detail || `Anthropic upstream error ${response.status}`);
  }

  let content = '';
  let reasoning = '';
  let finishReason: string | undefined;
  // cached_tokens 不预置 0:上游没报缓存量时保持 undefined(报 0 = 真没命中,与没报是两回事)。
  const usage: {
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens?: number;
    cache_write_tokens?: number;
  } = { prompt_tokens: 0, completion_tokens: 0 };
  let inputTokens = 0;
  const blocks = new Map<number, { id: string; name: string; arguments: string } | null>();
  // 思考块按 index 累积(thinking_delta + signature_delta):回给 loop 挂到 assistant 消息,工具轮原样回灌。
  const thinkingBlocks = new Map<number, { thinking: string; signature: string; redactedData?: string }>();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  guard.arm();
  while (true) {
    const { done, value } = await guard.read(reader);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      let ev: any;
      try {
        ev = JSON.parse(trimmed.slice(5));
      } catch {
        continue;
      }
      switch (ev.type) {
        case 'message_start': {
          const u = ev.message?.usage || {};
          inputTokens = u.input_tokens || 0;
          if (typeof u.cache_read_input_tokens === 'number') usage.cached_tokens = u.cache_read_input_tokens;
          if (typeof u.cache_creation_input_tokens === 'number') usage.cache_write_tokens = u.cache_creation_input_tokens;
          break;
        }
        case 'content_block_start': {
          const cb = ev.content_block;
          if (cb?.type === 'tool_use' && !blocks.has(ev.index)
            && ((typeof cb.id === 'string' && cb.id) || (typeof cb.name === 'string' && cb.name))) guard.progress();
          if (cb?.type === 'tool_use') blocks.set(ev.index, { id: cb.id || `toolu_${ev.index}`, name: cb.name || '', arguments: '' });
          else blocks.set(ev.index, null);
          if (cb?.type === 'thinking') {
            thinkingBlocks.set(ev.index, {
              thinking: typeof cb.thinking === 'string' ? cb.thinking : '',
              signature: typeof cb.signature === 'string' ? cb.signature : '',
            });
          } else if (cb?.type === 'redacted_thinking' && cb.data) {
            thinkingBlocks.set(ev.index, { thinking: '', signature: '', redactedData: String(cb.data) });
          }
          break;
        }
        case 'content_block_delta': {
          const d = ev.delta;
          if (!d) break;
          if (d.type === 'text_delta' && typeof d.text === 'string') {
            if (d.text) guard.progress();
            content += d.text;
            onToken?.(d.text);
          } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
            if (d.thinking) guard.progress();
            reasoning += d.thinking;
            const tb = thinkingBlocks.get(ev.index);
            if (tb) tb.thinking += d.thinking;
            onReasoning?.(d.thinking);
          } else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
            // 签名是回灌的准入票据:少了它这块思考回传必被拒,所以 signature 缺失的块整块不回。
            const tb = thinkingBlocks.get(ev.index);
            if (tb) tb.signature += d.signature;
          } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
            const t = blocks.get(ev.index);
            if (t) {
              if (d.partial_json) guard.progress();
              t.arguments += d.partial_json;
              onToolCallDelta?.({ id: t.id, name: t.name, argsLen: t.arguments.length, args: t.arguments, argsDelta: d.partial_json });
            }
          }
          break;
        }
        case 'message_delta': {
          if (ev.usage?.output_tokens) usage.completion_tokens = ev.usage.output_tokens;
          const sr = ev.delta?.stop_reason;
          if (sr) finishReason = sr === 'tool_use' ? 'tool_calls' : sr === 'end_turn' ? 'stop' : sr === 'max_tokens' ? 'length' : sr;
          break;
        }
        case 'error': {
          throw new LlmError(502, ev.error?.message || 'Anthropic stream error');
        }
        default:
          break; // ping / message_stop / content_block_stop
      }
    }
  }

  // 总输入 = 未缓存 + 缓存读 + 缓存写(Anthropic input_tokens 仅含未缓存部分)
  usage.prompt_tokens = inputTokens + (usage.cached_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
  if (usage.completion_tokens === 0 && content) usage.completion_tokens = Math.ceil(content.length / 4);

  const toolCalls = Array.from(blocks.entries())
    .filter(([, t]) => t !== null)
    .sort((a, b) => a[0] - b[0])
    .map(([idx, t]) => ({
      id: t!.id || `toolu_${idx}`,
      type: 'function' as const,
      function: { name: t!.name, arguments: t!.arguments || '{}' },
    }));

  // 思考块原料回给 loop(挂成 assistant.providerItems,下一轮由 openaiToAnthropicBody 原样回灌)。
  // 没拿到 signature 的块(流被截断)整块丢弃——半截签名回传必被拒。
  const outputItems = Array.from(thinkingBlocks.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) =>
      t.redactedData
        ? { type: 'redacted_thinking', data: t.redactedData }
        : t.signature
          ? { type: 'thinking', thinking: t.thinking, signature: t.signature }
          : null,
    )
    .filter(Boolean) as any[];

  return { content, reasoning, toolCalls, usage, finishReason, ...(outputItems.length ? { outputItems } : {}) };
}
