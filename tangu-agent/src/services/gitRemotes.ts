/**
 * 项目的远端一览(项目详情「Git」页的「远端」卡片)与新远端的起名。只读,不取凭据。
 *
 * 每个远端两样东西分开说:
 *   host(显示用,按主机名认)= forsion(这里的 Forsion Git)| github(github.com)| other;
 *   auth(推拉时实际带谁的凭据)= 与凭据接缝同一个判法(credentialOrigin:只认 https、地址里不自带凭据)——
 *     forsion / github = 引擎替他带那个账号(GitHub 还要绑了才有;绑的账号被拒时照电脑自己的再跑一次,见 gitActions);
 *     local = 照这台电脑自己的 git 配置(ssh 钥匙、凭据助手、地址里自带的)。所以 `git@github.com:o/r.git` 是 host=github、auth=local。
 *
 * pushRemote = gitPush 不点名远端时推去的那个:当前分支配了上游(branch.<分支>.remote + .merge)→ 它;否则 origin;只有一个远端 → 它;都不是 → null。
 *   从配置算,不用 @{u}:刚「以后推送到这里」、还没推过时 @{u} 解析不出来,而推送去向已经定了。
 *   上游写的是一个网址、或者一个已经删掉的远端名时也照报它(不在远端列表里):gitPush 照样往那里推,面板不能说成 origin。
 *
 * 加第二个远端时起名(发布到 Forsion Git / GitHub、连接已有地址):一个都没有 → origin;有了 → 按站点起 forsion / github / 主机名,
 * 撞名加 -2、-3。不碰原来的 origin。
 */
import { credentialOrigin } from './gitCredentials.js';
import { GITHUB_ORIGIN } from './githubGit.js';

export interface GitRemoteInfo {
  name: string;
  /** 遮过凭据的地址。 */
  url: string;
  host: 'forsion' | 'github' | 'other';
  /** 主机名(other 时界面拿它当站名);认不出 → null。 */
  hostname: string | null;
  /** 站上的仓库路径(`owner/repo`,去掉 .git);认不出 → null。 */
  path: string | null;
  /** 仓库网页(https 远端,或 github / Forsion Git 上的 ssh 远端);没有 → null。 */
  web: string | null;
  auth: 'forsion' | 'github' | 'local';
  /** Forsion Git 上商业版组织的仓库(路径第一段是当前用户所在组织在站上的组织名)→ 组织显示名;个人仓库 / 别的站没有这一项。 */
  org?: string;
}

/** 一面板最多列几个远端(每个一次 `git remote get-url`)。 */
export const REMOTES_LISTED = 8;

/** 地址 → 主机名 + 路径。https / ssh:// 按 URL 解;`user@host:path` 这种 scp 写法另认。认不出 → null。 */
function locate(raw: string): { hostname: string; path: string; https: boolean } | null {
  const text = raw.trim();
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(text);
  if (scp && !text.includes('://')) return { hostname: scp[1].toLowerCase(), path: scp[2], https: false };
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (!url.hostname || (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'ssh:')) return null;
  return { hostname: url.hostname.toLowerCase(), path: decodeURIComponent(url.pathname), https: url.protocol === 'https:' };
}

/** 一个远端 → 卡片上那一行。forsionOrigin = 这里 Forsion Git 的 `https://主机`(没有 / 读不到 → null);orgs = forsionGit.orgs()(站上组织名小写 → 显示名)。 */
export function describeRemote(name: string, rawUrl: string, maskedUrl: string, forsionOrigin: string | null, orgs?: Map<string, string> | null): GitRemoteInfo {
  const at = locate(rawUrl);
  const forsionHost = forsionOrigin ? new URL(forsionOrigin).hostname.toLowerCase() : null;
  const host = !at ? 'other' : at.hostname === 'github.com' ? 'github' : forsionHost && at.hostname === forsionHost ? 'forsion' : 'other';
  const repoPath = at ? at.path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '') : '';
  const credential = credentialOrigin(rawUrl);
  const auth = credential && credential === GITHUB_ORIGIN ? 'github' : credential && credential === forsionOrigin ? 'forsion' : 'local';
  // 网页:https 远端照它的地址;ssh 远端只有认得的两个站才拼得出(别的站的网页不一定在同一个主机名上)
  const web = at && repoPath && (at.https || host !== 'other') ? `https://${at.hostname}/${repoPath}` : null;
  const org = host === 'forsion' && repoPath.includes('/') ? orgs?.get(repoPath.split('/')[0].toLowerCase()) : undefined;
  return { name, url: maskedUrl, host, hostname: at?.hostname ?? null, path: repoPath || null, web, auth, ...(org ? { org } : {}) };
}

/** gitPush 不点名远端时推去哪个(规则见文件头)。upstreamRemote = 当前分支的 branch.<分支>.remote(没有 → 空串)。 */
export function pushRemoteOf(names: string[], upstreamRemote: string): string | null {
  if (upstreamRemote && upstreamRemote !== '.' && !upstreamRemote.startsWith('-')) return upstreamRemote;
  if (names.includes('origin')) return 'origin';
  return names.length === 1 ? names[0] : null;
}

/** 新远端的名字(规则见文件头)。site = forsion / github,或者远端地址(按主机名起)。 */
export function remoteNameFor(site: 'forsion' | 'github' | string, existing: string[]): string {
  if (!existing.length) return 'origin';
  let base = site;
  if (site !== 'forsion' && site !== 'github') {
    const hostname = locate(site)?.hostname ?? '';
    const labels = hostname.split('.').filter(Boolean);
    // gitlab.com → gitlab;git.example.com → example;IP / 认不出 → remote
    const pick = /^\d+(\.\d+){3}$/.test(hostname) ? '' : labels.length >= 2 ? labels[labels.length - 2] : labels[0] ?? '';
    base = pick.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'remote';
  }
  if (!existing.includes(base)) return base;
  for (let n = 2; ; n++) if (!existing.includes(`${base}-${n}`)) return `${base}-${n}`;
}
