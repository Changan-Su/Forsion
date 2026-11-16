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

function fakeAgent(opts: { newSessionDelayMs?: number; promptNeverEnds?: boolean; promptDelayMs?: number; onPrompt?: (send: (o: unknown) => void, sessionId: string) => void } = {}) {
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
    if (m.method === 'session/prompt') {
      opts.onPrompt?.(send, m.params.sessionId);
      if (!opts.promptNeverEnds) setTimeout(() => ok({ stopReason: 'end_turn' }), opts.promptDelayMs ?? (opts.onPrompt ? 30 : 0));
      return;
    }
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

  it('the engine\'s "waiting in the workbench" notice reaches the turn Forsion is running on that session; malformed or unrouted ones do not', async () => {
    const notice = { id: 'dsh-approval-A1', kind: 'approval-elsewhere', text: { zh: 'DSH 在工作台里等你批准', en: 'DSH is waiting for your approval in the workbench' }, action: { id: 'open-in-workbench', label: { zh: '打开工作台', en: 'Open the workbench' } } };
    const fa = fakeAgent({
      onPrompt: (send, sessionId) => {
        send({ jsonrpc: '2.0', method: '_forsion/notice', params: { sessionId: 'not-open', ...notice } }); // 没人在等的会话:丢
        send({ jsonrpc: '2.0', method: '_forsion/notice', params: { sessionId, id: 'bad id with spaces', text: { zh: 'x' } } }); // 形状不对:丢
        send({ jsonrpc: '2.0', method: '_forsion/notice', params: { sessionId, ...notice } });
        send({ jsonrpc: '2.0', method: '_forsion/notice', params: { sessionId, id: notice.id, clear: true } });
      },
    });
    const link = await mod.ResidentLink.open('e-notice', fa.conn as any);
    const published: Array<[string, any]> = [];
    const ctx = { ...runCtx(new AbortController().signal), publish: (t: string, p: any) => published.push([t, p]) };
    await link.run(def, ctx);
    const notices = published.filter(([t, p]) => t === 'status' && p.phase === 'engine_notice').map(([, p]) => p.notice);
    expect(notices).toEqual([
      { id: notice.id, text: notice.text, action: notice.action },
      { id: notice.id, clear: true },
    ]);
  });

  it('while DSH says the approval is waiting in the workbench, the idle watchdog does not cancel the turn; it runs again once cleared', async () => {
    const prev = process.env.TANGU_ENGINE_IDLE_TIMEOUT_MS;
    process.env.TANGU_ENGINE_IDLE_TIMEOUT_MS = '200';
    try {
      const notice = { id: 'dsh-approval-A1', text: { zh: 'DSH 在工作台里等你批准', en: 'DSH is waiting for your approval in the workbench' } };
      // 用户在工作台里批了 500ms(远超 200ms 的空闲上限),撤掉提示后引擎马上答完(撤掉后看门狗重新起表,离到点还有 200ms)
      const fa = fakeAgent({
        promptDelayMs: 520,
        onPrompt: (send, sessionId) => {
          send({ jsonrpc: '2.0', method: '_forsion/notice', params: { sessionId, ...notice } });
          setTimeout(() => send({ jsonrpc: '2.0', method: '_forsion/notice', params: { sessionId, id: notice.id, clear: true } }), 500);
        },
      });
      const link = await mod.ResidentLink.open('e-notice-idle', fa.conn as any);
      await expect(link.run(def, runCtx(new AbortController().signal))).resolves.toBeTruthy();
      expect(fa.calls).not.toContain('session/cancel');
      // 撤掉之后看门狗照旧:引擎再不出声就取消
      const quiet = fakeAgent({ promptNeverEnds: true, onPrompt: (send, sessionId) => {
        send({ jsonrpc: '2.0', method: '_forsion/notice', params: { sessionId, ...notice } });
        send({ jsonrpc: '2.0', method: '_forsion/notice', params: { sessionId, id: notice.id, clear: true } });
      } });
      const link2 = await mod.ResidentLink.open('e-notice-idle-2', quiet.conn as any);
      void link2.run(def, runCtx(new AbortController().signal)).catch(() => {});
      await until(() => quiet.calls.includes('session/cancel'), 2000);
    } finally {
      if (prev === undefined) delete process.env.TANGU_ENGINE_IDLE_TIMEOUT_MS; else process.env.TANGU_ENGINE_IDLE_TIMEOUT_MS = prev;
    }
  });
});
