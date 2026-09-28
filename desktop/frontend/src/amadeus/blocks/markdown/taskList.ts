// Makes GFM task-list checkboxes interactive. Milkdown's gfm preset renders task items
// as <li data-item-type="task" data-checked="…"> with an input rule to create them, but
// no click-to-toggle. This plugin toggles `checked` when the checkbox gutter is clicked.
// The checkbox itself is a CSS ::before in the list's left padding (see styles.css), so a
// click on it lands left of the list item's content box.

import { $prose, $remark } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { registerMessages, subscribeLocale, translate } from '../../../i18n'

registerMessages({
  'mdtask.checkbox': { zh: '完成', en: 'Done' },
})

// ── 空待办 `- [ ]` 的读侧(R-10b,评审 2026-09-27)────────────────────────────────────────────────
// GFM(micromark 的 task-list-item)要求 `[ ]` 后面「空白 + 非空白」才算勾选框 —— 只有 `- [ ]` / `- [ ] `(Obsidian 里
// 新建待办还没写字就是这个形态)被读成列表项里的字面文字 `[ ]`:显示成普通项,一编辑同一只列表就落盘成 `* \[ ]`。
// Obsidian 把它当空待办。这里在 mdast 上补认:列表项首段恰好只有 `[ ]` / `[x]` / `[X]` → 置 checked、首段清空。
// ⚠️ 必须先于写侧「空待办不落 `<br />`」(R-10,softBreak.ts stripEmptyLineBr):那边写出的正是 `- [ ]`。
/* eslint-disable @typescript-eslint/no-explicit-any */
export function markEmptyTasks(tree: any): void {
  const walk = (n: any): void => {
    if (n?.type === 'listItem' && n.checked == null) {
      const p = n.children?.[0]
      const t = p?.type === 'paragraph' && p.children?.length === 1 ? p.children[0] : null
      const m = t?.type === 'text' ? /^\[([ xX])\]$/.exec(String(t.value)) : null
      if (m) {
        n.checked = m[1] !== ' '
        p.children = []
      }
    }
    for (const c of n?.children ?? []) walk(c)
  }
  walk(tree)
}
/* eslint-enable @typescript-eslint/no-explicit-any */
export const emptyTaskRemark = $remark('amadeusEmptyTask', () => () => markEmptyTasks)

/** 翻转 `pos` 所在**最内层**列表项的勾选态;该项不是待办(checked == null)返回 null。
 *  鼠标点方框与键盘 Mod+Enter(unified/keyboard.ts,K-11)共用这一份 —— 只认最内层,
 *  普通子项里按键不会越级翻转外层待办。 */
export function toggleTaskTr(state: EditorState, pos: number): Transaction | null {
  const $at = state.doc.resolve(pos)
  for (let d = $at.depth; d >= 0; d--) {
    const node = $at.node(d)
    if (node.type.name !== 'list_item') continue
    if (node.attrs.checked == null) return null
    return state.tr.setNodeMarkup($at.before(d), undefined, { ...node.attrs, checked: !node.attrs.checked })
  }
  return null
}

// ── 读屏语义(P-08,评审 2026-09-27)──────────────────────────────────────────────────────────────
// 方框是 li 的 CSS ::before,AX 树里只有 listitem、没有勾选状态;aria-checked 挂在 li 上 Chromium 不认
// (listitem 不支持该状态)。所以每个待办项首放一个**视觉隐藏**的 role=checkbox widget:
//   · 不占位、不参与命中(pointer-events:none + clip)—— 鼠标点方框的 P-01 路径与几何原样不动;
//   · 读屏的「激活」是程序派发的 click(不做命中测试),照样走 toggleTaskTr,与鼠标 / Mod+Enter 同一份;
//   · key 编进勾选态:翻转即换 DOM,aria-checked 不会停在旧值;文案随语言刷新(subscribeLocale + destroy 退订)。
const taskA11yKey = new PluginKey<DecorationSet>('amadeusTaskA11y')
const SR_ONLY = 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;pointer-events:none'

