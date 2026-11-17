import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { fadeScaleOpen, openPanel } from './panelMotion'
import type { Droplet } from './droplet'

/** 二级面板(＋ 的「添加会话 / 视图 / 应用」、模型菜单的子面板)从那一行渗出来(方案 3.1):一级菜单压在液体上面。
 *  - 只在二级从无到有那一下流;悬停换到另一行 = 直接换内容,不重流(悬停扫过几行就会几滴此起彼伏)。
 *  - 两侧都放不下、叠在一级上方(stacked,窄 Chat View 常见)时一级会把液体盖住,一级还在流出时(还在裁切)二级挂在它
 *    矩形外会被裁掉 —— 这两种不流,淡入。
 *  - 关二级(回到一级、换掉、一级开始倒放)= 撤掉液体,二级走 80ms 退场替身。
 *  定位在同一个 layout 阶段里改了(右 → 左 / 叠放)就按新位置重来一次,那时还没画出任何一帧。 */
export function useSubPanelFlow(
  enabled: boolean,
  pane: string | null,
  placement: string,
  source: () => HTMLElement | null,
  sub: RefObject<HTMLElement | null>,
  parent: RefObject<HTMLElement | null>,
): void {
  const flow = useRef<{ d: Droplet; settled: boolean } | null>(null)
  useLayoutEffect(() => {
    if (!enabled || !pane) { flow.current?.d.cancel(); flow.current = null; return }
    if (flow.current?.settled) return
    const el = sub.current, src = source()
    if (!el || !src) return
    flow.current?.d.cancel()
    const calm = placement.startsWith('stacked') || !!parent.current?.classList.contains('lcl-droplet-pouring')
    const f = { d: calm ? fadeScaleOpen(src, el) : openPanel(src, el), settled: false }
    flow.current = f
    requestAnimationFrame(() => { f.settled = true })
  }, [enabled, pane, placement]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { flow.current?.d.cancel() }, [])
}
