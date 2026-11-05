import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BASH_EVAL_ARGS, RUN_VAR, fromShellPath, hostShellName, hostShellQuoting, hostShellSummary, msysToWindowsPath,
  resolveWindowsShell, windowsBashCandidates, windowsBashEnv, windowsToMsysPath,
} from './hostShell.js';

const bundled = 'C:\\Program Files\\Forsion\\resources\\git\\usr\\bin\\bash.exe';
const only = (...present: string[]) => (p: string) => present.includes(p);

describe('resolveWindowsShell', () => {
  it('uses the bundled bash first and puts the Git tree before PATH', () => {
    const shell = resolveWindowsShell({ TANGU_BASH_BIN: bundled, ProgramFiles: 'C:\\Program Files' },
      only(bundled, 'C:\\Program Files\\Forsion\\resources\\git\\ucrt64\\bin'));
    expect(shell).toEqual({
      kind: 'bash',
      bin: bundled,
      pathDirs: ['C:\\Program Files\\Forsion\\resources\\git\\ucrt64\\bin', 'C:\\Program Files\\Forsion\\resources\\git\\usr\\bin'],
    });
  });

  it('falls back to a standard Git for Windows install, then to cmd.exe', () => {
    const sys = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
    expect(resolveWindowsShell({ ProgramFiles: 'C:\\Program Files' }, only(sys)).bin).toBe(sys);
    expect(resolveWindowsShell({ ProgramFiles: 'C:\\Program Files' }, only()).kind).toBe('cmd');
  });

  it('never picks WSL bash, relative paths, or anything when forced to cmd', () => {
    const wsl = 'C:\\Windows\\System32\\bash.exe';
    expect(resolveWindowsShell({ TANGU_BASH_BIN: wsl }, () => true).kind).toBe('cmd');
    expect(resolveWindowsShell({ TANGU_BASH_BIN: 'bash.exe' }, () => true).kind).toBe('cmd');
    expect(resolveWindowsShell({ TANGU_BASH_BIN: bundled, TANGU_WINDOWS_SHELL: 'cmd' }, () => true).kind).toBe('cmd');
    expect(windowsBashCandidates({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })).toEqual(['C:\\Users\\me\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe']);
  });
});

describe('windowsBashEnv', () => {
  it('keeps PATH key casing, drops entries bash would resolve against the working directory, strips startup hooks', () => {
    const env = windowsBashEnv(
      { Path: 'C:\\Windows\\System32;;.;tools;\\\\server\\share\\bin;//attacker/share/bin;C:\\Tools', BASH_ENV: 'C:\\evil.sh', BASH_FUNC_ls__: '() { evil; }', SHELLOPTS: 'xtrace', HOME: 'C:\\Users\\me' },
      { kind: 'bash', bin: bundled, pathDirs: ['C:\\g\\ucrt64\\bin', 'C:\\g\\usr\\bin'] },
      'ls -t | head -3',
    );
    expect(env.Path).toBe('C:\\g\\ucrt64\\bin;C:\\g\\usr\\bin;C:\\Windows\\System32;C:\\Tools');
    expect(env.PATH).toBeUndefined();
    expect(env.BASH_ENV).toBeUndefined();
    expect(env.BASH_FUNC_ls__).toBeUndefined();
    expect(env.SHELLOPTS).toBeUndefined();
    expect(env.HOME).toBe('C:\\Users\\me');
    expect(env[RUN_VAR]).toBe('ls -t | head -3');
  });
});

describe.runIf(existsSync('/bin/bash'))('the fixed bash argv', () => {
  // The same argv Windows uses, run by this machine's bash: quotes, pipes, exit codes and the variable cleanup survive.
  const run = (command: string) => spawnSync('/bin/bash', BASH_EVAL_ARGS, { env: { ...process.env, [RUN_VAR]: command }, encoding: 'utf8' });
  it('runs the command text verbatim, unset before it runs', () => {
    const r = run(`echo "a b" 'c|d' | tr a-z A-Z; printf '%s\\n' "\${${RUN_VAR}:-gone}"`);
    expect(r.stdout).toBe('A B C|D\ngone\n');
  });
  it('keeps exit codes, multi-line scripts and here-docs', () => {
    expect(run('exit 7').status).toBe(7);
    expect(run('x=1\nif [ "$x" = 1 ]; then\n  cat <<EOF\nhello $x\nEOF\nfi').stdout).toBe('hello 1\n');
  });
});

describe('paths between Windows and bash', () => {
  it('MSYS drive paths become Windows paths for the file tools; others are untouched', () => {
    expect(msysToWindowsPath('/c/Users/me/a b.txt')).toBe('C:\\Users\\me\\a b.txt');
    expect(msysToWindowsPath('/d')).toBe('D:\\');
    expect(msysToWindowsPath('/proc/self')).toBe('/proc/self');
    // MSYS normalizes before it maps the drive: /c/../c/x is C:\x (the file bash opens), not C:\c\x
    expect(msysToWindowsPath('/c/../c/Users/me/auth.json')).toBe('C:\\Users\\me\\auth.json');
    expect(msysToWindowsPath('/c/./Users/../Users/me')).toBe('C:\\Users\\me');
    expect(msysToWindowsPath('/c/..')).toBe('/c/..');
    expect(msysToWindowsPath('relative/path')).toBe('relative/path');
    expect(fromShellPath('/c/x', 'win32')).toBe('C:\\x');
    expect(fromShellPath('/c/x', 'darwin')).toBe('/c/x');
  });
  it('Windows paths are shown to the model in the form bash prints', () => {
    expect(windowsToMsysPath('C:\\Users\\me\\Forsion\\Amadeus')).toBe('/c/Users/me/Forsion/Amadeus');
    expect(windowsToMsysPath('D:\\')).toBe('/d');
  });
});

describe('what the model is told', () => {
  const bash = { kind: 'bash' as const, bin: bundled, pathDirs: [] };
  const cmd = { kind: 'cmd' as const };
  it('names the real shell on each platform', () => {
    expect(hostShellName('darwin')).toBe('/bin/sh -c');
    expect(hostShellName('win32', bash)).toContain('Git for Windows');
    expect(hostShellName('win32', cmd)).toContain('ComSpec');
    expect(hostShellSummary('win32', cmd)).toContain('not bash');
  });
  it('bash on Windows: same commands, forward slashes, cmd //c and powershell for Windows programs', () => {
    const q = hostShellQuoting('win32', bash);
    expect(q).toContain('same commands');
    expect(q).toContain('C:/Users/me/file');
    expect(q).toContain('cmd //c');
    expect(q).toContain('powershell -NoProfile');
    expect(hostShellQuoting('win32', cmd)).toContain('bash is not available');
    expect(hostShellQuoting('linux')).toBe('');
  });
});
