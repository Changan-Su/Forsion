// 版块(方向 B,page/5)的编辑命令与工具条挂载点。格式、PM 节点与规范化在 columns.ts
// (版块 = 带 section attr 的 amadeusColumnRow);这里只管「怎么建、怎么改、工具条挂在哪」。
//
// 工具条:选区落在某个版块里时,在那一行的末尾挂一个 widget(行是 flex 容器,widget 绝对定位、不占栏位),
// 工具条本体是 React(SectionToolbar.tsx)经 portal 渲进去。插件只在「哪个版块、它的样式 / 栏数」变了时
// 通知一次 —— 在版块里打字不触发任何 React 重渲。
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { Fragment, type Node as ProseNode } from '@milkdown/kit/prose/model'
import { $prose } from '@milkdown/kit/utils'
import { freshAnchorId, isSectionRow, patchSection, unsplitRow, SECTION_MAX_COLUMNS, type SectionView } from './columns'

/** 选区所在的版块行(顶层行的前位);不在版块里 = null。行不可整体选中,块选中 / 光标都在栏里(depth ≥ 2)。 */
export function sectionRowAt(state: EditorState, pos: number = state.selection.from): number | null {
  const $p = state.doc.resolve(pos)
  if ($p.depth < 1) return null
  return isSectionRow($p.node(1)) ? $p.before(1) : null
}

/** 唯一新锚(同一事务里连铸几枚也不撞)。 */
function minter(doc: ProseNode): () => string {
  const taken = new Set<string>()
  return () => {
    let id = freshAnchorId(doc)
    while (taken.has(id)) id = freshAnchorId(doc)
    taken.add(id)
    return id
  }
}

const BLOCKED = new Set(['amadeusColumnRow', 'amadeusColumnCell', 'amadeusCanvasCard'])

/** [from, to) 是不是一段能整体装进版块的顶层块(不含分栏行 / 画布卡)。 */
export function canWrapInSection(state: EditorState, from: number, to: number): boolean {
  if (from >= to || state.doc.resolve(from).depth !== 0 || state.doc.resolve(to).depth !== 0) return false
  let ok = true
  state.doc.nodesBetween(from, to, (n, _pos, parent) => {
    if (parent === state.doc && BLOCKED.has(n.type.name)) ok = false
    return false
  })
  return ok
}

function markStructural(tr: Transaction): Transaction {
  // amxColumns = 结构性事务;KeepEmpty:刚建出来的空栏是给人填的,别被规范化当场清掉
  return tr.setMeta('amxColumns', true).setMeta('amxColumnsKeepEmpty', true)
}

/** 把一段顶层块装进一个 1 栏版块(⠿「转换为 → 版块」)。光标 / 选区跟着内容走。 */
export function wrapInSection(view: EditorView, from: number, to: number): boolean {
  const { state } = view
  if (!canWrapInSection(state, from, to)) return false
  const { amadeusColumnRow: row, amadeusColumnCell: cell } = state.schema.nodes
  if (!row || !cell) return false
  const fresh = minter(state.doc)
  const content = state.doc.slice(from, to).content
  const node = row.create({ tail: fresh(), section: {} }, cell.create({ anchor: fresh(), width: 1 }, content))
  const tr = state.tr.replaceWith(from, to, node)
  // 原内容整体右移两格(行开 + 栏开),行后的再多两格(栏闭 + 行闭):选区照这个偏移落回原处
  const shift = (p: number): number => (p >= from && p <= to ? p + 2 : p > to ? p + 4 : p)
  const sel = state.selection
  try {
    tr.setSelection(sel instanceof NodeSelection
      ? NodeSelection.create(tr.doc, shift(sel.from))
      : TextSelection.between(tr.doc.resolve(shift(sel.anchor)), tr.doc.resolve(shift(sel.head))))
  } catch {
    tr.setSelection(TextSelection.near(tr.doc.resolve(from + 2)))
  }
  view.dispatch(markStructural(tr).scrollIntoView())
  return true
}

