/// <reference types="vite/client" />
/**
 * 应用内「最新更新」(关于页展示)。
 * 数据源 = desktop 根目录的 CHANGELOG.md(纯 markdown,方便直接编辑 / 在 GitHub 阅读),
 * 构建期经 Vite `?raw` 内联进来后解析。维护:在 CHANGELOG.md 顶部加一节
 *   ## v1.2.3 (2026-06-20)
 *   - 要点
 * 关于页自动按节渲染(最新在最上)。标题原样展示(不再自动加 v),想要 v 就写在 CHANGELOG 里。
 * `Unreleased` 可以放在最上面参与展示，但它不是应用版本；APP_VERSION 取第一个正式版本节。
 * 与 docs/Log 的开发日志分工:这里面向用户精炼。
 *
 * 英文版 = 同目录的 CHANGELOG.en.md,节标题与中文逐字相同(`## 2.11.4 (2026-09-23)`),界面按语言取(W-11)。
 * 中文是发版真源:版本顺序与 APP_VERSION 都只看中文;英文缺哪一节就回落中文那一节,并标 fallback 让界面注明。
 */
import raw from '../../CHANGELOG.md?raw'
import rawEn from '../../CHANGELOG.en.md?raw'

export interface ChangelogEntry {
  version: string
  date: string // YYYY-MM-DD(可空)
  lines: string[]
  /** 英文界面下这一节没有英文版,显示的是中文原文 */
  fallback?: boolean
}

// 「## <version> (<date>)」起一节;date 可用 () /（）/ — 分隔,亦可省略。
const HEADING_RE = /^##\s+(.+?)\s*(?:[（(]\s*(\d{4}-\d{2}-\d{2})\s*[）)]|[—-]\s*(\d{4}-\d{2}-\d{2}))?\s*$/
const BULLET_RE = /^\s*[-*]\s+(.*\S)\s*$/

/** 解析 CHANGELOG.md → 版本条目(每个 `## 版本` 一节,其下 `- `/`* ` 行为要点)。 */
export function parseChangelog(md: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let cur: ChangelogEntry | null = null
  // HTML 注释(文件末尾的「维护方式」说明)里的示例条目不是更新内容,先剥掉。
  for (const line of md.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const h = HEADING_RE.exec(line)
    if (h) {
      cur = { version: h[1].trim(), date: (h[2] || h[3] || '').trim(), lines: [] }
      entries.push(cur)
      continue
    }
    const b = BULLET_RE.exec(line)
    if (b && cur) cur.lines.push(b[1])
  }
  return entries.filter((e) => e.version && e.lines.length)
}

export const CHANGELOG: ChangelogEntry[] = parseChangelog(raw)
export const CHANGELOG_EN: ChangelogEntry[] = parseChangelog(rawEn)

/** 按界面语言取更新日志。 */
export function changelogFor(locale: string, zh: ChangelogEntry[] = CHANGELOG, en: ChangelogEntry[] = CHANGELOG_EN): ChangelogEntry[] {
  if (locale !== 'en') return zh
  const byVersion = new Map(en.map((e) => [e.version, e]))
  return zh.map((e) => byVersion.get(e.version) ?? { ...e, fallback: true })
}

/**
 * 当前已发布版本。更新日志允许把 `Unreleased` 放在顶部，因此不能再用 CHANGELOG[0]：
 * 那会把插件 minAppVersion 门禁的宿主版本变成 0.0.0，误杀整包插件及其 Space。
 */
const RELEASE_VERSION_RE = /^(?:Forsion\s+)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/i
export function latestReleasedVersion(entries: ChangelogEntry[]): string {
  for (const entry of entries) {
    const match = RELEASE_VERSION_RE.exec(entry.version.trim())
    if (match) return match[1]
  }
  return ''
}

export const APP_VERSION: string = latestReleasedVersion(CHANGELOG)
