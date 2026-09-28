/**
 * P1 · G5:macOS 上 /usr/bin/sandbox-exec 缺失时,远程污点 run 的 shell **失败即关**(工具错误、命令不跑),
 * 本机 run 不受影响。单独一个文件:要把 node:fs 的 existsSync 对 sandbox-exec 那一条打桩成「不存在」。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const existsSync = (p: import('node:fs').PathLike): boolean => (String(p) === '/usr/bin/sandbox-exec' ? false : actual.existsSync(p));
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});

import { mkdtempSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST_TOOLS } from '../src/tools/hostExec.js';
import { startBackgroundProcess, disposeAllProcesses } from '../src/tools/processRegistry.js';
import { prepareHostCommand } from '../src/sandbox/hostSandbox.js';
import { RemoteShellProtectionError } from '../src/sandbox/remoteShellSeatbelt.js';
import type { ToolContext } from '../src/tools/toolTypes.js';

let ws: string;
const prevHome = process.env.TANGU_HOME;
beforeAll(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-g5-missing-')));
  process.env.TANGU_HOME = join(ws, 'forsion', 'tangu');
});
afterAll(() => {
  disposeAllProcesses();
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  try { rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
});
const ctx = (remote: boolean): ToolContext =>
  ({ userId: 'u1', sessionId: 'G5-missing', appId: 'test', cwd: ws, execMode: 'host', ...(remote ? { remote: { via: 'tunnel', marked: true } } : {}) }) as ToolContext;

describe.skipIf(process.platform !== 'darwin')('sandbox-exec 缺失(仅 macOS 有这层)', () => {
  it('远程 run_bash / run_background:工具错误、命令没跑;prepareHostCommand 抛错而不是退回裸命令', async () => {
    expect(() => prepareHostCommand(ctx(true), ['/bin/sh', '-c', 'true'])).toThrow(RemoteShellProtectionError);
    const marker = join(ws, 'ran-anyway');
    const out = await HOST_TOOLS.run_bash.execute({ command: `touch '${marker}'` }, ctx(true));
    expect(out).toMatch(/^Error: This command comes from a remote session.*sandbox-exec is unavailable.*was not run/s);
    const bg = startBackgroundProcess('G5-missing', `touch '${marker}'`, ws, ctx(true));
    expect(bg).toMatch(/^Error: This command comes from a remote session/);
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(marker)).toBe(false);
  });

  it('本机 run 不受影响', async () => {
    const marker = join(ws, 'local-ran');
    const out = await HOST_TOOLS.run_bash.execute({ command: `touch '${marker}'` }, ctx(false));
    expect(out).toMatch(/exit_code: 0/);
    expect(existsSync(marker)).toBe(true);
  });
});
