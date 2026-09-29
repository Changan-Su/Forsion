/** 全局页内查找(Cmd/Ctrl+F):壳级浮条 + 活动 View 的 DOM 扫描 + CSS 自定义高亮。
 *
 *  为什么不再是 ProseMirror 装饰(原 amadeus/blocks/markdown/findInPage.ts,本轮删掉):
 *  那套只看得见 Milkdown 文档里的字,而应用里绝大多数可读文本压根不在 PM 文档里 ——
 *  嵌入卡 / 多维表卡 / 链接卡各是独立的 `createRoot` React 树,画布的白板元素、框标题、连线标签
 *  是 frontmatter 渲染出来的 DOM,其余三十多个 View 更是完全不沾 PM。**查找的正确层次是活动
 *  View 的 DOM,不是某一个编辑器的文档**;顺带把老实现的三个地址簿 bug 一并带走(嵌入卡全部
 *  共用字面量 blockId="uembed" 从不进 flatOrder、v4 页的 UNIFIED_FIND_ID 捷径会盖掉它们、
 *  flatOrder 只认活动 scope 所以分栏/仪表盘里的编辑器计数恒错)。
 *
 *  三条纪律,每条都是踩过或实测过的:
 *
 *  1. **匹配必须跨行内节点。** 老实现按 textblock 的 `node.textContent` 匹配,所以 `苹**果**`
 *     命中。逐个 text node 做 `indexOf` 会**静默**丢掉每一处被加粗/链接/行内码切开的命中 ——
 *     不报错、不崩,只是少一半结果。故按块把 text node 拼成一条串再匹配,块边界插 '\n'
 *     保证命中不跨块(查询串里不会有 '\n')。
 *
 *  2. **画高亮不许碰 DOM。** 用 CSS 自定义高亮(`CSS.highlights`):它只吃 Range,不插节点 ——
 *     往 React / ProseMirror 自己管的 DOM 里塞 `<mark>` 会当场打架(PM 直接判定外部改动)。
 *     代价:`::highlight()` 只认颜色类属性,老 `.amx-find-active` 那圈 outline 表达不了,
 *     改用对比色底。不支持这个 API 的浏览器不注册热键,让浏览器原生查找接管(见 findSupported)。
 *
 *  3. **绝不 `scrollIntoView`。** 实测(Electron 40.10.2 / Chromium 144):它会去推
 *     `overflow:hidden` 的容器 —— 画布舞台 `.amx-stage` 正是这种 —— 推完 measureCards 的命中
 *     判定永久错位,而且负方向被夹到 0 根本推不动。默认只写最近一个**真能滚**的祖先的
 *     scrollTop/scrollLeft;滚不动的面(画布拿 transform 当视口)自己听 `amx-reveal` 事件接管,
 *     `preventDefault()` 即表示「我接手了」。
 *
 *  **替换(C-18)**:查找仍是 DOM 扫描;能不能替换由**注册了 provider 的面**说了算(registerFindProvider)。
 *  provider 认领自己那块 DOM 里的命中,把「Range → 新文字」落成**一次可撤销**的编辑(UnifiedPage 的所见即所得
 *  映射成 PM 事务,源码 textarea 走 execCommand 保原生撤销栈)。没有 provider 的面(大多数 View、只读页、嵌入卡)
 *  照常查找、不给替换。textarea 的值不在文字节点里 —— textareaFindProvider 开条期间在它身上铺一层等宽镜像
 *  (透明字、同字体同折行),命中与高亮都落在镜像上,上面三条纪律原样适用。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { CaseSensitive, ChevronDown, ChevronRight, Regex, Replace, ReplaceAll } from 'lucide-react'
import { registerMessages, useI18n } from './i18n'
import './findInPage.css'

registerMessages({
  'find.placeholder': { zh: '在本页查找…', en: 'Find in page…' },
  'find.prev': { zh: '上一个（Shift+Enter）', en: 'Previous (Shift+Enter)' },
  'find.next': { zh: '下一个（Enter）', en: 'Next (Enter)' },
  'find.close': { zh: '关闭（Esc）', en: 'Close (Esc)' },
  'find.case': { zh: '区分大小写', en: 'Match case' },
  'find.regex': { zh: '使用正则表达式', en: 'Use regular expression' },
  'find.toggleReplace': { zh: '切换替换（⌘⌥F / Ctrl+Alt+F）', en: 'Toggle replace (⌘⌥F / Ctrl+Alt+F)' },
  'find.replacePlaceholder': { zh: '替换为…', en: 'Replace with…' },
  'find.replaceOne': { zh: '替换（Enter）', en: 'Replace (Enter)' },
  'find.replaceAll': { zh: '全部替换（⌘/Ctrl+Enter）', en: 'Replace all (⌘/Ctrl+Enter)' },
  'find.badRegex': { zh: '正则表达式无效', en: 'Invalid regular expression' },
})

/** 浏览器支不支持 CSS 自定义高亮。不支持就不抢 mod+f,交还给浏览器原生查找。 */
export const findSupported = typeof CSS !== 'undefined' && 'highlights' in CSS

