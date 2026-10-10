/**
 * 推送 / 拉取带凭据的那一半:真 git 管仓库现场,**连远端的那一下**(push / fetch 子进程)换成假的 —— 不连网,
 * 断言交给子进程的环境与命令行。连真 Gitea 的端到端见 scripts/git-credentials.gitea.mjs。
 *   - https 远端 + 有提供方认领:子进程环境里有那三项,命令行参数里没有凭据;进程环境里已有 GIT_CONFIG_COUNT 时接着编号
 *   - 没有提供方 / 提供方不认领 / 远端 URL 自带凭据:子进程环境与现在逐字一致(没有那三项,跟踪开关也不动)
 *   - 带凭据的子进程摘掉 GIT_TRACE* / GIT_CURL_VERBOSE、把 Trace2 显式关掉,对这个站点清空凭据助手、关掉 askpass、消息固定成英文,
 *     不递归进子模块(子模块是另一份没过信任闸的仓库配置)
 *   - 认证失败 → 作废重取 → 带新凭据再来一次;一直失败只重试这一次;403 不重试
 *   - 失败原文里的凭据被遮掉(连同任何 Authorization 头)
 *   - 提供方说「暂时取不到」→ 不带凭据照跑:成功就成功,认证失败才报它的 code;说「到此为止」→ 一次 git 都不起,直接报
 *   - 拉取的 fetch 同样带;push 认 pushurl 的主机,fetch 认 url 的主机
 *   - 仓库自带传输配置(http.proxy 之类)时未经信任不带凭据(untrusted_transport,一次 git 都不起);信任后照带;
 *     没有凭据可带时这些配置不拦(现状)
 *   - 仓库配置里以 - 开头的「远端名」不当远端用(会被 git 当成选项):拉取 no_upstream、推送 no_remote,都不起 git
 *
 * 负对照(2026-10-10 各改一处实跑,对应的用例红):
 *   - runAction 里不并 `opts.credentials.env` → 「子进程环境里有那三项」「接着编号」「重取」「拉取的 fetch」红
 *   - runAction 里不调 stripGitTraceEnv → 「带凭据的子进程摘掉跟踪开关」红
 *   - runAction 里不加 `-c credential.<origin>.helper=` / 不清 GIT_ASKPASS / 不设 LANGUAGE → 「清空凭据助手、关掉 askpass…」红(各改一处各红一次)
 *   - runAction 里不遮输出(r = raw)→ 「失败原文里的凭据被遮掉」红
 *   - runRemoteAction 去掉「认证失败 → 重取」那一段 → 「作废重取」红
 *   - runRemoteAction 的重取改成 while 循环 → 「一直失败只重试这一次」红
 *   - runRemoteAction 去掉 `grant.unavailable` 那一句 → 「暂时取不到」红(报成 git_failed)
 *   - runRemoteAction 的 get-url 恒带 `--push` → 「push 认 pushurl,fetch 认 url」红
 *   - gitPush 改回直接 runAction(不经 runRemoteAction)→ 「子进程环境里有那三项」等十条红
 *   - gitPull 的 fetch 改回直接 runAction → 「拉取的 fetch 同样带凭据」红
 *   - runRemoteAction 里「到此为止」的失败也当成没有凭据继续 → 「到此为止 → 一次 git 都不起」红
 *   - runRemoteAction 去掉 `requireTransportTrust` 那一句 → 「仓库自带传输配置时未经信任不带凭据」红
 *   - gitPull / gitPush 去掉以 - 开头的远端名那一句 → 「以 - 开头的远端名」红
 *   - runRemoteAction 带凭据时不插 `--no-recurse-submodules` → 「子进程环境里有那三项」红(命令行对不上)
 *   - stripGitTraceEnv 不把 GIT_TRACE2* 置 0 → 「带凭据的子进程摘掉 GIT_TRACE*」红
 *   - runRemoteAction 不带凭据时也插 → 「没有提供方 / 不认领…与现在一致」红
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface RemoteCall { verb: string; /** 子命令起的那一段。 */ args: string[]; /** 整条命令行。 */ argv: string[]; env: NodeJS.ProcessEnv }
const remoteCalls: RemoteCall[] = [];
/** 每次连远端的子进程由它作答;缺省 = 成功。 */
let answer: (call: RemoteCall, nth: number) => { code: number; stdout?: string; stderr?: string } = () => ({ code: 0 });

