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
import { learnFromUpstreamError } from '../services/contextWindowStore.js';
import { LlmError, type AgentModel, type ThinkingLevel, type ToolCall } from '../core/types.js';
import { parseTextToolCalls } from './textToolCalls.js';
import { applyThinking, normalizeThinkingLevel, resolveModelCapability } from './modelCapabilities.js';
import { withStreamIdle, type StreamIdleGuard } from './streamIdle.js';

/** 直连 payload 的私有标记:multiBrain 据此把 stream 分发到本实现而非 httpBrain。 */
export const DIRECT_MARK = '__tangu_direct';
/** 直连协议标记:multiBrain 据此把 stream 再分发到 anthropic-messages / openai-responses 客户端。 */
export const PROTOCOL_MARK = '__tangu_protocol';
/** Codex 订阅:chatgpt-account-id 头取值(从 id_token 解出,随 payload 透传到 responses 客户端)。 */
export const ACCOUNT_MARK = '__tangu_account';
/** run id(BuildPayloadOpts.runId 透传):Responses 客户端据此把粘性路由态按 run 存,绝不跨 run。 */
export const RUN_MARK = '__tangu_run';

/**
 * 缓存路由键(prompt_cache_key / Codex 的 session_id 头)的取值域闸门。
 *
 * 缺省 `agent`(09-15 live 实测后翻转):按 agent+模型 取键,让同一 agent 的不同会话共享上游前缀桶 ——
 * cache 场景四档 2×2:异文新会话首调 0% → 44%,同文新会话 0% → 45%,同会话续写不受影响(93–94%)。
 * `TANGU_CACHE_KEY_SCOPE=session` 退回旧行为(同会话粘同机)。
 * 上游没传 agent 身份(后台阶段 / 子代理)时保持会话键——绝不静默换桶,否则样本分不清是谁的效果。
 */
export function resolveCacheKey(opts: { cacheKey?: string; agentId?: string; apiModelId?: string }): string | undefined {
  if (process.env.TANGU_CACHE_KEY_SCOPE === 'session') return opts.cacheKey;
  if (!opts.agentId) return opts.cacheKey;
  return `agent:${opts.agentId}:${opts.apiModelId || ''}`;
}

/**
 * chat-completions 上 wire 的 messages —— 剥掉引擎内部字段。两类,门控不同:
 *
 * 1. `providerItems`(Responses / Anthropic 的原始 output items,含 encrypted reasoning)**无条件剥**。
 *    它是引擎自己的载体,**没有任何** chat-completions 端点认识它。挂上去的路子有两条:同 run 内
 *    assistantTurnOf 无条件挂;跨 run 由 historyReplay 按「同模型 + 同协议」挂 —— 后者的协议判据在
 *    hydrate 时只拿得到模型的**静态**标记,而 tuneOpenAiDirectPayload 能把本轮动态改道 Responses,
 *    所以「上一轮走 Responses、这一轮回 chat-completions」时历史上确实可能带着它走到这里。
 *    严格网关见到未知键直接 400,故本函数是最后一道、也是**不看端点**的那道闸。
 * 2. `reasoning_content` **默认剥掉,只对已知收该字段的族放行**:DeepSeek 现行文档要求带 tools 的续轮
 *    把此前每条 assistant 的 reasoning_content 原样回传,否则 400;GLM(zai)线上形态相同;Qwen 只在
 *    开思考时收。其余端点(OpenAI 官方 / Azure / vLLM 类网关)对未知键没有文档 —— 未知端点绝不发未知字段。
 *    该字段只挂在**本 run 内存里**的 assistant 消息上(落库与跨 run 水合都不带),天然「同轮内回灌」。
 */