/** 普通分栏行 → 版块(样式全缺省)。超过 4 栏的不转。 */
export function rowToSection(view: EditorView, rowPos: number): boolean {
  const node = view.state.doc.nodeAt(rowPos)
  if (!node || node.type.name !== 'amadeusColumnRow' || isSectionRow(node) || node.childCount > SECTION_MAX_COLUMNS) return false
  view.dispatch(view.state.tr.setNodeMarkup(rowPos, undefined, { ...node.attrs, section: {} }))
  return true
}

/** slash「版块」:光标所在的顶层块是空段 → 就地换成版块;否则插在它后面。光标落进版块。 */
export function insertSection(view: EditorView): boolean {
  const { state } = view
  const { $from } = state.selection
  if ($from.depth !== 1) return false // 版块只在顶层(栏里、列表里、卡里不建)
  const { amadeusColumnRow: row, amadeusColumnCell: cell, paragraph } = state.schema.nodes
  if (!row || !cell || !paragraph) return false
  const top = $from.node(1)
  const fresh = minter(state.doc)
  const node = row.create({ tail: fresh(), section: {} }, cell.create({ anchor: fresh(), width: 1 }, paragraph.create()))
  const start = $from.before(1)
  const replace = top.type === paragraph && top.content.size === 0
  const at = replace ? start : start + top.nodeSize
  const tr = replace ? state.tr.replaceWith(start, start + top.nodeSize, node) : state.tr.insert(at, node)
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 3))) // 行开 + 栏开 + 段开
  view.dispatch(markStructural(tr).scrollIntoView())
  return true
}

/** 改版块样式(底色 / 留白 / 卡片 / 对齐 / 窄屏叠放)。 */
export function setSectionStyle(view: EditorView, rowPos: number, patch: Partial<SectionView>): boolean {
  const node = view.state.doc.nodeAt(rowPos)
  if (!isSectionRow(node)) return false
  view.dispatch(view.state.tr.setNodeMarkup(rowPos, undefined, { ...node!.attrs, section: patchSection(node!.attrs.section, patch) }))
  return true
}

/** 栏数 1–4。加栏 = 末尾补空栏(宽度取现有均值);减栏 = 末尾的栏并进最后留下的那栏:内容一个字不丢,
 *  锚转成栏内的惰性标记(多 ref 栏,v3 升级产物同形,派生时原样收回);空栏的锚放到行后。 */
export function setSectionColumns(view: EditorView, rowPos: number, n: number): boolean {
  const { state } = view
  const node = state.doc.nodeAt(rowPos)
  if (!isSectionRow(node) || n < 1 || n > SECTION_MAX_COLUMNS || n === node!.childCount) return false
  const rowNode = node!
  const { amadeusColumnCell: cell, paragraph, html } = state.schema.nodes
  const cells: ProseNode[] = []
  rowNode.forEach((c) => cells.push(c))
  const fresh = minter(state.doc)
  const marker = (anchor: string): ProseNode[] =>
    anchor && paragraph && html ? [paragraph.create(null, html.create({ value: `<!-- a ${anchor} -->` }))] : []
  const isEmpty = (c: ProseNode): boolean => c.childCount === 1 && c.firstChild!.type === paragraph && c.firstChild!.content.size === 0
  let next: ProseNode[]
  const after: ProseNode[] = []
  if (n > cells.length) {
    const avg = cells.reduce((s, c) => s + (Number(c.attrs.width) || 1), 0) / cells.length
    const width = Math.round(avg * 10000) / 10000 || 1
    next = [...cells]
    while (next.length < n) next.push(cell.create({ anchor: fresh(), width }, paragraph.create()))
  } else {
    const keep = cells.slice(0, n)
    const extra: ProseNode[] = []
    for (const c of cells.slice(n)) {
      if (isEmpty(c)) after.push(...marker(String(c.attrs.anchor)))
      else {
        extra.push(...marker(String(c.attrs.anchor)))
        c.forEach((child) => extra.push(child))
      }
    }
    const last = keep[keep.length - 1]
    if (extra.length) {
      const base: ProseNode[] = isEmpty(last) ? [] : (() => { const a: ProseNode[] = []; last.forEach((ch) => a.push(ch)); return a })()
      keep[keep.length - 1] = last.type.create(last.attrs, Fragment.fromArray([...base, ...extra]))
    }
    next = keep
  }
  const rebuilt = rowNode.type.create(rowNode.attrs, next)
  const tr = state.tr.replaceWith(rowPos, rowPos + rowNode.nodeSize, [rebuilt, ...after])
  const keepSel = state.selection.from > rowPos && state.selection.from < rowPos + rowNode.nodeSize
  if (keepSel) {
    const mapped = Math.min(state.selection.from, rowPos + rebuilt.nodeSize - 2)
    tr.setSelection(TextSelection.near(tr.doc.resolve(mapped)))
  }
  view.dispatch(markStructural(tr))
  return true
}