interface FindState {
  open: boolean
  query: string
  /** 当前命中序号(0 基)。 */
  active: number
  total: number
  /** 开条那一刻定下的搜索根 —— 输入框 autoFocus 会把 activeElement 抢走,之后再推导必错。 */
  root: HTMLElement | null
  /** 区分大小写(缺省不区分,同老行为)。 */
  caseSensitive: boolean
  /** 正则模式:查询串按 JS 正则解释,替换串认 `$1` / `$&` / `$<名>` / `$$`。 */
  regex: boolean
  /** 正则写错了:计数显示 0,输入框标红(不抛、不清空)。 */
  bad: boolean
  replaceOpen: boolean
  replacement: string
  /** 命中里有多少条落在注册了 provider 的面里(= 可替换)。 */
  replaceable: number
  /** provider 注册表的版本号:面换了(切源码模式、换篇)要重新挂镜像、重扫。 */
  providerVer: number
}

/** 命中放模块级而不是 store:Range 数组每次扫描都换新,进 store 只会白白重渲整条浮条。 */
let hits: Range[] = []
/** 与 hits 对位的匹配组(正则替换展开 `$1` 用;字面模式只有 [0])。 */
let hitGroups: RegExpExecArray[] = []

export const useFind = create<FindState>(() => ({
  open: false,
  query: '',
  active: 0,
  total: 0,
  root: null,
  caseSensitive: false,
  regex: false,
  bad: false,
  replaceOpen: false,
  replacement: '',
  replaceable: 0,
  providerVer: 0,
}))

/* ── 替换 provider ─────────────────────────────────────────────────── */

export interface FindReplaceItem {
  range: Range
  /** 这条命中要换成的文字(正则的 `$1` 已展开)。 */
  text: string
}
export interface FindReplaceProvider {
  /** 这块面的 DOM 锚:它在搜索根里,这个 provider 才生效。 */
  el: HTMLElement
  /** 这个节点里的命中归不归它替换;缺省 = el.contains(node)。 */
  owns?: (node: Node) => boolean
  /** 查找条开着期间挂上的准备工作(textarea 在这里铺镜像),返回收尾函数。 */
  attach?: () => () => void
  /** 把这些命中(文档序)换掉,**一次可撤销**;返回实际换掉的条数(对不上原文的跳过)。 */
  replace: (items: FindReplaceItem[]) => number
  /** Esc 收条时把焦点与选区落到这条命中上(命中不在真文字里时用,如 textarea 镜像);返回是否接手。 */
  focusAt?: (range: Range) => boolean
}
const providers = new Set<FindReplaceProvider>()
const bumpProviders = (): void => useFind.setState((s) => ({ providerVer: s.providerVer + 1 }))

/** 注册一块可替换的面(UnifiedPage 在可编辑时注册)。返回注销函数。 */
export function registerFindProvider(p: FindReplaceProvider): () => void {
  providers.add(p)
  bumpProviders()
  return () => {
    providers.delete(p)
    bumpProviders()
  }
}

function providerOf(r: Range): FindReplaceProvider | null {
  const n = r.startContainer
  for (const p of providers) {
    if (!p.el.isConnected) continue
    if (p.owns ? p.owns(n) : p.el.contains(n)) return p
  }
  return null
}