export function compatWireMessages(payload: any, target: { baseUrl?: string; provider?: string }): any[] {
  const msgs: any[] = Array.isArray(payload?.messages) ? payload.messages : [];
  const internal = (m: any): boolean => !!m && (m.reasoning_content !== undefined || m.providerItems !== undefined);
  // 一条都不带内部字段 → 原样返回**同一个数组**(调用方据此判「没动过」;别换成恒等 map)。
  if (!msgs.some(internal)) return msgs;
  const cap = resolveModelCapability({
    baseUrl: target.baseUrl,
    provider: target.provider,
    modelId: String(payload?.model || ''),
  });
  const replay =
    cap.format === 'deepseek' || cap.format === 'zai' || (cap.format === 'qwen' && payload?.enable_thinking === true);
  return msgs.map((m) => {
    if (!internal(m)) return m;
    // providerItems 先无条件摘掉,再按能力表决定 reasoning_content 的去留(放行那支也**必须**过这一摘:
    // 直接 `return m` 会把 providerItems 一起送上 DeepSeek/GLM 的 wire)。
    const { providerItems: _dropItems, ...kept } = m;
    if (replay && m.role === 'assistant' && m.reasoning_content) return kept;
    const { reasoning_content: _dropCot, ...rest } = kept;
    return rest;
  });
}

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

  // prefix 兜底档会**就地改写** system 消息(appendSystemToPayload),而 messages[0] 与调用方
  // (agentLoop 的 workingMessages)是同一个对象 —— 不拷就把兜底指令逐轮累积进共享历史,前缀每轮
  // 分叉、缓存全 miss。content 为数组的分支同样要拷(那条路径是 push,写的是共享数组)。
  const finalMessages = applyAttachments(
    (messages as any[]).map((m) =>
      m?.role === 'system' ? { ...m, ...(Array.isArray(m.content) ? { content: [...m.content] } : {}) } : m,
    ),
    attachments,
  );

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
  // 防严格网关拒未知字段)。Responses 协议(Codex 订阅)也带上——它不进 wire body
  // (openaiToResponsesBody 白名单重建),只喂 session_id 头的稳定化(缓存/路由粘性)。
  // ⚠️ provider 是**用户可自定义**的 providerId,不保证 'openai' 指向官方端点:真正决定这个字段
  // 上不上 chat-completions wire 的是 streamOpenAiCompat 里的官方 host 闸(见 isOfficialOpenAiHost)。
  const routingKey = resolveCacheKey({ cacheKey, agentId: opts.agentId, apiModelId });
  if (routingKey && ((opts.model as any)?.provider === 'openai' || (opts.model as any)?.[PROTOCOL_MARK] === 'openai-responses')) {
    payload.prompt_cache_key = routingKey;
  }
  // run 身份透传(私有标记,发请求前剥掉):Responses 客户端按 run 存粘性路由态。
  const runId = opts.runId;
  if (typeof runId === 'string' && runId) payload[RUN_MARK] = runId;
  // 透传直连协议/账号标记,供 streamProviderCompletion 分发到原生订阅客户端。
  const dm = opts.model as any;
  if (dm?.[PROTOCOL_MARK]) payload[PROTOCOL_MARK] = dm[PROTOCOL_MARK];
  if (dm?.[ACCOUNT_MARK]) payload[ACCOUNT_MARK] = dm[ACCOUNT_MARK];
  // verbosity / 思考摘要:只打在 Responses 协议 payload 上(openaiToResponsesBody 消费);
  // 绝不落 chat-completions wire(严格网关见未知字段会 400)。
  if (dm?.[PROTOCOL_MARK] === 'openai-responses') {
    if (opts.verbosity) payload.text_verbosity = opts.verbosity;
    if (opts.reasoningSummary) payload.reasoning_summary = opts.reasoningSummary;
  }
  return payload;
}

/**
 * 把系统提示追加进 OpenAI 形态 payload(prefix 兜底档用)。
 * agentLoop 已把 agent 基底提示拼进 messages[0];没有 system 消息就补一条。
 */
function appendSystemToPayload(payload: any, text: string): void {
  if (!text) return;
  const msgs: any[] = Array.isArray(payload.messages) ? payload.messages : (payload.messages = []);
  const sys = msgs.find((m) => m?.role === 'system');
  if (!sys) {
    msgs.unshift({ role: 'system', content: text });
    return;
  }
  if (typeof sys.content === 'string') sys.content = `${sys.content}\n\n${text}`;
  else if (Array.isArray(sys.content)) sys.content.push({ type: 'text', text });
  else sys.content = text;
}

