/** 正文里的括号 / 引号自动成对(Obsidian 的 autoPairBrackets,缺省开;开关与代码块共用,见 ./autoPairPrefs)。
 *  段落、标题、列表项、引用 / 折叠块 / callout 里的段落、表格单元格都算正文;代码块归 ./codeAutoPair,
 *  公式里的括号归 ./mathTyping,行内代码里一律字面。只挂 v4 统一实例(MarkdownBlock 的 `unified`)。
 *
 *  规则(CodeMirror closeBrackets 同口径,Obsidian 就是它):
 *  · 敲 `( [ {` → 补上闭合、光标在中间;只在后一个字是行尾 / 空白 / `) ] } : ; >` 时配(紧贴在字前面多半是给现成的字补左半边)。
 *  · 敲 `" '` → 同上补一对;前一个或后一个字是字母数字时不配(`don't`、`a"b` 是字面)。
 *  · 紧挨着同一个闭合符再敲它 = 跨过去。不只认自动补的那个:光标后紧跟同一个闭合符就跨。
 *  · 在空的一对 `(|)` 里退格 = 两个一起删。
 *  · 输入法组字期间、组字刚提交的那一下都不碰(组字提交上来的 `(` 照原样落字,不配也不吞)。
 *
 *  ⚠️ 跨过去的实现是「删掉光标后的那个闭合符,再让这一键照常落字」,不是光挪光标:Forsion 的链接 `[文字](地址)`、
 *  脚注 `[^a]`、callout `> [!note]` 都靠打出闭合符那一下的输入规则 / handleTextInput 成形 —— 光挪光标就把它们饿死了。
 *  所以跨过那一半(bodyPairEarlyPlugin)必须排在 callout 等处理器之前;补闭合那一半(bodyPairOpenPlugin)排在最后,
 *  先让 callout 的隐藏前缀改落点、公式 / 代码块自己的配对和第三方扩展说话。 */
import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { bracketAutoPairEnabled } from './autoPairPrefs'
import { buildBlockString } from './mathLivePreview'
import { caretInMath } from './mathTyping'
import { hiddenPrefixStart } from './callout'

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" }
const CLOSERS = new Set(Object.values(PAIRS))
const QUOTES = new Set(['"', "'"])
const WORD = /[\p{L}\p{N}_]/u
/** 括号后面是这些(或行尾)才配。￼ = 行内叶子(图片 / 硬换行)占位,当行尾看。 */
const BRACKET_BEFORE = /[\s)\]}:;>￼]/u
const LEAF = '￼'

/** 组字提交之后这么久内来的单字输入视作「输入法上屏的」,不配对(PM 在 compositionend 之后才把上屏的字交给 handleTextInput)。 */
const COMPOSE_GRACE_MS = 50
const composeEndedAt = new WeakMap<EditorView, number>()

/** 正在组字,或组字刚提交。导出给单测。 */
export function composingNow(view: EditorView): boolean {
  if (view.composing) return true
  const t = composeEndedAt.get(view)
  return t != null && Date.now() - t < COMPOSE_GRACE_MS
}

interface Caret {
  /** 所在文本块的文字;行内叶子占一个 ￼,下标 = 块内偏移。 */
  text: string
  off: number
}

/** 正文里一个折叠光标的上下文。代码块 / 行内代码 / 公式里、组字中、开关关着 → null。 */
function bodyCaret(view: EditorView, from: number, to: number): Caret | null {
  if (from !== to || !view.editable || composingNow(view) || !bracketAutoPairEnabled()) return null
  const { state } = view
  const sel = state.selection
  if (!(sel instanceof TextSelection) || !sel.empty || sel.from !== from) return null
  const $f = state.doc.resolve(from)
  const parent = $f.parent
  if (!parent.isTextblock || parent.type.spec.code) return null
  if ((state.storedMarks ?? $f.marks()).some((m) => m.type.spec.code)) return null
  // callout 标题行藏起来的令牌之前:这里的编辑由 callout 挪到可见标题起点,配对别碰看不见的字
  const visible = hiddenPrefixStart(state)
  if (visible != null && from < visible) return null
  const off = $f.parentOffset
  if (caretInMath(buildBlockString(parent), off)) return null
  return { text: parent.textBetween(0, parent.content.size, undefined, LEAF), off }
}

