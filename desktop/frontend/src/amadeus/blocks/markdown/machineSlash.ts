// ＋ 替用户敲下的那个 `/`(评审 B-19):块层(unified/blockLayer)插一个只含 `/` 的新块来唤起 slash 菜单,
// 用户 Esc / 点空白关菜单 = 不要这个选择器了 → MarkdownBlock 据此把 `/`(连同打了一半的查询)删掉,不留残渣。
// 用户自己敲的 `/` 不在此列:那是正文,Esc 后留成字面(既有语义)。
import type { EditorView } from '@milkdown/kit/prose/view'

const marks = new WeakMap<EditorView, number>()

/** 记下「`/` 之后」的位置(= slash 菜单报上来的 from)。 */
export function markMachineSlash(view: EditorView, afterSlash: number): void {
  marks.set(view, afterSlash)
}

/** 取走标记:菜单报上来的 from 与它相同 = 这就是 ＋ 敲的那个 `/`。取一次即清(选中项 / 关菜单都要清)。 */
export function takeMachineSlash(view: EditorView, from: number): boolean {
  const at = marks.get(view)
  marks.delete(view)
  return at === from
}
