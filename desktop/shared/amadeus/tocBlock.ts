/** 页内目录块(```toc 代码块)的选项 —— 编辑器渲染、代码块工具条判定、发布页三处共用这一份解析。
 *
 *  写法照 Obsidian 社区插件 Dynamic Table of Contents(`min_depth` / `max_depth`,一行一项),
 *  装了那个插件的 Obsidian 打开同一篇显示的范围和我们一样;没装的就是一个普通代码块,不丢内容。
 *  只读这两项,别的行(style / title / 用户自己写的)不认识也不报错,源码原样留着。 */

export const TOC_LANG = 'toc'

export interface TocRange {
  /** 列出的最浅一级标题(含)。 */
  min: number
  /** 列出的最深一级标题(含)。 */
  max: number
}

/** 没写或写坏时的范围:H1–H3(Notion 的目录块也只列到三级)。 */
export const TOC_DEFAULT_RANGE: Readonly<TocRange> = Object.freeze({ min: 1, max: 3 })

/** `/目录` 插进去的块:把缺省范围显式写出来,装了插件的 Obsidian 显示的也是 H1–H3(插件自己的缺省是 2 起)。 */
export const TOC_FENCE = '```toc\nmin_depth: 1\nmax_depth: 3\n```'

const OPTION_RE = /^\s*(min_depth|max_depth)\s*:\s*(\S+?)\s*$/

/** 块内文 → 列出的标题级别范围。数值夹在 1–6;写反了(min > max)按两头交换;非整数当没写。同名写了两次以后一次为准(YAML 的口径)。 */
export function parseTocRange(body: string): TocRange {
  let min: number | null = null
  let max: number | null = null
  for (const line of body.split(/\r?\n/)) {
    const m = OPTION_RE.exec(line)
    if (!m || !/^\d+$/.test(m[2])) continue
    const n = Math.min(6, Math.max(1, Number(m[2])))
    if (m[1] === 'min_depth') min = n
    else max = n
  }
  const lo = min ?? Math.min(TOC_DEFAULT_RANGE.min, max ?? TOC_DEFAULT_RANGE.min)
  const hi = max ?? Math.max(TOC_DEFAULT_RANGE.max, lo)
  return lo <= hi ? { min: lo, max: hi } : { min: hi, max: lo }
}
