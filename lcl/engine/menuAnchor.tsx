/**
 * 视口锚定浮层的唯一真源(右键菜单 / slash 菜单 / 补全 / 弹出层 / sash 刻度…)。
 *
 * 【为什么必须有这个文件】所有这类浮层都是 `position: fixed` + 视口坐标(clientX/clientY、
 * getBoundingClientRect、ProseMirror coordsAtPos)。但**祖先的 CSS zoom 会把 fixed 的 left/top
 * 再乘一遍** —— 实测 body{zoom:1.5} 下 `left:100px` 落在视口 150px 处,而 `offsetWidth` 仍是未缩放
 * 的局部 px(rect.width 才是 ×1.5 的视口 px)。于是浮层「离视口原点越远偏得越多」,肉眼就是
 * 「菜单和鼠标/光标明显对不上」。Forsion 的 zoom 常年非 1:uiZoom 网页端 1.1 / 触屏 1.15、
 * singleColumn 的 .mini-shell .mb-main 0.85。桌面 Electron 默认 1 → 开发机上完全看不见。
 *
 * 【定则】视口坐标 x 要落地 → 写 `left: x / 元素自身的 currentCSSZoom`;跟视口尺寸比大小前,
 * 局部 px 先 `× zoom`。别自己再写一遍,一律走这里。仪器:`npm run check:overlay`。
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode, type RefObject } from 'react'

/** 端级 UI 缩放变更事件:改 zoom 不会触发 window.resize,浮层收不到通知就会停在按旧 zoom 算的位置。
 *  由 app 的 uiZoom.apply() 派发(引擎不反向依赖 app,只约定事件名)。 */
export const UI_ZOOM_EVENT = 'forsion:uizoom'

/** 元素的累计 CSS zoom(自身 + 全部祖先)。浮层自己不设 zoom,故 = 祖先累计缩放。 */
export function zoomOf(el: Element | null | undefined): number {
  return (el as (Element & { currentCSSZoom?: number }) | null | undefined)?.currentCSSZoom || 1
}

/** clampMenu / useClampedMenu / OverlayAt 共用的落位选项。 */
export interface AnchorOpts {
  /** 锚点上沿(视口 px):往上展开时菜单底贴它。缺省 = y(在鼠标/光标处翻面)。 */
  anchorTop?: number
  /** 首选方向:'below'(默认,锚点下方展开)/ 'above'(锚点上方,放不下再翻到下方)。 */
  prefer?: 'below' | 'above'
  /** 水平以 x 为中心(行内工具栏那种居中浮条),缺省是左对齐 x。 */
  center?: boolean
  margin?: number
}

/**
 * 视口内夹取,全部参数与返回值都是**视口 px**。
 * - 横向:溢出就收进屏幕(不翻面);`center` 时先以 x 为中心再收。
 * - 纵向:按 prefer 先试首选方向,放不下就试另一侧,两侧都放不下才夹取。
 */
export function clampMenu(
  x: number,
  y: number,
  w: number,
  h: number,
  vw: number,
  vh: number,
  opts: AnchorOpts = {},
): { left: number; top: number } {
  const { anchorTop = y, prefer = 'below', center = false, margin = 8 } = opts
  const left = Math.max(margin, Math.min(center ? x - w / 2 : x, vw - w - margin))
  const fits = (t: number): boolean => t >= margin && t + h <= vh - margin
  const below = y
  const above = anchorTop - h
  const order = prefer === 'above' ? [above, below] : [below, above]
  for (const t of order) if (fits(t)) return { left, top: t }
  // 两侧都放不下(菜单比视口还高 / 锚点在视口外):退回夹取首选方向的那个候选。
  return { left, top: Math.max(margin, Math.min(order[0], vh - h - margin)) }
}

/** 挂在 fixed 浮层根上:量真实尺寸 → 夹取/翻面 → 反补偿 zoom。useLayoutEffect 在绘制前定位,故无闪。
 *  内容变高(异步加载完、筛选)由 ResizeObserver 兜住 —— 故**不需要**调用方传 deps。 */
export function useClampedMenu(x: number, y: number, opts: AnchorOpts = {}): {
  ref: RefObject<HTMLDivElement | null>
  style: CSSProperties
} {
  const { anchorTop, prefer, center, margin = 8 } = opts
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y, maxWidth: undefined as number | undefined })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const apply = (): void => {
      const z = zoomOf(el)
      // offsetWidth/Height = 未缩放局部 px(且不含 pop-in 的 scale 动画)→ ×z 换到视口 px 再比。
      const vw = window.innerWidth
      const wV = el.offsetWidth * z
      const v = clampMenu(x, y, wV, el.offsetHeight * z, vw, window.innerHeight, { anchorTop, prefer, center, margin })
      // 比视口还宽(窄屏 × 固定宽度浮层):夹取只能贴左边、右边照样被裁 → 给个局部 px 的上限。
      const maxWidth = wV > vw - 2 * margin ? (vw - 2 * margin) / z : undefined
      setPos((prev) => {
        const next = { left: v.left / z, top: v.top / z, maxWidth }
        return prev.left === next.left && prev.top === next.top && prev.maxWidth === next.maxWidth ? prev : next
      })
    }
    apply()
    window.addEventListener('resize', apply) // 开着菜单缩窗口时重夹,防跑出屏
    window.addEventListener(UI_ZOOM_EVENT, apply) // 端级 zoom 改了不发 resize,须单独收
    const ro = new ResizeObserver(apply) // 内容异步长高(如共享卡拉到参与者列表)后重新定位
    ro.observe(el)
    return () => {
      window.removeEventListener('resize', apply)
      window.removeEventListener(UI_ZOOM_EVENT, apply)
      ro.disconnect()
    }
  }, [x, y, anchorTop, prefer, center, margin])
  return { ref, style: { left: pos.left, top: pos.top, maxWidth: pos.maxWidth } }
}

/** 一行接入版:把 `style={{ left: x, top: y }}` 换成 `<OverlayAt x={x} y={y} className=…>`。 */
export function OverlayAt({
  x,
  y,
  anchorTop,
  prefer,
  center,
  margin,
  innerRef,
  className,
  style,
  children,
  ...rest
}: {
  x: number
  y: number
  anchorTop?: number
  prefer?: 'below' | 'above'
  center?: boolean
  margin?: number
  /** 调用方也要拿这个 DOM(如判定「点在菜单外」)时传进来;内部定位仍用自己的 ref。 */
  innerRef?: (el: HTMLDivElement | null) => void
  className?: string
  style?: CSSProperties
  children?: ReactNode
} & Omit<HTMLAttributes<HTMLDivElement>, 'style' | 'className' | 'children'>) {
  const p = useClampedMenu(x, y, { anchorTop, prefer, center, margin })
  return (
    <div
      ref={(el) => {
        p.ref.current = el
        innerRef?.(el)
      }}
      className={className}
      style={{ ...style, ...p.style }}
      {...rest}
    >
      {children}
    </div>
  )
}
