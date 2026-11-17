/** 代码块里的括号 / 引号自动配对(评审 R-27,Obsidian 缺省开)。本机偏好(设置 → 笔记,见 ./autoPairPrefs),缺省开,
 *  与正文配对(./bodyAutoPair)共用一个开关。
 *  规则:敲开括号 / 引号 → 补上对应的闭合、光标落在中间;紧挨着同一个闭合符再敲它 = 跨过去;
 *  退格删掉空的一对 `(|)` = 两个一起删。引号挨着字母数字不配(`don't`、`a"b` 这类是字面)。
 *  有选区时不接管(代码块里的选区照常被替换,与现状一致)。 */
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { bracketAutoPairEnabled } from './autoPairPrefs'

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' }
const CLOSERS = new Set(Object.values(PAIRS))
const WORD = /[\p{L}\p{N}_]/u

/** 光标在代码块里的上下文;不在代码块 / 有选区 / 输入法组字中 → null。代码块只含文本,偏移与字符一一对应。 */
function codeCaret(view: EditorView, from: number, to: number): { text: string; off: number } | null {
  if (from !== to || view.composing || !bracketAutoPairEnabled()) return null
  const $f = view.state.doc.resolve(from)
  if ($f.parent.type.name !== 'code_block') return null
  return { text: $f.parent.textContent, off: $f.parentOffset }
}

/** handleTextInput:配对 / 跨过闭合符。 */
export function codeAutoPairInput(view: EditorView, from: number, to: number, input: string): boolean {
  const at = codeCaret(view, from, to)
  if (!at || input.length !== 1) return false
  const next = at.text.charAt(at.off)
  const prev = at.text.charAt(at.off - 1)
  if (CLOSERS.has(input) && next === input) {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from + 1)))
    return true
  }
  const close = PAIRS[input]
  if (!close) return false
  if (WORD.test(next)) return false // 紧贴在一个词前面:多半是在给现有代码补左半边,别塞一个闭合进去
  if (close === input && WORD.test(prev)) return false // 引号挨着字母数字 = 字面(`don't`)
  const tr = view.state.tr.insertText(input + close, from, to)
  tr.setSelection(TextSelection.create(tr.doc, from + 1))
  view.dispatch(tr)
  return true
}

/** 退格删空的一对。 */
export function codeAutoPairBackspace(view: EditorView): boolean {
  const { from, to } = view.state.selection
  const at = codeCaret(view, from, to)
  if (!at || at.off === 0) return false
  const open = at.text.charAt(at.off - 1)
  if (!PAIRS[open] || at.text.charAt(at.off) !== PAIRS[open]) return false
  view.dispatch(view.state.tr.delete(from - 1, from + 1))
  return true
}
