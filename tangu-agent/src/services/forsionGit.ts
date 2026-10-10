/**
 * Forsion Git(云端那台 Gitea,账号就是 Forsion 账号)的凭据提供方:登录了 Forsion 的人,项目远端指向 Forsion Git 时,
 * 推送 / 拉取不用自己配任何 git 凭据。登记在 services/gitCredentials.ts 的接缝上;远端是别的主机时这里一概不认领。
 *
 * 数据经云端接缝取(seams/cloudBrain 的 GitHostingBrain,httpBrain 实现,它持有用户的 forsion_token):
 *   - 站点信息(`/api/git/info`:有没有 Forsion Git、站点地址、发不发凭据)—— 缓存;读不到当作没有。
 *     过期后先用旧值、后台刷新(站点地址几乎不变,不让用户点的推送等它);从没读到过时才等这一次(云端接缝自带短超时),
 *     失败后一段时间内不再试。**读不到 ≠ 报错**:推送照用户自己的 git 配置跑。
 *   - 推拉凭据(`/api/git/credential`:一枚这台设备专用的访问令牌)—— **只放内存**,进程内一直用同一枚;
 *     并发的两个动作共用一次请求(同一个设备名再要一次,旧的那枚就作废;服务端对同一用户还限次)。
 *     远端拒了这一枚(别的引擎进程用同一个设备名重发过)→ 接缝调 invalidate,这里作废后重取 —— 只这一次,不循环。
 *
 * 对用户说话的三个稳定 code(桌面按 code 出文案):
 *   forsion_git_needs_setup  这个人在 Forsion Git 还没有账号(detail = 站点地址):动作到此为止,去网页登录一次。
 *   forsion_git_rate_limited 取凭据太频繁(429):这一次照没有凭据跑,git 自己认证失败时才报它;一段时间内不再向服务端要。
 *   forsion_git_unavailable  暂时取不到(够不着 / 5xx / Forsion 登录失效):同上。
 * 服务端说「这里不发凭据」(503)→ 不认领,照现状。
 */
import os from 'node:os';
import { GitHostingError, type GitHostingBrain } from '../seams/cloudBrain.js';
import { GitCredentialError, credentialOrigin, registerGitCredentialProvider, type GitCredential, type GitCredentialProvider } from './gitCredentials.js';

export const FORSION_GIT_PROVIDER_ID = 'forsion-git';

const INFO_TTL_MS = 10 * 60_000;
const INFO_RETRY_MS = 60_000;
const UNAVAILABLE_BACKOFF_MS = 30_000;
const RATE_LIMIT_BACKOFF_MS = 2 * 60_000;

export interface ForsionGitHosting { /** 站点地址,没有尾斜杠。 */ webUrl: string; origin: string }
export interface ForsionGitAccount extends ForsionGitHosting { username: string }

export interface ForsionGit {
  provider: GitCredentialProvider;
  /** 这里有 Forsion Git、并且给登录的人发推拉凭据 → 站点;没有 / 读不到 → null。 */
  hosting(): Promise<ForsionGitHosting | null>;
  /** 当前用户在站上的账号(「发布到 Forsion Git」要用它拼远端地址)。这里不发凭据 → null;取不到 → 抛 GitCredentialError。 */
  account(): Promise<ForsionGitAccount | null>;
}

export interface ForsionGitOptions { device?: string; now?: () => number; infoTtlMs?: number; infoRetryMs?: number }