/** 替换串展开:`$$` → `$`,`$&` → 整条命中,`$n` / `$nn` → 分组,`$<名>` → 命名分组;字面模式原样。 */
export function expandReplacement(repl: string, m: RegExpExecArray | undefined, regex: boolean): string {
  if (!regex || !m) return repl
  return repl.replace(/\$(\$|&|<([^>]*)>|(\d{1,2}))/g, (all, tok: string, name: string | undefined, num: string | undefined) => {
    if (tok === '$') return '$'
    if (tok === '&') return m[0]
    if (name !== undefined) return m.groups?.[name] ?? ''
    if (num !== undefined) {
      const k = Number(num)
      if (k >= 1 && k < m.length) return m[k] ?? ''
      if (num.length === 2 && Number(num[0]) >= 1 && Number(num[0]) < m.length) return (m[Number(num[0])] ?? '') + num[1]
    }
    return all
  })
}

/** 查询串 → 全局正则。字面模式转义元字符;写错的正则 → 'bad'。 */
export function findMatcher(query: string, opts: { caseSensitive: boolean; regex: boolean }): RegExp | null | 'bad' {
  const q = opts.regex ? query : query.trim()
  if (!q) return null
  try {
    return new RegExp(opts.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.caseSensitive ? 'gm' : 'gim')
  } catch {
    return 'bad'
  }
}

/** 源码 textarea 的 provider:开条期间在它后面铺一层**等宽镜像**(透明字、同字体同内边距同折行),命中 / 高亮 / 定位
 *  都落在镜像的文字节点上;替换走 focus + setSelectionRange + execCommand('insertText'),一次替换 = 原生撤销栈里一步,
 *  并照常触发 input 事件(React onChange → 草稿 / 落盘跟上)。直接改 .value 会清空原生撤销栈,「可撤销」就没了。 */
export function textareaFindProvider(ta: HTMLTextAreaElement): FindReplaceProvider {
  let mirror: HTMLDivElement | null = null
  const COPY = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform', 'textAlign', 'tabSize', 'whiteSpace', 'overflowWrap', 'wordBreak', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing', 'direction'] as const
  const sync = (): void => {
    if (!mirror) return
    const cs = getComputedStyle(ta)
    for (const k of COPY) mirror.style[k] = cs[k]
    Object.assign(mirror.style, {
      position: 'absolute', left: `${ta.offsetLeft}px`, top: `${ta.offsetTop}px`,
      width: `${ta.offsetWidth}px`, height: `${ta.offsetHeight}px`, margin: '0', borderStyle: 'solid', borderColor: 'transparent',
      overflow: 'hidden', color: 'transparent', background: 'transparent', pointerEvents: 'none', whiteSpace: 'pre-wrap',
    })
    if (mirror.firstChild?.nodeValue !== ta.value) mirror.textContent = ta.value
    mirror.scrollTop = ta.scrollTop
  }
  return {
    el: ta,
    owns: (n) => !!mirror && mirror.contains(n),
    attach: () => {
      mirror = document.createElement('div')
      mirror.className = 'amx-find-mirror'
      mirror.setAttribute('aria-hidden', 'true')
      ta.parentElement?.insertBefore(mirror, ta.nextSibling)
      sync()
      const ro = new ResizeObserver(sync)
      ro.observe(ta)
      ta.addEventListener('input', sync)
      ta.addEventListener('scroll', sync)
      return () => {
        ro.disconnect()
        ta.removeEventListener('input', sync)
        ta.removeEventListener('scroll', sync)
        mirror?.remove()
        mirror = null
      }
    },
    replace: (items) => {
      const v = ta.value
      const edits = items
        .map(({ range, text }) => ({ from: range.startOffset, to: range.endOffset, text, was: range.toString() }))
        .filter((e) => v.slice(e.from, e.to) === e.was)
        .sort((a, b) => a.from - b.from)
      if (!edits.length) return 0
      const lo = edits[0].from
      const hi = edits[edits.length - 1].to
      let seg = ''
      let at = lo
      for (const e of edits) { seg += v.slice(at, e.from) + e.text; at = e.to }
      seg += v.slice(at, hi)
      const back = document.activeElement as HTMLElement | null
      ta.focus()
      ta.setSelectionRange(lo, hi)
      const ok = seg ? document.execCommand('insertText', false, seg) : document.execCommand('delete')
      if (!ok) {
        // 没有 execCommand 的宿主:退而直接改值(撤销栈保不住,但替换本身不能丢)。
        ta.setRangeText(seg, lo, hi, 'end')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      }
      back?.focus()
      sync()
      return edits.length
    },
    // 镜像是单个文字节点、内容 = ta.value,命中的偏移就是 textarea 里的偏移。
    focusAt: (range) => {
      if (!mirror?.contains(range.startContainer)) return false
      ta.focus({ preventScroll: true })
      ta.setSelectionRange(range.startOffset, range.endOffset)
      return true
    },
  }
}