vi.mock('../utils/boundedProcess.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../utils/boundedProcess.js')>();
  return {
    ...real,
    runBoundedProcess: (executable: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs: number }) => {
      const verb = args[args.indexOf('-C') + 2];
      if (verb !== 'push' && verb !== 'fetch') return real.runBoundedProcess(executable, args, options);
      const call = { verb, args: args.slice(args.indexOf('-C') + 2), argv: args, env: { ...options.env } };
      remoteCalls.push(call);
      const r = answer(call, remoteCalls.length);
      // 假的 fetch 成功 = 「取回来的就是跟踪引用上那个提交」:真 fetch 会写的 FETCH_HEAD 由这里写
      if (verb === 'fetch' && r.code === 0) {
        const cwd = args[args.indexOf('-C') + 1];
        writeFileSync(path.join(cwd, '.git', 'FETCH_HEAD'), `${git(cwd, 'rev-parse', 'refs/remotes/origin/main')}\t\tbranch 'main' of example\n`);
      }
      return Promise.resolve({ code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '', cleanupTimedOut: false });
    },
  };
});

const { GitActionError, gitPull, gitPush } = await import('./gitActions.js');
const { GitCredentialError, registerGitCredentialProvider, resetGitCredentialProvidersForTest } = await import('./gitCredentials.js');

const ORIGIN = 'https://git.example.test';
const REMOTE = `${ORIGIN}/dave/hello.git`;
const b64 = (password: string): string => Buffer.from(`dave:${password}`).toString('base64');
const AUTH_FAILED = "fatal: could not read Username for 'https://git.example.test': terminal prompts disabled";

