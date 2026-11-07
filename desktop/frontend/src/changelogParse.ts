/**
 * 更新日志的纯解析(不带 Vite 的 `?raw`):应用里经 changelog.ts 用,构建期的开屏插件(startupAppearancePlugin.ts)也用同一份,
 * 两边读出来的版本号才不会各说各的。
 */
import { parseReleaseVersion } from '../../shared/updateVersion'

export interface ChangelogEntry {
  version: string
  date: string // YYYY-MM-DD(可空)
  /** 要点;二级列表保留缩进(每层两个空格,例「  子条目」),渲染时经 changelogMarkdown 还原成嵌套列表 */
  lines: string[]
  /** 英文界面下这一节没有英文版,显示的是中文原文 */
  fallback?: boolean
}

// 「## <version> (<date>)」起一节;date 可用 () /（）/ — 分隔,亦可省略。
const HEADING_RE = /^##\s+(.+?)\s*(?:[（(]\s*(\d{4}-\d{2}-\d{2})\s*[）)]|[—-]\s*(\d{4}-\d{2}-\d{2}))?\s*$/
const BULLET_RE = /^(\s*)[-*]\s+(.*\S)\s*$/

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
    // 缩进按两格一层(制表符算一层);What's new / 关于页把「聊天：」下面的子条目画成下一级，而不是十几条并列的大项
    if (b && cur) cur.lines.push('  '.repeat(Math.floor(b[1].replace(/\t/g, '  ').length / 2)) + b[2])
  }
  return entries.filter((e) => e.version && e.lines.length)
}

/** 要点 → markdown 列表(保留嵌套)。 */
export const changelogMarkdown = (lines: string[]): string => lines.map((l) => l.replace(/^ */, (indent) => `${indent}- `)).join('\n')

/**
 * 当前已发布版本。更新日志允许把 `Unreleased` 放在顶部，因此不能再用 CHANGELOG[0]：
 * 那会把插件 minAppVersion 门禁的宿主版本变成 0.0.0，误杀整包插件及其 Space。
 */
export function latestReleasedVersion(entries: ChangelogEntry[]): string {
  for (const entry of entries) {
    const parsed = parseReleaseVersion(entry.version.trim().replace(/^Forsion\s+/i, ''))
    if (parsed) return parsed.version
  }
  return ''
}
