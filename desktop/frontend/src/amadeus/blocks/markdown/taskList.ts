// Makes GFM task-list checkboxes interactive. Milkdown's gfm preset renders task items
// as <li data-item-type="task" data-checked="…"> with an input rule to create them, but
// no click-to-toggle. This plugin toggles `checked` when the checkbox gutter is clicked.
// The checkbox itself is a CSS ::before in the list's left padding (see styles.css), so a
// click on it lands left of the list item's content box.

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'

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

export function taskCheckboxPlugin() {
  return $prose(
    () =>
      new Plugin({
        props: {
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
