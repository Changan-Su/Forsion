/**
 * OpenAI 兼容 LLM 实现（直连 provider 用）—— 接缝② `brain.llm` 的「直连面」。
 *
 * 与 Forsion 托管面（httpBrain → brain-api）并列:本文件让 standalone 持用户自己的 key 直连
 * OpenAI / Ollama / 任意 OpenAI 兼容 /chat/completions 端点。两块逻辑:
 *   - streamOpenAiCompat: 从 server/src/services/llmService.ts:243-351 原样搬来的「纯」流式
 *     补全(无任何 Forsion/DB 耦合,逐 token 回调 + 跨 chunk 累积 tool_calls)。
 *   - buildOpenAiCompatPayload: 精简 payload 装配——messages/tools 本就是 OpenAI 形态,直接用;
 *     **不含** Forsion 的分层 prompt / 缓存 / thinking(那些是云端托管面的能力,直连面拿原始 payload)。
 *
 * core 的 agentLoop 已把 agent 基底系统提示拼进 workingMessages[0],故直连面不会丢系统提示。
 */
import type { BuildPayloadOpts, StreamOpts, StreamResult } from '../seams/cloudBrain.js';
import { LlmError, type AgentModel, type ToolCall } from '../core/types.js';

/** 直连 payload 的私有标记:multiBrain 据此把 stream 分发到本实现而非 httpBrain。 */
export const DIRECT_MARK = '__tangu_direct';

/** 把 image attachments 合进最后一条 user 消息（搬自 llmService.applyAttachments,纯函数）。 */
function applyAttachments(finalMessages: any[], attachments: any[]): any[] {
  if (!attachments || attachments.length === 0) return finalMessages;
  const lastIdx = finalMessages.length - 1;
  if (lastIdx < 0 || finalMessages[lastIdx].role !== 'user') return finalMessages;
  const lastMsg = finalMessages[lastIdx];
  const images = attachments.filter((att) => att.type === 'image');
  if (images.length === 0) return finalMessages;

  const base = Array.isArray(lastMsg.content)
    ? [...(lastMsg.content as any[])]
    : [{ type: 'text', text: lastMsg.content || '' }];
  images.forEach((att) => base.push({ type: 'image_url', image_url: { url: att.url, detail: 'high' } }));
  finalMessages[lastIdx] = { ...lastMsg, content: base };
  return finalMessages;
}

/**
 * 精简 OpenAI 兼容 payload。messages(含 agentLoop 拼好的 system) 与 tools 已是 OpenAI 形态,直接透传。
 * 标记 DIRECT_MARK 供 streamProviderCompletion 分发;发请求前由 streamOpenAiCompat 剥掉。
 */
export function buildOpenAiCompatPayload(opts: BuildPayloadOpts): any {
  const {
    apiModelId,
    messages,
    temperature = 0.7,
    maxTokens,
    tools,
    toolChoice,
    attachments = [],
    stream = true,
    cacheKey,
  } = opts;

  const finalMessages = applyAttachments([...messages], attachments);

  const payload: any = {
    model: apiModelId,
    messages: finalMessages,
    temperature,
    stream,
    stream_options: stream ? { include_usage: true } : undefined,
    [DIRECT_MARK]: true,
  };
  if (maxTokens) payload.max_tokens = maxTokens;
  if (tools && tools.length) {
    payload.tools = tools;
    if (toolChoice) payload.tool_choice = toolChoice;
  }
  // OpenAI 官方 API 直连:prompt_cache_key 按会话粘机提升前缀缓存命中(其他 provider 不发,
  // 防严格网关拒未知字段)。
  if (cacheKey && (opts.model as any)?.provider === 'openai') {
    payload.prompt_cache_key = cacheKey;
  }
  return payload;
}

