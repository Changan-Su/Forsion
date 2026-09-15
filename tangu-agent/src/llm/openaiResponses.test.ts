import { describe, it, expect, afterEach, vi } from 'vitest';
import { openaiToResponsesBody, streamOpenAiResponses, stableSessionUuid } from './openaiResponses.js';
import { ACCOUNT_MARK, RUN_MARK } from './openaiCompat.js';

describe('openaiToResponsesBody', () => {
  it('maps system→instructions, messages→input, tools flattened, tool result→function_call_output', () => {
    const body = openaiToResponsesBody({
      model: 'gpt-5-codex',
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'OUT' },
      ],
      tools: [{ type: 'function', function: { name: 'read', description: 'd', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
    });
    expect(body.instructions).toBe('SYS');
    expect(body.input[0]).toEqual({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] });
    expect(body.input).toContainEqual({ type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' });
    expect(body.input).toContainEqual({ type: 'function_call_output', call_id: 'c1', output: 'OUT' });
    expect(body.tools[0]).toMatchObject({ type: 'function', name: 'read', parameters: { type: 'object' } });
    expect(body.tool_choice).toBe('auto');
    expect(body.store).toBe(false);
  });

  // D1 的另一半:agentLoop 现在无条件把 reasoning_content 挂到本 run 内存里的 assistant 消息上,
  // 这条钉住它绝不随 Responses body 上 wire —— 订阅私有端点见未知字段直接 400。
  it('assistant 的 reasoning_content 不进 body(白名单重建,未知端点绝不发未知字段)', () => {
    const body = openaiToResponsesBody({
      model: 'gpt-5-codex',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'VISIBLE-BODY', reasoning_content: 'COT-SECRET' },
      ],
    });
    // 两条一起才不是空断言:正文进了 body(这条 assistant 确实被转换过),思考没进。
    expect(JSON.stringify(body)).toContain('VISIBLE-BODY');
    expect(JSON.stringify(body)).not.toContain('COT-SECRET');
  });

  it('reasoning_effort → body.reasoning(effort+summary),max_tokens → max_output_tokens(官方直连思考档)', () => {
    const body = openaiToResponsesBody({ model: 'gpt-5.6-luna', messages: [], reasoning_effort: 'medium', max_tokens: 1200 });
    expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
    expect(body.max_output_tokens).toBe(1200);
    const plain = openaiToResponsesBody({ model: 'gpt-5-codex', messages: [] });
    expect(plain.reasoning).toBeUndefined(); // Codex 订阅路径不带 → 逆向契约不动
  });

  it('include encrypted reasoning 无条件发(codex-rs 同款):缺省 effort 服务端仍可能按模型默认思考,门控会让延续性静默失效', () => {
    for (const payload of [
      { model: 'm', messages: [], reasoning_effort: 'high' },
      { model: 'm', messages: [], reasoning_effort: 'none' },
      { model: 'm', messages: [] },
    ]) {
      expect(openaiToResponsesBody(payload).include).toEqual(['reasoning.encrypted_content']);
    }
  });

  it('reasoning_summary=none 关摘要(headless 省输出);verbosity 经 text_verbosity → body.text', () => {
    const noSum = openaiToResponsesBody({ model: 'm', messages: [], reasoning_effort: 'high', reasoning_summary: 'none' });
    expect(noSum.reasoning).toEqual({ effort: 'high' }); // summary 键整个不出现
    const low = openaiToResponsesBody({ model: 'm', messages: [], text_verbosity: 'low' });
    expect(low.text).toEqual({ verbosity: 'low' });
    const plain = openaiToResponsesBody({ model: 'm', messages: [] });
    expect(plain.text).toBeUndefined();
  });

  it('reasoning 延续性:assistant 带 providerItems → 原样回灌,不再由文本重建', () => {
    const items = [
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC' },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
    ];
    const body = openaiToResponsesBody({
      model: 'm',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'reading', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }], providerItems: items },
        { role: 'tool', tool_call_id: 'call_1', content: 'DATA' },
      ],
    });
    expect(body.input[1]).toEqual(items[0]); // reasoning item 原样在位
    expect(body.input[2]).toEqual(items[1]);
    expect(body.input[3]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'DATA' });
    // 不应再出现由文本重建的 assistant message / function_call(会与 items 重复)
    expect(body.input.filter((i: any) => i.type === 'function_call')).toHaveLength(1);
    expect(body.input.some((i: any) => i.type === 'message' && i.role === 'assistant')).toBe(false);
  });

  it('无 providerItems(跨 run 水合的历史)→ 文本重建,优雅降级', () => {
    const body = openaiToResponsesBody({
      model: 'm',
      messages: [{ role: 'assistant', content: 'done', tool_calls: [] }],
    });
    expect(body.input[0]).toEqual({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] });
  });

  it('官方 BYOK(无 accountId)带 body 级 prompt_cache_key;订阅路径不发', () => {
    const byok = openaiToResponsesBody({ model: 'm', messages: [], prompt_cache_key: 'sess-1' });
    expect(byok.prompt_cache_key).toBe('sess-1');
    const sub = openaiToResponsesBody({ model: 'm', messages: [], prompt_cache_key: 'sess-1', [ACCOUNT_MARK]: 'acct' });
    expect(sub.prompt_cache_key).toBeUndefined();
  });

  it('订阅路径不发 max_output_tokens(私有端点 400 "Unsupported parameter"——self_brainstorm 真机首跑三席全灭实证 07-31)', () => {
    const sub = openaiToResponsesBody({ model: 'm', messages: [], max_tokens: 2000, [ACCOUNT_MARK]: 'acct' });
    expect(sub.max_output_tokens).toBeUndefined();
    // 官方 BYOK 不受影响(上方既有用例已断言 1200 在场,这里只守订阅分支)
  });
});

