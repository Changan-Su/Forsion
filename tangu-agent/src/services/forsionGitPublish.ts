/**
 * 「发布到 Forsion Git」:项目是一个还没有远端的 git 仓库、这里的 Forsion Git 给登录的人发推拉凭据时,
 * 把一个远端设成 `<站点>/<用户名>/<仓库名>.git` 再推当前分支。站上开着「推到不存在的仓库即建(私有)」,所以不用另调建仓接口。
 *
 * 这是 Forsion Git 专属的动作,不进凭据接缝(services/gitCredentials.ts 不认识任何具体的站);推送本身照走 gitPush ——
 * 凭据、信任闸、显式 refspec、不等交互都是那一套。
 *
 * 口径:
 * - 远端名:一个远端都没有 → origin;已经有了 → forsion(撞名加 -2,services/gitRemotes.ts),原来的远端不碰。
 *   target(以后推送到这里;没有远端时恒为真)→ 推送时把它设成当前分支的上游;为假 → 只推这一次,推送去向不变(用户在对话框里勾的)。
 * - 仓库名由用户确认(界面预填由文件夹名整理出来的名字):Gitea 只收英文字母、数字、`-` `_` `.`,中文文件夹名整理不出名字。
 *   不合规的名字直接拒(invalid_repo_name),不悄悄改成别的。
 * - 没推上去(名字撞了站上另一个历史不同的仓库、站上没开账号、凭据取不到…)→ 把刚加的远端撤掉,仓库回到点之前的样子,
 *   可以换个名字再来。超时例外:推送可能已经做完,远端留着,之后用「推送」接着推。
 */
import path from 'node:path';
import { GitActionError, gitPush, readGit, requireRepoRoot, requireTrust, runAction } from './gitActions.js';
import { GitCredentialError } from './gitCredentials.js';
import { forsionGit } from './forsionGit.js';
import { remoteNameFor } from './gitRemotes.js';

/** Gitea 的仓库名上限。 */
const REPO_NAME_MAX = 100;
/** Gitea 不收以这些结尾的仓库名。 */
const RESERVED_SUFFIX = /\.(git|wiki|rss|atom)$/i;

/** 文件夹名 → Gitea 收的仓库名(只有英文字母、数字、`-` `_` `.`;不以 `-` `.` 开头结尾;没有连着的 `.`)。整理不出来 → 空串。 */
export function forsionRepoName(raw: string): string {
  let name = raw.normalize('NFKC').trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  while (RESERVED_SUFFIX.test(name)) name = name.replace(RESERVED_SUFFIX, '').replace(/[-.]+$/g, '');
  return name.slice(0, REPO_NAME_MAX).replace(/[-.]+$/g, '');
}

/** 界面上要不要出现「发布到 Forsion Git」:这里发凭据 → 站点地址 + 由文件夹名整理出来的仓库名(可能是空串,界面让用户自己填)。
 *  只读站点信息(缓存),不取凭据。 */
export async function forsionPublishInfo(cwd: string): Promise<{ webUrl: string; name: string } | null> {
  const site = await forsionGit()?.hosting().catch(() => null);
  return site ? { webUrl: site.webUrl, name: forsionRepoName(path.basename(cwd)) } : null;
}

export interface PublishResult { /** 仓库的网页地址。 */ url: string; name: string; remote: string; branch: string; target: string; output: string }

export async function publishToForsionGit(cwd: string, name: unknown, trust?: boolean, target = true): Promise<PublishResult> {
  await requireRepoRoot(cwd);
  const head = await readGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], { timeoutMs: 5000 });
  if (head.code !== 0 || !head.stdout.trim()) throw new GitActionError('detached', 'HEAD is detached; switch to a branch before publishing');
  if ((await readGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { timeoutMs: 5000 })).code !== 0) {
    throw new GitActionError('no_commits', 'There is nothing to publish yet; make a commit first');
  }
  await requireTrust(cwd, 'write', trust);
  const remotes = (await readGit(cwd, ['remote'], { timeoutMs: 5000 })).stdout.split('\n').map((r) => r.trim()).filter(Boolean);
  const remote = remoteNameFor('forsion', remotes);
  const repo = typeof name === 'string' ? name.trim() : '';
  if (!repo || forsionRepoName(repo) !== repo) throw new GitActionError('invalid_repo_name', 'That is not a valid repository name', repo);
  const git = forsionGit();
  const account = git ? await git.account().catch((e: unknown) => {
    if (e instanceof GitCredentialError) throw new GitActionError(e.code, e.message, e.detail);
    throw e;
  }) : null;
  if (!account) throw new GitActionError('forsion_git_unavailable', 'Forsion Git is not available for this account right now');
  const page = `${account.webUrl}/${encodeURIComponent(account.username)}/${encodeURIComponent(repo)}`;
  const added = await runAction(cwd, ['remote', 'add', remote, `${page}.git`]);
  if (added.code !== 0) throw new GitActionError('git_failed', 'git remote add failed', added.stderr.trim().slice(-600));
  try {
    // 明说推到刚加的远端:分支上要是留着以前的上游设置,不跟它走;不改去向时只推这一次
    const pushed = await gitPush(cwd, trust, remote, { once: !(target || !remotes.length) });
    return { url: page, name: repo, ...pushed };
  } catch (e) {
    // 超时 = 推送可能已经做完:远端留着。其余都是确定没推上去:撤掉刚加的远端,回到点之前的样子。
    // 只删刚写的那一节配置,不用 `git remote remove`:它还会顺手清掉所有指着这个名字的分支上游设置和 refs/remotes/<名字>/*
    // —— 以前有过一个同名远端、只删了配置节的仓库里,那些是发布之前就在的东西。
    if (!(e instanceof GitActionError && e.code === 'git_timeout')) await runAction(cwd, ['config', '--remove-section', `remote.${remote}`]).catch(() => {});
    throw e;
  }
}
