// Callout 渲染:blockquote 首行以 `[!type]`(可带 +/- 折叠符)开头 → Obsidian 式着色标注。
// ProseMirror 装饰 + 定向标题分段；不改 schema，落盘仍是原生 Obsidian callout 语法。
// 折叠块标题直接编辑，令牌通过源码按钮编辑；有色标注沿用双击源码入口。
// 折叠([!x]-)已实现:收起只留首行,chevron 切换 = 改写 token 里的 +/- 字符(状态即 md,跨端一致)。

import { $prose, $remark } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection, type Selection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import type { EditorState } from '@milkdown/kit/prose/state'
import type { ResolvedPos, Node as PMNode } from '@milkdown/kit/prose/model'
import { registerMessages, translate } from '../../../i18n'
import { splitParagraph } from './softBreak'
import { FOLD_TOKEN } from './blockTriggers'

registerMessages({
  'mdcallout.expand': { zh: '展开', en: 'Expand' },
  'mdcallout.collapse': { zh: '折叠', en: 'Collapse' },
  'mdcallout.title': { zh: '折叠标题', en: 'Toggle title' },
  'mdcallout.empty': { zh: '空折叠块，点击添加内容', en: 'Empty toggle. Click to add content.' },
  'mdcallout.source': { zh: '编辑折叠源码', en: 'Edit toggle source' },
})

// Obsidian callout 的第一行就是标题；只在读取时拆开这一个段落，不改变普通 Markdown 的软换行。
// 序列化树没有 position，不能在写侧重复拆分（Shift+Enter 仍是段内换行）。
type CalloutAst = { type: string; value?: string; children?: CalloutAst[]; position?: unknown }
export function splitCalloutTitle(tree: CalloutAst): void {
  const first = tree.children?.[0]
  if (tree.type === 'blockquote' && first?.type === 'paragraph' && first.position
    && /^\[![a-z]+\][+-]?/i.test(first.children?.[0]?.value ?? '')) {
    const parts: CalloutAst[] = splitParagraph(first)
    if (parts.length > 1) tree.children!.splice(0, 1, ...parts)
  }
  tree.children?.forEach(splitCalloutTitle)
}
export const calloutTitleRemark = $remark('amadeusCalloutTitle', () => () => splitCalloutTitle)

/**
 * 落盘前把 callout 令牌的 `\[` 还原成 `[`。
 *
 * remark 序列化会把行首的 `[` 转义成 `\[`(防被读成链接引用),于是 `> [!note]- 标题` 落盘成
 * `> \[!note]- 标题`:Amadeus 自己读回来没问题(`\[` 解析后还是 `[`),但 **Obsidian 不认**,
 * 而「Obsidian 里原生可折叠」正是选这套落盘格式的全部理由。
 *
 * ⚠️ 为什么不走 toMarkdownExtensions 的 handlers.text:Milkdown 自己也注册了一个 text handler,
 * 且排在所有 remark 扩展之后 —— 后者恒胜,我们的永远不会被调用(2026-07-29 真浏览器取证:
 * 换成 paragraph handler 能进,text 进不去)。故沿用本文件既有的「落盘前去转义」路子
 * (同 unescapeWikiOutsideFences / unescapeMathSource)。
 *
 * 只认**引用行行首**的令牌,普通段落里的 `\[` 一概不动 —— 那里的转义是必要的。
 */
