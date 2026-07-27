import { describe, it, expect, afterEach, vi } from 'vitest';
import { openaiToResponsesBody, streamOpenAiResponses } from './openaiResponses.js';
import { ACCOUNT_MARK } from './openaiCompat.js';

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

  it('reasoning_effort → body.reasoning(effort+summary),max_tokens → max_output_tokens(官方直连思考档)', () => {
    const body = openaiToResponsesBody({ model: 'gpt-5.6-luna', messages: [], reasoning_effort: 'medium', max_tokens: 1200 });
    expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
    expect(body.max_output_tokens).toBe(1200);
    const plain = openaiToResponsesBody({ model: 'gpt-5-codex', messages: [] });
    expect(plain.reasoning).toBeUndefined(); // Codex 订阅路径不带 → 逆向契约不动
  });
});

describe('streamOpenAiResponses SSE parse', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('parses streamed text + function_call into normalized OpenAI shape', async () => {
    const ev = (o: any): string => `data: ${JSON.stringify(o)}\n`;
    const sse = [
      ev({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'read_file', arguments: '' } }),
      ev({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' }),
      ev({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"a.txt"}' }),
      ev({ type: 'response.output_text.delta', delta: 'hello' }),
      ev({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } }),
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
    expect(res.finishReason).toBe('tool_calls');
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
