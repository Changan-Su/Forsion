// `[[笔记#标题]]` / `[[笔记#^块]]` 补全的纯逻辑(评审 2026-09-27 L-13):查询串拆段、从目标笔记正文抽标题 / 已有块 ID。
// 块 ID 只列**已有的** `^id`(Obsidian 互操作格式)—— 不为了补全给段落生成 id(那是改用户的文件)。
import { mapOutsideFences, plainSnippet, stripForIndex } from '@amadeus-shared/links'

export interface SubQuery {
  /** `#` 之前的目标名(可空 = 本篇,`[[#标题]]`)。 */
  name: string
  kind: 'heading' | 'block'
  /** `#` / `#^` 之后已经打的字。 */
  q: string
}

/** `Alpha#Sec` → { name:'Alpha', kind:'heading', q:'Sec' };`Alpha#^ab` → block;不含 `#` 或带 `|` → null。 */
export function parseSubQuery(query: string): SubQuery | null {
  const hash = query.indexOf('#')
  if (hash < 0 || query.includes('|')) return null
  const sub = query.slice(hash + 1)
  const block = sub.startsWith('^')
  return { name: query.slice(0, hash).trim(), kind: block ? 'block' : 'heading', q: block ? sub.slice(1) : sub }
}

/** 链接锚里放不下的字符(`[[a#b]]` 的语法字符)换成空格 —— Obsidian 同样处理。 */
export const anchorSafe = (s: string): string => s.replace(/[[\]|#^]/g, ' ').replace(/\s+/g, ' ').trim()

/** 正文里的 ATX 标题(围栏代码里的 `# 注释` 不算),去掉行内语法;按出现顺序、同名去重。 */
export function headingsOf(md: string): Array<{ level: number; text: string }> {
  const out: Array<{ level: number; text: string }> = []
  const seen = new Set<string>()
  mapOutsideFences(stripForIndex(md), (line) => {
    const m = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line)
    if (m) {
      const text = anchorSafe(plainSnippet(m[2]))
      if (text && !seen.has(text)) { seen.add(text); out.push({ level: m[1].length, text }) }
    }
    return line
  })
  return out
}

/** 正文里已有的块 ID(行尾 `^id`),附该行去语法的预览。 */
export function blockIdsOf(md: string): Array<{ id: string; preview: string }> {
  const out: Array<{ id: string; preview: string }> = []
  const seen = new Set<string>()
  mapOutsideFences(stripForIndex(md), (line) => {
    const m = /(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*$/.exec(line)
    if (m && !seen.has(m[1])) {
      seen.add(m[1])
      out.push({ id: m[1], preview: plainSnippet(line.slice(0, m.index)) })
    }
    return line
  })
  return out
}