/** 活动 View 的根。焦点优先(Cmd+F 的语义就是「我正在看的这一面」),其次 dockview 的活动组,
 *  最后退到主区。⚠️ `.wb-view` 不是 dockview 面板独有(仪表盘卡片也用),所以只能从焦点
 *  `closest()` 往上找最内层的那个,不能 `querySelector` 抓第一个。 */
function pickRoot(): HTMLElement | null {
  const focused = document.activeElement
  const near = focused instanceof Element ? focused.closest('.wb-view, .mb-view, .fs-overlay') : null
  return (near
    ?? document.querySelector('.dv-active-group .wb-view')
    ?? document.querySelector('.wb-view--main')
    ?? document.querySelector('.mb-view')
    ?? document.body) as HTMLElement | null
}

/** 单行选区的文字(开条预填用):正文选区或输入框 / textarea 里的选区;跨行、过长、纯空白的不算。 */
function selectedQuery(): string | null {
  const el = document.activeElement
  let t = ''
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && /^(text|search)$/.test(el.type))) {
    if (el.closest('.amx-findbar')) return null
    t = el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
  } else {
    t = window.getSelection()?.toString() ?? ''
  }
  return t.trim() && !/[\r\n]/.test(t) && t.length <= 200 ? t : null
}

/** 开条那一刻焦点在哪(连同它里面的选区):收条时交还,焦点不许掉到 body(评审 C-17)。
 *  开条后输入框 autoFocus 会把 activeElement 抢走,只能在开条这一刻记。 */
let openedFrom: { el: HTMLElement; range: Range | null } | null = null

function rememberOrigin(): void {
  const a = document.activeElement
  if (!(a instanceof HTMLElement) || a === document.body || a.closest('.amx-findbar')) { openedFrom = null; return }
  const sel = window.getSelection()
  const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null
  openedFrom = { el: a, range: a.isContentEditable && r && a.contains(r.startContainer) ? r.cloneRange() : null }
}

/** 命中所在的可编辑区(contenteditable 的真文字;嵌入卡等 contenteditable=false 的岛不算)。 */
function editableOf(r: Range): HTMLElement | null {
  const el = r.startContainer.parentElement
  if (!el?.isContentEditable) return null
  let host: HTMLElement = el
  while (host.parentElement?.isContentEditable) host = host.parentElement
  return host
}

/** 收条后的焦点(评审 C-17;查找条是全局组件,只动 DOM 焦点 / 选区,不认识 PM):
 *  Esc(键盘)且当前命中在可编辑区 → 选区落在命中上并聚焦(Obsidian 同款:接着打字就在命中处);
 *  否则(× 点击 / 命中在只读处 / 没有命中)→ 回到开条时的焦点,连同它原来的选区。
 *  焦点已被别处接走(点进了另一面)就不抢。 */
function restoreFocus(hit: Range | null): void {
  const from = openedFrom
  openedFrom = null
  const a = document.activeElement
  if (a && a !== document.body && !a.closest('.amx-findbar')) return
  if (hit) {
    const p = providerOf(hit)
    if (p?.focusAt?.(hit)) return
    const ed = editableOf(hit)
    if (ed) {
      ed.focus({ preventScroll: true })
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(hit)
      return
    }
  }
  if (!from?.el.isConnected) return
  from.el.focus({ preventScroll: true })
  if (from.range && from.range.startContainer.isConnected) {
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(from.range)
  }
}

