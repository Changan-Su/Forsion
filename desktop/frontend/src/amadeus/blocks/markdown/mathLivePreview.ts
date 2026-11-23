// LaTeX 实况预览(Obsidian 式):数学公式在文档里**始终是纯文本** `$…$` / `$$…$$`(零 schema、零序列化改动,
// .md 落盘原样),仅当光标**不在这一处公式**时用 ProseMirror 装饰渲染成 KaTeX;光标回到公式 → 露出
// 源码可编辑。因此不再用 @milkdown/plugin-math 的原子节点(那套一敲完就变原子、无法再编辑)。
//
// 为什么用装饰而非节点:节点是原子,光标进不去、编辑=删了重打;装饰不动文档,源码就是原生文本,光标天然可编辑,
// 序列化/撤销/其它插件全部无感。整页编辑器只在文档改变时重建全套装饰，移动选区只重画显隐或语法着色受影响的段落。
import { $prose, $remark } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import type { Mark, Node as PMNode } from '@milkdown/kit/prose/model'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { attachCopyButton, attachSourceButton, revealSource } from './sourceToggle'
import { editorFocusKey, editorFocused } from './editorFocus'
import { registerMessages, translate } from '../../../i18n'
import { mathDollarInput, mathPairBackspace, mathBracketInput, mathBracketBackspace } from './mathTyping'
import { inlinePreviewCaret, inlinePreviewEdgeClick, inlinePreviewEdgeKeyDown } from './inlinePreviewCaret'
import { mathSourceHighlights } from './mathSourceHighlight'
import { UI_ZOOM_EVENT } from '../../lib/clampMenu'

import { ESCAPES, escapeRecorder, scanMath, type MathSpan } from './inlineTextSpans'
export { scanMath, type MathSpan } from './inlineTextSpans'

registerMessages({
  'mathlive.renderFailedTitle': { zh: 'LaTeX 无法渲染', en: 'LaTeX could not be rendered' },
  'mathlive.renderFailedBadge': { zh: '公式无法渲染', en: 'Formula could not be rendered' },
})

const BREAK_NAMES = new Set(['hardbreak', 'hard_break', 'break'])

/** 把一个 textblock 的内联内容抟成与文档位置 1:1 对齐的字符串:text 原样;code 文本抹成等长空格(不参与公式匹配);
 *  硬换行→'\n'(挡行内公式跨行);其它内联原子(size 1)→ '￼'(绝不是 `$`)。offset i ↔ 文档位 contentStart+i。 */
