/**
 * 绑定的 GitHub 账号的凭据提供方:在账户中心给 Forsion 账号绑了 GitHub 的人,项目远端在 github.com(https)时,
 * 推送 / 拉取直接用那个账号,不用自己配 git 凭据。登记在 services/gitCredentials.ts 的接缝上;别的主机一概不认领。
 * 绑定 / 解绑只在账户中心做(要先确认是账号本人),这里只读「绑没绑」和取凭据。
 *
 * 数据经云端接缝取(seams/cloudBrain 的 GithubBrain,httpBrain 实现):
 *   - 绑没绑(`/api/github/status`:登录名、头像)—— 界面用,不缓存;读不到当作不知道(null)。
 *   - 推拉凭据(`/api/github/credential`:绑定时拿到的那枚 OAuth 令牌,不过期)—— **只放内存**,进程内一直用同一枚;
 *     并发的两个动作共用一次请求。
 *
 * **只带话、不拦**:下面三个 code 都是 fallback —— 这一次照「没有凭据」跑,git 自己因为认证失败时才报给用户。
 * 电脑上本来就给 github.com 配好凭据(钥匙串、gh)的人不受影响,也不多出任何报错。
 *   github_not_linked      这个 Forsion 账号没绑 GitHub。
 *   github_relink_required 绑定失效了(云端解不开存着的令牌;或者 GitHub 拒了云端给的这一枚 = 授权在 GitHub 那边被撤了)。
 *   github_unavailable     暂时取不到(够不着 / 5xx / Forsion 登录失效)。
 * 云端没开 GitHub 绑定(503)/ 旧云端没有这个模块(404 不带 code)→ 不认领,照现状,一段时间内不再问。
 *
 * ponytail: 只认 github.com。云端的 GITHUB_WEB_URL 可以指向 GitHub Enterprise,但 /status 不回站点地址;要支持时让它回、这里照 Forsion Git 那样比 origin。
 */
import { GitHostingError, type GithubBrain, type GithubLinkStatus } from '../seams/cloudBrain.js';
import { GitCredentialError, registerGitCredentialProvider, type GitCredential, type GitCredentialProvider } from './gitCredentials.js';

export const GITHUB_PROVIDER_ID = 'github';
export const GITHUB_ORIGIN = 'https://github.com';

/** 没绑 / 绑定失效:用户会去账户中心绑完马上回来点推送,所以只歇很短;status() 读到「已绑定」时还会提前解除。 */
const NOT_LINKED_BACKOFF_MS = 30_000;
const UNAVAILABLE_BACKOFF_MS = 30_000;
const NOT_CONFIGURED_BACKOFF_MS = 10 * 60_000;

export interface GithubGit {
  provider: GitCredentialProvider;
  /** 云端开没开绑定、当前用户绑没绑(不取令牌)。读不到 → null。 */
  status(): Promise<GithubLinkStatus | null>;
  /** 推拉用的那一枚(「发布到 GitHub」拿它调建仓接口)。这里不发 → null;没绑 / 取不到 → 抛 GitCredentialError。 */
  credential(): Promise<GitCredential | null>;
}

export function createGithubGit(brain: GithubBrain, opts: { now?: () => number } = {}): GithubGit {
  const now = opts.now ?? Date.now;
  let cached: GitCredential | null = null;
  /** github.com 拒过的那一枚。云端再给出同一枚 = 授权已经在 GitHub 那边撤了:不再拿它去撞,带话让用户重新绑定。 */
  let rejected: string | null = null;
  let flight: Promise<GitCredential | null> | null = null;
  let blocked: { until: number; error: GitCredentialError | null } | null = null;
  const block = (ms: number, error: GitCredentialError | null): void => { blocked = { until: now() + ms, error }; };
  const relink = (): GitCredentialError => new GitCredentialError('github_relink_required', 'The GitHub link no longer works; link the GitHub account again in the account centre', undefined, true);

  const credential = async (): Promise<GitCredential | null> => {
    if (cached) return cached;
    if (blocked && now() < blocked.until) { if (blocked.error) throw blocked.error; return null; }
    return flight ??= brain.credential().then((issued) => {
      blocked = null;
      if (issued.password === rejected) { const error = relink(); block(NOT_LINKED_BACKOFF_MS, error); throw error; }
      rejected = null;
      cached = { username: issued.username, password: issued.password };
      return cached;
    }, (e: unknown) => {
      const status = e instanceof GitHostingError ? e.status : 0;
      const code = e instanceof GitHostingError ? e.code : '';
      if (status === 503 || (status === 404 && code !== 'GITHUB_NOT_LINKED')) { block(NOT_CONFIGURED_BACKOFF_MS, null); return null; }
      const error = status === 404 ? new GitCredentialError('github_not_linked', 'No GitHub account is linked to this Forsion account', undefined, true)
        : status === 409 ? relink()
        : new GitCredentialError('github_unavailable', 'GitHub credentials are unavailable right now', undefined, true);
      block(status === 404 || status === 409 ? NOT_LINKED_BACKOFF_MS : UNAVAILABLE_BACKOFF_MS, error);
      throw error;
    }).finally(() => { flight = null; });
  };

  return {
    credential,
    status: async () => {
      const status = await brain.status().catch(() => null);
      // 界面每次打开都会读这个:读到「已绑定」就把歇着的状态都放开(刚在账户中心绑好 / 重新绑好,回来点推送不用等);
      // 读到「没绑定」就丢掉手里那一枚(在账户中心解绑了,那枚令牌已经被撤)。
      if (status?.configured && status.linked) { blocked = null; rejected = null; }
      if (status?.configured && !status.linked) cached = null;
      return status;
    },
    provider: {
      credentials: async (origin) => (origin === GITHUB_ORIGIN ? credential() : null),
      invalidate: (_origin, refused) => {
        if (cached && cached.username === refused.username && cached.password === refused.password) { rejected = cached.password; cached = null; }
      },
    },
  };
}

// ── 进程里的那一个(standalone 装配时装上;没配云端 / 没登录 = 没有)──
let installed: { git: GithubGit; unregister: () => void } | null = null;

/** 装上(或换掉 / 卸掉)本进程的 GitHub 提供方。brain 没有 github 服务(没配云端地址、没登录)→ 卸掉,推拉照现状。 */
export function installGithubGit(brain: GithubBrain | undefined, opts?: { now?: () => number }): GithubGit | null {
  installed?.unregister();
  installed = null;
  if (!brain) return null;
  const git = createGithubGit(brain, opts);
  installed = { git, unregister: registerGitCredentialProvider(GITHUB_PROVIDER_ID, git.provider) };
  return git;
}

export const githubGit = (): GithubGit | null => installed?.git ?? null;

/** 界面用(项目详情「Git」页、设置里的「账号」):这里开没开 GitHub 绑定、当前用户绑没绑。没装 / 云端没开 / 读不到 → null。 */
export async function githubLinkInfo(): Promise<{ linked: boolean; login?: string } | null> {
  const status = await githubGit()?.status();
  if (!status?.configured) return null;
  return status.linked ? { linked: true, login: status.login } : { linked: false };
}