export function openFindBar(opts: { replace?: boolean } = {}): void {
  if (!findSupported) return
  const pre = selectedQuery()
  // 已经开着时再按一次 = 重新聚焦并全选(输入框的 autoFocus 只在挂载那一次生效;焦点回到正文
  // 之后再按 Cmd+F,不做这一步就是「按了没反应」)。正文里新选了一段 → 同 VS Code,换成它。
  if (useFind.getState().open) {
    useFind.setState({ ...(pre ? { query: pre } : {}), ...(opts.replace ? { replaceOpen: true } : {}) })
    const inp = document.querySelector<HTMLInputElement>('.amx-findbar input')
    inp?.focus()
    inp?.select()
    return
  }
  rememberOrigin()
  useFind.setState({ open: true, root: pickRoot(), ...(pre ? { query: pre } : {}), ...(opts.replace ? { replaceOpen: true } : {}) })
}

/** how:用户亲手收条('keyboard' = Esc,'pointer' = 点 ×)才交还焦点;面被摘掉等自动收条不动焦点。 */
export function closeFindBar(how?: 'keyboard' | 'pointer'): void {
  const hit = how === 'keyboard' ? (hits[useFind.getState().active] ?? null) : null
  hits = []
  hitGroups = []
  paint(-1)
  useFind.setState({ open: false, query: '', active: 0, total: 0, root: null, bad: false, replaceable: 0 })
  if (how) restoreFocus(hit)
  else openedFrom = null
}

/* ── 扫描 ─────────────────────────────────────────────────────────── */

/** 不产生换行的 display 值:这些元素里的文字与前后同属一块,命中可以横跨它们。 */
const INLINEISH = /^(inline|contents|ruby)/

/** 找 text node 所属的「块」。缓存到 WeakMap:一次扫描里同一批祖先会被问上千次。 */
function blockOf(node: Node, cache: WeakMap<Element, boolean>): Element | null {
  let el = node.parentElement
  while (el) {
    let inline = cache.get(el)
    if (inline === undefined) {
      inline = INLINEISH.test(getComputedStyle(el).display)
      cache.set(el, inline)
    }
    if (!inline) return el
    el = el.parentElement
  }
  return null
}

/** 扫出 root 里所有命中,按文档序(匹配组写进 hitGroups)。matcher 由 findMatcher 给(大小写 / 正则)。 */
function scan(root: HTMLElement, matcher: RegExp | null): Range[] {
  hitGroups = []
  if (!matcher) return []
  const inlineCache = new WeakMap<Element, boolean>()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n: Node): number {
      const p = n.parentElement
      if (!p || !n.nodeValue) return NodeFilter.FILTER_REJECT
      // 查找条自己的文字不算命中;脚本/样式的文本不是给人看的。
      if (p.closest('.amx-findbar')) return NodeFilter.FILTER_REJECT
      const tag = p.tagName
      // textarea 的子文字节点是 React 首挂时的初值,不是当前内容(当前内容在 .value,由 textareaFindProvider 的镜像代查)。
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') return NodeFilter.FILTER_REJECT
      // 低缩放的画布把卡片正文 display:none 换成缩略标题;折叠的小节同理 —— 看不见就不该命中。
      if (!p.checkVisibility()) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })

  // 拼成一条串:块边界插 '\n',所以命中永远不跨块(查询串里不可能有 '\n')。
  let text = ''
  const pieces: Array<{ node: Text; at: number }> = []
  let prevBlock: Element | null = null
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text
    const block = blockOf(t, inlineCache)
    if (pieces.length && block !== prevBlock) text += '\n'
    prevBlock = block
    pieces.push({ node: t, at: text.length })
    text += t.nodeValue ?? ''
  }

  const out: Range[] = []
  let cursor = 0 // pieces 里的推进指针:偏移单调递增,不必每次从头二分
  matcher.lastIndex = 0
  for (let m = matcher.exec(text); m; m = matcher.exec(text)) {
    if (!m[0]) { matcher.lastIndex++; continue } // 零长匹配(`^`、`a*`…)不算命中,挪一格防死循环
    if (m[0].includes('\n')) continue // 跨块边界(拼串时插的 '\n')
    const from = m.index
    const to = from + m[0].length
    while (cursor > 0 && pieces[cursor].at > from) cursor--
    while (cursor + 1 < pieces.length && pieces[cursor + 1].at <= from) cursor++
    let endIdx = cursor
    while (endIdx + 1 < pieces.length && pieces[endIdx + 1].at < to) endIdx++
    const r = document.createRange()
    r.setStart(pieces[cursor].node, from - pieces[cursor].at)
    r.setEnd(pieces[endIdx].node, Math.min(to - pieces[endIdx].at, pieces[endIdx].node.length))
    out.push(r)
    hitGroups.push(m)
  }
  return out
}

