// 脚注可写(评审 R-18):gfm 预设只带来了 schema(粘贴 md 能生成脚注,手打不行),这里补上输入规则、点击跳转、显示编号。
// 悬停预览在 unified/linkCard.tsx(复用链接卡片的计时与外壳)。
//
// 落盘零改动:footnote_reference / footnote_definition 照 gfm 预设原样序列化(`[^label]` / `[^label]: …`)。
// 编号只是**显示装饰**(按引用首次出现的次序数,装饰带给 nodeView 渲染),label 才是数据,命名脚注 `[^note]` 盘上仍是 note。
//
// ⚠️ 往返陷阱 —— 规则为什么长这样:
//  ① GFM 只在文中**有同名定义**时才把 `[^a]` 读成脚注引用,否则是字面文本(下一次保存还会被转义成 `\[^a]`)。
//     所以手打的引用还没有定义时,同一事务在文末建出空定义 `[^a]:`,并把光标送进去写脚注正文(Obsidian「插入脚注」/
//     Word / Google Docs 同款;点定义左侧的编号回到引用处)。定义已在 → 只插引用,光标原地。
//     空定义若被撂下,落盘是 `[^a]: <br />`(空段的既定编码,评审附录 A),重开仍是同一条定义。
//  ② 段落开头的 `[^a]` 后面若紧跟 `:`,落盘 `[^a]: …` 重开就成了**定义**(语义悄悄变了)。所以段首打的 `[^a]`
//     不当场转换,等下一个字:是 `:` 就留字面(多半在写定义,见 ③),别的字才转成引用 —— 那时 `]` 后已经不是 `:`。
//  ③ 顶层段落开头打 `[^a]: `(冒号后空格)= 写定义:整段包成 footnote_definition(列表 / 引用里不认:那里首段必须是段落)。
//     文中已有同名的**空**定义(① 自动建的那条)一并删掉,不留两条。
//  ④ 前面紧跟 `[`(Obsidian 块链接 `[[^id]]`)/ `!`(图片 `![^a](…)`)/ `\`(转义)的不认;代码块 / 行内代码里恒字面
//     (⚠️ Milkdown 的输入规则插件不看 InputRule 的 inCodeMark 选项,行内代码得自己判)。
//     代价:链接文字以 `^` 开头的 `[^a](url)` 手打不成链接(粘贴照常)。
//  ⑤ 规则刚跳到新定义时按退格 = 撤销这条规则(Milkdown 的 undoInputRule),但它的选区是从新定义里映射回来的,
//     会落在文末 —— 这里抢在它前面跑同一个撤销,光标放回原处(`[^a]` 之后)。
// 在定义末尾回车续写是容器语义(评审附录 A R-18),这里不碰。
// 仪器:check:rtcorpus 的 fn.* 键入组(键入 → 落盘 → 重开逐字)、check:linkcard 的 FN 组(悬停卡 / 点击跳转 / 编号 / 只读)。
import { $inputRule, $prose } from '@milkdown/kit/utils'
import { InputRule, undoInputRule } from '@milkdown/kit/prose/inputrules'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView, type NodeView } from '@milkdown/kit/prose/view'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { registerMessages, subscribeLocale, translate } from '../../../i18n'
import { unfoldToReveal } from '../../unified/revealText'
import { revealBlockAtTop } from '../../unified/revealScroll'
import { inCode } from './wikiAutocomplete'

registerMessages({
  'footnote.backToRef': { zh: '回到引用处', en: 'Back to reference' },
})

/** jumped = 上一笔事务是「建了新定义并把光标送过去」的那条规则(⑤ 的退格撤销据此接管)。 */
interface FnState { decos: DecorationSet; jumped: boolean }
const key = new PluginKey<FnState>('amx-footnote')
const JUMPED = 'jumped'

const REF = 'footnote_reference'
const DEF = 'footnote_definition'
/** 标签字符(micromark 同口径):不含空白、方括号、反斜杠;`￼` = 行内 leaf 占位,命中即不认。 */
const LABEL = '[^\\s[\\]\\\\\\ufffc]{1,200}'

/** 与 micromark normalizeIdentifier 同口径:`[^A]` 引用 `[^a]:` 的定义。 */
export const normLabel = (l: string): string => l.replace(/[\t\n\r ]+/g, ' ').trim().toLowerCase().toUpperCase()

