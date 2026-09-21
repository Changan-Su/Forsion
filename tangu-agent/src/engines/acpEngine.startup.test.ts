/** 外部引擎「起不来」必须立刻失败,不能拖到 30s 握手超时。
 *  病灶原型:Windows 安装包的内置 Node 缺 npm → `npx.cmd` 拿 MODULE_NOT_FOUND 退出。
 *  spawn 本身是成功的(cmd.exe 起来了),没有 'error' 事件 —— 只有 'exit' 抓得到。 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { watchEngineStartup } from './acpEngine.js';

const child = (code: string) =>
  spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });

describe('watchEngineStartup', () => {
  it('握手前子进程退出 → 立刻 reject,并带上 stderr 末尾(而不是干等超时)', async () => {
    const c = child('console.error("Cannot find module npm-prefix.js"); process.exit(1)');
    await expect(watchEngineStartup(c, 'codex').failed).rejects.toThrow(/握手前就退出了\(code=1\).*npm-prefix/s);
  });

  it('spawn 失败(命令不存在)照旧 reject', async () => {
    const c = spawn('definitely-not-a-real-engine-binary-xyz', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    await expect(watchEngineStartup(c, 'codex').failed).rejects.toThrow(/spawn failed/);
  });

  it('disarm 之后的正常退出不再 reject(否则每次跑完都炸一次)', async () => {
    const c = child('process.exit(0)');
    const w = watchEngineStartup(c, 'codex');
    w.disarm();
    // 必须**先确认子进程真的退了**再判静默:干等固定毫秒的话,disarm 写成空实现也会绿。
    await new Promise<void>((r) => c.on('close', () => r()));
    const settled = await Promise.race([
      w.failed.then(() => 'rejected', () => 'rejected'),
      new Promise((r) => setTimeout(() => r('quiet'), 50)),
    ]);
    expect(settled).toBe('quiet');
  });

  // 真子进程复现不了这个时序(本机 'data' 恒早于 'exit' —— 负对照实跑过,去掉 close 监听照样绿),
  // 所以直接喂事件:'exit' 只保证进程没了,stderr 可能还在管道里,'close' 才保证读完。
  const fakeChild = () => Object.assign(new EventEmitter(), { stderr: new EventEmitter() }) as any;

  it('exit 时 stderr 还没排空 → 等到 close 再报,现场不丢', async () => {
    const c = fakeChild();
    const failed = watchEngineStartup(c, 'codex').failed;
    c.emit('exit', 1, null);
    c.stderr.emit('data', Buffer.from('late MODULE_NOT_FOUND'));
    c.emit('close', 1, null);
    await expect(failed).rejects.toThrow(/code=1.*late MODULE_NOT_FOUND/s);
  });

  it('close 一直不来也要报(detached 的孙进程占着管道)', async () => {
    const c = fakeChild();
    const failed = watchEngineStartup(c, 'codex').failed;
    c.emit('exit', 7, null); // 只有 exit,没有 close
    await expect(failed).rejects.toThrow(/code=7/);
  });
});
