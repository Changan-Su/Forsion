/**
 * 「从 Git 克隆」:把一个远端仓库克隆到本机的一个新文件夹里(之后由桌面把它加成项目),以及列出当前用户在
 * Forsion Git / 绑定的 GitHub 账号下的仓库供他挑。
 *
 * 克隆:
 * - 地址只收 https / ssh(gitActions.remoteAddress)。远端的主机有凭据提供方认领时按次带上凭据(Forsion Git、绑定的 GitHub),
 *   凭据只在这一个子进程的环境里,不会写进克隆出来的仓库配置;没人认领就照用户自己的 git 配置跑。
 * - 目标 = <parent>/<name>。parent 必须是已有的目录(用户在界面上选的);name 是一个文件夹名(不带路径分隔符)。
 *   目标已经在了(哪怕是空文件夹)→ target_exists,不往已有的文件夹里写。目标由这里先**独占地建出来**再让 git 克隆进去:
 *   同时点了两次、或者别的程序抢先建了同名的东西,后到的那个拿到 target_exists,碰不到先到的。
 * - 不递归子模块(另一个仓库、另一份没过信任闸的配置;用户需要时自己在终端里取)。
 * - 失败 / 超时 → 把这次建出来的那个文件夹删掉(是这一次调用自己建的,里面只有 git 写的东西)。
 *
 * ponytail: 没有进度(克隆期间界面只有一个转圈),超时 15 分钟。很大的仓库在终端里克隆、再用「添加项目」。
 *   要做进度就让 git 带 --progress、把 stderr 流给界面。
 * ponytail: 仓库清单只取最近更新的 50 个、不翻页,不够用的人贴地址。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitActionError, remoteAddress, runWithRemoteCredentials } from './gitActions.js';
import { GitCredentialError, type GitCredential } from './gitCredentials.js';
import { forsionGit } from './forsionGit.js';
import { githubGit } from './githubGit.js';

const CLONE_TIMEOUT_MS = 15 * 60_000;
const LIST_TIMEOUT_MS = 15_000;
const LIST_MAX = 50;

/** 远端地址 → 预填的文件夹名(最后一段,去掉 .git)。整理不出来 → 空串,由用户自己填。 */
export function cloneDirName(url: string): string {
  const last = url.trim().replace(/[/\\]+$/, '').split(/[/\\:]/).pop() ?? '';
  const name = last.replace(/\.git$/i, '');
  return folderName(name) ?? '';
}

/** 一个可以当文件夹名的名字(不带路径分隔符、不是 . / ..、不以 - 开头);不行 → null。 */
function folderName(raw: unknown): string | null {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name || name.length > 100 || name === '.' || name === '..' || name.startsWith('-') || /[/\\:\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

export async function gitClone(url: unknown, parent: unknown, name: unknown): Promise<{ path: string; name: string }> {
  const target = remoteAddress(url);
  if (!target) throw new GitActionError('invalid_remote_url', 'That is not a remote address this app can use');
  const dir = folderName(name);
  if (!dir) throw new GitActionError('invalid_folder_name', 'That is not a valid folder name', typeof name === 'string' ? name : '');
  // 先解到真实路径:之后的建、克隆、清理都指同一个地方(parent 是软链时,中途把它换了指向也删不到别处)
  const base = typeof parent === 'string' && path.isAbsolute(parent) ? await fs.realpath(parent).catch(() => '') : '';
  if (!base || !(await fs.stat(base).then((s) => s.isDirectory(), () => false))) throw new GitActionError('invalid_folder', 'The folder to clone into does not exist', typeof parent === 'string' ? parent : '');
  const dest = path.join(base, dir);
  // 独占地建:已经在了(文件、文件夹、软链都算)→ 不碰。建成之后这个文件夹才归这一次调用,清理只删它。
  await fs.mkdir(dest).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'EEXIST') throw new GitActionError('target_exists', 'There is already something with that name in this folder', dest);
    throw new GitActionError('invalid_folder', 'Could not create the folder to clone into', e.code ?? '');
  });
  const cleanup = (): Promise<void> => fs.rm(dest, { recursive: true, force: true }).catch(() => {});
  try {
    // 在一个中立的目录里起 git(目标给绝对路径):parent 要是恰好在别的仓库里面,那个仓库的配置与这次克隆无关,不让它掺进来
    const cloned = await runWithRemoteCredentials(os.tmpdir(), target, 'fetch', ['clone', '--no-recurse-submodules', '--', target, dest], CLONE_TIMEOUT_MS, undefined);
    if (cloned.code !== 0) {
      const text = (cloned.stderr || cloned.stdout).trim();
      throw new GitActionError('remote_unreachable', 'Could not clone that repository', text.length > 1500 ? `…${text.slice(-1500)}` : text);
    }
  } catch (e) {
    await cleanup();
    throw e;
  }
  return { path: dest, name: dir };
}

