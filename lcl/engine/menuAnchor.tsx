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
import React, { useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode, type RefObject } from 'react'

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
  /** 右缘对齐 x(「⋯」按钮下方往左展开的菜单),缺省是左缘对齐 x。 */
  alignEnd?: boolean
  margin?: number
  /** 横向夹取的左右边界(视口 px),缺省 = 视口。笔记的划线菜单夹在编辑器面板里,不伸到文件树上;
   *  边界比浮层还窄时退回视口。纵向照旧按视口。 */
  boundLeft?: number
  boundRight?: number
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
  const { anchorTop = y, prefer = 'below', center = false, alignEnd = false, margin = 8, boundLeft, boundRight } = opts
  let lo = Math.max(0, boundLeft ?? 0)
  let hi = Math.min(vw, boundRight ?? vw)
  if (hi - lo < w + 2 * margin) { lo = 0; hi = vw }
  const left = Math.max(lo + margin, Math.min(center ? x - w / 2 : alignEnd ? x - w : x, hi - w - margin))
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
  const { anchorTop, prefer, center, alignEnd, margin = 8, boundLeft, boundRight } = opts
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
      const v = clampMenu(x, y, wV, el.offsetHeight * z, vw, window.innerHeight, { anchorTop, prefer, center, alignEnd, margin, boundLeft, boundRight })
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
  }, [x, y, anchorTop, prefer, center, alignEnd, margin, boundLeft, boundRight])
  return { ref, style: { left: pos.left, top: pos.top, maxWidth: pos.maxWidth } }
}

/**
 * 「CSS 已经把位置定好、只是会掉出边界」那类浮层的横向兜底 —— 锚在按钮上的 `position:absolute`
 * 菜单(聊天输入区的 add / mode 菜单、ModelPill 的两级菜单、ProjectSelector…)。
 *
 * 【为什么不直接改成 fixed 走 useClampedMenu】聊天区自上而下三层 `container-type: inline-size`
 * (`.t2-chat-view` / `.t2-chat-col` / `.t2c-card`)。container-type 蕴含 `contain: layout`,
 * 而 layout containment 会让元素成为 **fixed 后代的包含块** —— 菜单一改 fixed 就锚到卡片而不是视口,
 * 还得连带 portal 出去,而 portal 又会打断 `closest('[data-cmenu]')` / `wrapRef.contains()` 那套
 * 「点外面关菜单」判定(第一下 mousedown 就把菜单关了 = 用户眼里的「点了没反应」)。
 * 所以这里只做最小事:量真实矩形,溢出就横向推回来,比可用边界还宽再给 max-width。
 * 默认边界是 viewport；Chatbox 等嵌在 Dock View 里的浮层传 `boundary`，不能借相邻 View 的空间。
 *
 * 【为什么用 `translate` 而不是 `transform`】这些菜单的入场动画 `@keyframes pop` 正动着 transform,
 * 写 inline transform 头 160ms 会被它覆盖;`translate` 是独立属性,与 transform 叠加不打架。
 * 【zoom】rect 是视口 px,写回样式是局部 px(手机 body zoom 恒 1.15)→ 一律除 zoomOf。
 */
/**
 * useEdgeNudge 的纯算术部分(仪器打在这里,见 menuAnchor.test.ts)。
 * 入参 left/width/vw 全是**视口 px**;返回的 dx / maxWidth 是**局部 px**(可直接写进 style)。
 * @returns dx 需要横向推移多少(0 = 已经在屏内);maxWidth 仅在浮层比可用宽度还宽时给出。
 */
export function edgeNudge(
  left: number,
  width: number,
  vw: number,
  zoom: number,
  margin = 8,
): { dx: number; maxWidth?: number } {
  // 隐藏中的浮层(display:none → rect 全零)必须原样返回:否则 left=0 < margin 会被当成「掉出左边」,
  // 白推一个 margin/zoom 的偏移进去,一显示就整体歪掉(`.t2c-ctxring-pop` 就是 display:none + hover 显示)。
  // 显示的那一刻尺寸从 0 变真,useEdgeNudge 的 ResizeObserver 会再夹一次,不会漏夹。
  if (width <= 0) return { dx: 0 }
  const avail = vw - 2 * margin
  const tooWide = width > avail
  const w = tooWide ? avail : width
  let dx = 0
  if (left < margin) dx = margin - left
  else if (left + w > vw - margin) dx = vw - margin - w - left
  return { dx: dx / zoom, maxWidth: tooWide ? avail / zoom : undefined }
}

/**
 * 二级面板相对一级面板的横向落位。所有坐标都是视口 px；panelWidth / gap / margin
 * 是元素局部 px，内部统一乘累计 zoom 后再比较。边界可以是整个 viewport，也可以是某个 View / 卡片。
 * 两侧都放不下时返回 stacked，由调用方把二级面板叠到一级面板上方。
 */
