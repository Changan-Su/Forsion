import { afterEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import { HOST_TOOLS } from '../tools/hostExec.js';
import type { ToolContext } from '../tools/toolTypes.js';
import { _resetRunSecretEnv, clearRunSecretEnv, normalizeSecretEnv, redactRunSecrets, runSecretEnv, setRunSecretEnv } from './runSecretEnv.js';

const SECRET = 'SESSDATA=abc123def456; bili_jct=zzzz9999';

afterEach(() => _resetRunSecretEnv());

describe('normalizeSecretEnv', () => {
  it('accepts upper-case names with string values and drops blanks', () => {
    expect(normalizeSecretEnv({ BLUEBIRD_COOKIE: SECRET, EMPTY_ONE: '  ' })).toEqual({ BLUEBIRD_COOKIE: SECRET });
    expect(normalizeSecretEnv(undefined)).toEqual({});
  });
  it('rejects bad shapes, reserved names and engine prefixes', () => {
    expect(normalizeSecretEnv('x')).toBeNull();
    expect(normalizeSecretEnv(['x'])).toBeNull();
    expect(normalizeSecretEnv({ lower: 'x' })).toBeNull();
    expect(normalizeSecretEnv({ PATH: '/tmp' })).toBeNull();
    expect(normalizeSecretEnv({ NODE_OPTIONS: '--require x' })).toBeNull();
    expect(normalizeSecretEnv({ TANGU_TOKEN: 'x' })).toBeNull();
    expect(normalizeSecretEnv({ FORSION_X: 'x' })).toBeNull();
    expect(normalizeSecretEnv({ ABC: 1 })).toBeNull();
    expect(normalizeSecretEnv({ ABC: 'a\0b' })).toBeNull();
    expect(normalizeSecretEnv(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`KEY_${i}`, 'v'])))).toBeNull();
  });
});

describe('per-run store', () => {
  it('is scoped to the run, empty for remote runs, and cleared at the end', () => {
    setRunSecretEnv('r1', { BLUEBIRD_COOKIE: SECRET });
    expect(runSecretEnv({ runId: 'r1' })).toEqual({ BLUEBIRD_COOKIE: SECRET });
    expect(runSecretEnv({ runId: 'r2' })).toEqual({});
    expect(runSecretEnv({ runId: 'r1', remote: { via: 'unit' } })).toEqual({});
    clearRunSecretEnv('r1');
    expect(runSecretEnv({ runId: 'r1' })).toEqual({});
  });
  it('redacts the value from text', () => {
    setRunSecretEnv('r1', { BLUEBIRD_COOKIE: SECRET });
    expect(redactRunSecrets({ runId: 'r1' }, `got ${SECRET} ok`)).toBe('got [REDACTED:BLUEBIRD_COOKIE] ok');
    expect(redactRunSecrets({ runId: 'r2' }, `got ${SECRET}`)).toBe(`got ${SECRET}`);
    // 只露出其中一项、或只露出值,也抹掉
    expect(redactRunSecrets({ runId: 'r1' }, 'a SESSDATA=abc123def456 b')).not.toContain('abc123def456');
    expect(redactRunSecrets({ runId: 'r1' }, 'v=abc123def456')).toBe('v=[REDACTED:BLUEBIRD_COOKIE]');
  });
});

describe('run_bash', () => {
  const ctx = (runId: string): ToolContext => ({ runId, sessionId: 's', userId: 'u', cwd: os.tmpdir() } as unknown as ToolContext);
  it.skipIf(process.platform === 'win32')('passes the secret to the script but never shows it to the model', async () => {
    setRunSecretEnv('r1', { BLUEBIRD_COOKIE: SECRET });
    const out = await HOST_TOOLS.run_bash.execute({ command: 'printf "len=%s\\n" "${#BLUEBIRD_COOKIE}"; printf "%s" "$BLUEBIRD_COOKIE"', timeout_ms: 5000 }, ctx('r1'));
    expect(out).toContain(`len=${SECRET.length}`);
    expect(out).toContain('[REDACTED:BLUEBIRD_COOKIE]');
    expect(out).not.toContain('abc123def456');
  });
  it.skipIf(process.platform === 'win32')('background processes do not get it', async () => {
    const { startBackgroundProcess, disposeAllProcesses } = await import('../tools/processRegistry.js');
    const { mkdtempSync, readFileSync, existsSync } = await import('node:fs');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'secret-bg-'));
    setRunSecretEnv('r1', { BLUEBIRD_COOKIE: SECRET });
    startBackgroundProcess('s', `printf "len=%s" "\${#BLUEBIRD_COOKIE}" > "${dir}/out.txt"`, dir, ctx('r1'));
    for (let i = 0; i < 40 && !existsSync(`${dir}/out.txt`); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100));
    disposeAllProcesses();
    expect(readFileSync(`${dir}/out.txt`, 'utf8')).toBe('len=0');
  });
  it.skipIf(process.platform === 'win32')('other runs do not see it', async () => {
    setRunSecretEnv('r1', { BLUEBIRD_COOKIE: SECRET });
    const out = await HOST_TOOLS.run_bash.execute({ command: 'printf "len=%s" "${#BLUEBIRD_COOKIE}"', timeout_ms: 5000 }, ctx('r2'));
    expect(out).toContain('len=0');
  });
});