/** 文中同名的第一条定义(GFM:重名取第一条)。 */
export function findFootnoteDef(doc: PMNode, label: string): { pos: number; node: PMNode } | null {
  const want = normLabel(label)
  let hit: { pos: number; node: PMNode } | null = null
  doc.descendants((n, pos) => {
    if (hit) return false
    if (n.type.name === DEF && normLabel(String(n.attrs.label)) === want) { hit = { pos, node: n }; return false }
    return !n.isTextblock // 定义是块,不进段落内部找
  })
  return hit
}

/** 定义的纯文本(悬停卡片用);没有定义 → null,空定义 → ''。 */
export function footnoteDefText(doc: PMNode, label: string): string | null {
  const d = findFootnoteDef(doc, label)
  if (!d) return null
  const parts: string[] = []
  d.node.descendants((n) => {
    if (n.isTextblock) { parts.push(n.textContent); return false }
    return true
  })
  return parts.join('\n').trim()
}

const isEmptyDef = (n: PMNode): boolean => n.type.name === DEF && n.childCount === 1 && n.firstChild!.isTextblock && n.firstChild!.content.size === 0

/** 把引用插进 [from, to)(其后可跟一段字面 tail);文中没有同名定义 → 文末补一条空定义并把光标送进去。 */
function insertRef(state: EditorState, from: number, to: number, label: string, tail = ''): Transaction | null {
  const refType = state.schema.nodes[REF]
  const defType = state.schema.nodes[DEF]
  const para = state.schema.nodes.paragraph
  if (!refType || !defType || !para || inCode(state, from, to)) return null
  const tr = state.tr.replaceWith(from, to, refType.create({ label }))
  if (tail) tr.insertText(tail, from + 1)
  if (findFootnoteDef(state.doc, label)) return tr
  const at = tr.doc.content.size
  tr.insert(at, defType.create({ label }, para.create()))
  return tr.setSelection(TextSelection.create(tr.doc, at + 2)).setMeta(key, JUMPED).scrollIntoView()
}

/** ① 文中(非段首)打完 `[^label]` 的 `]` → 脚注引用。 */
const refRule = new InputRule(new RegExp(`(?<![[!\\\\])\\[\\^(${LABEL})\\]$`, 'u'), (state, match, start, end) => {
  const $s = state.doc.resolve(start)
  if ($s.parentOffset === 0 && $s.parent.type.name === 'paragraph') return null // 段首交给 leadRule(②)
  return insertRef(state, start, end, match[1])
}, { inCodeMark: false })

/** ② 段首的 `[^label]` 等下一个字:不是 `:`(也不是回车)才转引用,那个字照常落在引用后面。 */
const leadRule = new InputRule(new RegExp(`^\\[\\^(${LABEL})\\]([^:\\n])$`, 'u'), (state, match, start, end) => {
  const $s = state.doc.resolve(start)
  if ($s.parentOffset !== 0 || $s.parent.type.name !== 'paragraph') return null
  return insertRef(state, start, end, match[1], match[2])
}, { inCodeMark: false })

/** ③ 顶层段首打 `[^label]: ` → 整段包成脚注定义;同名的空定义(① 自动建的)一并删掉。 */
const defRule = new InputRule(new RegExp(`^\\[\\^(${LABEL})\\]:[ \\u00a0]$`, 'u'), (state, match, start, end) => {
  const defType = state.schema.nodes[DEF]
  const $s = state.doc.resolve(start)
  if (!defType || $s.parentOffset !== 0 || $s.parent.type.name !== 'paragraph' || $s.depth !== 1 || inCode(state, start, end)) return null
  const label = match[1]
  const empties: number[] = []
  state.doc.forEach((n, pos) => { if (isEmptyDef(n) && normLabel(String(n.attrs.label)) === normLabel(label)) empties.push(pos) })
  const tr = state.tr.delete(start, end)
  const range = tr.doc.resolve(start).blockRange()
  if (!range) return null
  tr.wrap(range, [{ type: defType, attrs: { label } }])
  for (const pos of empties.reverse()) {
    const at = tr.mapping.map(pos)
    const n = tr.doc.nodeAt(at)
    if (n && isEmptyDef(n)) tr.delete(at, at + n.nodeSize)
  }
  return tr
}, { inCodeMark: false })