/** 从 providerRegistry 命中结果构造的 AgentModel 带此标记,buildProviderPayload 据此走直连。 */
export function makeDirectModel(modelId: string, providerId: string): AgentModel {
  return { id: modelId, name: modelId, provider: providerId, [DIRECT_MARK]: true };
}

/**
 * 流式补全（OpenAI 兼容 SSE）。逐 token 回调,跨 chunk 按 index 累积 tool_calls。
 * 原样搬自 server/src/services/llmService.ts:243-351（纯 fetch,无 server 耦合）。
 */
export async function streamOpenAiCompat(opts: StreamOpts): Promise<StreamResult> {
  const { apiKey, baseUrl, payload, onToken, onReasoning, onToolCallDelta, signal } = opts;
  // 剥掉私有标记,再发给 provider。
  const { [DIRECT_MARK]: _omitDirect, __forsion_model_id: _omitFsn, ...clean } = payload as any;
  const streamPayload = { ...clean, stream: true, stream_options: { include_usage: true } };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey && apiKey !== '__cloud_proxy__') headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(streamPayload),
    signal,
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => '');
    let detail = errorText;
    try {
      const j = JSON.parse(errorText);
      detail = j.error?.message || j.message || errorText;
    } catch {
      /* keep raw */
    }
    const status = response.status === 401 || response.status === 403 ? 502 : response.status || 502;
    throw new LlmError(status, detail || `Upstream error ${response.status}`);
  }

  let content = '';
  let reasoning = '';
  let finishReason: string | undefined;
  const usage = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 };
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).replace(/^ /, '');
      if (data === '[DONE]' || data === '') continue;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = json.choices?.[0];
      const delta = choice?.delta;
      if (delta) {
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          onToken?.(delta.content);
        }
        const r = delta.reasoning_content ?? delta.reasoning;
        if (typeof r === 'string' && r) {
          reasoning += r;
          onReasoning?.(r);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            const cur = toolAcc.get(idx) || { id: '', name: '', arguments: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            const argsDelta = typeof tc.function?.arguments === 'string' ? tc.function.arguments : '';
            if (argsDelta) cur.arguments += argsDelta;
            toolAcc.set(idx, cur);
            if (onToolCallDelta)
              onToolCallDelta({ id: cur.id || `call_${idx}`, name: cur.name, argsLen: cur.arguments.length, args: cur.arguments, argsDelta });
          }
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (json.usage) {
        usage.prompt_tokens = json.usage.prompt_tokens || usage.prompt_tokens;
        usage.completion_tokens = json.usage.completion_tokens || usage.completion_tokens;
        // 缓存命中归一化(与 server llmService 同口径):OpenAI prompt_tokens_details.cached_tokens、
        // DeepSeek prompt_cache_hit_tokens、Anthropic 兼容网关 cache_read_input_tokens。
        const cached =
          json.usage.prompt_tokens_details?.cached_tokens ??
          json.usage.prompt_cache_hit_tokens ??
          json.usage.cache_read_input_tokens;
        if (typeof cached === 'number' && cached > 0) usage.cached_tokens = cached;
        const written = json.usage.cache_creation_input_tokens ?? json.usage.prompt_cache_write_tokens;
        if (typeof written === 'number' && written > 0) usage.cache_write_tokens = written;
      }
    }
  }

  if (usage.completion_tokens === 0 && content) {
    usage.completion_tokens = Math.ceil(content.length / 4);
  }
  if (usage.prompt_tokens === 0) {
    try {
      usage.prompt_tokens = Math.ceil(JSON.stringify((payload as any).messages || []).length / 4);
    } catch {
      /* ignore */
    }
  }

  const toolCalls: ToolCall[] = Array.from(toolAcc.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([idx, t]) => ({
      id: t.id || `call_${idx}`,
      type: 'function' as const,
      function: { name: t.name, arguments: t.arguments || '{}' },
    }))
    .filter((t) => t.function.name);

  return { content, reasoning, toolCalls, usage, finishReason };
}
