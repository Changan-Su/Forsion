/** Local execution policy. The engine stays trusted; model-driven processes enter an OS sandbox. */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { protectedHostPaths, protectedAncestors, canonicalFuturePath } from './hostSandboxProtection.js';
import type { ToolContext } from '../tools/toolTypes.js';
import { writableRoots } from '../tools/fsPolicy.js';

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
/** Prepare a process launch. Restricted modes never fall back to an unrestricted command. */
export function prepareHostCommand(ctx: Pick<ToolContext, 'cwd' | 'extraRoots' | 'hostSandbox'>, argv: string[]): PreparedHostCommand {
  if (!argv.length || argv.some((a) => typeof a !== 'string' || a.includes('\0'))) throw new Error('Invalid command argv');
  const config = normalizeHostSandbox(ctx.hostSandbox);
  const cwd = path.resolve(ctx.cwd || process.cwd());
  if (config.mode === 'off') return { file: argv[0], args: argv.slice(1), options: { cwd, detached: process.platform !== 'win32' }, cleanup() {} };
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
export function spawnHostCommand(ctx: Pick<ToolContext, 'cwd' | 'extraRoots' | 'hostSandbox'>, argv: string[], options: SpawnOptions = {}): ChildProcess {
  const command = prepareHostCommand(ctx, argv);
  try {
    const child = spawn(command.file, command.args, { ...options, ...command.options });
    child.once('close', command.cleanup);
    child.once('error', command.cleanup);
    return child;
  } catch (e) { command.cleanup(); throw e; }
}

/** Preserve Node's platform-specific shell quoting in compatibility mode. */
export function spawnHostShell(ctx: Pick<ToolContext, 'cwd' | 'extraRoots' | 'hostSandbox'>, command: string): ChildProcess {
  if (!hostSandboxEnabled(ctx)) return spawn(command, { cwd: ctx.cwd || process.cwd(), shell: true, detached: true });
  return spawnHostCommand(ctx, ['/bin/sh', '-c', command]);
}