function taskA11yWidget(at: number, checked: boolean): Decoration {
  return Decoration.widget(at, (view: EditorView, getPos: () => number | undefined) => {
    const box = document.createElement('span')
    box.className = 'amx-task-a11y'
    box.setAttribute('role', 'checkbox')
    box.setAttribute('aria-checked', String(checked))
    box.contentEditable = 'false'
    box.tabIndex = -1
    box.style.cssText = SR_ONLY
    const label = (): void => { box.setAttribute('aria-label', translate('mdtask.checkbox')) }
    label()
    ;(box as unknown as { __off?: () => void }).__off = subscribeLocale(label)
    box.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (!view.editable) return // 只读视图(分享页 / 嵌入体):不翻转,同鼠标点方框
      const pos = getPos()
      if (pos == null) return
      const tr = toggleTaskTr(view.state, pos)
      if (tr) view.dispatch(tr)
    })
    return box
  }, {
    side: -1,
    ignoreSelection: true,
    key: `amxtask:${checked ? 1 : 0}`,
    stopEvent: () => true,
    destroy: (dom) => { (dom as unknown as { __off?: () => void }).__off?.() },
  })
}

/** 待办项 → 其内容首的 widget 位(`pos + 1`)与勾选态;只收 [from, to] 相交的(含祖先)。 */
function tasksBetween(doc: ProseNode, from: number, to: number): Map<number, boolean> {
  const out = new Map<number, boolean>()
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'list_item' && node.attrs.checked != null) out.set(pos + 1, !!node.attrs.checked)
    return true
  })
  return out
}

/**
 * 增量维护:只重建本事务改动区间里(及其祖先)的待办 widget,其余 map 过去。
 * 全文重扫在 1500 条待办的文档上把每键 dispatch 从 ~0.8ms 拉到 ~3.1ms(实测),所以不整篇重建。
 */
function taskA11yApply(tr: Transaction, old: DecorationSet): DecorationSet {
  if (!tr.docChanged) return old // 纯选区事务零开销
  let set = old.map(tr.mapping, tr.doc)
  const size = tr.doc.content.size
  tr.mapping.maps.forEach((stepMap, i) => {
    const rest = tr.mapping.slice(i + 1)
    stepMap.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
      const from = Math.max(0, rest.map(newFrom, -1) - 1)
      const to = Math.min(size, rest.map(newTo, 1) + 1)
      const touched = tasksBetween(tr.doc, from, to)
      let stale = set.find(from, to)
      for (const at of touched.keys()) stale = stale.concat(set.find(at, at))
      set = set.remove(stale).add(tr.doc, [...touched].map(([at, checked]) => taskA11yWidget(at, checked)))
    })
  })
  return set
}

export function taskCheckboxPlugin() {
  return $prose(
    () =>
      new Plugin<DecorationSet>({
        key: taskA11yKey,
        state: {
          init: (_config, state) => DecorationSet.create(state.doc,
            [...tasksBetween(state.doc, 0, state.doc.content.size)].map(([at, checked]) => taskA11yWidget(at, checked))),
          apply: taskA11yApply,
        },
        props: {
          decorations: (state) => taskA11yKey.getState(state),
          handleClick(view, _pos, event) {
            const target = event.target as HTMLElement | null
            const li = target?.closest('li[data-item-type="task"]') as HTMLElement | null
            if (!li) return false
            // 只读视图(分享页/嵌入体):PM 对 handleClick 不看 editable,这里自己挡,勾选框不翻转。
            if (!view.editable) return false
            // Only toggle when the click lands in the checkbox gutter (left of the content box).
            const rect = li.getBoundingClientRect()
            if (event.clientX - rect.left > 2) return false
            const tr = toggleTaskTr(view.state, view.posAtDOM(li, 0))
            if (!tr) return false
            view.dispatch(tr)
            return true
          },
        },
      }),
  )
}
