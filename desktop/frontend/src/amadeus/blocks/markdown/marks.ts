// 三个自定义行内标记(下划线 / 文字色 / 背景色),落盘为 Obsidian 可渲染的 HTML:
//   <u>x</u> / <span style="color:X">x</span> / <mark style="background:X">x</mark>
// 另有三个无属性的语义标签(I-17):<kbd>x</kbd> / <sub>x</sub> / <sup>x</sup> —— 原先各被拆成开、合两个不可编辑的
// html 原子,现在折叠成可编辑的 mark。**只认小写、无属性**的写法:大小写或属性一变,往返就写不回原字节,那些照旧留原子。
// 仓库首个 schema mark。难点在“解析回来”:remark 把行内 HTML 拆成开合两个 html 兄弟节点
// (见 tmp/remark-roundtrip 探针),逐节点 runner 无法配对 → 自建 remark 桥:
//   parse 侧:transformer 用栈把 [<tag>,…,</tag>](含嵌套)折叠成单个带 children 的 mdast 节点;
//   serialize 侧:toMarkdownExtensions 把该节点还原成 HTML(gfm 删除线同款机制,已证 Milkdown 序列化器认)。
// Milkdown 自带的 remarkHtmlTransformer 只包裹块级 html、不碰行内(preset 源码已核),故不冲突。
import { $command, $markSchema, $remark } from '@milkdown/kit/utils'
import { toggleMark } from '@milkdown/kit/prose/commands'
import type { Command } from '@milkdown/kit/prose/state'
import type { MarkType } from '@milkdown/kit/prose/model'

// mdast 节点类型名(仅存在于内存 AST,不落盘)
const U = 'amadeusU'
const FG = 'amadeusFg'
const BG = 'amadeusBg'
const KBD = 'amadeusKbd'
const SUB = 'amadeusSub'
const SUP = 'amadeusSup'
/** 无属性语义标签:字面 `<tag>` / `</tag>`(只认小写,见文件头)→ mdast 类型。 */
const PLAIN_TAGS = new Map<string, string>([['kbd', KBD], ['sub', SUB], ['sup', SUP]])

// mdast 节点是动态形状(remark AST),这层统一按 any 处理,不值得为它铺一套精确类型。
/* eslint-disable @typescript-eslint/no-explicit-any */
type MdNode = any
type Folded = { type: string; color?: string; bg?: string }

