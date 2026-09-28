// Makes GFM task-list checkboxes interactive. Milkdown's gfm preset renders task items
// as <li data-item-type="task" data-checked="…"> with an input rule to create them, but
// no click-to-toggle. This plugin toggles `checked` when the checkbox gutter is clicked.
// The checkbox itself is a CSS ::before in the list's left padding (see styles.css), so a
// click on it lands left of the list item's content box.

import { $prose, $remark } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'

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
