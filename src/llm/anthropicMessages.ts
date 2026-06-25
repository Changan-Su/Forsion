/**
 * Anthropic 原生 Messages API 客户端 —— 订阅登录(Claude Code 额度)的推理通道。
 *
 * 与 openaiCompat 并列的第二条直连面:OAuth 订阅登录拿到的不是 API key,而是 Claude Code 的
 * Bearer access_token,且端点是 /v1/messages(非 OpenAI 兼容 /chat/completions)。multiBrain
 * 据 payload 上的 PROTOCOL_MARK='anthropic-messages' 把流分发到这里。
 *
 * 两件事:
 *   1. openaiToAnthropicBody —— 把 buildOpenAiCompatPayload 产出的 OpenAI 形态 payload(system 进
 *      messages[0]、assistant.tool_calls、role:'tool'、OpenAI tools)翻译成严格 Messages 请求体:
 *      system 提升到顶层 + 强制首块为 Claude Code 身份串、tool_calls→tool_use、role:'tool'→tool_result
 *      (相邻合并)、OpenAI tools→{name,description,input_schema}。
 *   2. streamAnthropicOAuth —— Bearer + anthropic-beta:oauth-2025-04-20 头直连 /v1/messages,SSE 解析
 *      搬自 server/src/services/anthropicStream.ts,归一回 OpenAI 形态 StreamResult(loop 零改动)。
 *
 * ⚠️ 订阅路径强制:首个 system 块必须正好是 CLAUDE_CODE_SYSTEM,否则 Anthropic 拒。该串及 beta 头是
 *    私有契约,可能随官方变动——失效先核对这两处。
 */
import type { StreamOpts, StreamResult } from '../seams/cloudBrain.js';
import { LlmError } from '../core/types.js';
import { withStreamIdle, type StreamIdleGuard } from './streamIdle.js';

const ANTHROPIC_VERSION = '2023-06-01';
const OAUTH_BETA = 'oauth-2025-04-20';
const DEFAULT_MAX_TOKENS = 8192;
/** 订阅路径强制的首个 system 块——少了它官方直接拒。 */
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

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
      return p; // 已是 Anthropic 块原样透传
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
 * 关键:role:'system' 提升顶层(强制首块 = Claude Code 身份);assistant.tool_calls→tool_use;
 * 相邻 role:'tool' 合并成一条 user(tool_result 块);OpenAI tools→input_schema。
 */
export function openaiToAnthropicBody(payload: any): any {
  const sysTexts: string[] = [];
  const messages: any[] = [];
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

  // 强制首块身份串 + 真正的系统提示跟其后
  const system: any[] = [{ type: 'text', text: CLAUDE_CODE_SYSTEM }];
  const joined = sysTexts.join('\n\n');
  if (joined) system.push({ type: 'text', text: joined });

  const body: any = {
    model: payload.model,
    max_tokens: typeof payload.max_tokens === 'number' && payload.max_tokens > 0 ? payload.max_tokens : DEFAULT_MAX_TOKENS,
    stream: true,
    system,
    messages,
  };
  const tools = convertTools(payload.tools);
  if (tools) body.tools = tools;
  const tc = payload.tool_choice;
  if (tc === 'none') body.tool_choice = { type: 'none' };
  else if (tc === 'auto') body.tool_choice = tools ? { type: 'auto' } : undefined;
  else if (tc && typeof tc === 'object' && tc.type === 'function') body.tool_choice = { type: 'tool', name: tc.function?.name };
  if (typeof payload.temperature === 'number') body.temperature = payload.temperature;
  return body;
}

/** 原生 Messages 流式调用(OAuth Bearer);签名/回调与 streamOpenAiCompat 一致,归一回 OpenAI 形态。 */
export async function streamAnthropicOAuth(opts: StreamOpts): Promise<StreamResult> {
  return withStreamIdle(opts.signal, (guard) => runAnthropicOAuthStream(opts, guard));
}

async function runAnthropicOAuthStream(opts: StreamOpts, guard: StreamIdleGuard): Promise<StreamResult> {
  const { apiKey, baseUrl, payload, onToken, onReasoning, onToolCallDelta } = opts;
  const body = openaiToAnthropicBody(payload);

  const response = await fetch(anthropicMessagesUrl(baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`, // 订阅 OAuth:Bearer,非 x-api-key
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': OAUTH_BETA,
    },
    body: JSON.stringify(body),
    signal: guard.signal,
  });

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
  const usage = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 };
  let inputTokens = 0;
  const blocks = new Map<number, { id: string; name: string; arguments: string } | null>();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  guard.arm();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    guard.arm();
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
          usage.cached_tokens = u.cache_read_input_tokens || 0;
          usage.cache_write_tokens = u.cache_creation_input_tokens || 0;
          break;
        }
        case 'content_block_start': {
          const cb = ev.content_block;
          if (cb?.type === 'tool_use') blocks.set(ev.index, { id: cb.id || `toolu_${ev.index}`, name: cb.name || '', arguments: '' });
          else blocks.set(ev.index, null);
          break;
        }
        case 'content_block_delta': {
          const d = ev.delta;
          if (!d) break;
          if (d.type === 'text_delta' && typeof d.text === 'string') {
            content += d.text;
            onToken?.(d.text);
          } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
            reasoning += d.thinking;
            onReasoning?.(d.thinking);
          } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
            const t = blocks.get(ev.index);
            if (t) {
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
  usage.prompt_tokens = inputTokens + usage.cached_tokens + usage.cache_write_tokens;
  if (usage.completion_tokens === 0 && content) usage.completion_tokens = Math.ceil(content.length / 4);

  const toolCalls = Array.from(blocks.entries())
    .filter(([, t]) => t !== null)
    .sort((a, b) => a[0] - b[0])
    .map(([idx, t]) => ({
      id: t!.id || `toolu_${idx}`,
      type: 'function' as const,
      function: { name: t!.name, arguments: t!.arguments || '{}' },
    }));

  return { content, reasoning, toolCalls, usage, finishReason };
}
