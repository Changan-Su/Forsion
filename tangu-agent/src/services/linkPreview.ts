/**
 * Chat 链接悬停卡的富卡数据:GitHub / Forsion Git(Gitea)的 PR 与 issue(借鉴 Comma 方案 §2.6)。
 * 别的链接一律素卡,渲染端只看 URL、不联网;这里只管认得的那两类。
 *
 * - 只认 https://github.com/<o>/<r>/(pull|issues)/<n>,与云端给的 Forsion Git 站点下的 <o>/<r>/(pulls|issues)/<n>。
 *   请求只发往 api.github.com 与那个站点自己的 /api/v1:用户给的 URL 只贡献 owner / repo / 编号三段(字符集钉死),主机不取自它。
 * - 网络走 web_fetch 的 fetchPublic:每一跳重新解析并拒内网 / 回环、连接钉住校验时的地址、跨主机跳转剥 Authorization。
 *   总时限 6 秒、正文 1MB 封顶。
 * - 凭据走 git 凭据接缝:绑了 GitHub 就用那一枚(Bearer),Forsion Git 用推拉那一枚(Basic)。令牌不出引擎进程。
 *   没有 / 取不到 → 匿名;带令牌被拒(401 / 403 / 404)→ 匿名再问一次;匿名也拿不到(限流、私有仓)→ null,渲染端出素卡。
 * - 缓存按「用户 + 地址」:拿到的整个进程期间有效;没拿到的 60 秒后可以再问(限流过去、刚绑上 GitHub)。
 *
 * ponytail: 「检查过没过」要再打 check-runs 一个接口,没做;卡上的事实只用这一次响应里有的(增删行、文件数、评论数)。
 */
import { fetchPublic } from '../tools/builtin/webFetch.js';
import { gitCredentialEnv } from './gitCredentials.js';
import { forsionGit } from './forsionGit.js';

export interface LinkPreview {
  source: 'github' | 'forsion-git';
  kind: 'pr' | 'issue';
  /** owner/name */
  repo: string;
  number: number;
  title: string;
  state: 'open' | 'draft' | 'merged' | 'closed';
  author?: string;
  /** 按状态取最相关的时刻(ISO):合并 / 关闭 / 创建。 */
  at?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  comments?: number;
}

export interface RepoItem {
  source: LinkPreview['source'];
  kind: LinkPreview['kind'];
  owner: string;
  repo: string;
  number: number;
  /** 站点根,没有尾斜杠(取凭据按它的 origin)。 */
  site: string;
  api: string;
}

const GITHUB_SITE = 'https://github.com';
const NAME = /^[\w.-]{1,100}$/;
const TIMEOUT_MS = 6000;
/** 取凭据最多等这么久(云端接缝慢 / 挂住时),过了就匿名:总时限得留给真正的请求。 */
const AUTH_WAIT_MS = 3000;
const MAX_BYTES = 1024 * 1024;
const RETRY_MS = 60_000;
const MAX_ENTRIES = 500;