export type NestedPanelPlacement = 'right' | 'left' | 'stacked'
export function nestedPanelPlacement(
  anchorLeft: number,
  anchorRight: number,
  panelWidth: number,
  boundaryLeft: number,
  boundaryRight: number,
  zoom = 1,
  gap = 6,
  margin = 8,
): NestedPanelPlacement {
  const widthV = panelWidth * zoom
  const gapV = gap * zoom
  const marginV = margin * zoom
  if (anchorRight + gapV + widthV <= boundaryRight - marginV) return 'right'
  if (anchorLeft - gapV - widthV >= boundaryLeft + marginV) return 'left'
  return 'stacked'
}

/**
 * 二级面板在一级菜单内的纵向偏移（局部 CSS px）。优先让面板顶边贴住触发行；若会越过
 * 一级菜单底边或 View 边界则向上夹住。这样靠上的入口不会把短面板甩到菜单最底部，
 * 靠下的入口和长列表仍不会压住输入区。
 */
export function nestedPanelTop(
  anchorTop: number,
  panelHeight: number,
  menuTop: number,
  menuBottom: number,
  boundaryTop: number,
  boundaryBottom: number,
  zoom = 1,
  margin = 8,
): number {
  const safeZoom = zoom > 0 ? zoom : 1
  const marginV = margin * safeZoom
  const minTop = boundaryTop + marginV
  const maxBottom = Math.min(menuBottom, boundaryBottom - marginV)
  const maxTop = Math.max(minTop, maxBottom - panelHeight * safeZoom)
  const top = Math.min(Math.max(anchorTop, minTop), maxTop)
  return (top - menuTop) / safeZoom
}

interface EdgeNudgeOptions {
  margin?: number
  /** 除 viewport 外再收进最近的容器边界，例如 Chat View。找不到时自动回退 viewport。 */
  boundary?: string
}

/** @param active 假值 = 关闭(清零);真值同时**兼作重算依赖** —— 调用方把会挪动浮层的状态编进去
 *  (如 ModelPill 的 `${pane}:${flip}`),翻面之后才会重新夹取。 */
export function useEdgeNudge(
  active: string | number | boolean | null | undefined,
  options: number | EdgeNudgeOptions = 8,
): {
  ref: RefObject<HTMLDivElement | null>
  style: CSSProperties
} {
  const margin = typeof options === 'number' ? options : (options.margin ?? 8)
  const boundarySelector = typeof options === 'number' ? undefined : options.boundary
  const ref = useRef<HTMLDivElement>(null)
  const [fix, setFix] = useState<{ dx: number; maxWidth?: number }>({ dx: 0 })
  useLayoutEffect(() => {
    if (!active) return setFix((p) => (p.dx === 0 && p.maxWidth === undefined ? p : { dx: 0 }))
    const el = ref.current
    if (!el) return
    const apply = (): void => {
      const z = zoomOf(el)
      // 先撤掉上一次的推移和收窄再量,否则每次都在已推过的位置上再推一遍(自我叠加,菜单会一路飞出去);
      // 收窄不撤的话,量到的是收窄后的宽 → 判「放得下」→ 撤掉收窄 → 变宽又放不下,ResizeObserver 来回翻(边界比浮层窄时闪)。
      const prev = el.style.translate, prevMax = el.style.maxWidth
      el.style.translate = ''
      el.style.maxWidth = ''
      const r = el.getBoundingClientRect()
      const ow = el.offsetWidth
      el.style.translate = prev
      el.style.maxWidth = prevMax
      // ⚠️ 这里跑在 useLayoutEffect,而入场动画 `@keyframes pop` 正 `scale(0.97)` 着 —— rect 会**偏窄**,
      // 于是刚好溢出的菜单被判成「放得下」,dx=0,动画结束一还原就露在屏幕外(实测:390 屏上模式菜单
      // 量到 357 宽判定通过,实际 368 宽、右缘 387.5 已经出界)。offsetWidth 不吃 transform,是未缩放的
      // 真实宽(局部 px,×zoom 换到视口 px);pop 只有 translateY,缩放中心横向不动,故用 rect 中线还原左缘。
      const w = ow * z
      const boundary = boundarySelector ? el.closest(boundarySelector)?.getBoundingClientRect() : undefined
      const boundaryLeft = boundary?.left ?? 0
      const boundaryRight = boundary?.right ?? window.innerWidth
      const localLeft = (r.left + r.right) / 2 - w / 2 - boundaryLeft
      const { dx, maxWidth } = edgeNudge(localLeft, w, boundaryRight - boundaryLeft, z, margin)
      setFix((p) => (Math.abs(p.dx - dx) < 0.5 && p.maxWidth === maxWidth ? p : { dx, maxWidth }))
    }
    apply()
    // 兜住「动画不止 translateY」的将来:入场动画放完再夹一次(尺寸没变时 setFix 会自己短路)。
    void Promise.allSettled(el.getAnimations().map((a) => a.finished)).then(() => { if (ref.current === el) apply() })
    window.addEventListener('resize', apply)
    window.addEventListener(UI_ZOOM_EVENT, apply)
    const ro = new ResizeObserver(apply) // 内容异步长出来(模型列表拉完)后重量
    ro.observe(el)
    const boundaryEl = boundarySelector ? el.closest(boundarySelector) : null
    if (boundaryEl) ro.observe(boundaryEl)
    return () => {
      window.removeEventListener('resize', apply)
      window.removeEventListener(UI_ZOOM_EVENT, apply)
      ro.disconnect()
    }
  }, [active, margin, boundarySelector])
  return { ref, style: { translate: fix.dx ? `${fix.dx}px` : undefined, maxWidth: fix.maxWidth } }
}