export const unescapeCalloutToken = (md: string): string =>
  md.replace(/^((?:[ \t]*>[ \t]?)+)\\\[!/gm, '$1[!')

// ⚠️ 这条正则**漏过 `]`**(`\[!([a-zA-Z]+)([+-])?`),于是 `[!note]- 标题` 里 `note` 之后遇到 `]` 直接不匹配
// —— callout 整个功能从来没生效过(2026-07-29 真浏览器取证:blockquote 的 class 恒为空)。
// 顺手放宽尾部:标题紧跟在 `-` 后面(`[!fold]-标题`)也认,Obsidian 同样接受;而且 contenteditable
// 会把行尾那个空格吃掉,不放宽的话「敲 `>` 生成令牌 → 一打字就不是 callout 了」。
const CALLOUT_RE = /^\[!([a-zA-Z]+)\]([+-])?/

// 令牌之后才是标题;标题自己还能带块级前缀:`## ` → 按 H2 排版,`- ` → 项目符号。
// 纯装饰(落盘仍是 Obsidian 的单行 callout,折叠跨端不坏),故 `##` 不进 schema、不变成真 heading 节点。
const TITLE_MARK_RE = /^(#{1,6}|[-*+]) /

/** blockquote 是不是 callout;是则给出类型/折叠符/首段/标题前缀。marker: '+' | '-' | undefined */
function calloutOf(node: PMNode) {
  if (node.type.name !== 'blockquote') return null
  const first = node.firstChild
  const m = first && first.isTextblock ? CALLOUT_RE.exec(first.textContent) : null
  if (!m || !first) return null
  // 令牌与标题之间那个空格跟着令牌一起藏,否则隐藏后标题左边凭空空一格
  const gap = /[ \u00a0]/.test(first.textContent[m[0].length] ?? '') ? 1 : 0
  const mk = TITLE_MARK_RE.exec(first.textContent.slice(m[0].length + gap))
  return {
    type: m[1].toLowerCase(),
    marker: m[2] as '+' | '-' | undefined,
    token: m[0],
    hideLen: m[0].length + gap, // 隐藏范围(含那个空格)比徽章范围长
    first,
    mark: mk
      ? { at: m[0].length + gap, len: mk[0].length, cls: mk[1][0] === '#' ? `h${mk[1].length}` : 'bullet' }
      : null,
  }
}

/**
 * 某个位置所在的 callout(往上找最近的 blockquote 祖先)。
 * headEnd = 首段(标题行)末尾;markerPos = `]` 后那个 +/- 字符的位置。
 */
function calloutAt($pos: ResolvedPos, hiddenAncestor = false) {
  for (let i = 1; i <= $pos.depth; i++) {
    const d = hiddenAncestor ? i : $pos.depth + 1 - i
    const node = $pos.node(d)
    if (node.type.name !== 'blockquote') continue
    const c = calloutOf(node)
    if (!c) continue
    const bqStart = $pos.start(d) // blockquote 内容起点
    const inHead = $pos.pos < bqStart + c.first.nodeSize
    if (hiddenAncestor && (c.marker !== '-' || inHead)) continue
    return {
      ...c,
      node,
      marker: c.marker,
      collapsed: c.marker === '-',
      bqPos: $pos.before(d), // blockquote 本身那一位(源码态就以它为身份)
      bqStart,
      afterBq: $pos.after(d), // blockquote 之后那一位
      headEnd: bqStart + 1 + c.first.content.size,
      inHead,
      markerPos: bqStart + 1 + c.type.length + 3,
      /** 标题行里被藏起来的语法段(令牌、`## `/`- ` 前缀),文档绝对位 */
      hidden: [
        [bqStart + 1, bqStart + 1 + c.hideLen] as [number, number],
        ...(c.mark ? [[bqStart + 1 + c.mark.at, bqStart + 1 + c.mark.at + c.mark.len] as [number, number]] : []),
      ],
    }
  }
  return null
}

const collapsedCalloutAt = ($pos: ResolvedPos) => {
  const c = calloutAt($pos)
  return c && c.collapsed ? c : null
}

const SCROLL_BUFFER = '--amx-fold-scroll-buffer'
const scrollBuffer = (pane: HTMLElement): number => parseFloat(pane.style.getPropertyValue(SCROLL_BUFFER)) || 0
const setScrollBuffer = (pane: HTMLElement, px: number): void => {
  pane.style.setProperty(SCROLL_BUFFER, `${Math.max(0, Math.ceil(px))}px`)
}

/**
 * 页面滚到末尾时，正文收起会缩小 scrollHeight，浏览器先夹掉 scrollTop，整页一起跳。
 * 在滚动容器末尾补足刚收起的高度，并随展开动画逐帧结算；向上滚动时释放余量。
 */
const foldScrollJobs = new WeakMap<HTMLElement, () => void>()
const foldBufferListeners = new WeakMap<HTMLElement, () => void>()
function holdFoldViewport(pane: HTMLElement, change: () => void): void {
  foldScrollJobs.get(pane)?.()
  foldBufferListeners.get(pane)?.()
  const top = pane.scrollTop
  const minHeight = top + pane.clientHeight
  // 先给足临时余量，再改文档；否则浏览器会在 dispatch 内同步夹掉 scrollTop。
  setScrollBuffer(pane, scrollBuffer(pane) + pane.scrollHeight)
  change()
  let raf = 0
  let active = true
  const started = performance.now()
  const trim = (): void => {
    const natural = pane.scrollHeight - scrollBuffer(pane)
    const needed = Math.max(0, pane.scrollTop + pane.clientHeight - natural)
    if (needed < scrollBuffer(pane)) setScrollBuffer(pane, needed)
    if (!scrollBuffer(pane)) {
      pane.removeEventListener('scroll', trim)
      foldBufferListeners.delete(pane)
    }
  }
  const armTrim = (): void => {
    trim()
    if (scrollBuffer(pane)) {
      pane.addEventListener('scroll', trim, { passive: true })
      foldBufferListeners.set(pane, () => {
        pane.removeEventListener('scroll', trim)
        foldBufferListeners.delete(pane)
      })
    }
  }
  const unlisten = (): void => {
    pane.removeEventListener('wheel', release)
    pane.removeEventListener('touchmove', release)
    pane.removeEventListener('keydown', release)
  }
  const settle = (): void => {
    const current = scrollBuffer(pane)
    const natural = pane.scrollHeight - current
    setScrollBuffer(pane, Math.max(0, minHeight - natural))
    pane.scrollTop = top
    if (active && performance.now() - started < 260) raf = requestAnimationFrame(settle)
    else {
      unlisten()
      foldScrollJobs.delete(pane)
      armTrim()
    }
  }
  const release = (): void => {
    if (!active) return
    active = false
    cancelAnimationFrame(raf)
    unlisten()
    foldScrollJobs.delete(pane)
    requestAnimationFrame(() => { if (!foldScrollJobs.has(pane)) armTrim() })
  }
  foldScrollJobs.set(pane, release)
  pane.addEventListener('wheel', release, { passive: true, once: true })
  pane.addEventListener('touchmove', release, { passive: true, once: true })
  pane.addEventListener('keydown', release, { once: true })
  settle()
}

/** 切折叠 = 改写 token 里的 +/- 字符(状态即 md,Obsidian 同语义、跨端一致) */
let foldAnimationId = 0
function toggleFold(view: EditorView, c: { marker?: string; collapsed: boolean; markerPos: number; bqPos: number }) {
  const fold = view.state.doc.nodeAt(c.bqPos)
  const isFold = !!fold && calloutOf(fold)?.type === 'fold'
  const animationId = isFold ? ++foldAnimationId : 0
  if (isFold) {
    view.dispatch(view.state.tr.setMeta(calloutKey, { foldStart: { at: c.bqPos, id: animationId } } satisfies CalloutMeta))
    const beforeDom = view.nodeDOM(c.bqPos)
    // 展开时必须先让 display:none 的子块以高度 0 进入布局，再改 marker 才有插值起点。
    if (beforeDom instanceof HTMLElement) void beforeDom.offsetHeight
  }
  const change = (): void => {
    const tr = view.state.tr
    view.dispatch(
      c.marker
        ? tr.insertText(c.collapsed ? '+' : '-', c.markerPos, c.markerPos + 1)
        : tr.insertText('-', c.markerPos, c.markerPos),
    )
  }
  const pane = view.dom.closest<HTMLElement>('.amx-pane.amx-editor')
  if (c.marker && pane) holdFoldViewport(pane, change)
  else change()
  if (isFold) setTimeout(() => {
    if (view.dom.isConnected)
      view.dispatch(view.state.tr.setMeta(calloutKey, { foldEnd: animationId } satisfies CalloutMeta))
  }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 230)
}

/** PM 的同一文档位置可以落在字号为 0 的令牌末尾，也可以落在可见标题首字前。
 * 前者会画出 0 高原生光标，自绘光标也读到令牌的底部；将 DOM 选区规范到可见文字。
 */
function alignFoldTitleCaret(view: EditorView): void {
  const selection = view.state.selection
  if (!selection.empty || !view.hasFocus()) return
  const c = calloutAt(selection.$from)
  if (!c || c.type !== 'fold' || !c.inHead || calloutKey.getState(view.state)?.srcAt === c.bqPos) return
  if (selection.from !== c.hidden[c.hidden.length - 1][1]) return
  const domSelection = document.getSelection()
  const anchor = domSelection?.anchorNode
  const origin = anchor instanceof Element ? anchor : anchor?.parentElement
  if (!origin?.closest('.callout-syntax')) return
  const head = view.nodeDOM(c.bqStart)
  if (!(head instanceof HTMLElement)) return
  const walker = document.createTreeWalker(head, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    if (!node.textContent || node.parentElement?.closest('.callout-syntax,button')) continue
    if (view.posAtDOM(node, 0) !== selection.from) continue
    const range = document.createRange()
    range.setStart(node, 0)
    range.collapse(true)
    domSelection!.removeAllRanges()
    domSelection!.addRange(range)
    return
  }
}

/**
 * 「哪个 callout 正处在源码态」——存它的 blockquote 位置,随文档编辑映射。
 *
 * ⚠️ 不能改回「光标在标题行就露源码」那套(2026-07-31 两次实报):ProseMirror 的 selection 失焦后
 * **原地不动**,点过一次就永远露着;而折叠态的光标守卫又会主动把光标送进/送离标题行,于是
 * 从没点过的块也会自己把 `[!note]-` 亮出来。源码只由显式入口打开，与光标位置无关。
 *
 * 有色标注保留原交互；[!fold] 使用左侧按钮折叠、标题直接编辑、显式源码入口。
 * 有色标注的交互契约:
 *   · 标题行**整行单击** = 切折叠(不放光标)
 *   · **双击** = 露源码(第一下顺带切了一次折叠,刻意不抵消)
 *   · **本块失焦** = 收回源码态(每个 Amadeus 块是独立编辑器,点别的块即失焦)
 *   · 键盘走进标题行**不露**,方向键把藏起来的语法段整段跳过
 */
// export:统一实例 spike(amadeus/unified)需要在「光标离开 callout」时代为清 srcAt ——
// 每块一实例时代「本块失焦=收回」靠编辑器 blur,单实例里点别的段落不再触发 blur。
type CalloutState = { srcAt: number | null; animations: { at: number; id: number }[] }
type CalloutMeta = { srcAt?: number | null; foldStart?: { at: number; id: number }; foldEnd?: number }
export const calloutKey = new PluginKey<CalloutState>('amadeus-callout-src')

/** 在宿主的结构源码/通用引用键位之前处理折叠标题，避免退格删坏隐藏令牌。 */
export function handleFoldKeyDown(view: EditorView, event: KeyboardEvent): boolean {
  if (!view.editable || event.isComposing) return false
  const { state } = view
  const c = calloutAt(state.selection.$from)
  if (!c || c.type !== 'fold' || !c.inHead || calloutKey.getState(state)?.srcAt === c.bqPos) return false
  const start = c.hidden[c.hidden.length - 1][1]
  if (event.key === 'Home' || (event.key === 'ArrowLeft' && event.metaKey)) {
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, event.shiftKey ? Math.max(start, state.selection.anchor) : start, start)))
    alignFoldTitleCaret(view)
    return true
  }
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false
  if (event.key === 'ArrowLeft' && state.selection.empty && state.selection.from <= start) {
    const before = TextSelection.near(state.doc.resolve(c.bqPos), -1)
    if (before.from < c.bqPos) view.dispatch(state.tr.setSelection(before))
    return true
  }
  if (event.key === 'Backspace' && state.selection.empty && state.selection.from <= start) {
    const children: PMNode[] = [state.schema.nodes.paragraph.create(null, c.first.content.cut(start - c.bqStart - 1))]
    c.node.forEach((node, _offset, index) => { if (index > 0) children.push(node) })
    const tr = state.tr.replaceWith(c.bqPos, c.afterBq, children)
    view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(c.bqPos + 1))).scrollIntoView())
    return true
  }
  if (event.key === 'Enter' && state.selection.$from.sameParent(state.selection.$to)) {
    const tr = state.tr.deleteSelection()
    if (c.marker !== '+') tr.insertText('+', c.markerPos, c.markerPos + (c.marker ? 1 : 0))
    const at = Math.max(tr.selection.from, tr.mapping.map(start))
    tr.split(at, 1, [{ type: state.schema.nodes.paragraph }])
    view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(at + 2))).scrollIntoView())
    return true
  }
  return false
}

