import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authFile } from '../core/tanguHome.js';
import { loginFlow } from './login.js';

vi.mock('../utils/openBrowser.js', () => ({ openBrowser: () => {} }));

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

describe('tangu login × auth.json', () => {
  let home: string;
  const fetchMock = vi.fn(async (url: string) => (String(url).endsWith('/start')
    ? json({ device_code: 'd', user_code: 'u', verification_uri: 'https://a.test/v', interval: 0.001 })
    : json({ status: 'approved', token: 'new-token' })));

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tangu-login-'));
    vi.stubEnv('TANGU_HOME', home);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
  });

  it('坏文件:开始授权之前就拒绝,不发请求,文件不动', async () => {
    writeFileSync(authFile(), '{"cloudUrl":');
    await expect(loginFlow('https://a.test')).rejects.toThrow('exit 1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readFileSync(authFile(), 'utf8')).toBe('{"cloudUrl":');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('unreadable'));
  });

  it('好文件:写入新 token,保留记住的 model', async () => {
    writeFileSync(authFile(), JSON.stringify({ cloudUrl: 'https://old.test', token: 'old', model: 'm' }));
    await loginFlow('https://a.test/');
    expect(JSON.parse(readFileSync(authFile(), 'utf8'))).toEqual({ cloudUrl: 'https://a.test', token: 'new-token', model: 'm' });
  });
});
