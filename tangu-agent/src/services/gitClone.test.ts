/**
 * 「从 Git 克隆」和「我的仓库」(克隆的 git 子进程换成假的,两个站的接口是假的 fetch,不连网):
 *   - 克隆:地址只收 https / ssh;目标 = <parent>/<name>,已经在了不写;不递归子模块;远端主机有提供方认领时带凭据(只在环境里)
 *   - 失败 / 超时 → 这次建出来的文件夹删掉
 *   - 预填的文件夹名:地址最后一段去掉 .git
 *   - 我的仓库:Forsion Git 用 `token <令牌>`、GitHub 用 Bearer;接口回的克隆地址不是这个站自己的 https 地址 → 丢掉;没绑 / 令牌被拒 → 各自的 code
 *
 * 负对照(2026-10-14 各改一处实跑,对应的用例红):
 *   - gitClone 去掉 target_exists 判断 → 「目标已经在了」红
 *   - 失败时不 cleanup → 「失败 / 超时 → 文件夹删掉」红
 *   - repoOf 不比 origin → 「别的站的克隆地址丢掉」红
 *   - folderName 放过带 / 的名字 → 「文件夹名」红
 *   2026-10-14:目标不独占地建(换回「先看在不在,再让 git 建」)→ 「同时两次克隆」红(后到的失败后把先到的那份删了)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitHostingError, type GitHostingBrain, type GithubBrain } from '../seams/cloudBrain.js';

interface CloneCall { args: string[]; env: NodeJS.ProcessEnv }
const clones: CloneCall[] = [];
type Answer = { code: number; stderr?: string; reason?: 'timeout' };
let answer: () => Answer | Promise<Answer> = () => ({ code: 0 });

vi.mock('../utils/boundedProcess.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../utils/boundedProcess.js')>();
  return {
    ...real,
    runBoundedProcess: async (executable: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs: number }) => {
      const at = args.indexOf('-C') + 2;
      if (args[at] !== 'clone') return real.runBoundedProcess(executable, args, options);
      clones.push({ args: args.slice(at), env: { ...options.env } });
      mkdirSync(path.join(args[args.length - 1], '.git'), { recursive: true }); // git 往目标文件夹里写东西
      const r = await answer();
      return { code: r.code, stdout: '', stderr: r.stderr ?? '', reason: r.reason, cleanupTimedOut: false };
    },
  };
});

const { GitActionError } = await import('./gitActions.js');
const { installGithubGit } = await import('./githubGit.js');
const { installForsionGit } = await import('./forsionGit.js');
const { resetGitCredentialProvidersForTest } = await import('./gitCredentials.js');
const { cloneDirName, gitClone, listForsionGitRepos, listGithubRepos } = await import('./gitClone.js');

let root: string;
const savedEnv = { ...process.env };
const failure = async (p: Promise<unknown>): Promise<InstanceType<typeof GitActionError>> => {
  try { await p; } catch (e) { if (e instanceof GitActionError) return e; throw e; }
  throw new Error('expected a GitActionError');
};
const linkGithub = (fail: GitHostingError | null = null): void => {
  const brain: GithubBrain = { status: async () => ({ configured: true, linked: true, login: 'dave', avatarUrl: null }), credential: async () => { if (fail) throw fail; return { username: 'dave', password: 'gho_secret' }; } };
  installGithubGit(brain);
};
const fakeFetch = (status: number, json: unknown) => {
  const seen: Array<{ url: string; auth: string }> = [];
  const doFetch = (async (url: string, init: any) => { seen.push({ url, auth: init?.headers?.Authorization ?? '' }); return { status, ok: status >= 200 && status < 300, json: async () => json }; }) as unknown as typeof fetch;
  return { doFetch, seen };
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'tangu-gitclone-'))); // 克隆回的是解过软链的真实路径(macOS 的临时目录是软链)
  writeFileSync(path.join(root, 'gitconfig'), '');
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', TANGU_HOME: path.join(root, 'tangu-home') });
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});
beforeEach(() => { clones.length = 0; answer = () => ({ code: 0 }); });
afterEach(() => { installGithubGit(undefined); installForsionGit(undefined); resetGitCredentialProvidersForTest(); });

describe('克隆', () => {
  it('克隆到 <parent>/<name>:不递归子模块;远端主机有提供方认领时带凭据,凭据不进命令行', async () => {
    linkGithub();
    const r = await gitClone('https://github.com/dave/demo.git', root, 'demo');
    expect(r).toEqual({ path: path.join(root, 'demo'), name: 'demo' });
    expect(clones).toHaveLength(1);
    expect(clones[0].args).toEqual(['clone', '--no-recurse-submodules', '--', 'https://github.com/dave/demo.git', path.join(root, 'demo')]);
    expect(clones[0].env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    // 别的主机:没人认领,照用户自己的 git 配置
    await gitClone('https://gitlab.com/dave/other.git', root, 'other');
    expect(clones[1].env.GIT_CONFIG_KEY_0).toBeUndefined();
  });

  it('目标已经在了(哪怕是空文件夹)→ target_exists,不起 git', async () => {
    mkdirSync(path.join(root, 'taken'));
    expect((await failure(gitClone('https://github.com/dave/demo.git', root, 'taken'))).code).toBe('target_exists');
    expect(clones).toHaveLength(0);
  });

  it('同时两次克隆到同一个目标:只有一个真的去克隆,另一个拿到 target_exists,克隆出来的那一份还在', async () => {
    // 两个都抢到「目标不在」的话,后起的那个 git 会因为文件夹已经有东西而失败 —— 它的清理不许删掉先起的那一份
    answer = () => (clones.length === 1 ? { code: 0 } : { code: 128, stderr: 'fatal: destination path already exists and is not an empty directory' });
    const settled = await Promise.allSettled([gitClone('https://gitlab.com/dave/demo.git', root, 'race'), gitClone('https://gitlab.com/dave/demo.git', root, 'race')]);
    expect(settled.map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason as InstanceType<typeof GitActionError>).code)).sort()).toEqual(['ok', 'target_exists']);
    expect(clones).toHaveLength(1);
    expect(existsSync(path.join(root, 'race', '.git'))).toBe(true);
  });

  it('地址 / 文件夹名 / 要放进去的文件夹不对 → 各自的 code,不起 git', async () => {
    expect((await failure(gitClone('http://insecure.example.com/x.git', root, 'x'))).code).toBe('invalid_remote_url');
    expect((await failure(gitClone('file:///etc', root, 'x'))).code).toBe('invalid_remote_url');
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', '-x', 'a:b', 42]) expect((await failure(gitClone('https://github.com/dave/demo.git', root, bad))).code, String(bad)).toBe('invalid_folder_name');
    expect((await failure(gitClone('https://github.com/dave/demo.git', path.join(root, 'no-such-folder'), 'x'))).code).toBe('invalid_folder');
    expect((await failure(gitClone('https://github.com/dave/demo.git', 'relative/path', 'x'))).code).toBe('invalid_folder');
    expect(clones).toHaveLength(0);
  });

  it('失败 / 超时 → 这次建出来的文件夹删掉', async () => {
    answer = () => ({ code: 128, stderr: 'fatal: repository not found' });
    const e = await failure(gitClone('https://gitlab.com/dave/missing.git', root, 'missing'));
    expect(e.code).toBe('remote_unreachable');
    expect(e.detail).toMatch(/repository not found/);
    expect(existsSync(path.join(root, 'missing'))).toBe(false);
    answer = () => ({ code: 1, reason: 'timeout' });
    expect((await failure(gitClone('https://gitlab.com/dave/huge.git', root, 'huge'))).code).toBe('git_timeout');
    expect(existsSync(path.join(root, 'huge'))).toBe(false);
  });

  it('GitHub 拒了、而 Forsion 账号没绑 GitHub → github_not_linked(界面给「去绑定」)', async () => {
    linkGithub(new GitHostingError(404, 'GITHUB_NOT_LINKED'));
    answer = () => ({ code: 128, stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" });
    expect((await failure(gitClone('https://github.com/dave/private.git', root, 'private'))).code).toBe('github_not_linked');
    expect(existsSync(path.join(root, 'private'))).toBe(false);
  });

  it('预填的文件夹名:地址最后一段去掉 .git', () => {
    expect(cloneDirName('https://github.com/dave/demo.git')).toBe('demo');
    expect(cloneDirName('git@github.com:dave/My-Notes.git')).toBe('My-Notes');
    expect(cloneDirName('https://git.forsion.net/dave/notes/')).toBe('notes');
    expect(cloneDirName('https://example.com/')).toBe('example.com');
    expect(cloneDirName('')).toBe('');
  });
});

describe('我的仓库', () => {
  it('GitHub:Bearer 令牌;接口回的克隆地址不是 github.com 自己的 https 地址 → 丢掉', async () => {
    linkGithub();
    const { doFetch, seen } = fakeFetch(200, [
      { full_name: 'dave/demo', private: true, clone_url: 'https://github.com/dave/demo.git', updated_at: '2026-10-01T00:00:00Z' },
      { full_name: 'dave/evil', private: false, clone_url: 'https://evil.example.com/dave/evil.git' },
      { full_name: 'dave/plain', private: false, clone_url: 'http://github.com/dave/plain.git' },
      { full_name: 'not a name', clone_url: 'https://github.com/x/y.git' },
    ]);
    expect(await listGithubRepos({ fetch: doFetch })).toEqual([{ fullName: 'dave/demo', private: true, cloneUrl: 'https://github.com/dave/demo.git', updatedAt: '2026-10-01T00:00:00Z' }]);
    expect(seen[0].auth).toBe('Bearer gho_secret');
    expect(seen[0].url).toMatch(/^https:\/\/api\.github\.com\/user\/repos\?/);
  });

  it('GitHub:云端没开绑定 → null;没绑 → github_not_linked;令牌被拒 → github_relink_required', async () => {
    expect(await listGithubRepos({ fetch: fakeFetch(200, []).doFetch })).toBeNull();
    linkGithub(new GitHostingError(404, 'GITHUB_NOT_LINKED'));
    expect((await failure(listGithubRepos({ fetch: fakeFetch(200, []).doFetch }))).code).toBe('github_not_linked');
    linkGithub();
    expect((await failure(listGithubRepos({ fetch: fakeFetch(401, null).doFetch }))).code).toBe('github_relink_required');
  });

  it('Forsion Git:`token <令牌>`,只收这个站自己的地址;这里没有 Forsion Git → null', async () => {
    expect(await listForsionGitRepos({ fetch: fakeFetch(200, []).doFetch })).toBeNull();
    const brain: GitHostingBrain = { info: async () => ({ configured: true, webUrl: 'https://git.forsion.test', credentials: true }), credential: async () => ({ webUrl: 'https://git.forsion.test', username: 'dave', password: 'tok-1' }) };
    installForsionGit(brain, { device: 'test' });
    const { doFetch, seen } = fakeFetch(200, [
      { full_name: 'dave/notes', private: true, clone_url: 'https://git.forsion.test/dave/notes.git', updated_at: null },
      { full_name: 'dave/else', private: false, clone_url: 'https://github.com/dave/else.git' },
    ]);
    expect(await listForsionGitRepos({ fetch: doFetch })).toEqual([{ fullName: 'dave/notes', private: true, cloneUrl: 'https://git.forsion.test/dave/notes.git', updatedAt: null }]);
    expect(seen[0]).toEqual({ url: 'https://git.forsion.test/api/v1/user/repos?limit=50&page=1', auth: 'token tok-1' });
  });
});