describe('stableSessionUuid(缓存/路由粘性:同会话稳定,不再每请求随机)', () => {
  it('UUID 形状直用(小写化);非 UUID 稳定哈希;空值回退随机', () => {
    const u = '018FAAC3-D278-7DC1-AFD0-C7BEA738F73C';
    expect(stableSessionUuid(u)).toBe(u.toLowerCase());
    const a = stableSessionUuid('sess_abc');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(stableSessionUuid('sess_abc')).toBe(a); // 稳定
    expect(stableSessionUuid('sess_xyz')).not.toBe(a);
    expect(stableSessionUuid(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('streamOpenAiResponses SSE parse', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** 只喂一条 response.completed,取回归一化后的 usage。 */
  const usageOf = async (u: any): Promise<any> => {
    const sse = `data: ${JSON.stringify({ type: 'response.completed', response: { usage: u } })}\n`;
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }),
      }),
    );
    const res = await streamOpenAiResponses({
      apiKey: 'x', baseUrl: 'https://example/codex', payload: { model: 'gpt-5-codex', messages: [] },
    } as any);
    return res.usage;
  };

  // 与 openaiCompat 同一条极性契约:两套协议对「没报 / 报了 0」必须给出同一语义。
  it('reasoning_tokens 极性:上游没报 → 整个键缺席;明确报 0 → 键在且为 0', async () => {
    expect(await usageOf({ input_tokens: 10, output_tokens: 5 })).not.toHaveProperty('reasoning_tokens');
    expect(await usageOf({ input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } }))
      .toHaveProperty('reasoning_tokens', 0);
  });

  it('parses streamed text + function_call into normalized OpenAI shape', async () => {
    const ev = (o: any): string => `data: ${JSON.stringify(o)}\n`;
    const sse = [
      ev({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'read_file', arguments: '' } }),
      ev({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' }),
      ev({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"a.txt"}' }),
      ev({ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC' } }),
      ev({ type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'read_file', arguments: '{"path":"a.txt"}' } }),
      ev({ type: 'response.output_text.delta', delta: 'hello' }),
      ev({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 } } } }),
    ].join('');
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(sse));
            c.close();
          },
        }),
      }),
    );

    const res = await streamOpenAiResponses({
      apiKey: 'x',
      baseUrl: 'https://example/codex',
      payload: { model: 'gpt-5-codex', messages: [], [ACCOUNT_MARK]: 'acct_1' },
    } as any);

    expect(res.content).toBe('hello');
    expect(res.toolCalls).toEqual([{ id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }]);
    expect(res.usage.prompt_tokens).toBe(10);
    expect(res.usage.reasoning_tokens).toBe(3); // 隐藏思考量拆账
    expect(res.finishReason).toBe('tool_calls');
    // 原始 output items 完整带回(reasoning 延续性的原料),顺序保持
    expect(res.outputItems?.map((i: any) => i.type)).toEqual(['reasoning', 'function_call']);
    expect(res.outputItems?.[0].encrypted_content).toBe('ENC');
  });

  it('Codex 逆向头只在订阅路径(accountId)发;官方 BYOK 纯 Bearer——OpenAI-Beta 头会静默压掉 reasoning summary(实测 0 vs 160 条)', async () => {
    const sse = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n';
    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal('fetch', (_url: any, init: any) => {
      seen.push(init.headers);
      return Promise.resolve({
        ok: true,
        body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }),
      });
    });

    await streamOpenAiResponses({ apiKey: 'x', baseUrl: 'https://api.openai.com/v1', payload: { model: 'gpt-5.6-luna', messages: [] } } as any);
    await streamOpenAiResponses({ apiKey: 'x', baseUrl: 'https://chatgpt.com/backend-api/codex', payload: { model: 'gpt-5-codex', messages: [], [ACCOUNT_MARK]: 'acct_1' } } as any);

    expect(seen[0]['OpenAI-Beta']).toBeUndefined();
    expect(seen[0].originator).toBeUndefined();
    expect(seen[0]['chatgpt-account-id']).toBeUndefined();
    expect(seen[1]['OpenAI-Beta']).toBe('responses=experimental');
    expect(seen[1]['chatgpt-account-id']).toBe('acct_1');
  });

  it('response.incomplete(输出截断)归一化为 finishReason=length——半截函数参数不得伪装成 tool_calls 被执行', async () => {
    const sse = [
      'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc1","call_id":"call_1","name":"write_file","arguments":""}}',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc1","delta":"{\\"path\\":\\"a.txt\\",\\"content\\":\\"半截"}',
      'data: {"type":"response.incomplete","response":{"usage":{"input_tokens":5,"output_tokens":99},"incomplete_details":{"reason":"max_output_tokens"}}}',
      '',
    ].join('\n');
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }),
      }),
    );
    const res = await streamOpenAiResponses({ apiKey: 'x', baseUrl: 'https://api.openai.com/v1', payload: { model: 'gpt-5.6-luna', messages: [] } } as any);
    expect(res.finishReason).toBe('length');
    expect(res.toolCalls.length).toBe(1); // 调用保留(供 loop 置错回喂),但绝不能报 tool_calls
  });
});

