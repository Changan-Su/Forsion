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
import { createHash, randomUUID } from 'node:crypto';
import type { StreamOpts, StreamResult } from '../seams/cloudBrain.js';
import { LlmError } from '../core/types.js';
import { ACCOUNT_MARK } from './openaiCompat.js';
import { withStreamIdle, type StreamIdleGuard } from './streamIdle.js';

// —— 逆向所得常量(易碎,集中于此)——
const BETA_HEADER = 'responses=experimental';
const ORIGINATOR = 'codex_cli_rs';

/** 会话级稳定 session UUID:cacheKey 本身是 UUID 就直用;否则 md5 → UUID 形状;没有则回退随机。 */
export function stableSessionUuid(cacheKey?: unknown): string {
  const k = typeof cacheKey === 'string' ? cacheKey.trim() : '';
  if (!k) return randomUUID();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return k.toLowerCase();
  const h = createHash('md5').update(k).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

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
      // reasoning 延续性:本 run 内产生的 assistant 轮挂着原始 output items(reasoning/message/
      // function_call,含 encrypted_content)→ 原样回灌,不再由文本重建。OpenAI 契约:函数调用续轮
      // 必须带回 reasoning items,否则模型每轮从零重推理(官方口径 SWE-bench ~3% 差距,输出token也涨)。
      // 跨 run 水合的历史没有 items → 走下面的文本重建,优雅降级。
      if (Array.isArray(m.providerItems) && m.providerItems.length) {
        input.push(...m.providerItems);
        continue;
      }
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
    // store:false 下要拿回可回灌的思考态,必须显式要 encrypted_content。**无条件发**(codex-rs 同款):
    // 缺省 effort 时服务端仍可能按模型默认思考,按档位门控会让延续性静默失效(Codex 评审二轮 #1);
    // 非思考响应只是没有该 item,include 本身零成本。本路径只通官方 OpenAI / Codex 订阅端点。
    include: ['reasoning.encrypted_content'],
  };
  // 思考档由 tuneOpenAiDirectPayload 按能力表写进 payload.reasoning_effort(官方直连与 Codex 订阅都走这里)。
  // summary:'auto' 让思考过程以 reasoning delta 流回(否则 UI 只见沉默);effort 'none' 时不发 summary
  // ——「不思考」与「要思考摘要」互斥,同发会被拒。headless 场景(bench/自动化)可经
  // payload.reasoning_summary='none' 关摘要省输出(codex 模型目录默认即 none;UI 会看不到思考过程)。
  if (payload.reasoning_effort) {
    body.reasoning =
      payload.reasoning_effort === 'none'
        ? { effort: 'none' }
        : { effort: payload.reasoning_effort, ...(payload.reasoning_summary === 'none' ? {} : { summary: 'auto' }) };
  }
  // GPT-5 系 verbosity(coding 预设下发 low,对齐 codex 模型默认;省可见正文的输出量)。
  if (payload.text_verbosity) body.text = { verbosity: payload.text_verbosity };
  // 官方 Responses(BYOK)支持 max_output_tokens;**订阅私有端点直接 400 拒**("Unsupported parameter")
  // ——未知端点绝不发未知字段。实证:self_brainstorm 真机首跑三席全灭、compaction 传 maxTokens 同病(07-31)。
  const cap = payload.max_completion_tokens ?? payload.max_tokens;
  if (cap && !payload[ACCOUNT_MARK]) body.max_output_tokens = cap;
  // 官方 Responses(BYOK,无 accountId)支持 body 级 prompt_cache_key;订阅私有端点不发未知字段。
  if (payload.prompt_cache_key && !payload[ACCOUNT_MARK]) body.prompt_cache_key = payload.prompt_cache_key;
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
  };
  // Codex 逆向头只在订阅路径(accountId 存在)发:官方 api.openai.com 带 OpenAI-Beta:
  // responses=experimental 会**静默压掉 reasoning summary**(A/B 实测同 body 0 vs 160 条 delta),
  // 表现为「开了思考却看不到思考过程」。官方 BYOK 走纯 Bearer。
  if (accountId) {
    headers['OpenAI-Beta'] = BETA_HEADER;
    headers.originator = ORIGINATOR;
    // session_id 按会话粘住(codex-rs 用整场会话同一 conversation UUID):每请求随机会打散
    // 服务端的缓存/路由粘性。cacheKey(=sessionId)非 UUID 形状时降级为哈希出的稳定 UUID。
    headers.session_id = stableSessionUuid((payload as any)?.prompt_cache_key);
    headers['chatgpt-account-id'] = String(accountId);
  }

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
  let incomplete = false; // response.incomplete(max_output_tokens 等):输出被截断,工具参数不可信
  const usage = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 };
  // 完整 output items(reasoning/message/function_call,按 output_item.done 到达序):回给 loop 挂到
  // assistant 消息上,续轮原样回灌(reasoning 延续性)。截断响应(incomplete)不回——半截参数不可信。
  const outputItems: any[] = [];
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
      } else if (type === 'response.output_item.done' && ev.item && typeof ev.item === 'object') {
        // 记 output_index 供收尾排序:正常 SSE 有序,但代理重排/实现差异下按 index 恢复原始输出序(防御)。
        outputItems.push({ __idx: typeof ev.output_index === 'number' ? ev.output_index : outputItems.length, item: ev.item });
      } else if (type === 'response.completed' || type === 'response.incomplete') {
        // incomplete=响应被截断(常见 max_output_tokens;content_filter 等其他原因的半截参数同样不可信)
        // → 统一归一化为 finishReason:'length',让 agentLoop 的截断硬化把工具调用全部置错不执行。
        if (type === 'response.incomplete') incomplete = true;
        const u = ev.response?.usage;
        if (u) {
          usage.prompt_tokens = u.input_tokens || usage.prompt_tokens;
          usage.completion_tokens = u.output_tokens || usage.completion_tokens;
          const cached = u.input_tokens_details?.cached_tokens;
          if (typeof cached === 'number' && cached > 0) usage.cached_tokens = cached;
          const rt = u.output_tokens_details?.reasoning_tokens;
          if (typeof rt === 'number' && rt > 0) usage.reasoning_tokens = rt;
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

  finishReason = incomplete ? 'length' : toolCalls.length ? 'tool_calls' : 'stop';
  if (usage.completion_tokens === 0 && content) usage.completion_tokens = Math.ceil(content.length / 4);

  const orderedItems = outputItems.sort((a, b) => a.__idx - b.__idx).map((o) => o.item);
  return { content, reasoning, toolCalls, usage, finishReason, ...(incomplete || !orderedItems.length ? {} : { outputItems: orderedItems }) };
}