// ── 我的仓库(供挑选)────────────────────────────────────────────────────────

export interface RemoteRepo { /** `所有者/仓库名`。 */ fullName: string; private: boolean; /** 克隆用的 https 地址。 */ cloneUrl: string; updatedAt: string | null }

/** 接口回的一条仓库 → 界面要的那几样。克隆地址必须是这个站自己的 https 地址(接口回的东西会被拿去连),否则丢掉。 */
function repoOf(raw: any, origin: string): RemoteRepo | null {
  const fullName = typeof raw?.full_name === 'string' ? raw.full_name : '';
  const cloneUrl = typeof raw?.clone_url === 'string' ? raw.clone_url : '';
  if (!fullName || !/^[^\s/]+\/[^\s/]+$/.test(fullName) || remoteAddress(cloneUrl) !== cloneUrl || !cloneUrl.startsWith(`${origin}/`)) return null;
  return { fullName, private: raw.private === true, cloneUrl, updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : null };
}

async function listFrom(doFetch: typeof fetch, url: string, headers: Record<string, string>, origin: string, unreachable: string): Promise<RemoteRepo[]> {
  const r = await doFetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Forsion', ...headers }, redirect: 'error', signal: AbortSignal.timeout(LIST_TIMEOUT_MS) })
    .catch(() => { throw new GitActionError(unreachable, 'Could not reach the Git host'); });
  if (r.status === 401) throw new GitActionError(origin === 'https://github.com' ? 'github_relink_required' : 'forsion_git_unavailable', 'The Git host did not accept the account credentials', REJECTED);
  const json: any = r.ok ? await r.json().catch(() => null) : null;
  if (!Array.isArray(json)) throw new GitActionError(unreachable, 'The Git host did not return a repository list', String(r.status));
  return json.map((raw) => repoOf(raw, origin)).filter((repo): repo is RemoteRepo => !!repo).slice(0, LIST_MAX);
}

/** 站点回了 401 的那一种失败(手里这枚凭据不行了):调用方据此让提供方丢掉它,下一次重取,不用重启。 */
const REJECTED = '401';
const rejectedByHost = (e: unknown): boolean => e instanceof GitActionError && e.detail === REJECTED && (e.code === 'github_relink_required' || e.code === 'forsion_git_unavailable');

const credentialOr = async (get: () => Promise<GitCredential | null> | undefined): Promise<GitCredential | null> =>
  Promise.resolve(get()).catch((e: unknown) => {
    if (e instanceof GitCredentialError) throw new GitActionError(e.code, e.message, e.detail);
    throw e;
  }).then((c) => c ?? null);

/** 当前用户在 Forsion Git 上能看到的仓库(自己的 + 协作的),最近更新的在前。这里没有 Forsion Git → null。 */
export async function listForsionGitRepos(opts: { fetch?: typeof fetch } = {}): Promise<RemoteRepo[] | null> {
  const git = forsionGit();
  const site = await git?.hosting().catch(() => null);
  if (!git || !site) return null;
  const credential = await credentialOr(() => git.provider.credentials(site.origin));
  if (!credential) return null;
  // Gitea 的访问令牌用 `Authorization: token <令牌>`;推拉用的那一枚带 read:user + write:repository,够列仓库
  return listFrom(opts.fetch ?? fetch, `${site.webUrl}/api/v1/user/repos?limit=${LIST_MAX}&page=1`, { Authorization: `token ${credential.password}` }, site.origin, 'forsion_git_unavailable')
    .catch((e: unknown) => { if (rejectedByHost(e)) git.provider.invalidate?.(site.origin, credential); throw e; });
}

/** 绑定的 GitHub 账号名下的仓库(自己的 + 协作的 + 所在组织的),最近更新的在前。云端没开绑定 → null;没绑 → 抛 github_not_linked。 */
export async function listGithubRepos(opts: { fetch?: typeof fetch } = {}): Promise<RemoteRepo[] | null> {
  const git = githubGit();
  if (!git) return null;
  const credential = await credentialOr(() => git.credential());
  if (!credential) return null;
  return listFrom(opts.fetch ?? fetch, `https://api.github.com/user/repos?sort=updated&per_page=${LIST_MAX}`,
    { Authorization: `Bearer ${credential.password}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, 'https://github.com', 'github_unreachable')
    .catch((e: unknown) => { if (rejectedByHost(e)) git.provider.invalidate?.('https://github.com', credential); throw e; });
}
