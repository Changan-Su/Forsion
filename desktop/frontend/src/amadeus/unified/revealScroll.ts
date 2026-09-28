/** 把正文里的某个块「亮到阅读位置」:块顶贴在滚动容器可视区上部,让开 sticky 顶栏再留一条缝。
 *
 *  大纲跳转 / `[[笔记#标题]]` / `[[笔记#^块]]` 共用(评审 C-03;G4-01 搜索命中、L-05 锚点跳转复用这一份)。
 *  为什么不用 PM 的 `tr.scrollIntoView()`:
 *   ① 它要求 DOM 选区**已经**在编辑器里(prosemirror-view scrollToSelection 首句),刚打开笔记 /
 *      焦点在标题框里时第一次点击原地不动;
 *   ② 它是「最小滚动」—— 往下跳时标题贴在视口底边,往上跳时停在 top:0,被 sticky 的 `.amx-toolbar` 盖住。
 *  定位协议与页内查找(findInPage.reveal)同一套:先发 `amx-reveal` 给这一面自己接管(画布拿 transform
 *  当视口,滚动 API 够不着),没人接才写最近一个**真能滚**的祖先的 scrollTop;绝不 scrollIntoView
 *  (它会推 overflow:hidden 的画布舞台,推完命中判定永久错位)。 */

/** 最近一个真能滚的祖先(与 findInPage.scrollerOf 同口径:overflow:hidden 不算)。 */
function scrollerOf(el: Element | null): HTMLElement | null {
  for (let e = el; e && e !== document.body; e = e.parentElement) {
    if (!(e instanceof HTMLElement)) continue
    const st = getComputedStyle(e)
    if (/auto|scroll/.test(st.overflowY) && e.scrollHeight > e.clientHeight + 1) return e
  }
  return null
}

/** 滚动容器顶上被 sticky 顶栏盖住的那一截(视口 px)。只认宿主壳的笔记顶栏 `.amx-toolbar`
 *  (EditorScope / 台架 upane 里都是滚动容器的直接子元素;移动端与 Mini 不渲染它 → 0)。
 *  不做「凡 sticky 都算」的泛扫:LCL FloatingToc 的 sticky 框是 top:50% / height:0,会把落点推到半屏。 */
function stickyTopInset(host: HTMLElement): number {
  const bar = host.querySelector(':scope > .amx-toolbar')
  if (!(bar instanceof HTMLElement)) return 0
  const st = getComputedStyle(bar)
  if (st.position !== 'sticky' || st.display === 'none' || st.visibility === 'hidden') return 0
  return bar.getBoundingClientRect().height
}

/** el 的顶边滚到「滚动容器顶 + 顶栏高 + gap」。el 不可见(折叠区里,rect 为空)时不动。 */
export function revealBlockAtTop(el: HTMLElement, gap = 12): void {
  const rect = el.getBoundingClientRect()
  if (!rect.width && !rect.height) return
  const taken = !el.dispatchEvent(new CustomEvent('amx-reveal', { bubbles: true, cancelable: true, detail: { rect } }))
  if (taken) return
  const host = scrollerOf(el.parentElement)
  if (!host) {
    // 没有滚动容器(整页随文档滚):直接按窗口量。
    window.scrollBy(0, rect.top - gap)
    return
  }
  const hr = host.getBoundingClientRect()
  // rect / hr / 顶栏高都是**视口**量(已过应用级 CSS zoom),scrollTop 是元素自己的 CSS px ——
  // 差值除掉这一级 zoom(同 findInPage.reveal / flashCiteTip),否则 80%/125% 下按比例过冲。
  const z = (host as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1
  host.scrollTop += (rect.top - (hr.top + stickyTopInset(host) + gap)) / z
}
