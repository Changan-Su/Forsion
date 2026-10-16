/** 「离视口一屏以内了」的一次性通知:长会话里的代码块等到这时才做语法高亮,一打开不用把整段会话的代码都高亮一遍
 *  (docs/ToBeImproved/长内容渲染机制方案_2026-10-16 的 C)。到了回调一次、不再观察;返回的函数取消。
 *  ⚠️ 只给「挂上前后高度不变」的东西用。笔记嵌入试过(10-16)又撤了:占位估高与真实高度不符,一挂上内容就移位、
 *  又把下一批带进范围,连锁挂载拖到之后几秒,撞上打字就是几千个元素的样式重算。
 *
 *  root 必须是滚动容器本身:root 取视口时,滚动容器外的元素先被容器裁掉,rootMargin 放不大它们,得真滚进来才算「近」。
 *  同一个滚动容器共用一个 IntersectionObserver,没人在等了就断开。没有 IntersectionObserver 的环境直接回调。
 *  ponytail: 只挂不卸;长到内存吃紧再加「远了就卸」。 */
const byRoot = new Map<Element | null, { io: IntersectionObserver; waiting: Map<Element, () => void> }>()

/** 聊天流与笔记正文是已知的滚动容器,先认它们;别处往上找第一个能纵向滚的祖先。 */
function scrollRoot(el: Element): Element | null {
  const known = el.closest('.t2-stream, .amx-pane')
  if (known) return known
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return p
  }
  return null
}

export function whenNear(el: Element, cb: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') { cb(); return () => {} }
  const root = scrollRoot(el)
  let entry = byRoot.get(root)
  if (!entry) {
    const waiting = new Map<Element, () => void>()
    const io = new IntersectionObserver((records) => {
      for (const r of records) {
        const fn = r.isIntersecting ? waiting.get(r.target) : undefined
        if (!fn) continue
        release(root, r.target)
        fn()
      }
    }, { root, rootMargin: `${root?.clientHeight || window.innerHeight}px 0px` }) // 一屏;百分比会按宽度算。ponytail: 高度取建观察器那一刻的
    entry = { io, waiting }
    byRoot.set(root, entry)
  }
  entry.waiting.set(el, cb)
  entry.io.observe(el)
  return () => release(root, el)
}

function release(root: Element | null, el: Element): void {
  const entry = byRoot.get(root)
  if (!entry || !entry.waiting.delete(el)) return
  entry.io.unobserve(el)
  if (!entry.waiting.size) { entry.io.disconnect(); byRoot.delete(root) }
}
