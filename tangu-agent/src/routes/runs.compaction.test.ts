import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
vi.mock('../services/agentLoop.js', () => ({
  enqueueRun: vi.fn(), abortRun: vi.fn(), enqueueSteer: vi.fn(), expediteSteer: vi.fn(), cancelSteer: vi.fn(), waitForRunSettlement: vi.fn(),
}));
import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import runsRouter from './runs.js';
import { releaseRunCompaction, runCompactionOperation } from '../services/runCompaction.js';
let server: Server; let base: string;
const unexpected = new Proxy({}, { get: () => () => { throw new Error('unexpected dependency'); } }) as any;
beforeAll(() => {
  configureTangu({
    host: { ...unexpected, authMiddleware: (req: any, _res: any, next: any) => { req.user = { userId: String(req.headers.authorization).slice(7) }; next(); } } as any,
    brain: unexpected, billing: unexpected, profile: createTanguProfile({ sandboxMode: 'none' }),
    state: { getRunForUser: async (id: string, user: string) => id === 'run' && user === 'owner' ? { id } : null } as any,
  });
  const app = express(); app.use(express.json()); app.use(runsRouter); server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => { server?.close(); });
afterEach(() => releaseRunCompaction('run'));
async function send(user: string, operationId: unknown) {
  const res = await fetch(`${base}/agent/runs/run/compaction/skip`, { method: 'POST', headers: { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId }) });
  return { status: res.status, body: await res.json() };
}
async function active(reason: 'idle' | 'threshold' = 'idle') {
  let id = ''; let ready!: () => void; let finish!: (text: string) => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const result = new Promise<string>(resolve => { finish = resolve; });
  const events: Record<string, unknown>[] = [];
  const run = runCompactionOperation({ runId: 'run', reason, signal: new AbortController().signal, iteration: 0, idleMinutes: 60,
    publish: async e => { events.push(e); id = String(e.operationId); }, prepare: async () => { ready(); return result; }, commit: async () => ({ phase: 'compacted', changed: true }) });
  await started; return { id, run, finish, events };
}
describe('POST /agent/runs/:id/compaction/skip ownership and operation contract', () => {
  it('foreign users and stale operations cannot cancel; the owner can skip exactly that summary', async () => {
    const f = await active();
    expect((await send('other', f.id)).status).toBe(404);
    expect(await send('owner', 'stale')).toMatchObject({ status: 409, body: { ok: false, reason: 'stale_operation' } });
    expect(f.events.map(e => e.phase)).toEqual(['compacting']);
    expect(await send('owner', f.id)).toMatchObject({ status: 200, body: { ok: true, status: 'skipped', operationId: f.id } });
    expect(await f.run).toBe(false);
    expect((await send('owner', f.id)).body.ok).toBe(true);
    f.finish('late');
  });
  it('rejects malformed ids and keeps mandatory compaction running', async () => {
    const f = await active('threshold');
    expect((await send('owner', {})).status).toBe(400);
    expect(await send('owner', f.id)).toMatchObject({ status: 409, body: { ok: false, reason: 'required' } });
    f.finish('summary'); expect(await f.run).toBe(true);
  });
});
