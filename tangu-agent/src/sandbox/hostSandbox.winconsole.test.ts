/**
 * Windows 上 agent 跑命令不许弹控制台窗口(用户反馈:每次调 python 都弹一个 cmd 窗)。
 *
 * 机理:桌面端的引擎进程没有控制台(Electron 以 ELECTRON_RUN_AS_NODE 起,GUI 子系统)。Node 的 detached:true 在
 * Windows 上是 DETACHED_PROCESS —— cmd.exe 自己没控制台,它起的 python.exe 这类控制台程序就各自新开一个**可见**窗口;
 * 而 windowsHide 的 CREATE_NO_WINDOW 与 DETACHED_PROCESS 同用时被系统忽略。所以两个标志必须成对:
 * win32 不 detached + windowsHide(cmd.exe 拿到一个无窗口的控制台,子孙继承它)。POSIX 仍要 detached —— 超时 / 中止按进程组整组杀。
 * 不只是观感:新开了控制台的孙进程,标准句柄跟着换成那个新控制台的 —— 输出进了弹出来的窗口,管道里收不到
 * (2026-10-04 windows-2022 实测:旧选项 visible=True 且 stdout 为空;单加 windowsHide 仍 visible=True;成对改后 visible=False、stdout 回到管道)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

const spawnSpy = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  spawnSpy.mockImplementation(actual.spawn as never);
  return { ...actual, spawn: spawnSpy };
});
import { prepareHostCommand, spawnHostShell } from './hostSandbox.js';

const realPlatform = process.platform;
const asPlatform = (value: NodeJS.Platform): void => { Object.defineProperty(process, 'platform', { value }); };
afterEach(() => { asPlatform(realPlatform); spawnSpy.mockClear(); });

describe('agent 子进程在 Windows 上不弹控制台窗口', () => {
  it('win32:不 detached + windowsHide 成对;POSIX 仍 detached', () => {
    const fake = { once: () => fake, on: () => fake } as unknown as ChildProcess;
    for (const [platform, detached] of [['win32', false], ['linux', true]] as const) {
      asPlatform(platform);
      spawnSpy.mockReturnValueOnce(fake);
      spawnHostShell({ cwd: os.tmpdir() }, 'echo hi');
      expect(spawnSpy.mock.lastCall?.[1], `run_bash on ${platform}`).toMatchObject({ shell: true, detached, windowsHide: true });
      expect(prepareHostCommand({ cwd: os.tmpdir() }, ['x']).options, `argv on ${platform}`).toMatchObject({ detached, windowsHide: true });
    }
  });

  // 真机探针(只在 Windows 上跑;CI = probe-win-console.yml 与 build-desktop 的 Windows 闸):经 cmd.exe 起一个控制台程序(孙进程),
  // 让它自己报「我的控制台窗口可见吗」。旧选项作负对照必须报 True —— 对照不红,这只探针就什么都没证明。
  // ponytail: 只认经典 conhost(windows-2022)。默认终端是 Windows Terminal 的机器上 GetConsoleWindow 给的是隐藏的伪窗口,
  // 对照会假绿;要覆盖那种机器得改成枚举顶层窗口。
  it.runIf(realPlatform === 'win32')('真机:孙进程看不到可见的控制台窗口(旧选项作负对照)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-winconsole-'));
    const ps1 = path.join(dir, 'probe.ps1');
    // 写文件上报而不是走 stdout:新开了控制台的进程,标准句柄可能被换成那个新控制台的,管道里什么都收不到
    await fs.writeFile(ps1, [
      'param([string]$Out)',
      `Add-Type -Namespace Probe -Name Con -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);'`,
      '$h = [Probe.Con]::GetConsoleWindow()',
      '"visible=$([Probe.Con]::IsWindowVisible($h)) hwnd=$h" | Set-Content -Encoding ascii $Out',
      '"stdout-reached"',
    ].join('\r\n'));
    const probe = async (label: string, start: (command: string) => ChildProcess): Promise<string> => {
      const out = path.join(dir, `${label}.txt`);
      const t0 = Date.now();
      const child = start(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${ps1}" "${out}"`);
      let stdio = '';
      child.stdout?.on('data', (d) => { stdio += d; });
      child.stderr?.on('data', (d) => { stdio += d; });
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      const report = await fs.readFile(out, 'utf8').then((text) => text.trim(), () => '(no report file)');
      const line = `${report} | exit=${code} | ${Date.now() - t0}ms | stdio=${JSON.stringify(stdio.trim())}`;
      console.log(`[winconsole] ${label}: ${line}`);
      return line;
    };
    try {
      const { spawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      const legacy = await probe('legacy', (command) => spawn(command, { shell: true, detached: true }));
      // 只记录不断言:单加 windowsHide、不去掉 detached 时窗口还在不在(头注释里「必须成对」那句的实证)
      await probe('detached-hide', (command) => spawn(command, { shell: true, detached: true, windowsHide: true }));
      const fixed = await probe('fixed', (command) => spawnHostShell({ cwd: dir }, command));
      expect(legacy, '负对照:旧选项(detached,无 windowsHide)').toMatch(/^visible=True/);
      expect(fixed, '没有可见窗口,且孙进程的 stdout 回到管道').toMatch(/^visible=False .*stdio="stdout-reached"$/);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }, 90_000);
});
