/// <reference types="vite/client" />
/**
 * 应用内「最新更新」(关于页展示)。
 * 数据源 = desktop 根目录的 CHANGELOG.md(纯 markdown,方便直接编辑 / 在 GitHub 阅读),
 * 构建期经 Vite `?raw` 内联进来后解析。维护:在 CHANGELOG.md 顶部加一节
 *   ## 1.2.3 (2026-06-20)
 *   - 要点
 * 关于页自动按节渲染(最新在最上)。与 docs/Log 的开发日志分工:这里面向用户精炼。
 */
import raw from '../../CHANGELOG.md?raw'

export interface ChangelogEntry {
  version: string
  date: string // YYYY-MM-DD(可空)
  lines: string[]
}

// 「## <version> (<date>)」起一节;date 可用 () /（）/ — 分隔,亦可省略。
const HEADING_RE = /^##\s+(.+?)\s*(?:[（(]\s*(\d{4}-\d{2}-\d{2})\s*[）)]|[—-]\s*(\d{4}-\d{2}-\d{2}))?\s*$/
const BULLET_RE = /^\s*[-*]\s+(.*\S)\s*$/

/** 解析 CHANGELOG.md → 版本条目(每个 `## 版本` 一节,其下 `- `/`* ` 行为要点)。 */
export function parseChangelog(md: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let cur: ChangelogEntry | null = null
  for (const line of md.split('\n')) {
    const h = HEADING_RE.exec(line)
    if (h) {
      cur = { version: h[1].replace(/^v/i, '').trim(), date: (h[2] || h[3] || '').trim(), lines: [] }
      entries.push(cur)
      continue
    }
    const b = BULLET_RE.exec(line)
    if (b && cur) cur.lines.push(b[1])
  }
  return entries.filter((e) => e.version && e.lines.length)
}

export const CHANGELOG: ChangelogEntry[] = parseChangelog(raw)
