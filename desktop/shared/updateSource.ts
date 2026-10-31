/**
 * 应用更新的「看谁的版本、从哪儿下」(纯函数)。桌面主进程与移动端更新检查共用。
 *
 * 口径(2026-10-19 用户定,方案页 docs/ToBeImproved/更新渠道方案_2026-10-19/):
 *  · **有没有新版只看官网下载页上本平台安装包的版本**(`GET /api/website/config`)。GitHub 只当下载源,
 *    并钉死同一个 tag;官网没答上才退回看 GitHub。
 *  · **下载来源缺省「自动」按地区**:中国大陆先走官网,其他地区(含港澳台)先走 GitHub;地区查不出先走官网。
 *    选中的那边下不动,自动换另一边一次。
 * 住 desktop/shared/:web 镜像的构建上下文只带 desktop/shared(见 updateVersion.ts 头注)。
 */
import { isNewer, isPrerelease, parseReleaseVersion } from './updateVersion'

export const WEBSITE_API = 'https://forsion.net/api'

/** 用户偏好(桌面存 config.json 的 updater.source)。 */
export type UpdateSourcePref = 'auto' | 'website' | 'github'
/** 这一次实际从哪儿下。 */
export type UpdateSource = 'website' | 'github'

export function parseSourcePref(v: unknown): UpdateSourcePref {
  return v === 'website' || v === 'github' ? v : 'auto'
}

/** 下载顺序:第一个先试,下不动换第二个。mainland:true 大陆 / false 其他地区 / null 没探出来。 */
export function sourceOrder(pref: UpdateSourcePref, mainland: boolean | null): UpdateSource[] {
  const first: UpdateSource = pref === 'auto' ? (mainland === false ? 'github' : 'website') : pref
  return first === 'website' ? ['website', 'github'] : ['github', 'website']
}

/** `/api/auth/region` → 是不是中国大陆;坏形状 / 查不出国家 = null。 */
export function parseMainland(body: unknown): boolean | null {
  const b = body as { mainland_china?: unknown; country?: unknown } | null
  if (!b || typeof b !== 'object' || !b.country) return null
  return typeof b.mainland_china === 'boolean' ? b.mainland_china : b.country === 'CN'
}

export type WebsitePlatform = 'windows' | 'macos' | 'android'
export interface WebsiteInstaller {
  version: string
  filename: string
  size?: number
  /** base64 的 SHA-512(electron-updater 校验用);老记录没有。 */
  sha512?: string
}
export type WebsiteInstallers = Partial<Record<WebsitePlatform, WebsiteInstaller>>

/** `/api/website/config` → 各平台已发布的安装包;形状不对返回 null(= 官网没答上)。 */
export function parseWebsiteInstallers(body: unknown): WebsiteInstallers | null {
  const platforms = (body as { platforms?: unknown } | null)?.platforms
  if (!platforms || typeof platforms !== 'object') return null
  const out: WebsiteInstallers = {}
  for (const key of ['windows', 'macos', 'android'] as const) {
    const p = (platforms as Record<string, any>)[key]
    const version = String(p?.version || '').trim().replace(/^v/i, '')
    if (!p || !parseReleaseVersion(version)) continue
    out[key] = {
      version,
      filename: String(p.filename || ''),
      ...(Number.isFinite(p.size) && p.size > 0 ? { size: p.size } : {}),
      ...(typeof p.sha512 === 'string' && p.sha512 ? { sha512: p.sha512 } : {}),
    }
  }
  return out
}

/** Both the declared GitHub flag and the version suffix restrict an entry to the preview channel. */
export function selectGitHubRelease(body: unknown, beta: boolean, onlyPre = false, accepts?: (release: Record<string, unknown>) => boolean): { version: string; body?: string; release: Record<string, unknown> } | null {
  const list = Array.isArray(body) ? body : [body]
  let best: { version: string; body?: string; release: Record<string, unknown> } | null = null
  for (const value of list) {
    if (!value || typeof value !== 'object') continue
    const release = value as Record<string, unknown>
    const parsed = parseReleaseVersion(release.tag_name)
    if (release.draft === true || !parsed || (accepts && !accepts(release))) continue
    const pre = release.prerelease === true || isPrerelease(parsed.version)
    if ((!beta && pre) || (onlyPre && !pre)) continue
    if (!best || isNewer(parsed.version, best.version)) best = {
      version: parsed.version, body: typeof release.body === 'string' ? release.body : undefined, release,
    }
  }
  return best
}

/** 这个包的「官网版本」看哪个平台:Linux 官网不放,跟 Windows 走(同一个 tag 一起出)。 */
export function websitePlatformFor(os: string): WebsitePlatform {
  return os === 'darwin' ? 'macos' : os === 'android' ? 'android' : 'windows'
}

/** 官网能不能直接给这个包:只放标准包(捆 Extend)的 Windows / mac,Linux 与 NoExtend 只能从 GitHub 下。 */
export function websiteCarries(os: string, bundleExtend: boolean): boolean {
  return bundleExtend && (os === 'win32' || os === 'darwin')
}

/** 官网那份安装包正好是这个版本、而且不是 NoExtend 包(发包脚本按扩展名挑,挑错时宁可走 GitHub)。 */
export function websiteHas(installer: WebsiteInstaller | undefined, version: string): installer is WebsiteInstaller {
  return !!installer && installer.version === version && !/noextend/i.test(installer.filename)
}
