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
});
