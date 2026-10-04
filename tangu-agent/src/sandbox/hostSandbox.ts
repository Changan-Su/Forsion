/** Local execution policy. The engine stays trusted; model-driven processes enter an OS sandbox. */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { protectedHostPaths, protectedAncestors, canonicalFuturePath } from './hostSandboxProtection.js';
import type { ToolContext } from '../tools/toolTypes.js';
import { writableRoots } from '../tools/fsPolicy.js';
import { toolSubprocessEnv } from './credentialEnv.js';
import { effectiveRemote } from '../services/remoteOrigin.js';
import { remoteShellProfile, RemoteShellProtectionError } from './remoteShellSeatbelt.js';

/** 起进程时要看的 ctx 字段:工作区 / 宿主沙箱策略,加远程污点(起跑时的 remote 或中途被 steer 染上的,按 runId 现查)。 */
type HostExecContext = Pick<ToolContext, 'cwd' | 'extraRoots' | 'hostSandbox' | 'remote' | 'runId' | 'writeProtectShell'>;

export interface HostSandboxConfig {
  mode: 'off' | 'workspace-write' | 'read-only';
  network: 'deny' | 'allow';
}
export function normalizeHostSandbox(value: unknown): HostSandboxConfig {
  if (value == null) return { mode: 'off', network: 'deny' };
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid hostSandbox configuration');
  const input = value as Record<string, unknown>;
  const mode = input.mode === undefined ? 'off' : input.mode;
  const network = input.network === undefined ? 'deny' : input.network;
  if (typeof mode !== 'string' || typeof network !== 'string' || !['off', 'workspace-write', 'read-only'].includes(mode) || !['deny', 'allow'].includes(network)) {
    throw new Error('Invalid hostSandbox mode or network policy');
  }
  return { mode: mode as HostSandboxConfig['mode'], network: network as HostSandboxConfig['network'] };
}
export function hostSandboxEnabled(ctx: Pick<ToolContext, 'hostSandbox'>): boolean {
  return normalizeHostSandbox(ctx.hostSandbox).mode !== 'off';
}
/** Background stdin may only reuse the exact policy and workspace used at process creation. */
export function hostSandboxScopeKey(ctx: Pick<ToolContext, 'cwd' | 'extraRoots' | 'hostSandbox'>): string {
  const policy = normalizeHostSandbox(ctx.hostSandbox);
  return JSON.stringify({ ...policy, cwd: canonicalFuturePath(ctx.cwd || process.cwd()), roots: localWritableRoots(ctx).sort() });
}
export function hostSandboxBackend(platform = process.platform): { available: boolean; backend: string; executable?: string; reason?: string } {
  if (platform === 'darwin') return existsSync('/usr/bin/sandbox-exec')
    ? { available: true, backend: 'seatbelt', executable: '/usr/bin/sandbox-exec' }
    : { available: false, backend: 'seatbelt', reason: 'macOS sandbox-exec is unavailable' };
  if (platform === 'linux') {
    const executable = ['/usr/bin/bwrap', '/bin/bwrap'].find((p) => existsSync(p));
    return executable ? { available: true, backend: 'bubblewrap', executable }
      : { available: false, backend: 'bubblewrap', reason: 'Local sandbox requires bubblewrap at /usr/bin/bwrap or /bin/bwrap' };
  }
  return { available: false, backend: 'unsupported', reason: `Local sandbox is unsupported on ${platform}; no native helper is installed` };
}

function canonical(p: string): string { return realpathSync(path.resolve(p)); }
function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
function safeEnvironment(scratch: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TERM'].includes(key) || /^LC_[A-Z_]+$/.test(key)) env[key] = value;
  }
  env.PATH ??= '/usr/bin:/bin';
  // Packaged Desktop runs this engine with Electron's Node entry point.
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  env.TMPDIR = scratch;
  env.TMP = scratch;
  env.TEMP = scratch;
  env.XDG_CACHE_HOME = path.join(scratch, 'cache');
  env.npm_config_cache = path.join(scratch, 'npm-cache');
  env.PIP_CACHE_DIR = path.join(scratch, 'pip-cache');
  return env;
}

