import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { streamOpenAiCompat } from '../src/llm/openaiCompat.js';
import { streamAnthropicMessages } from '../src/llm/anthropicMessages.js';
import { streamOpenAiResponses } from '../src/llm/openaiResponses.js';
import { createHttpBrain } from '../src/adapters/standalone/httpBrain.js';
import type { StreamOpts, StreamResult } from '../src/seams/cloudBrain.js';

const frame = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`;
const directBudget = Number(process.env.TANGU_STREAM_IDLE_TIMEOUT_MS) || 120_000;
const protocols: Array<{
  name: string;
  budget: number;
  run(opts: StreamOpts): Promise<StreamResult>;
  idle: unknown[];
  reasoning: unknown;
  startTool: unknown;
  toolDelta: unknown;
}> = [
  {
    name: 'OpenAI chat', budget: directBudget, run: streamOpenAiCompat,
    idle: [{ choices: [{ delta: { role: 'assistant' } }] }, { choices: [{ delta: { reasoning_content: '', tool_calls: [] } }] }],
    reasoning: { choices: [{ delta: { reasoning_content: '思考中' } }] },
    startTool: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '' } }] } }] },
    toolDelta: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' ' } }] } }] },
  },
  {
    name: 'Anthropic messages', budget: directBudget, run: streamAnthropicMessages,
    idle: [{ type: 'ping' }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } }],
    reasoning: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '思考中' } },
    startTool: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'search' } },
    toolDelta: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ' ' } },
  },
  {
    name: 'OpenAI responses', budget: directBudget, run: streamOpenAiResponses,
    idle: [{ type: 'response.in_progress' }, { type: 'response.output_text.delta', delta: '' }],
    reasoning: { type: 'response.reasoning_summary_text.delta', delta: '思考中' },
    startTool: { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'search', arguments: '' } },
    toolDelta: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: ' ' },
  },
  {
    name: 'hosted brain', budget: 300_000,
    run: (opts) => createHttpBrain({ cloudUrl: 'https://cloud.test', token: 't' }).llm.streamProviderCompletion(opts),
    idle: [{ t: 'alive' }, { t: 'waiting' }, { t: 'token', d: '' }, { t: 'reasoning', d: '' }, { t: 'unknown' }],
    reasoning: { t: 'reasoning', d: '思考中' },
    startTool: { t: 'tool', id: 'call_1', name: 'search', argsLen: 0, args: '', argsDelta: '' },
    toolDelta: { t: 'tool', id: 'call_1', name: 'search', argsLen: 1, argsDelta: ' ' },
  },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('TANGU_BRAIN_STREAM_IDLE_MS', '300000');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** Intentionally ignores fetch's signal: guard must cancel the pending read itself. */
function controlledResponse(cancelWaitsForever = false) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn(() => cancelWaitsForever ? new Promise<void>(() => {}) : undefined);
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
  return {
    body, cancel,
    send: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    close: () => controller.close(),
  };
}

const opts = (extra: Partial<StreamOpts> = {}): StreamOpts => ({
  apiKey: 'test', baseUrl: 'https://provider.test/v1',
  payload: { model: 'test', messages: [], __forsion_model_id: 'test' }, ...extra,
} as StreamOpts);

describe.each(protocols)('$name semantic stream watchdog', (protocol) => {
  it('continuous ping, malformed data and empty events time out at the semantic budget', async () => {
    const response = controlledResponse();
    const running = protocol.run(opts());
    const outcome = expect(running).rejects.toMatchObject({ status: 504, message: 'stream progress idle timeout' });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i++) {
      response.send(`: ping\n\ndata: invalid-json\n\n${protocol.idle.map(frame).join('')}`);
      await vi.advanceTimersByTimeAsync(protocol.budget / 5);
    }
    await outcome;
    expect(response.cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['reasoning', 'tool'] as const)('%s deltas renew the budget even with no visible answer', async (kind) => {
    const response = controlledResponse();
    const onReasoning = vi.fn();
    const onToolCallDelta = vi.fn();
    const running = protocol.run(opts({ onReasoning, onToolCallDelta }));
    await vi.advanceTimersByTimeAsync(0);
    if (kind === 'tool') response.send(frame(protocol.startTool));
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(protocol.budget * 0.75);
      response.send(frame(kind === 'reasoning' ? protocol.reasoning : protocol.toolDelta));
      await vi.advanceTimersByTimeAsync(0);
    }
    response.close();
    const result = await running;
    expect(result.content).toBe('');
    expect(kind === 'reasoning' ? onReasoning : onToolCallDelta).toHaveBeenCalled();
    expect(response.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('repeated identical tool metadata without arguments cannot renew indefinitely', async () => {
    const response = controlledResponse();
    const running = protocol.run(opts());
    const outcome = expect(running).rejects.toMatchObject({ status: 504, message: 'stream progress idle timeout' });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i++) {
      response.send(frame(protocol.startTool));
      await vi.advanceTimersByTimeAsync(protocol.budget / 5);
    }
    await outcome;
    expect(response.body.locked).toBe(false);
  });

  it('user abort cancels and releases a stalled reader without waiting for its cancel hook', async () => {
    const response = controlledResponse(true);
    const external = new AbortController();
    const running = protocol.run(opts({ signal: external.signal }));
    const outcome = expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    expect(response.body.locked).toBe(true);
    external.abort(new Error('user stop'));
    await outcome;
    expect(response.cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
