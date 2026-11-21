/**
 * 长命令不挡插话(11-20)的工具层:run_bash 什么时候移交、移交后输出怎么打码、结局怎么判。
 * 整条链(插话 → 移交 → 结局交回 / 起一轮)见 agentLoopSteerHandoff.test.ts。
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import { HOST_TOOLS } from '../src/tools/hostExec.js';
import { hostProcessProvider } from '../src/tools/builtin/hostProcess.js';
import { disposeAllProcesses, getProcess, killProcess, listProcesses, processOutput, type BackgroundProcess } from '../src/tools/processRegistry.js';
import { endReasonOf, endWakes, formatHandoffUpdate, takeHandoffUpdates } from '../src/services/steerHandoff.js';
import { parseBackgroundUpdate } from '../src/contracts/approvalQueue.js';
import { clearRunSecretEnv, setRunSecretEnv } from '../src/sandbox/runSecretEnv.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
afterEach(() => { disposeAllProcesses(); delete process.env.TANGU_HANDOFF_MAX_MS; });

let seq = 0;
/** 一次带 steerHandoff 的 run_bash 调用;pending 由测试控制,flip() 模拟插话到达。 */
function call(command: string, opts: { pending?: boolean; runId?: string } = {}) {
  let pending = !!opts.pending;
  const cbs = new Set<() => void>();
  const sessionId = `S${++seq}`;
  const ctx: any = {
    cwd: os.tmpdir(), sessionId, userId: 'u', appId: 'a', runId: opts.runId || `R${seq}`, toolCallId: `c${seq}`,
    steerHandoff: { pending: () => pending, onSteer: (cb: () => void) => { cbs.add(cb); return () => cbs.delete(cb); } },
  };
  const out = HOST_TOOLS.run_bash.execute({ command }, ctx) as Promise<string>;
  return {
    out, sessionId, ctx,
    steer: () => { pending = true; for (const cb of [...cbs]) cb(); },
    withdraw: () => { pending = false; },
  };
}
const until = async (cond: () => boolean, ms = 8000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(25); }
};