/** 按当前选项重扫;返回新命中数。正则写错 → bad。 */
function rescan(root: HTMLElement): number {
  const st = useFind.getState()
  const matcher = findMatcher(st.query, st)
  hits = scan(root, matcher === 'bad' ? null : matcher)
  useFind.setState({ bad: matcher === 'bad', replaceable: hits.filter((r) => providerOf(r)).length })
  return hits.length
}

/* ── 上色 ─────────────────────────────────────────────────────────── */

function paint(active: number): void {
  if (!findSupported) return
  const reg = CSS.highlights
  if (!hits.length) {
    reg.delete('amx-find')
    reg.delete('amx-find-active')
    return
  }
  reg.set('amx-find', new Highlight(...hits))
  const cur = hits[active]
  // 两个高亮会叠在同一段文字上,靠 priority 决定谁的底色胜出。
  const hl = cur ? new Highlight(cur) : new Highlight()
  hl.priority = 1
  reg.set('amx-find-active', hl)
}

/* ── 定位 ─────────────────────────────────────────────────────────── */

/** 最近一个真能滚的祖先。`overflow:hidden` 不算 —— 它「程序上滚得动」,但滚了用户没法滚回来
 *  (viewportLock.ts 顶注记的就是这个坑)。 */
function scrollerOf(el: Element | null): HTMLElement | null {
  for (let e = el; e && e !== document.body; e = e.parentElement) {
    if (!(e instanceof HTMLElement)) continue
    const st = getComputedStyle(e)
    const scrollableY = /auto|scroll/.test(st.overflowY) && e.scrollHeight > e.clientHeight + 1
    const scrollableX = /auto|scroll/.test(st.overflowX) && e.scrollWidth > e.clientWidth + 1
    if (scrollableY || scrollableX) return e
  }
  return null
}