/**
 * 直连 payload 的 provider 适配 —— 档位/字段名/温度这些差异**全部**查 `modelCapabilities` 能力表。
 *
 * 改造前这里只对官方 api.openai.com + `^gpt-5` 特判,其余 provider 的 thinkingLevel 被静默吞掉。
 * 现在由能力表按 host/协议/模型族路由到各家的线上形态(见该文件头注释),本函数只剩两件事:
 *   1. 调 applyThinking 写字段
 *   2. 思考开且该端点要求改道时,打 PROTOCOL_MARK 分发到 /v1/responses
 *
 * 保留的实测契约(2026-07,gpt-5.6-luna):chat/completions + tools + 缺省档位会 400
 * 「…use /v1/responses or set reasoning_effort to 'none'」→ 关档补 'none' 留在 chat/completions,
 * 开档改道 responses。temperature≠1 与 max_tokens 同样被拒,由能力表的 quirk 位处理。
 *
 * @returns 夹紧后实际生效的档位(可能被模型能力降档);仅供日志/UI 回显。
 */
export function tuneOpenAiDirectPayload(
  payload: any,
  thinkingLevel: string | undefined,
  target: { baseUrl?: string; provider?: string; apiModelId?: string } | string | undefined,
): ThinkingLevel {
  const t = typeof target === 'string' ? { baseUrl: target } : (target || {});
  const cap = resolveModelCapability({
    baseUrl: t.baseUrl,
    provider: t.provider,
    modelId: t.apiModelId || String(payload.model || ''),
    protocol: typeof payload[PROTOCOL_MARK] === 'string' ? payload[PROTOCOL_MARK] : undefined,
  });
  const level = normalizeThinkingLevel(thinkingLevel, 'off');
  const { effective, viaResponses } = applyThinking(payload, level, cap, (text) => appendSystemToPayload(payload, text));
  if (viaResponses) payload[PROTOCOL_MARK] = 'openai-responses';
  return effective;
}

/** 从 providerRegistry 命中结果构造的 AgentModel 带此标记,buildProviderPayload 据此走直连。 */
export function makeDirectModel(
  modelId: string,
  providerId: string,
  extra?: { protocol?: string; accountId?: string },
): AgentModel {
  return {
    id: modelId,
    name: modelId,
    provider: providerId,
    [DIRECT_MARK]: true,
    ...(extra?.protocol ? { [PROTOCOL_MARK]: extra.protocol } : {}),
    ...(extra?.accountId ? { [ACCOUNT_MARK]: extra.accountId } : {}),
  };
}

/**
 * 流式补全（OpenAI 兼容 SSE）。逐 token 回调,跨 chunk 按 index 累积 tool_calls。
 * 原样搬自 server/src/services/llmService.ts:243-351（纯 fetch,无 server 耦合）。
 */
export async function streamOpenAiCompat(opts: StreamOpts): Promise<StreamResult> {
  return withStreamIdle(opts.signal, (guard) => runOpenAiCompatStream(opts, guard));
}