/**
 * 浮层退场(DESIGN §3「动效」):条件渲染的浮层一关就从 DOM 里没了,来不及放退场。这里在卸载那一刻拷一份「替身」
 * 留在原处放完退场再摘 —— 调用方不用改成延迟卸载。
 *
 * - 有没有退场、怎么退由 CSS 决定:替身带 `data-lcl-exit`,命中了退场规则(base.css 那张名单)就放完再摘;
 *   没命中(没有动画)就立刻摘,等于原样。仪器 `check:motion` 钉着进场名单 == 退场名单。
 * - 卸载时父节点可能一起被拆(Ribbon 的 backdrop 包着菜单):替身落进**还在的最近祖先**,作用域类(`.am-app`…)和变量照旧;
 *   拆掉的那几层浅拷一份套在外面(透明、不吃指针),层叠上下文与原来相同。
 * - 替身 inert + aria-hidden + 不吃指针:读屏、焦点、点击都只认真菜单;输入框的值手动带上(cloneNode 不拷 value)。
 * - 组件常驻、靠 `open` 决定画不画的(命令面板、⌘P)传 open:翻成 false 时同样留替身。
 */
export function useExitGhost(ref: RefObject<HTMLElement | null>, open = true): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!open || !el) return
    // 祖先链在挂上时就记下:open 翻成 false 那一次,清理跑在 React 摘掉节点之后(卸载那一次则在之前)。
    const chain: Element[] = []
    for (let p = el.parentElement; p; p = p.parentElement) chain.push(p)
    return () => {
      const next = el.isConnected ? el.nextSibling : null
      const ghost = el.cloneNode(true) as HTMLElement
      const src = el.querySelectorAll('input, textarea')
      ghost.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea').forEach((g, i) => { g.value = (src[i] as HTMLInputElement | undefined)?.value ?? g.value })
      ghost.removeAttribute('id')
      ghost.setAttribute('aria-hidden', 'true')
      ghost.setAttribute('data-lcl-exit', '')
      ghost.inert = true
      ghost.style.pointerEvents = 'none'
      queueMicrotask(() => {
        if (el.isConnected) return // 没真卸(StrictMode 的演习卸载、换 key 前后同位)
        const hostAt = chain.findIndex((p) => p.isConnected)
        if (hostAt < 0) return
        const host = chain[hostAt]
        // 一起被拆的那几层(Ribbon 的 backdrop)照原样套回去,只当定位 / 层叠的壳:不上色、不动画、不吃指针。
        // 少了它,替身落进 .rb 的层叠上下文,会被旁边的侧栏盖住(10-23 实拍)。
        let outer: Element = ghost
        for (const w of chain.slice(0, hostAt)) {
          const shell = w.cloneNode(false) as HTMLElement
          shell.removeAttribute('id')
          shell.setAttribute('aria-hidden', 'true')
          shell.inert = true
          Object.assign(shell.style, { background: 'none', boxShadow: 'none', backdropFilter: 'none', border: '0', animation: 'none', pointerEvents: 'none' })
          shell.appendChild(outer)
          outer = shell
        }
        host.insertBefore(outer, next?.parentNode === host ? next : null)
        const anims = ghost.getAnimations?.() ?? []
        if (!anims.length) { outer.remove(); return }
        void Promise.allSettled(anims.map((a) => a.finished)).then(() => outer.remove())
      })
    }
  }, [ref, open])
}

/** 一行接入版:把 `style={{ left: x, top: y }}` 换成 `<OverlayAt x={x} y={y} className=…>`。关掉时放退场(useExitGhost)。 */
export function OverlayAt({
  x,
  y,
  anchorTop,
  prefer,
  center,
  alignEnd,
  margin,
  boundLeft,
  boundRight,
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
  alignEnd?: boolean
  margin?: number
  boundLeft?: number
  boundRight?: number
  /** 调用方也要拿这个 DOM(如判定「点在菜单外」)时传进来;内部定位仍用自己的 ref。 */
  innerRef?: (el: HTMLDivElement | null) => void
  className?: string
  style?: CSSProperties
  children?: ReactNode
} & Omit<HTMLAttributes<HTMLDivElement>, 'style' | 'className' | 'children'>) {
  const p = useClampedMenu(x, y, { anchorTop, prefer, center, alignEnd, margin, boundLeft, boundRight })
  useExitGhost(p.ref)
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
