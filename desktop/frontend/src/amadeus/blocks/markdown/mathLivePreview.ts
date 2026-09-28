// LaTeX 实况预览(Obsidian 式):数学公式在文档里**始终是纯文本** `$…$` / `$$…$$`(零 schema、零序列化改动,
// .md 落盘原样),仅当光标**不在这一行**时用 ProseMirror 装饰把该行的公式渲染成 KaTeX;光标回到这一行 → 露出
// 源码可编辑。因此不再用 @milkdown/plugin-math 的原子节点(那套一敲完就变原子、无法再编辑)。
//
// 为什么用装饰而非节点:节点是原子,光标进不去、编辑=删了重打;装饰不动文档,源码就是原生文本,光标天然可编辑,
// 序列化/撤销/其它插件全部无感。每个 Amadeus 块是独立 Milkdown 编辑器、文档极小 → 每次选区变化重算装饰的开销可忽略。
import { $prose, $remark } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { attachSourceButton, revealSource } from './sourceToggle'
import { registerMessages, translate } from '../../../i18n'

registerMessages({
  'mathlive.renderFailedTitle': { zh: 'LaTeX 无法渲染', en: 'LaTeX could not be rendered' },
  'mathlive.renderFailedBadge': { zh: '公式无法渲染', en: 'Formula could not be rendered' },
})

export interface MathSpan { from: number; to: number; latex: string; display: boolean }

/** 扫描「一块的文本」中的公式跨度(块级 `$$…$$` 优先,再行内 `$…$`)。
 *  入参 s 已由调用方把 code 文本/内联原子替成占位符、硬换行替成 '\n'(见 buildBlockString)。
 *  行内规则(仿 remark-math 核心):开 `$` 后不接空白、闭 `$` 前不接空白、内容非空、不跨行 —— 挡掉「$5 和 $10」这类货币误伤。
 *  ponytail: 不处理 `\$` 转义、不识别同段内 code 里的 `$`(调用方已抹掉 code 文本);够用,漏网是极边角。 */
export function scanMath(s: string): MathSpan[] {
  const spans: MathSpan[] = []
  const n = s.length
  const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === undefined
  let i = 0
  while (i < n) {
    if (s[i] === '$') {
      if (s[i + 1] === '$') {
        // 块级 $$…$$(可跨行);$$$ 三连(Yelp 价位/货币)不当块公式起手。
        if (s[i + 2] !== '$') {
          const close = s.indexOf('$$', i + 2)
          if (close > i + 1) {
            const latex = s.slice(i + 2, close).trim()
            if (latex) { spans.push({ from: i, to: close + 2, latex, display: true }); i = close + 2; continue }
          }
        }
        i += 2; continue // 未闭合 / $$$ → 整体跳过,避免退化成行内误配
      }
      // 行内 $…$:开 `$` 后不接空白;闭 `$` 前不接空白、且其后不接字母数字
      // (否则「$5-$10」价位区间、「$HOME/$USER」环境变量会被吞成公式,污染正文)。
      if (!isSpace(s[i + 1])) {
        let j = i + 1
        let found = -1
        while (j < n) {
          const c = s[j]
          if (c === '\n') break              // 行内公式不跨行
          if (c === '$') { if (!isSpace(s[j - 1]) && !/[A-Za-z0-9]/.test(s[j + 1] ?? '')) found = j; break }
          j++
        }
        if (found > i + 1) {
          spans.push({ from: i, to: found + 1, latex: s.slice(i + 1, found), display: false })
          i = found + 1; continue
        }
      }
    }
    i++
  }
  return spans
}

const BREAK_NAMES = new Set(['hardbreak', 'hard_break', 'break'])

/** 把一个 textblock 的内联内容抟成与文档位置 1:1 对齐的字符串:text 原样;code 文本抹成等长空格(不参与公式匹配);
 *  硬换行→'\n'(挡行内公式跨行);其它内联原子(size 1)→ '￼'(绝不是 `$`)。offset i ↔ 文档位 contentStart+i。 */
