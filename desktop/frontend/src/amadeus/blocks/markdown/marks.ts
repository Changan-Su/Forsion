// 三个自定义行内标记(下划线 / 文字色 / 背景色),落盘为 Obsidian 可渲染的 HTML:
//   <u>x</u> / <span style="color:X">x</span> / <mark style="background:X">x</mark>
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
  return null
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

export const inlineHtmlMarksRemark = $remark('amadeusInlineHtmlMarks', () =>
  function inlineHtmlMarks(this: any) {
    const data = this.data()
    const toMd = (data.toMarkdownExtensions ||= [])
    toMd.push({
      handlers: {
        [U]: htmlWrap(() => '<u>', '</u>'),
        [FG]: htmlWrap((n: MdNode) => `<span style="color:${n.color}">`, '</span>'),
        [BG]: htmlWrap((n: MdNode) => `<mark style="background:${n.bg}">`, '</mark>'),
      },
    })
    return (tree: MdNode): void => {
      if (Array.isArray(tree?.children)) tree.children = foldTags(tree.children)
    }
  },
)

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

// AFFiNE theme v2 高亮色 → 语义名(亮色 hex 落盘保 Obsidian 可渲染;in-app 暗色靠 data-hl/data-hlc
// 语义名走 styles.css 的 [data-mode='dark'] 覆盖)。与 InlineToolbar 色板同源,改一处必须三处同步。
// 正典 = AFFiNE **v1** 编辑器色板(--affine-text-highlight-*,@toeverything/theme dist/style.css
// 实测;高亮菜单实际引用的是 v1 变量,v2 design token 不是编辑器渲染值)。品红为本产品扩展。
const HL_FG_NAMES: Record<string, string> = {
  '#c62222': 'red', '#d34f0b': 'orange', '#b67c04': 'yellow', '#149343': 'green',
  '#0782a0': 'teal', '#2159d3': 'blue', '#842ed3': 'purple', '#941555': 'magenta', '#7a7a7a': 'grey',
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

export const colorSchema = $markSchema('amadeusColor', () => ({
  attrs: { color: { default: '' } },
  parseDOM: [{ tag: 'span[style*="color"]', getAttrs: (dom) => ({ color: (dom as HTMLElement).style.color }) }],
  toDOM: (mark) => {
    const c = String(mark.attrs.color)
    const name = HL_FG_NAMES[c.toLowerCase()]
    return ['span', { style: `color:${c}`, ...(name ? { 'data-hlc': name } : {}) }, 0]
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
  parseDOM: [{ tag: 'mark', getAttrs: (dom) => ({ bg: (dom as HTMLElement).style.backgroundColor || '' }) }],
  toDOM: (mark) => {
    const bg = String(mark.attrs.bg)
    if (!bg) return ['mark', {}, 0]
    const name = HL_BG_NAMES[bg.toLowerCase()]
    return ['mark', { style: `background:${bg}`, ...(name ? { 'data-hl': name } : {}) }, 0]
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
