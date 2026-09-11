import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTanguProfile } from '../profiles/tangu.js';
import type { ToolContext } from './toolTypes.js';
import { withWriteLock } from './writeLock.js';
import { DockerCleanupError } from '../sandbox/dockerLifecycle.js';

const effects = vi.hoisted(() => ({ snapshot: vi.fn(), activity: vi.fn() }));
vi.mock('../services/checkpoints.js', () => ({ snapshotBeforeWrite: effects.snapshot, recordPostWrite: vi.fn() }));
vi.mock('../services/userActivity.js', () => ({ appendActivityLine: effects.activity }));
import { executeTool } from './registry.js';

const call = { id: 'write1', type: 'function' as const, function: { name: 'write_file', arguments: '{"path":"audit.txt","content":"test"}' } };
function context(execute: (args: any, ctx: ToolContext) => Promise<string> | string, signal?: AbortSignal, timeoutMs = 1000): ToolContext {
  const profile = createTanguProfile({ sandboxMode: 'none' });
  profile.toolLoadout.providers = [{ id: 'cancellation-test', tools: () => [{
    name: 'write_file', mode: 'host', capabilities: { sideEffect: 'write', defaultTimeoutMs: timeoutMs },
    definition: { type: 'function', function: { name: 'write_file', description: '', parameters: {} } }, execute,
  }] }];
  return { userId: 'u', appId: 'tangu', sessionId: 's', runId: 'r', cwd: '/tmp', execMode: 'host',
    profile, signal, hostSandbox: { mode: 'off', network: 'deny' } } as ToolContext;
}

beforeEach(() => { vi.clearAllMocks(); effects.snapshot.mockResolvedValue(null); });

describe('tool cancellation lifecycle', () => {
  it('propagates unconfirmed Docker cleanup after cancellation without rolling back into a live mount', async () => {
    const ac = new AbortController();
    const undo = vi.fn();
    effects.snapshot.mockResolvedValueOnce(undo);
    const error = new DockerCleanupError('still-running', 'daemon unavailable');
    await expect(executeTool(call, context(() => { ac.abort(); throw error; }, ac.signal))).rejects.toBe(error);
    expect(undo).not.toHaveBeenCalled();
  });

  it('never starts an already cancelled tool, including implementations that ignore signals', async () => {
    const ac = new AbortController(); ac.abort();
    const execute = vi.fn(() => 'should never run');
    await expect(executeTool(call, context(execute, ac.signal))).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
    expect(effects.snapshot).not.toHaveBeenCalled();
  });

  it('a tool cancelled while waiting for the write lock does not revive when the lock opens', async () => {
    let release!: () => void;
    const held = withWriteLock(() => new Promise<void>((resolve) => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const ac = new AbortController();
    const execute = vi.fn(() => 'should never run');
    const pending = executeTool(call, context(execute, ac.signal));
    ac.abort();
    release();
    await held;
    expect((await pending).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(effects.snapshot).not.toHaveBeenCalled();
  });

  it('checks cancellation again after an asynchronous write checkpoint', async () => {
    const ac = new AbortController();
    effects.snapshot.mockImplementationOnce(async () => { ac.abort(); return null; });
    const execute = vi.fn(() => 'should never run');
    expect((await executeTool(call, context(execute, ac.signal))).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps the write lock until a non-cooperative timed-out operation actually settles', async () => {
    let release!: (value: string) => void;
    let scopedSignal: AbortSignal | undefined;
    let completed = false;
    const first = executeTool(call, context((_args, ctx) => {
      scopedSignal = ctx.signal;
      return new Promise<string>((resolve) => { release = resolve; });
    }, undefined, 30)).then((r) => { completed = true; return r; });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const secondExecute = vi.fn(() => 'second completed');
    const second = executeTool({ ...call, id: 'write2' }, context(secondExecute));
    try {
      await vi.waitFor(() => expect(scopedSignal?.aborted).toBe(true));
      expect(completed).toBe(false); // deadline 没有 Promise.race 掩盖仍在执行的副作用。
      expect(secondExecute).not.toHaveBeenCalled();
    } finally { release('first actually completed'); }
    await first;
    expect((await second).isError).toBe(false);
    expect(secondExecute).toHaveBeenCalledOnce();
  });
});
