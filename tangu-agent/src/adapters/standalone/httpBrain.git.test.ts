/**
 * 云端接缝的 Forsion Git 服务(httpBrain.git;对端 server microserver/git 的 /api/git/info 与 /api/git/credential):
 *   - 没配云端地址 / 没登录(token 为空)→ 没有这个服务(推拉照现状,不发任何请求)
 *   - info:不带登录头;200 → 站点;旧云端 404 / 形状不对 → 没配;5xx / 连不上 → 抛 GitHostingError(调用方当作读不到)
 *   - credential:带登录头与设备名;200 → { webUrl, username, password };409 / 429 / 503 / 502 → GitHostingError 带对端的
 *     status、code、webUrl,**不带响应体原文**;连不上 → status 0;200 但缺字段 → 502 BAD_RESPONSE
 *
 * 负对照(2026-10-10 各改一处实跑,对应的用例红):
 *   - httpBrain 末尾不 `delete brain.git` → 「没有这个服务」红
 *   - info 的请求带上 authHeaders() → 「info 不带登录头」红
 *   - credential 失败时把 code / webUrl 丢掉 → 「失败带对端的 status / code / webUrl」红
 *   - credential 失败时把响应体原文拼进错误 → 「不带响应体原文」红
 *   - credential 不查用户名 / 令牌在不在 → 「没有用户名 / 令牌 → 502 BAD_RESPONSE」红
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHostingError } from '../../seams/cloudBrain.js';
import { createHttpBrain } from './httpBrain.js';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const brainWith = (handler: (url: string, init?: RequestInit) => Promise<Response>) => {
  const fetch = vi.fn(handler);
  vi.stubGlobal('fetch', fetch);
  return { git: createHttpBrain({ cloudUrl: 'https://server.example/', token: 'forsion-session' }).git!, fetch };
};
const failure = async (p: Promise<unknown>): Promise<GitHostingError> => {
  try { await p; } catch (e) { if (e instanceof GitHostingError) return e; throw e; }
  throw new Error('expected a GitHostingError');
};

describe('httpBrain.git', () => {
  it('没配云端地址 / 没登录 → 没有这个服务,也不发请求', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(createHttpBrain({ cloudUrl: '', token: 'forsion-session' }).git).toBeUndefined();
    expect(createHttpBrain({ cloudUrl: 'https://server.example', token: '' }).git).toBeUndefined();
    expect(createHttpBrain({ cloudUrl: 'https://server.example', token: 'forsion-session' }).git).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('info:不带登录头;站点 / 没配 / 旧云端 404 / 形状不对', async () => {
    const answers: Response[] = [
      json({ configured: true, webUrl: 'https://git.forsion.test', credentials: true }),
      json({ configured: true, webUrl: 'https://git.forsion.test' }),
      json({ configured: false }),
      json({ detail: 'Not found' }, 404),
      json({ configured: true }),
    ];
    const { git, fetch } = brainWith(async () => answers.shift()!);
    expect(await git.info()).toEqual({ configured: true, webUrl: 'https://git.forsion.test', credentials: true });
    expect(await git.info()).toEqual({ configured: true, webUrl: 'https://git.forsion.test', credentials: false });
    expect(await git.info()).toEqual({ configured: false });
    expect(await git.info()).toEqual({ configured: false });
    expect(await git.info()).toEqual({ configured: false });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://server.example/api/git/info');
    expect(JSON.stringify(init.headers ?? {})).not.toContain('forsion-session'); // info 不带登录头
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('info:5xx / 连不上 → GitHostingError(调用方当作读不到)', async () => {
    expect((await failure(brainWith(async () => json({ detail: 'boom' }, 500)).git.info())).status).toBe(500);
    expect((await failure(brainWith(async () => { throw new TypeError('fetch failed'); }).git.info())).status).toBe(0);
  });

  it('credential:带登录头与设备名;200 → 用户名与令牌', async () => {
    const { git, fetch } = brainWith(async () => json({ webUrl: 'https://git.forsion.test', username: 'dave', password: 'tok-issued' }));
    expect(await git.credential('daves-mac')).toEqual({ webUrl: 'https://git.forsion.test', username: 'dave', password: 'tok-issued' });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://server.example/api/git/credential');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer forsion-session');
    expect(JSON.parse(String(init.body))).toEqual({ device: 'daves-mac' });
  });

  it('credential:失败带对端的 status / code / webUrl,不带响应体原文', async () => {
    const cases: Array<[number, Record<string, unknown>, { status: number; code: string; webUrl?: string }]> = [
      [409, { detail: 'This account has no Forsion Git account yet', code: 'GIT_NEEDS_SETUP', webUrl: 'https://git.forsion.test', needsSetup: 'username' }, { status: 409, code: 'GIT_NEEDS_SETUP', webUrl: 'https://git.forsion.test' }],
      [429, { detail: 'slow down', code: 'GIT_CREDENTIAL_RATE_LIMITED' }, { status: 429, code: 'GIT_CREDENTIAL_RATE_LIMITED', webUrl: undefined }],
      [503, { code: 'GIT_CREDENTIALS_NOT_CONFIGURED' }, { status: 503, code: 'GIT_CREDENTIALS_NOT_CONFIGURED', webUrl: undefined }],
      [502, { code: 'GIT_UNAVAILABLE', password: 'tok-must-not-leak' }, { status: 502, code: 'GIT_UNAVAILABLE', webUrl: undefined }],
      [401, { detail: 'Invalid token' }, { status: 401, code: '', webUrl: undefined }],
    ];
    for (const [status, body, expected] of cases) {
      const e = await failure(brainWith(async () => json(body, status)).git.credential('daves-mac'));
      expect({ status: e.status, code: e.code, webUrl: e.webUrl }, String(status)).toEqual(expected);
      expect(`${e.message} ${JSON.stringify(e)}`).not.toMatch(/tok-must-not-leak|slow down|Invalid token|no Forsion Git account/);
    }
  });

  it('credential:连不上 → status 0;200 但没有用户名 / 令牌 → 502 BAD_RESPONSE', async () => {
    expect((await failure(brainWith(async () => { throw new TypeError('fetch failed'); }).git.credential('m'))).status).toBe(0);
    const bad = await failure(brainWith(async () => json({ webUrl: 'https://git.forsion.test', username: 'dave' })).git.credential('m'));
    expect({ status: bad.status, code: bad.code }).toEqual({ status: 502, code: 'BAD_RESPONSE' });
  });
});
