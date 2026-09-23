import { describe, it, expect, afterEach, vi } from 'vitest';
import { openaiToAnthropicBody, streamAnthropicMessages } from './anthropicMessages.js';
import { tuneOpenAiDirectPayload, PROTOCOL_MARK as PROTOCOL } from './openaiCompat.js';

describe('openaiToAnthropicBody', () => {
  // 能力表 → wire 端到端:Opus 5.5 思考常开(disabled 是 400),display 缺省 omitted 会让工具间旁白静默。
  it('Opus 5.5 拨「关」:仍发 adaptive + summarized + 最弱档,不发 disabled / temperature', () => {
    const p: any = { model: 'claude-opus-5-5', temperature: 0.7, messages: [{ role: 'user', content: 'hi' }], [PROTOCOL]: 'anthropic-messages' };
    expect(tuneOpenAiDirectPayload(p, 'off', { baseUrl: 'https://api.anthropic.com' })).toBe('minimal');
    const body = openaiToAnthropicBody(p);
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.temperature).toBeUndefined();
  });

  it('lifts role:system to the top level verbatim — no injected client identity block', () => {
    const body = openaiToAnthropicBody({
      model: 'claude-x',
      messages: [
        { role: 'system', content: 'BE NICE' },
        { role: 'user', content: 'hi' },
      ],
    });
    // 回归闸:订阅 OAuth 分支(强制首块「You are Claude Code…」冒充官方 CLI)已于 2026-07-31 删除。
    // 这条断言的作用是让它加回来时立刻红,而不是悄悄多一块 system。
    expect(body.system).toEqual([{ type: 'text', text: 'BE NICE' }]);
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('converts assistant tool_calls → tool_use and coalesces tool results into one user turn', () => {
    const body = openaiToAnthropicBody({
      model: 'claude-x',
      messages: [
        { role: 'user', content: 'read a' },
        { role: 'assistant', content: 'ok', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{"p":"a"}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'FILE BODY' },
        { role: 'tool', tool_call_id: 't1b', content: 'SECOND' },
      ],
    });
    const asst = body.messages.find((m: any) => m.role === 'assistant');
    expect(asst.content).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'tool_use', id: 't1', name: 'read', input: { p: 'a' } },
    ]);
    const toolUser = body.messages[body.messages.length - 1];
    expect(toolUser.role).toBe('user');
    expect(toolUser.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'FILE BODY' },
      { type: 'tool_result', tool_use_id: 't1b', content: 'SECOND' },
    ]);
  });

  // D1 的另一半:agentLoop 现在无条件把 reasoning_content 挂到本 run 内存里的 assistant 消息上,
  // 这条钉住它绝不随 Anthropic body 上 wire(块式重建;思考延续性走 providerItems 的 thinking 块)。
  it('assistant 的 reasoning_content 不进 body(块式重建,未知字段不外泄)', () => {
    const body = openaiToAnthropicBody({
      model: 'claude-x',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'VISIBLE-BODY', reasoning_content: 'COT-SECRET' },
      ],
    });
    // 两条一起才不是空断言:正文进了 body(这条 assistant 确实被转换过),思考没进。
    expect(JSON.stringify(body)).toContain('VISIBLE-BODY');
    expect(JSON.stringify(body)).not.toContain('COT-SECRET');
  });

  it('maps OpenAI tools → input_schema and tool_choice vocab', () => {
    const body = openaiToAnthropicBody({
      model: 'claude-x',
      messages: [],
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: { x: { type: 'string' } } } } }],
      tool_choice: 'auto',
    });
    expect(body.tools).toEqual([{ name: 'f', description: 'd', input_schema: { type: 'object', properties: { x: { type: 'string' } } } }]);
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });
});

describe('用户自有 API key 路径', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('无系统提示时整个 system 字段不发(别塞空数组)', () => {
    const bare = openaiToAnthropicBody({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] });
    expect(bare.system).toBeUndefined();
  });

  it('走 x-api-key;不发 Authorization、不发 oauth beta 头', async () => {
    let seen: any = null;
    vi.stubGlobal('fetch', (_u: string, init: any) => {
      seen = init.headers;
      return Promise.resolve({ ok: false, status: 401, body: null, json: () => Promise.resolve({ error: { message: 'x' } }) });
    });
    await streamAnthropicMessages({
      apiKey: 'sk-ant-api03-xxx',
      baseUrl: 'https://api.anthropic.com',
      payload: { model: 'claude-x', messages: [] },
    } as any).catch(() => {});
    expect(seen['x-api-key']).toBe('sk-ant-api03-xxx');
    // 同上,这两条是删除订阅 OAuth 分支的回归闸。
    expect(seen.Authorization).toBeUndefined();
    expect(seen['anthropic-beta']).toBeUndefined();
  });
});

