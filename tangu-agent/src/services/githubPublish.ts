/**
 * 「发布到 GitHub」:项目是一个还没有远端的 git 仓库、Forsion 账号绑了 GitHub 时,在那个 GitHub 账号下建一个**私有**仓库,
 * 把一个远端设成 `https://github.com/<登录名>/<仓库名>.git` 再推当前分支。推送本身照走 gitPush(凭据由 services/githubGit.ts 的提供方给)。
 * 远端名与 target(以后推送到这里)的口径同 forsionGitPublish.ts:已经有远端时这个叫 github,不碰原来的。
 *
 * GitHub 不会「推到不存在的仓库即建」,所以先调它的建仓接口(绑定时拿到的令牌带 repo 权限)。由引擎直接调 GitHub:
 * 云端在大陆机房,到 GitHub 的线路时好时坏,而这台电脑反正要连得上 github.com 才推得了。
 *
 * 口径(照 forsionGitPublish.ts,不同的只有这几条):
 * - 同名仓库已经在了:它是**私有**的而且还是**空**的 → 照推(上一次建好了但没推上去,再点一次就是这种情况);
 *   别的(公开的,或者里面已经有东西)→ github_repo_exists,不往里推 —— 推进公开仓库收不回来,推进另一个项目的仓库等于把这个项目
 *   交给它的协作者。真要推进去走「连接已有远端」。
 * - 仓库建了但没推上去 → 撤掉刚加的远端;GitHub 上那个空的私有仓库留着(令牌没有删仓库的权限)。
 * - 没绑 GitHub / 绑定失效 → github_not_linked / github_relink_required(界面给「去绑定」)。
 *
 * ponytail: 只发到个人账号下,不选组织;只认 github.com(理由同 githubGit.ts)。
 */
import path from 'node:path';
import { GitActionError, gitPush, readGit, requireRepoRoot, requireTrust, runAction } from './gitActions.js';
import { GitCredentialError } from './gitCredentials.js';
import { forsionRepoName } from './forsionGitPublish.js';
import { GITHUB_ORIGIN, githubGit } from './githubGit.js';
import { remoteNameFor } from './gitRemotes.js';

const API = 'https://api.github.com';
const API_TIMEOUT_MS = 15_000;
/** GitHub 的登录名:字母、数字、连字符。接口回的东西要拼进远端地址,不是这个形状就不用。 */
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface GithubPublishOptions { fetch?: typeof fetch }

/** 界面上「发布到 GitHub」预填的仓库名(GitHub 收的字符与 Gitea 相同:字母、数字、- _ .)。 */
export const githubRepoName = (cwd: string): string => forsionRepoName(path.basename(cwd));

async function github(doFetch: typeof fetch, url: string, token: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  const r = await doFetch(url, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Forsion', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    redirect: 'error', // 令牌只交给 api.github.com 自己
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  }).catch(() => { throw new GitActionError('github_unreachable', 'Could not reach GitHub'); });
  return { status: r.status, json: await r.json().catch(() => null) };
}

