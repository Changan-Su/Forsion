/** 提示框 / 悬停卡的 React 入口。时序、接力、定位的真身在引擎 hoverSurface.ts(Ribbon 也要用,引擎不能反向依赖这里)。 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { hoverCardSurface, type HoverSide, type HoverSpec } from '../engine/hoverSurface'

export { tooltipProps, attachTooltip, hideTooltip, placeHover } from '../engine/hoverSurface'
export type { TooltipContent, TooltipLines, TooltipOptions, HoverSide, RectLike } from '../engine/hoverSurface'

export interface HoverCardOptions {
  side?: HoverSide
  className?: string
  rect?: HoverSpec['rect']
}

/**
 * 悬停卡:内容是 React(图标、几行字),时序同提示框、相邻接力,用 `--hovercard-*` 的时长。
 * content 为 null = 这次不出。返回的 triggerProps 摊到触发元素上,portal 渲染在组件里任意位置。
 */
export function useHoverCard(content: ReactNode | null, opts: HoverCardOptions = {}): {
  triggerProps: {
    onMouseEnter(e: { currentTarget: HTMLElement }): void
    onMouseLeave(e: { currentTarget: HTMLElement }): void
    onMouseDown(e: { currentTarget: HTMLElement }): void
    onFocus(e: { currentTarget: HTMLElement }): void
    onBlur(): void
  }
  portal: ReactNode
} {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const has = useRef(false)
  has.current = content != null
  const trigger = useRef<HTMLElement | null>(null)
  const spec = (): HoverSpec => ({
    side: opts.side,
    className: opts.className,
    rect: opts.rect,
    // flushSync:内容先落进浮层再量尺寸定位,不先闪一帧空卡。
    fill: (el) => { if (!has.current) return false; flushSync(() => setHost(el)); return true },
    release: () => setHost(null),
  })
  useEffect(() => () => { if (trigger.current) hoverCardSurface.drop(trigger.current) }, [])
  // 弹着的时候内容没了(状态变成「不该出卡」)→ 收。
  useEffect(() => { if (content == null && trigger.current) hoverCardSurface.drop(trigger.current) }, [content])
  return {
    triggerProps: {
      onMouseEnter: (e) => { trigger.current = e.currentTarget; hoverCardSurface.enter(e.currentTarget, spec()) },
      onMouseLeave: (e) => hoverCardSurface.leave(e.currentTarget),
      onMouseDown: (e) => hoverCardSurface.press(e.currentTarget),
      onFocus: (e) => {
        trigger.current = e.currentTarget
        let kb = true
        try { kb = e.currentTarget.matches(':focus-visible') } catch { /* 老内核:按键盘处理 */ }
        if (kb) hoverCardSurface.focus(e.currentTarget, spec())
      },
      onBlur: () => { if (trigger.current) hoverCardSurface.drop(trigger.current) },
    },
    portal: host && content != null ? createPortal(content, host) : null,
  }
}
