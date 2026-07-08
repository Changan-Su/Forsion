import { describe, it, expect, vi, afterEach } from 'vitest';

// 只验根因:①Windows 上引擎子进程必须 shell:true(否则 npx.cmd 无法执行 → 切换外部 CLI 卡死);
// ②握手 withTimeout 到点必 reject(否则死子进程上无限 await)。不拉起真 SDK 连接。
const spawnMock = vi.fn((..._args: any[]) => ({ on() {}, kill() {}, stdin: {}, stdout: {}, stderr: { on() {} }, pid: 1 }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const { spawnEngine, withTimeout } = await import('../src/engines/acpEngine.js');

const withPlatform = (p: string, fn: () => void): void => {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
  try { fn(); } finally { Object.defineProperty(process, 'platform', orig); }
};

afterEach(() => spawnMock.mockClear());

describe('spawnEngine cross-platform shell', () => {
  const def = { id: 'x', name: 'X', command: 'npx', args: ['-y', 'pkg'] } as any;

  it('uses shell:true on win32 (so npx.cmd resolves)', () => {
    withPlatform('win32', () => spawnEngine(def));
    expect(spawnMock).toHaveBeenCalledOnce();
    const opts = spawnMock.mock.calls[0][2] as any;
    expect(opts.shell).toBe(true);
    expect(opts.windowsHide).toBe(true);
  });

  it('uses shell:false on posix (npx is a real script)', () => {
    withPlatform('darwin', () => spawnEngine(def, { cwd: '/tmp', detached: true }));
    const opts = spawnMock.mock.calls[0][2] as any;
    expect(opts.shell).toBe(false);
    expect(opts.detached).toBe(true);
    expect(opts.cwd).toBe('/tmp');
  });
});

describe('withTimeout handshake guard', () => {
  it('rejects when the promise never settles', async () => {
    await expect(withTimeout(new Promise(() => {}), 20, 'initialize'))
      .rejects.toThrow(/initialize timed out/);
  });

  it('resolves when the promise settles first', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'x')).resolves.toBe('ok');
  });
});