export function buildBlockString(block: PMNode): string {
  let s = ''
  block.forEach((child) => {
    if (child.isText) {
      const isCode = child.marks.some((m) => m.type.name === 'code' || m.type.name === 'inlineCode')
      const text = child.text ?? ''
      // 用户转义过的定界符(`\[\[`、`\$`、`\=\=`、`\%\%`、`\#`,D-11 的 amadeusEscaped mark)不参与匹配:换成占位,
      // 双链 / 公式 / 高亮注释 / 标签胶囊一处全认。只换定界符 —— 双链名里被转义的 `_` / `|` 照常属于链接名。
      const escaped = !isCode && child.marks.some((m) => m.type.name === 'amadeusEscaped')
      s += isCode ? ' '.repeat(text.length) : escaped ? text.replace(/[[\]$=%#]/g, '\u0002') : text
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

/** 渲染公式(点击回到源码)。preview=true → 当前公式在源码下方预览，不拦鼠标。
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
  // 块公式:`</>` 左边再挂一颗复制键(只读视图也有)
  if (display) attachCopyButton(el, view, latex)
  // 悬停浮现的 `</>`:点它进源码(点公式本身同样进,这只是看得见的入口)
  attachSourceButton(el, view, () => { const at = srcFrom(); if (at != null) revealSource(view, at) }, !display)
  // 点渲染结果 → 把光标塞进源码(srcFrom+1,即开 `$` 之后)并置焦,该行随即露出源码可编辑。
  el.addEventListener('mousedown', (e) => {
    if (!view.editable) return // 只读视图:点公式不进入编辑态(否则会闪出源码)
    e.preventDefault()
    const at = srcFrom()
    if (at == null) return
    const pos = Math.min(at + 1, view.state.doc.content.size)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)).setMeta(editorFocusKey, true))
    view.focus()
  })
  return el
}

/** 预览里光标的记号:同 Obsidian LaTeX Suite 的缺省 ▶。包一层 `{}`,后面紧跟字母也不会粘成别的命令。 */
const CARET_MARK = '{\\blacktriangleright}'

/** `latex[k]` 这个反斜杠是不是一条命令的开头(前面连着偶数个反斜杠;`\\` 换行的第二个不算)。 */
function startsCommand(latex: string, k: number): boolean {
  let n = 0
  for (let i = k; i >= 0 && latex[i] === '\\'; i--) n++
  return n % 2 === 1
}

/** 在公式正文的光标处插 ▶(at = 光标在 latex 里的偏移)。光标落在命令名上(`\fr|ac`、`\sqrt|`、`\{|`、`\|`)时挪到
 *  反斜杠前 —— 同 LaTeX Suite:不把命令拆坏,▶ 也不会被当成命令的参数。导出供单测。 */
export function markCaret(latex: string, at: number): string {
  let i = Math.max(0, Math.min(at, latex.length))
  let j = i
  while (j > 0 && /[A-Za-z]/.test(latex[j - 1])) j--
  if (j < i && j > 0 && latex[j - 1] === '\\' && startsCommand(latex, j - 1)) i = j - 1
  else if (i > 0 && latex[i - 1] === '\\' && startsCommand(latex, i - 1)) i -= 1
  else if (i > 1 && latex[i - 2] === '\\' && !/[A-Za-z]/.test(latex[i - 1]) && startsCommand(latex, i - 2)) i -= 2
  return latex.slice(0, i) + CARET_MARK + latex.slice(i)
}

/** 选区落在这个公式里(start / end = 含两头 `$` 的源码范围)。空选区 = 光标在公式源码里(右边界不算,同「正在编辑」
 *  的口径);非空选区要两头都在两头的 `$` 之间(同 LaTeX Suite 判「在公式里」的口径)。连 `$` 一起选中整个公式、或选区
 *  跨出公式都不算 —— 那是对整个公式 / 正文动手,格式浮条照旧。 */
function selectionInside(from: number, to: number, start: number, end: number, display: boolean): boolean {
  if (from === to) return from >= start && from < end
  const d = display ? 2 : 1
  return from >= start + d && to <= end - d
}

/** 选区所在的那个公式(口径同 selectionInside):不在公式里 / 跨出公式 / 代码块里 → null。
 *  格式浮条据此让位(公式源码里没有粗体斜体可言,同 Obsidian)。 */
export function formulaAtSelection(state: EditorState): { from: number; to: number; latex: string; display: boolean } | null {
  const { $from, $to, from, to } = state.selection
  if (!$from.parent.isTextblock || $from.parent.type.spec.code || !$from.sameParent($to)) return null
  const s = buildBlockString($from.parent)
  if (s.indexOf('$') === -1) return null
  const cs = $from.start()
  const sp = scanMath(s).find((x) => selectionInside(from, to, cs + x.from, cs + x.to, x.display))
  return sp ? { from: cs + sp.from, to: cs + sp.to, latex: sp.latex, display: sp.display } : null
}

/** 正在编辑的行内公式(光标或选区在它里面,口径同 selectionInside):给浮层预览用。没焦点 / 不在行内公式里 /
 *  选区跨出公式 → null。▶ 标在选区末端(空选区就是光标),同 LaTeX Suite —— 选中占位时也看得出在哪。 */
function activeInlineFormula(state: EditorState): { from: number; to: number; latex: string; caretAt: number } | null {
  if (!editorFocused(state)) return null
  const hit = formulaAtSelection(state)
  if (!hit || hit.display) return null
  const { to } = state.selection
  return { from: hit.from, to: hit.to, latex: hit.latex, caretAt: Math.min(Math.max(to - (hit.from + 1), 0), hit.latex.length) }
}

const FLOAT_GAP = 4 // 气泡与这一行之间的空隙(视觉 px)

/** 行内公式编辑中的预览:浮在这一行上方的小气泡(放不下翻到下方),▶ 标出光标位置;不占文档流、不推挤正文。
 *  气泡由插件视图自己挂在编辑器 DOM 的**外面**(view.dom 的父节点里),不进 contentDOM:段尾不多任何节点,
 *  coordsAtPos / 方向键 / 输入法量到的都还是正文本身。块公式的预览照旧是源码下方的装饰。 */
class InlineMathFloat {
  private el: HTMLElement | null = null
  private key = ''
  private raf = 0
  private armed = false
  private resize: ResizeObserver | null = null

  constructor(private view: EditorView) {
    this.update(view)
  }

  update(view: EditorView, prev?: EditorState): void {
    this.view = view
    // 纯 meta 事务(文档、选区、焦点都没变):位置与内容都不变,不量。
    if (prev && this.el && prev.doc === view.state.doc && prev.selection.eq(view.state.selection) &&
        editorFocused(prev) === editorFocused(view.state)) return
    const hit = activeInlineFormula(view.state)
    const host = view.dom.parentElement
    if (!hit || !host) return this.hide()
    if (!this.el) {
      this.el = document.createElement('div')
      this.el.className = 'math-preview math-preview--inline math-preview--float'
      this.el.setAttribute('aria-hidden', 'true') // 纯视觉辅助,读屏读源码本身
    }
    if (this.el.parentElement !== host) host.appendChild(this.el)
    const key = `${hit.caretAt}:${hit.latex}`
    if (key !== this.key) {
      this.key = key
      const inner = document.createElement('span')
      inner.className = 'math-preview-inner'
      katexInto(inner, markCaret(hit.latex, hit.caretAt), false)
      // 插了记号反而渲染不了(半截命令之类):退回不带记号的版本,预览照常有。
      if (inner.querySelector('.math-error')) katexInto(inner, hit.latex, false)
      this.el.replaceChildren(inner)
    }
    this.place(hit)
    this.arm(true)
  }

  private later = (): void => {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      const hit = this.el && activeInlineFormula(this.view.state)
      if (hit) this.place(hit)
    })
  }

  /** 只在气泡开着时监听:滚动(翻上 / 翻下)、窗口与界面缩放、编辑区改宽(分栏拖动会让公式换行)。 */
  private arm(on: boolean): void {
    if (on === this.armed) return
    this.armed = on
    if (on) {
      window.addEventListener('scroll', this.later, true)
      window.addEventListener('resize', this.later)
      window.addEventListener(UI_ZOOM_EVENT, this.later)
      if (typeof ResizeObserver !== 'undefined') {
        this.resize = new ResizeObserver(this.later)
        this.resize.observe(this.view.dom)
      }
    } else {
      window.removeEventListener('scroll', this.later, true)
      window.removeEventListener('resize', this.later)
      window.removeEventListener(UI_ZOOM_EVENT, this.later)
      this.resize?.disconnect()
      this.resize = null
    }
  }

  /** 左缘让预览里的字对齐源码的 `$`,底边落在这一行上方;上方被裁切的祖先 / 吸顶工具栏挡住就翻到下方;左右夹在编辑区里。
   *  先归零再量、按「布局 px / 视觉 px」换算(computed width ÷ 量到的宽,带小数;界面缩放与画布缩放都算进去)。 */
  private place(hit: { from: number; to: number }): void {
    const el = this.el, view = this.view
    if (!el) return
    let start: { left: number; top: number }
    let end: { bottom: number }
    try {
      start = view.coordsAtPos(hit.from, 1)
      end = view.coordsAtPos(hit.to, -1)
    } catch { return }
    el.classList.remove('is-below')
    el.style.left = '0px'
    el.style.top = '0px'
    el.style.maxWidth = ''
    const area = view.dom.getBoundingClientRect()
    let left = area.left, right = area.right, top = 0
    for (let a = el.parentElement; a; a = a.parentElement) {
      const st = getComputedStyle(a)
      // display: contents 的壳(.amx-stage-off 这类)没有盒子,overflow 不生效,量出来是 0×0,别拿它裁。
      if (st.display !== 'contents' && (st.overflowX !== 'visible' || st.overflowY !== 'visible')) {
        const r = a.getBoundingClientRect()
        left = Math.max(left, r.left); right = Math.min(right, r.right); top = Math.max(top, r.top)
      }
    }
    const bar = view.dom.closest('.amx-pane')?.querySelector('.amx-toolbar')
    if (bar) top = Math.max(top, bar.getBoundingClientRect().bottom)
    right = Math.min(right, document.documentElement.clientWidth)
    const r0 = el.getBoundingClientRect()
    if (!r0.width) return // 视图藏起来了(换到后台的标签)
    const k = parseFloat(getComputedStyle(el).width) / r0.width || 1
    if (r0.width > right - left) el.style.maxWidth = `${Math.max(0, (right - left) * k)}px`
    const r = el.getBoundingClientRect()
    const inset = (el.firstElementChild?.getBoundingClientRect().left ?? r.left) - r.left
    const x = Math.max(left, Math.min(start.left - inset, right - r.width))
    let y = start.top - FLOAT_GAP - r.height
    if (y < top) {
      y = end.bottom + FLOAT_GAP
      el.classList.add('is-below')
    }
    el.style.left = `${(x - r.left) * k}px`
    el.style.top = `${(y - r.top) * k}px`
  }

  hide(): void {
    this.arm(false)
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.el?.remove()
    this.key = ''
  }

  destroy(): void {
    this.hide()
    this.el = null
  }
}

// ── 「哪些地方不算公式」:按 Markdown 解析的口径把代码 / 地址抹成空格 ──────────────────────────────────
// 抹掉的区域:围栏代码(开 / 闭栏行与栏内)、缩进代码块、行内代码(任意长度反引号)、行内链接 / 图片的地址与标题、
// 合法引用定义的地址与标题(含标题在下一行)。抹成等长空格(换行保留)→ 偏移不变,`$` 贴着代码时的开闭判据与显示侧
// buildBlockString(code 文本抹成空格)一致。
// 读写两侧都在「原文」上调它:读侧是磁盘原文,写侧是序列化结果。序列化器对代码 / 地址不加转义、对正文里的反引号
// 加 `\`,用户写的转义在写侧是 ESCAPE_SENTINEL(NUL,见 ./literalEscape)—— 所以「被转义」认 奇数个反斜杠 或 NUL。
// ⚠️ 抹错的代价不对称:抹多了 = 真公式读侧不补反斜杠(编辑器里公式渲染错,回归);抹少了 = 代码 / 地址里的 `\_`
//    存盘时被当公式反转义删掉(老毛病)。拿不准一律少抹。结构按 CommonMark + GFM 走两遍:
//    ① 块级(scanBlocks):引用层数、列表项 / 脚注定义的内容列(容器)、围栏(相对容器缩进 ≤3)、缩进代码(不能打断段落)、
//       HTML 块(里面不做行内解析)、引用定义(不能打断段落;整行剩余恰好是「地址 + 可选标题」才算)→ 段落 / 标题的行内区间;
//    ② 行内(scanInline):每个段落一遍向前扫 —— 反引号串配对、`<…>` 自动链接 / 行内 HTML 跳过、方括号栈配链接(链接成立后
//       外层 `[` 失效,同 CommonMark),整体线性。
//    尖括号自动链接 `<…>` 只跳过、不抹:序列化器会把其中的反斜杠翻倍,抹掉就反转义不回来,越存越多(公式里写 `<ab:x\{y\}>`)。
// 仪器:mathLivePreview.test.ts「maskNonMath 对拍 remark 解析器」—— 拿编辑器同一套 remark 解析出的 mdast 量抹多 / 抹少。
const isAsciiPunct = (c: string | undefined): boolean => c !== undefined && /[!-/:-@[-`{-~]/.test(c)

function escapedAt(s: string, i: number): boolean {
  if (s[i - 1] === '\u0000') return true
  let k = 0
  while (s[i - 1 - k] === '\\') k++
  // 写侧 `NUL\` = 用户转义过的反斜杠(字面 `\`),它吃掉这串里的第一个反斜杠。
  if (k && s[i - 1 - k] === '\u0000') k--
  return k % 2 === 1
}

/** 地址:`<…>`(不跨行、不含未转义的 `<` `>`)或一串不含空白的字符(括号配平,不超过 32 层;遇到未配对的 `)` 停)。
 *  返回地址之后的下标,不合法 -1。 */
function destEnd(v: string, p: number): number {
  const n = v.length
  if (v[p] === '<') {
    let q = p + 1
    for (; q < n; q++) {
      const c = v[q]
      if (c === '>') return q + 1
      if (c === '\n' || c === '<') return -1
      if ((c === '\\' || c === '\u0000') && q + 1 < n && v[q + 1] !== '\n') q++
    }
    return -1
  }
  let q = p
  let depth = 0
  for (; q < n; q++) {
    const c = v[q]
    if ((c === '\\' || c === '\u0000') && isAsciiPunct(v[q + 1])) { q++; continue }
    if (c <= ' ' || c === '\u007f') break
    if (c === '(') { if (++depth > 32) return -1 }
    else if (c === ')') { if (!depth) break; depth-- }
  }
  return q === p || depth ? -1 : q
}

/** 标题:`"…"` `'…'` `(…)`(转义的引号不算闭合;括号标题里不许有未转义的 `(`)。返回闭合之后的下标,不合法 -1。 */
function titleEnd(v: string, p: number): number {
  const open = v[p]
  if (open !== '"' && open !== "'" && open !== '(') return -1
  const close = open === '(' ? ')' : open
  for (let q = p + 1; q < v.length; q++) {
    const c = v[q]
    if ((c === '\\' || c === '\u0000') && isAsciiPunct(v[q + 1])) { q++; continue }
    if (c === close) return q + 1
    if (open === '(' && c === '(') return -1
  }
  return -1
}

/** 空格 / Tab,最多再跨一个换行。 */
function skipWs(v: string, p: number, newline: boolean): number {
  let nl = !newline
  while (p < v.length) {
    const c = v[p]
    if (c === ' ' || c === '\t') p++
    else if (c === '\n' && !nl) { nl = true; p++ }
    else break
  }
  return p
}

/** 行内链接 `](` 之后的部分:返回收尾 `)` 的下标,不成链接 -1。标题前必须有空白(地址里的撇号 / 引号是地址的一部分)。 */
function linkTailEnd(v: string, p: number): number {
  let q = skipWs(v, p, true)
  if (v[q] === ')') return q
  const d = destEnd(v, q)
  if (d === -1) return -1
  q = skipWs(v, d, true)
  if (v[q] === ')') return q
  if (q === d) return -1
  const t = titleEnd(v, q)
  if (t === -1) return -1
  q = skipWs(v, t, true)
  return v[q] === ')' ? q : -1
}

const normLabel = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase()

const HTML_BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt '
  + 'fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem '
  + 'nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '))
const TAG_ATTR = `(?:\\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\\s*=\\s*(?:[^\\s"'=<>\`]+|'[^']*'|"[^"]*"))?)`
const OPEN_TAG = `<[A-Za-z][A-Za-z0-9-]*${TAG_ATTR}*\\s*\\/?>`
const CLOSE_TAG = `<\\/[A-Za-z][A-Za-z0-9-]*\\s*>`
const INLINE_TAG = new RegExp(`${OPEN_TAG}|${CLOSE_TAG}`, 'y')
const HTML7_LINE = new RegExp(`^(?:${OPEN_TAG}|${CLOSE_TAG})[ \\t]*$`)
const AUTOLINK = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>|<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>/y

/** 行首是不是新起一块(按 CommonMark 能否打断段落):返回块类型或 null。content 已去掉引用前缀与缩进。 */
type BlockKind = 'fence' | 'atx' | 'setext' | 'hr' | 'list' | 'footnote' | 'html' | null
function blockStart(content: string, paraOpen: boolean, lazy = false, listInterrupt = paraOpen): BlockKind {
  const c0 = content[0]
  if ((c0 === '`' || c0 === '~') && /^(`{3,}|~{3,})/.test(content)) {
    const m = /^(`{3,}|~{3,})(.*)$/.exec(content)!
    if (!(m[1][0] === '`' && m[2].includes('`'))) return 'fence'
  }
  if (c0 === '#' && /^#{1,6}(?:[ \t]|$)/.test(content)) return 'atx'
  if (paraOpen && !lazy && /^(?:=+|-+)[ \t]*$/.test(content)) return 'setext' // 懒续行当不了 setext 底线
  if (/^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(content)) return 'hr'
  const li = /^(?:[-+*]|(\d{1,9})[.)])(?=[ \t]|$)/.exec(content)
  if (li && !(listInterrupt && (!content.slice(li[0].length).trim() || (li[1] !== undefined && li[1] !== '1')))) return 'list'
  if (c0 === '[' && /^\[\^[^\]\s]+\]:/.test(content)) return 'footnote'
  if (c0 === '<') {
    if (/^<(?:script|pre|style|textarea)(?:[ \t>]|$)/i.test(content) || /^<(?:!--|\?|![A-Za-z]|!\[CDATA\[)/.test(content)) return 'html'
    const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t>]|\/>|$)/.exec(content)
    if (tag && HTML_BLOCK_TAGS.has(tag[1].toLowerCase())) return 'html'
    if (!paraOpen && HTML7_LINE.test(content)) return 'html'
  }
  return null
}
/** HTML 块的结束条件:null = 到空行为止,否则这一行命中即结束(含该行)。 */
function htmlBlockEnd(content: string): RegExp | null {
  if (/^<(?:script|pre|style|textarea)/i.test(content)) return /<\/(?:script|pre|style|textarea)>/i
  if (content.startsWith('<!--')) return /-->/
  if (content.startsWith('<?')) return /\?>/
  if (content.startsWith('<![CDATA[')) return /\]\]>/
  if (content.startsWith('<!')) return />/
  return null
}

/** `s` 从 p 起恰好是「地址 + 可选标题」(标题前要有空白,后面不许再有字)。返回 0 = 不是,1 = 只有地址,2 = 地址 + 标题。 */
function destTitleOnly(s: string, p: number): 0 | 1 | 2 {
  const d = destEnd(s, p)
  if (d === -1) return 0
  let q = skipWs(s, d, false)
  if (q >= s.length) return 1
  if (q === d) return 0
  const t = titleEnd(s, q)
  if (t === -1) return 0
  q = skipWs(s, t, false)
  return q >= s.length ? 2 : 0
}

/** 引用定义的头一行 `[label]: 地址 [标题]`:整行剩余恰好是这些才算(多行标题不认 —— 少抹)。
 *  返回 { label, from(冒号之后), rest: 0 = 冒号后空着(地址在下一行) / 1 = 只有地址 / 2 = 地址 + 标题 },不是定义返回 null。 */
function parseDefinition(content: string): { label: string; from: number; rest: 0 | 1 | 2 } | null {
  const m = /^\[((?:[^\\[\]\u0000]|[\\\u0000][\s\S]){1,999})\]:/.exec(content)
  if (!m || !/\S/.test(m[1]) || m[1][0] === '^') return null
  const from = m[0].length
  const p = skipWs(content, from, false)
  if (p >= content.length) return { label: m[1], from, rest: 0 }
  const rest = destTitleOnly(content, p)
  return rest ? { label: m[1], from, rest } : null
}

interface Line { start: number; end: number }
/** 一行的引用前缀:层数、正文起点(`>` 后的一个可选空格算前缀)、正文缩进列数与首个非空白字符的位置。 */
function quoteOf(md: string, ln: Line, firstLead: number, maxDepth = Infinity): { depth: number; body: number; cols: number; text: number } {
  let p = ln.start
  let depth = 0
  for (;;) {
    if (depth >= maxDepth) {
      let q = p
      let cols = 0
      while (q < ln.end && (md[q] === ' ' || md[q] === '\t')) { cols += md[q] === '\t' ? 4 - (cols % 4) : 1; q++ }
      return { depth, body: p, cols, text: q }
    }
    let q = p
    let cols = 0
    while (q < ln.end && (md[q] === ' ' || md[q] === '\t')) { cols += md[q] === '\t' ? 4 - (cols % 4) : 1; q++ }
    if (q < ln.end && md[q] === '>' && cols <= (depth ? 3 : firstLead)) {
      depth++
      p = q + 1
      if (md[p] === ' ') p++
      continue
    }
    return { depth, body: p, cols, text: q }
  }
}

/** 块级:围栏 / 缩进代码整行抹空、引用定义的地址与标题抹空;返回各段落 / 标题的行内字符下标(跨行时含换行)与定义过的标签。 */
function scanBlocks(md: string, a: string[]): { segs: number[][]; labels: Set<string>; notes: Set<string> } {
  const lines: Line[] = []
  for (let s = 0; s <= md.length;) {
    let e = md.indexOf('\n', s)
    if (e === -1) e = md.length
    lines.push({ start: s, end: e > s && md[e - 1] === '\r' ? e - 1 : e })
    s = e + 1
  }
  const blankLine = (ln: Line): void => { for (let x = ln.start; x < ln.end; x++) a[x] = ' ' }
  const segs: number[][] = []
  const labels = new Set<string>()
  const notes = new Set<string>() // 脚注定义的标签:`[^x]` 有定义时是脚注引用,不是链接的 `[`
  let seg: number[] | null = null
  const addToSeg = (from: number, ln: Line): void => {
    if (seg) seg.push(ln.start - 1) // 段落里的换行(上一行与这一行连续:空行 / 代码 / HTML 都会先把 seg 清掉)
    else segs.push(seg = [])
    for (let x = from; x < ln.end; x++) seg.push(x)
  }
  let fence: { ch: string; len: number; depth: number; base: number } | null = null
  let html: { end: RegExp | null; depth: number } | null = null
  let containers: number[] = [] // 列表项 / 脚注定义的内容列(相对引用前缀之后)
  let lastDepth = 0
  let para = false
  // 段落到目前为止全是引用定义(定义是从段落开头剥出来的:块级上段落照样开着,后面的缩进行是续行不是代码;
  // 下一条定义照样能接上;一旦有了普通文字,后面的 `[x]: …` 就只是文字)
  let defOnly = false
  let table = null as { depth: number; base: number } | null
  /** 表格一行按未转义的 `|` 切格(首尾的 `|` 不算一格)。 */
  const cellsOf = (from: number, to: number): Array<[number, number]> => {
    while (to > from && (md[to - 1] === ' ' || md[to - 1] === '\t')) to--
    let start = md[from] === '|' ? from + 1 : from
    const cells: Array<[number, number]> = []
    for (let x = start; x < to; x++) if (md[x] === '|' && !escapedAt(md, x)) { cells.push([start, x]); start = x + 1 }
    if (start < to) cells.push([start, to])
    return cells
  }
  const tableRow = (ln: Line, text: number): void => {
    for (const [from, to] of cellsOf(text, ln.end)) { seg = null; addToSeg(from, { start: ln.start, end: to }) }
    seg = null
  }
  /** 段落里的一行(新段落开头或续行):段落到目前全是定义时先试定义,不是就当文字。返回多吃掉的行数(地址 / 标题在下一行)。 */
  const paraLine = (li: number, text: number, ln: Line, depth: number, base: number): number => {
    if ((!para || defOnly) && md[text] === '[') {
      const def = parseDefinition(md.slice(text, ln.end))
      if (def) {
        // 下一行(同一引用层、是段落续行而不新起一块)可能接着地址 / 标题
        const next = lines[li + 1]
        const nq = next ? quoteOf(md, next, 3 + base) : null
        const body = next && nq && nq.depth === depth && nq.text < next.end ? md.slice(nq.text, next.end) : null
        const cont = body !== null && !(nq!.cols - base <= 3 && blockStart(body, true))
        let used = 0
        if (def.rest === 0) used = cont && destTitleOnly(body!, 0) ? 1 : -1
        else if (def.rest === 1 && cont && /^["'(]/.test(body!) && titleEnd(body!, 0) !== -1 && skipWs(body!, titleEnd(body!, 0), false) >= body!.length) used = 1
        if (used !== -1) {
          labels.add(normLabel(def.label))
          for (let x = text + def.from; x < ln.end; x++) a[x] = ' '
          if (used) for (let x = nq!.text; x < next!.end; x++) a[x] = ' '
          seg = null
          para = true
          defOnly = true
          return used
        }
      }
    }
    // GFM 表格:这一行是表头、下一行是分隔行(列数一致)→ 打断段落;各单元格单独做行内解析(`|` 在行内代码里照样分格)
    const next = lines[li + 1]
    if (next && md.slice(text, ln.end).includes('|')) {
      const nq = quoteOf(md, next, 3 + base)
      const delim = md.slice(nq.text, next.end)
      if (nq.depth === depth && nq.cols - base <= 3 && /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(delim) && delim.includes('|')
        && cellsOf(nq.text, next.end).length === cellsOf(text, ln.end).length) {
        seg = null
        tableRow(ln, text)
        table = { depth, base }
        para = false
        defOnly = false
        return 1
      }
    }
    if (para && defOnly) seg = null // 定义之后的第一行文字:新起行内区间(定义行不参与行内解析)
    addToSeg(text, ln)
    para = true
    defOnly = false
    return 0
  }
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li]
    const top = containers.length ? containers[containers.length - 1] : 0
    const qd = quoteOf(md, ln, 3 + top)
    let { cols } = qd
    const { depth } = qd
    let text = qd.text
    const isBlank = text >= ln.end
    if (fence) {
      // 栏内不再认新的引用 / 列表:只剥开栏那几层 `>`
      const fq = quoteOf(md, ln, 3 + top, fence.depth)
      const fBlank = fq.text >= ln.end
      if (fq.depth < fence.depth || (!fBlank && fq.cols < fence.base)) fence = null
      else {
        const m = /^(`{3,}|~{3,})[ \t]*$/.exec(md.slice(fq.text, ln.end))
        if (!fBlank && fq.cols - fence.base <= 3 && m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null
        blankLine(ln)
        continue
      }
    }
    if (html) {
      const hq = quoteOf(md, ln, 3 + top, html.depth)
      if (hq.depth < html.depth || (html.end === null && hq.text >= ln.end)) html = null
      else {
        if (html.end && html.end.test(md.slice(ln.start, ln.end))) html = null
        continue
      }
    }
    if (isBlank) { para = false; seg = null; table = null; continue }
    // 上一行段落还开着、且原有容器这一行都接上了:这一行新开的列表项(哪怕套在新开的引用里)都按「打断段落」判 ——
    // 空项、非 1 起头的有序项不算(micromark 只在原有容器全接上时按子 flow 里有没有进行中的段落定 interrupt;
    // 有容器没接上时不限制,`> a\n- ` 的 `- ` 照样是空列表项)
    let lineInterrupt = para && depth >= lastDepth
    if (table) {
      if (depth === table.depth && !isBlank && cols >= table.base && !(cols - table.base <= 3 && blockStart(md.slice(text, ln.end), true))) {
        tableRow(ln, text)
        continue
      }
      table = null
    }
    if (depth !== lastDepth) {
      // 引用层数变了:层数变少且段落开着、这行又不新起一块 = 懒续行(仍属那个段落)
      if (para && depth < lastDepth && (cols >= 4 || !blockStart(md.slice(text, ln.end), true, true, false))) { li += paraLine(li, text, ln, lastDepth, 0); continue }
      containers = []
      para = false
      seg = null
      lastDepth = depth
    }
    // 容器:缩进不够当前内容列的,要么是懒续行,要么退出容器
    let keep = containers.length
    while (keep && cols < containers[keep - 1]) keep--
    let base = keep ? containers[keep - 1] : 0
    let content = md.slice(text, ln.end)
    if (keep < containers.length) {
      if (para && !(cols - base <= 3 && blockStart(content, true, true, false))) { li += paraLine(li, text, ln, depth, base); continue }
      containers = containers.slice(0, keep)
      lineInterrupt = false
      para = false // 不是懒续行:原段落随容器一起结束
      seg = null
    }
    // 一行可以连开几层容器(`- - x`、`1. [^1]: …` 很少见,照样一层层剥)
    for (;;) {
      const rel = cols - base
      if (rel >= 4) {
        if (para) li += paraLine(li, text, ln, depth, base)
        else { blankLine(ln); seg = null }
        break
      }
      const kind = blockStart(content, para, false, para || lineInterrupt)
      if (kind === 'fence') {
        const m = /^(`{3,}|~{3,})/.exec(content)!
        fence = { ch: m[1][0], len: m[1].length, depth, base }
        blankLine(ln)
        para = false; seg = null
        break
      }
      if (kind === 'list' || kind === 'footnote') {
        const mk = kind === 'list' ? /^(?:[-+*]|\d{1,9}[.)])/.exec(content)![0] : /^\[\^[^\]\s]+\]:/.exec(content)![0]
        let q = text + mk.length
        let sp = 0
        while (q < ln.end && (md[q] === ' ' || md[q] === '\t')) { sp += md[q] === '\t' ? 4 - ((cols + mk.length + sp) % 4) : 1; q++ }
        const col = kind === 'footnote' ? cols + 4 : cols + mk.length + (q >= ln.end || sp > 4 ? 1 : sp)
        if (kind === 'footnote') notes.add(normLabel(mk.slice(2, -2)))
        containers.push(col)
        para = false; seg = null
        if (q >= ln.end) break
        // 记号后 ≥5 格:内容列 = 记号 + 1,余下按相对缩进 ≥4 走缩进代码
        cols += mk.length + sp
        base = col
        text = q
        content = md.slice(text, ln.end)
        continue
      }
      if (kind === 'atx') {
        const h = /^#{1,6}[ \t]*/.exec(content)![0]
        seg = null
        addToSeg(text + h.length, ln)
        seg = null
        para = false
        break
      }
      if (kind === 'setext' || kind === 'hr') { para = false; seg = null; break }
      if (kind === 'html') {
        const end = htmlBlockEnd(content)
        html = end && end.test(content.slice(2)) ? null : { end, depth }
        para = false; seg = null
        break
      }
      li += paraLine(li, text, ln, depth, base)
      break
    }
  }
  return { segs, labels, notes }
}

/** 行内:一个段落(下标序列 idx,跨行处是换行)一遍向前扫。 */
function scanInline(md: string, idx: number[], a: string[], labels: Set<string>, notes: Set<string>): void {
  const n = idx.length
  let v = ''
  for (const i of idx) v += md[i]
  const esc = (x: number): boolean => escapedAt(md, idx[x])
  const maskV = (from: number, to: number): void => { for (let y = from; y < to; y++) if (v[y] !== '\n') a[idx[y]] = ' ' }
  // 反引号串:按长度登记起点;配对 = 之后第一个同长度的串(指针只前进 → 线性)
  const runs = new Map<number, number[]>()
  for (let x = 0; x < n;) {
    if (v[x] !== '`') { x++; continue }
    let e = x
    while (v[e] === '`') e++
    const list = runs.get(e - x)
    if (list) list.push(x)
    else runs.set(e - x, [x])
    x = e
  }
  const ptr = new Map<number, number>()
  const closerOf = (len: number, from: number): number => {
    const list = runs.get(len)
    if (!list) return -1
    let k = ptr.get(len) ?? 0
    while (k < list.length && list[k] < from) k++
    ptr.set(len, k)
    return k < list.length ? list[k] : -1
  }
  const miss: Record<string, number> = {} // 某种 HTML 收尾在 x 之后已找不到:之后的同类起手不再重扫
  const findFrom = (key: string, needle: string, from: number): number => {
    if (miss[key] !== undefined && from >= miss[key]) return -1
    const e = v.indexOf(needle, from)
    if (e === -1) miss[key] = from
    return e
  }
  const htmlEnd = (x: number): number => {
    if (v.startsWith('<!--', x)) {
      if (v.startsWith('<!-->', x)) return x + 5
      if (v.startsWith('<!--->', x)) return x + 6
      const e = findFrom('c', '-->', x + 4)
      return e === -1 ? -1 : e + 3
    }
    if (v.startsWith('<?', x)) { const e = findFrom('p', '?>', x + 2); return e === -1 ? -1 : e + 2 }
    if (v.startsWith('<![CDATA[', x)) { const e = findFrom('d', ']]>', x + 9); return e === -1 ? -1 : e + 3 }
    if (v[x + 1] === '!' && /[A-Za-z]/.test(v[x + 2] ?? '')) { const e = findFrom('b', '>', x + 2); return e === -1 ? -1 : e + 1 }
    AUTOLINK.lastIndex = x
    if (AUTOLINK.test(v)) return AUTOLINK.lastIndex
    INLINE_TAG.lastIndex = x
    if (INLINE_TAG.test(v)) return INLINE_TAG.lastIndex
    return -1
  }
  const stack: Array<{ x: number; image: boolean }> = []
  let inactiveBelow = 0 // 栈里下标 < 它的 `[` 已失效(里面成了链接;`![` 不失效,同 CommonMark)
  for (let x = 0; x < n;) {
    const c = v[x]
    if (c === '`') {
      let s = x
      if (esc(x)) s = x + 1 // 转义只吃掉第一个反引号,剩下的照常成串
      let e = x
      while (v[e] === '`') e++
      if (e - s > 0) {
        const close = closerOf(e - s, e)
        if (close !== -1) { maskV(s, close + (e - s)); x = close + (e - s); continue }
      }
      x = e
      continue
    }
    if (c === '<' && !esc(x)) {
      const e = htmlEnd(x)
      x = e === -1 ? x + 1 : e
      continue
    }
    if (c === '[' && !esc(x)) {
      if (v[x + 1] === '^' && notes.size) {
        const fn = /^\[\^([^\]\s]{1,999})\]/.exec(v.slice(x, x + 1004))
        if (fn && notes.has(normLabel(fn[1]))) { x += fn[0].length; continue } // 脚注引用
      }
      stack.push({ x, image: x > 0 && v[x - 1] === '!' && !esc(x - 1) })
      x++
      continue
    }
    if (c === ']' && !esc(x) && stack.length) {
      const k = stack.length - 1
      const op = stack.pop()!
      const inactive = k < inactiveBelow && !op.image
      inactiveBelow = Math.min(inactiveBelow, stack.length)
      if (inactive) { x++; continue }
      let end = -1
      if (v[x + 1] === '(') {
        const close = linkTailEnd(v, x + 2)
        if (close !== -1) { maskV(x + 2, close); end = close + 1 }
      }
      if (end === -1 && labels.size) {
        // 链接文字当标签(collapsed `[t][]` / shortcut `[t]`):标签最长 999 字、不含未转义的方括号 —— 先按长度挡,
        // 别对整段文字切片(成串的 `[` + `][]` 会变成平方级)
        const textLabel = (): string | null => {
          if (x - op.x - 1 > 999) return null
          const text = v.slice(op.x + 1, x)
          return /(^|[^\\\u0000])[[\]]/.test(text) ? null : text
        }
        const lab = v[x + 1] === '[' ? /^\[((?:[^\\[\]\u0000]|[\\\u0000][\s\S]){0,999})\]/.exec(v.slice(x + 1, x + 1003)) : null
        if (lab) {
          const key = lab[1].trim() ? lab[1] : textLabel()
          if (key !== null && labels.has(normLabel(key))) end = x + 1 + lab[0].length
        } else {
          const key = textLabel()
          if (key !== null && labels.has(normLabel(key))) end = x + 1
        }
      }
      if (end === -1) { x++; continue }
      if (!op.image) inactiveBelow = stack.length
      x = end
      continue
    }
    x++
  }
}

/** md 里「不算公式」的区域抹成等长空格(偏移不变)。导出供单测。 */
export function maskNonMath(md: string): string {
  const a = md.split('')
  const { segs, labels, notes } = scanBlocks(md, a)
  for (const seg of segs) scanInline(md, seg, a, labels, notes)
  return a.join('')
}

/** 一段 markdown **原文**里的公式跨度(偏移相对 md)—— 落盘反转义与解析补反斜杠**共用这一份**,别再各写一套。
 *  R-01 返修(评审 2026-09-27):读侧曾按 PM 视图认公式(行内代码抹空、链接地址不计、mark 定界符不计),写侧按原文认;
 *  `` `$HOME` `` / `[a](http://x/?$b)` 里的 `$` 让两侧配出不同的对 —— 读侧补了反斜杠、写侧不还原,每存一次翻一倍。
 *  两侧都在「原文」上用这一个函数,认出的跨度就一致(写侧的原文 = 序列化结果,与打开时的原文逐字相同)。
 *  代码 / 链接地址按 Markdown 解析的口径排除(maskNonMath):两侧照样同一口径,而且代码里的 `\_` 不再被当公式反转义删掉。
 *  ponytail: 公式旁的 `\$` 仍按 `$` 参与配对(读侧见 restoreMathEscapes 的 view;写侧看到的是序列化器翻倍后的形态,
 *  两侧对「被转义」的判据对不齐,改了反而让 `$a\\$` 这类合法公式认不出)。 */
export function mdMathSpans(md: string): MathSpan[] {
  if (md.indexOf('$') === -1) return []
  const masked = maskNonMath(md)
  return scanMath(masked).map((sp) => (sp.display ? { ...sp, latex: md.slice(sp.from + 2, sp.to - 2).trim() } : { ...sp, latex: md.slice(sp.from + 1, sp.to - 1) }))
}

/** 落盘前把 remark 在 $…$/$$…$$ 里加的反斜杠转义抹掉,让公式按原文持久化(对齐 Obsidian/remark-math)。
 *  math 现是纯文本节点,序列化经 mdast-util-to-markdown **只在「反斜杠后紧接 ASCII 标点」时**加/翻倍转义
 *  (x_i→x\_i、a*b→a\*b、\{→\\{;而 \sum、\begin 这类「反斜杠后接字母」的**原样不动**,\\ 换行也只把首个反斜杠翻倍 → \\\ )。
 *  所以只能反转「\标点→标点」;**绝不能**用 \X→X 盲删——那会把 \sum→sum、\begin→begin、\\→\ 一起吞掉,
 *  命令名和 \\ 换行全丢 → 矩阵/数组(\begin{array}…\hline)当场炸。字符类同 mdast escapeBackslashes 的 [!-/:-@[-`{-~]。
 *  跨度由 mdMathSpans 给(围栏代码块跳过——块内的 $…$ 不是公式,反转义会破坏代码里的 \n 等序列)。 */
export function unescapeMathSource(md: string): string {
  if (md.indexOf('$') === -1) return md
  const masked = maskNonMath(md)
  const spans = scanMath(masked)
  if (!spans.length) return md
  let out = ''
  let last = 0
  for (const sp of spans) {
    // 公式跨度里夹着的行内代码 / 地址(已被抹空)原样保留:只反转义未被抹掉的「\标点」。
    out += md.slice(last, sp.from) + md.slice(sp.from, sp.to).replace(/\\([!-/:-@[-`{-~])/g, (all, ch: string, off: number) =>
      masked[sp.from + off] === '\\' ? ch : all)
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
/** 公式体之外的转义:text.value 里的下标(已计入公式补回的反斜杠)。literalEscape.ts 据此拆出转义字面(D-11)。 */
export const LITERAL_ESCAPES = 'amadeusLiteralEscapes'

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
  texts.forEach((n, i) => {
    const ks: number[] = []
    const lit: number[] = []
    for (const [k, at] of recs[i]) {
      if (bodies.some(([from, to]) => at - 1 >= from && at < to)) ks.push(k)
      else lit.push(k)
    }
    let v: string = n.value
    for (const k of [...ks].sort((a, b) => b - a)) v = v.slice(0, k) + '\\' + v.slice(k)
    n.value = v
    // 公式外的转义留给 literalEscape.ts(D-11):下标顺移公式里补回的反斜杠数。
    if (lit.length) (n.data ||= {})[LITERAL_ESCAPES] = lit.map((k) => k + ks.filter((x) => x < k).length)
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

const mathKey = new PluginKey('amadeus-math-live-preview')

/** 渲染后的公式要包进的行内标记(背景色 / 文字色 / 下划线 / 删除线等):公式源码整段都带着的那几个。
 *  渲染件是挂在源码前的 widget,PM 缺省只给 side ≥ 0 的 widget 套后一段文字的标记;side -1 的拿不到 ——
 *  于是整段划了背景色,公式那块却是白底。链接、行内代码类标记不套:套上 `<a>` 点公式会跳走。 */
const WRAP_SKIP = /link|code/i
export function formulaMarks(doc: PMNode, from: number, to: number): readonly Mark[] {
  const acc: { marks: readonly Mark[] | null } = { marks: null }
  doc.nodesBetween(from, to, (n) => {
    if (!n.isInline) return true
    acc.marks = acc.marks === null ? n.marks : acc.marks.filter((m) => m.isInSet(n.marks))
    return false
  })
  return (acc.marks ?? []).filter((m) => !WRAP_SKIP.test(m.type.name))
}
const marksKey = (marks: readonly Mark[]): string => marks.map((m) => `${m.type.name}${JSON.stringify(m.attrs)}`).join('|')

type MathRange = { from: number; to: number }

function collectMathDecorations(doc: PMNode, selection: MathRange | null, from: number, to: number, decos: Decoration[]): void {
  const selFrom = selection?.from ?? -1
  const selTo = selection?.to ?? -1
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true
    if (node.type.spec.code) return false // 代码块内不渲染公式
    const cs = pos + 1
    const s = buildBlockString(node)
    if (s.indexOf('$') === -1) return false
    const spans = scanMath(s)
    if (!spans.length) return false
    for (const sp of spans) {
      const inside = selectionInside(selFrom, selTo, cs + sp.from, cs + sp.to, sp.display)
      const editing = selection !== null && (inside || (selFrom !== selTo && selFrom < cs + sp.to && selTo > cs + sp.from))
      if (editing) {
        // Whole source, `$` included: the public styling hook (monospace, italic, code size). PM merges it
        // into every text span of the formula, so selectors are `.math-source.math-source-x`, not descendants.
        // Never cut around the selection: the font must not jump while dragging a selection.
        decos.push(Decoration.inline(cs + sp.from, cs + sp.to, { class: 'math-source' }))
        for (const token of mathSourceHighlights(s.slice(sp.from, sp.to), cs + sp.from, { from: selFrom, to: selTo })) {
          decos.push(Decoration.inline(token.from, token.to, { class: token.className }))
        }
        // 只有光标 / 选区整个落在里面的那个公式出预览(选中占位时照常出,同 Obsidian);选区跨出公式不出。
        // 块公式的预览在源码下方;行内公式的预览是插件视图自己摆的浮层(InlineMathFloat),不走装饰。
        if (!inside || !sp.display) continue
        decos.push(Decoration.widget(cs + sp.to, (v, getPos) => renderMath(v, sp.latex, true, getPos, true), {
          side: 1,
          ignoreSelection: true,
          key: `p:b:${sp.latex}`, // 不带位置(P-04):预览不读位置,内容相同即可复用
        }))
        continue
      }
      const from = cs + sp.from
      const to = cs + sp.to
      const { latex, display } = sp
      decos.push(Decoration.inline(from, to, { class: 'math-src-hidden' }))
      // ⚠️ key **不带位置**(评审 P-04):带上 from 的话,文首打一个字,下游每个公式的 key 都变,PM 把它们
      //    整批销毁重建、逐个重跑 KaTeX(120 个公式每键 ~78ms)。位置改由 widget 的 getPos 在点击时现算。
      // 行内公式套上源码的标记(背景色划线要连公式一起);块公式独占一块,不套。行内的一律显式给 marks(交集空也给 []):
      // 不给的话 side -1 的 widget 沿用前一段文字的标记 —— `<mark>前文</mark>$x$` 里没划线的公式也被涂上底色(Codex 评审)。
      const marks = display ? [] : formulaMarks(node, sp.from, sp.to)
      decos.push(Decoration.widget(from, (v, getPos) => renderMath(v, latex, display, getPos), {
        side: -1,
        ignoreSelection: true,
        // 标记进 key:同一公式改了颜色要换一份 widget,PM 按 key 复用时不会重套标记。
        key: `m:${display ? 'b' : 'i'}:${latex}${marks.length ? `#${marksKey(marks)}` : ''}`,
        ...(display ? {} : { marks }),
      }))
      if (!display && to === cs + node.content.size) decos.push(inlinePreviewCaret(from, to, `math:${latex}`))
    }
    return false // 不深入内联
  })
}

// The selection changes how intersected formulas are displayed and how partially selected
// tokens are colored. A large common interior stays fully selected. Two distant carets
// affect only their own blocks, even when thousands of paragraphs separate them.
function changedSelectionRanges(old: MathRange | null, next: MathRange | null): MathRange[] {
  if (!old) return next ? [next] : []
  if (!next) return [old]
  if (old.to < next.from || next.to < old.from) return old.from < next.from ? [old, next] : [next, old]
  const ranges: MathRange[] = []
  if (old.from !== next.from) ranges.push({ from: Math.min(old.from, next.from), to: Math.max(old.from, next.from) })
  if (old.to !== next.to) ranges.push({ from: Math.min(old.to, next.to), to: Math.max(old.to, next.to) })
  return ranges
}

function affectedTextblocks(doc: PMNode, ranges: MathRange[]): MathRange[] {
  const blocks: MathRange[] = []
  for (const range of ranges) {
    const start = doc.resolve(range.from)
    const end = doc.resolve(range.to)
    const from = start.parent.isTextblock ? start.start() : range.from
    const to = end.parent.isTextblock ? end.end() : range.to
    const previous = blocks[blocks.length - 1]
    if (previous && previous.to >= from) previous.to = Math.max(previous.to, to)
    else blocks.push({ from, to })
  }
  return blocks
}

// Keep one persistent DecorationSet per mounted plugin. Reading the completed EditorState
// here also handles editors without the focus plugin and changing plugin order on reconfigure.
function cachedMathDecorations(): (state: EditorState) => DecorationSet {
  let doc: PMNode | null = null
  let previous: MathRange | null = null
  let formulaBlocks: MathRange | null = null
  let decorations = DecorationSet.empty
  return (state) => {
    const selection = editorFocused(state) ? state.selection : null
    if (state.doc === doc && previous?.from === selection?.from && previous?.to === selection?.to) return decorations
    if (state.doc !== doc) {
      const all: Decoration[] = []
      collectMathDecorations(state.doc, selection, 0, state.doc.content.size, all)
      // Blocks are visited in document order. Capture the bounds before create consumes the array.
      // Empty trailing paragraphs and container boundaries are outside these bounds.
      formulaBlocks = all.length ? {
        from: state.doc.resolve(all[0].from).start(),
        to: state.doc.resolve(all[all.length - 1].to).end(),
      } : null
      decorations = DecorationSet.create(state.doc, all)
      doc = state.doc
    } else if (formulaBlocks) {
      const ranges = changedSelectionRanges(previous, selection)
      for (const { from, to } of affectedTextblocks(doc, ranges)) {
        const fresh: Decoration[] = []
        collectMathDecorations(doc, selection, from, to, fresh)
        // Select-all (or collapsing it) replaces every decorated block. Removing and adding
        // thousands of entries first would walk the persistent decoration tree twice more.
        decorations = from <= formulaBlocks.from && to >= formulaBlocks.to
          ? DecorationSet.create(doc, fresh)
          : decorations.remove(decorations.find(from, to)).add(doc, fresh)
      }
    }
    previous = selection
    return decorations
  }
}

export function mathLivePreviewPlugin() {
  return $prose(
    () =>
      new Plugin({
        key: mathKey,
        props: {
          handleTextInput: (view, from, to, text) => mathDollarInput(view, from, to, text) || mathBracketInput(view, from, to, text),
          handleKeyDown: (view, event) => mathPairBackspace(view, event) || mathBracketBackspace(view, event) || inlinePreviewEdgeKeyDown(view, event),
          handleClick: (view, _pos, event) => inlinePreviewEdgeClick(view, event),
          // 失焦 → 全部渲染(每个 Amadeus 块独立编辑器:点别的块 = 本块失焦,公式即渲染)。焦点态读 editorFocus。
          decorations: cachedMathDecorations(),
        },
        view: (view) => new InlineMathFloat(view),
      }),
  )
}
