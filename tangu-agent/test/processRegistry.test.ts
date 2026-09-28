import { describe, it, expect, afterEach } from 'vitest';
import {
  startBackgroundProcess, writeStdin, waitForOutput, getProcess, disposeAllProcesses,
  type BackgroundProcess,
} from '../src/tools/processRegistry.js';

const SID = 'test-session';
const CWD = process.cwd();

afterEach(() => disposeAllProcesses());

function startOk(cmd: string): BackgroundProcess {
  const r = startBackgroundProcess(SID, cmd, CWD);
  if (typeof r === 'string') throw new Error(`start failed: ${r}`);
  return r;
}

describe('writeStdin + waitForOutput (interactive shell)', () => {
  it('drives a line-oriented process: write to stdin, see echoed output', async () => {
    const p = startOk('cat'); // echoes stdin → stdout
    const from = p.output.length;
    expect(writeStdin(SID, p.id, 'hello', true)).toMatch(/wrote/);
    const { output, status } = await waitForOutput(p, from, { idleMs: 200, capMs: 4000 });
    expect(output).toContain('hello');
    expect(status).toBe('running'); // cat still alive, waiting for more input
  });

  it('errors when writing to an exited process', async () => {
    const p = startOk('true'); // exits 0 immediately
    await waitForOutput(p, p.output.length, { capMs: 3000 }); // wait until it exits
    expect(getProcess(SID, p.id)?.status).not.toBe('running');
    expect(writeStdin(SID, p.id, 'x', true)).toMatch(/Error.*已结束/);
  });

  it('Ctrl-C (\\x03) sends SIGINT and the process ends', async () => {
    const p = startOk('cat');
    expect(writeStdin(SID, p.id, '\x03', false)).toMatch(/SIGINT/);
    // capMs 给足:CI 的共享 runner 上 3s 曾经不够(同一份代码前一轮是绿的)。断言本身没放松 ——
    // 最终仍必须不是 running,只是不拿「慢」当「没死」。
    const { status } = await waitForOutput(p, p.output.length, { capMs: 10_000 });
    expect(status).not.toBe('running'); // SIGINT terminated cat
    // ⚠️ 用例超时必须 > capMs:vitest 默认 5s,而 waitForOutput 在进程状态迟迟不变时会一直等到
    // capMs。CI 上偶发就是这样(第 4 轮撞 capMs=3s 报 'running',第 7 轮撞 vitest 5s 报 timed out
    // —— 同一个 flaky 的两副面孔)。留足余量,让「10s 内确实没退」才是红。
  }, 20_000);

  it('does not leak an unhandled stdin EPIPE when the process closed its stdin', async () => {
    // 关掉 fd 0 后仍在跑 → 管道已无读端,写一个字节就 EPIPE(异步 'error',try/catch 接不住)。
    const uncaught: any[] = [];
    const onUncaught = (e: unknown): void => { uncaught.push(e); };
    process.on('uncaughtException', onUncaught);
    try {
      const p = startOk('exec 0<&-; echo ready; sleep 5');
      await waitForOutput(p, 0, { idleMs: 100, capMs: 10_000 }); // 见到 ready 即返回;cap 只防 CI 慢
      expect(p.output).toContain('ready');
      expect(writeStdin(SID, p.id, 'x', true)).toMatch(/wrote/);
      await new Promise((res) => setTimeout(res, 200));
      expect(uncaught.map((e) => e?.code ?? String(e))).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  }, 15_000);

  it('errors for an unknown process id', () => {
    expect(writeStdin(SID, 'bg_nope', 'x', true)).toMatch(/不存在/);
  });
});

describe('waitForOutput resolve paths', () => {
  it('resolves on cap timeout when no new output arrives', async () => {
    const p = startOk('cat'); // produces nothing without input
    const t0 = Date.now();
    const { output, status } = await waitForOutput(p, p.output.length, { idleMs: 200, capMs: 300 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(output).toBe('');
    expect(status).toBe('running');
  });

  it('resolves promptly when the abort signal is already aborted', async () => {
    const p = startOk('cat');
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    await waitForOutput(p, p.output.length, { idleMs: 5000, capMs: 60_000, signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(1000); // didn't wait out cap/idle
  });
});

// P1 · K2 §3.7:后台进程打来源标签,急停按标签 / runId 整组杀。
import { killProcessesWhere, listTaggedProcesses, onProcessChange, processOriginOf } from '../src/tools/processRegistry.js';
import { taintRunRemote, clearRunRemoteTaint } from '../src/services/remoteOrigin.js';

describe('来源标签 + killProcessesWhere(P1-K2)', () => {
  const alive = (pid: number | null): boolean => { try { process.kill(pid!, 0); return true; } catch { return false; } };

  it('来源按 ctx 判:远程(起跑污点 / 中途染色)> 这条 run 自己的来源(runOrigin)> 无人值守 > 本机;会话级 channelSession 不算', () => {
    expect(processOriginOf(undefined)).toBe('local');
    expect(processOriginOf({ remote: { via: 'tunnel', marked: true } } as any)).toBe('remote');
    taintRunRemote('R-proc', { via: 'p2p', marked: false });
    expect(processOriginOf({ runId: 'R-proc', runOrigin: 'local' } as any)).toBe('remote'); // 本机起、中途染色
    clearRunRemoteTaint('R-proc');
    expect(processOriginOf({ runOrigin: 'channel', channelSession: true } as any)).toBe('channel');
    // 连着微信的会话里用户在桌面敲的 run:会话级旗标为真,run 本身是本机(独立评审 P2)
    expect(processOriginOf({ runOrigin: 'local', channelSession: true } as any)).toBe('local');
    expect(processOriginOf({ channelSession: true } as any)).toBe('local');
    expect(processOriginOf({ runOrigin: 'unattended' } as any)).toBe('unattended');
    expect(processOriginOf({ muse: true } as any)).toBe('unattended');
    expect(processOriginOf({ automationOrigin: 't1' } as any)).toBe('unattended');
    expect(processOriginOf({ runId: 'R-local' } as any)).toBe('local');
  });

  it('远程 ctx 起的进程带 origin/runId、进快照;杀组连孙进程一起死;本机进程不动', async () => {
    const changes: number[] = [];
    const off = onProcessChange(() => changes.push(1));
    const remote = startBackgroundProcess(SID, 'sleep 30 & wait', CWD, { remote: { via: 'tunnel', marked: true }, runId: 'R-rem', cwd: CWD } as any);
    const local = startOk('sleep 30');
    if (typeof remote === 'string') throw new Error(remote);
    expect(remote).toMatchObject({ origin: 'remote', runId: 'R-rem' });
    expect(local.origin).toBe('local');
    expect(listTaggedProcesses().map((p) => [p.id, p.origin, p.runId])).toEqual([[remote.id, 'remote', 'R-rem']]);
    expect(changes.length).toBeGreaterThanOrEqual(2);
    expect(killProcessesWhere((p) => p.origin !== 'local')).toBe(1);
    await waitForOutput(remote, 0, { capMs: 5000 });
    expect(remote.status).toBe('killed');
    expect(alive(remote.pid)).toBe(false);
    expect(local.status).toBe('running');
    expect(alive(local.pid)).toBe(true);
    expect(listTaggedProcesses()).toEqual([]);
    // 按 runId 命中本机起、后被染色的 run 起的进程(它的 origin 仍是 local)
    const tainted = startBackgroundProcess(SID, 'sleep 30', CWD, { runId: 'R-mid', cwd: CWD } as any);
    if (typeof tainted === 'string') throw new Error(tainted);
    expect(killProcessesWhere((p) => new Set(['R-mid']).has(p.runId || ''))).toBe(1);
    expect(killProcessesWhere(() => { throw new Error('bad pred'); })).toBe(0); // 谓词抛 = 不杀
    off();
  }, 20_000);
});
