/**
 * 「发布到 Forsion Git」(真 git 管仓库现场;连远端的 push 子进程换成假的,不连网;云端接缝是假的):
 *   - 仓库名:文件夹名整理成 Gitea 收的样子;整理不出来(中文名)→ 空串,由用户自己填
 *   - 能不能发布:装了 Forsion Git 提供方且站点发凭据 → 站点 + 预填的名字,**不取凭据**;没登录 / 站点不发凭据 → null
 *   - 发布:origin 设成 <站点>/<用户名>/<仓库名>.git,带凭据推当前分支,回仓库的网页地址
 *   - 只在一个远端都没有时做(has_remote);游离 HEAD / 还没有提交 / 名字不合规 / 子目录 / 未信任的钩子 → 各自的 code,仓库不动
 *   - 没推上去 → 刚加的 origin 撤掉;超时(可能已经推上去)→ origin 留着
 *   - 站上还没有账号 → forsion_git_needs_setup(带站点地址),不加远端;没登录 → forsion_git_unavailable
 *
 * 负对照(2026-10-10 各改一处实跑,对应的用例红):
 *   - forsionRepoName 不去保留后缀 / 不收紧连着的点 → 「仓库名」红
 *   - forsionPublishInfo 改成调 account()(会取凭据)→ 「能不能发布…不取凭据」红
 *   - publishToForsionGit 去掉 has_remote 判断 → 「已有远端」红(origin 被加到别人定好的仓库上 / remote add 报错)
 *   - 去掉名字校验 → 「名字不合规」红
 *   - 去掉 requireTrust → 「未信任的钩子」红(推送那一步照样会拦、origin 也会撤掉,但凭据已经先取了)
 *   - 去掉「还没有提交」的判断 → 「名字不合规…」那条红
 *   - 失败时不撤 origin → 「没推上去 → origin 撤掉」红
 *   - 超时也撤 origin → 「超时 → origin 留着」红
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitHostingError, type GitHostingBrain, type GitHostingInfo } from '../seams/cloudBrain.js';

interface PushCall { args: string[]; env: NodeJS.ProcessEnv }
const pushes: PushCall[] = [];
let answer: () => { code: number; stderr?: string; reason?: 'timeout' } = () => ({ code: 0 });

vi.mock('../utils/boundedProcess.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../utils/boundedProcess.js')>();
  return {
    ...real,
    runBoundedProcess: (executable: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs: number }) => {
      const at = args.indexOf('-C') + 2;
      if (args[at] !== 'push') return real.runBoundedProcess(executable, args, options);
      pushes.push({ args: args.slice(at), env: { ...options.env } });
      const r = answer();
      return Promise.resolve({ code: r.code, stdout: '', stderr: r.stderr ?? '', reason: r.reason, cleanupTimedOut: false });
    },
  };
});

const { GitActionError } = await import('./gitActions.js');
const { installForsionGit } = await import('./forsionGit.js');
const { resetGitCredentialProvidersForTest } = await import('./gitCredentials.js');
const { forsionPublishInfo, forsionRepoName, publishToForsionGit } = await import('./forsionGitPublish.js');

const WEB = 'https://git.forsion.test';
let root: string;
const savedEnv = { ...process.env };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
const project = (name: string, opts: { commit?: boolean } = {}): string => {
  const cwd = path.join(root, name);
  mkdirSync(cwd, { recursive: true });
  git(cwd, 'init', '-q', '-b', 'main');
  if (opts.commit !== false) { writeFileSync(path.join(cwd, 'a.txt'), 'a\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base'); }
  return cwd;
};
const signedIn = (over: Partial<GitHostingBrain> & { hosted?: GitHostingInfo } = {}) => {
  const brain = {
    info: vi.fn(over.info ?? (async () => over.hosted ?? ({ configured: true, webUrl: WEB, credentials: true } as GitHostingInfo))),
    credential: vi.fn(over.credential ?? (async () => ({ webUrl: WEB, username: 'dave', password: 'tok-1' }))),
  } satisfies GitHostingBrain;
  installForsionGit(brain, { device: 'test-mac' });
  return brain;
};
const failure = async (p: Promise<unknown>): Promise<InstanceType<typeof GitActionError>> => {
  try { await p; } catch (e) { if (e instanceof GitActionError) return e; throw e; }
  throw new Error('expected a GitActionError');
};

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'tangu-gitpublish-'));
  writeFileSync(path.join(root, 'gitconfig'), '');
  mkdirSync(path.join(root, 'tangu-home'));
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', TANGU_HOME: path.join(root, 'tangu-home'),
    GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@example.com',
  });
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});
beforeEach(() => { pushes.length = 0; answer = () => ({ code: 0 }); });
afterEach(() => { installForsionGit(undefined); resetGitCredentialProvidersForTest(); });

describe('forsionRepoName', () => {
  it('仓库名:文件夹名整理成 Gitea 收的样子;整理不出来 → 空串', () => {
    const cases: Array<[string, string]> = [
      ['hello', 'hello'], ['My Project', 'My-Project'], ['  notes (2026) / draft  ', 'notes-2026-draft'], ['a/b\\c:d', 'a-b-c-d'],
      ['demo.git', 'demo'], ['notes.wiki.git', 'notes'], ['feed.atom', 'feed'], ['..weird...name..', 'weird.name'], ['--x--', 'x'], ['.github', 'github'],
      ['snake_case.v2', 'snake_case.v2'], ['ＡＢＣ１２３', 'ABC123'], ['我的项目', ''], ['项目 alpha 版', 'alpha'], ['...', ''], ['', ''],
    ];
    for (const [raw, want] of cases) expect(forsionRepoName(raw), JSON.stringify(raw)).toBe(want);
    const long = forsionRepoName(`${'a'.repeat(99)}.${'b'.repeat(40)}`);
    expect(long).toBe('a'.repeat(99)); // 截到 100 之后不以 . 结尾
    for (const [, want] of cases) if (want) expect(forsionRepoName(want)).toBe(want); // 整理过的名字再整理一遍不变
  });
});

describe('forsionPublishInfo', () => {
  it('能不能发布:站点发凭据 → 站点 + 预填的名字,不取凭据;没登录 / 站点不发凭据 / 读不到 → null', async () => {
    const cwd = project('My Project');
    expect(await forsionPublishInfo(cwd)).toBeNull(); // 没登录:没有装提供方
    const brain = signedIn();
    expect(await forsionPublishInfo(cwd)).toEqual({ webUrl: WEB, name: 'My-Project' });
    expect(await forsionPublishInfo(project('我的项目'))).toEqual({ webUrl: WEB, name: '' });
    expect(brain.credential).not.toHaveBeenCalled();
    signedIn({ hosted: { configured: true, webUrl: WEB, credentials: false } });
    expect(await forsionPublishInfo(cwd)).toBeNull();
    signedIn({ info: async () => { throw new GitHostingError(0, 'NETWORK'); } });
    expect(await forsionPublishInfo(cwd)).toBeNull();
  });
});

describe('publishToForsionGit', () => {
  it('发布:origin 设成 <站点>/<用户名>/<仓库名>.git,带凭据推当前分支,回仓库的网页地址', async () => {
    const cwd = project('publish-ok');
    signedIn();
    const r = await publishToForsionGit(cwd, 'hello');
    expect(r).toMatchObject({ url: `${WEB}/dave/hello`, name: 'hello', remote: 'origin', branch: 'main', target: 'origin/main' });
    expect(git(cwd, 'remote', 'get-url', 'origin')).toBe(`${WEB}/dave/hello.git`);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].args).toEqual(['push', '--no-recurse-submodules', '--set-upstream', 'origin', 'HEAD:refs/heads/main']);
    expect(pushes[0].env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${Buffer.from('dave:tok-1').toString('base64')}`);
    expect(JSON.stringify(r)).not.toContain('tok-1');
  });

  it('已有远端 → has_remote,原来的远端一个字不动,也不取凭据', async () => {
    const cwd = project('publish-has-remote');
    git(cwd, 'remote', 'add', 'upstream', 'https://github.com/someone/else.git');
    const brain = signedIn();
    const err = await failure(publishToForsionGit(cwd, 'hello'));
    expect({ code: err.code, detail: err.detail }).toEqual({ code: 'has_remote', detail: 'upstream' });
    expect(git(cwd, 'remote', '-v')).toBe('upstream\thttps://github.com/someone/else.git (fetch)\nupstream\thttps://github.com/someone/else.git (push)');
    expect(brain.credential).not.toHaveBeenCalled();
    expect(pushes).toHaveLength(0);
  });

  it('名字不合规 → invalid_repo_name(不悄悄改成别的);游离 HEAD → detached;还没有提交 → no_commits;子目录 → nested_repo —— 都不加远端', async () => {
    signedIn();
    const cwd = project('publish-invalid');
    for (const name of ['我的项目', 'a b', '-x', 'x.git', 'a..b', '', '   ', undefined, 42]) {
      expect((await failure(publishToForsionGit(cwd, name))).code, String(name)).toBe('invalid_repo_name');
    }
    mkdirSync(path.join(cwd, 'sub'));
    expect((await failure(publishToForsionGit(path.join(cwd, 'sub'), 'hello'))).code).toBe('nested_repo');
    expect((await failure(publishToForsionGit(project('publish-empty', { commit: false }), 'hello'))).code).toBe('no_commits');
    git(cwd, 'checkout', '-q', '--detach');
    expect((await failure(publishToForsionGit(cwd, 'hello'))).code).toBe('detached');
    expect(git(cwd, 'remote')).toBe('');
    expect(pushes).toHaveLength(0);
  });

  it('未信任的钩子 → untrusted_config,不加远端;信任后照常发布', async () => {
    const cwd = project('publish-trust');
    mkdirSync(path.join(cwd, '.githooks'));
    writeFileSync(path.join(cwd, '.githooks', 'pre-push'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    git(cwd, 'config', 'core.hooksPath', '.githooks');
    const brain = signedIn();
    expect((await failure(publishToForsionGit(cwd, 'hello'))).code).toBe('untrusted_config');
    expect(git(cwd, 'remote')).toBe('');
    expect(brain.credential).not.toHaveBeenCalled(); // 没信任之前连凭据都不去取
    expect(await publishToForsionGit(cwd, 'hello', true)).toMatchObject({ url: `${WEB}/dave/hello` });
  });

  it('没推上去 → 刚加的 origin 撤掉,可以换个名字再来;超时(可能已经推上去)→ origin 留着', async () => {
    const cwd = project('publish-rollback');
    signedIn();
    answer = () => ({ code: 1, stderr: ' ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs' });
    const err = await failure(publishToForsionGit(cwd, 'taken'));
    expect(err.code).toBe('git_failed');
    expect(git(cwd, 'remote')).toBe('');
    answer = () => ({ code: 0 });
    expect(await publishToForsionGit(cwd, 'another')).toMatchObject({ url: `${WEB}/dave/another` });

    const slow = project('publish-timeout');
    answer = () => ({ code: 1, reason: 'timeout' });
    expect((await failure(publishToForsionGit(slow, 'hello'))).code).toBe('git_timeout');
    expect(git(slow, 'remote', 'get-url', 'origin')).toBe(`${WEB}/dave/hello.git`);
  });

  it('站上还没有账号 → forsion_git_needs_setup(带站点地址),不加远端;取凭据被限次 → forsion_git_rate_limited;没登录 → forsion_git_unavailable', async () => {
    const cwd = project('publish-account');
    signedIn({ credential: async () => { throw new GitHostingError(409, 'GIT_NEEDS_SETUP', WEB); } });
    const setup = await failure(publishToForsionGit(cwd, 'hello'));
    expect({ code: setup.code, detail: setup.detail }).toEqual({ code: 'forsion_git_needs_setup', detail: WEB });
    signedIn({ credential: async () => { throw new GitHostingError(429, 'GIT_CREDENTIAL_RATE_LIMITED'); } });
    expect((await failure(publishToForsionGit(cwd, 'hello'))).code).toBe('forsion_git_rate_limited');
    installForsionGit(undefined);
    expect((await failure(publishToForsionGit(cwd, 'hello'))).code).toBe('forsion_git_unavailable');
    expect(git(cwd, 'remote')).toBe('');
    expect(pushes).toHaveLength(0);
  });
});