/** 在绑定的账号下确保有这个私有仓库。回它所在的登录名(用户在 GitHub 上改过名时,和云端记着的那个不一样)。 */
async function ensurePrivateRepo(doFetch: typeof fetch, token: string, login: string, name: string): Promise<string> {
  const created = await github(doFetch, `${API}/user/repos`, token, { method: 'POST', body: { name, private: true } });
  const ownerOf = (json: any): string => (typeof json?.owner?.login === 'string' && LOGIN_RE.test(json.owner.login) ? json.owner.login : login);
  if (created.status === 201) return ownerOf(created.json);
  if (created.status === 401) throw new GitActionError('github_relink_required', 'GitHub no longer accepts the linked account');
  if (created.status === 422) {
    // 同名的已经在了:只有它是私有的、而且还是空的(= 上次建好没推上去)才往里推(见文件头)。
    // 有内容的仓库哪怕是私有的也不碰:那是另一个项目,往里推一个新分支会把这个项目交给它的协作者。
    const at = `${API}/repos/${encodeURIComponent(login)}/${encodeURIComponent(name)}`;
    const existing = await github(doFetch, at, token);
    // 空仓库列提交时 GitHub 回 409(Git Repository is empty)
    if (existing.status === 200 && existing.json?.private === true && (await github(doFetch, `${at}/commits?per_page=1`, token)).status === 409) return ownerOf(existing.json);
    if (existing.status === 200) throw new GitActionError('github_repo_exists', 'A repository with that name already exists on this GitHub account', name);
    // 查不到那个仓库 = 422 不是因为重名(名字 GitHub 不收之类):照下面按 GitHub 给的原因报
  }
  // 原因只取 GitHub 的那一句 message(例:组织要求先过 SSO、次数超限),不带别的字段
  throw new GitActionError('github_api_failed', 'GitHub refused to create the repository', `${created.status}${typeof created.json?.message === 'string' ? ` ${created.json.message.slice(0, 300)}` : ''}`);
}

export interface GithubPublishResult { /** 仓库的网页地址。 */ url: string; name: string; remote: string; branch: string; target: string; output: string }

export async function publishToGithub(cwd: string, name: unknown, trust?: boolean, opts: GithubPublishOptions = {}, target = true): Promise<GithubPublishResult> {
  await requireRepoRoot(cwd);
  const head = await readGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], { timeoutMs: 5000 });
  if (head.code !== 0 || !head.stdout.trim()) throw new GitActionError('detached', 'HEAD is detached; switch to a branch before publishing');
  if ((await readGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { timeoutMs: 5000 })).code !== 0) {
    throw new GitActionError('no_commits', 'There is nothing to publish yet; make a commit first');
  }
  await requireTrust(cwd, 'write', trust);
  const remotes = (await readGit(cwd, ['remote'], { timeoutMs: 5000 })).stdout.split('\n').map((r) => r.trim()).filter(Boolean);
  const remote = remoteNameFor('github', remotes);
  const repo = typeof name === 'string' ? name.trim() : '';
  if (!repo || forsionRepoName(repo) !== repo) throw new GitActionError('invalid_repo_name', 'That is not a valid repository name', repo);
  const credential = await Promise.resolve(githubGit()?.credential()).catch((e: unknown) => {
    if (e instanceof GitCredentialError) throw new GitActionError(e.code, e.message, e.detail);
    throw e;
  });
  if (!credential) throw new GitActionError('github_not_linked', 'No GitHub account is linked to this Forsion account');
  const owner = await ensurePrivateRepo(opts.fetch ?? fetch, credential.password, credential.username, repo).catch((e: unknown) => {
    // GitHub 不认这一枚了:让提供方丢掉它(重新绑定后下一次取到的是新的,不用重启)
    if (e instanceof GitActionError && e.code === 'github_relink_required') githubGit()?.provider.invalidate?.(GITHUB_ORIGIN, credential);
    throw e;
  });
  const page = `${GITHUB_ORIGIN}/${owner}/${encodeURIComponent(repo)}`;
  const added = await runAction(cwd, ['remote', 'add', remote, `${page}.git`]);
  if (added.code !== 0) throw new GitActionError('git_failed', 'git remote add failed', added.stderr.trim().slice(-600));
  try {
    // 明说推到刚加的远端:分支上要是留着以前的上游设置,不跟它走;不改去向时只推这一次
    const pushed = await gitPush(cwd, trust, remote, { once: !(target || !remotes.length) });
    return { url: page, name: repo, ...pushed };
  } catch (e) {
    // 超时 = 推送可能已经做完:远端留着。其余都是确定没推上去:撤掉刚加的远端(只删这一节配置,理由见 forsionGitPublish)
    if (!(e instanceof GitActionError && e.code === 'git_timeout')) await runAction(cwd, ['config', '--remove-section', `remote.${remote}`]).catch(() => {});
    throw e;
  }
}
