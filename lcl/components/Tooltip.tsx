/** 提示框 / 悬停卡的 React 入口。时序、接力、定位的真身在引擎 hoverSurface.ts(Ribbon 也要用,引擎不能反向依赖这里)。 */
import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { hoverCardSurface, type HoverSide, type HoverSpec } from '../engine/hoverSurface'

export { tooltipProps, attachTooltip, hideTooltip, placeHover } from '../engine/hoverSurface'
export type { TooltipContent, TooltipLines, TooltipOptions, HoverSide, RectLike } from '../engine/hoverSurface'

export interface HoverCardOptions {
  side?: HoverSide
  className?: string
  rect?: HoverSpec['rect']
  /** 触屏:按住 0.5 秒出卡(立刻出,不再等悬停延时),松手收;按住期间压掉系统的长按菜单。鼠标不发触屏事件,桌面上开着也不影响
   *  (右键菜单照旧)。手机端的链接卡用它。 */
  longPress?: boolean
}

const LONG_PRESS_MS = 500

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
    onTouchStart?(e: TouchEvent<HTMLElement>): void
    onTouchMove?(e: TouchEvent<HTMLElement>): void
    onTouchEnd?(e: TouchEvent<HTMLElement>): void
    onTouchCancel?(e: TouchEvent<HTMLElement>): void
    onContextMenu?(e: { preventDefault(): void }): void
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
  // 长按:手指挪开 10px 以上算滚动,不出;出了之后松手就收,并吞掉随后的 click(不然松手即打开链接)。
  const hold = useRef<{ timer: number; x: number; y: number; shown: boolean } | null>(null)
  const endHold = (): { shown: boolean } | null => {
    const h = hold.current
    hold.current = null
    if (h) window.clearTimeout(h.timer)
    return h
  }
  useEffect(() => () => { endHold(); if (trigger.current) hoverCardSurface.drop(trigger.current) }, [])
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
      ...(opts.longPress ? {
        onTouchStart: (e: TouchEvent<HTMLElement>) => {
          endHold()
          const p = e.touches[0]
          if (!p || e.touches.length > 1) return
          const el = e.currentTarget
          trigger.current = el
          const h = { x: p.clientX, y: p.clientY, shown: false, timer: 0 }
          h.timer = window.setTimeout(() => { h.shown = true; hoverCardSurface.focus(el, spec()) }, LONG_PRESS_MS)
          hold.current = h
        },
        onTouchMove: (e: TouchEvent<HTMLElement>) => {
          const h = hold.current
          const p = e.touches[0]
          if (h && !h.shown && p && Math.hypot(p.clientX - h.x, p.clientY - h.y) > 10) endHold()
        },
        onTouchEnd: (e: TouchEvent<HTMLElement>) => {
          if (!endHold()?.shown) return
          e.preventDefault()
          hoverCardSurface.drop(e.currentTarget)
        },
        onTouchCancel: (e: TouchEvent<HTMLElement>) => { if (endHold()?.shown) hoverCardSurface.drop(e.currentTarget) },
        onContextMenu: (e: { preventDefault(): void }) => { if (hold.current) e.preventDefault() }, // 只压按住期间那一次(安卓长按会弹)
      } : {}),
    },
    portal: host && content != null ? createPortal(content, host) : null,
  }
}
