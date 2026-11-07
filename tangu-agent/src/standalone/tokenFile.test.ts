/**
 * 令牌文件(cloud.tokenFile)。读失败 ≠ 空:读不到时保留上一个好令牌,绝不把长跑实例打成未登录。
 * 负对照(实跑见红):tokenFileSource 改成无条件 last = token → 「读失败保留」整组红;
 * httpBrain 那条把现读函数换成启动时的固定串 → 「换发后下一次请求用新令牌」红。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloudCredential, readTokenFile, tokenFileSource } from './tokenFile.js';
import { createHttpBrain } from '../adapters/standalone/httpBrain.js';
import { parseConfig } from './config.js';

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'token-file-')); file = path.join(dir, 'auth.json'); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe('readTokenFile', () => {
  it('reads the token field of a JSON file, ignoring the rest', () => {
    writeFileSync(file, JSON.stringify({ token: 'tok-1', cloudUrl: 'https://x', userId: 'u' }));
    expect(readTokenFile(file)).toBe('tok-1');
  });

  it('reads plain text', () => {
    writeFileSync(file, 'tok-1\n');
    expect(readTokenFile(file)).toBe('tok-1');
  });

  it.each([['empty', ''], ['only spaces', '   \n'], ['broken JSON', '{"token":'], ['JSON without a token', '{"cloudUrl":"x"}'], ['a non-string token', '{"token":1}'], ['an empty token', '{"token":""}'], ['text with spaces', 'not a token at all']])('finds nothing in a file with %s', (_name, body) => {
    writeFileSync(file, body);
    expect(readTokenFile(file)).toBe('');
  });

  it('finds nothing when the file is missing', () => {
    expect(readTokenFile(path.join(dir, 'absent'))).toBe('');
  });
});

describe('tokenFileSource', () => {
  it('picks up a rotated token on the next call', () => {
    writeFileSync(file, '{"token":"tok-1"}');
    const next = tokenFileSource(file);
    expect(next()).toBe('tok-1');
    writeFileSync(file, '{"token":"tok-2"}');
    expect(next()).toBe('tok-2');
  });

  it.each([['a zero-byte file', () => writeFileSync(file, '')], ['half-written JSON', () => writeFileSync(file, '{"tok')], ['a deleted file', () => rmSync(file)]])('keeps the last good token through %s', (_name, damage) => {
    writeFileSync(file, '{"token":"tok-1"}');
    const next = tokenFileSource(file);
    expect(next()).toBe('tok-1');
    damage();
    expect(next()).toBe('tok-1');
    expect(next()).toBe('tok-1');
    writeFileSync(file, '{"token":"tok-2"}');
    expect(next()).toBe('tok-2');
  });

  it('starts from the configured token until the file is readable', () => {
    const next = tokenFileSource(file, 'boot');
    expect(next()).toBe('boot');
    writeFileSync(file, 'tok-1');
    expect(next()).toBe('tok-1');
  });
});

describe('cloudCredential', () => {
  it('stays the plain string without a token file', () => {
    expect(cloudCredential({ token: 'static' })).toBe('static');
  });

  it('prefers the file over the static token', () => {
    writeFileSync(file, 'from-file');
    const credential = cloudCredential({ token: 'static', tokenFile: file });
    expect(typeof credential === 'function' ? credential() : credential).toBe('from-file');
  });

  it('sends the rotated token on the next request of a running brain', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: any) => {
      seen.push(new Headers(init?.headers).get('authorization') || '');
      return new Response(JSON.stringify({ broadcasts: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    writeFileSync(file, '{"token":"tok-1"}');
    const brain = createHttpBrain({ cloudUrl: 'https://cloud.example', token: cloudCredential({ token: 'boot', tokenFile: file }) });
    await brain.inbox!.listBroadcasts('2026-10-31 00:00:00');
    writeFileSync(file, '{"token":"tok-2"}');
    await brain.inbox!.listBroadcasts('2026-10-31 00:00:00');
    writeFileSync(file, '');
    await brain.inbox!.listBroadcasts('2026-10-31 00:00:00');
    expect(seen).toEqual(['Bearer tok-1', 'Bearer tok-2', 'Bearer tok-2']);
  });
});

describe('config', () => {
  it('seeds the token from the file for the checks and the local credential', () => {
    writeFileSync(file, '{"token":"from-file"}');
    vi.stubEnv('TANGU_TOKEN_FILE', file);
    const cfg = parseConfig([]);
    expect(cfg.tokenFile).toBe(file);
    expect(cfg.token).toBe('from-file');
  });

  it('takes --token-file over the environment', () => {
    writeFileSync(file, 'from-flag');
    vi.stubEnv('TANGU_TOKEN_FILE', path.join(dir, 'other'));
    expect(parseConfig(['--token-file', file]).token).toBe('from-flag');
  });

  it('keeps a configured token when the file cannot be read at start', () => {
    vi.stubEnv('TANGU_TOKEN', 'static');
    vi.stubEnv('TANGU_TOKEN_FILE', path.join(dir, 'absent'));
    expect(parseConfig([]).token).toBe('static');
  });

  it('changes nothing without a token file', () => {
    vi.stubEnv('TANGU_TOKEN', 'static');
    vi.stubEnv('TANGU_TOKEN_FILE', '');
    const cfg = parseConfig([]);
    expect(cfg.token).toBe('static');
    expect(cfg.tokenFile).toBeUndefined();
  });
});
