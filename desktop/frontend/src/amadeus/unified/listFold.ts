// v4 统一编辑器的**列表项折叠**(2026-08-14,AFFiNE `blocks/list` 的 toggle 对位)。
// 与 headingFold 同一套取舍:**会话内纯装饰,不落盘** —— 磁盘上的 md 一个字都不变,
// 重开笔记/切源码后全展开。AFFiNE 那边 collapsed 是持久化块属性(list-model.ts),我们做不到
// 也不想做(那会往纯 md 里加 amadeus_* 键),这是刻意的偏差,别当 bug 报。
//
// 锚 = list_item 的文档 pos,随事务 mapping 存活;项被删/子列表被掏空即自动失效。
// 折叠 = 把该项的子列表整只 display:none,并给项加一层 class 让 CSS 画箭头位。
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, Selection } from '@milkdown/kit/prose/state'
import type { EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'listfold.expandChildren': { zh: '展开子项', en: 'Expand children' },
})

interface ListFoldState {
  folded: number[]
  decos: DecorationSet
}

export const listFoldKey = new PluginKey<ListFoldState>('AMX_LIST_FOLD')

/** 该位置上是不是「带子列表的 list_item」;是则返回 {item, nestedFrom, nestedTo}。 */
function foldableAt(doc: ProseNode, pos: number): { item: ProseNode; from: number; to: number } | null {
  if (pos < 0 || pos >= doc.content.size) return null
  const item = doc.nodeAt(pos)
  if (!item || item.type.name !== 'list_item' || item.childCount < 2) return null
  const nested = item.child(1)
  if (!/_list$/.test(nested.type.name)) return null
  const from = pos + 1 + item.child(0).nodeSize
  return { item, from, to: from + nested.nodeSize }
}

function build(doc: ProseNode, folded: number[]): DecorationSet {
  const decos: Decoration[] = []
  for (const p of folded) {
    const f = foldableAt(doc, p)
    if (!f) continue
    decos.push(Decoration.node(p, p + f.item.nodeSize, { class: 'amx-listitem-folded' }))
    decos.push(Decoration.node(f.from, f.to, { class: 'amx-fold-hidden' }))
    decos.push(
      Decoration.widget(
        p + 2, // 项内首段的内容首(项前位 +1 = 段落前位,再 +1 = 段内容首)
        (view: EditorView, getPos: () => number | undefined) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'amx-fold-caret'
          b.textContent = '▸'
          b.contentEditable = 'false'
          b.title = translate('listfold.expandChildren')
          // widget 带 key,装饰重建时 DOM 会被复用 —— 切语言不会重造这颗按钮,
          // 所以在 hover(tooltip 真正要显示的那一刻)重取一次文案。
          b.addEventListener('mouseenter', () => { b.title = translate('listfold.expandChildren') })
          b.addEventListener('mousedown', (e) => {
            e.preventDefault()
            e.stopPropagation()
            const at = getPos()
            if (at == null) return
            toggleListFoldAt(view, view.state.doc.resolve(at).before(view.state.doc.resolve(at).depth - 1))
          })
          return b
        },
        { side: -1, ignoreSelection: true, key: `amxlfold:${p}` },
      ),
    )
  }
  return DecorationSet.create(doc, decos)
}

export function toggleListFoldAt(view: EditorView, itemPos: number): void {
  view.dispatch(view.state.tr.setMeta(listFoldKey, { toggle: itemPos }))
}

/** 把手折叠钮的三态(与 headingFold 同签名,blockLayer 的 syncFold 按「先标题、后列表」问)。 */
export function listFoldStateAt(view: EditorView, pos: number): 'foldable' | 'folded' | null {
  if (!foldableAt(view.state.doc, pos)) return null
  return listFoldKey.getState(view.state)?.folded.includes(pos) ? 'folded' : 'foldable'
}

/** 折叠隐藏区间(供光标守卫与「折叠态回车不带走子项」用)。 */
export function listHiddenRanges(state: EditorState): Array<{ start: number; after: number }> {
  const st = listFoldKey.getState(state)
  if (!st?.folded.length) return []
  const out: Array<{ start: number; after: number }> = []
  for (const p of st.folded) {
    const f = foldableAt(state.doc, p)
    if (f) out.push({ start: f.from, after: f.to })
  }
  return out
}

/** 该 list_item 当前是否折叠(键盘层用:折叠态回车只拆兄弟,子项留在原项里)。 */
export function isListFolded(state: EditorState, itemPos: number): boolean {
  return !!listFoldKey.getState(state)?.folded.includes(itemPos)
}

export const listFoldPlugins: MilkdownPlugin[] = [
  $prose(
    () =>
      new Plugin<ListFoldState>({
        key: listFoldKey,
        state: {
          init: () => ({ folded: [], decos: DecorationSet.empty }),
          apply: (tr, prev) => {
            let folded = prev.folded
            if (tr.docChanged)
              folded = folded
                .map((p) => tr.mapping.mapResult(p))
                .filter((r) => !r.deleted || foldableAt(tr.doc, r.pos) != null)
                .map((r) => r.pos)
            const meta = tr.getMeta(listFoldKey) as { toggle?: number } | undefined
            if (meta?.toggle != null) {
              const p = meta.toggle
              folded = folded.includes(p) ? folded.filter((x) => x !== p) : [...folded, p]
            }
            // 只留「仍是带子列表的列表项」的锚:子项被删光 = 自动展开,不留幽灵折叠态。
            folded = [...new Set(folded)].filter((p) => foldableAt(tr.doc, p) != null)
            if (!tr.docChanged && !meta && folded === prev.folded) return prev
            return { folded, decos: build(tr.doc, folded) }
          },
        },
        // 光标不许停在被折起的子列表里(与 headingFold 同一条守卫;只管空选区,范围选择不动)。
        appendTransaction: (_trs, oldState, state) => {
          const st = listFoldKey.getState(state)
          if (!st?.folded.length || !state.selection.empty) return null
          const from = state.selection.from
          for (const rg of listHiddenRanges(state)) {
            if (from <= rg.start || from >= rg.after) continue
            const dir = from >= oldState.selection.from ? 1 : -1
            let sel = Selection.near(state.doc.resolve(dir === 1 ? Math.min(rg.after, state.doc.content.size) : rg.start), dir)
            if (sel.from > rg.start && sel.from < rg.after) sel = Selection.near(state.doc.resolve(rg.start), -1)
            return state.tr.setSelection(sel)
          }
          return null
        },
        props: {
          decorations(state) {
            return listFoldKey.getState(state)?.decos ?? null
          },
        },
      }),
  ),
].flat()
