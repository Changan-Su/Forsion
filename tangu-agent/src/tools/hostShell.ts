/**
 * Which shell `run_bash` really uses on this machine, and the Windows path rules that come with it.
 *
 * macOS / Linux: `/bin/sh -c` (unchanged).
 * Windows: Git for Windows bash when one is available — the desktop bundles it next to MinGit and passes
 * TANGU_BASH_BIN; otherwise a standard Git for Windows install. No bash (an older desktop, a failed bundle,
 * TANGU_WINDOWS_SHELL=cmd) → cmd.exe, exactly as before, and every description says so.
 *
 * ⚠️ The answer is resolved once per process. Approval classification (isKnownSafeBash) and execution
 * (spawnHostShell) must agree: a command judged read-only under bash rules must never run under cmd.exe,
 * where `ls` is looked up in the working directory first. If the resolved bash disappears later, the spawn
 * fails instead of falling back.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

export type HostShellKind = 'posix' | 'bash' | 'cmd';
export interface HostShell {
  kind: HostShellKind;
  /** Absolute path of bash.exe (kind 'bash' only). */
  bin?: string;
  /** Directories that go first on PATH for the bash child (usr/bin and the MinGW bin of the same Git tree). */
  pathDirs?: string[];
}

let cached: HostShell | undefined;

/** The shell run_bash uses. `platform` / `env` exist for tests; the real answer is cached per process. */
export function hostShell(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): HostShell {
  if (platform !== 'win32') return { kind: 'posix' };
  const live = platform === process.platform && env === process.env;
  if (live && cached) return cached;
  const resolved = resolveWindowsShell(env, existsSync);
  if (live) cached = resolved;
  return resolved;
}

/** Tests only. */
export function resetHostShellCache(): void {
  cached = undefined;
}

/** bash.exe candidates, best first: the desktop's bundled one, then standard Git for Windows installs.
 *  Never `C:\Windows\System32\bash.exe` — that is WSL, a different machine with a different filesystem. */
export function windowsBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  if (env.TANGU_BASH_BIN?.trim()) out.push(env.TANGU_BASH_BIN.trim());
  for (const root of [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (root?.trim()) out.push(path.win32.join(root.trim(), 'Git', 'usr', 'bin', 'bash.exe'));
  }
  if (env.LOCALAPPDATA?.trim()) out.push(path.win32.join(env.LOCALAPPDATA.trim(), 'Programs', 'Git', 'usr', 'bin', 'bash.exe'));
  return [...new Set(out)];
}

export function resolveWindowsShell(env: NodeJS.ProcessEnv, exists: (p: string) => boolean): HostShell {
  if (/^cmd(\.exe)?$/i.test(env.TANGU_WINDOWS_SHELL?.trim() || '')) return { kind: 'cmd' };
  for (const bin of windowsBashCandidates(env)) {
    if (!path.win32.isAbsolute(bin) || /^[\\/]{2}/.test(bin) || !/(^|[\\/])bash\.exe$/i.test(bin) || /[\\/]system32[\\/]/i.test(bin)) continue;
    if (!exists(bin)) continue;
    return { kind: 'bash', bin, pathDirs: bashPathDirs(bin, exists) };
  }
  return { kind: 'cmd' };
}

/** `<root>/usr/bin/bash.exe` → [<root>/ucrt64/bin | mingw64/bin | clangarm64/bin, <root>/usr/bin] — the order
 *  Git Bash's own profile uses. Without usr/bin first, `find` and `sort` resolve to the System32 programs. */
function bashPathDirs(bin: string, exists: (p: string) => boolean): string[] {
  const binDir = path.win32.dirname(bin);
  const parent = path.win32.dirname(binDir);
  // usr/bin/bash.exe → root is two levels up; bin/bash.exe (the Git Bash launcher) → one level up.
  const root = /^usr$/i.test(path.win32.basename(parent)) ? path.win32.dirname(parent) : parent;
  const mingw = ['ucrt64', 'mingw64', 'clangarm64', 'mingw32'].map((d) => path.win32.join(root, d, 'bin')).filter(exists);
  return [...mingw.slice(0, 1), path.win32.join(root, 'usr', 'bin')];
}

/**
 * Environment for the bash child on Windows: the Git tree's usr/bin first, PATH stripped of empty and relative
 * entries (bash would search the working directory for them — a workspace `ls.exe` must never win), and no
 * variables that make bash run code before the command (BASH_ENV, exported functions, SHELLOPTS…).
 */