function reveal(r: Range): void {
  const rect = r.getBoundingClientRect()
  if (!rect.width && !rect.height) return
  const el = r.startContainer.parentElement
  if (!el) return
  // 先给这一面自己一次机会:画布拿 transform 当视口,任何滚动 API 都够不着它。
  const taken = !el.dispatchEvent(
    new CustomEvent('amx-reveal', { bubbles: true, cancelable: true, detail: { rect } }),
  )
  if (taken) return
  const host = scrollerOf(el)
  if (!host) return
  const hr = host.getBoundingClientRect()
  // rect / hr 都是**视口**量(已过应用级 CSS zoom),而 scrollTop 是元素自己的 CSS px ——
  // 差值必须除掉这一级 zoom,否则 80%/125% 设置下每次定位都按比例过冲(同 flashCiteTip)。
  const z = (host as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1
  if (rect.bottom > hr.bottom || rect.top < hr.top) {
    host.scrollTop += (rect.top + rect.height / 2 - (hr.top + hr.height / 2)) / z
  }
  if (rect.right > hr.right || rect.left < hr.left) {
    host.scrollLeft += (rect.left + rect.width / 2 - (hr.left + hr.width / 2)) / z
  }
}

/* ── 浮条 ─────────────────────────────────────────────────────────── */

export function FindBar(): React.ReactElement | null {
  const open = useFind((s) => s.open)
  if (!open) return null
  return <FindBarBody />
}

function FindBarBody(): React.ReactElement {
  const { t } = useI18n()
  const query = useFind((s) => s.query)
  const active = useFind((s) => s.active)
  const total = useFind((s) => s.total)
  const root = useFind((s) => s.root)
  const caseSensitive = useFind((s) => s.caseSensitive)
  const regex = useFind((s) => s.regex)
  const bad = useFind((s) => s.bad)
  const replaceOpen = useFind((s) => s.replaceOpen)
  const replacement = useFind((s) => s.replacement)
  const replaceable = useFind((s) => s.replaceable)
  const providerVer = useFind((s) => s.providerVer)
  const [box, setBox] = useState<{ top: number; right: number }>({ top: 12, right: 12 })
  const findRef = useRef<HTMLInputElement | null>(null)
  // 这一面有没有可替换的 provider(没有就不给替换行 —— 大多数 View、只读页)。
  const canReplace = !!root && [...providers].some((p) => p.el.isConnected && root.contains(p.el))
  void providerVer

  // 贴到活动 View 的右上角(分栏时贴对那一栏)。root 一开条就定死,只跟窗口尺寸变。
  useLayoutEffect(() => {
    const place = (): void => {
      const r = root?.getBoundingClientRect()
      if (r) setBox({ top: r.top + 8, right: Math.max(8, window.innerWidth - r.right + 8) })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [root])

  // 条开着期间给搜索根里的 provider 挂准备工作(textarea 铺镜像)。面换了(切源码模式)跟着换。
  // ⚠️ 必须声明在下面的重扫之前:镜像要先在场,第一次扫描才看得见 textarea 里的字。
  useLayoutEffect(() => {
    if (!root) return
    const offs = [...providers].filter((p) => p.attach && root.contains(p.el)).map((p) => (p.attach as () => () => void)())
    return () => offs.forEach((off) => off())
  }, [root, providerVer])

  // 查询 / 选项变化 → 重扫 + 回到第一条。
  useEffect(() => {
    if (!root) return
    rescan(root)
    useFind.setState({ total: hits.length, active: 0 })
    paint(0)
    if (hits.length) reveal(hits[0])
  }, [root, query, caseSensitive, regex, providerVer])

  // 搜索根自己被摘掉(切 tab / 关设置)→ 条自动收。dockview 是 `renderer='onlyWhenVisible'`,
  // 切走的 tab **整棵从 DOM 摘掉**,而下面那个 MutationObserver 只看 root 的*子树*,root 自身被摘
  // 不会通知 —— 少这一段,浮条就挂在半空:还在屏幕上、搜什么都是 0、只能按 Esc。
  // focusin 覆盖「点进另一面」这条常路(立刻收);1s 轮询兜住键盘换 tab 这类不落焦点的走法。
  useEffect(() => {
    if (!root) return
    const check = (): void => { if (!root.isConnected) closeFindBar() }
    window.addEventListener('focusin', check)
    const id = window.setInterval(check, 1000)
    return () => {
      window.removeEventListener('focusin', check)
      window.clearInterval(id)
    }
  }, [root])

  // 正文变了(打字、聊天流式输出、切页)→ 重扫,否则 Range 还指着已经没了的文本。
  useEffect(() => {
    if (!root || !query.trim()) return
    let timer = 0
    const mo = new MutationObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        rescan(root)
        const next = Math.min(useFind.getState().active, Math.max(0, hits.length - 1))
        useFind.setState({ total: hits.length, active: next })
        paint(next)
      }, 150)
    })
    mo.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      window.clearTimeout(timer)
      mo.disconnect()
    }
  }, [root, query, caseSensitive, regex])

  const step = (dir: 1 | -1): void => {
    if (!hits.length) return
    const next = (useFind.getState().active + dir + hits.length) % hits.length
    useFind.setState({ active: next })
    paint(next)
    reveal(hits[next])
  }

  /** 替换 hits[idx](全部替换 = 所有可替换的命中),按 provider 分组,各自一次可撤销的编辑。
   *  之后当场重扫(编辑是同步落 DOM 的):替换当前 → 光标跳到被换掉那处之后的下一条(替换串自己又命中的不回头)。 */
  const doReplace = (all: boolean): void => {
    if (!root || !hits.length) return
    const st = useFind.getState()
    const idx = all ? hits.map((_, i) => i) : [st.active]
    const groups = new Map<FindReplaceProvider, FindReplaceItem[]>()
    for (const i of idx) {
      const p = providerOf(hits[i])
      if (!p) continue
      const list = groups.get(p) ?? []
      list.push({ range: hits[i], text: expandReplacement(st.replacement, hitGroups[i], st.regex) })
      groups.set(p, list)
    }
    let done = 0
    for (const [p, items] of groups) done += p.replace(items)
    if (!done && !all) { step(1); return } // 当前这条换不了(嵌入卡 / 页面 chrome 里的字)→ 跳下一条
    const before = st.active
    const replacedText = all ? '' : expandReplacement(st.replacement, hitGroups[st.active], st.regex)
    rescan(root)
    let next = 0
    if (!all && hits.length) {
      const m = findMatcher(st.query, st)
      const self = m && m !== 'bad' ? (replacedText.match(new RegExp(m.source, m.flags)) ?? []).length : 0
      next = (before + self) % hits.length
    }
    useFind.setState({ total: hits.length, active: next })
    paint(next)
    if (hits.length) reveal(hits[next])
  }

  const keys = (e: React.KeyboardEvent): boolean => {
    if (e.key === 'Escape') { closeFindBar('keyboard'); return true }
    if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyF') {
      e.preventDefault()
      if (canReplace) useFind.setState({ replaceOpen: !useFind.getState().replaceOpen })
      return true
    }
    return false
  }
  const toggle = (k: 'caseSensitive' | 'regex'): void => {
    useFind.setState({ [k]: !useFind.getState()[k] } as Partial<FindState>)
    findRef.current?.focus()
  }

  return (
    <div className={`amx-findbar${replaceOpen && canReplace ? ' amx-findbar--replace' : ''}`} style={{ top: box.top, right: box.right }}>
      {canReplace && (
        <button
          className="amx-findbar-expand"
          onClick={() => useFind.setState({ replaceOpen: !replaceOpen })}
          title={t('find.toggleReplace')}
          aria-label={t('find.toggleReplace')}
          aria-expanded={replaceOpen}
        >
          {replaceOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      )}
      <div className="amx-findbar-rows">
        <div className="amx-findbar-row">
          <input
            ref={findRef}
            autoFocus
            placeholder={t('find.placeholder')}
            value={query}
            aria-invalid={bad || undefined}
            title={bad ? t('find.badRegex') : undefined}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => useFind.setState({ query: e.target.value })}
            onKeyDown={(e) => {
              if (!keys(e) && e.key === 'Enter') step(e.shiftKey ? -1 : 1)
              // 全局热键表是 window 上的冒泡监听,不拦住的话在框里打字会触发一堆命令。
              e.stopPropagation()
            }}
          />
          <button className="amx-findbar-opt" onClick={() => toggle('caseSensitive')} aria-pressed={caseSensitive} title={t('find.case')} aria-label={t('find.case')}>
            <CaseSensitive size={15} />
          </button>
          <button className="amx-findbar-opt" onClick={() => toggle('regex')} aria-pressed={regex} title={t('find.regex')} aria-label={t('find.regex')}>
            <Regex size={14} />
          </button>
          <span className="amx-findbar-count">{total ? `${active + 1}/${total}` : query.trim() ? '0' : ''}</span>
          <button onClick={() => step(-1)} title={t('find.prev')} aria-label={t('find.prev')}>‹</button>
          <button onClick={() => step(1)} title={t('find.next')} aria-label={t('find.next')}>›</button>
          <button onClick={() => closeFindBar('pointer')} title={t('find.close')} aria-label={t('find.close')}>✕</button>
        </div>
        {replaceOpen && canReplace && (
          <div className="amx-findbar-row">
            <input
              className="amx-findbar-replace"
              placeholder={t('find.replacePlaceholder')}
              value={replacement}
              onChange={(e) => useFind.setState({ replacement: e.target.value })}
              onKeyDown={(e) => {
                if (!keys(e) && e.key === 'Enter') doReplace(e.metaKey || e.ctrlKey)
                e.stopPropagation()
              }}
            />
            <button className="amx-findbar-act" onClick={() => doReplace(false)} disabled={!replaceable} title={t('find.replaceOne')} aria-label={t('find.replaceOne')}>
              <Replace size={14} />
            </button>
            <button className="amx-findbar-act" onClick={() => doReplace(true)} disabled={!replaceable} title={t('find.replaceAll')} aria-label={t('find.replaceAll')}>
              <ReplaceAll size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