// 颜色值白名单:只认十六进制/rgb(a)/hsl(a)/纯字母命名色/CSS 变量。锚定整串 →
// 拒绝多声明注入(如 `red&#x3b background-image:url(...)`,编码分号绕过 [^;] 后被 & 挡下)、
// url()/expression()、引号/尖括号突破属性(Codex M3)。不安全 → openTag 返回 null → 该标签留字面。
const isSafeColor = (v: string): boolean =>
  /^(#[0-9a-fA-F]{3,8}|rgba?\([\d.,%\s/]+\)|hsla?\([\d.,%\s/]+\)|[a-zA-Z]+|var\(--[\w-]+\))$/.test(v.trim())

function openTag(n: MdNode): Folded | null {
  if (n?.type !== 'html' || typeof n.value !== 'string') return null
  const s = n.value.trim()
  if (/^<u>$/i.test(s)) return { type: U }
  const plain = /^<([a-z]+)>$/.exec(s)
  const plainType = plain && PLAIN_TAGS.get(plain[1])
  if (plainType) return { type: plainType }
  // `(?:[^"]*;\s*)?color:` 要求 color 起一条声明(串首或分号后)→ 不误吃 border-color/background-color(Codex M4)。
  let m = s.match(/^<span\s+style\s*=\s*"(?:[^"]*;\s*)?color\s*:\s*([^;"]+)[^"]*"\s*>$/i)
  if (m) {
    const c = m[1].trim()
    return isSafeColor(c) ? { type: FG, color: c } : null
  }
  m = s.match(/^<mark(?:\s+style\s*=\s*"(?:[^"]*;\s*)?background\s*:\s*([^;"]+)[^"]*")?\s*>$/i)
  if (m) {
    const bg = (m[1] ?? '').trim()
    if (bg && !isSafeColor(bg)) return null
    return { type: BG, bg }
  }
  return null
}
function closeTag(n: MdNode): string | null {
  if (n?.type !== 'html' || typeof n.value !== 'string') return null
  const s = n.value.trim()
  if (/^<\/u>$/i.test(s)) return U
  if (/^<\/span>$/i.test(s)) return FG
  if (/^<\/mark>$/i.test(s)) return BG
  const plain = /^<\/([a-z]+)>$/.exec(s)
  return (plain && PLAIN_TAGS.get(plain[1])) || null
}

// 把一层 children 里的 <tag>…</tag> 折叠成 mark 节点(栈式)。三条硬约束(Codex):
//  · 深度上限 CAP:超深不折叠、开合标签留字面 —— 防超深嵌套撑爆 parseMarkdown 递归栈(M1)。
//  · 同型祖先已开 → 幽灵帧:内容并入外层,不建嵌套节点 —— Milkdown mark 是集合,嵌套同型 closeMark 会
//    连外层一起抹掉(下划线扁平化=正确;同型异色=降级为外层色,但绝不产生无标记文本)(M2)。
//  · 未闭合的 real 帧 → 撤销折叠,还原成 [原始<open> 字面, …已收 children] —— 不丢开标签、不吞内容(L1)。
const FOLD_DEPTH_CAP = 16
type Frame = { tgt: MdNode[]; type: string | null; kind: 'real' | 'phantom' | 'literal'; raw: MdNode; node: MdNode }
function foldTags(children: MdNode[]): MdNode[] {
  const rootTgt: MdNode[] = []
  const stack: Frame[] = [{ tgt: rootTgt, type: null, kind: 'real', raw: null, node: null }]
  const top = (): Frame => stack[stack.length - 1]
  for (const n of children) {
    const open = openTag(n)
    const close = closeTag(n)
    if (open) {
      const depth = stack.length - 1
      const sameTypeOpen = stack.some((f) => f.kind === 'real' && f.type === open.type)
      if (depth >= FOLD_DEPTH_CAP) {
        top().tgt.push(n) // 超深:开标签留字面
        stack.push({ tgt: top().tgt, type: open.type, kind: 'literal', raw: n, node: null })
      } else if (sameTypeOpen) {
        stack.push({ tgt: top().tgt, type: open.type, kind: 'phantom', raw: n, node: null })
      } else {
        const node: MdNode = { ...open, children: [] }
        top().tgt.push(node)
        stack.push({ tgt: node.children, type: open.type, kind: 'real', raw: n, node })
      }
    } else if (close && stack.length > 1 && top().type === close) {
      const f = stack.pop() as Frame
      if (f.kind === 'literal') top().tgt.push(n) // 字面 close 配字面 open
    } else {
      if (Array.isArray(n?.children)) n.children = foldTags(n.children)
      top().tgt.push(n)
    }
  }
  while (stack.length > 1) {
    const f = stack.pop() as Frame
    if (f.kind === 'real') {
      const parent = top().tgt
      const i = parent.indexOf(f.node)
      if (i >= 0) parent.splice(i, 1, f.raw, ...f.node.children) // 还原字面 <open> + 摊平已收内容
    }
    // phantom / literal:内容已在外层,开标签(literal)也已字面,无需处理
  }
  return rootTgt
}

// serialize:mark 节点 → HTML(mdast-util-to-markdown handler)。照 gfm 删除线 handler 形状。
function htmlWrap(open: (n: MdNode) => string, close: string) {
  const handle = (node: MdNode, _p: unknown, state: any, info: any): string => {
    const tracker = state.createTracker(info)
    const exit = state.enter('emphasis') // 借 phrasing 构造名参与转义上下文;不影响输出
    let value = tracker.move(open(node))
    value += state.containerPhrasing(node, { ...info, before: '>', after: '<' })
    value += tracker.move(close)
    exit()
    return value
  }
  handle.peek = (): string => '<'
  return handle
}

// 真身单独导出:$remark 包起来之后拿不回 unified 插件(要 ctx),而落盘正确性必须能单测。
export function inlineHtmlMarksPlugin(this: any) {
  const data = this.data()
  const toMd = (data.toMarkdownExtensions ||= [])
  toMd.push({
    handlers: {
      // 注:`~~`/`**`/`*` 的落盘修正不在这里 —— 扩展里的 handler 会被 milkdown 的
      // `remarkStringifyOptionsCtx.handlers` 压掉,见 attentionFlanking.ts 文件头。
      [U]: htmlWrap(() => '<u>', '</u>'),
      [FG]: htmlWrap((n: MdNode) => `<span style="color:${n.color}">`, '</span>'),
      [BG]: htmlWrap((n: MdNode) => `<mark style="background:${n.bg}">`, '</mark>'),
      [KBD]: htmlWrap(() => '<kbd>', '</kbd>'),
      [SUB]: htmlWrap(() => '<sub>', '</sub>'),
      [SUP]: htmlWrap(() => '<sup>', '</sup>'),
    },
  })
  return (tree: MdNode): void => {
    if (Array.isArray(tree?.children)) tree.children = foldTags(tree.children)
  }
}

export const inlineHtmlMarksRemark = $remark('amadeusInlineHtmlMarks', () => inlineHtmlMarksPlugin)

export const underlineSchema = $markSchema('amadeusUnderline', () => ({
  parseDOM: [{ tag: 'u' }],
  toDOM: () => ['u', 0],
  parseMarkdown: {
    match: (node) => node.type === U,
    runner: (state, node, markType) => {
      state.openMark(markType)
      state.next(node.children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'amadeusUnderline',
    runner: (state, mark) => {
      state.withMark(mark, U)
    },
  },
}))

/** `<kbd>` / `<sub>` / `<sup>`:无属性 mark,解析 / 序列化与下划线同形。 */
function plainTagSchema(id: string, tag: string, mdType: string) {
  return $markSchema(id, () => ({
    parseDOM: [{ tag }],
    toDOM: () => [tag, 0],
    parseMarkdown: {
      match: (node) => node.type === mdType,
      runner: (state, node, markType) => {
        state.openMark(markType)
        state.next(node.children)
        state.closeMark(markType)
      },
    },
    toMarkdown: {
      match: (mark) => mark.type.name === id,
      runner: (state, mark) => {
        state.withMark(mark, mdType)
      },
    },
  }))
}
export const kbdSchema = plainTagSchema('amadeusKbd', 'kbd', KBD)
export const subSchema = plainTagSchema('amadeusSub', 'sub', SUB)
export const supSchema = plainTagSchema('amadeusSup', 'sup', SUP)

// AFFiNE theme v2 高亮色 → 语义名(亮色 hex 落盘保 Obsidian 可渲染;in-app 暗色靠 data-hl/data-hlc
// 语义名走 styles.css 的 [data-mode='dark'] 覆盖)。与 InlineToolbar 色板同源,改一处必须三处同步。
// 正典 = AFFiNE **v1** 编辑器色板(--affine-text-highlight-*,@toeverything/theme dist/style.css
// 实测;高亮菜单实际引用的是 v1 变量,v2 design token 不是编辑器渲染值)。品红为本产品扩展。
const HL_FG_NAMES: Record<string, string> = {
  '#c62222': 'red', '#b9450a': 'orange', '#8f6203': 'yellow', '#117b38': 'green',
  '#06748f': 'teal', '#2159d3': 'blue', '#842ed3': 'purple', '#941555': 'magenta', '#6a6a6a': 'grey',
  // 2026-08-25 前的 v1 原值：也识别为语义色，便于应用内按明暗可读色补偿。
  '#d34f0b': 'orange', '#b67c04': 'yellow', '#149343': 'green', '#0782a0': 'teal', '#7a7a7a': 'grey',
  '#ca4c0b': 'orange', '#9e6b03': 'yellow', '#12873e': 'green', '#077f9d': 'teal', '#757575': 'grey',
  // 2026-08-13 当日 v2 token 误版兼容别名(当日落盘的文档):
  '#c83030': 'red', '#db7123': 'orange', '#ac7400': 'yellow', '#225c18': 'green',
  '#0e4841': 'teal', '#003c67': 'blue', '#7c3aed': 'purple',
  // 旧色板(Open Color,2026-08-13 前落盘的文档)兼容别名:暗色下同样按语义名覆盖,不留刺眼亮色。
  '#e03131': 'red', '#e8590c': 'orange', '#f08c00': 'yellow', '#2f9e44': 'green',
  '#0c8599': 'teal', '#1971c2': 'blue', '#9c36b5': 'purple', '#868e96': 'grey',
}
const HL_BG_NAMES: Record<string, string> = {
  '#fed5d5': 'red', '#fedfbb': 'orange', '#fef3a1': 'yellow', '#e1fab1': 'green',
  '#adf8e9': 'teal', '#cce2fe': 'blue', '#edddff': 'purple', '#ffcece': 'magenta', '#eaecef': 'grey',
  // 2026-08-13 当日 v2 token 误版兼容别名:
  '#fce5e6': 'red', '#ffebd5': 'orange', '#fff9b6': 'yellow', '#f0fccb': 'green',
  '#c7f8f2': 'teal', '#daf0ff': 'blue', '#ede9ff': 'purple', '#ffecf6': 'magenta', '#e6e6e6': 'grey',
  // 旧色板兼容别名(同上)。
  '#ffe3e3': 'red', '#ffe8cc': 'orange', '#fff3bf': 'yellow', '#d3f9d8': 'green',
  '#c5f6fa': 'teal', '#d0ebff': 'blue', '#f3d9fa': 'purple', '#e9ecef': 'grey',
}

// ── 粘贴 / 拖入的 HTML → 颜色 mark(D-09,评审 2026-09-27)────────────────────────────────────────────
// 旧版 parseDOM 照单全收:Google Docs 的 `color:#000000`、暗色网站的浅灰字被固化进笔记(另一种明暗下看不见),
// 只带背景色的 span 被 `style*="color"` 误中写成 `<span style="color:">`;应用内复制的红字 / 黄底被浏览器
// 归一成 `rgb()`,查色板只认 hex → data-hl/data-hlc 丢了,暗色补偿永久失效。
// 现口径(同 Notion「不在色板里的颜色一律丢弃」):
//  1. 本应用自己写出的元素带 data-amx-fg / data-amx-bg(toDOM 写入的原值)→ 原样收(应用内复制跨篇、跨窗口不丢
//     手写的自定义色),仍过 isSafeColor;
//  2. 语义名 data-hlc / data-hl → 色板值(样式 hex 与语义名一致时保留样式那一档,兼容旧色板别名);
//  3. 样式色归一成 hex(浏览器给的是 `rgb(r, g, b)`)命中色板 → 收;
//  4. 其余一律不建 mark:文字色返回 false(规则不匹配,正文照常解析),`<mark>` 降为无色高亮。
// 只管 DOM 这一侧;磁盘 md 里用户手写的 `<span style="color:…">` 走 openTag,照旧认。仪器 marks.test.ts。
/** CSS 颜色串 → 小写 `#rrggbb`;认 `#rgb` / `#rrggbb` / `rgb(r, g, b)` / 不透明的 `rgba(…)`。其余(命名色、半透明、hsl…)→ null。 */
export function cssColorToHex(v: string): string | null {
  const s = v.trim().toLowerCase()
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s)
  if (h) return '#' + (h[1].length === 3 ? [...h[1]].map((c) => c + c).join('') : h[1])
  const m = /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/.exec(s)
  if (!m) return null
  if (m[4] !== undefined && Number(m[4]) !== (m[5] ? 100 : 1)) return null
  const n = [m[1], m[2], m[3]].map(Number)
  return n.some((x) => x > 255) ? null : '#' + n.map((x) => x.toString(16).padStart(2, '0')).join('')
}
/** 语义名 → 该色当前色板值(表里每个名字第一次出现的那条 = 现行色板,后面是旧版别名)。 */
const canonicalOf = (table: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [hex, name] of Object.entries(table)) if (!(name in out)) out[name] = hex
  return out
}
const HL_FG_CANON = canonicalOf(HL_FG_NAMES)
const HL_BG_CANON = canonicalOf(HL_BG_NAMES)
const paletteHit = (table: Record<string, string>, canon: Record<string, string>, name: string | null, styleColor: string): string | null => {
  const hex = cssColorToHex(styleColor)
  if (hex && table[hex] && (!name || table[hex] === name)) return hex
  return name && canon[name] ? canon[name] : null
}
/** 粘贴 HTML 里的 span → 文字色 mark attrs;不是本应用的色 → false(不建 mark)。 */
export function pastedFgAttrs(dom: HTMLElement): { color: string } | false {
  const own = dom.getAttribute('data-amx-fg')
  if (own && isSafeColor(own)) return { color: own }
  if (!dom.style.color) return false // 只有 background-color 之类:不是文字色
  const c = paletteHit(HL_FG_NAMES, HL_FG_CANON, dom.getAttribute('data-hlc'), dom.style.color)
  return c ? { color: c } : false
}
/** 粘贴 HTML 里的 `<mark>` → 背景色 attrs;色板外的背景 → 无色高亮(保留「高亮」语义,丢外来颜色)。 */
export function pastedBgAttrs(dom: HTMLElement): { bg: string } {
  const own = dom.getAttribute('data-amx-bg')
  if (own !== null && (own === '' || isSafeColor(own))) return { bg: own }
  return { bg: paletteHit(HL_BG_NAMES, HL_BG_CANON, dom.getAttribute('data-hl'), dom.style.backgroundColor) ?? '' }
}
/** toDOM 查语义名:存量里被旧版粘贴写成 `rgb()` 的也认回来(只影响显示,不改盘上字节)。 */
const semanticOf = (table: Record<string, string>, v: string): string | undefined => table[cssColorToHex(v) ?? v.toLowerCase()]

export const colorSchema = $markSchema('amadeusColor', () => ({
  attrs: { color: { default: '' } },
  parseDOM: [{ tag: 'span[style*="color"]', getAttrs: (dom) => pastedFgAttrs(dom as HTMLElement) }],
  toDOM: (mark) => {
    const c = String(mark.attrs.color)
    const name = semanticOf(HL_FG_NAMES, c)
    return ['span', { style: `color:${c}`, 'data-amx-fg': c, ...(name ? { 'data-hlc': name } : {}) }, 0]
  },
  parseMarkdown: {
    match: (node) => node.type === FG,
    runner: (state, node, markType) => {
      state.openMark(markType, { color: (node as MdNode).color })
      state.next(node.children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'amadeusColor',
    runner: (state, mark) => {
      state.withMark(mark, FG, undefined, { color: mark.attrs.color })
    },
  },
}))

export const bgSchema = $markSchema('amadeusBg', () => ({
  attrs: { bg: { default: '' } },
  parseDOM: [{ tag: 'mark', getAttrs: (dom) => pastedBgAttrs(dom as HTMLElement) }],
  toDOM: (mark) => {
    const bg = String(mark.attrs.bg)
    if (!bg) return ['mark', { 'data-amx-bg': '' }, 0]
    const name = semanticOf(HL_BG_NAMES, bg)
    return ['mark', { style: `background:${bg}`, 'data-amx-bg': bg, ...(name ? { 'data-hl': name } : {}) }, 0]
  },
  parseMarkdown: {
    match: (node) => node.type === BG,
    runner: (state, node, markType) => {
      state.openMark(markType, { bg: (node as MdNode).bg })
      state.next(node.children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'amadeusBg',
    runner: (state, mark) => {
      state.withMark(mark, BG, undefined, { bg: mark.attrs.bg })
    },
  },
}))

// 命令:下划线切换 + 文字色/背景色(带值应用,空值=清除该 mark)。
export const toggleUnderlineCommand = $command('AmadeusToggleUnderline', (ctx) => () =>
  toggleMark(underlineSchema.type(ctx)),
)

function setAttrMark(type: MarkType, attrs: Record<string, string>): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection
    if (empty) return false
    if (dispatch) dispatch(state.tr.removeMark(from, to, type).addMark(from, to, type.create(attrs)))
    return true
  }
}
function clearAttrMark(type: MarkType): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection
    if (empty) return false
    if (dispatch) dispatch(state.tr.removeMark(from, to, type))
    return true
  }
}
export const applyColorCommand = $command('AmadeusApplyColor', (ctx) => (color?: string) =>
  color ? setAttrMark(colorSchema.type(ctx), { color }) : clearAttrMark(colorSchema.type(ctx)),
)
export const applyBgCommand = $command('AmadeusApplyBg', (ctx) => (bg?: string) =>
  bg ? setAttrMark(bgSchema.type(ctx), { bg }) : clearAttrMark(bgSchema.type(ctx)),
)
