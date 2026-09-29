/** 正文首行 → 标题(评审 K-24):标题 → 正文早就有(标题框里回车 / ↓ / →),反方向缺 —— 正文首行按 ↑、首段段首按 ←
 *  哪儿也去不了。只挪焦点,不改文档:
 *  · ↑:光标在文档**第一个文本块**、且在它的第一个视觉行(PM endOfTextblock('up'),折行的首段按视觉行判);
 *  · ←:光标在段首,且第一个顶层块是普通段落(标题行首的 ← 归 `##` 前缀 input,列表 / 引用行首的 ← 有自己的语义)。
 *  go() 返回 false(画布满铺没有标题、只读)就不吞键,照常交给后面的处理。 */
import { $prose } from '@milkdown/kit/utils'
import { keymap } from '@milkdown/kit/prose/keymap'
import { Selection, TextSelection } from '@milkdown/kit/prose/state'
import type { Command } from '@milkdown/kit/prose/state'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'

export function titleNavPlugins(go: () => boolean): MilkdownPlugin[] {
  const up: Command = (state, _dispatch, view) => {
    const sel = state.selection
    if (!(sel instanceof TextSelection) || !sel.empty || !view) return false
    const first = Selection.atStart(state.doc)
    if (first.$from.start() !== sel.$from.start()) return false
    if (!view.endOfTextblock('up')) return false
    return go()
  }
  const left: Command = (state) => {
    const sel = state.selection
    if (!(sel instanceof TextSelection) || !sel.empty) return false
    const $f = sel.$from
    if ($f.depth !== 1 || $f.index(0) !== 0 || $f.parentOffset !== 0 || $f.parent.type.name !== 'paragraph') return false
    return go()
  }
  return [$prose(() => keymap({ ArrowUp: up, ArrowLeft: left }))]
}
