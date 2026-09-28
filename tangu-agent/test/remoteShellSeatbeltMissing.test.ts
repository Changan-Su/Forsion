/**
 * P1 · G5:macOS 上 /usr/bin/sandbox-exec 缺失时,远程污点 run 的 shell **失败即关**(工具错误、命令不跑),
 * 本机 run 不受影响。方案 B 起引擎自己的 git(git 现场 / 项目详情面板)不论本机远程都失败即关,免审批的 git 读命令回到审批。单独一个文件:要把 node:fs 的 existsSync 对 sandbox-exec 那一条打桩成「不存在」。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const existsSync = (p: import('node:fs').PathLike): boolean => (String(p) === '/usr/bin/sandbox-exec' ? false : actual.existsSync(p));
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST_TOOLS } from '../src/tools/hostExec.js';
import { startBackgroundProcess, disposeAllProcesses } from '../src/tools/processRegistry.js';
import { prepareHostCommand } from '../src/sandbox/hostSandbox.js';
import { RemoteShellProtectionError } from '../src/sandbox/remoteShellSeatbelt.js';
import { collectGitState, runGit } from '../src/services/runtimeContext.js';
import { projectContext } from '../src/services/projectContext.js';
import { isKnownSafeBash } from '../src/services/approvals.js';
import { execFileSync } from 'node:child_process';
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

  it('引擎自己的 git 一律失败即关(方案 B):远程与本机的 git 现场都不注入(null)、项目详情面板显示不可用,绝不裸跑 git', async () => {
    const repo = join(ws, 'repo');
    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo });
    git('init', '-q'); writeFileSync(join(repo, 'f.txt'), 'a'); git('add', 'f.txt'); git('commit', '-qm', 'i');
    expect(await collectGitState(repo, { cwd: repo, execMode: 'host', remote: { via: 'tunnel', marked: true } })).toBeNull();
    // 原先这里是「本机照常收集」:方案 B 起本机的 git 现场也只在写保护里跑,包不上就不跑
    expect(await collectGitState(repo, { cwd: repo, execMode: 'host' })).toBeNull();
    await expect(runGit(repo, ['status'])).rejects.toThrow(RemoteShellProtectionError);
    expect((await projectContext(repo)).git).toEqual({ available: false, repo: false });
  });

  it('免审批的 git 读命令包不上写保护 → 不再是 known-safe(回到审批卡);闸门放行后硬套 writeProtectShell 也只回错误、不裸跑', async () => {
    const repo = join(ws, 'repo');
    expect(isKnownSafeBash('git status', repo)).toBe(false);
    expect(isKnownSafeBash('ls', repo)).toBe(true); // 别的 known-safe 程序不读仓库配置,不受影响
    const out = await HOST_TOOLS.run_bash.execute({ command: 'git status' }, { ...ctx(false), cwd: repo, writeProtectShell: true });
    expect(out).toMatch(/^Error: On this Mac, git commands that run without approval.*sandbox-exec is unavailable.*was not run/s);
  });

  it('本机 run 不受影响', async () => {
    const marker = join(ws, 'local-ran');
    const out = await HOST_TOOLS.run_bash.execute({ command: `touch '${marker}'` }, ctx(false));
    expect(out).toMatch(/exit_code: 0/);
    expect(existsSync(marker)).toBe(true);
  });
});