// ── B4①(C-6):Codex 后端的粘性路由态 x-codex-turn-state ───────────────────────
describe('x-codex-turn-state 回带(TANGU_CODEX_TURN_STATE)', () => {
  const OLD = process.env.TANGU_CODEX_TURN_STATE;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (OLD === undefined) delete process.env.TANGU_CODEX_TURN_STATE;
    else process.env.TANGU_CODEX_TURN_STATE = OLD;
  });

  const SSE = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n';
  const stubFetch = (seen: Array<Record<string, string>>, turnState: string | null = 'TS-1') =>
    vi.stubGlobal('fetch', (_u: any, init: any) => {
      seen.push(init.headers);
      return Promise.resolve({
        ok: true,
        headers: new Headers(turnState ? { 'x-codex-turn-state': turnState } : {}),
        body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(SSE)); c.close(); } }),
      });
    });
  const call = (runId?: string, accountId: string | null = 'acct_1') =>
    streamOpenAiResponses({
      apiKey: 'x', baseUrl: 'https://chatgpt.com/backend-api/codex',
      payload: {
        model: 'gpt-5-codex', messages: [],
        ...(accountId ? { [ACCOUNT_MARK]: accountId } : {}),
        ...(runId ? { [RUN_MARK]: runId } : {}),
      },
    } as any);

  it('闸开:同 run 的后续请求回带,换一个 run 不带(跨 run 回带 = 把别人的路由态贴上去)', async () => {
    process.env.TANGU_CODEX_TURN_STATE = '1';
    const seen: Array<Record<string, string>> = [];
    stubFetch(seen);
    await call('run-A');
    await call('run-A');
    await call('run-B');
    await call('run-A');
    expect(seen[0]['x-codex-turn-state']).toBeUndefined(); // 首请求无从回带
    expect(seen[1]['x-codex-turn-state']).toBe('TS-1');
    expect(seen[2]['x-codex-turn-state']).toBeUndefined(); // 新 run:不继承
    expect(seen[3]['x-codex-turn-state']).toBe('TS-1');
  });

  it('闸关(缺省)一次都不回带', async () => {
    // 显式清掉实验变量:测试进程若本来就带着 TANGU_CODEX_TURN_STATE=1 启动,这条用例实际测的是
    // 「闸开」并会红(评审 #11)。还原交给本 describe 的 afterEach(它按 OLD 逐字恢复)。
    delete process.env.TANGU_CODEX_TURN_STATE;
    const seen: Array<Record<string, string>> = [];
    stubFetch(seen);
    await call('run-C');
    await call('run-C');
    expect(seen[1]['x-codex-turn-state']).toBeUndefined();
  });

  it('没有 run 身份时不回带(宁可测不出,不串 run)', async () => {
    process.env.TANGU_CODEX_TURN_STATE = '1';
    const seen: Array<Record<string, string>> = [];
    stubFetch(seen);
    await call(undefined);
    await call(undefined);
    expect(seen[1]['x-codex-turn-state']).toBeUndefined();
  });

  it('上游根本没给这个头 → 无可回带(报表据此把「不存在」与「无效果」分开)', async () => {
    process.env.TANGU_CODEX_TURN_STATE = '1';
    const seen: Array<Record<string, string>> = [];
    stubFetch(seen, null);
    await call('run-D');
    await call('run-D');
    expect(seen[1]['x-codex-turn-state']).toBeUndefined();
  });
});
