import { flushSync } from 'react-dom'

/** 还在等「离视口近了」才第一次渲染的笔记嵌入(embedLayer 的懒挂)。单独一个小模块:导出 PDF 那边要用,
 *  不能为它把 embedLayer 连同各类嵌入组件一起拉进主包。 */
export const waitingEmbeds = new Set<() => void>()

/** 克隆 DOM 去打印的(导出 PDF)先调它:把没进过视口的嵌入全挂上,不然印出来是空占位。 */
export function showWaitingEmbeds(): void {
  if (waitingEmbeds.size) flushSync(() => { for (const show of [...waitingEmbeds]) show() })
}
