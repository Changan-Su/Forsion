import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  buildOpenAiCompatPayload,
  tuneOpenAiDirectPayload,
  compatWireMessages,
  resolveCacheKey,
  streamOpenAiCompat,
  PROTOCOL_MARK,
  ACCOUNT_MARK,
} from './openaiCompat.js';
import { openaiToResponsesBody } from './openaiResponses.js';
import { createProviderRegistry } from './providerRegistry.js';
import { GROK_BUILD_CLIENT_IDENTIFIER, GROK_BUILD_CLIENT_MODE, GROK_BUILD_CLIENT_VERSION } from './grokBuildCompat.js';

// 直连面的档位下发契约。「哪个模型该发什么」的矩阵在 modelCapabilities.test.ts;
// 这里只守 tune 这一层的职责:查表 → 写 payload → 需要时打改道标记。
describe('tuneOpenAiDirectPayload(直连档位下发)', () => {
  const base = () => ({ model: 'gpt-5.6-luna', temperature: 0.7, messages: [], tools: [{}] }) as any;
  const OFFICIAL = 'https://api.openai.com/v1';

  it.each(['codex', 'openai'])('GPT-6 Astra 经 %s 注册表→payload→Responses 保留工具与有效档位', (providerId) => {
    const subscription = providerId === 'codex';
    const reg = createProviderRegistry([{
      providerId, baseUrl: subscription ? 'https://chatgpt.com/backend-api/codex' : OFFICIAL,
      ...(subscription ? { protocol: 'openai-responses' as const, accountId: 'test-account' } : {}),
      modelIds: ['gpt-6-astra'],
    }]);
    const resolved = reg.resolve(`${providerId}/gpt-6-astra`)!;
    for (const requested of [undefined, 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const p = buildOpenAiCompatPayload({
        model: resolved.model, apiModelId: resolved.apiModelId,
        messages: [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'read file' }],
        maxTokens: 1200,
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }],
      });
      Object.assign(p, { top_p: 0.8, top_logprobs: 2, logprobs: true, include: ['message.output_text.logprobs'] });
      const effective = tuneOpenAiDirectPayload(p, requested, { baseUrl: resolved.baseUrl, apiModelId: resolved.apiModelId });
      const expected = !requested || ['off', 'minimal'].includes(requested) ? 'low' : requested;
      expect(effective).toBe(expected);
      expect(p[PROTOCOL_MARK]).toBe('openai-responses');
      const wire = openaiToResponsesBody(p);
      expect(wire.model).toBe('gpt-6-astra');
      expect(wire.reasoning.effort).toBe(expected);
      expect(wire.instructions).toBe('SYSTEM');
      expect(wire.tools[0]).toMatchObject({ type: 'function', name: 'read_file' });
      expect(wire.include).toEqual(['reasoning.encrypted_content']);
      for (const key of ['temperature', 'top_p', 'top_logprobs', 'logprobs', PROTOCOL_MARK, ACCOUNT_MARK]) expect(wire).not.toHaveProperty(key);
      expect(wire.max_output_tokens).toBe(subscription ? undefined : 1200);
    }
  });

  it('思考关 → 补 reasoning_effort:none + 剥 temperature,仍走 chat/completions', () => {
    const p = base();
    tuneOpenAiDirectPayload(p, 'off', OFFICIAL);
    expect(p.reasoning_effort).toBe('none');
    expect(p.temperature).toBeUndefined();
    expect(p[PROTOCOL_MARK]).toBeUndefined();
  });

  it('思考开 → 打 openai-responses 协议标记,effort 随传', () => {
    const p = base();
    tuneOpenAiDirectPayload(p, 'medium', OFFICIAL);
    expect(p[PROTOCOL_MARK]).toBe('openai-responses');
    expect(p.reasoning_effort).toBe('medium');
  });

  it('max_tokens → max_completion_tokens(压缩等通道会带上限)', () => {
    const p = { ...base(), max_tokens: 1200 };
    tuneOpenAiDirectPayload(p, 'off', OFFICIAL);
    expect(p.max_tokens).toBeUndefined();
    expect(p.max_completion_tokens).toBe(1200);
  });

  it('官方但非 gpt-5 族(gpt-4o)不发 effort(实测会被拒),退到系统提示兜底', () => {
    const p = { ...base(), model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'BASE' }] };
    tuneOpenAiDirectPayload(p, 'high', OFFICIAL);
    expect(p.reasoning_effort).toBeUndefined();
    expect(p.messages[0].content).toContain('BASE');
    expect(p.messages[0].content.length).toBeGreaterThan('BASE'.length);
  });

  it('未知网关:不发任何厂商私有字段,只动系统提示', () => {
    const p = { ...base(), model: 'my-model', messages: [{ role: 'system', content: 'BASE' }] };
    tuneOpenAiDirectPayload(p, 'high', 'https://llm.mycorp.internal/v1');
    expect(p.reasoning_effort).toBeUndefined();
    expect(p.thinking).toBeUndefined();
    expect(p.enable_thinking).toBeUndefined();
    expect(p.temperature).toBe(0.7);
  });

  it('未知网关思考关:一个字都不改(与改造前逐字节一致)', () => {
    const p = { ...base(), model: 'my-model', messages: [{ role: 'system', content: 'BASE' }] };
    tuneOpenAiDirectPayload(p, 'off', 'https://llm.mycorp.internal/v1');
    expect(p.messages[0].content).toBe('BASE');
    expect(p.temperature).toBe(0.7);
  });

  it('没有 system 消息时 prefix 兜底会补一条', () => {
    const p = { ...base(), model: 'my-model', messages: [{ role: 'user', content: 'hi' }] };
    tuneOpenAiDirectPayload(p, 'low', 'https://llm.mycorp.internal/v1');
    expect(p.messages[0].role).toBe('system');
    expect(p.messages[1].role).toBe('user');
  });

  it('Codex 订阅(已带协议标记)现在也能拿到档位', () => {
    const p = { ...base(), model: 'gpt-5.6-codex', [PROTOCOL_MARK]: 'openai-responses' };
    tuneOpenAiDirectPayload(p, 'high', { baseUrl: 'https://chatgpt.com/backend-api/codex' });
    expect(p.reasoning_effort).toBe('high');
    expect(p[PROTOCOL_MARK]).toBe('openai-responses');
  });

  it('Claude 订阅拿到 thinking(改造前此路径完全无思考字段)', () => {
    // 4.6 及更早仍是手动扩展思考(budget_tokens)
    const p = { ...base(), model: 'claude-sonnet-4-6', [PROTOCOL_MARK]: 'anthropic-messages' };
    tuneOpenAiDirectPayload(p, 'high', { baseUrl: 'https://api.anthropic.com' });
    expect(p.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
  });

  it('⚠️Claude 5 走自适应:发 budget_tokens 或 temperature 都是 400', () => {
    const p = { ...base(), model: 'claude-sonnet-5', [PROTOCOL_MARK]: 'anthropic-messages' };
    tuneOpenAiDirectPayload(p, 'high', { baseUrl: 'https://api.anthropic.com' });
    expect(p.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(p.output_config).toEqual({ effort: 'high' });
    expect(p.temperature).toBeUndefined();
  });

  it('阿里 DashScope 的 Qwen3 拿到 enable_thinking(改造前是静默无效)', () => {
    const p = { ...base(), model: 'qwen3-max' };
    tuneOpenAiDirectPayload(p, 'medium', { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' });
    expect(p.enable_thinking).toBe(true);
    expect(p.thinking_budget).toBe(8192);
  });

  it('返回夹紧后的实际档位', () => {
    const p = { ...base(), model: 'o3-mini' };
    expect(tuneOpenAiDirectPayload(p, 'off', OFFICIAL)).toBe('minimal'); // o 系关不掉思考
  });
});

// ── B5:prefix 兜底档不得改写调用方持有的 system 消息 ──────────────────────────
describe('buildOpenAiCompatPayload 深拷贝 system 消息', () => {
  const model = { id: 'my-model', name: 'my-model', provider: 'custom' } as any;
  const GATEWAY = 'https://llm.mycorp.internal/v1';

  it('字符串 content:兜底指令只进 payload,调用方的历史一个字不变', () => {
    const shared: any[] = [{ role: 'system', content: 'BASE' }, { role: 'user', content: 'hi' }];
    const p = buildOpenAiCompatPayload({ model, apiModelId: 'my-model', messages: shared });
    tuneOpenAiDirectPayload(p, 'high', GATEWAY);
    expect(p.messages[0].content).toContain('BASE');
    expect(p.messages[0].content.length).toBeGreaterThan('BASE'.length);
    // 回归闸:改造前这里是同一个对象被就地改写 → 兜底指令逐轮累积进会话历史,前缀每轮分叉。
    expect(shared[0].content).toBe('BASE');
    expect(p.messages[0]).not.toBe(shared[0]);
  });

  it('content 为数组的 system:push 写的是副本数组', () => {
    const shared: any[] = [{ role: 'system', content: [{ type: 'text', text: 'BASE' }] }];
    const p = buildOpenAiCompatPayload({ model, apiModelId: 'my-model', messages: shared });
    tuneOpenAiDirectPayload(p, 'high', GATEWAY);
    expect(p.messages[0].content).toHaveLength(2);
    expect(shared[0].content).toHaveLength(1);
  });

  it('非 system 消息保持同一引用(只拷该拷的一条)', () => {
    const shared: any[] = [{ role: 'system', content: 'BASE' }, { role: 'user', content: 'hi' }];
    const p = buildOpenAiCompatPayload({ model, apiModelId: 'my-model', messages: shared });
    expect(p.messages[1]).toBe(shared[1]);
  });
});

// ── B4②(C-6):缓存路由键的取值域 ────────────────────────────────────────────
describe('TANGU_CACHE_KEY_SCOPE', () => {
  const OLD = process.env.TANGU_CACHE_KEY_SCOPE;
  afterEach(() => {
    if (OLD === undefined) delete process.env.TANGU_CACHE_KEY_SCOPE;
    else process.env.TANGU_CACHE_KEY_SCOPE = OLD;
  });

  it('缺省按 agent+模型(09-15 翻转);=session 退回会话键', () => {
    delete process.env.TANGU_CACHE_KEY_SCOPE;
    expect(resolveCacheKey({ cacheKey: 'sess-1', agentId: 'coding', apiModelId: 'gpt-5.6-luna' })).toBe('agent:coding:gpt-5.6-luna');
    process.env.TANGU_CACHE_KEY_SCOPE = 'session';
    expect(resolveCacheKey({ cacheKey: 'sess-1', agentId: 'coding', apiModelId: 'gpt-5.6-luna' })).toBe('sess-1');
  });

  it('=agent → agent+模型;上游没给 agent 身份时保持会话键(绝不静默换桶)', () => {
    process.env.TANGU_CACHE_KEY_SCOPE = 'agent';
    expect(resolveCacheKey({ cacheKey: 'sess-1', agentId: 'coding', apiModelId: 'gpt-5.6-luna' })).toBe('agent:coding:gpt-5.6-luna');
    expect(resolveCacheKey({ cacheKey: 'sess-1', apiModelId: 'gpt-5.6-luna' })).toBe('sess-1');
  });

  it('prompt_cache_key 跟着换桶(provider=openai 的 payload 才带;上不上 wire 见下面的 wire 面)', () => {
    process.env.TANGU_CACHE_KEY_SCOPE = 'agent';
    const p = buildOpenAiCompatPayload({
      model: { id: 'gpt-5.6-luna', name: 'gpt-5.6-luna', provider: 'openai' } as any,
      apiModelId: 'gpt-5.6-luna', messages: [], cacheKey: 'sess-1', agentId: 'coding',
    } as any);
    expect(p.prompt_cache_key).toBe('agent:coding:gpt-5.6-luna');
  });
});

// ── D1:chat-completions 回灌 reasoning_content(按能力表格式门控)───────────────
describe('compatWireMessages(reasoning_content 门控)', () => {
  const msgs = (): any[] => [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok', reasoning_content: 'COT', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'OUT' },
  ];
  const wire = (model: string, baseUrl: string, extra: any = {}) =>
    compatWireMessages({ model, messages: msgs(), ...extra }, { baseUrl });

  it('DeepSeek(format=deepseek):assistant 带回 reasoning_content —— 不带回,带 tools 的续轮会 400', () => {
    expect(wire('deepseek-v4', 'https://api.deepseek.com/v1')[1].reasoning_content).toBe('COT');
  });

  it('GLM(format=zai)同形状,一并放行', () => {
    expect(wire('glm-5.3', 'https://open.bigmodel.cn/api/paas/v4')[1].reasoning_content).toBe('COT');
  });

  it('Qwen 只在开思考时收(enable_thinking 由能力表写)', () => {
    const base = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    expect(wire('qwen3-max', base, { enable_thinking: true })[1].reasoning_content).toBe('COT');
    expect(wire('qwen3-max', base, { enable_thinking: false })[1].reasoning_content).toBeUndefined();
  });

  it('OpenAI 官方与未知网关一律剥掉(未知端点绝不发未知字段:严格网关 400)', () => {
    expect(wire('gpt-5.6-luna', 'https://api.openai.com/v1')[1].reasoning_content).toBeUndefined();
    expect(wire('my-model', 'https://llm.mycorp.internal/v1')[1].reasoning_content).toBeUndefined();
  });

  it('剥的时候只动带该字段的那条,其余引用不变;没有该字段时整个数组原样返回', () => {
    const src = msgs();
    const out = compatWireMessages({ model: 'gpt-5.6-luna', messages: src }, { baseUrl: 'https://api.openai.com/v1' });
    expect(out[0]).toBe(src[0]);
    expect(src[1].reasoning_content).toBe('COT'); // 不就地改写调用方的消息
    const clean = [{ role: 'user', content: 'hi' }];
    expect(compatWireMessages({ model: 'gpt-5.6-luna', messages: clean }, { baseUrl: 'https://api.openai.com/v1' })).toBe(clean);
  });
});

// providerItems 是引擎私有的 Responses/Anthropic item 载体,**没有任何** chat-completions 端点认识它。
// 它走到这里有两条真实路子:同 run 内 assistantTurnOf 无条件挂;跨 run 由 historyReplay 挂(那侧的协议
// 判据只拿得到模型的静态标记,而 tuneOpenAiDirectPayload 能把某一轮动态改道 Responses,于是
// 「上一轮 Responses、这一轮 chat-completions」时历史上确实会带着它进来)。本闸不看端点、无条件剥。
describe('compatWireMessages(providerItems 无条件剥除)', () => {
  const items = [
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC' },
    { type: 'function_call', call_id: 't1', name: 'read', arguments: '{}' },
  ];
  const msgs = (): any[] => [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }], providerItems: items },
    { role: 'tool', tool_call_id: 't1', content: 'OUT' },
  ];

  // 严格端点夹具:未知网关 —— 未知键在这里就是 400。
  it('严格网关:providerItems 一个字节都不上 wire(正文与 tool_calls 原样保留)', () => {
    const src = msgs();
    expect(JSON.stringify(src)).toContain('providerItems'); // 负对照的前半:输入确实带着它
    const out = compatWireMessages({ model: 'my-model', messages: src }, { baseUrl: 'https://llm.mycorp.internal/v1' });
    expect(JSON.stringify(out)).not.toContain('providerItems'); // 剥成 no-op 的话这条立刻红
    expect(JSON.stringify(out)).not.toContain('encrypted_content');
    expect(out[1].content).toBe('ok');
    expect(out[1].tool_calls).toEqual(src[1].tool_calls);
    expect(out[0]).toBe(src[0]); // 不带内部字段的那条仍是同一个引用
    expect(src[1].providerItems).toBe(items); // 不就地改写调用方的消息
  });

  // DeepSeek/GLM 那支是「原样返回该消息」的放行分支 —— 它必须也过 providerItems 这一摘,
  // 否则放行 reasoning_content 的同时把 providerItems 一起送上 wire。
  it('放行 reasoning_content 的族(DeepSeek):COT 留下,providerItems 照样剥', () => {
    const src = msgs();
    src[1].reasoning_content = 'COT';
    const out = compatWireMessages({ model: 'deepseek-v4', messages: src }, { baseUrl: 'https://api.deepseek.com/v1' });
    expect(out[1].reasoning_content).toBe('COT');
    expect(out[1].providerItems).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('providerItems');
  });

  it('NEGATIVE CONTROL: 一条内部字段都没有时整个数组原样返回(没把这里改成恒等 map)', () => {
    const clean = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }];
    expect(compatWireMessages({ model: 'my-model', messages: clean }, { baseUrl: 'https://llm.mycorp.internal/v1' })).toBe(clean);
  });
});

