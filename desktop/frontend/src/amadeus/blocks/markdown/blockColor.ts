/** 整块颜色(Notion 对齐方案 A1,2026-11-17 用户定):段落 / 标题 / 列表项 / 待办 / 引用可以整块上字色、底色。
 *
 *  存法 = 块首空标记,与段落对齐 `<span data-amadeus-align>` 同一种写法(./paragraphIndent):
 *    `<span data-amadeus-bg="blue" data-amadeus-fg="red"></span>正文`
 *  - 值存**语义名**(九色 + accent),暗色 / 配色由 CSS 换;「更多颜色」给的 `#rrggbb` 原样存(不随暗色换)。
 *  - 段落 / 标题:颜色是节点自己的 attr,标记写在它自己的段首(对齐标记之后、制表符缩进之前)。
 *  - 列表项 / 引用:颜色挂在**容器**节点上(DOM 写在 li / blockquote 上,不用 `:has()` 反推,见 DESIGN §7.10),
 *    落盘写进容器第一段的段首;读入时从第一段摘下来交给容器。
 *  - 标注 / 折叠块(`> [!type]`)不在这里:A5 定存法前,它们不能上色(./callout 的令牌在第一段段首,标记插不到它前面)。
 *  - 读不懂的标记(未知颜色名、未知 `data-amadeus-*` 属性、同一属性出现两次)一律**不摘**:原样留在正文里当 HTML,
 *    存盘逐字写回,不丢。 */

/** 九色语义名:与划词调色板(./colorPaletteValues 的 itb.color.*)同名;底色那一组的「粉」在暗色 CSS 里也叫 magenta。 */
export const BLOCK_COLOR_NAMES = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'magenta', 'grey'] as const
export type BlockColorName = (typeof BLOCK_COLOR_NAMES)[number]

const HEX = /^#[0-9a-f]{6}$/i
/** 合法的块颜色值:九色名、accent(跟随强调色)、#rrggbb;其余(含 '')= 无颜色。 */
export function normalizeBlockColor(v: unknown): string {
  if (typeof v !== 'string') return ''
  if ((BLOCK_COLOR_NAMES as readonly string[]).includes(v) || v === 'accent') return v
  return HEX.test(v) ? v.toLowerCase() : ''
}

export interface BlockColor { bg: string; fg: string }
export const NO_COLOR: BlockColor = { bg: '', fg: '' }
export const hasBlockColor = (attrs: { bg?: unknown; fg?: unknown } | null | undefined): boolean =>
  !!attrs && (!!normalizeBlockColor(attrs.bg) || !!normalizeBlockColor(attrs.fg))

/** 写盘用的颜色标记;没有颜色 → null。底色在前、字色在后(规范形,往返逐字)。 */
export function colorMarker(c: { bg?: unknown; fg?: unknown }): string | null {
  const bg = normalizeBlockColor(c.bg), fg = normalizeBlockColor(c.fg)
  if (!bg && !fg) return null
  return `<span${bg ? ` data-amadeus-bg="${bg}"` : ''}${fg ? ` data-amadeus-fg="${fg}"` : ''}></span>`
}

export type TextAlignment = 'left' | 'center' | 'right'
/** amadeusKeep:liftContainerColor 判定「这枚标记不能摘」时打的记号,段落解析见到就停、原样留作 HTML。 */
type MdNode = { type: string; value?: string; children?: MdNode[]; amadeusKeep?: boolean }
type MarkerKey = 'align' | 'bg' | 'fg'

const ATTRS = '((?:\\s+data-amadeus-[a-z]+="[^"]*")+)\\s*'
const FULL = new RegExp(`^<span${ATTRS}><\\/span>$`)
const OPEN = new RegExp(`^<span${ATTRS}>$`)

function readAttrs(raw: string): Partial<Record<MarkerKey, string>> | null {
  const out: Partial<Record<MarkerKey, string>> = {}
  for (const m of raw.matchAll(/data-amadeus-([a-z]+)="([^"]*)"/g)) {
    const key = m[1] as MarkerKey
    if (key in out) return null
    if (key === 'align') { if (m[2] !== 'left' && m[2] !== 'center' && m[2] !== 'right') return null }
    else if (key === 'bg' || key === 'fg') { if (!normalizeBlockColor(m[2]) || normalizeBlockColor(m[2]) !== m[2]) return null }
    else return null // 别的 data-amadeus-*:不是我们认识的块标记,留在正文里
    out[key] = m[2]
  }
  return out
}

