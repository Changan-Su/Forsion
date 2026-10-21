/**
 * What's new 弹窗的数据:官网「更新动态」(forsion.net/releases)的已发布快照 + 打包进来的 CHANGELOG。
 * 主进程(拉取校验)与渲染层(合并成版本列表)共用;纯函数,不碰 Electron / DOM。
 */
import { isNewer } from './updateVersion'

export const WEBSITE_ORIGIN = 'https://forsion.net'
export const WEBSITE_RELEASES_URL = `${WEBSITE_ORIGIN}/api/website/releases`

export interface WebsiteRelease {
  version: string
  date: string
  scope: { zh?: string; en?: string }
  markdown: { zh?: string; en?: string }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const VERSION = /^\d+(\.\d+)*(-[0-9A-Za-z.-]+)?$/ // 测试版通道的 2.13.5-beta.1 也算

/** 只收形状对的条目;字段缺失 / 类型不对的整条丢掉,不让一条坏数据带崩弹窗。 */
export function parseWebsiteReleases(body: unknown): WebsiteRelease[] {
  const list = (body as { releases?: unknown } | null)?.releases
  if (!Array.isArray(list)) return []
  const out: WebsiteRelease[] = []
  for (const r of list) {
    const version = str(r?.version), zh = str(r?.markdown?.zh), en = str(r?.markdown?.en)
    if (!version || !VERSION.test(version) || (!zh && !en)) continue
    out.push({ version, date: str(r?.date) || '', scope: { zh: str(r?.scope?.zh), en: str(r?.scope?.en) }, markdown: { zh, en } })
  }
  return out
}

/** semver 比较(复用 updater 那份,beta 早于同号正式版);段数少的算旧:官网的「2.12」总览排在 2.12.x 之后。 */
export function compareVersions(a: string, b: string): number {
  if (isNewer(a, b)) return 1
  if (isNewer(b, a)) return -1
  const parts = (v: string): number => v.split('-')[0].split('.').length
  return parts(a) - parts(b)
}

export interface WhatsNewEntry {
  version: string
  /** Editorial label only; updater identity and website anchors remain real versions. */
  displayVersion?: string
  date: string
  /** 官网那一篇(当前语言,缺了用另一种语言) */
  markdown?: string
  scope?: string
  /** 没有官网文章时:打包 CHANGELOG 那一节的条目 */
  lines?: string[]
  /** 也不在打包的 CHANGELOG 里(比安装包新):更新器从 tag 上拉回来的那一节 markdown */
  notes?: string
  /** 比正在用的版本新 */
  isNew: boolean
  installed: boolean
}

/**
 * 合并成左栏的版本列表(新 → 旧):官网有文章的用文章,其余用打包的 CHANGELOG 那一节;
 * 更新器报告的新版本两边都没有时,用它带的说明补一条。
 */
export function buildWhatsNewEntries(input: {
  website: WebsiteRelease[] | null
  changelog: Array<{ version: string; date: string; lines: string[] }>
  installed: string
  locale: 'zh' | 'en'
  update?: { version?: string; notes?: string }
}): WhatsNewEntry[] {
  const { installed, locale } = input
  const other = locale === 'zh' ? 'en' : 'zh'
  const map = new Map<string, WhatsNewEntry>()
  const flags = (v: string) => ({ isNew: !!installed && compareVersions(v, installed) > 0, installed: v === installed })
  for (const r of input.website ?? []) {
    map.set(r.version, { version: r.version, date: r.date, markdown: r.markdown[locale] ?? r.markdown[other], scope: r.scope[locale] ?? r.scope[other], ...flags(r.version) })
  }
  for (const c of input.changelog) {
    if (!VERSION.test(c.version) || map.has(c.version)) continue // Unreleased 不是版本
    map.set(c.version, { version: c.version, date: c.date, lines: c.lines, ...flags(c.version) })
  }
  const u = input.update
  if (u?.version && VERSION.test(u.version) && !map.has(u.version)) map.set(u.version, { version: u.version, date: '', notes: u.notes, ...flags(u.version) })
  // The 2.13.6 article/changelog is the consolidated 2.13.5 + 2.13.6 edition.
  // Keep its numeric identity for sorting/update actions; a cached 2.13.5 post must not duplicate it.
  const combined = map.get('2.13.6')
  if (combined && (combined.markdown || combined.lines)) {
    combined.displayVersion = '2.13.5&2.13.6'
    combined.installed ||= installed === '2.13.5'
    map.delete('2.13.5')
  }
  return [...map.values()].sort((a, b) => compareVersions(b.version, a.version))
}

/** 官网上这一版的锚点(releases/page.js 的 id 规则:点换成横线)。 */
export const websiteReleaseUrl = (version: string): string => `${WEBSITE_ORIGIN}/releases/#release-${version.replace(/\./g, '-')}`