export const footnoteInputRules = [$inputRule(() => refRule), $inputRule(() => leadRule), $inputRule(() => defRule)]

// ── 编号(显示装饰)+ 点击跳转 ─────────────────────────────────────────────────────────────

/** label → 编号:按引用在文中首次出现的次序(GFM 渲染同口径);同名引用同号。 */
function numbering(doc: PMNode): DecorationSet {
  const nums = new Map<string, number>()
  const refs: Array<{ pos: number; node: PMNode }> = []
  const defs: Array<{ pos: number; node: PMNode }> = []
  doc.descendants((n, pos) => {
    if (n.type.name === REF) {
      const k = normLabel(String(n.attrs.label))
      if (!nums.has(k)) nums.set(k, nums.size + 1)
      refs.push({ pos, node: n })
    } else if (n.type.name === DEF) defs.push({ pos, node: n })
    return true
  })
  if (!refs.length && !defs.length) return DecorationSet.empty
  const deco = (x: { pos: number; node: PMNode }): Decoration => {
    const num = nums.get(normLabel(String(x.node.attrs.label)))
    // 编号同时进 attrs:PM 判外层装饰相等只比 attrs(不比 spec),只放 spec 的话编号变了 nodeView 收不到 update。
    return Decoration.node(x.pos, x.pos + x.node.nodeSize, { 'data-fn-num': num == null ? '' : String(num) }, { fnNum: num ?? null })
  }
  return DecorationSet.create(doc, [...refs, ...defs].map(deco))
}

/** 这一事务插进来的内容里有没有脚注节点(没有、且之前文中也没有 → 不必整篇重数)。 */
function touchesFootnotes(tr: Transaction): boolean {
  return tr.steps.some((s) => {
    const slice = (s as unknown as { slice?: { content: { descendants: (f: (n: PMNode) => boolean) => void } } }).slice
    let hit = false
    slice?.content.descendants((n) => { if (n.type.name === REF || n.type.name === DEF) hit = true; return !hit })
    return hit
  })
}

const numOf = (decos: readonly Decoration[]): number | null => {
  for (const d of decos) { const n = (d.spec as { fnNum?: number | null }).fnNum; if (n != null) return n }
  return null
}

class RefView implements NodeView {
  dom: HTMLElement
  constructor(private node: PMNode, decos: readonly Decoration[]) {
    this.dom = document.createElement('sup')
    this.dom.setAttribute('data-type', REF) // parseDOM / 悬停卡 / 仪器都认这两个属性
    this.dom.contentEditable = 'false'
    this.render(decos)
  }
  private render(decos: readonly Decoration[]): void {
    const label = String(this.node.attrs.label)
    const num = numOf(decos)
    this.dom.setAttribute('data-label', label)
    this.dom.textContent = num != null ? String(num) : label
  }
  update(node: PMNode, decos: readonly Decoration[]): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render(decos)
    return true
  }
  ignoreMutation(): boolean { return true }
}

class DefView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private dt: HTMLElement
  private off: () => void
  constructor(private node: PMNode, decos: readonly Decoration[]) {
    this.dom = document.createElement('dl')
    this.dom.setAttribute('data-type', DEF)
    this.dt = document.createElement('dt')
    this.dt.contentEditable = 'false'
    this.contentDOM = document.createElement('dd')
    this.dom.append(this.dt, this.contentDOM)
    const title = (): void => { this.dt.title = translate('footnote.backToRef') }
    title()
    this.off = subscribeLocale(title)
    this.render(decos)
  }
  private render(decos: readonly Decoration[]): void {
    const label = String(this.node.attrs.label)
    const num = numOf(decos)
    this.dom.setAttribute('data-label', label)
    this.dt.textContent = num != null ? String(num) : label // 没有引用的定义:没有编号,显示 label
  }
  update(node: PMNode, decos: readonly Decoration[]): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render(decos)
    return true
  }
  ignoreMutation(m: MutationRecord | { type: 'selection'; target: Node }): boolean {
    if (m.type === 'selection') return false
    return m.target === this.dom || !this.contentDOM.contains(m.target)
  }
  destroy(): void { this.off() }
}

