// LaTeX 实况预览(Obsidian 式):数学公式在文档里**始终是纯文本** `$…$` / `$$…$$`(零 schema、零序列化改动,
// .md 落盘原样),仅当光标**不在这一行**时用 ProseMirror 装饰把该行的公式渲染成 KaTeX;光标回到这一行 → 露出
// 源码可编辑。因此不再用 @milkdown/plugin-math 的原子节点(那套一敲完就变原子、无法再编辑)。
//
// 为什么用装饰而非节点:节点是原子,光标进不去、编辑=删了重打;装饰不动文档,源码就是原生文本,光标天然可编辑,
// 序列化/撤销/其它插件全部无感。每个 Amadeus 块是独立 Milkdown 编辑器、文档极小 → 每次选区变化重算装饰的开销可忽略。
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import katex from 'katex'
import 'katex/dist/katex.min.css'

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
      const msg = err.getAttribute('title') || 'LaTeX 无法渲染'
      el.replaceChildren()
      const badge = document.createElement('span')
      badge.className = 'math-error'
      badge.title = msg
      badge.textContent = display ? '⚠ 公式无法渲染' : '⚠'
      el.appendChild(badge)
    }
  } catch {
    el.textContent = display ? `$$${latex}$$` : `$${latex}$`
  }
}

/** 离行渲染(点击回到源码可编辑)。preview=true → 作「本行实况预览」:行内 $..$ 浮层在上方、块级 $$..$$ 渲染在下方,不拦鼠标(光标已在源码)。 */
function renderMath(view: EditorView, latex: string, display: boolean, srcFrom: number, preview = false): HTMLElement {
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
  // 点渲染结果 → 把光标塞进源码(srcFrom+1,即开 `$` 之后)并置焦,该行随即露出源码可编辑。
  el.addEventListener('mousedown', (e) => {
    if (!view.editable) return // 只读视图:点公式不进入编辑态(否则会闪出源码)
    e.preventDefault()
    const pos = Math.min(srcFrom + 1, view.state.doc.content.size)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)).setMeta(mathKey, { focus: true }))
    view.focus()
  })
  return el
}

/** 落盘前把 remark 在 $…$/$$…$$ 里加的反斜杠转义抹掉,让公式按原文持久化(对齐 Obsidian/remark-math)。
 *  math 现是纯文本节点,序列化经 mdast-util-to-markdown **只在「反斜杠后紧接 ASCII 标点」时**加/翻倍转义
 *  (x_i→x\_i、a*b→a\*b、\{→\\{;而 \sum、\begin 这类「反斜杠后接字母」的**原样不动**,\\ 换行也只把首个反斜杠翻倍 → \\\ )。
 *  所以只能反转「\标点→标点」;**绝不能**用 \X→X 盲删——那会把 \sum→sum、\begin→begin、\\→\ 一起吞掉,
 *  命令名和 \\ 换行全丢 → 矩阵/数组(\begin{array}…\hline)当场炸。字符类同 mdast escapeBackslashes 的 [!-/:-@[-`{-~]。
 *  先按 ``` 围栏切出代码块跳过——块内的 $…$ 不是公式,反转义会破坏代码里的 \n 等序列。 */
export function unescapeMathSource(md: string): string {
  if (md.indexOf('$') === -1) return md
  const parts = md.split(/(^```[\s\S]*?^```[^\n]*$)/m) // 偶数下标=非代码,奇数=围栏代码块(原样保留)
  return parts
    .map((part, idx) => {
      if (idx % 2 === 1) return part
      const spans = scanMath(part)
      if (!spans.length) return part
      let out = ''
      let last = 0
      for (const sp of spans) {
        out += part.slice(last, sp.from) + part.slice(sp.from, sp.to).replace(/\\([!-/:-@[-`{-~])/g, '$1')
        last = sp.to
      }
      return out + part.slice(last)
    })
    .join('')
}

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
        decos.push(Decoration.widget(anchor, (v) => renderMath(v, sp.latex, sp.display, cs + sp.from, true), {
          side: sp.display ? 1 : -1,
          ignoreSelection: true,
          key: `p${cs + sp.from}:${sp.display ? 'b' : 'i'}:${sp.latex}`,
        }))
        continue
      }
      const from = cs + sp.from
      const to = cs + sp.to
      const { latex, display } = sp
      decos.push(Decoration.inline(from, to, { class: 'math-src-hidden' }))
      decos.push(Decoration.widget(from, (v) => renderMath(v, latex, display, from), {
        side: -1,
        ignoreSelection: true,
        key: `m${from}:${display ? 'b' : 'i'}:${latex}`,
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