export function windowsBashEnv(base: NodeJS.ProcessEnv, shell: HostShell, command: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (/^(BASH_ENV|ENV|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|PROMPT_COMMAND)$/i.test(k) || /^BASH_FUNC_/i.test(k)) continue;
    env[k] = v;
  }
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'Path';
  const kept = String(env[key] || '').split(';').map((p) => p.trim()).filter((p) => p && path.win32.isAbsolute(p) && !/^[\\/]{2}/.test(p)); // no UNC in either spelling: a share on PATH runs its exes
  env[key] = [...(shell.pathDirs || []), ...kept].join(';');
  env[RUN_VAR] = command;
  return env;
}

/** The command travels in an environment variable, never on the command line: the bash argv is a fixed literal.
 *  That sidesteps Windows command-line quoting, the MSYS runtime's own wildcard expansion of unquoted arguments,
 *  and the 32 KiB command-line limit. The variable is unset before the command runs, so children never see it. */
export const RUN_VAR = 'TANGU_RUN_BASH_COMMAND';
export const BASH_EVAL_ARGS = ['-c', `__tangu_cmd=$${RUN_VAR}; unset ${RUN_VAR}; eval "$__tangu_cmd"`];

/** What run_bash's description names as its shell. */
export function hostShellName(platform: NodeJS.Platform = process.platform, shell: HostShell = hostShell(platform)): string {
  if (platform !== 'win32') return '/bin/sh -c';
  return shell.kind === 'bash' ? 'bash from Git for Windows' : 'Windows ComSpec, usually cmd.exe';
}

/** Shell-specific rules the model needs before writing a command. Empty on macOS / Linux. */
export function hostShellQuoting(platform: NodeJS.Platform = process.platform, shell: HostShell = hostShell(platform)): string {
  if (platform !== 'win32') return '';
  if (shell.kind === 'bash') {
    return 'This is Windows, but run_bash is real bash with GNU coreutils: write the same commands you would on macOS or Linux (ls, head, find, du, grep, sed, xargs…). ' +
      'Write paths with forward slashes — C:/Users/me/file or /c/Users/me/file; a backslash is an escape character in bash, and paths with spaces need quotes. ' +
      'For a Windows-only program call it explicitly: cmd //c "ver" (two slashes, or bash rewrites /c as a path) or powershell -NoProfile -Command "…". ';
  }
  return 'On Windows, commands are parsed by ComSpec (usually cmd.exe), not Bash or PowerShell — bash is not available on this machine. ' +
    'Single quotes do not protect a command from cmd.exe pipes. For PowerShell scripts, prefer powershell.exe -NoProfile -EncodedCommand with UTF-16LE Base64, ' +
    'or a verified .ps1 file via -File; avoid nested shell quoting and do not assume Unix escaping. ';
}

/** One line for the environment section: which shell run_bash really is. */
export function hostShellSummary(platform: NodeJS.Platform = process.platform, shell: HostShell = hostShell(platform)): string {
  if (platform !== 'win32') return platform === 'darwin' ? '/bin/sh (bash-compatible)' : '/bin/sh';
  return shell.kind === 'bash'
    ? 'bash (Git for Windows) — same commands as macOS/Linux; paths as C:/… or /c/…'
    : 'cmd.exe (not bash — no bash on this machine)';
}

/**
 * MSYS spelling of a Windows path → Windows spelling: `/c/Users/x` → `C:\Users\x`, `/c` → `C:\`.
 * Anything else comes back unchanged. Bash prints paths in the MSYS form (`pwd`, `find`), and the model
 * hands them straight to the file tools; Node on Windows would read `/c/Users` as `<current drive>:\c\Users`.
 */
export function msysToWindowsPath(p: string): string {
  // MSYS drops `.` / `..` before it maps the drive (`/c/../c/x` is C:\x, not C:\c\x); do the same, or the
  // credential check looks at a different file than the one bash opens.
  const n = p.startsWith('/') && !p.startsWith('//') ? path.posix.normalize(p) : p;
  const m = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(n);
  if (!m) return p;
  return `${m[1].toUpperCase()}:\\${(m[2] || '').replace(/\//g, '\\')}`;
}

/** File-tool path input on this machine: on Windows, accept the MSYS form bash prints. Elsewhere unchanged. */
export function fromShellPath(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? msysToWindowsPath(p) : p;
}

/** Windows path → the form bash shows (`C:\Users\x` → `/c/Users/x`). Used to tell the model both spellings. */
export function windowsToMsysPath(p: string): string {
  const m = /^([a-zA-Z]):[\\/]?(.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, '/');
  const rest = m[2].replace(/\\/g, '/').replace(/\/+$/, '');
  return `/${m[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
}