export function buildBlockString(block: PMNode): string {
  let s = ''
  block.forEach((child) => {
    if (child.isText) {
      const isCode = child.marks.some((m) => m.type.name === 'code' || m.type.name === 'inlineCode')
      const text = child.text ?? ''
      s += isCode ? ' '.repeat(text.length) : text
    } else if (BREAK_NAMES.has(child.type.name)) {
      s += '\n'
    } else {
      s += '￼'.repeat(child.nodeSize) // 非文本内联占位:按 nodeSize 补齐,保 offset↔文档位严格 1:1(内联原子通常 size=1)
    }
  })
  return s
}

/** KaTeX 渲染进 el。throwOnError:false 下 KaTeX 对无法解析的公式会渲一段 `.katex-error` 源码红字(刺眼、常跨多行);
 *  这里把它收敛成一枚干净徽章「⚠」(悬停 title 看 KaTeX 报因),不再把整段源码铺成红字。
 *  数组/矩阵的 `\\` 转义修复(见 unescapeMathSource)后,合法公式正常渲染,只有真不支持的构造才会走到徽章。 */
function katexInto(el: HTMLElement, latex: string, display: boolean): void {
  try {
    katex.render(latex, el, { throwOnError: false, displayMode: display, errorColor: '#e5484d' })
    const err = el.querySelector('.katex-error')
    if (err) {
      const msg = err.getAttribute('title') || translate('mathlive.renderFailedTitle')
      el.replaceChildren()
      const badge = document.createElement('span')
      badge.className = 'math-error'
      badge.title = msg
      badge.textContent = display ? `⚠ ${translate('mathlive.renderFailedBadge')}` : '⚠'
      el.appendChild(badge)
    }
  } catch {
    el.textContent = display ? `$$${latex}$$` : `$${latex}$`
  }
}

/** 离行渲染(点击回到源码可编辑)。preview=true → 作「本行实况预览」:行内 $..$ 浮层在上方、块级 $$..$$ 渲染在下方,不拦鼠标(光标已在源码)。
 *  srcFrom 是**取值函数**(widget 的 getPos):装饰 key 不带位置(P-04),上方一打字 PM 就原样复用这份 DOM,
 *  构建时捕获的数字会指向旧位置 —— 点公式 / `</>` 时现算。 */
function renderMath(view: EditorView, latex: string, display: boolean, srcFrom: () => number | undefined, preview = false): HTMLElement {
  if (preview) {
    const wrap = document.createElement(display ? 'div' : 'span')
    wrap.className = display ? 'math-preview math-preview--block' : 'math-preview math-preview--inline'
    wrap.contentEditable = 'false'
    const inner = document.createElement(display ? 'div' : 'span')
    inner.className = 'math-preview-inner'
    katexInto(inner, latex, display)
    wrap.appendChild(inner)
    return wrap
  }
  const el = document.createElement(display ? 'div' : 'span')
  el.className = display ? 'math-rendered math-rendered--block' : 'math-rendered'
  el.contentEditable = 'false'
  katexInto(el, latex, display)
  // 悬停浮现的 `</>`:点它进源码(点公式本身同样进,这只是看得见的入口)
  attachSourceButton(el, view, () => { const at = srcFrom(); if (at != null) revealSource(view, at) }, !display)
  // 点渲染结果 → 把光标塞进源码(srcFrom+1,即开 `$` 之后)并置焦,该行随即露出源码可编辑。
  el.addEventListener('mousedown', (e) => {
    if (!view.editable) return // 只读视图:点公式不进入编辑态(否则会闪出源码)
    e.preventDefault()
    const at = srcFrom()
    if (at == null) return
    const pos = Math.min(at + 1, view.state.doc.content.size)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)).setMeta(mathKey, { focus: true }))
    view.focus()
  })
  return el
}

/** 围栏代码块切分:偶数下标 = 正文,奇数下标 = 围栏代码块(块内的 $…$ 不是公式,原样保留)。 */
const FENCE_SPLIT = /(^```[\s\S]*?^```[^\n]*$)/m

/** 一段 markdown **原文**里的公式跨度(偏移相对 md)—— 落盘反转义与解析补反斜杠**共用这一份**,别再各写一套。
 *  R-01 返修(评审 2026-09-27):读侧曾按 PM 视图认公式(行内代码抹空、链接地址不计、mark 定界符不计),写侧按原文认;
 *  `` `$HOME` `` / `[a](http://x/?$b)` 里的 `$` 让两侧配出不同的对 —— 读侧补了反斜杠、写侧不还原,每存一次翻一倍。
 *  两侧都在「原文」上用这一个函数,认出的跨度就一致(写侧的原文 = 序列化结果,与打开时的原文逐字相同)。
 *  ponytail: 行内代码 / 链接地址里的 `$` 照旧参与配对(与返修前的落盘侧同一口径)—— 这类段落里的公式可能认不出、
 *  反斜杠一次性丢掉(同 R-01 修前),但不会越存越多。 */
