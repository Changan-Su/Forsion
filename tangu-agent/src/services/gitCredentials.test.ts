/**
 * 按远端主机取 git 凭据的接缝(纯逻辑,不起 git、不连网;连真 git 的那一半见 gitActions.credentials.test.ts,
 * 连真 Gitea 的见 scripts/git-credentials.gitea.mjs):
 *   - 只有 https 远端、且 URL 里没有自带用户名 / 口令时才有 origin
 *   - 三项环境变量的样子;env 里已有 GIT_CONFIG_COUNT 时接着编号
 *   - 没有提供方 / 没人认领 → 空;按登记顺序,第一个给出凭据的算数;同一个 id 再登记是替换
 *   - 提供方抛普通异常 = 不认领;抛 fallback 的 GitCredentialError = 记下、照没有凭据继续;抛不带 fallback 的 = 原样抛出
 *   - 认证失败后的重取:只把被拒的那一枚交给给出它的提供方作废;拿回同一枚就停手
 *   - 认证失败的原文认得出来(403 不算);带凭据时摘跟踪开关;回显前遮密文
 *
 * 负对照(2026-10-10 各改一处实跑,对应的用例红):
 *   - credentialOrigin 去掉 `protocol !== 'https:'` → 「只有 https…」红(http 远端也拿到了 origin)
 *   - credentialOrigin 去掉 `url.username || url.password` → 同一条红
 *   - gitCredentialConfig 把 index 写死成 0 → 「已有 GIT_CONFIG_COUNT…」红
 *   - gitCredentialEnv 里把 `if (!e.fallback) throw e` 删掉 → 「到此为止」那条红
 *   - gitCredentialEnv 里 catch 不再 continue、改成原样抛 → 「普通异常 = 不认领」红
 *   - refreshGitCredential 去掉「拿回同一枚 → 空」→ 「拿回同一枚就停手」红
 *   - isGitAuthFailure 的正则加上 403 → 「403 不算」红
 *   - scrubGitSecrets 去掉按字面遮的那个循环 → 「回显前遮密文」红
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GitCredentialError, credentialOrigin, gitCredentialConfig, gitCredentialEnv, isGitAuthFailure, refreshGitCredential,
  registerGitCredentialProvider, resetGitCredentialProvidersForTest, scrubGitSecrets, stripGitTraceEnv,
} from './gitCredentials.js';

const ORIGIN = 'https://git.example.test';
const REMOTE = `${ORIGIN}/dave/hello.git`;
const CRED = { username: 'dave', password: 'tok-first' };
const B64 = Buffer.from('dave:tok-first').toString('base64');

afterEach(() => resetGitCredentialProvidersForTest());

describe('credentialOrigin', () => {
  it('只有 https 远端、且 URL 里没有自带用户名 / 口令时才有 origin', () => {
    expect(credentialOrigin(REMOTE)).toBe(ORIGIN);
    expect(credentialOrigin('  HTTPS://Git.Example.Test:443/a/b.git\n')).toBe(ORIGIN); // 主机名小写、缺省端口省略
    expect(credentialOrigin('https://git.example.test:8443/a/b.git')).toBe('https://git.example.test:8443');
    for (const url of [
      'http://git.example.test/a/b.git', 'ssh://git@git.example.test/a/b.git', 'git@git.example.test:a/b.git',
      'https://dave:secret@git.example.test/a/b.git', 'https://token@git.example.test/a/b.git',
      '/srv/git/b.git', '../b.git', 'C:\\repos\\b.git', 'file:///srv/git/b.git', '',
    ]) expect(credentialOrigin(url), url).toBeNull();
  });
});

describe('gitCredentialConfig', () => {
  it('三项:计数、按 origin 限定的 extraheader 键、Basic 头', () => {
    expect(gitCredentialConfig(ORIGIN, CRED, {})).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://git.example.test/.extraheader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${B64}`,
    });
  });

  it('已有 GIT_CONFIG_COUNT 时接着编号,不覆盖别人的那几项', () => {
    expect(gitCredentialConfig(ORIGIN, CRED, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '1', GIT_CONFIG_KEY_1: 'c.d', GIT_CONFIG_VALUE_1: '2' })).toEqual({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_2: 'http.https://git.example.test/.extraheader',
      GIT_CONFIG_VALUE_2: `Authorization: Basic ${B64}`,
    });
    // 不是数的计数当作没有
    expect(gitCredentialConfig(ORIGIN, CRED, { GIT_CONFIG_COUNT: 'x' }).GIT_CONFIG_COUNT).toBe('1');
  });
});

describe('gitCredentialEnv', () => {
  it('没有提供方 / 不是 https / 没人认领 → 空,提供方只在 https 远端上被问到', async () => {
    expect(await gitCredentialEnv(REMOTE, {})).toEqual({ env: {}, secrets: [] });
    const lookup = vi.fn(async () => null);
    registerGitCredentialProvider('none', lookup);
    expect(await gitCredentialEnv(REMOTE, {})).toEqual({ env: {}, secrets: [] });
    expect(lookup).toHaveBeenCalledWith(ORIGIN);
    lookup.mockClear();
    for (const url of ['http://git.example.test/a.git', 'git@git.example.test:a.git', '/srv/a.git', 'https://u:p@git.example.test/a.git']) {
      expect(await gitCredentialEnv(url, {}), url).toEqual({ env: {}, secrets: [] });
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('按登记顺序问,第一个给出凭据的算数;给出的是那三项 + 要遮的密文 + 这一枚的来历', async () => {
    const second = vi.fn(async () => ({ username: 'other', password: 'tok-other' }));
    registerGitCredentialProvider('skip', async () => null);
    registerGitCredentialProvider('first', async (origin) => (origin === ORIGIN ? CRED : null));
    registerGitCredentialProvider('second', second);
    const grant = await gitCredentialEnv(REMOTE, { GIT_CONFIG_COUNT: '1' });
    expect(grant).toEqual({
      env: { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_1: 'http.https://git.example.test/.extraheader', GIT_CONFIG_VALUE_1: `Authorization: Basic ${B64}` },
      secrets: ['tok-first', B64], origin: ORIGIN, credential: CRED, providerId: 'first',
    });
    expect(second).not.toHaveBeenCalled();
  });

  it('同一个 id 再登记 = 替换;注销之后不再被问到', async () => {
    registerGitCredentialProvider('p', async () => CRED);
    const off = registerGitCredentialProvider('p', async () => ({ username: 'dave', password: 'tok-new' }));
    expect((await gitCredentialEnv(REMOTE, {})).credential?.password).toBe('tok-new');
    off();
    expect(await gitCredentialEnv(REMOTE, {})).toEqual({ env: {}, secrets: [] });
  });

  it('提供方抛普通异常 / 给出不成形的东西 = 不认领,动作不多出报错', async () => {
    registerGitCredentialProvider('broken', async () => { throw new Error('cloud is down'); });
    registerGitCredentialProvider('shapeless', (async () => ({ username: 'dave', password: '' })) as never);
    expect(await gitCredentialEnv(REMOTE, {})).toEqual({ env: {}, secrets: [] });
    registerGitCredentialProvider('good', async () => CRED);
    expect((await gitCredentialEnv(REMOTE, {})).providerId).toBe('good');
  });

  it('带话的失败:fallback → 记下并照没有凭据继续(后面的提供方给得出就用它的);到此为止的 → 原样抛出', async () => {
    const soft = new GitCredentialError('x_rate_limited', 'asked too often', undefined, true);
    registerGitCredentialProvider('soft', async () => { throw soft; });
    expect(await gitCredentialEnv(REMOTE, {})).toEqual({ env: {}, secrets: [], unavailable: soft });
    const off = registerGitCredentialProvider('good', async () => CRED);
    expect(await gitCredentialEnv(REMOTE, {})).toMatchObject({ credential: CRED, providerId: 'good' });
    off();
    const hard = new GitCredentialError('x_needs_setup', 'no account yet', 'https://git.example.test');
    registerGitCredentialProvider('hard', async () => { throw hard; });
    await expect(gitCredentialEnv(REMOTE, {})).rejects.toBe(hard);
  });
});

describe('refreshGitCredential', () => {
  it('把被拒的那一枚交给给出它的提供方作废,再取一次', async () => {
    let current = CRED;
    const invalidate = vi.fn((_origin: string, rejected: { password: string }) => { if (rejected.password === current.password) current = { username: 'dave', password: 'tok-second' }; });
    const bystander = vi.fn();
    registerGitCredentialProvider('bystander', { credentials: async () => null, invalidate: bystander });
    registerGitCredentialProvider('mine', { credentials: async () => current, invalidate });
    const first = await gitCredentialEnv(REMOTE, {});
    const next = await refreshGitCredential(REMOTE, first, {});
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith(ORIGIN, CRED);
    expect(bystander).not.toHaveBeenCalled();
    expect(next.credential).toEqual({ username: 'dave', password: 'tok-second' });
    expect(next.secrets).toContain('tok-second');
  });

  it('拿回同一枚就停手(没有 credential);这次本来就没带凭据 → 什么也不做', async () => {
    const lookup = vi.fn(async () => CRED);
    registerGitCredentialProvider('static', lookup);
    const first = await gitCredentialEnv(REMOTE, {});
    expect((await refreshGitCredential(REMOTE, first, {})).credential).toBeUndefined();
    lookup.mockClear();
    expect(await refreshGitCredential(REMOTE, { env: {}, secrets: [] }, {})).toEqual({ env: {}, secrets: [] });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('重取时提供方说暂时取不到 → 带回 unavailable,没有 credential', async () => {
    let calls = 0;
    const soft = new GitCredentialError('x_rate_limited', 'asked too often', undefined, true);
    registerGitCredentialProvider('limited', async () => { if (calls++) throw soft; return CRED; });
    const first = await gitCredentialEnv(REMOTE, {});
    expect(await refreshGitCredential(REMOTE, first, {})).toEqual({ env: {}, secrets: [], unavailable: soft });
  });
});

describe('回显与跟踪', () => {
  it('认证失败的原文认得出来;403 不算', () => {
    for (const text of [
      "fatal: could not read Username for 'https://git.example.test': terminal prompts disabled",
      "remote: Unauthorized\nfatal: Authentication failed for 'https://git.example.test/dave/hello.git/'",
      'error: RPC failed; HTTP 401 curl 22 The requested URL returned error: 401',
      "fatal: could not read Password for 'https://dave@git.example.test': terminal prompts disabled",
    ]) expect(isGitAuthFailure(text), text).toBe(true);
    for (const text of [
      "fatal: unable to access 'https://git.example.test/bob/private.git/': The requested URL returned error: 403",
      "remote: Repository not found.\nfatal: repository 'https://git.example.test/x/y.git/' not found",
      ' ! [rejected]        main -> main (non-fast-forward)',
      "fatal: unable to access 'https://git.example.test/': Could not resolve host: git.example.test",
    ]) expect(isGitAuthFailure(text), text).toBe(false);
  });

  it('带凭据的子进程摘掉 GIT_TRACE* / GIT_CURL_VERBOSE,别的不动', () => {
    const env: NodeJS.ProcessEnv = { GIT_TRACE: '1', GIT_TRACE_CURL: '/tmp/x', GIT_TRACE2_EVENT: '1', GIT_CURL_VERBOSE: '1', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh', PATH: '/bin' };
    stripGitTraceEnv(env);
    expect(env).toEqual({ GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh', PATH: '/bin' });
  });

  it('回显前遮密文:按字面遮这次用过的,再遮任何 Authorization 头的值', () => {
    const text = `=> Send header: Authorization: Basic ${B64}\nremote said tok-first is revoked\n=> Send header: authorization: Bearer abc.def.ghi\nfatal: failed`;
    const out = scrubGitSecrets(text, ['tok-first', B64]);
    expect(out).toBe('=> Send header: Authorization: Basic ***\nremote said *** is revoked\n=> Send header: authorization: Bearer ***\nfatal: failed');
    expect(scrubGitSecrets('nothing secret here', ['', 'tok-first'])).toBe('nothing secret here');
  });
});