/** Exposed for policy tests; values are quoted as data, never concatenated shell source. */
export function seatbeltPolicy(roots: string[], scratch: string, network: HostSandboxConfig['network'], protectedPaths: string[]): string {
  const quote = (s: string): string => JSON.stringify(s);
  return [
    '(version 1)', '(deny default)',
    '(allow process-exec process-fork)', '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))', '(allow sysctl-read)',
    '(allow file-read*)', '(allow file-write* (literal "/dev/null"))',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    '(allow ipc-posix-sem)',
    ...[...roots, scratch].map((r) => `(allow file-write* (subpath ${quote(r)}))`),
    '(deny file-write* (regex #"/[.](git|agents|codex)(/|$)"))',
    ...protectedPaths.map((p) => `(deny file-write* (subpath ${quote(p)}))`),
    ...protectedAncestors(protectedPaths).map((p) => `(deny file-write-unlink (literal ${quote(p)}))`),
    ...(network === 'allow' ? ['(allow network*)'] : []),
  ].join('\n');
}

export interface PreparedHostCommand {
  file: string;
  args: string[];
  options: SpawnOptions;
  cleanup(): void;
}
function localWritableRoots(ctx: Pick<ToolContext, 'cwd' | 'extraRoots' | 'hostSandbox'>): string[] {
  if (normalizeHostSandbox(ctx.hostSandbox).mode !== 'workspace-write') return [];
  const cwd = path.resolve(ctx.cwd || process.cwd());
  const configured = process.platform === 'linux' ? [cwd, ...(ctx.extraRoots || [])] : writableRoots(ctx as ToolContext);
  return [...new Set(configured.filter(existsSync).map(canonical))].sort((a, b) => a.length - b.length);
}
/**
 * P1 · G5 方案 A:宿主沙箱关 + macOS + 远程污点(含起跑后被远端 steer 染上的,每条命令现查)→ 套远程 shell 写拒绝 profile。
 * 本机 run、宿主沙箱开(沿用它自己的 profile)、Linux / Windows(方案 C,设置页与 CHANGELOG 如实写明)都不走这里。
 */
export function remoteShellSeatbeltApplies(ctx: HostExecContext | undefined, platform = process.platform): boolean {
  return platform === 'darwin' && !!ctx && normalizeHostSandbox(ctx.hostSandbox).mode === 'off' && !!effectiveRemote(ctx);
}
/**
 * 起进程时套不套写拒绝 profile:远程污点(上面那条),或 P1 · G5 方案 B 的 writeProtectShell —— 引擎自己的 git 与按 known-safe
 * 免审批放行的 git 读命令,本机 run 也套(仓库里被远程命令摆下的 filter / fsmonitor / 钩子由它们以用户身份执行)。
 * 只 macOS + 宿主沙箱关;宿主沙箱开时沿用那一档自己的 profile。remoteShellSeatbeltApplies 仍只管「远程」那一半
 * (后台进程 stdin 闸、写保护失败提示的文案都是远程专属)。
 */
export function shellWriteProtectApplies(ctx: HostExecContext | undefined, platform = process.platform): boolean {
  return platform === 'darwin' && !!ctx && normalizeHostSandbox(ctx.hostSandbox).mode === 'off' && (!!ctx.writeProtectShell || !!effectiveRemote(ctx));
}
/** 写保护包装。sandbox-exec 缺失 / 名单渲染失败 → 抛 RemoteShellProtectionError,**绝不**退回不包的命令。
 *  sandbox_apply 在子进程里失败(引擎自己跑在别的沙箱里)时 sandbox-exec 不 exec 目标命令、以 71 退出 —— 同样不会裸跑。 */
