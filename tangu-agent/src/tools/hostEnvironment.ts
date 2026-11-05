/**
 * The "this computer" lines of the host environment section: system, the shell run_bash really uses, home,
 * notes vault, this device's name and which command-line tools are on PATH. Without them the model guesses
 * (and writes bash for cmd.exe, or `C:\` paths for a Mac).
 *
 * Every value is stable for the life of the engine process, so the system prompt prefix stays cacheable:
 * no clock, no counts. Reads that fail fall back quietly — the section must never break a run.
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forsionSharedDir } from '../core/tanguHome.js';
import { hostShell, hostShellSummary, windowsToMsysPath, type HostShell } from './hostShell.js';

export interface MachineFacts {
  platform: NodeJS.Platform;
  system: string;
  deviceName: string;
  shell: HostShell;
  home: string;
  vault: string | null;
  tools: string[];
  missing: string[];
}

/** Same rule as Forsion-Extend core/contentSync.ts `prettyHost` (the sync page's default device name):
 *  drop `.local`, dashes / underscores → spaces. Change both together. */
export function prettyHost(h: string): string {
  return h.replace(/\.local$/i, '').replace(/[-_]+/g, ' ').trim() || h;
}

/** This device's name as the user sees it in Forsion sync: the name they gave it on the sync page
 *  (`<forsion home>/content-sync-device.json`, written by Extend), else the default derived from the hostname.
 *  Never the device id. */
export function deviceName(sharedDir: string = forsionSharedDir(), hostname: string = os.hostname()): string {
  try {
    const raw = JSON.parse(readFileSync(path.join(sharedDir, 'content-sync-device.json'), 'utf8'));
    const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
    if (name && name.length <= 64 && !/[\u0000-\u001f\u007f]/.test(name)) return name;
  } catch { /* no sync yet, or unreadable: fall back to the default name */ }
  return prettyHost(hostname);
}

let macVersion: string | null | undefined;
function macProductVersion(): string | null {
  if (macVersion !== undefined) return macVersion;
  try {
    const plist = readFileSync('/System/Library/CoreServices/SystemVersion.plist', 'utf8');
    macVersion = /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim() || null;
  } catch { macVersion = null; }
  return macVersion;
}

export function systemLabel(platform: NodeJS.Platform = process.platform, release = os.release(), arch = process.arch): string {
  if (platform === 'darwin') {
    const v = platform === process.platform ? macProductVersion() : null;
    return v ? `macOS ${v} (${arch})` : `macOS (Darwin ${release}, ${arch})`;
  }
  if (platform === 'win32') {
    const build = Number(/^\d+\.\d+\.(\d+)/.exec(release)?.[1] || 0);
    return `${build >= 22000 ? 'Windows 11' : 'Windows'} (build ${build || release}, ${arch})`;
  }
  return `${platform === 'linux' ? 'Linux' : platform} ${release} (${arch})`;
}

const toolCache = new Map<string, { tools: string[]; missing: string[] }>();

/** Which of git / python3 / node / npm the shell will find. Windows + bash also searches the Git tree that bash
 *  puts first on PATH (git lives there). `python` is reported only when `python3` is missing. */
export function pathTools(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  shell: HostShell = hostShell(platform, env),
  exists: (p: string) => boolean = existsSync,
): { tools: string[]; missing: string[] } {
  const sep = platform === 'win32' ? ';' : ':';
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const dirs = [...(shell.pathDirs || []), ...String(env[key] || '').split(sep)].map((d) => d.trim()).filter(Boolean);
  const cacheKey = `${platform}|${dirs.join(sep)}`;
  const hit = exists === existsSync ? toolCache.get(cacheKey) : undefined;
  if (hit) return hit;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  // On Windows bash runs extensionless shell shims too (npm ships one next to npm.cmd); cmd.exe needs an extension.
  const exts = platform === 'win32' ? (shell.kind === 'bash' ? ['.exe', '', '.cmd'] : ['.exe', '.cmd', '.bat']) : [''];
  const found = (name: string): boolean => dirs.some((d) => exts.some((e) => exists(join(d, name + e))));
  const tools: string[] = [];
  const missing: string[] = [];
  for (const name of ['git', 'python3', 'node', 'npm']) {
    if (found(name)) tools.push(name);
    else if (name === 'python3' && found('python')) tools.push('python (no python3 here)');
    else missing.push(name);
  }
  const out = { tools, missing };
  if (exists === existsSync) toolCache.set(cacheKey, out);
  return out;
}

/** Read once per process: these lines sit in the system prompt prefix, and a device rename or a new PATH entry
 *  mid-run should not change it (prompt cache). Only the vault can appear later (first-run setup creates it). */
let machineCache: Omit<MachineFacts, 'vault'> | null = null;

export function machineFacts(vault: string | null): MachineFacts {
  if (!machineCache) {
    const shell = hostShell();
    const { tools, missing } = pathTools(process.env, process.platform, shell);
    machineCache = { platform: process.platform, system: systemLabel(), deviceName: deviceName(), shell, home: os.homedir(), tools, missing };
  }
  return { ...machineCache, vault };
}

/** The lines that go into the host environment section. */
export function machineEnvironmentLines(f: MachineFacts): string {
  const both = (p: string): string =>
    f.platform === 'win32' && f.shell.kind === 'bash' ? `\`${p}\` (\`${windowsToMsysPath(p)}\` in run_bash)` : `\`${p}\``;
  const lines = [
    `- This computer: ${f.system}, device name "${f.deviceName}". Home ${both(f.home)}` +
      (f.vault ? `; notes vault ${both(f.vault)}.` : '.'),
    `- run_bash shell: ${hostShellSummary(f.platform, f.shell)}.` +
      ` On PATH: ${f.tools.length ? f.tools.join(', ') : 'none of git / python3 / node / npm'}` +
      (f.missing.length && f.tools.length ? ` (not found: ${f.missing.join(', ')})` : '') + '.',
  ];
  return lines.join('\n') + '\n';
}
