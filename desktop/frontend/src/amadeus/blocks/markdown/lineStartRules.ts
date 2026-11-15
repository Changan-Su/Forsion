// 回车口径开关打开时(./enterMode)的行首输入规则:段内软换行之后那一行的开头,也当「段首」跑块级输入规则。
//
// 为什么要这一层:块级输入规则(分割线 `---` / `*** ` / `___ `、脚注段首 `[^a]x` / 定义 `[^a]: `、以及其它插件
// 注册的 `^…` 规则)都按「段落开头到光标」的文字匹配,软换行在那段文字里是个占位符 —— 第二行起的行首永远匹配不上。
// 回车一次只多一个换行之后,第二行是常态,这些规则就都失灵了。
//
// 做法:这一行的文字(连同正要落的字)看着像块级语法时,先在一份**假的** state 上把这一行从段落里切出来
// (./blockTriggers 的 isolateTr:上下都紧贴、记号由它负责;后面的行切成下一段),再让输入规则插件在切开后的段首试跑一次。
// 真有规则会成 → 在编辑器里照做:先切段,再跑同一个插件;并把「切段 + 规则」记成一次可被行首退格撤销的输入规则
// (undoInputRule 撤回去 = 一段两行、这一行是字面文字)。没有规则会成 → 什么都不动,交回原路。
// 关着时不挂(MarkdownBlock 只在 unified && 开关打开时接这条 handleTextInput)。
import type { EditorView } from '@milkdown/kit/prose/view'
import { customInputRulesKey } from '@milkdown/kit/prose'
import { Transform } from '@milkdown/kit/prose/transform'
import type { Transaction } from '@milkdown/kit/prose/state'
import { enterInline } from './enterMode'
import { isolateTr, lineBounds, undoIsolate } from './blockTriggers'
import { TIGHT_MANAGED } from './lineGap'

/** 这一行(连同正要落的字)看着像行首块级语法吗。只是预筛:真不真由输入规则自己判。 */
const LOOKS_BLOCKY = /^[ \t]{0,3}[-*_#>`~$[+|0-9]/

type TextInputHandler = (view: EditorView, from: number, to: number, text: string) => boolean

export function lineStartInputRule(view: EditorView, from: number, to: number, text: string): boolean {
  if (!enterInline() || view.composing || from !== to) return false
  const state = view.state
  const $from = state.doc.resolve(from)
  const b = lineBounds($from)
  if (!b || b.before == null) return false
  const line = $from.parent.textBetween(b.before - $from.start() + 1, $from.parentOffset, undefined, '￼') + text
  if (line.length > 64 || !LOOKS_BLOCKY.test(line)) return false
  const plugin = customInputRulesKey.get(state)
  const handler = plugin?.props.handleTextInput as TextInputHandler | undefined
  if (!plugin || !handler) return false
  // 试跑:假 view 只收不发。不切段也会成(规则自己认得行首,如脚注段首引用)→ 交回原路,不切。
  const fires = (st: typeof state, f: number, t: number): boolean => {
    let hit = false
    const probe = { state: st, composing: false, dispatch: () => { hit = true } } as unknown as EditorView
    try { handler.call(plugin, probe, f, t, text) } catch { hit = false }
    return hit
  }
  if (fires(state, from, to)) return false
  // 块级语法只占这一行:后面还有行就一起切出去(成这一块之后的下一段)
  if (!state.selection.empty || state.selection.from !== from) return false
  const split = isolateTr(state, $from, true)
  if (!split) return false
  // 切口上的位置映射有歧义(行尾会被映到下一段段首),用 isolateTr 放好的光标
  const nf = split.selection.from
  const nt = nf
  if (!fires(state.apply(split), nf, nt)) return false
  view.dispatch(split)
  // 规则的事务经这个壳派发,好拿到它的位置映射(输入规则插件只用 state / composing / dispatch)
  let ruleTr: Transaction | null = null
  const shell = {
    get state() { return view.state },
    composing: false,
    dispatch: (tr: Transaction) => { ruleTr = tr; view.dispatch(tr) },
  } as unknown as EditorView
  if (!handler.call(plugin, shell, nf, nt, text) || !ruleTr) {
    undoIsolate(view, split)
    return false
  }
  const rule: Transaction = ruleTr
  const fix = view.state.tr
  // 这一行后面还有行、规则把它换成了记不了紧贴的块(分割线):由下一段记 amxTightBefore,落盘仍紧挨着(./lineGap 的 safeBefore)
  if (b.after != null) {
    const at = rule.mapping.map(split.selection.$from.before(), -1)
    const node = at <= fix.doc.content.size ? fix.doc.nodeAt(at) : null
    const nextAt = node ? at + node.nodeSize : -1
    const next = node && !('amxTight' in node.attrs) ? fix.doc.nodeAt(nextAt) : null
    if (next && 'amxTightBefore' in next.attrs && next.attrs.amxTightBefore !== true) {
      fix.setNodeMarkup(nextAt, undefined, { ...next.attrs, amxTightBefore: true }).setMeta(TIGHT_MANAGED, true)
    }
  }
  // 行首退格撤销输入规则(undoInputRule)时把切段一起倒回去:插件状态里的 transform 换成「切段 + 规则 + 上面的记号」,
  // from / to 换回切段之前的位置。只在规则之后没有别的插件追加改动时这样做(倒回的步骤必须正好是文档经历过的全部步骤;
  // 有追加改动时输入规则插件自己也已经放弃了撤销记录,同关着时)。
  const stored = rule.getMeta(plugin) as { text: string } | undefined
  if (stored && view.state.doc.eq(rule.doc)) {
    const both = new Transform(state.doc)
    try {
      for (const st of split.steps) both.step(st)
      for (const st of rule.steps) both.step(st)
      for (const st of fix.steps) both.step(st)
      fix.setMeta(plugin, { transform: both, from, to, text: stored.text })
    } catch { /* 拼不上就不留撤销记录 */ }
  }
  if (fix.docChanged || fix.getMeta(plugin)) view.dispatch(fix)
  return true
}