// ── A3 + D1 的 wire 面:usage 解析与请求体 ────────────────────────────────────
describe('streamOpenAiCompat(usage 解析 / wire 面)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const sse = (usage: any): string =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] })}\n` +
    `data: ${JSON.stringify({ choices: [], usage })}\n`;

  const run = async (usage: any, baseUrl = 'https://api.openai.com/v1', payload: any = {}) => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return Promise.resolve({
        ok: true,
        body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse(usage))); c.close(); } }),
      });
    });
    const res = await streamOpenAiCompat({ apiKey: 'k', baseUrl, payload: { model: 'gpt-5.6-luna', messages: [], ...payload } } as any);
    return { res, body: bodies[0] };
  };

  it('上报了缓存量 → 数字(含真实的 0);没上报 → undefined', async () => {
    const hit = await run({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 64 } });
    expect(hit.res.usage.cached_tokens).toBe(64);
    // 报 0 = 这次真没命中;没报 = 这家网关不转发缓存字段。两者归一会把命中率报表洗成假的 0%。
    const zero = await run({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } });
    expect(zero.res.usage.cached_tokens).toBe(0);
    const silent = await run({ prompt_tokens: 100, completion_tokens: 5 });
    expect(silent.res.usage.cached_tokens).toBeUndefined();
  });

  it('DeepSeek 的 prompt_cache_hit_tokens 同样归一', async () => {
    const r = await run({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 32 });
    expect(r.res.usage.cached_tokens).toBe(32);
  });

  it('completion_tokens_details.reasoning_tokens → usage.reasoning_tokens(此前是计量盲区)', async () => {
    const r = await run({ prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 42 } });
    expect(r.res.usage.reasoning_tokens).toBe(42);
    // 极性:上游明确报 0(这轮真没思考)与上游根本没报(这家网关不转发该字段)是两件事 ——
    // 后者必须整个键缺席,否则思考消耗报表会把缺失数据读成「确实没有推理消耗」。
    const zero = await run({ prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 0 } });
    expect(zero.res.usage).toHaveProperty('reasoning_tokens', 0);
    const none = await run({ prompt_tokens: 100, completion_tokens: 50 });
    expect(none.res.usage).not.toHaveProperty('reasoning_tokens');
  });

  it('prompt_cache_key 只对官方 api.openai.com 上 wire(providerId 用户可自定义,不能单凭它判端点能力)', async () => {
    const key = 'agent:coding:gpt-5.6-luna';
    const official = await run({ prompt_tokens: 1, completion_tokens: 1 }, 'https://api.openai.com/v1', { prompt_cache_key: key });
    expect(official.body.prompt_cache_key).toBe(key);
    // 把任意严格网关注册成 providerId:'openai' → 从前每次请求都带上它没声明支持的字段(可能直接 400)。
    const gateway = await run({ prompt_tokens: 1, completion_tokens: 1 }, 'https://llm.mycorp.internal/v1', { prompt_cache_key: key });
    expect(gateway.body).not.toHaveProperty('prompt_cache_key');
    // 子域伪装不算官方(判 hostname 全等,不能用 includes)。
    const spoof = await run({ prompt_tokens: 1, completion_tokens: 1 }, 'https://api.openai.com.evil.tld/v1', { prompt_cache_key: key });
    expect(spoof.body).not.toHaveProperty('prompt_cache_key');
  });

  it('wire body:OpenAI 端点剥掉 reasoning_content,DeepSeek 端点带上', async () => {
    const messages = [{ role: 'assistant', content: 'ok', reasoning_content: 'COT' }];
    const openai = await run({ prompt_tokens: 1, completion_tokens: 1 }, 'https://api.openai.com/v1', { messages });
    expect(openai.body.messages[0].reasoning_content).toBeUndefined();
    const deepseek = await run({ prompt_tokens: 1, completion_tokens: 1 }, 'https://api.deepseek.com/v1', { model: 'deepseek-v4', messages });
    expect(deepseek.body.messages[0].reasoning_content).toBe('COT');
  });

  it('Grok Build 使用 CLI proxy 请求头并省略不兼容的 stream_options', async () => {
    let calledInit: any;
    vi.stubGlobal('fetch', (_u: any, init: any) => {
      calledInit = init;
      return Promise.resolve({
        ok: true,
        body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: [DONE]\n')); c.close(); } }),
      });
    });
    await streamOpenAiCompat({
      apiKey: 'grok-token',
      baseUrl: 'https://cli-chat-proxy.grok.com/v1',
      payload: { model: 'grok-build', messages: [], [PROTOCOL_MARK]: 'grok-build' },
    } as any);
    expect(calledInit.headers).toMatchObject({
      Authorization: 'Bearer grok-token',
      'X-XAI-Token-Auth': 'xai-grok-cli',
      'x-grok-client-version': GROK_BUILD_CLIENT_VERSION,
      'x-grok-client-identifier': GROK_BUILD_CLIENT_IDENTIFIER,
      'x-grok-client-mode': GROK_BUILD_CLIENT_MODE,
      'User-Agent': `grok-shell/${GROK_BUILD_CLIENT_VERSION}`,
      'x-grok-model-override': 'grok-build',
    });
    expect(JSON.parse(calledInit.body)).not.toHaveProperty('stream_options');
  });
});