/** 取消版块:两栏以上 → 留下普通分栏(位置不动);只有一栏 → 内容回到正文(同「取消分栏」)。 */
export function removeSection(view: EditorView, rowPos: number): boolean {
  const node = view.state.doc.nodeAt(rowPos)
  if (!isSectionRow(node)) return false
  if (node!.childCount >= 2) {
    view.dispatch(view.state.tr.setNodeMarkup(rowPos, undefined, { ...node!.attrs, section: null }))
    return true
  }
  return unsplitRow(view, rowPos)
}

// ── 工具条挂载 ───────────────────────────────────────────────────────────────────────

export interface SectionToolbarState {
  /** widget 的 DOM(portal 目标)。 */
  el: HTMLElement
  view: EditorView
  rowPos: number
  /** 当前样式对象(引用;变了才通知)与栏数。 */
  section: unknown
  cols: number
}

export interface SectionToolbarStore {
  get(): SectionToolbarState | null
  subscribe(fn: () => void): () => void
}

const KEY = new PluginKey('AMX_SECTION_TOOLBAR')

/** 工具条插件 + 一个极小的外部 store(useSyncExternalStore 订阅)。每个编辑器实例各建一份。 */
export function createSectionToolbar(): { plugin: ReturnType<typeof $prose>; store: SectionToolbarStore } {
  let current: SectionToolbarState | null = null
  let el: HTMLElement | null = null
  const subs = new Set<() => void>()
  const publish = (next: SectionToolbarState | null): void => {
    const same = current === next || (!!current && !!next && current.el === next.el && current.rowPos === next.rowPos
      && current.section === next.section && current.cols === next.cols && current.view === next.view)
    if (same) return
    current = next
    for (const fn of subs) fn()
  }
  const store: SectionToolbarStore = {
    get: () => current,
    subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn) } },
  }
  const plugin = $prose(() => new Plugin({
    key: KEY,
    props: {
      decorations(state) {
        const rowPos = sectionRowAt(state)
        if (rowPos == null) return null
        const row = state.doc.nodeAt(rowPos)!
        // 行尾(最后一栏之后)挂 widget:不当第一个子元素,免得 :first-child 一类的栏样式错位
        const at = rowPos + row.nodeSize - 1
        return DecorationSet.create(state.doc, [Decoration.widget(at, () => {
          const host = document.createElement('div')
          host.className = 'amx-sec-tb-host'
          host.setAttribute('contenteditable', 'false')
          el = host
          return host
        }, {
          key: 'amx-sec-tb',
          side: 1,
          ignoreSelection: true,
          stopEvent: () => true,
          destroy: (dom) => { if (el === dom) el = null },
        })])
      },
    },
    view: () => ({
      update(view) {
        const rowPos = sectionRowAt(view.state)
        const row = rowPos == null ? null : view.state.doc.nodeAt(rowPos)
        // widget 的 DOM 在 decorations 渲染时才建;update 在渲染之后跑,此刻 el 已就位
        if (rowPos == null || !row || !el || !el.isConnected || !view.editable) { publish(null); return }
        publish({ el, view, rowPos, section: row.attrs.section, cols: row.childCount })
      },
      destroy() { publish(null) },
    }),
  }))
  return { plugin, store }
}
