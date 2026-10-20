/**
 * 「发布到 GitHub」和「连接已有远端」(真 git 管仓库现场;连远端的 push / ls-remote 子进程换成假的,GitHub 的接口是假的 fetch,不连网):
 *   - 发布:先在绑定的账号下建**私有**仓库(令牌只进 Authorization 头),origin 设成 https://github.com/<登录名>/<仓库名>.git,带凭据推当前分支
 *   - 同名仓库已在:私有 → 照推;不是私有 → github_repo_exists,仓库不动、不推
 *   - 没推上去 → 刚加的 origin 撤掉;超时 → origin 留着
 *   - 没绑 GitHub → github_not_linked;GitHub 不认这枚令牌(401)→ github_relink_required;都不加远端
 *   - 名字不合规 → invalid_repo_name,一次接口都不调;已有远端(2026-10-14 起)→ 新远端叫 github,原来的不动
 *   - 远端地址:只收 https 和 ssh;明文 http、file、本机命令式的写法、自带口令的、以 - 开头的都不收
 *   - 连接:加 origin 并当场列一次分支;远端有同名分支 → 记成上游;连不上 → origin 撤掉
 *   - 已有远端时连接(2026-10-14 起):按主机名起名;target 缺省 → 不管远端有没有这条分支都把上游改过去;target=false → 上游不动
 *
 * 负对照(2026-10-13 各改一处实跑,对应的用例红):
 *   - 建仓请求里把 private 写成 false → 「建私有仓库」红
 *   - 422 时不查那个仓库是不是私有、一律照推 → 「同名的公开仓库」红
 *   2026-10-14(评审后补的三条,各改一处实跑):
 *   - 422 + 私有就照推(不查是不是空的)→ 「同名的私有仓库里已经有东西」红
 *   - publish 里 gitPush 不点名 origin → 「分支上留着以前的上游设置」红(推到了旧地址)
 *   - 401 时不让提供方丢掉那一枚 → 「GitHub 不认这一枚」红(重新绑定后还在用旧的)
 *   - 失败时不撤 origin → 「没推上去 → origin 撤掉」红
 *   - remoteAddress 放过带口令的 https → 「远端地址」红
 *   - gitConnectRemote 连不上时不撤 origin → 「连不上 → origin 撤掉」红
 *   2026-10-14(加第二个远端,各改一处实跑):
 *   - gitConnectRemote 远端没有这条分支时不写上游 → 「已有远端时连接」红(旧上游还在,推送去了老地方)
 *   - gitConnectRemote 不管 target 一律写上游 → 「target=false」红
 *   - 连不上时恒撤 remote.origin → 「已有远端时连不上」红
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitHostingError, type GithubBrain } from '../seams/cloudBrain.js';

interface RemoteCall { command: string; args: string[]; env: NodeJS.ProcessEnv }
const calls: RemoteCall[] = [];
let answer: (command: string) => { code: number; stdout?: string; stderr?: string; reason?: 'timeout' } = () => ({ code: 0 });

vi.mock('../utils/boundedProcess.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../utils/boundedProcess.js')>();
  return {
    ...real,
    runBoundedProcess: (executable: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs: number }) => {
      const at = args.indexOf('-C') + 2;
      if (args[at] !== 'push' && args[at] !== 'ls-remote') return real.runBoundedProcess(executable, args, options);
      calls.push({ command: args[at], args: args.slice(at), env: { ...options.env } });
      const r = answer(args[at]);
      return Promise.resolve({ code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '', reason: r.reason, cleanupTimedOut: false });
    },
  };
});

const { GitActionError, gitConnectRemote, remoteAddress } = await import('./gitActions.js');
const { installGithubGit } = await import('./githubGit.js');
const { resetGitCredentialProvidersForTest } = await import('./gitCredentials.js');
const { publishToGithub } = await import('./githubPublish.js');

let root: string;
const savedEnv = { ...process.env };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
const project = (name: string): string => {
  const cwd = path.join(root, name);
  mkdirSync(cwd, { recursive: true });
  git(cwd, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(cwd, 'a.txt'), 'a\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
  return cwd;
};
const linked = (fail: GitHostingError | null = null): void => {
  const brain: GithubBrain = {
    status: async () => ({ configured: true, linked: true, login: 'dave', avatarUrl: null }),
    credential: async () => { if (fail) throw fail; return { username: 'dave', password: 'gho_secret' }; },
  };
  installGithubGit(brain);
};
/** 假的 api.github.com:按「方法 路径」回。 */
const api = (routes: Record<string, { status: number; json?: unknown }>) => {
  const seen: Array<{ key: string; auth: string; body: any }> = [];
  const doFetch = (async (url: string, init: any) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`;
    seen.push({ key, auth: init?.headers?.Authorization ?? '', body: init?.body ? JSON.parse(init.body) : undefined });
    const hit = routes[key] ?? { status: 500 };
    return { status: hit.status, json: async () => hit.json ?? null };
  }) as unknown as typeof fetch;
  return { doFetch, seen };
};
const failure = async (p: Promise<unknown>): Promise<InstanceType<typeof GitActionError>> => {
  try { await p; } catch (e) { if (e instanceof GitActionError) return e; throw e; }
  throw new Error('expected a GitActionError');
};
const remotesOf = (cwd: string): string => git(cwd, 'remote');

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'tangu-githubpublish-'));
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
beforeEach(() => { calls.length = 0; answer = () => ({ code: 0 }); });
afterEach(() => { installGithubGit(undefined); resetGitCredentialProvidersForTest(); });

describe('发布到 GitHub', () => {
  it('建私有仓库 → origin 指过去 → 带绑定账号的凭据推当前分支;令牌只在 Authorization 头里', async () => {
    linked();
    const cwd = project('fresh');
    const { doFetch, seen } = api({ 'POST /user/repos': { status: 201, json: { owner: { login: 'dave-renamed' } } } });
    const r = await publishToGithub(cwd, 'demo-site', undefined, { fetch: doFetch });
    expect(seen).toEqual([{ key: 'POST /user/repos', auth: 'Bearer gho_secret', body: { name: 'demo-site', private: true } }]);
    expect(r).toMatchObject({ url: 'https://github.com/dave-renamed/demo-site', name: 'demo-site', remote: 'origin', branch: 'main', target: 'origin/main' });
    expect(git(cwd, 'remote', 'get-url', 'origin')).toBe('https://github.com/dave-renamed/demo-site.git');
    expect(calls).toHaveLength(1);
    expect(calls[0].env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    expect(calls[0].args.join(' ')).not.toContain('gho_secret');
  });

  it('同名的私有仓库已在、还是空的(上次建好没推上去)→ 照推', async () => {
    linked();
    const cwd = project('retry');
    const { doFetch } = api({ 'POST /user/repos': { status: 422 }, 'GET /repos/dave/demo': { status: 200, json: { private: true, owner: { login: 'dave' } } }, 'GET /repos/dave/demo/commits': { status: 409 } });
    expect((await publishToGithub(cwd, 'demo', undefined, { fetch: doFetch })).url).toBe('https://github.com/dave/demo');
    expect(calls).toHaveLength(1);
  });

  it('同名的私有仓库里已经有东西(另一个项目)→ github_repo_exists:不加远端、不推', async () => {
    linked();
    const cwd = project('private-clash');
    const { doFetch } = api({ 'POST /user/repos': { status: 422 }, 'GET /repos/dave/demo': { status: 200, json: { private: true, owner: { login: 'dave' } } }, 'GET /repos/dave/demo/commits': { status: 200, json: [{ sha: 'abc' }] } });
    expect((await failure(publishToGithub(cwd, 'demo', undefined, { fetch: doFetch }))).code).toBe('github_repo_exists');
    expect(remotesOf(cwd)).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('分支上留着以前的上游设置(指向别处)→ 仍然推到刚加的 origin', async () => {
    linked();
    const cwd = project('stale-upstream');
    git(cwd, 'config', 'branch.main.remote', 'https://old.example/elsewhere.git');
    git(cwd, 'config', 'branch.main.merge', 'refs/heads/main');
    const { doFetch } = api({ 'POST /user/repos': { status: 201, json: { owner: { login: 'dave' } } } });
    await publishToGithub(cwd, 'demo', undefined, { fetch: doFetch });
    expect(calls[0].args).toEqual(['push', '--no-recurse-submodules', '--set-upstream', 'origin', 'HEAD:refs/heads/main']);
  });

  it('GitHub 不认这一枚(401)→ github_relink_required,并让提供方丢掉它:重新绑定后下一次用新的', async () => {
    let token = 'gho_old';
    installGithubGit({ status: async () => ({ configured: true, linked: true, login: 'dave', avatarUrl: null }), credential: async () => ({ username: 'dave', password: token }) });
    const cwd = project('relinked');
    const refused = api({ 'POST /user/repos': { status: 401 } });
    expect((await failure(publishToGithub(cwd, 'demo', undefined, { fetch: refused.doFetch }))).code).toBe('github_relink_required');
    token = 'gho_new'; // 用户在账户中心重新绑定了
    const ok = api({ 'POST /user/repos': { status: 201, json: { owner: { login: 'dave' } } } });
    await publishToGithub(cwd, 'demo', undefined, { fetch: ok.doFetch });
    expect(ok.seen[0].auth).toBe('Bearer gho_new');
  });

  it('同名的公开仓库 → github_repo_exists:不加远端、不推', async () => {
    linked();
    const cwd = project('public-clash');
    const { doFetch } = api({ 'POST /user/repos': { status: 422 }, 'GET /repos/dave/demo': { status: 200, json: { private: false } } });
    expect((await failure(publishToGithub(cwd, 'demo', undefined, { fetch: doFetch }))).code).toBe('github_repo_exists');
    expect(remotesOf(cwd)).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('没推上去 → origin 撤掉;超时 → origin 留着', async () => {
    linked();
    const { doFetch } = api({ 'POST /user/repos': { status: 201, json: {} } });
    const rejected = project('rejected');
    answer = () => ({ code: 1, stderr: 'remote: Repository not found.' });
    expect((await failure(publishToGithub(rejected, 'demo', undefined, { fetch: doFetch }))).code).toBe('credential_denied');
    expect(remotesOf(rejected)).toBe('');
    const slow = project('slow');
    answer = () => ({ code: 1, reason: 'timeout' });
    expect((await failure(publishToGithub(slow, 'demo', undefined, { fetch: doFetch }))).code).toBe('git_timeout');
    expect(remotesOf(slow)).toBe('origin');
  });

  it('没绑 GitHub → github_not_linked;GitHub 不认这枚令牌 → github_relink_required;都不加远端', async () => {
    const cwd = project('nolink');
    const { doFetch, seen } = api({ 'POST /user/repos': { status: 401 } });
    expect((await failure(publishToGithub(cwd, 'demo', undefined, { fetch: doFetch }))).code).toBe('github_not_linked'); // 没装提供方(没登录)
    linked(new GitHostingError(404, 'GITHUB_NOT_LINKED'));
    expect((await failure(publishToGithub(cwd, 'demo', undefined, { fetch: doFetch }))).code).toBe('github_not_linked');
    expect(seen).toHaveLength(0);
    linked();
    expect((await failure(publishToGithub(cwd, 'demo', undefined, { fetch: doFetch }))).code).toBe('github_relink_required');
    expect(remotesOf(cwd)).toBe('');
  });

  it('名字不合规 → invalid_repo_name,一次接口都不调', async () => {
    linked();
    const { doFetch, seen } = api({});
    const cwd = project('checks');
    expect((await failure(publishToGithub(cwd, '我的项目', undefined, { fetch: doFetch }))).code).toBe('invalid_repo_name');
    expect(seen).toHaveLength(0);
  });
});

describe('连接已有远端', () => {
  it('远端地址:只收 https 和 ssh', () => {
    for (const ok of ['https://github.com/dave/demo.git', 'https://dave@git.example.com/x/y', 'ssh://git@github.com/dave/demo.git', 'git@github.com:dave/demo.git', '  https://github.com/dave/demo  ']) expect(remoteAddress(ok), ok).toBe(ok.trim());
    for (const bad of ['http://github.com/dave/demo.git', 'git://github.com/dave/demo.git', 'file:///tmp/repo', '/tmp/repo', '../repo', 'ext::sh -c id', '--upload-pack=id', 'https://dave:secret@github.com/x/y.git', 'git@github.com:-oProxyCommand=id', 'https://github.com/a b', '', 42, null]) expect(remoteAddress(bad), String(bad)).toBeNull();
  });

  it('加 origin 并当场列一次分支;远端有同名分支 → 记成上游;空的远端 → 没有上游', async () => {
    const cwd = project('connect');
    answer = () => ({ code: 0, stdout: 'abc123\trefs/heads/main\ndef456\trefs/heads/other\n' });
    expect(await gitConnectRemote(cwd, 'https://git.example.com/dave/demo.git')).toEqual({ remote: 'origin', upstream: 'origin/main', target: true });
    expect(calls.map((c) => c.args.join(' '))).toEqual(['ls-remote --heads origin']);
    expect(git(cwd, 'config', '--get', 'branch.main.remote')).toBe('origin');
    expect(git(cwd, 'config', '--get', 'branch.main.merge')).toBe('refs/heads/main');
    const empty = project('connect-empty');
    answer = () => ({ code: 0, stdout: '' });
    expect(await gitConnectRemote(empty, 'git@github.com:dave/new.git')).toEqual({ remote: 'origin', upstream: null, target: true });
    expect(git(empty, 'remote', 'get-url', 'origin')).toBe('git@github.com:dave/new.git');
  });

  it('连不上 → origin 撤掉(可以改了地址再来);地址不收 → 不动仓库', async () => {
    const cwd = project('unreachable');
    answer = () => ({ code: 128, stderr: 'fatal: repository not found' });
    const e = await failure(gitConnectRemote(cwd, 'https://git.example.com/dave/missing.git'));
    expect(e.code).toBe('remote_unreachable');
    expect(e.detail).toMatch(/repository not found/);
    expect(remotesOf(cwd)).toBe('');
    expect((await failure(gitConnectRemote(cwd, 'http://insecure.example.com/x.git'))).code).toBe('invalid_remote_url');
    expect(calls).toHaveLength(1);
  });

  it('已有远端时连接:按主机名起名、原来的不动;target 缺省 → 远端没有这条分支也把上游改过去;target=false → 上游不动', async () => {
    const cwd = project('connect-second');
    git(cwd, 'remote', 'add', 'origin', 'https://example.com/x.git');
    git(cwd, 'config', 'branch.main.remote', 'origin'); git(cwd, 'config', 'branch.main.merge', 'refs/heads/main');
    answer = () => ({ code: 0, stdout: '' });
    expect(await gitConnectRemote(cwd, 'https://gitlab.com/dave/demo.git', undefined, false)).toEqual({ remote: 'gitlab', upstream: null, target: false });
    expect(git(cwd, 'config', '--get', 'branch.main.remote')).toBe('origin');
    expect(await gitConnectRemote(cwd, 'https://gitlab.com/dave/other.git')).toEqual({ remote: 'gitlab-2', upstream: null, target: true });
    expect(git(cwd, 'config', '--get', 'branch.main.remote')).toBe('gitlab-2');
    expect(git(cwd, 'remote', 'get-url', 'origin')).toBe('https://example.com/x.git');
  });

  it('已有远端时连不上 → 只撤刚加的那一个', async () => {
    const cwd = project('connect-second-fail');
    git(cwd, 'remote', 'add', 'origin', 'https://example.com/x.git');
    answer = () => ({ code: 128, stderr: 'fatal: repository not found' });
    expect((await failure(gitConnectRemote(cwd, 'https://gitlab.com/dave/missing.git'))).code).toBe('remote_unreachable');
    expect(remotesOf(cwd)).toBe('origin');
  });
});

describe('发布到 GitHub · 已有远端', () => {
  it('新远端叫 github,原来的不动;缺省设成上游', async () => {
    linked();
    const { doFetch } = api({ 'POST /user/repos': { status: 201, json: { owner: { login: 'dave' } } } });
    const cwd = project('publish-second');
    git(cwd, 'remote', 'add', 'origin', 'https://git.example.com/dave/x.git');
    const r = await publishToGithub(cwd, 'demo', undefined, { fetch: doFetch });
    expect(r).toMatchObject({ remote: 'github', target: 'github/main' });
    expect(git(cwd, 'remote', 'get-url', 'origin')).toBe('https://git.example.com/dave/x.git');
    expect(calls.at(-1)?.args).toEqual(['push', '--no-recurse-submodules', '--set-upstream', 'github', 'HEAD:refs/heads/main']);
  });
});