/** 一段 mdast 子节点开头的块标记串:每一枚是一个 html 节点 `<span …></span>`,或 remark 拆开的 `<span …>` + `</span>` 两个。
 *  遇到读不懂的就停,停下的地方之后原样留下。返回每一枚的属性与占了几个子节点。 */
function leadingMarkers(children: MdNode[] | undefined): Array<{ attrs: Partial<Record<MarkerKey, string>>; size: number }> {
  const out: Array<{ attrs: Partial<Record<MarkerKey, string>>; size: number }> = []
  const seen = new Set<string>()
  let i = 0
  while (children && i < children.length) {
    const node = children[i]
    if (node?.type !== 'html' || typeof node.value !== 'string' || node.amadeusKeep) break
    const v = node.value.trim()
    let hit = FULL.exec(v), size = 1
    if (!hit) {
      hit = OPEN.exec(v)
      const close = children[i + 1]
      if (!hit || close?.type !== 'html' || close.value?.trim() !== '</span>') break
      size = 2
    }
    const attrs = readAttrs(hit[1])
    if (!attrs || Object.keys(attrs).some((k) => seen.has(k))) break
    for (const k of Object.keys(attrs)) seen.add(k)
    out.push({ attrs, size })
    i += size
  }
  return out
}

/** 段落 / 标题:摘下段首的对齐 + 颜色标记。 */
export function takeBlockMarkers(children: MdNode[] | undefined): { align: TextAlignment; bg: string; fg: string; children: MdNode[] | undefined } {
  const marks = leadingMarkers(children)
  if (!marks.length) return { align: 'left', bg: '', fg: '', children }
  const all = Object.assign({}, ...marks.map((m) => m.attrs)) as Partial<Record<MarkerKey, string>>
  const used = marks.reduce((n, m) => n + m.size, 0)
  return { align: (all.align as TextAlignment | undefined) ?? 'left', bg: all.bg ?? '', fg: all.fg ?? '', children: children!.slice(used) }
}

/** mdast 行内节点的纯文字(同 PM 的 textContent:HTML 节点不算字)。只看开头一小段就够判断。 */
function mdText(nodes: MdNode[]): string {
  let out = ''
  for (const c of nodes) {
    if (out.length > 64) break
    if (c.type === 'html') continue
    out += c.children ? mdText(c.children) : (c.value ?? '')
  }
  return out
}

/** 列表项 / 引用:从第一段(段落或标题)的段首只摘**颜色**,对齐标记留给那一段自己。不改入参,返回新的 mdast 节点。 */
export function liftContainerColor<T extends MdNode>(node: T): { bg: string; fg: string; node: T } {
  const first = node.children?.[0]
  if (!first || (first.type !== 'paragraph' && first.type !== 'heading')) return { bg: '', fg: '', node }
  const marks = leadingMarkers(first.children)
  let bg = '', fg = '', i = 0
  const keep: MdNode[] = []
  for (const m of marks) {
    const own = first.children!.slice(i, i + m.size)
    i += m.size
    if (m.attrs.bg || m.attrs.fg) {
      bg ||= m.attrs.bg ?? ''
      fg ||= m.attrs.fg ?? ''
      // 同一枚里还带着对齐(手写形):对齐那部分还给段落
      if (m.attrs.align) keep.push({ type: 'html', value: `<span data-amadeus-align="${m.attrs.align}"></span>` })
    } else keep.push(...own)
  }
  if (!bg && !fg) return { bg: '', fg: '', node }
  const rest = first.children!.slice(i)
  const firstOut = { ...first, children: [...keep, ...rest] }
  // 摘了会变样的两种(Codex 评审 #2 #3),这时**不摘**:
  //  · 摘完段首又是一枚颜色标记(手写的重复标记):段落会把它当自己的颜色读走,写回时容器颜色盖掉它 → 第二枚丢了;
  //  · 引用里摘完露出 `[!type]`:读进来成了标注 / 折叠块,写回时标注不写颜色 → 标记丢了、结构也变了。
  //  后一种把颜色标记钉成正文 HTML(和没有 A1 时一模一样);前一种交给段落自己读(第一枚归段落,重复的那枚照旧是正文)。
  const relifts = leadingMarkers(firstOut.children).some((m) => m.attrs.bg || m.attrs.fg)
  // 口径同写盘那侧的 isCalloutQuote(PM textContent):HTML 不算字,转义拆开的几段文字拼起来看
  const exposesCallout = node.type === 'blockquote' && /^\[![^\]\s]+\]/.test(mdText(rest))
  if (exposesCallout) {
    const pinned = first.children!.map((c, k) => (k < i && c.type === 'html' && /data-amadeus-(?:bg|fg)=/.test(c.value ?? '') ? { ...c, amadeusKeep: true } : c))
    return { bg: '', fg: '', node: { ...node, children: [{ ...first, children: pinned }, ...node.children!.slice(1)] } }
  }
  if (relifts) return { bg: '', fg: '', node }
  return { bg, fg, node: { ...node, children: [firstOut, ...node.children!.slice(1)] } }
}