describe('run_bash 移交', () => {
  it('插话排着、命令一秒内就跑完 → 照常返回完整结果,不进后台', async () => {
    const c = call('echo quick-done', { pending: true });
    const out = await c.out;
    expect(out).toContain('quick-done');
    expect(out).toContain('exit_code: 0');
    expect(listProcesses(c.sessionId)).toEqual([]);
  });

  it('插话在宽限期内撤回 → 不移交,命令照常跑完', async () => {
    const c = call('sleep 1.6; echo kept-foreground');
    await sleep(200);
    c.steer();
    await sleep(200);
    c.withdraw(); // 宽限期(1s)到之前撤回
    const out = await c.out;
    expect(out).toContain('kept-foreground');
    expect(out).not.toContain('Moved to the background');
    expect(listProcesses(c.sessionId)).toEqual([]);
  });

  it('插话到达 → 立刻返回已有输出;同一个进程接着跑完,结局 finished', async () => {
    const c = call("printf 'early\\n'; sleep 1.5; printf 'late\\n'");
    await sleep(1100);
    const t0 = Date.now();
    c.steer();
    const out = await c.out;
    expect(Date.now() - t0).toBeLessThan(500);
    expect(out).toMatch(/^stdout so far:\nearly/);
    expect(out).toContain('Moved to the background');
    const [p] = listProcesses(c.sessionId);
    expect(p.handoff).toMatchObject({ runId: c.ctx.runId, toolCallId: c.ctx.toolCallId });
    expect(p.runId).toBe(c.ctx.runId);
    expect(p.origin).toBe('local');
    await until(() => !!p.handoff?.closed);
    expect(p.output).toBe('early\nlate\n');
    expect(p.exitCode).toBe(0);
    expect(endReasonOf(p)).toBe('finished');
    expect(endWakes(endReasonOf(p))).toBe(true);
  });

  it('秘密变量:run 收尾清了秘密表之后,read_process_output / processOutput 照样打码', async () => {
    const runId = 'R-secret';
    setRunSecretEnv(runId, { MY_TOKEN: 'sekrit-value-123456' });
    const c = call('sleep 1.2; printf "token=%s\\n" "$MY_TOKEN"', { runId });
    await sleep(1100);
    c.steer();
    await c.out;
    clearRunSecretEnv(runId); // 那一轮收尾了
    const [p] = listProcesses(c.sessionId);
    await until(() => !!p.handoff?.closed);
    expect(p.output).toContain('sekrit-value-123456'); // 缓冲里是原样(界面 / 模型都不直接读它)
    expect(processOutput(p)).toContain('token=[REDACTED:MY_TOKEN]');
    const read = hostProcessProvider.tools().find((t) => t.name === 'read_process_output')!;
    const text = String(await read.execute({ process_id: p.id }, { sessionId: c.sessionId } as any));
    expect(text).toContain('[REDACTED:MY_TOKEN]');
    expect(text).not.toContain('sekrit-value-123456');
  });

  it('子代理 / PTC 的调用不移交(哪怕上下文里带着 steerHandoff)', async () => {
    for (const extra of [{ subAgentDepth: 1 }, { ptcRead: true }]) {
      const ctx: any = {
        cwd: os.tmpdir(), sessionId: `S-x${++seq}`, userId: 'u', appId: 'a', runId: 'R-x', toolCallId: 'c-x', ...extra,
        steerHandoff: { pending: () => true, onSteer: () => () => {} },
      };
      const out = String(await HOST_TOOLS.run_bash.execute({ command: 'sleep 1.3; echo sub-done' }, ctx));
      expect(out).toContain('sub-done');
      expect(out).not.toContain('Moved to the background');
      expect(listProcesses(ctx.sessionId)).toEqual([]);
    }
  });
});

describe('结局表', () => {
  it('kill_process / 界面停止 → stopped,不交回;到上限 → timed_out,交回', async () => {
    const a = call('sleep 30');
    await sleep(1100);
    a.steer();
    await a.out;
    const [pa] = listProcesses(a.sessionId);
    killProcess(a.sessionId, pa.id);
    await until(() => !!pa.handoff?.closed);
    expect(endReasonOf(pa)).toBe('stopped');
    expect(endWakes('stopped')).toBe(false);
    expect(takeHandoffUpdates(a.sessionId)).toBeNull(); // 被停的:标成处理过,不出结局行
    expect(pa.handoff?.delivered).toBe(true);

    process.env.TANGU_HANDOFF_MAX_MS = '600';
    const b = call('sleep 30');
    await sleep(1100);
    b.steer();
    await b.out;
    const [pb] = listProcesses(b.sessionId);
    await until(() => !!pb.handoff?.closed);
    expect(endReasonOf(pb)).toBe('timed_out');
    const text = takeHandoffUpdates(b.sessionId)!;
    expect(text).toContain('[timed_out]');
    expect(takeHandoffUpdates(b.sessionId)).toBeNull(); // 只交一次
  });

  it('结局行能被界面解析(行头格式是两边的契约)', () => {
    const p = {
      id: 'bg_x', command: 'npm test --silent', startedAt: 0, endedAt: 47_000, exitCode: 1, status: 'exited',
      handoff: { runId: 'R', toolCallId: 'call_1', movedAt: 5000, deadlineAt: 5000 + 1_800_000, closed: true },
    } as unknown as BackgroundProcess;
    const rows = parseBackgroundUpdate(formatHandoffUpdate([p]));
    expect(rows).toEqual([{ status: 'finished', processId: 'bg_x', callId: 'call_1', command: 'npm test --silent', exitCode: 1 }]);
    expect(getProcess('none', 'bg_x')).toBeNull();
  });
});
