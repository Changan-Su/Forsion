/** 常驻进程这条路(residentAcp.ts)的收尾与重连:对面是内存里一个照 DSH 的样子说话的假 agent(按行收发 JSON-RPC)。
 *  真 DSH 的同一套在 scripts/dsh-engine.check.mjs 的 resident* 场景(本机跑,要装官方包)。 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 取消的时限在模块加载时读:先设小,再动态加载
process.env.TANGU_RESIDENT_CANCEL_GRACE_MS = '120';
let mod: typeof import('./residentAcp.js');
let hosts: typeof import('./residentHosts.js');
beforeAll(async () => {
  mod = await import('./residentAcp.js');
  hosts = await import('./residentHosts.js');
});
afterEach(() => { mod.resetResidentLinksForTest(); vi.restoreAllMocks(); });

const cwd = mkdtempSync(path.join(tmpdir(), 'resident-acp-'));
const until = async (f: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

function fakeAgent(opts: { newSessionDelayMs?: number; promptNeverEnds?: boolean } = {}) {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const calls: string[] = [];
  let n = 0;
  let buf = '';
  const send = (o: unknown): void => { fromAgent.write(JSON.stringify(o) + '\n'); };
  const handle = (m: any): void => {
    if (!m.method) return;
    calls.push(m.method);
    const ok = (result: unknown): void => send({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') return ok({ protocolVersion: 1, agentInfo: { name: 'fake-resident', version: '0' }, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } });
    if (m.method === 'session/new') { setTimeout(() => ok({ sessionId: `s${++n}` }), opts.newSessionDelayMs ?? 0); return; }
    if (m.method === 'session/prompt') { if (!opts.promptNeverEnds) ok({ stopReason: 'end_turn' }); return; }
    if (m.id !== undefined) ok({}); // session/close 等;session/cancel 是通知,不回
  };
  toAgent.on('data', (d) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); }
  });
  return { conn: { id: 'c1', input: toAgent, output: fromAgent, closed: new Promise<void>(() => {}) }, calls };
}

const def = { id: 'dsh', name: 'DSH' } as any;
const runCtx = (signal: AbortSignal): any => ({
  engineId: 'dsh', runId: 'r1', sessionId: 'forsion-1', userId: 'u1', message: 'hello', cwd, signal,
  publish: () => {}, requestApproval: async () => ({ approved: false }),
});

describe('resident ACP link', () => {
  it('a stop that comes while the session is still being set up never sends the prompt', async () => {
    const fa = fakeAgent({ newSessionDelayMs: 150 });
    const link = await mod.ResidentLink.open('e-setup', fa.conn as any);
    const ac = new AbortController();
    const turn = link.run(def, runCtx(ac.signal));
    setTimeout(() => ac.abort(), 30);
    await expect(turn).rejects.toThrow(/Stopped/);
    expect(fa.calls).toContain('session/new');
    expect(fa.calls).not.toContain('session/prompt');
  });

  it('a stop the engine never finishes ends the turn after the grace period and closes that session', async () => {
    const fa = fakeAgent({ promptNeverEnds: true });
    const link = await mod.ResidentLink.open('e-stuck', fa.conn as any);
    const ac = new AbortController();
    const turn = link.run(def, runCtx(ac.signal));
    await until(() => fa.calls.includes('session/prompt'));
    expect(link.isOpen('s1')).toBe(true);
    ac.abort();
    await expect(turn).rejects.toThrow(/did not stop this turn in time/);
    expect(fa.calls).toContain('session/cancel');
    await until(() => fa.calls.some((c) => c.endsWith('session/close')));
    expect(link.isOpen('s1')).toBe(false);
  });

  it('after a restart, two turns arriving together connect once and share the link', async () => {
    let connects = 0;
    const off = hosts.registerResidentEngineHost('test', {
      engineId: 'e-race',
      connect: async () => ({ id: `c${++connects}`, input: new PassThrough(), output: new PassThrough(), closed: new Promise<void>(() => {}) }),
    });
    const open = vi.spyOn(mod.ResidentLink, 'open').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { closed: false } as any;
    });
    try {
      const first = await mod.acquireResident('e-race');
      expect(open).toHaveBeenCalledTimes(1);
      (first as any).closed = true; // 进程重启过
      const [a, b] = await Promise.all([mod.acquireResident('e-race'), mod.acquireResident('e-race')]);
      expect(open).toHaveBeenCalledTimes(2);
      expect(a).toBe(b);
      expect(connects).toBe(2);
    } finally { off(); }
  });
});