// ── B5:≤4 个 cache_control 断点 + 思考块原样回灌 ─────────────────────────────
describe('Anthropic 直连的缓存断点与思考延续性', () => {
  afterEach(() => vi.unstubAllGlobals());

  const PROTOCOL_MARK = '__tangu_protocol';
  const bpCount = (body: any): number =>
    [
      ...(body.tools || []),
      ...(body.system || []),
      ...(body.messages || []).flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])),
    ].filter((b: any) => b?.cache_control).length;

  const manyTurns = (n: number): any[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));

  it('按协议门控打断点:tools 尾 → system 尾 → 最后两条消息,总数正好 4(Anthropic 硬上限)', () => {
    const body = openaiToAnthropicBody({
      model: 'claude-x',
      [PROTOCOL_MARK]: 'anthropic-messages',
      messages: [{ role: 'system', content: 'SYS' }, ...manyTurns(6)],
      tools: [
        { type: 'function', function: { name: 'a', parameters: {} } },
        { type: 'function', function: { name: 'b', parameters: {} } },
      ],
    });
    expect(bpCount(body)).toBe(4);
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' }); // 工具表尾(13k 固定头的末端)
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    const msgs = body.messages;
    expect(msgs[msgs.length - 1].content.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(msgs[msgs.length - 2].content.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(msgs[msgs.length - 3].content.at(-1).cache_control).toBeUndefined(); // 上限截断在这里
  });

  it('消息少于断点额度时不凭空补,也绝不超过 4', () => {
    const body = openaiToAnthropicBody({
      model: 'claude-x',
      [PROTOCOL_MARK]: 'anthropic-messages',
      messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }],
    });
    expect(bpCount(body)).toBe(2);
  });

  it('没有协议标记(其他直连面复用本转换器)→ 一个断点都不打', () => {
    const body = openaiToAnthropicBody({
      model: 'claude-x',
      messages: [{ role: 'system', content: 'SYS' }, ...manyTurns(4)],
      tools: [{ type: 'function', function: { name: 'a', parameters: {} } }],
    });
    expect(bpCount(body)).toBe(0);
  });

  it('思考块排在正文/tool_use 之前原样回灌(工具轮少了它 = 被拒或从零重推理);关思考时不回灌', () => {
    const items = [{ type: 'thinking', thinking: 'COT', signature: 'SIG' }, { type: 'redacted_thinking', data: 'RED' }];
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'ok', providerItems: items, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'OUT' },
    ];
    const on = openaiToAnthropicBody({ model: 'claude-x', messages, thinking: { type: 'enabled', budget_tokens: 4096 } });
    const asst = on.messages.find((m: any) => m.role === 'assistant');
    expect(asst.content.map((b: any) => b.type)).toEqual(['thinking', 'redacted_thinking', 'text', 'tool_use']);
    expect(asst.content[0]).toEqual({ type: 'thinking', thinking: 'COT', signature: 'SIG' });
    const off = openaiToAnthropicBody({ model: 'claude-x', messages, thinking: { type: 'disabled' } });
    expect(off.messages.find((m: any) => m.role === 'assistant').content.map((b: any) => b.type)).toEqual(['text', 'tool_use']);
  });

  it('断点不落在 thinking 块上(可缓存块是 text/tool_use 一族)', () => {
    const body = openaiToAnthropicBody({
      model: 'claude-x',
      [PROTOCOL_MARK]: 'anthropic-messages',
      thinking: { type: 'enabled', budget_tokens: 4096 },
      messages: [{ role: 'assistant', content: 'ok', providerItems: [{ type: 'thinking', thinking: 'COT', signature: 'SIG' }] }],
    });
    const blocks = body.messages[0].content;
    expect(blocks.map((b: any) => b.type)).toEqual(['thinking', 'text']);
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('流里 signature_delta 拼出可回灌的 thinking 块;没拿到签名的整块丢弃', async () => {
    const ev = (o: any): string => `data: ${JSON.stringify(o)}\n`;
    const sse = [
      ev({ type: 'message_start', message: { usage: { input_tokens: 7, cache_read_input_tokens: 3 } } }),
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'step ' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'two' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } }),
      ev({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } }), // 无签名 → 丢
      ev({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }),
      ev({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'done' } }),
      ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }),
    ].join('');
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }),
      }),
    );
    const res = await streamAnthropicMessages({ apiKey: 'k', baseUrl: 'https://api.anthropic.com', payload: { model: 'claude-x', messages: [] } } as any);
    expect(res.reasoning).toBe('step two');
    expect(res.outputItems).toEqual([{ type: 'thinking', thinking: 'step two', signature: 'SIG' }]);
    expect(res.usage.cached_tokens).toBe(3);
    expect(res.usage.prompt_tokens).toBe(10); // 未缓存 7 + 缓存读 3
  });

  it('上游没报缓存字段 → cached_tokens 保持 undefined(与「报了 0」分开)', async () => {
    const sse =
      `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 5 } } })}\n` +
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })}\n`;
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }),
      }),
    );
    const res = await streamAnthropicMessages({ apiKey: 'k', baseUrl: 'https://api.anthropic.com', payload: { model: 'claude-x', messages: [] } } as any);
    expect(res.usage.cached_tokens).toBeUndefined();
    expect(res.usage.prompt_tokens).toBe(5);
  });
});
