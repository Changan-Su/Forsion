import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deviceName, machineEnvironmentLines, pathTools, prettyHost, systemLabel, type MachineFacts } from './hostEnvironment.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'tangu-hostenv-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('device name', () => {
  it('uses the name given on the sync page, else the default derived from the hostname (as Extend does)', () => {
    expect(deviceName(tmp, 'Skylers-MacBook-Pro.local')).toBe('Skylers MacBook Pro');
    writeFileSync(path.join(tmp, 'content-sync-device.json'), JSON.stringify({ id: 'secret-device-id', name: '  Studio Mac ' }));
    expect(deviceName(tmp, 'x')).toBe('Studio Mac');
    writeFileSync(path.join(tmp, 'content-sync-device.json'), JSON.stringify({ id: 'secret-device-id' }));
    expect(deviceName(tmp, 'DESKTOP_7Q2')).toBe('DESKTOP 7Q2');
    writeFileSync(path.join(tmp, 'content-sync-device.json'), '{broken');
    expect(deviceName(tmp, 'pc')).toBe('pc');
    expect(prettyHost('--')).toBe('--');
  });
});

describe('system label', () => {
  it('names Windows 11 by build number and keeps the architecture', () => {
    expect(systemLabel('win32', '10.0.26100', 'x64')).toBe('Windows 11 (build 26100, x64)');
    expect(systemLabel('win32', '10.0.19045', 'x64')).toBe('Windows (build 19045, x64)');
    expect(systemLabel('linux', '6.8.0', 'arm64')).toBe('Linux 6.8.0 (arm64)');
  });
});

describe('tools on PATH', () => {
  it('Windows + bash searches the Git tree too and accepts npm’s extensionless shim', () => {
    const files = new Set(['C:\\g\\ucrt64\\bin\\git.exe', 'C:\\py\\python.exe', 'C:\\node\\node.exe', 'C:\\node\\npm']);
    const r = pathTools({ Path: 'C:\\py;C:\\node' }, 'win32', { kind: 'bash', bin: 'C:\\g\\usr\\bin\\bash.exe', pathDirs: ['C:\\g\\ucrt64\\bin', 'C:\\g\\usr\\bin'] }, (p) => files.has(p));
    expect(r.tools).toEqual(['git', 'python (no python3 here)', 'node', 'npm']);
    expect(r.missing).toEqual([]);
  });
  it('reports what is missing', () => {
    const r = pathTools({ PATH: '/opt/bin' }, 'darwin', { kind: 'posix' }, (p) => p === '/opt/bin/git');
    expect(r).toEqual({ tools: ['git'], missing: ['python3', 'node', 'npm'] });
  });
});

describe('environment lines', () => {
  const facts = (over: Partial<MachineFacts>): MachineFacts => ({
    platform: 'darwin', system: 'macOS 26.1 (arm64)', deviceName: 'Studio Mac', shell: { kind: 'posix' },
    home: '/Users/me', vault: '/Users/me/Forsion/Amadeus', tools: ['git', 'python3', 'node', 'npm'], missing: [], ...over,
  });
  it('macOS: system, name, home, vault, shell, tools', () => {
    const t = machineEnvironmentLines(facts({}));
    expect(t).toContain('macOS 26.1 (arm64), device name "Studio Mac"');
    expect(t).toContain('Home `/Users/me`; notes vault `/Users/me/Forsion/Amadeus`.');
    expect(t).toContain('run_bash shell: /bin/sh (bash-compatible). On PATH: git, python3, node, npm.');
  });
  it('Windows + bash: both spellings of every path', () => {
    const t = machineEnvironmentLines(facts({
      platform: 'win32', system: 'Windows 11 (build 26100, x64)', shell: { kind: 'bash', bin: 'C:\\g\\usr\\bin\\bash.exe' },
      home: 'C:\\Users\\me', vault: 'C:\\Users\\me\\Forsion\\Amadeus', missing: [],
    }));
    expect(t).toContain('Home `C:\\Users\\me` (`/c/Users/me` in run_bash); notes vault `C:\\Users\\me\\Forsion\\Amadeus` (`/c/Users/me/Forsion/Amadeus` in run_bash).');
    expect(t).toContain('run_bash shell: bash (Git for Windows)');
  });
  it('Windows without bash says so; no vault, missing tools listed', () => {
    const t = machineEnvironmentLines(facts({ platform: 'win32', shell: { kind: 'cmd' }, home: 'C:\\Users\\me', vault: null, tools: ['git'], missing: ['node', 'npm'] }));
    expect(t).toContain('cmd.exe (not bash');
    expect(t).toContain('Home `C:\\Users\\me`.');
    expect(t).toContain('(not found: node, npm)');
  });
});
