import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { HOST_TOOLS } from '../src/tools/hostExec.js';

// 防回归(Issue 1):不返回的命令——shell 后台拉起一个长跑孙进程(sleep),孙进程继承并撑着 stdout 管道。
// 老实现只 SIGKILL shell,孙进程残留 → 'close' 永不触发 → Promise 永挂(本测试会因 vitest 超时而失败)。
// 新实现 detached 进程组 + process.kill(-pid) 杀整组 + grace 兜底 → 在 timeout+grace 内必返回,标 timed out。
describe('run_bash hang guard', () => {
  it('backgrounded grandchild + short timeout → 在 timeout+grace 内返回且标超时,绝不挂死', async () => {
    const start = Date.now();
    const out = await HOST_TOOLS.run_bash.execute(
      { command: 'sleep 600 & wait', timeout_ms: 600 },
      { cwd: os.tmpdir() } as any,
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(600 + 2200); // timeout(600ms) + grace(1500ms) 内收尾
    expect(out).toContain('timed out');
  }, 6000);

  it('正常命令仍返回 stdout 与 exit_code 0', async () => {
    const out = await HOST_TOOLS.run_bash.execute(
      { command: 'echo tangu-ok' },
      { cwd: os.tmpdir() } as any,
    );
    expect(out).toContain('tangu-ok');
    expect(out).toContain('exit_code: 0');
  }, 6000);
});