/** 链接 → 认得的 PR / issue;别的(http、带账号口令、别的主机、路径对不上)→ null。纯函数。 */
export function repoItemOf(href: string, forsionGitWebUrl: string | null): RepoItem | null {
  let u: URL;
  try { u = new URL(href); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  let source: RepoItem['source'];
  let site: string;
  let rest: string;
  let prSeg: string;
  if ((u.hostname === 'github.com' || u.hostname === 'www.github.com') && !u.port) {
    source = 'github'; site = GITHUB_SITE; rest = u.pathname; prSeg = 'pull';
  } else {
    if (!forsionGitWebUrl) return null;
    let base: URL;
    try { base = new URL(forsionGitWebUrl); } catch { return null; }
    if (base.protocol !== 'https:') return null;
    site = base.origin + base.pathname.replace(/\/+$/, '');
    const full = u.origin + u.pathname;
    if (!full.startsWith(`${site}/`)) return null;
    source = 'forsion-git'; rest = full.slice(site.length); prSeg = 'pulls';
  }
  const m = /^\/([^/]+)\/([^/]+)\/([^/]+)\/(\d{1,9})(?:\/.*)?$/.exec(rest);
  if (!m) return null;
  const [, owner, repo, seg, n] = m as unknown as [string, string, string, string, string];
  if (!NAME.test(owner) || !NAME.test(repo) || /^\.+$/.test(owner) || /^\.+$/.test(repo)) return null;
  const kind = seg === prSeg ? 'pr' : seg === 'issues' ? 'issue' : null;
  const number = Number(n);
  if (!kind || !number) return null;
  const apiRoot = source === 'github' ? 'https://api.github.com/repos' : `${site}/api/v1/repos`;
  return { source, kind, owner, repo, number, site, api: `${apiRoot}/${owner}/${repo}/${kind === 'pr' ? 'pulls' : 'issues'}/${number}` };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);

/** GitHub / Gitea 的 PR 或 issue JSON → 卡片数据(两家字段同名)。没有标题 = 不是我们要的东西 → null。纯函数。 */
export function previewOf(item: RepoItem, j: unknown): LinkPreview | null {
  const o = (j && typeof j === 'object' ? j : {}) as Record<string, any>;
  const title = str(o.title);
  if (!title) return null;
  const pull = o.pull_request && typeof o.pull_request === 'object' ? o.pull_request : null; // issues 接口问到的其实是 PR
  const mergedAt = str(o.merged_at) ?? str(pull?.merged_at);
  const state = o.merged === true || pull?.merged === true || mergedAt ? 'merged' : o.state === 'closed' ? 'closed' : o.draft === true ? 'draft' : 'open';
  return {
    source: item.source,
    kind: item.kind === 'pr' || pull ? 'pr' : 'issue',
    repo: `${item.owner}/${item.repo}`,
    number: item.number,
    title,
    state,
    author: str(o.user?.login),
    at: state === 'merged' ? mergedAt : state === 'closed' ? str(o.closed_at) : str(o.created_at),
    additions: int(o.additions),
    deletions: int(o.deletions),
    changedFiles: int(o.changed_files),
    comments: int(o.comments),
  };
}

/** 一次 GET:非 2xx 不读正文;超 MAX_BYTES 抛错。测试换成假的。 */
export type PreviewFetcher = (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<{ status: number; text: string }>;

const fetchCapped: PreviewFetcher = async (url, headers, signal) => {
  const page = await fetchPublic(url, { headers, signal });
  try {
    if (page.status < 200 || page.status >= 300) return { status: page.status, text: '' };
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of page.body as AsyncIterable<Buffer>) {
      n += c.length;
      if (n > MAX_BYTES) throw new Error('link preview body too large');
      chunks.push(c);
    }
    return { status: page.status, text: Buffer.concat(chunks).toString('utf8') };
  } finally {
    page.destroy();
  }
};

async function authFor(item: RepoItem): Promise<string | undefined> {
  try {
    const { credential } = await gitCredentialEnv(`${item.site}/`);
    if (!credential) return undefined;
    return item.source === 'github'
      ? `Bearer ${credential.password}`
      : `Basic ${Buffer.from(`${credential.username}:${credential.password}`, 'utf8').toString('base64')}`;
  } catch {
    return undefined; // 没绑 / 要先去站上登录一次 / 限次:这一次匿名
  }
}

async function load(item: RepoItem, fetcher: PreviewFetcher, authWaitMs: number): Promise<LinkPreview | null> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const base = { accept: item.source === 'github' ? 'application/vnd.github+json' : 'application/json', 'user-agent': 'Forsion-Tangu-LinkPreview' };
  try {
    let timer: NodeJS.Timeout | undefined;
    const auth = await Promise.race([
      authFor(item),
      new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), authWaitMs); timer.unref?.(); }),
    ]).finally(() => clearTimeout(timer));
    let r = await fetcher(item.api, auth ? { ...base, authorization: auth } : base, signal);
    if (auth && (r.status === 401 || r.status === 403 || r.status === 404)) r = await fetcher(item.api, base, signal);
    return r.status === 200 ? previewOf(item, JSON.parse(r.text)) : null;
  } catch {
    return null;
  }
}

const cache = new Map<string, { value: Promise<LinkPreview | null>; until: number }>();

export interface LinkPreviewOptions {
  fetcher?: PreviewFetcher;
  now?: () => number;
  /** 测试用:不问 forsionGit(),直接给站点地址(null = 没有 Forsion Git)。 */
  forsionGitWebUrl?: string | null;
  /** 测试用:取凭据最多等多久(缺省 AUTH_WAIT_MS)。 */
  authWaitMs?: number;
}

/** 链接的富卡数据;认不得 / 取不到 → null(不抛)。 */
export async function linkPreview(userId: string, href: string, opts: LinkPreviewOptions = {}): Promise<LinkPreview | null> {
  const now = opts.now ?? Date.now;
  const site = opts.forsionGitWebUrl !== undefined
    ? opts.forsionGitWebUrl
    : (await Promise.resolve(forsionGit()?.hosting()).catch(() => null))?.webUrl ?? null;
  const item = repoItemOf(href, site);
  if (!item) return null;
  const key = `${userId}\n${item.api}`;
  const hit = cache.get(key);
  if (hit && now() < hit.until) return hit.value;
  const entry = { value: load(item, opts.fetcher ?? fetchCapped, opts.authWaitMs ?? AUTH_WAIT_MS), until: Number.POSITIVE_INFINITY };
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  void entry.value.then((v) => { if (!v) entry.until = now() + RETRY_MS; });
  return entry.value;
}

export function resetLinkPreviewCacheForTest(): void { cache.clear(); }