export function createForsionGit(brain: GitHostingBrain, opts: ForsionGitOptions = {}): ForsionGit {
  const now = opts.now ?? Date.now;
  const device = opts.device ?? os.hostname();
  const infoTtlMs = opts.infoTtlMs ?? INFO_TTL_MS;
  const infoRetryMs = opts.infoRetryMs ?? INFO_RETRY_MS;

  // ── 站点信息 ──
  let known: { value: ForsionGitHosting | null; at: number } | null = null; // 最近一次读成功的结果(null = 没有 / 不发凭据)
  let failedAt = Number.NEGATIVE_INFINITY;
  let infoFlight: Promise<ForsionGitHosting | null> | null = null;
  const readInfo = (): Promise<ForsionGitHosting | null> => infoFlight ??= brain.info().then((info) => {
    // 站点地址必须是 https:凭据只往 https 远端带(接缝的规矩),对不上 origin 的站点等于没有
    const origin = info.configured && info.credentials ? credentialOrigin(info.webUrl) : null;
    known = { value: origin && info.configured ? { webUrl: info.webUrl.replace(/\/+$/, ''), origin } : null, at: now() };
    return known.value;
  }, () => {
    failedAt = now();
    return known?.value ?? null;
  }).finally(() => { infoFlight = null; });
  const hosting = async (): Promise<ForsionGitHosting | null> => {
    if (known && now() - known.at < infoTtlMs) return known.value;
    if (now() - failedAt < infoRetryMs) return known?.value ?? null;
    const pending = readInfo();
    return known ? known.value : pending;
  };

  // ── 推拉凭据 ──
  let cached: GitCredential | null = null;
  let flight: Promise<GitCredential | null> | null = null;
  let blocked: { until: number; error: GitCredentialError | null } | null = null;
  const block = (ms: number, error: GitCredentialError | null): void => { blocked = { until: now() + ms, error }; };
  const credential = async (site: ForsionGitHosting): Promise<GitCredential | null> => {
    if (cached) return cached;
    if (blocked && now() < blocked.until) { if (blocked.error) throw blocked.error; return null; }
    return flight ??= brain.credential(device).then((issued) => {
      blocked = null;
      cached = { username: issued.username, password: issued.password };
      return cached;
    }, (e: unknown) => {
      const status = e instanceof GitHostingError ? e.status : 0;
      const code = e instanceof GitHostingError ? e.code : '';
      if (status === 409 && code === 'GIT_NEEDS_SETUP') {
        throw new GitCredentialError('forsion_git_needs_setup', 'This Forsion account has no Forsion Git account yet; sign in to Forsion Git on the web once', (e as GitHostingError).webUrl || site.webUrl);
      }
      if (status === 503) { block(infoTtlMs, null); return null; }
      const error = status === 429
        ? new GitCredentialError('forsion_git_rate_limited', 'Forsion Git credentials were requested too many times; try again in a few minutes', undefined, true)
        : new GitCredentialError('forsion_git_unavailable', 'Forsion Git credentials are unavailable right now', undefined, true);
      block(status === 429 ? RATE_LIMIT_BACKOFF_MS : UNAVAILABLE_BACKOFF_MS, error);
      throw error;
    }).finally(() => { flight = null; });
  };

  return {
    hosting,
    provider: {
      credentials: async (origin) => {
        const site = await hosting();
        return site && site.origin === origin ? credential(site) : null;
      },
      invalidate: (_origin, rejected) => {
        if (cached && cached.username === rejected.username && cached.password === rejected.password) cached = null;
      },
    },
    account: async () => {
      const site = await hosting();
      const issued = site ? await credential(site) : null;
      return site && issued ? { ...site, username: issued.username } : null;
    },
  };
}

// ── 进程里的那一个(standalone 装配时装上;没配云端 / 没登录 = 没有)──
let installed: { git: ForsionGit; unregister: () => void } | null = null;

/** 装上(或换掉 / 卸掉)本进程的 Forsion Git 提供方。brain 没有 git 服务(没配云端地址、没登录)→ 卸掉,推拉照现状。 */
export function installForsionGit(brain: GitHostingBrain | undefined, opts?: ForsionGitOptions): ForsionGit | null {
  installed?.unregister();
  installed = null;
  if (!brain) return null;
  const git = createForsionGit(brain, opts);
  installed = { git, unregister: registerGitCredentialProvider(FORSION_GIT_PROVIDER_ID, git.provider) };
  return git;
}

export const forsionGit = (): ForsionGit | null => installed?.git ?? null;
