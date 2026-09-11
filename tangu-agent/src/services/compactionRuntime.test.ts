import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../core/types.js';

const fake = vi.hoisted(() => ({ query: vi.fn(), resolve: vi.fn(), build: vi.fn(), stream: vi.fn() }));
vi.mock('../core/db.js', () => ({ query: fake.query }));
vi.mock('../seams/runtime.js', () => ({ deps: () => ({ brain: { llm: {
  resolveModelAndKey: fake.resolve, buildProviderPayload: fake.build, streamProviderCompletion: fake.stream,
} } }) }));
import { compactWorkingMessages, compactSession } from './compaction.js';

const message = (role: string, content: string): ChatMessage => ({ role, content }) as ChatMessage;
function history(): ChatMessage[] {
  return [message('system', 'stable developer instructions'), message('user', 'ORIGINAL_GOAL'),
    { role: 'assistant', content: 'Changed the parser', tool_calls: [
      { id: 'edit1', type: 'function', function: { name: 'edit_file', arguments: '{"path":"src/parser.ts"}' } },
    ] } as any,
    { role: 'tool', tool_call_id: 'edit1', content: 'CURRENT_RUN_EVIDENCE: failing test expects a colon' } as any,
    ...Array.from({ length: 20 }, (_, i) => message(i % 2 ? 'assistant' : 'user', `recent ${i}`))];
}

beforeEach(() => {
  vi.resetAllMocks();
  fake.resolve.mockResolvedValue({ model: {}, apiKey: 'test', baseUrl: 'test', apiModelId: 'test' });
  fake.build.mockImplementation(async (opts) => opts);
  fake.stream.mockResolvedValue({ content: '## Goal\nContinue fixing the parser; keep the failing test evidence.' });
});

describe('current working context compaction', () => {
  it('summarizes current tools and the full replaced prefix without advancing persisted history', async () => {
    const msgs = history();
    // 超過旧 60k 尾截断：目标和本轮早期工具证据仍必须完整进入摘要输入。
    msgs.splice(4, 0, message('assistant', 'x'.repeat(65_000)));
    const stable = msgs[0];
    const tail = msgs.slice(-12);
    const ac = new AbortController();
    const result = await compactWorkingMessages(msgs, 'm', 'tangu', ac.signal);
    expect(result.ok).toBe(true);
    const transcript = fake.build.mock.calls[0][0].messages[1].content;
    expect(transcript).toContain('ORIGINAL_GOAL');
    expect(transcript).toContain('CURRENT_RUN_EVIDENCE');
    expect(transcript).toContain('edit_file');
    expect(transcript).not.toContain('recent 19'); // 尾部不删除,也不重复总结。
    expect(transcript.length).toBeGreaterThan(65_000);
    expect(msgs[0]).toBe(stable);
    expect(msgs.slice(-12)).toEqual(tail);
    expect(msgs[1].content).toContain('<modified-files>\nsrc/parser.ts');
    expect(fake.build.mock.calls[0][0].signal).toBe(ac.signal);
    expect(fake.stream.mock.calls[0][0].signal).toBe(ac.signal);
    expect(result).not.toHaveProperty('throughTimestamp');
    expect(fake.query).not.toHaveBeenCalled();
  });

  it('keeps a tool call and all its results together at the retained-tail boundary', async () => {
    const msgs = history();
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: 'a' }, { id: 'b' }] } as any,
      { role: 'tool', tool_call_id: 'a', content: 'a result' } as any,
      { role: 'tool', tool_call_id: 'b', content: 'b result' } as any, message('assistant', 'next'));
    await compactWorkingMessages(msgs, 'm', 'tangu', undefined, 2);
    const firstTool = msgs.findIndex((m) => m.role === 'tool');
    expect((msgs[firstTool - 1] as any).tool_calls).toHaveLength(2);
    expect(msgs.slice(firstTool).map((m: any) => m.tool_call_id)).toEqual(['a', 'b', undefined]);
  });

  it('updates a previous in-memory summary instead of accumulating old checkpoints', async () => {
    const msgs = history();
    msgs.splice(1, 0, message('system', '## Compacted Summary of Earlier Conversation\nEarlier decision\n\n<file-operations>\n<modified-files>\nsrc/old.ts\n</modified-files>\n</file-operations>'));
    await compactWorkingMessages(msgs, 'm');
    expect(fake.build.mock.calls[0][0].messages[1].content).toContain('Earlier decision');
    expect(msgs.filter((m) => String(m.content).startsWith('## Compacted Summary'))).toHaveLength(1);
    expect(msgs[1].content).toContain('src/old.ts');
    expect(msgs[1].content).toContain('src/parser.ts');
  });

  it('propagates cancellation to the stream and leaves the original context intact', async () => {
    fake.stream.mockImplementation(({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const msgs = history();
    const original = structuredClone(msgs);
    const ac = new AbortController();
    const running = compactWorkingMessages(msgs, 'm', 'tangu', ac.signal);
    const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fake.stream).toHaveBeenCalledOnce());
    ac.abort();
    await rejected;
    expect(msgs).toEqual(original);
    expect(fake.query).not.toHaveBeenCalled();
  });

  it('does not start compaction for an already stopped run', async () => {
    const ac = new AbortController(); ac.abort();
    await expect(compactWorkingMessages(history(), 'm', 'tangu', ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.resolve).not.toHaveBeenCalled();
  });

  it('does not continue after a cancelled resolve or overwrite a changed working snapshot', async () => {
    const ac = new AbortController();
    fake.resolve.mockImplementationOnce(async () => { ac.abort(); return { model: {}, apiKey: '', baseUrl: '', apiModelId: '' }; });
    await expect(compactWorkingMessages(history(), 'm', 'tangu', ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.build).not.toHaveBeenCalled();

    const msgs = history();
    fake.stream.mockImplementationOnce(async () => { msgs[1].content = 'NEW USER REQUIREMENT'; return { content: 'summary is now stale' }; });
    const result = await compactWorkingMessages(msgs, 'm');
    expect(result).toMatchObject({ ok: false, reason: 'working context changed during compaction' });
    expect(msgs[1].content).toBe('NEW USER REQUIREMENT');
    expect(msgs).toHaveLength(24);
  });

  it('does not write a persisted checkpoint after cancellation during summary generation', async () => {
    fake.query.mockResolvedValueOnce([
      { role: 'user', content: 'question', timestamp: 1 }, { role: 'assistant', content: 'answer', timestamp: 2 },
    ]).mockResolvedValueOnce([]);
    const ac = new AbortController();
    fake.stream.mockImplementationOnce(async () => { ac.abort(); return { content: 'stale persisted summary' }; });
    await expect(compactSession('s', 'm', 'tangu', ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.query).toHaveBeenCalledTimes(2);
    expect(fake.query.mock.calls.every(([sql]) => String(sql).startsWith('SELECT'))).toBe(true);
  });
});
