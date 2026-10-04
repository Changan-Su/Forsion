/** provider-auth.json 的读改写:多进程共写 + refresh_token 会轮换,丢一次更新就得重新登录。锁内合并、原子落位。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync, symlinkSync, lstatSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { providerAuthFile } from '../core/tanguHome.js';
import { loadProviderCreds, saveProviderCred, updateProviderCred, type OAuthTokens } from './providerCreds.js';

const tok = (access_token: string, extra: Partial<OAuthTokens> = {}): OAuthTokens => ({ access_token, baseUrl: 'b', tokenEndpoint: 't', clientId: 'c', ...extra });
let home: string;
const prev = process.env.TANGU_HOME;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tangu-creds-')); process.env.TANGU_HOME = home; });
afterEach(() => {
  if (prev === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe('provider-auth.json 读改写', () => {
  it('改一条不动别的;fn 拿到的是盘上此刻那条;返回 undefined 不写', () => {
    saveProviderCred('xai', tok('x1', { refresh_token: 'r1' }));
    saveProviderCred('codex', tok('c1', { account_id: 'acct' }));
    let seen: OAuthTokens | undefined;
    updateProviderCred('xai', (cur) => { seen = cur; return { ...cur!, access_token: 'x2' }; });
    expect(seen?.access_token).toBe('x1');
    expect(loadProviderCreds()).toMatchObject({ xai: { access_token: 'x2', refresh_token: 'r1' }, codex: { access_token: 'c1', account_id: 'acct' } });
    const before = readFileSync(providerAuthFile(), 'utf8');
    updateProviderCred('codex', () => undefined);
    updateProviderCred('nope', (cur) => { expect(cur).toBeUndefined(); return undefined; });
    expect(readFileSync(providerAuthFile(), 'utf8')).toBe(before);
  });

  it('原子落位:0600、不留临时文件、不留锁', () => {
    saveProviderCred('xai', tok('x1'));
    if (process.platform !== 'win32') expect(statSync(providerAuthFile()).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(providerAuthFile())).filter((n) => /\.tmp$|\.lock$/.test(n))).toEqual([]);
  });

  it('fn 抛错:原文件一字不动,锁放掉(下一次写不被卡住)', () => {
    saveProviderCred('xai', tok('x1'));
    const before = readFileSync(providerAuthFile(), 'utf8');
    expect(() => updateProviderCred('xai', () => { throw new Error('boom'); })).toThrow('boom');
    expect(readFileSync(providerAuthFile(), 'utf8')).toBe(before);
    saveProviderCred('xai', tok('x2'));
    expect(loadProviderCreds().xai.access_token).toBe('x2');
  });

  it('文件是软链(live 台架链到开发环境那份):写进真身,链还是链', () => {
    const real = join(home, 'elsewhere', 'provider-auth.json');
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, JSON.stringify({ xai: tok('x1', { refresh_token: 'r1' }) }), 'utf8');
    symlinkSync(real, providerAuthFile());
    updateProviderCred('xai', (cur) => ({ ...cur!, access_token: 'x2', refresh_token: 'r2' }));
    expect(lstatSync(providerAuthFile()).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf8')).xai).toMatchObject({ access_token: 'x2', refresh_token: 'r2' });
  });

  it('文件坏了(半截 JSON)照旧当空处理:登录要能把它救回来', () => {
    saveProviderCred('xai', tok('x1'));
    writeFileSync(providerAuthFile(), '{"xai":', 'utf8');
    saveProviderCred('codex', tok('c1'));
    expect(Object.keys(loadProviderCreds())).toEqual(['codex']);
  });
});
