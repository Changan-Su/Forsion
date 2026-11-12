import { afterEach, describe, expect, it, vi } from 'vitest';
import { releaseRunCompaction, runCompactionOperation, skipRunCompaction, type RunCompactionReason } from './runCompaction.js';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
afterEach(() => releaseRunCompaction('r'));
function fixture(reason: RunCompactionReason = 'idle') {
  const parent = new AbortController(); const prepared = deferred<string>(); const started = deferred<void>();
  const events: Record<string, unknown>[] = []; const writes: string[] = []; let signal!: AbortSignal;
  const commit = vi.fn(async (text: string) => { writes.push(text); return { phase: 'compacted' as const, changed: true }; });
  const run = runCompactionOperation({ runId: 'r', reason, signal: parent.signal, iteration: 0, idleMinutes: 60,
    publish: async (event) => { events.push(event); }, prepare: (s) => { signal = s; started.resolve(); return prepared.promise; }, commit });
  return { parent, prepared, started: started.promise, events, writes, commit, run, signal: () => signal, id: () => String(events[0].operationId) };
}
describe('run summary lifecycle', () => {
  it('publishes start before the summary provider, then completes once', async () => {
    const f = fixture(); await f.started;
    expect(f.events).toMatchObject([{ phase: 'compacting', skippable: true, reason: 'idle' }]);
    f.prepared.resolve('summary'); expect(await f.run).toBe(true);
    expect(f.events.map(e => e.phase)).toEqual(['compacting', 'compacted']); expect(f.writes).toEqual(['summary']);
  });
  it('skip resumes even if provider ignores abort; late output cannot commit', async () => {
    const f = fixture(); await f.started;
    expect(skipRunCompaction('r', f.id())).toMatchObject({ ok: true, status: 'skipped' });
    expect(skipRunCompaction('r', f.id())).toMatchObject({ ok: true, status: 'skipped' });
    expect(f.signal().aborted).toBe(true); expect(f.parent.signal.aborted).toBe(false); expect(await f.run).toBe(false);
    f.prepared.resolve('late summary'); await Promise.resolve(); await Promise.resolve();
    expect(f.commit).not.toHaveBeenCalled(); expect(f.events.map(e => e.phase)).toEqual(['compacting', 'compaction_skipped']);
  });
  it.each(['threshold', 'overflow'] as const)('rejects skipping mandatory %s compaction', async (reason) => {
    const f = fixture(reason); await f.started; expect(skipRunCompaction('r', f.id())).toMatchObject({ ok: false, reason: 'required' });
    expect(f.signal().aborted).toBe(false); f.prepared.resolve('fits'); await f.run; expect(f.writes).toEqual(['fits']);
  });
  it('completion claims the operation before checkpoint writing; skip cannot roll it back', async () => {
    const f = fixture(); const writing = deferred<void>(); const entered = deferred<void>();
    f.commit.mockImplementation(async (text) => { entered.resolve(); await writing.promise; f.writes.push(text); return { phase: 'compacted', changed: true }; });
    await f.started; f.prepared.resolve('summary'); await entered.promise;
    expect(skipRunCompaction('r', f.id())).toMatchObject({ ok: false, status: 'committing' });
    writing.resolve(); expect(await f.run).toBe(true); expect(f.writes).toEqual(['summary']);
  });
  it('parent stop aborts the run and summary; never acts like skip', async () => {
    const f = fixture(); await f.started; f.parent.abort(); await expect(f.run).rejects.toMatchObject({ name: 'AbortError' });
    f.prepared.resolve('late'); await Promise.resolve(); expect(f.commit).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toMatchObject({ phase: 'compaction_failed', aborted: true });
  });
  it('stale ids cannot cancel newer work; skip before preparation starts no provider', async () => {
    const call = vi.fn(); const events: Record<string, unknown>[] = [];
    const result = await runCompactionOperation({ runId: 'r', reason: 'idle', signal: new AbortController().signal, idleMinutes: 60, iteration: 0,
      publish: async (e) => { events.push(e); if(e.phase === 'compacting') { expect(skipRunCompaction('r', 'old').reason).toBe('stale_operation'); skipRunCompaction('r', String(e.operationId)); } },
      prepare: call, commit: async () => ({ phase: 'compacted', changed: true }) });
    expect(result).toBe(false); expect(call).not.toHaveBeenCalled(); expect(events.at(-1)?.phase).toBe('compaction_skipped');
  });
  it('does not replace a chosen terminal outcome when event publication fails', async () => {
    const events: string[] = [];
    const run = runCompactionOperation({ runId: 'r', reason: 'idle', signal: new AbortController().signal, idleMinutes: 60, iteration: 0,
      publish: async (e) => { events.push(String(e.phase)); if (e.phase === 'compacted') throw new Error('transport'); },
      prepare: async () => 'summary', commit: async () => ({ phase: 'compacted', changed: true }) });
    await expect(run).rejects.toThrow('transport');
    expect(events).toEqual(['compacting', 'compacted']);
  });

});