export function mdMathSpans(md: string): MathSpan[] {
  if (md.indexOf('$') === -1) return []
  const out: MathSpan[] = []
  let base = 0
  md.split(FENCE_SPLIT).forEach((part, idx) => {
    if (idx % 2 === 0 && part.indexOf('$') !== -1) {
      for (const sp of scanMath(part)) out.push({ ...sp, from: sp.from + base, to: sp.to + base })
    }
    base += part.length
  })
  return out
}

/** 落盘前把 remark 在 $…$/$$…$$ 里加的反斜杠转义抹掉,让公式按原文持久化(对齐 Obsidian/remark-math)。
 *  math 现是纯文本节点,序列化经 mdast-util-to-markdown **只在「反斜杠后紧接 ASCII 标点」时**加/翻倍转义
 *  (x_i→x\_i、a*b→a\*b、\{→\\{;而 \sum、\begin 这类「反斜杠后接字母」的**原样不动**,\\ 换行也只把首个反斜杠翻倍 → \\\ )。
 *  所以只能反转「\标点→标点」;**绝不能**用 \X→X 盲删——那会把 \sum→sum、\begin→begin、\\→\ 一起吞掉,
 *  命令名和 \\ 换行全丢 → 矩阵/数组(\begin{array}…\hline)当场炸。字符类同 mdast escapeBackslashes 的 [!-/:-@[-`{-~]。
 *  跨度由 mdMathSpans 给(围栏代码块跳过——块内的 $…$ 不是公式,反转义会破坏代码里的 \n 等序列)。 */
