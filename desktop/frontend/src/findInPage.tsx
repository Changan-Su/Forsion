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
 */
import { useEffect, useLayoutEffect, useState } from 'react'
import { create } from 'zustand'
import { registerMessages, useI18n } from './i18n'
import './findInPage.css'

registerMessages({
  'find.placeholder': { zh: '在本页查找…', en: 'Find in page…' },
  'find.prev': { zh: '上一个(Shift+Enter)', en: 'Previous (Shift+Enter)' },
  'find.next': { zh: '下一个(Enter)', en: 'Next (Enter)' },
  'find.close': { zh: '关闭(Esc)', en: 'Close (Esc)' },
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
}

/** 命中放模块级而不是 store:Range 数组每次扫描都换新,进 store 只会白白重渲整条浮条。 */
let hits: Range[] = []

export const useFind = create<FindState>(() => ({
  open: false,
  query: '',
  active: 0,
  total: 0,
  root: null,
}))

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

export function openFindBar(): void {
  if (!findSupported) return
  // 已经开着时再按一次 = 重新聚焦并全选(输入框的 autoFocus 只在挂载那一次生效;焦点回到正文
  // 之后再按 Cmd+F,不做这一步就是「按了没反应」)。
  if (useFind.getState().open) {
    const inp = document.querySelector<HTMLInputElement>('.amx-findbar input')
    inp?.focus()
    inp?.select()
    return
  }
  useFind.setState({ open: true, root: pickRoot() })
}

export function closeFindBar(): void {
  hits = []
  paint(-1)
  useFind.setState({ open: false, query: '', active: 0, total: 0, root: null })
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

/** 扫出 root 里所有命中,按文档序。大小写不敏感。 */
function scan(root: HTMLElement, query: string): Range[] {
  const q = query.toLowerCase()
  if (!q) return []
  const inlineCache = new WeakMap<Element, boolean>()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n: Node): number {
      const p = n.parentElement
      if (!p || !n.nodeValue) return NodeFilter.FILTER_REJECT
      // 查找条自己的文字不算命中;脚本/样式的文本不是给人看的。
      if (p.closest('.amx-findbar')) return NodeFilter.FILTER_REJECT
      const tag = p.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT
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

  const lower = text.toLowerCase()
  const out: Range[] = []
  let from = lower.indexOf(q)
  let cursor = 0 // pieces 里的推进指针:偏移单调递增,不必每次从头二分
  while (from !== -1) {
    const to = from + q.length
    while (cursor > 0 && pieces[cursor].at > from) cursor--
    while (cursor + 1 < pieces.length && pieces[cursor + 1].at <= from) cursor++
    let endIdx = cursor
    while (endIdx + 1 < pieces.length && pieces[endIdx + 1].at < to) endIdx++
    const r = document.createRange()
    r.setStart(pieces[cursor].node, from - pieces[cursor].at)
    r.setEnd(pieces[endIdx].node, Math.min(to - pieces[endIdx].at, pieces[endIdx].node.length))
    out.push(r)
    from = lower.indexOf(q, to)
  }
  return out
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
  const [box, setBox] = useState<{ top: number; right: number }>({ top: 12, right: 12 })

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

  // 查询变化 → 重扫 + 回到第一条。
  useEffect(() => {
    if (!root) return
    hits = scan(root, query.trim())
    useFind.setState({ total: hits.length, active: 0 })
    paint(0)
    if (hits.length) reveal(hits[0])
  }, [root, query])

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
        hits = scan(root, query.trim())
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
  }, [root, query])

  const step = (dir: 1 | -1): void => {
    if (!hits.length) return
    const next = (useFind.getState().active + dir + hits.length) % hits.length
    useFind.setState({ active: next })
    paint(next)
    reveal(hits[next])
  }

  return (
    <div className="amx-findbar" style={{ top: box.top, right: box.right }}>
      <input
        autoFocus
        placeholder={t('find.placeholder')}
        value={query}
        onChange={(e) => useFind.setState({ query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') step(e.shiftKey ? -1 : 1)
          else if (e.key === 'Escape') closeFindBar()
          // 全局热键表是 window 上的冒泡监听,不拦住的话在框里打字会触发一堆命令。
          e.stopPropagation()
        }}
      />
      <span className="amx-findbar-count">{total ? `${active + 1}/${total}` : query.trim() ? '0' : ''}</span>
      <button onClick={() => step(-1)} title={t('find.prev')} aria-label="previous match">‹</button>
      <button onClick={() => step(1)} title={t('find.next')} aria-label="next match">›</button>
      <button onClick={closeFindBar} title={t('find.close')} aria-label="close find">✕</button>
    </div>
  )
}