/** 已在视野里就不滚(短文里点一下脚注别把页面拽走);否则贴到阅读位置(让开 sticky 顶栏,C-03 同口径)。 */
function reveal(el: Node | null): void {
  if (!(el instanceof HTMLElement)) return
  const r = el.getBoundingClientRect()
  if (r.top >= 0 && r.bottom <= window.innerHeight) return
  revealBlockAtTop(el)
}

/** 引用 → 定义:展开藏着它的折叠,光标落在定义正文末尾(接着就能写),滚进视野。只读视图照样跳(只是不能改)。 */
export function jumpToFootnoteDef(view: EditorView, label: string): boolean {
  let d = findFootnoteDef(view.state.doc, label)
  if (!d) return false
  if (unfoldToReveal(view, d.pos)) d = findFootnoteDef(view.state.doc, label)
  if (!d) return false
  const end = d.pos + d.node.nodeSize - 1
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(end), -1)))
  view.focus()
  reveal(view.nodeDOM(d.pos))
  return true
}

/** 定义 → 回到第一处引用(光标落在引用之后)。 */
export function jumpToFootnoteRef(view: EditorView, label: string): boolean {
  const want = normLabel(label)
  let at = -1
  view.state.doc.descendants((n, pos) => {
    if (at >= 0) return false
    if (n.type.name === REF && normLabel(String(n.attrs.label)) === want) at = pos
    return at < 0
  })
  if (at < 0) return false
  unfoldToReveal(view, at)
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at + 1))))
  view.focus()
  reveal(view.nodeDOM(at))
  return true
}

export const footnotePlugin = $prose(() => new Plugin({
  key,
  state: {
    init: (_c, s): FnState => ({ decos: numbering(s.doc), jumped: false }),
    apply: (tr, prev): FnState => {
      // 与输入规则插件的撤销态同口径:只有改文档 / 动选区的事务才作废(其他插件跟着派的纯 meta 事务不算)。
      const jumped = tr.getMeta(key) === JUMPED || (!tr.docChanged && !tr.selectionSet && prev.jumped)
      let decos = prev.decos
      if (tr.docChanged && (decos !== DecorationSet.empty || touchesFootnotes(tr))) decos = numbering(tr.doc)
      return decos === prev.decos && jumped === prev.jumped ? prev : { decos, jumped }
    },
  },
  props: {
    decorations: (state) => key.getState(state)?.decos,
    // ⑤ 刚跳到新定义就退格 = 撤销规则,光标回到原处(Milkdown 核心键表在全部 prose 插件之后,这里先拿到键)。
    handleKeyDown(view, event) {
      if (event.key !== 'Backspace' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false
      if (!key.getState(view.state)?.jumped) return false
      const u = view.state.plugins.map((p) => (p.spec as { isInputRules?: boolean }).isInputRules ? p.getState(view.state) as { from: number; text: string } | null : null).find(Boolean)
      if (!u) return false
      return undoInputRule(view.state, (tr) => {
        const at = Math.min(u.from + u.text.length, tr.doc.content.size)
        view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(at))).scrollIntoView())
      })
    },
    nodeViews: {
      [REF]: (node, _view, _getPos, decos) => new RefView(node, decos),
      [DEF]: (node, _view, _getPos, decos) => new DefView(node, decos),
    },
    // 点上标 = 跳到定义(PM 默认会把这个原子节点整个选中,什么也不发生)。右键 / mac Ctrl+点击留给系统菜单。
    handleClickOn(view, _pos, node, _nodePos, event, direct) {
      if (!direct || node.type.name !== REF || event.button !== 0 || event.ctrlKey) return false
      return jumpToFootnoteDef(view, String(node.attrs.label))
    },
    handleDOMEvents: {
      // 定义左侧的编号 = 回到引用处。按下就接管:dt 不可编辑,不许 PM 把光标塞进 dl 外壳。
      mousedown(view, event) {
        if (event.button !== 0) return false
        const dt = (event.target as HTMLElement | null)?.closest?.(`dl[data-type="${DEF}"] > dt`)
        if (!dt || !view.dom.contains(dt)) return false
        const label = dt.parentElement?.getAttribute('data-label') ?? ''
        event.preventDefault()
        jumpToFootnoteRef(view, label)
        return true
      },
    },
  },
}))
