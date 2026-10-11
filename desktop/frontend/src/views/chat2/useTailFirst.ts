import { useEffect, useRef, useState } from 'react'

export const TAIL_FIRST = 12
const TAIL_STEP = 12
/** 手机上的长对话先挂最后 `TAIL_FIRST` 条,其余在浏览器空闲时一批批补到上面。
 *  一次挂完 60 条是一整段同步渲染(2026-10-11 实测:中端手机速度下卡住约 1 秒,期间页面不出帧也不响应);
 *  分批之后每批之间都让出帧。人落在对话底部,先看到的本来就是最后几条;补上面的那几批时,钉在底部的由吸底逻辑
 *  接着钉住,已经往上翻的由浏览器的滚动锚定保持不动。`enabled` 为假(桌面 / 网页 / 正要跳到某条消息)时原样全挂。
 *  ⚠️ 一段会话**一旦整段在页面上就一直整段**(`wholeFor` 记着是哪一段):补完了、或者中途不许分批过(搜索命中要跳到某条)。
 *     否则新来一条消息、或者跳转目标一清,前面已经显示的消息会被卸掉再挂回 —— 选区、展开状态、开着的菜单跟着丢。
 *     记在 ref 里而不是 state 里:它只在下一次渲染时被读,为它多渲一轮整段对话不值。
 *  ponytail: 不是虚拟列表 —— 补完之后整段都在页面上;对话长到补完也嫌重时再换成窗口化。 */
export function useTailFirst<T>(items: T[], sessionId: string | null, enabled: boolean): T[] {
  const [shown, setShown] = useState({ sessionId, count: TAIL_FIRST })
  const wholeFor = useRef<string | null | undefined>(undefined)
  const count = shown.sessionId === sessionId ? shown.count : TAIL_FIRST // 换了会话:从头来,不多渲一轮
  const whole = !enabled || wholeFor.current === sessionId || (items.length > 0 && count >= items.length)
  useEffect(() => {
    if (whole) { wholeFor.current = sessionId; return }
    if (!items.length) return // 历史还没到:没有可补的
    const grow = (): void => setShown({ sessionId, count: count + TAIL_STEP })
    if (typeof requestIdleCallback !== 'function') { const timer = window.setTimeout(grow, 32); return () => window.clearTimeout(timer) }
    const idle = requestIdleCallback(grow, { timeout: 200 })
    return () => cancelIdleCallback(idle)
  }, [whole, count, sessionId, items.length])
  return whole ? items : items.slice(items.length - count)
}