/** 刚被跨过的那一键:跨过之后这一键还要走完后面的 handleTextInput(含补闭合那一半)。引号的开、闭是同一个字 ——
 *  不拦的话 `"|"` 再敲 `"` 会先删掉闭合、又被当成开引号补出一对(`""|"`)。记的是删完之后的文档,同一键里不变。 */
const steppedDoc = new WeakMap<EditorView, PMNode>()

/** handleTextInput(排在最前):光标后紧跟同一个闭合符时跨过去 = 删掉那个闭合符,返回 false 让这一键照常落字。
 *  落下的字沿用被删那个闭合符的样式(storedMarks):`(` 后按了 ⌘B 再打字,补的 `)` 仍是普通字;用户转义过的字面
 *  (`\)`)仍带转义记号。这样后面的输入规则(脚注 `[^a]` 等)照常看到打出来的闭合符,样式也不变。 */
export function bodyStepOver(view: EditorView, from: number, to: number, input: string): boolean {
  if (input.length !== 1 || !CLOSERS.has(input)) return false
  const c = bodyCaret(view, from, to)
  if (!c || c.text.charAt(c.off) !== input) return false
  const { state } = view
  const after = state.doc.resolve(from).nodeAfter
  if (!after?.isText) return false
  const tr = state.tr.delete(from, from + 1).setStoredMarks(after.marks)
  view.dispatch(tr)
  steppedDoc.set(view, view.state.doc)
  return false
}

/** handleTextInput(排在最后):敲开括号 / 引号补上闭合,光标落在中间。 */
export function bodyPairOpen(view: EditorView, from: number, to: number, input: string): boolean {
  if (input.length !== 1) return false
  const close = PAIRS[input]
  if (!close) return false
  if (steppedDoc.get(view) === view.state.doc) return false // 这一键刚跨过一个闭合符
  const c = bodyCaret(view, from, to)
  if (!c) return false
  const next = c.text.charAt(c.off)
  const prev = c.text.charAt(c.off - 1)
  if (QUOTES.has(input)) {
    if (next === input || WORD.test(next) || WORD.test(prev)) return false
  } else if (next && !BRACKET_BEFORE.test(next)) return false
  // 引用首段行首的 `[`:那里的 `[!type]` 是 callout 令牌,自动补的 `]` 会让 `[!n]` 半截就被认成 callout
  if (input === '[' && c.off === 0) {
    const $f = view.state.doc.resolve(from)
    if ($f.depth >= 2 && $f.node(-1).type.name === 'blockquote' && $f.index(-1) === 0) return false
  }
  const tr = view.state.tr.insertText(input + close, from, to)
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 1)).scrollIntoView())
  return true
}

/** handleKeyDown(排在最前):空的一对 `(|)` 里退格,两个一起删。 */
export function bodyPairBackspace(view: EditorView, event: KeyboardEvent): boolean {
  if (event.key !== 'Backspace' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false
  if (event.isComposing || event.keyCode === 229) return false
  const { from, to, $from } = view.state.selection
  // 先只看光标两边各一个字(每次退格都会走到这里,别为不相干的退格算整块文字)
  const before = $from.nodeBefore, after = $from.nodeAfter
  if (!before?.isText || !after?.isText || PAIRS[before.text!.slice(-1)] !== after.text!.charAt(0)) return false
  const c = bodyCaret(view, from, to)
  if (!c || c.off === 0) return false
  const close = PAIRS[c.text.charAt(c.off - 1)]
  if (!close || c.text.charAt(c.off) !== close) return false
  view.dispatch(view.state.tr.delete(from - 1, from + 1).scrollIntoView())
  return true
}

/** 跨过闭合符 + 成对退格 + 记下组字结束的时刻。MarkdownBlock 里排在 calloutPlugin 之前(见文件头)。 */
export const bodyPairEarlyPlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleTextInput: (view, from, to, text) => bodyStepOver(view, from, to, text),
        handleKeyDown: (view, event) => bodyPairBackspace(view, event),
        handleDOMEvents: {
          compositionend: (view) => {
            composeEndedAt.set(view, Date.now())
            return false
          },
        },
      },
    }),
)

/** 补闭合。unified/keyboard.ts 的 keyboardPlugins 里(整条链最后)。 */
export const bodyPairOpenPlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleTextInput: (view, from, to, text) => bodyPairOpen(view, from, to, text),
      },
    }),
)