/** toDOM / parseDOM 两侧共用:颜色 attr ↔ data-bg / data-fg。 */
export const colorDomAttrs = (attrs: { bg?: unknown; fg?: unknown }): Record<string, string> => {
  const out: Record<string, string> = {}
  const bg = normalizeBlockColor(attrs.bg), fg = normalizeBlockColor(attrs.fg)
  if (bg) out['data-bg'] = bg
  if (fg) out['data-fg'] = fg
  // 「更多颜色」的 hex:CSS 按语义名查不到,直接给变量(不随暗色换,同划词的自定义色)
  const style = [HEX.test(bg) ? `--amx-blk-bg: ${bg}` : '', HEX.test(fg) ? `--amx-blk-fg: ${fg}` : ''].filter(Boolean).join('; ')
  if (style) out.style = style
  return out
}
export const colorFromDom = (dom: HTMLElement): BlockColor => ({
  bg: normalizeBlockColor(dom.getAttribute('data-bg')),
  fg: normalizeBlockColor(dom.getAttribute('data-fg')),
})
export const COLOR_ATTR_SPEC = { bg: { default: '' }, fg: { default: '' } }

/** 标记从 md 源串里剥掉(给按源码行找标题的地方用:`![[笔记#标题]]` 嵌入等)。只剥认识的块标记。 */
export function stripBlockMarkers(line: string): string {
  return line.replace(/^(\s*)(?:<span(?:\s+data-amadeus-(?:align|bg|fg)="[^"]*")+\s*><\/span>)+/, '$1')
}

// ── 容器(列表项 / 引用)写盘:把容器的颜色交给第一段,由段落的 toMarkdown 写进段首标记 ──────────────
type PMLike = {
  type: { name: string; create(attrs: unknown, content?: unknown, marks?: unknown): PMLike }
  attrs: Record<string, unknown>
  firstChild: PMLike | null
  isTextblock: boolean
  textContent: string
  content: { replaceChild(i: number, n: PMLike): unknown }
  marks: unknown
}

/** `> [!type]…` 标注 / 折叠块:颜色不写段首标记(令牌必须在段首,A5 另定存法)。 */
export const isCalloutQuote = (node: PMLike): boolean => {
  const first = node.firstChild
  return node.type.name === 'blockquote' && !!first && first.isTextblock && /^\[![^\]\s]+\]/.test(first.textContent)
}

/** 容器能不能存颜色:第一段是段落 / 标题,且不是标注。 */
export const containerTakesColor = (node: PMLike): boolean => {
  const first = node.firstChild
  return !!first && (first.type.name === 'paragraph' || first.type.name === 'heading') && !isCalloutQuote(node)
}

/** 带颜色的容器 → 第一段换成带同样颜色 attr 的副本(只用于序列化,不进文档)。存不下(见 containerTakesColor)原样返回。 */
export function withColorOnFirstChild<T extends PMLike>(node: T): T {
  if (!hasBlockColor(node.attrs) || !containerTakesColor(node)) return node
  const first = node.firstChild!
  const colored = first.type.create({ ...first.attrs, bg: normalizeBlockColor(node.attrs.bg), fg: normalizeBlockColor(node.attrs.fg) }, (first as unknown as { content: unknown }).content, first.marks)
  return node.type.create(node.attrs, node.content.replaceChild(0, colored), node.marks) as T
}
