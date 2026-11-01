/**
 * 提交身份(作者的名字和邮箱)。git 没有它就不让提交,而没用过 git 的人不会去终端里配。
 *
 * 口径:
 *   1. 这台电脑 / 这个仓库的 git 配置里有的,照用,这里什么都不加 —— 自己配过的人不受影响。
 *   2. 缺的那一样(名字或邮箱)才由这里补:先用「设置 → Git」里填的,没填就用由 Forsion 账号推出来的。
 *      只经环境变量交给**这一次**提交的子进程(GIT_AUTHOR_* / GIT_COMMITTER_*),不写任何 git 配置;
 *      所以只对从 Forsion 里点的提交和 Agent 的 git_commit 工具生效,终端里、Agent 用 run_bash 跑的 `git commit` 照旧。
 *   3. 都凑不齐(没登录 Forsion、也没填)→ 不补。git 多半会自己按这台电脑的用户名和主机名取一个(`someone@host.local`),
 *      提交照样成功 —— 那个身份也报给界面(source = auto),让用户看得见、想换能换;git 取不出来时才是 no_identity。
 *
 * 由账号推出来的邮箱是一个不公开的地址 `<用户名>@noreply.<Forsion Git 的主机>`:Gitea 认这个写法(它自己的
 * NO_REPLY_ADDRESS 缺省就是 noreply.<DOMAIN>),提交会记到这个人名下。不拿账号的真邮箱当缺省 —— 邮箱进了提交历史就收不回来;
 * 想让提交在 GitHub 上记到自己名下的人,在设置里改成自己在 GitHub 用的邮箱。这里没有 Forsion Git 时没有缺省邮箱。
 *
 * ponytail: 用户名取的是 Forsion 的用户名。站上的 Git 用户名绝大多数时候与它相同(撞名 / 保留名时账号桥会改名),
 * 不同的那几个人的提交在 Forsion Git 上记不到名下;要准就让云端在 /api/git/info 之外给一个不建号的「我的 Git 用户名」。
 * ponytail: 进程环境里自带的 GIT_AUTHOR_* / GIT_COMMITTER_*(从带这些变量的终端里启动的应用)不算在「已配置」里:这里补的会盖过它,
 *   显示与提交一致;要让它优先就先读环境再决定补不补。
 */
import os from 'node:os';
import { readGit } from './gitActions.js';
import { cleanIdentityPart, gitSettings } from './gitSettings.js';
import { deps } from '../seams/runtime.js';
import { forsionGit } from './forsionGit.js';

export interface GitIdentity {
  name: string;
  email: string;
  /** git = git 配置里本来就有;custom = 「设置 → Git」里填的;forsion = 由 Forsion 账号推出来的;
   *  auto = 哪儿都没有,git 自己按这台电脑的用户名和主机名取的。 */
  source: 'git' | 'custom' | 'forsion' | 'auto';
}
export interface IdentityDefaults { name: string; email: string }

/** Forsion 账号 → 缺省身份。名字 = 昵称,没有就用用户名;邮箱见文件头。任何一样都可能是空串。 */
export function forsionIdentity(user: { username?: unknown; nickname?: unknown } | null, gitHost: string | null): IdentityDefaults {
  const username = cleanIdentityPart(user?.username);
  const local = username.toLowerCase();
  return {
    name: cleanIdentityPart(user?.nickname) || username,
    // Gitea 的用户名只有字母、数字和 - _ .;别的写法不会是站上的账号,不拿来拼地址
    email: gitHost && /^[a-z0-9][a-z0-9._-]*$/.test(local) ? `${local}@noreply.${gitHost}` : '',
  };
}

/** git 配置里的那一样。cwd 给了 = 连仓库级的一起算(就是在这个仓库里提交时 git 会用的);没给 = 系统 + 全局。 */
async function configured(key: string, cwd?: string): Promise<string> {
  const r = await readGit(cwd ?? os.homedir(), ['config', '--get', key], { timeoutMs: 5000 }).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() : '';
}

/** 由 Forsion 账号推出来的缺省提交身份(给 resolveGitIdentity 当 defaults)。走一趟云端,所以限时:它挡在提交前面。没登录 / 够不着 → null。 */
export async function accountIdentityDefaults(userId: string): Promise<IdentityDefaults | null> {
  const timeout = new Promise<null>((resolve) => { setTimeout(() => resolve(null), 5000).unref(); });
  const user = await Promise.race([deps().brain.users.getUserById(userId).catch(() => null), timeout]);
  if (!user || !user.username || user.username === 'local') return null;
  const site = await forsionGit()?.hosting().catch(() => null);
  return forsionIdentity(user, site ? new URL(site.origin).hostname : null);
}

export interface ResolvedIdentity {
  /** 提交会署的名字和邮箱;凑不齐 → null。 */
  identity: GitIdentity | null;
  /** 要并进提交那个子进程环境的东西(只有 git 配置里缺的那几样)。 */
  env: Record<string, string>;
}

/** defaults 只在 git 配置和设置都凑不齐时才问(它要走一趟云端)。 */
export async function resolveGitIdentity(defaults: () => Promise<IdentityDefaults | null>, cwd?: string): Promise<ResolvedIdentity> {
  const [name, email] = await Promise.all([configured('user.name', cwd), configured('user.email', cwd)]);
  if (name && email) return { identity: { name, email, source: 'git' }, env: {} };
  const settings = gitSettings();
  const custom = { name: settings.identityName, email: settings.identityEmail };
  const need = (!name && !custom.name) || (!email && !custom.email);
  const fallback = need ? await defaults().catch(() => null) : null;
  const fill = { name: custom.name || fallback?.name || '', email: custom.email || fallback?.email || '' };
  const env: Record<string, string> = {};
  if (!name && fill.name) { env.GIT_AUTHOR_NAME = fill.name; env.GIT_COMMITTER_NAME = fill.name; }
  if (!email && fill.email) { env.GIT_AUTHOR_EMAIL = fill.email; env.GIT_COMMITTER_EMAIL = fill.email; }
  const final = { name: name || fill.name, email: email || fill.email };
  const usedCustom = (!name && !!custom.name) || (!email && !!custom.email);
  if (final.name && final.email) return { identity: { ...final, source: usedCustom ? 'custom' : 'forsion' }, env };
  // 还缺:问 git 这次会署什么(它会按系统用户名 / 主机名取;取不出来或 user.useConfigOnly → 非 0 = 真的没有身份)
  const guessed = await readGit(cwd ?? os.homedir(), ['var', 'GIT_AUTHOR_IDENT'], { timeoutMs: 5000 }).catch(() => null);
  const m = guessed?.code === 0 ? /^(.*) <([^<>]*)> \d+ [+-]\d{4}$/.exec(guessed.stdout.trim()) : null;
  const auto = { name: final.name || m?.[1].trim() || '', email: final.email || m?.[2].trim() || '' };
  return { identity: auto.name && auto.email ? { ...auto, source: 'auto' } : null, env };
}
