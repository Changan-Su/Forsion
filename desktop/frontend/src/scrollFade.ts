/**
 * 滚动条自动隐现(macOS overlay 手感):静止时透明,滚动中或指针落到滚动条上才显形。
 *
 * 分工 —— 「指针落到滚动条上」纯 CSS 就够(`::-webkit-scrollbar-thumb:hover`);
 * 「正在滚动」CSS 表达不了,所以本模块在**捕获阶段**监听 scroll,给正在滚的那个元素打
 * `data-scrolling`,静止 IDLE_MS 后摘掉。样式在 styles/base.css 与 amadeus/styles.css。
 *
 * ⚠️ scroll 事件**不冒泡**,必须 `capture: true` 才能用一个监听器覆盖全部滚动容器
 *    (挂在每个容器上 = 要追着组件生命周期跑,必漏)。
 * ⚠️ 标记打在**正在滚的那个元素**上,不是 <html>:打全局的话滚聊天时侧栏的滚动条也会一起亮。
 */

/** 停止滚动后多久淡出。比淡入慢一档(淡入 0.12s / 淡出 0.35s,见 CSS)。 */
const IDLE_MS = 900

const timers = new WeakMap<Element, number>()

function mark(el: Element): void {
  // 已经在滚就别重复写属性(每帧一次 setAttribute = 每帧一次样式失效)
  if (!el.hasAttribute('data-scrolling')) el.setAttribute('data-scrolling', '')
  const prev = timers.get(el)
  if (prev !== undefined) clearTimeout(prev)
  timers.set(el, window.setTimeout(() => {
    el.removeAttribute('data-scrolling')
    timers.delete(el)
  }, IDLE_MS))
}

let installed = false

export function installScrollFade(): void {
  if (installed) return
  installed = true
  document.addEventListener('scroll', (e) => {
    const t = e.target as Element | Document | null
    // 文档级滚动的 target 是 document,样式得挂到 documentElement 上才选得中
    const el = !t || t === document ? document.documentElement : (t as Element)
    if (el instanceof Element) mark(el)
  }, { capture: true, passive: true })
}