/** 官方 OpenAI 端点判定 —— hostname **全等**比对(用 includes 会把 api.openai.com.evil.tld 认成官方)。 */
function isOfficialOpenAiHost(baseUrl: string | undefined): boolean {
  try {
    return new URL(baseUrl || '').hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

async function runOpenAiCompatStream(opts: StreamOpts, guard: StreamIdleGuard): Promise<StreamResult> {
  const { apiKey, baseUrl, payload, onToken, onReasoning, onToolCallDelta } = opts;
  // 剥掉私有标记,再发给 provider。prompt_cache_key 一并摘下,只在官方 host 上补回(见下)。
  const { [DIRECT_MARK]: _omitDirect, __forsion_model_id: _omitFsn, [PROTOCOL_MARK]: _omitProto, [ACCOUNT_MARK]: _omitAcct, [RUN_MARK]: _omitRun, prompt_cache_key: cacheKeyField, ...clean } = payload as any;
  const streamPayload = {
    ...clean,
    messages: compatWireMessages(clean, { baseUrl, provider: opts.provider }),
    stream: true,
    stream_options: { include_usage: true },
    // prompt_cache_key 只对官方 api.openai.com 上 wire:providerId 是用户可自定义字符串
    // (providerRegistry 不保证 'openai' == 官方端点),把任意严格网关注册成 'openai' 后,这个它
    // 没声明支持的字段会随每次请求发出去,可能直接 400 —— 未知端点绝不发未知字段。
    // ponytail: 官方 host 但注册在别的 providerId 下时 payload 本就没有这个字段(build 侧门控未放宽),
    // 这里补不回来 —— 那是既有的漏优化,不是本次回归。
    ...(cacheKeyField && isOfficialOpenAiHost(baseUrl) ? { prompt_cache_key: cacheKeyField } : {}),
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey && apiKey !== '__cloud_proxy__') headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(streamPayload),
    signal: guard.signal,
  });
  opts.onResponseStart?.();

  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => '');
    let detail = errorText;
    try {
      const j = JSON.parse(errorText);
      detail = j.error?.message || j.message || errorText;
    } catch {
      /* keep raw */
    }
    // 超长被拒时,报错文案里几乎总写明真实上限 —— 学下来,下次按真值算预算(见 contextWindowStore)。
    // 只学不拦:学到与否都照常抛错,失败语义一个字不变。
    learnFromUpstreamError(streamPayload?.model, response.status, detail);
    const status = response.status === 401 || response.status === 403 ? 502 : response.status || 502;
    throw new LlmError(status, detail || `Upstream error ${response.status}`);
  }

  let content = '';
  let reasoning = '';
  let finishReason: string | undefined;
  // 可选字段必须在字面量里预置类型,否则后面按需赋值会 TS2339。
  const usage: {
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens?: number;
    cache_write_tokens: number;
    reasoning_tokens?: number;
  } = { prompt_tokens: 0, completion_tokens: 0, cache_write_tokens: 0 };
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();

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
          guard.progress();
          content += delta.content;
          onToken?.(delta.content);
        }
        const r = delta.reasoning_content ?? delta.reasoning;
        if (typeof r === 'string' && r) {
          guard.progress();
          reasoning += r;
          onReasoning?.(r);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            const cur = toolAcc.get(idx) || { id: '', name: '', arguments: '' };
            const startsTool = (typeof tc.id === 'string' && tc.id && !cur.id)
              || (typeof tc.function?.name === 'string' && tc.function.name && !cur.name);
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            const argsDelta = typeof tc.function?.arguments === 'string' ? tc.function.arguments : '';
            if (startsTool || argsDelta) guard.progress();
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
        // 上游**没报**缓存量 → 保持 undefined:报了 0(这次真没命中)与根本没报是两件事,
        // 都归 0 就把「这家网关不转发缓存字段」洗成了「命中率 0%」,命中率报表整片失真。
        if (typeof cached === 'number') usage.cached_tokens = cached;
        const written = json.usage.cache_creation_input_tokens ?? json.usage.prompt_cache_write_tokens;
        if (typeof written === 'number' && written > 0) usage.cache_write_tokens = written;
        // chat-completions 的隐藏思考量(DeepSeek/GLM/Qwen 走这条路);此前整条链路不解析 → 计量盲区。
        // 与 cached_tokens 同一条极性:上游报了就赋值(**含 0**),没报保持 undefined。
        // 把 0 过滤掉 = 把「这轮真没思考」洗成「上游没报」,与 Responses 侧语义相反。
        const reasoningTokens = json.usage.completion_tokens_details?.reasoning_tokens;
        if (typeof reasoningTokens === 'number') usage.reasoning_tokens = reasoningTokens;
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

  let toolCalls: ToolCall[] = Array.from(toolAcc.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([idx, t]) => ({
      id: t.id || `call_${idx}`,
      type: 'function' as const,
      function: { name: t.name, arguments: t.arguments || '{}' },
    }))
    .filter((t) => t.function.name);

  // 原生 tool_calls 为空 → 文本兜底:个别模型把工具调用当正文吐出(<invoke …>/｜｜DSML｜｜ 等),
  // 解析回结构化调用并从正文剔除,避免 agent 误判收尾停住。
  let outContent = content;
  if (toolCalls.length === 0) {
    const fb = parseTextToolCalls(content);
    if (fb.toolCalls.length) {
      toolCalls = fb.toolCalls as unknown as ToolCall[];
      outContent = fb.cleaned;
    }
  }

  return { content: outContent, reasoning, toolCalls, usage, finishReason };
}
