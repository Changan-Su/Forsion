/** 异步插入的锚点 + 占位(评审 G3-06)。
 *
 * slash 菜单里「先干活再插入」的项(插件的 run、建多维表 / 画板 / 子页面、选图片、书签 / 嵌入的对话框)结果是异步回来的。
 * 此前一律在**完成那一刻的光标处**插入并 focus:用户期间挪到别段打字,结果落在别段;去聊天框打字,焦点被拽回笔记、
 * 后面的字打进了笔记;唤起命令的那行留成一个空段。现在:
 *  - 唤起时在光标处钉一个随编辑映射的锚(widget 装饰,不进文档、不进撤销栈),插件项显示「生成中…」+ 取消;
 *  - 结果回来插到**锚所在的块**:那块是空的就原地替换(不留空段),否则插在它后面;
 *  - 只有焦点仍在编辑器、且选区还在锚所在的块里,才把光标挪到插入内容末尾;否则不动选区、不抢焦点;
 *  - 锚被删掉(用户删了那一行)或点了取消 → 结果不插;前者提示一声。
 * 插件的 run 接口不变(取消 = 丢弃结果,不给插件传 signal —— 那是公共契约变更)。
 */
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import type { Fragment } from '@milkdown/kit/prose/model'
import { $prose } from '@milkdown/kit/utils'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { registerMessages, translate } from '../../i18n'
import { unfoldCalloutsForInsert } from '../blocks/markdown/callout'

registerMessages({
  'pendins.busy': { zh: '「{label}」进行中…', en: '"{label}" in progress…' },
  'pendins.cancel': { zh: '取消', en: 'Cancel' },
  'pendins.lost': { zh: '「{label}」的结果没有插入：原来的位置已被删除。', en: '"{label}" wasn’t inserted: its original position was deleted.' },
  'pendins.sourceMode': {
    zh: '「{label}」的结果没有插入：你正在源码模式里编辑。切回可视模式后可以重新执行。',
    en: '"{label}" wasn’t inserted because you’re editing in source mode. Switch back to visual mode and run it again.',
  },
})

export const pendingInsertKey = new PluginKey<DecorationSet>('UNIFIED_PENDING_INSERT')

interface AddMeta { id: string; pos: number; label: string; visible: boolean; onCancel: () => void }
type Meta = { add: AddMeta } | { remove: string }

function chip(a: AddMeta): HTMLElement {
  const el = document.createElement('span')
  el.className = 'amx-pending-insert'
  el.dataset.pendingInsert = a.id
  el.contentEditable = 'false'
  if (!a.visible) {
    el.dataset.hidden = ''
    return el
  }
  el.setAttribute('role', 'status')
  const spin = document.createElement('span')
  spin.className = 'amx-pending-insert-spin'
  spin.setAttribute('aria-hidden', 'true')
  const text = document.createElement('span')
  text.textContent = translate('pendins.busy', { label: a.label })
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'btn sm'
  cancel.textContent = translate('pendins.cancel')
  cancel.addEventListener('mousedown', (e) => e.preventDefault()) // 不把焦点从别处抢过来
  cancel.addEventListener('click', (e) => {
    e.preventDefault()
    a.onCancel()
  })
  el.append(spin, text, cancel)
  return el
}

export function createPendingInsert(): MilkdownPlugin[] {
  return [
    $prose(() => new Plugin<DecorationSet>({
      key: pendingInsertKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, set) {
          let next = set.map(tr.mapping, tr.doc)
          const m = tr.getMeta(pendingInsertKey) as Meta | undefined
          if (m && 'add' in m) {
            next = next.add(tr.doc, [Decoration.widget(m.add.pos, () => chip(m.add), {
              id: m.add.id, key: `pending:${m.add.id}`, side: -1, ignoreSelection: true, stopEvent: () => true,
            })])
          } else if (m && 'remove' in m) {
            next = next.remove(next.find(undefined, undefined, (spec) => spec.id === m.remove))
          }
          return next
        },
      },
      props: { decorations: (st) => pendingInsertKey.getState(st) },
    })),
  ]
}

/** 锚现在在哪(已被删掉 / 已取消 = null)。 */
export function pendingPos(state: EditorState, id: string): number | null {
  const set = pendingInsertKey.getState(state)
  const hit = set?.find(undefined, undefined, (spec) => spec.id === id)[0]
  return hit ? hit.from : null
}

let seq = 0
export interface PendingAnchor {
  id: string
  label: string
  cancelled: () => boolean
}

/** 在当前光标处钉锚。visible=false:不画占位(对话框开着时画「进行中」是噪音),只记位置。 */
export function beginPending(view: EditorView, label: string, visible = true): PendingAnchor {
  const id = `p${Date.now().toString(36)}${(seq++).toString(36)}`
  let cancelled = false
  const onCancel = (): void => {
    cancelled = true
    endPending(view, id)
  }
  view.dispatch(view.state.tr.setMeta(pendingInsertKey, { add: { id, pos: view.state.selection.head, label, visible, onCancel } } satisfies Meta))
  return { id, label, cancelled: () => cancelled }
}

/** 撤掉锚(不插东西)。 */
export function endPending(view: EditorView, id: string): void {
  if (view.isDestroyed || pendingPos(view.state, id) == null) return
  view.dispatch(view.state.tr.setMeta(pendingInsertKey, { remove: id } satisfies Meta))
}

/** 把内容插到锚所在的块(空块原地替换,否则插在后面),同一笔事务撤掉锚。锚已不在 = false,什么都不做。
 *  容器口径同 UnifiedPage 的 insertMd:doc、分栏 cell 或引用/callout(列表项里 = 整份列表之后)。 */
export function insertAtPending(view: EditorView, id: string, content: Fragment | null): boolean {
  const pos = pendingPos(view.state, id)
  if (pos == null) return false
  let tr = view.state.tr.setMeta(pendingInsertKey, { remove: id } satisfies Meta)
  if (!content?.size) {
    view.dispatch(tr)
    return true
  }
  const $p = view.state.doc.resolve(pos)
  let d = $p.depth
  while (d >= 1 && !['doc', 'amadeusColumnCell', 'blockquote'].includes($p.node(d - 1).type.name)) d--
  const sel = view.state.selection
  let at: number
  let end: number
  let focusHere: boolean
  if (d < 1) {
    at = pos
    tr = tr.insert(pos, content)
    end = pos + content.size
    focusHere = view.hasFocus() && sel.empty && sel.head === pos
  } else {
    const from = $p.before(d)
    const to = $p.after(d)
    const blank = $p.node(d).textContent.trim() === ''
    focusHere = view.hasFocus() && sel.from >= from && sel.to <= to
    at = blank ? from : to
    tr = blank ? tr.replaceWith(from, to, content) : tr.insert(to, content)
    end = at + content.size
  }
  unfoldCalloutsForInsert(tr, at, end)
  if (focusHere) tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size)), -1)).scrollIntoView()
  view.dispatch(tr)
  return true
}

/** 结果回来时编辑器在源码模式里藏着(Codex 复核 inst P1-3):不写隐藏的 doc,说一声。 */
export function toastPendingSourceMode(label: string): void {
  window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { level: 'warning', text: translate('pendins.sourceMode', { label }) } }))
}

export function toastPendingLost(label: string): void {
  window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: translate('pendins.lost', { label }) } }))
}
