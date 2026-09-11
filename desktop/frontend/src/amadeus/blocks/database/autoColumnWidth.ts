/**
 * 多维表「自适应列宽」的纯几何估算。
 *
 * 不直接量 DOM 的原因：可编辑格的 input 会先吃满当前列宽，scrollWidth 会把旧布局反过来
 * 当成内容宽；插件只读格的副内容又与主内容住在同一列。调用方把每格真正要保护的主内容
 * 描述成 AutoWidthSample，本文件只按那份样本算宽，因此 sub 永远不会误入计算。
 */

export const AUTO_COLUMN_MIN = 100
export const AUTO_COLUMN_MAX = 420

export interface AutoWidthColumn {
  id: string
  name: string
}

export interface AutoWidthSample {
  /** 单行主内容；副内容不属于这个接口。 */
  text?: string
  /** 多枚 chip / 操作按钮分别给出，计算时会计入各自内边距和间距。 */
  pieces?: string[]
  kind?: 'text' | 'chips' | 'actions' | 'checkbox'
  mono?: boolean
  avatar?: boolean
  dot?: boolean
  /** 层级表首列的缩进与折叠钮占位。 */
  leading?: number
}

const clamp = (width: number): number => Math.min(AUTO_COLUMN_MAX, Math.max(AUTO_COLUMN_MIN, Math.ceil(width)))

/** 13.5px 正文字号下的保守字宽；按字符类别估算比用字符数能更好覆盖中英混排。 */
export function estimatedTextWidth(value: string, mono = false): number {
  let width = 0
  const chars = Array.from(value)
  const limit = Math.min(chars.length, 96)
  for (let i = 0; i < limit; i++) {
    const char = chars[i]
    const cp = char.codePointAt(0) ?? 0
    if (mono) width += cp > 0x7f ? 13.5 : 8
    else if (cp > 0xffff || (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af)) width += 13.5
    else if (/\s/.test(char)) width += 4
    else if (/[ilI1.,:;|'`]/.test(char)) width += 4.2
    else if (/[MW@#%&]/.test(char)) width += 9
    else if (/[A-Z]/.test(char)) width += 7.7
    else if (/[0-9]/.test(char)) width += 7.1
    else width += 6.8
  }
  // 极长主内容不逐字遍历；宽度最终也会被 AUTO_COLUMN_MAX 截住。
  if (chars.length > limit) width += AUTO_COLUMN_MAX
  return width
}

function sampleWidth(sample: AutoWidthSample): number {
  if (sample.kind === 'checkbox') return AUTO_COLUMN_MIN
  const pieces = sample.pieces ?? []
  let content = estimatedTextWidth(sample.text ?? '', !!sample.mono)
  if (sample.kind === 'chips' && pieces.length) {
    content = pieces.reduce((sum, piece) => sum + estimatedTextWidth(piece, !!sample.mono) + 18, 0) + (pieces.length - 1) * 6
  } else if (sample.kind === 'actions' && pieces.length) {
    content = pieces.reduce((sum, piece) => sum + estimatedTextWidth(piece, !!sample.mono) + 18, 0) + (pieces.length - 1) * 4
  }
  return content
    + 20 // 12px 单元格 padding + 8px 字体抗锯齿/字重安全余量，主内容宁可稍松也不能被截断
    + (sample.avatar ? 28 : 0) // 22px 头像 + 6px gap
    + (sample.dot ? 13 : 0) // 7px 状态点 + 6px gap
    + (sample.leading ?? 0)
}

/**
 * 每列取「表头、所有主内容」的最大值。表头预留类型图标、排序标记与内边距；最终限制在
 * 100–420px，短枚举列不会平分整张宽表，长主内容也不会把其余列完全挤出视口。
 */
export function autoColumnWidths<Row, Column extends AutoWidthColumn>(
  columns: Column[],
  rows: Row[],
  sampleOf: (row: Row, column: Column) => AutoWidthSample,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const column of columns) {
    let width = estimatedTextWidth(column.name) + 47 // icon + gap + sort reserve + 16px header padding
    for (const row of rows) {
      width = Math.max(width, sampleWidth(sampleOf(row, column)))
      if (width >= AUTO_COLUMN_MAX) break
    }
    out[column.id] = clamp(width)
  }
  return out
}
