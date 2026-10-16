import { flushSync } from 'react-dom'

/** 还在等「离视口近了」才第一次渲染的笔记嵌入(embedLayer 的懒挂)。单独一个小模块:导出 PDF 那边要用,
 *  不能为它把 embedLayer 连同各类嵌入组件一起拉进主包。 */
export const waitingEmbeds = new Set<() => void>()

/** 嵌入还在读数据时露出的占位(跨笔记引用解析中、PDF 组件、数据库 / 画板读取中)。 */
const LOADING = '.embed-loading, .embed-pdf-loading, [data-embed-loading]'

/** 克隆 DOM 去打印的(导出 PDF)先调它:把没进过视口的嵌入全挂上,不然印出来是空占位;再等 host 里没有「读取中」、
 *  DOM 静下来 300ms 才返回(最多等 5 秒),不然印出来是「加载中」。 */
export async function showWaitingEmbeds(host: Element): Promise<void> {
  if (!waitingEmbeds.size && !host.querySelector(LOADING)) return
  let last = performance.now()
  const mo = new MutationObserver(() => { last = performance.now() })
  mo.observe(host, { subtree: true, childList: true, characterData: true })
  if (waitingEmbeds.size) flushSync(() => { for (const show of [...waitingEmbeds]) show() })
  const t0 = performance.now()
  while ((host.querySelector(LOADING) || performance.now() - last < 300) && performance.now() - t0 < 5000) {
    await new Promise((r) => setTimeout(r, 50))
  }
  mo.disconnect()
}
