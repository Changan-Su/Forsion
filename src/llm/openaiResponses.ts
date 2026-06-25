/**
 * OpenAI Responses API 客户端 —— Codex 订阅(ChatGPT Plus/Pro 额度)的推理通道。
 *
 * 与 openaiCompat / anthropicMessages 并列的第三条直连面。Codex 订阅不走 api.openai.com,而是
 * ChatGPT 后端 chatgpt.com/backend-api/codex/responses,且请求体是 Responses 形态(input items +
 * instructions),不是 chat-completions。multiBrain 据 PROTOCOL_MARK='openai-responses' 分发到这里。
 *
 * 无官方文档,wire format 全靠逆向——常量集中在文件顶部,失效优先核对这里:端点/headers/事件名。
 * SSE 流式;把 function_call 项归一回 OpenAI 形态 StreamResult(loop 零改动)。
 *
 * ⚠️ 私有契约,随官方变动易碎。account_id 缺失会 401(登录时从 id_token JWT 解出,见 providerOAuth)。
 */
import { randomUUID } from 'node:crypto';
import type { StreamOpts, StreamResult } from '../seams/cloudBrain.js';
import { LlmError } from '../core/types.js';
import { ACCOUNT_MARK } from './openaiCompat.js';
import { withStreamIdle, type StreamIdleGuard } from './streamIdle.js';

// —— 逆向所得常量(易碎,集中于此)——
const BETA_HEADER = 'responses=experimental';
const ORIGINATOR = 'codex_cli_rs';

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => (p?.type === 'text' ? String(p.text ?? '') : typeof p === 'string' ? p : '')).filter(Boolean).join('\n');
  }
  return content == null ? '' : String(content);
}

/** OpenAI 形态 payload → Responses 请求体。system→instructions、messages→input items、tools 扁平化。 */
export function openaiToResponsesBody(payload: any): any {
  const sysTexts: string[] = [];
  const input: any[] = [];

  for (const m of Array.isArray(payload.messages) ? payload.messages : []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system') {
      const t = contentToText(m.content);
      if (t) sysTexts.push(t);
      continue;
    }
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: contentToText(m.content) });
      continue;
    }
    if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : contentToText(m.content);
      if (text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments || '{}' });
      }
      continue;
    }
    // user(可能带图片 parts)
    const parts = Array.isArray(m.content)
      ? m.content.map((p: any) => (p?.type === 'image_url' ? { type: 'input_image', image_url: p.image_url?.url } : { type: 'input_text', text: String(p?.text ?? '') }))
      : [{ type: 'input_text', text: contentToText(m.content) }];
    input.push({ type: 'message', role: 'user', content: parts });
  }

  const body: any = {
    model: payload.model,
    input,
    stream: true,
    store: false,
  };
  const instructions = sysTexts.join('\n\n');
  if (instructions) body.instructions = instructions;
  if (Array.isArray(payload.tools) && payload.tools.length) {
    body.tools = payload.tools
      .map((t: any) => {
        const fn = t?.function ?? t;
        if (!fn?.name) return null;
        return { type: 'function', name: fn.name, description: fn.description ?? '', parameters: fn.parameters ?? { type: 'object', properties: {} }, strict: false };
      })
      .filter(Boolean);
  }
  const tc = payload.tool_choice;
  if (tc === 'none' || tc === 'auto') body.tool_choice = tc;
  else if (tc && typeof tc === 'object' && tc.type === 'function') body.tool_choice = { type: 'function', name: tc.function?.name };
  return body;
}

/** Codex 订阅流式调用(OAuth Bearer + chatgpt-account-id);归一回 OpenAI 形态。 */
export async function streamOpenAiResponses(opts: StreamOpts): Promise<StreamResult> {
  return withStreamIdle(opts.signal, (guard) => runOpenAiResponsesStream(opts, guard));
}

async function runOpenAiResponsesStream(opts: StreamOpts, guard: StreamIdleGuard): Promise<StreamResult> {
  const { apiKey, baseUrl, payload, onToken, onReasoning, onToolCallDelta } = opts;
  const accountId = (payload as any)?.[ACCOUNT_MARK];
  const body = openaiToResponsesBody(payload);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'OpenAI-Beta': BETA_HEADER,
    originator: ORIGINATOR,
    session_id: randomUUID(),
  };
  if (accountId) headers['chatgpt-account-id'] = String(accountId);

  const response = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers,
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
    throw new LlmError(status, detail || `Codex upstream error ${response.status}`);
  }

  let content = '';
  let reasoning = '';
  let finishReason: string | undefined;
  const usage = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 };
  // function_call:按 item_id 累积,order 保留输出顺序
  const fnCalls = new Map<string, { id: string; name: string; arguments: string }>();
  const order: string[] = [];

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
      const data = trimmed.slice(5).replace(/^ /, '');
      if (!data || data === '[DONE]') continue;
      let ev: any;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      const type: string = ev.type || '';
      if (type === 'response.output_text.delta') {
        if (typeof ev.delta === 'string') {
          content += ev.delta;
          onToken?.(ev.delta);
        }
      } else if (type === 'response.output_item.added' && ev.item?.type === 'function_call') {
        const key = ev.item.id || ev.item_id || `fc_${ev.output_index ?? order.length}`;
        if (!fnCalls.has(key)) {
          fnCalls.set(key, { id: ev.item.call_id || ev.item.id || key, name: ev.item.name || '', arguments: ev.item.arguments || '' });
          order.push(key);
        }
      } else if (type === 'response.function_call_arguments.delta') {
        const key = ev.item_id || `fc_${ev.output_index ?? 0}`;
        const c = fnCalls.get(key);
        if (c && typeof ev.delta === 'string') {
          c.arguments += ev.delta;
          onToolCallDelta?.({ id: c.id, name: c.name, argsLen: c.arguments.length, args: c.arguments, argsDelta: ev.delta });
        }
      } else if (type.startsWith('response.reasoning') && type.endsWith('.delta')) {
        if (typeof ev.delta === 'string') {
          reasoning += ev.delta;
          onReasoning?.(ev.delta);
        }
      } else if (type === 'response.completed' || type === 'response.incomplete') {
        const u = ev.response?.usage;
        if (u) {
          usage.prompt_tokens = u.input_tokens || usage.prompt_tokens;
          usage.completion_tokens = u.output_tokens || usage.completion_tokens;
          const cached = u.input_tokens_details?.cached_tokens;
          if (typeof cached === 'number' && cached > 0) usage.cached_tokens = cached;
        }
      } else if (type === 'response.failed' || type === 'error') {
        throw new LlmError(502, ev.response?.error?.message || ev.error?.message || 'Codex stream error');
      }
    }
  }

  const toolCalls = order
    .map((k) => fnCalls.get(k))
    .filter((c): c is { id: string; name: string; arguments: string } => !!c && !!c.name)
    .map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments || '{}' } }));

  finishReason = toolCalls.length ? 'tool_calls' : 'stop';
  if (usage.completion_tokens === 0 && content) usage.completion_tokens = Math.ceil(content.length / 4);

  return { content, reasoning, toolCalls, usage, finishReason };
}