export function unescapeMathSource(md: string): string {
  const spans = mdMathSpans(md)
  if (!spans.length) return md
  let out = ''
  let last = 0
  for (const sp of spans) {
    out += md.slice(last, sp.from) + md.slice(sp.from, sp.to).replace(/\\([!-/:-@[-`{-~])/g, '$1')
    last = sp.to
  }
  return out + md.slice(last)
}

// ── 解析侧:公式里的「反斜杠 + 标点」逐字保留(R-01,评审 2026-09-27)────────────────────────────────
//
// 病:公式在编辑器里只是段落纯文本,micromark 解析时把 `\{`、`\\`、`\,`、`\|`、`\%`、`\#`、`\_` 当 markdown 转义
// **吃掉了反斜杠** —— 矩阵 `\\` 塌成一个反斜杠、`\{a,b\}` 变 `{a,b}`。上面 unescapeMathSource 只管序列化一侧,
// 于是「新写的公式首次保存是对的,重开后再编辑一次就坏了」。
//
// 修法:唯一咽喉 = remark 管线(加载 / 切换 / 回灌 / 粘贴都经 parserCtx 走它)。
//  ① mdast-util-from-markdown 扩展:照抄默认的 characterEscapeValue 出口,顺手记下「这个字符来自 `\X`」——
//     它在 text.value 里的下标 + 它在**源串**里的偏移(不猜、不对原文做平行扫描 —— 容器前缀 / 续行缩进 / 字符引用都不会错位)。
//  ② transformer:在**源串**(file.value)上跑 mdMathSpans —— 与写侧 unescapeMathSource 同一个函数、同一种原文 ——
//     落在公式内容里的转义字符前把反斜杠补回。于是 PM 里的公式文本 === 磁盘原文,序列化再经 unescapeMathSource 对称还原。
// ⚠️ 判据**只能**是源串偏移 + mdMathSpans,不能按 PM / mdast 视图另认公式(R-01 返修的病根,见 mdMathSpans 顶注)。
// ⚠️ 必须早于 remark-line-break(它按 `\n` 把 text 拆成新对象,记号随之丢失)—— 挂在 commonmarkWithIndent 的
//    PARSE_FIDELITY 里,不是 .use() 追加。
// ⚠️ 定界 `$` 本身被转义(`\$x\$`)= 用户明说「不是公式」,整段不补。
// ponytail: 公式旁的 `\$`(转义的美元符)落盘时反斜杠会丢(D-11 另归 0b),写侧的配对因此可能与这边不同 ——
//    极边角下反斜杠一次性翻倍一次后稳定,不会越存越多。
// ponytail: gfm 的 autolink-literal 在 fromMarkdown 内部就把含 URL 的 text 拆成新节点(不带记号)——
//    公式里写网址 / 邮箱的转义不补,极边角。
/* eslint-disable @typescript-eslint/no-explicit-any */
type MdNode = any
const ESCAPES = 'amadeusEscapes'

/** 默认 characterEscapeValue 出口(onexitdata)的照抄 + 记下 [value 下标, 源串偏移]。 */
const escapeRecorder = {
  exit: {
    characterEscapeValue(this: any, token: any): void {
      const tail = this.stack.pop()
      ;((tail.data ||= {})[ESCAPES] ||= []).push([tail.value.length, token.start.offset])
      tail.value += this.sliceSerialize(token)
      tail.position.end = { line: token.end.line, column: token.end.column, offset: token.end.offset }
    },
  },
}

/** 按源串把树里公式内被吃掉的反斜杠补回(就地改 text.value;导出供单测)。source = 解析的那份原文(file.value)。 */
export function restoreMathEscapes(tree: MdNode, source: string): void {
  const texts: MdNode[] = []
  const collect = (n: MdNode): void => {
    if (n?.type === 'text' && n.data?.[ESCAPES]) texts.push(n)
    for (const c of n?.children ?? []) collect(c)
  }
  collect(tree)
  if (!texts.length) return
  // micromark 预处理会跳过开头的 BOM,偏移从 BOM 之后算。
  const shift = source.charCodeAt(0) === 0xfeff ? 1 : 0
  // 每条记录 → 源串里被转义字符的下标(反斜杠在它前一位);自检对不上(偏移口径漂了)的直接作废:宁丢勿翻倍。
  const recs = texts.map((n) => {
    const list: Array<[number, number]> = []
    for (const [k, offset] of n.data[ESCAPES] as Array<[number, number]>) {
      const at = offset + shift
      if (source[at - 1] === '\\' && source[at] === n.value[k]) list.push([k, at])
    }
    delete n.data[ESCAPES]
    return list
  })
  // 配对要按「写侧将看到的原文」算:转义的 `\$` 落盘时反斜杠会掉(mdast 不转义 `$`),它左邻就变了 ——
  // 这里先把这些反斜杠拿掉再配对,否则 `$a \$,x$\{b\}$` 这类两侧配出不同的对(读侧补、写侧不还原)。
  const escapedDollar = new Set<number>()
  for (const list of recs) for (const [, at] of list) if (source[at] === '$') escapedDollar.add(at)
  let view = source
  let toSource = (i: number): number => i
  if (escapedDollar.size) {
    const map: number[] = []
    let v = ''
    for (let i = 0; i < source.length; i++) {
      if (escapedDollar.has(i + 1)) continue
      v += source[i]
      map.push(i)
    }
    map.push(source.length)
    view = v
    toSource = (i) => map[i]
  }
  const bodies: Array<[number, number]> = [] // 公式内容(不含定界符)在源串里的 [起, 止)
  for (const sp of mdMathSpans(view)) {
    const dl = sp.display ? 2 : 1
    const delims: number[] = []
    for (let d = 0; d < dl; d++) delims.push(toSource(sp.from + d), toSource(sp.to - 1 - d))
    // 定界 `$` 本身是 `\$`:用户明说「这不是公式」(`\$x\$`),整段不补 —— 否则落盘成 `\\$x\$`。
    if (delims.some((i) => escapedDollar.has(i))) continue
    bodies.push([toSource(sp.from + dl - 1) + 1, toSource(sp.to - dl)])
  }
  if (!bodies.length) return
  texts.forEach((n, i) => {
    const ks: number[] = []
    for (const [k, at] of recs[i]) {
      if (bodies.some(([from, to]) => at - 1 >= from && at < to)) ks.push(k)
    }
    let v: string = n.value
    for (const k of ks.sort((a, b) => b - a)) v = v.slice(0, k) + '\\' + v.slice(k)
    n.value = v
  })
}

/** remark 插件本体(单测直接 .use 它;生产经 mathEscapeRemark 挂进 commonmarkWithIndent)。 */
export function remarkMathEscapes(this: any): (tree: MdNode, file: any) => void {
  const data = this.data()
  ;(data.fromMarkdownExtensions ||= []).push(escapeRecorder)
  return (tree, file) => restoreMathEscapes(tree, String(file?.value ?? ''))
}
export const mathEscapeRemark = $remark('amadeusMathEscapes', () => remarkMathEscapes)
/* eslint-enable @typescript-eslint/no-explicit-any */

const mathKey = new PluginKey<{ focus: boolean }>('amadeus-math-live-preview')

function buildDecorations(state: EditorState): DecorationSet {
  const focus = mathKey.getState(state)?.focus ?? false
  const decos: Decoration[] = []
  const selFrom = state.selection.from
  const selTo = state.selection.to
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    if (node.type.spec.code) return false // 代码块内不渲染公式
    const cs = pos + 1
    const s = buildBlockString(node)
    if (s.indexOf('$') === -1) return false
    const spans = scanMath(s)
    if (!spans.length) return false
    // 若聚焦且选区落在本块 → 算出光标所在「行」(以 '\n' 为界)的字符区间,该行的公式露源码、其余行照常渲染。
    let lineFrom = -1
    let lineTo = -1
    if (focus && selFrom <= cs + node.content.size && selTo >= cs) {
      const a = Math.max(0, Math.min(s.length, selFrom - cs))
      const b = Math.max(0, Math.min(s.length, selTo - cs))
      lineFrom = s.lastIndexOf('\n', a - 1) + 1
      const nl = s.indexOf('\n', b)
      lineTo = nl === -1 ? s.length : nl
    }
    for (const sp of spans) {
      const onActiveLine = lineFrom !== -1 && sp.from < lineTo && sp.to > lineFrom
      if (onActiveLine) {
        // 本行 → 源码保持可编辑,同时给一个实况预览:行内 $..$ 浮层在上方、块级 $$..$$ 渲染在源码下方。
        const anchor = sp.display ? cs + sp.to : cs + sp.from
        decos.push(Decoration.widget(anchor, (v, getPos) => renderMath(v, sp.latex, sp.display, getPos, true), {
          side: sp.display ? 1 : -1,
          ignoreSelection: true,
          key: `p:${sp.display ? 'b' : 'i'}:${sp.latex}`, // 不带位置(P-04):预览不读位置,内容相同即可复用
        }))
        continue
      }
      const from = cs + sp.from
      const to = cs + sp.to
      const { latex, display } = sp
      decos.push(Decoration.inline(from, to, { class: 'math-src-hidden' }))
      // ⚠️ key **不带位置**(评审 P-04):带上 from 的话,文首打一个字,下游每个公式的 key 都变,PM 把它们
      //    整批销毁重建、逐个重跑 KaTeX(120 个公式每键 ~78ms)。位置改由 widget 的 getPos 在点击时现算。
      decos.push(Decoration.widget(from, (v, getPos) => renderMath(v, latex, display, getPos), {
        side: -1,
        ignoreSelection: true,
        key: `m:${display ? 'b' : 'i'}:${latex}`,
      }))
    }
    return false // 不深入内联
  })
  return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty
}

export function mathLivePreviewPlugin() {
  return $prose(
    () =>
      new Plugin<{ focus: boolean }>({
        key: mathKey,
        state: {
          init: () => ({ focus: false }),
          apply: (tr, value) => {
            const m = tr.getMeta(mathKey) as { focus?: boolean } | undefined
            return m && typeof m.focus === 'boolean' ? { focus: m.focus } : value
          },
        },
        props: {
          // 失焦 → 全部渲染(每个 Amadeus 块独立编辑器:点别的块 = 本块失焦,公式即渲染)。
          handleDOMEvents: {
            focus: (view) => { if (!mathKey.getState(view.state)?.focus) view.dispatch(view.state.tr.setMeta(mathKey, { focus: true })); return false },
            blur: (view) => { if (mathKey.getState(view.state)?.focus) view.dispatch(view.state.tr.setMeta(mathKey, { focus: false })); return false },
          },
          decorations: (state) => buildDecorations(state),
        },
      }),
  )
}