/** 语法字符藏着时,方向键把它当一个整体跳过 —— 否则光标停在看不见的字里,打字位置发玄。 */
function skipHidden(state: EditorState, next: number, dir: 1 | -1): number | null {
  const size = state.doc.content.size
  if (next < 0 || next > size) return null
  const $n = state.doc.resolve(next)
  const c = calloutAt($n)
  if (!c || calloutKey.getState(state)?.srcAt === c.bqPos) return null // 源码态:语法字符看得见,别跳
  for (const [a, b] of c.hidden) if (next > a && next < b) return dir > 0 ? b : a
  return null
}

export function calloutPlugin() {
  return $prose(
    () =>
      new Plugin<CalloutState>({
        key: calloutKey,
        state: {
          init: () => ({ srcAt: null, animations: [] }),
          apply: (tr, value) => {
            const m = tr.getMeta(calloutKey) as CalloutMeta | undefined
            let animations = value.animations.map((a) => ({ ...a, at: tr.mapping.map(a.at) }))
            if (m?.foldStart) animations = [...animations.filter((a) => a.at !== m.foldStart!.at), m.foldStart]
            if (m?.foldEnd) animations = animations.filter((a) => a.id !== m.foldEnd)
            if (m && 'srcAt' in m) return { srcAt: m.srcAt ?? null, animations }
            // 没有显式改动就跟着文档编辑漂(在源码态里打字,位置会前后挪)
            if (value.srcAt === null) return { srcAt: null, animations }
            const at = tr.mapping.map(value.srcAt)
            const node = tr.doc.nodeAt(at)
            return { srcAt: node && calloutOf(node) && tr.selection.from > at && tr.selection.to < at + node.nodeSize ? at : null, animations }
          },
        },
        /**
         * 折叠区 = 光标不可达区。内容只是高度归零,骗得过眼睛骗不过 ProseMirror:光标照样能落进去
         * (点标题行文字右侧的空白、折叠时光标本来就在内容里、方向键、加载时自动聚焦),
         * 于是「打字打进虚空」。一条守卫收口所有入口。
         *
         * [!fold] 回到可见标题末；有色标注保留向后越过整块的语义。
         * ⚠️ 只管空光标 —— 跨隐藏区的选区(Meta+A 全选删除)是合法的,别破坏。
         */
        appendTransaction(_trs, _old, state) {
          const sel = state.selection
          if (!sel.empty) return null
          const head = calloutAt(sel.$from)
          if (head?.type === 'fold' && head.inHead && calloutKey.getState(state)?.srcAt !== head.bqPos) {
            const visibleStart = head.hidden[head.hidden.length - 1][1]
            if (sel.from < visibleStart) return state.tr.setSelection(TextSelection.create(state.doc, visibleStart))
          }
          const c = calloutAt(sel.$from, true)
          if (!c) return null
          // 用户主动收起时留在标题，继续编辑的位置可预测；嵌套折叠取最外层可见标题。
          if (c.type === 'fold') return state.tr.setSelection(TextSelection.create(state.doc, c.headEnd))
          const outside = (s: Selection): boolean => s.from < c.bqStart || s.from >= c.afterBq
          const fwd = TextSelection.near(state.doc.resolve(Math.min(c.afterBq, state.doc.content.size)), 1)
          if (outside(fwd)) return state.tr.setSelection(fwd)
          const back = TextSelection.near(state.doc.resolve(Math.max(c.bqStart - 1, 0)), -1)
          if (outside(back)) return state.tr.setSelection(back)
          // 整篇文档就这一个折叠 callout,前后都无处可去 → 只能停在标题行末(此时露出语法字符是诚实的)。
          return state.tr.setSelection(TextSelection.create(state.doc, c.headEnd))
        },
        props: {
          // 本块失焦 → 退出源码态(每个 Amadeus 块是独立编辑器,点别的块即失焦)。
          handleDOMEvents: {
            blur: (view) => {
              if (calloutKey.getState(view.state)?.srcAt !== null)
                view.dispatch(view.state.tr.setMeta(calloutKey, { srcAt: null }))
              return false
            },
          },
          handleKeyDown(view, event) {
            if (handleFoldKeyDown(view, event)) return true
            // 语法字符藏着时,←/→ 把它整段跳过(否则光标停在看不见的字里)
            if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.shiftKey) {
              const sel = view.state.selection
              if (sel.empty) {
                const dir = event.key === 'ArrowRight' ? 1 : -1
                const to = skipHidden(view.state, sel.from + dir, dir)
                if (to !== null) {
                  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, to)))
                  return true
                }
              }
              return false
            }
            /** 折叠态按 Enter:新段落会被藏起来(光标进虚空),故先展开再让默认换行照常走。 */
            if (event.key !== 'Enter' || event.isComposing) return false
            const c = collapsedCalloutAt(view.state.selection.$from)
            if (!c) return false
            // '-' → '+' 等长替换:光标位置不受映射影响,后续 keymap 拿到的就是展开后的 state。
            view.dispatch(view.state.tr.insertText('+', c.markerPos, c.markerPos + 1))
            return false
          },
          /** 按 Obsidian 习惯逐字敲 `> [!note] 标题`(K-13):`> ` 已按折叠键位写下 `[!fold]-`,接着敲出的
           *  `[!x]` 就是用户要的类型令牌 —— 它一成形就替掉那枚自动令牌,否则落成 `[!fold]-\[!note] 标题`。
           *  只在打字(含输入法提交)完成 `]` 的那一下判,不改 `>` 键位。 */
          handleTextInput(view, from, to, text) {
            if (!text.includes(']')) return false
            const { state } = view
            const $f = state.doc.resolve(from)
            if (!$f.parent.isTextblock || $f.depth < 2 || !$f.sameParent(state.doc.resolve(to))) return false
            if ($f.node(-1).type.name !== 'blockquote' || $f.index(-1) !== 0) return false
            const start = $f.start()
            const para = $f.parent
            const next = para.textBetween(0, from - start, undefined, '\ufffc') + text + para.textBetween(to - start, para.content.size, undefined, '\ufffc')
            if (!next.startsWith(FOLD_TOKEN) || !CALLOUT_RE.test(next.slice(FOLD_TOKEN.length))) return false
            view.dispatch(state.tr.insertText(text, from, to).delete(start, start + FOLD_TOKEN.length).scrollIntoView())
            return true
          },
          /** 折叠标题单击编辑；有色标注标题仍切折叠。源码态都按普通文本定位。 */
          handleClick(view, pos) {
            const c = calloutAt(view.state.doc.resolve(pos))
            if (!c || !c.inHead) return false
            if (calloutKey.getState(view.state)?.srcAt === c.bqPos) return false
            if (c.type === 'fold') {
              if (!view.editable) return false
              // 原生 selectionchange 比 click/keydown 晚一拍；显式落位避免紧接着 Enter 用旧行首位置。
              const at = Math.max(c.hidden[c.hidden.length - 1][1], Math.min(pos, c.headEnd))
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)))
              view.focus()
              alignFoldTitleCaret(view)
              return true
            }
            toggleFold(view, c)
            return true
          },
          /** 折叠标题双击保留原生选词；有色标注双击进入源码。 */
          handleDoubleClick(view, pos) {
            const c = calloutAt(view.state.doc.resolve(pos))
            if (!c || !c.inHead || c.type === 'fold') return false
            view.dispatch(view.state.tr.setMeta(calloutKey, { srcAt: c.bqPos }))
            return false // 让 ProseMirror 照常选中双击处的词
          },
          decorations(state: EditorState) {
            const decos: Decoration[] = []
            state.doc.descendants((node, pos) => {
              if (node.type.name !== 'blockquote') return true
              const c = calloutOf(node)
              if (c) {
                const { type, marker, token, hideLen, mark } = c
                const collapsed = marker === '-'
                const pluginState = calloutKey.getState(state)
                const inSrcMode = pluginState?.srcAt === pos
                decos.push(
                  Decoration.node(pos, pos + node.nodeSize, {
                    class: `callout callout-${type}${collapsed ? ' callout-collapsed' : ''}`,
                    'data-callout': type,
                    ...(pluginState?.animations.some((a) => a.at === pos) ? { 'data-fold-animating': '' } : {}),
                  }),
                )
                // [!type](+/-) 徽章(token 已含折叠符):blockquote 开(+1)+ 首段开(+1)= 文本起点 pos+2。
                decos.push(Decoration.inline(pos + 2, pos + 2 + token.length, { class: 'callout-token' }))
                // 标题排版(`## ` → H2 …)挂在首段上,**恒定**:随光标进出改字号会让整行跳一下。
                const headStart = pos + 1
                const headEnd = headStart + c.first.nodeSize
                if (type === 'fold') {
                  const empty = !inSrcMode && c.first.content.size === hideLen + (mark?.len ?? 0)
                  decos.push(Decoration.node(headStart, headEnd, {
                    class: 'callout-toggle-title',
                    ...(empty ? { 'data-placeholder': translate('mdcallout.title') } : {}),
                    ...(empty && state.selection.empty && state.selection.from === pos + 2 + c.first.content.size
                      ? { 'data-empty-caret': '' } : {}),
                  }))
                }
                if (mark) decos.push(Decoration.node(headStart, headEnd, { class: `callout-title-${mark.cls}` }))
                // 语法字符(令牌 + 标题前缀)只在显式进入源码态时露出。
                // ⚠️ 别改回「光标在标题行就露」,原因见 calloutKey 处的注释(两次实报都栽在那上面)。
                if (!inSrcMode) {
                  decos.push(Decoration.inline(pos + 2, pos + 2 + hideLen, { class: 'callout-syntax' }))
                  if (mark)
                    decos.push(
                      Decoration.inline(pos + 2 + mark.at, pos + 2 + mark.at + mark.len, {
                        class: `callout-syntax callout-syntax-${mark.cls}`,
                      }),
                    )
                }
                // 折叠 chevron:改写 token 的 +/- 字符 → 状态进 md(Obsidian 同语义)。
                // ']' 之后的位置 = pos+2 + '[!' + type + ']'。
                const markerPos = pos + 2 + type.length + 3
                // 折叠块按钮固定在行首；有色标注仍在标题文字之后。二者都必须挂在段落内。
                const chevronAt = type === 'fold' ? pos + 2 : pos + 2 + c.first.content.size
                decos.push(
                  Decoration.widget(
                    chevronAt,
                    (view) => {
                      const b = document.createElement('button')
                      // ⚠️ 类名不能叫 callout-fold —— 那是 `[!fold]` 类型加在 blockquote 上的类,
                      // 同名会让「chevron 旋转 90°」的规则命中整个引用块。
                      b.className = `callout-chevron${collapsed ? ' collapsed' : ''}`
                      b.type = 'button'
                      b.title = collapsed ? translate('mdcallout.expand') : translate('mdcallout.collapse')
                      b.setAttribute('aria-label', b.title)
                      b.setAttribute('aria-expanded', String(!collapsed))
                      b.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M5.5 3.8a.65.65 0 0 1 1.02-.53l5.3 3.67a1.3 1.3 0 0 1 0 2.12l-5.3 3.67a.65.65 0 0 1-1.02-.53z"/></svg>'
                      b.contentEditable = 'false'
                      b.addEventListener('mousedown', (e) => {
                        e.preventDefault()
                        e.stopPropagation()
                      })
                      const activate = (): void => {
                        const c = calloutAt(view.state.doc.resolve(pos + 2))
                        if (c?.bqPos === pos) toggleFold(view, c)
                      }
                      const focusCurrent = (): void => {
                        const head = view.nodeDOM(pos + 1) as HTMLElement | null
                        head?.querySelector<HTMLButtonElement>('.callout-chevron')?.focus()
                      }
                      b.addEventListener('keydown', (e) => {
                        if (e.key !== ' ' && e.key !== 'Enter') return
                        e.preventDefault()
                        e.stopPropagation()
                        // PM 会重建装饰所在的标题段落；keyup 结束后把焦点交给新按钮。
                        document.addEventListener('keyup', focusCurrent, { capture: true, once: true })
                        activate()
                      })
                      b.addEventListener('click', (e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        activate()
                        if ((e as MouseEvent).detail === 0) queueMicrotask(focusCurrent)
                      })
                      return b
                    },
                    // marker 是装饰身份的一部分，撤销/重做与源码编辑时也会重建带正确状态的按钮。
                    // 键盘触发后的焦点由 keyup 交给新按钮。
                    { side: type === 'fold' ? -1 : 1, ignoreSelection: true, stopEvent: () => true, key: `cf${pos}:${markerPos}:${marker ?? ''}` },
                  ),
                )
                if (type === 'fold') {
                  decos.push(Decoration.widget(headEnd - 1, (view) => {
                    const b = document.createElement('button')
                    b.type = 'button'
                    b.className = 'amx-src-btn callout-source'
                    b.contentEditable = 'false'
                    b.textContent = '</>'
                    b.title = translate('mdcallout.source')
                    b.setAttribute('aria-label', b.title)
                    if (!view.editable) b.style.display = 'none'
                    b.onmousedown = (e) => e.preventDefault()
                    b.onclick = (e) => {
                      e.preventDefault()
                      view.dispatch(view.state.tr.setMeta(calloutKey, { srcAt: pos })
                        .setSelection(TextSelection.create(view.state.doc, pos + 2)))
                      view.focus()
                    }
                    return b
                  }, { side: 1, stopEvent: () => true, key: `cs${pos}` }))
                  if (!collapsed && node.childCount === 1) decos.push(Decoration.widget(headEnd, (view) => {
                    const b = document.createElement('button')
                    b.type = 'button'
                    b.className = 'callout-empty'
                    b.contentEditable = 'false'
                    b.textContent = translate('mdcallout.empty')
                    if (!view.editable) b.style.display = 'none'
                    b.onmousedown = (e) => e.preventDefault()
                    b.onclick = () => {
                      const tr = view.state.tr.insert(headEnd, view.state.schema.nodes.paragraph.create())
                      view.dispatch(tr.setSelection(TextSelection.create(tr.doc, headEnd + 1)))
                      view.focus()
                    }
                    return b
                  }, { side: -1, stopEvent: () => true, key: `ce${pos}:${headEnd}` }))
                }
              }
              return true // 嵌套折叠各自保留开关与状态。
            })
            return decos.length ? DecorationSet.create(state.doc, decos) : null
          },
        },
      }),
  )
}