function remoteSeatbeltCommand(cwd: string, argv: string[], local: boolean): PreparedHostCommand {
  const backend = hostSandboxBackend('darwin');
  if (!backend.available || !backend.executable) throw new RemoteShellProtectionError(backend.reason || 'sandbox-exec is unavailable', local);
  const profile = remoteShellProfile(local);
  // 环境与本机 run 相同(toolSubprocessEnv:只剥引擎凭据),不换成沙箱开时的白名单 —— 这一层只管写。
  return { file: backend.executable, args: ['-p', profile, '--', ...argv], options: { cwd, env: toolSubprocessEnv(), detached: true }, cleanup() {} };
}
/** Prepare a process launch. Restricted modes never fall back to an unrestricted command. */
export function prepareHostCommand(ctx: HostExecContext, argv: string[]): PreparedHostCommand {
  if (!argv.length || argv.some((a) => typeof a !== 'string' || a.includes('\0'))) throw new Error('Invalid command argv');
  const config = normalizeHostSandbox(ctx.hostSandbox);
  const cwd = path.resolve(ctx.cwd || process.cwd());
  if (config.mode === 'off' && shellWriteProtectApplies(ctx)) return remoteSeatbeltCommand(cwd, argv, !effectiveRemote(ctx));
  // 沙箱关:照旧继承环境,但剥掉引擎凭据(C2 —— verifyCommand / runGit / 沙箱辅助进程都走这里);沙箱开:safeEnvironment 本就只留白名单。
  if (config.mode === 'off') return { file: argv[0], args: argv.slice(1), options: { cwd, env: toolSubprocessEnv(), detached: process.platform !== 'win32', windowsHide: true }, cleanup() {} };
  const backend = hostSandboxBackend();
  if (!backend.available || !backend.executable) throw new Error(`Host sandbox unavailable: ${backend.reason}`);
  const resolvedCwd = canonical(cwd);
  const roots = localWritableRoots(ctx);
  const scratch = canonical(mkdtempSync(path.join(os.tmpdir(), 'tangu-sandbox-')));
  const cleanup = (): void => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* retry by OS temp cleanup */ } };
  try {
    const protectedPaths = protectedHostPaths();
    const args = process.platform === 'darwin'
      ? ['-p', seatbeltPolicy(roots, scratch, config.network, protectedPaths), '--', ...argv]
      : bubblewrapArgs(roots, scratch, resolvedCwd, config.network, protectedPaths, argv);
    return { file: backend.executable, args, options: { cwd: resolvedCwd, env: safeEnvironment(scratch), detached: true }, cleanup };
  } catch (e) { cleanup(); throw e; }
}
function bubblewrapArgs(roots: string[], scratch: string, cwd: string, network: HostSandboxConfig['network'], protectedPaths: string[], argv: string[]): string[] {
  for (const protectedPath of protectedPaths) {
    if (!existsSync(protectedPath) && roots.some((root) => inside(path.resolve(protectedPath), root))) {
      throw new Error(`Host sandbox cannot protect missing sensitive path ${protectedPath} with this writable root on Linux; choose a narrower workspace`);
    }
  }
  const args = ['--die-with-parent', '--new-session', '--unshare-all'];
  if (network === 'allow') args.push('--share-net');
  args.push('--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev');
  for (const root of roots) args.push('--bind', root, root);
  args.push('--bind', scratch, scratch);
  // Existing metadata remains read-only even under a writable workspace mount.
  const protectedEntries = [...protectedPaths, ...roots.flatMap((r) => ['.git', '.agents', '.codex'].map((n) => path.join(r, n)))];
  for (const target of new Set(protectedEntries.filter(existsSync).map(canonical))) {
    if (roots.some((root) => inside(target, root))) args.push('--ro-bind', target, target);
  }
  args.push('--chdir', cwd, '--', ...argv);
  return args;
}
export function spawnHostCommand(ctx: HostExecContext, argv: string[], options: SpawnOptions = {}): ChildProcess {
  const command = prepareHostCommand(ctx, argv);
  try {
    const child = spawn(command.file, command.args, { ...options, ...command.options });
    child.once('close', command.cleanup);
    child.once('error', command.cleanup);
    return child;
  } catch (e) { command.cleanup(); throw e; }
}

/** Preserve Node's platform-specific shell quoting in compatibility mode.
 *  远程写保护那条路(macOS)同样是 `/bin/sh -c command` —— 与 Node 在 darwin 上 shell:true 的展开一致,只是外面多一层 sandbox-exec。
 *  Windows 不 detached + windowsHide,两个必须成对:detached 是 DETACHED_PROCESS,cmd.exe 没有控制台,它起的 python.exe
 *  等控制台程序就各自弹一个可见窗口,而单加 windowsHide(CREATE_NO_WINDOW)与它同用时被系统忽略。win32 的终止本来就不靠进程组。 */
export function spawnHostShell(ctx: HostExecContext, command: string): ChildProcess {
  if (!hostSandboxEnabled(ctx) && !shellWriteProtectApplies(ctx)) return spawn(command, { cwd: ctx.cwd || process.cwd(), shell: true, detached: process.platform !== 'win32', windowsHide: true, env: toolSubprocessEnv() });
  return spawnHostCommand(ctx, ['/bin/sh', '-c', command]);
}