let root: string;
const savedEnv = { ...process.env };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
/** 已有一个提交、上游设好(跟踪引用是真的)、远端地址指向 https 主机的仓。 */
const project = (name: string, url = REMOTE): string => {
  const seed = path.join(root, `${name}-seed.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', seed]);
  const cwd = path.join(root, name);
  mkdirSync(cwd);
  git(cwd, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(cwd, 'a.txt'), 'a\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
  git(cwd, 'remote', 'add', 'origin', seed);
  git(cwd, 'push', '-q', '-u', 'origin', 'main');
  git(cwd, 'remote', 'set-url', 'origin', url);
  return cwd;
};
const failure = async (p: Promise<unknown>): Promise<InstanceType<typeof GitActionError>> => {
  try { await p; } catch (e) { if (e instanceof GitActionError) return e; throw e; }
  throw new Error('expected a GitActionError');
};
const credentialKeys = (env: NodeJS.ProcessEnv): string[] => Object.keys(env).filter((k) => /^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(k)).sort();

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'tangu-gitcred-'));
  const globalConfig = path.join(root, 'gitconfig');
  writeFileSync(globalConfig, '');
  mkdirSync(path.join(root, 'tangu-home'));
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', TANGU_HOME: path.join(root, 'tangu-home'),
    GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@example.com',
  });
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});
beforeEach(() => { remoteCalls.length = 0; answer = () => ({ code: 0 }); });
afterEach(() => {
  resetGitCredentialProvidersForTest();
  for (const key of Object.keys(process.env)) if (/^GIT_(TRACE|CURL_VERBOSE|CONFIG_(COUNT|KEY_|VALUE_))/.test(key)) delete process.env[key];
});

describe('带凭据的推送', () => {
  it('https 远端 + 有提供方认领:子进程环境里有那三项,命令行参数里没有凭据', async () => {
    const cwd = project('push-inject');
    const asked: string[] = [];
    registerGitCredentialProvider('test', async (origin) => { asked.push(origin); return { username: 'dave', password: 'tok-1' }; });
    expect(await gitPush(cwd)).toMatchObject({ remote: 'origin', branch: 'main', target: 'origin/main' });
    expect(asked).toEqual([ORIGIN]);
    expect(remoteCalls).toHaveLength(1);
    const [call] = remoteCalls;
    expect(call.args).toEqual(['push', '--no-recurse-submodules', 'origin', 'HEAD:refs/heads/main']); // 带着凭据不递归进子模块
    expect({ count: call.env.GIT_CONFIG_COUNT, key: call.env.GIT_CONFIG_KEY_0, value: call.env.GIT_CONFIG_VALUE_0 }).toEqual({
      count: '1', key: 'http.https://git.example.test/.extraheader', value: `Authorization: Basic ${b64('tok-1')}`,
    });
    expect(call.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(call.argv.join(' ')).not.toMatch(/tok-1|Authorization|extraheader/);
    expect(call.argv.join(' ')).not.toContain(b64('tok-1'));
  });

  it('带凭据的子进程:对这个站点清空凭据助手、关掉 askpass、消息固定成英文;不带凭据的子进程这三样都不动', async () => {
    const cwd = project('push-helpers');
    Object.assign(process.env, { GIT_ASKPASS: '/usr/local/bin/some-askpass', LANGUAGE: 'zh_CN' });
    try {
      await gitPush(cwd); // 没有提供方
      registerGitCredentialProvider('test', async () => ({ username: 'dave', password: 'tok-1' }));
      await gitPush(cwd);
      resetGitCredentialProvidersForTest();
      registerGitCredentialProvider('test', async () => { throw new GitCredentialError('x_rate_limited', 'asked too often', undefined, true); });
      await gitPush(cwd); // 提供方说暂时取不到:照用户自己的凭据流程跑(助手 / askpass 不动),只把消息固定成英文
      const helperReset = ['-c', 'credential.https://git.example.test.helper='];
      const shape = (c: RemoteCall) => ({ reset: helperReset.every((part) => c.argv.includes(part)), askpass: c.env.GIT_ASKPASS, language: c.env.LANGUAGE });
      expect(remoteCalls.map(shape)).toEqual([
        { reset: false, askpass: '/usr/local/bin/some-askpass', language: 'zh_CN' },
        { reset: true, askpass: '', language: 'en' },
        { reset: false, askpass: '/usr/local/bin/some-askpass', language: 'en' },
      ]);
      // 清空助手的那一项排在 -C 之前(是 git 自己的选项,不是子命令的)
      expect(remoteCalls[1].argv.indexOf('credential.https://git.example.test.helper=')).toBeLessThan(remoteCalls[1].argv.indexOf('-C'));
    } finally { delete process.env.GIT_ASKPASS; delete process.env.LANGUAGE; }
  });

  it('进程环境里已有 GIT_CONFIG_COUNT 时接着编号,别人的那几项原样还在', async () => {
    const cwd = project('push-count');
    Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'advice.detachedHead', GIT_CONFIG_VALUE_0: 'false' });
    registerGitCredentialProvider('test', async () => ({ username: 'dave', password: 'tok-1' }));
    await gitPush(cwd);
    const { env } = remoteCalls[0];
    expect(credentialKeys(env)).toEqual(['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_VALUE_1']);
    expect([env.GIT_CONFIG_COUNT, env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0, env.GIT_CONFIG_KEY_1]).toEqual(['2', 'advice.detachedHead', 'false', 'http.https://git.example.test/.extraheader']);
  });

  it('没有提供方 / 不认领 / 远端 URL 自带凭据:子进程环境与现在一致(没有那三项,跟踪开关不动)', async () => {
    process.env.GIT_TRACE = '1';
    const plain = project('push-plain');
    await gitPush(plain);
    registerGitCredentialProvider('other-host', async (origin) => (origin === 'https://github.com' ? { username: 'x', password: 'y' } : null));
    await gitPush(plain);
    resetGitCredentialProvidersForTest();
    let asked = 0;
    registerGitCredentialProvider('greedy', async () => { asked++; return { username: 'dave', password: 'tok-1' }; });
    await gitPush(project('push-own-creds', 'https://dave:mine@git.example.test/dave/hello.git'));
    expect(asked).toBe(0);
    expect(remoteCalls).toHaveLength(3);
    for (const call of remoteCalls) {
      expect(credentialKeys(call.env)).toEqual([]);
      expect(call.env.GIT_TRACE).toBe('1');
      expect(call.env.GIT_TRACE2_EVENT).toBeUndefined();
      expect(call.args).toEqual(['push', 'origin', 'HEAD:refs/heads/main']); // 命令行也一字不差(子模块照用户自己的配置)
    }
  });

  it('带凭据的子进程摘掉 GIT_TRACE* / GIT_CURL_VERBOSE', async () => {
    const cwd = project('push-trace');
    Object.assign(process.env, { GIT_TRACE: '1', GIT_TRACE_CURL: '1', GIT_CURL_VERBOSE: '1' });
    registerGitCredentialProvider('test', async () => ({ username: 'dave', password: 'tok-1' }));
    await gitPush(cwd);
    const { env } = remoteCalls[0];
    expect([env.GIT_TRACE, env.GIT_TRACE_CURL, env.GIT_CURL_VERBOSE]).toEqual([undefined, undefined, undefined]);
    // Trace2 的去向还能写在全局配置里:显式置 0 才压得住(真 git 的那一条在 gitActions.test.ts「带凭据的子进程不留痕」)
    expect([env.GIT_TRACE2, env.GIT_TRACE2_EVENT, env.GIT_TRACE2_PERF]).toEqual(['0', '0', '0']);
    expect(env.GIT_CONFIG_COUNT).toBe('1');
  });

  it('认证失败 → 提供方作废重取 → 带新凭据再来一次就成功', async () => {
    const cwd = project('push-retry');
    let current = 'tok-stale';
    const invalidated: string[] = [];
    let asked = 0;
    registerGitCredentialProvider('test', {
      credentials: async () => { asked++; return { username: 'dave', password: current }; },
      invalidate: (_origin, rejected) => { invalidated.push(rejected.password); current = 'tok-fresh'; },
    });
    answer = (call) => (call.env.GIT_CONFIG_VALUE_0 === `Authorization: Basic ${b64('tok-fresh')}` ? { code: 0 } : { code: 128, stderr: AUTH_FAILED });
    expect(await gitPush(cwd)).toMatchObject({ remote: 'origin', branch: 'main' });
    expect({ asked, invalidated, attempts: remoteCalls.length }).toEqual({ asked: 2, invalidated: ['tok-stale'], attempts: 2 });
  });

  it('一直失败只重试这一次;403(没有这个仓库的权限)不重试', async () => {
    const cwd = project('push-once');
    let asked = 0;
    registerGitCredentialProvider('test', async () => ({ username: 'dave', password: `tok-${++asked}` }));
    answer = () => ({ code: 128, stderr: AUTH_FAILED });
    expect((await failure(gitPush(cwd))).code).toBe('git_failed');
    expect({ asked, attempts: remoteCalls.length }).toEqual({ asked: 2, attempts: 2 });

    remoteCalls.length = 0; asked = 0;
    answer = () => ({ code: 128, stderr: "fatal: unable to access 'https://git.example.test/bob/private.git/': The requested URL returned error: 403" });
    expect((await failure(gitPush(cwd))).code).toBe('git_failed');
    expect({ asked, attempts: remoteCalls.length }).toEqual({ asked: 1, attempts: 1 });
  });

  it('失败原文里的凭据被遮掉(令牌原文、Basic 编码、任何 Authorization 头的值)', async () => {
    const cwd = project('push-scrub');
    registerGitCredentialProvider('test', async () => ({ username: 'dave', password: 'tok-secret' }));
    answer = () => ({ code: 1, stderr: `=> Send header: Authorization: Basic ${b64('tok-secret')}\nremote: token tok-secret is not allowed to push\nerror: failed to push some refs` });
    const err = await failure(gitPush(cwd));
    expect(err.code).toBe('git_failed');
    expect(err.detail).toBe('=> Send header: Authorization: Basic ***\nremote: token *** is not allowed to push\nerror: failed to push some refs');
    // 成功时回给界面的 output 同样遮过
    answer = () => ({ code: 0, stderr: `To ${REMOTE}\n   abc..def  HEAD -> main (tok-secret)` });
    expect((await gitPush(cwd)).output).toBe(`To ${REMOTE}\n   abc..def  HEAD -> main (***)`);
  });

  it('提供方说「暂时取不到」→ 不带凭据照跑:成功就成功,认证失败才报它的 code;别的失败还是 git 的原样', async () => {
    const cwd = project('push-fallback');
    registerGitCredentialProvider('test', async () => { throw new GitCredentialError('x_rate_limited', 'asked too often', undefined, true); });
    await gitPush(cwd); // 用户自己配了凭据的情形:照常成功,不多出报错
    expect(credentialKeys(remoteCalls[0].env)).toEqual([]);
    answer = () => ({ code: 128, stderr: AUTH_FAILED });
    const limited = await failure(gitPush(cwd));
    expect({ code: limited.code, message: limited.message }).toEqual({ code: 'x_rate_limited', message: 'asked too often' });
    answer = () => ({ code: 1, stderr: ' ! [rejected]        main -> main (non-fast-forward)' });
    expect((await failure(gitPush(cwd))).code).toBe('git_failed');
    expect(remoteCalls).toHaveLength(3); // 每次只跑一遍,没有重试
  });

  it('重取时被限次 → 不再重试,报限次的 code', async () => {
    const cwd = project('push-retry-limited');
    let asked = 0;
    registerGitCredentialProvider('test', async () => { if (asked++) throw new GitCredentialError('x_rate_limited', 'asked too often', undefined, true); return { username: 'dave', password: 'tok-stale' }; });
    answer = () => ({ code: 128, stderr: AUTH_FAILED });
    expect((await failure(gitPush(cwd))).code).toBe('x_rate_limited');
    expect({ asked, attempts: remoteCalls.length }).toEqual({ asked: 2, attempts: 1 });
  });

  it('提供方说「到此为止」→ 一次 git 都不起,按它的 code 与 detail 报', async () => {
    const cwd = project('push-hard');
    registerGitCredentialProvider('test', async () => { throw new GitCredentialError('x_needs_setup', 'no account yet', 'https://git.example.test'); });
    const err = await failure(gitPush(cwd));
    expect({ code: err.code, detail: err.detail }).toEqual({ code: 'x_needs_setup', detail: 'https://git.example.test' });
    expect(remoteCalls).toHaveLength(0);
  });
});

describe('替用户带凭据之前', () => {
  it('仓库自带传输配置时未经信任不带凭据:untrusted_transport 点名那几项、一次 git 都不起;信任后照带,之后不再问', async () => {
    const cwd = project('transport-gate');
    git(cwd, 'config', 'http.proxy', 'http://127.0.0.1:9');
    git(cwd, 'config', 'http.sslVerify', 'false');
    registerGitCredentialProvider('test', async () => ({ username: 'dave', password: 'tok-1' }));
    for (const action of [gitPush, gitPull]) {
      const err = await failure(action(cwd));
      expect({ code: err.code, detail: err.detail }).toEqual({ code: 'untrusted_transport', detail: 'http.proxy\nhttp.sslverify' });
    }
    expect(remoteCalls).toHaveLength(0);
    await gitPush(cwd, true);
    await gitPull(cwd);
    expect(remoteCalls.map((c) => [c.verb, c.env.GIT_CONFIG_KEY_0])).toEqual([
      ['push', 'http.https://git.example.test/.extraheader'], ['fetch', 'http.https://git.example.test/.extraheader'],
    ]);
  });

  it('没有凭据可带时,仓库自带的传输配置不拦(那是用户自己的连接,现状)', async () => {
    const cwd = project('transport-plain');
    git(cwd, 'config', 'http.proxy', 'http://127.0.0.1:9');
    await gitPush(cwd);
    registerGitCredentialProvider('other-host', async (origin) => (origin === 'https://github.com' ? { username: 'x', password: 'y' } : null));
    await gitPull(cwd);
    expect(remoteCalls.map((c) => [c.verb, credentialKeys(c.env)])).toEqual([['push', []], ['fetch', []]]);
  });

  it('仓库配置里以 - 开头的「远端名」不当远端用:拉取 no_upstream、推送 no_remote,都不起 git', async () => {
    const cwd = project('dash-remote');
    git(cwd, 'config', 'branch.main.remote', '--upload-pack=touch /tmp/pwned');
    registerGitCredentialProvider('test', async () => ({ username: 'dave', password: 'tok-1' }));
    expect((await failure(gitPull(cwd))).code).toBe('no_upstream');
    expect((await failure(gitPush(cwd))).code).toBe('no_remote');
    expect(remoteCalls).toHaveLength(0);
  });
});

describe('带凭据的拉取', () => {
  it('拉取的 fetch 同样带凭据;认证失败同样重取一次', async () => {
    const cwd = project('pull-inject');
    let current = 'tok-stale';
    registerGitCredentialProvider('test', { credentials: async () => ({ username: 'dave', password: current }), invalidate: () => { current = 'tok-fresh'; } });
    answer = (call) => (call.env.GIT_CONFIG_VALUE_0 === `Authorization: Basic ${b64('tok-fresh')}` ? { code: 0 } : { code: 128, stderr: AUTH_FAILED });
    expect(await gitPull(cwd)).toMatchObject({ remote: 'origin', upstream: 'origin/main', updated: false });
    expect(remoteCalls.map((c) => [c.args, c.env.GIT_CONFIG_KEY_0])).toEqual([
      [['fetch', '--no-recurse-submodules', 'origin', 'refs/heads/main'], 'http.https://git.example.test/.extraheader'],
      [['fetch', '--no-recurse-submodules', 'origin', 'refs/heads/main'], 'http.https://git.example.test/.extraheader'],
    ]);
  });

  it('push 认 pushurl 的主机,fetch 认 url 的主机', async () => {
    const cwd = project('pull-pushurl', 'https://read.example.test/dave/hello.git');
    git(cwd, 'remote', 'set-url', '--push', 'origin', 'https://write.example.test/dave/hello.git');
    const asked: string[] = [];
    registerGitCredentialProvider('test', async (origin) => { asked.push(origin); return { username: 'dave', password: 'tok-1' }; });
    await gitPull(cwd);
    await gitPush(cwd);
    expect(asked).toEqual(['https://read.example.test', 'https://write.example.test']);
    expect(remoteCalls.map((c) => [c.verb, c.env.GIT_CONFIG_KEY_0])).toEqual([
      ['fetch', 'http.https://read.example.test/.extraheader'],
      ['push', 'http.https://write.example.test/.extraheader'],
    ]);
  });

  it('fetch 失败的原文同样遮过;提供方「到此为止」时不 fetch', async () => {
    const cwd = project('pull-scrub');
    registerGitCredentialProvider('test', async () => ({ username: 'dave', password: 'tok-secret' }));
    answer = () => ({ code: 128, stderr: `=> Send header: Authorization: Basic ${b64('tok-secret')}\nfatal: unable to access the remote as tok-secret` });
    expect((await failure(gitPull(cwd))).detail).toBe('=> Send header: Authorization: Basic ***\nfatal: unable to access the remote as ***');
    resetGitCredentialProvidersForTest();
    remoteCalls.length = 0;
    registerGitCredentialProvider('test', async () => { throw new GitCredentialError('x_needs_setup', 'no account yet', ORIGIN); });
    expect((await failure(gitPull(cwd))).code).toBe('x_needs_setup');
    expect(remoteCalls).toHaveLength(0);
  });
});
