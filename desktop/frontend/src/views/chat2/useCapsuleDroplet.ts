import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import { fadeScaleOpen, openPanel, reducedMotion, zoomOf, type Droplet } from '@lcl/engine'

// 动效 token 从 :root 读(base.css 一份)。这里在 Tangu 界面包里,不能引宿主的 theme/motionTokens(check:tanguboundary)。
const rootVar = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
const rootMs = (name: string, fallback: number): number => {
  const m = /^(-?[\d.]+)(ms|s)$/.exec(rootVar(name))
  return m ? parseFloat(m[1]) * (m[2] === 's' ? 1000 : 1) : fallback
}
const rootCurve = (name: string): string => rootVar(name) || 'ease'

/** Chat Box 底排按钮的菜单从按钮里流出来(2026-11-16 Chat Box 水滴方案,用户选 A;DESIGN §3「液滴展开」)。
 *
 *  一颗按钮开着的菜单有两段寿命,别再挂在同一个 `openMenu === k` 上(第三轮「模式胶囊最后那一下突兀」就是这么来的):
 *  - `expanded`:胶囊撑宽(.is-open)。收起一开始就摘,胶囊跟液体一起缩回去(CSS 读 --cap-close)。
 *  - 菜单挂载 + 窄 Chat View 的让位(.t2c-capsule-held):倒放完才放。让位的按钮收完再淡回来,＋ 只原地淡、位置一直留着。
 *
 *  关法分两种:再点同一颗 / 点空白 / Esc / 面板标题栏的 × = `dismiss()` 倒放;点了一行、换另一颗、外部把菜单关掉
 *  = 调用方照旧把 open 置空,这里直接撤掉液体,菜单走 80ms 退场替身(DESIGN「点一行之后马上有别的事」)。
 *  倒放途中又点同一颗 = `toggle()` 从这一帧掉头(reopen)。
 *
 *  液滴的源不是胶囊本身:胶囊收起时边缩边变窄,液滴每帧重新瞄准它,最后那一滴左右来回跳(试玩页量到)。
 *  源 = 胶囊收起时的那块地方,一个不随胶囊变宽而变的占位(.t2c-drop-src)。 */
export interface CapsuleParts {
  /** 胶囊外层(data-cmenu 那层);占位挂在它里面。 */
  wrap: HTMLElement | null
  /** 胶囊按钮本身。 */
  pill: HTMLElement | null
  /** 菜单面板(挂载、定好位之后)。 */
  panel: HTMLElement | null
  /** 胶囊朝哪边长:'right' = 右缘不动、向左长(模型胶囊)。缺省左缘不动。 */
  grow?: 'left' | 'right'
}

/** 交给自带面板的胶囊组件(＋、模型):它们照旧自己渲染,开合的两段寿命由 Composer2 这一份钩子管。 */
export interface CapsuleControl {
  expanded: boolean
  retracting: boolean
  toggle: () => void
  dismiss: () => void
  panelRef: MutableRefObject<HTMLDivElement | null>
}

interface Active<K> { k: K; d: Droplet; anchor: HTMLElement; panel: HTMLElement }

const PEERS = ':scope > .t2c-capsule-peer:not(.add-pill-wrap), :scope > .t2c-collapse-on-capsule-open'

export function useCapsuleDroplet<K extends string>(
  open: K | null,
  setOpen: (k: K | null) => void,
  parts: (k: K) => CapsuleParts | null,
): {
  /** 正在倒放的那一颗(菜单还挂着、胶囊已经在缩)。 */
  closing: K | null
  /** 胶囊此刻是否撑宽。 */
  expanded: (k: K) => boolean
  /** 倒放收起;没有液体(还没开 / 减少动态效果下也有淡出)时直接关。 */
  dismiss: () => void
  /** 点胶囊:关着 = 开;开着 = 倒放;正在倒放 = 掉头。 */
  toggle: (k: K) => void
} {
  const [closing, setClosing] = useState<K | null>(null)
  const closingRef = useRef<K | null>(null) // 同步读(同一帧连点两下不靠渲染)
  const active = useRef<Active<K> | null>(null)
  const partsRef = useRef(parts)
  partsRef.current = parts
  const setOpenRef = useRef(setOpen)
  setOpenRef.current = setOpen
  const openRef = useRef(open)
  openRef.current = open
  /** 这次开着时被让位藏起来的按钮:收完给它们淡回来。 */
  const yielded = useRef<HTMLElement[]>([])

  const drop = (a: Active<K>): void => {
    a.d.cancel()
    a.anchor.remove()
    a.panel.inert = false
  }

  useLayoutEffect(() => {
    const prev = active.current
    if (prev && prev.k !== open) { drop(prev); active.current = null }
    if (closingRef.current !== null && closingRef.current !== open) { closingRef.current = null; setClosing(null) }
    // 让位的按钮回来:关了,或换成了另一颗(换的那颗会重新藏它要藏的)
    const back = yielded.current.filter((el) => el.isConnected && el.checkVisibility?.() !== false)
    yielded.current = []
    if (back.length && !reducedMotion()) {
      for (const el of back) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: rootMs('--duration-fast', 150), easing: rootCurve('--ease-calm') })
    }
    if (!open || active.current) return
    const p = partsRef.current(open)
    if (!p?.wrap || !p.pill || !p.panel) return
    const row = p.wrap.parentElement
    if (row) yielded.current = Array.from(row.querySelectorAll<HTMLElement>(PEERS)).filter((el) => el !== p.wrap && el.checkVisibility?.() === false)
    // 占位 = 胶囊收起时的样子(此刻胶囊刚挂上 .is-open,宽度过渡还在起点)
    const anchor = document.createElement('span')
    anchor.className = 't2c-drop-src'
    anchor.setAttribute('aria-hidden', 'true')
    const { pill, wrap } = p
    // 相对外层量(不靠 offsetParent:芯片的外层不一定是定位元素);外层是 static 就就地抬成 relative
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative'
    const z = zoomOf(wrap) || 1, wr = wrap.getBoundingClientRect(), pr = pill.getBoundingClientRect()
    const bl = wrap.clientLeft, bt = wrap.clientTop
    Object.assign(anchor.style, {
      top: `${(pr.top - wr.top) / z - bt}px`, height: `${pr.height / z}px`, width: `${pr.width / z}px`,
      borderRadius: getComputedStyle(pill).borderTopLeftRadius,
      ...(p.grow === 'right' ? { right: `${(wr.right - pr.right) / z - bl}px` } : { left: `${(pr.left - wr.left) / z - bl}px` }),
    })
    wrap.appendChild(anchor)
    // 液滴按「此刻量到的面板矩形」长:浮层(OverlayAt / 吸附锚点)常在自己的 layout effect 里 setState 再定一次位,
    // React 在本次提交末尾同步重渲 —— 等到微任务(还没画出任何一帧)再开流,量到的才是最终位置
    const k = open
    queueMicrotask(() => {
      if (openRef.current !== k || active.current) { anchor.remove(); return }
      const panel = partsRef.current(k)?.panel
      if (!panel?.isConnected) { anchor.remove(); return }
      active.current = { k, d: openPanel(anchor, panel), anchor, panel }
    })
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (active.current) drop(active.current) }, [])

  const dismiss = useCallback((): void => {
    const a = active.current
    if (!a) { setOpenRef.current(null); return }
    if (closingRef.current === a.k) return
    closingRef.current = a.k
    setClosing(a.k)
    a.panel.inert = true
    void a.d.retract().then(() => {
      if (active.current !== a || closingRef.current !== a.k) return
      closingRef.current = null
      setOpenRef.current(null)
    })
  }, [])
  const toggle = useCallback((k: K): void => {
    const a = active.current
    if (a?.k === k && closingRef.current === k) {
      // 倒放途中又点同一颗:从这一帧掉头、停在打开
      if (a.d.reopen?.()) { closingRef.current = null; a.panel.inert = false; setClosing(null); return }
      drop(a); active.current = null; closingRef.current = null; setClosing(null)
      setOpenRef.current(null)
      requestAnimationFrame(() => setOpenRef.current(k))
      return
    }
    if (a?.k === k || (!a && open === k)) { dismiss(); return }
    setOpenRef.current(k)
  }, [dismiss, open])

  return { closing, expanded: (k) => open === k && closing !== k, dismiss, toggle }
}

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

/** 液滴收起曲线(--droplet-retract-ease;读不到就用展开曲线,只是不够顺)。 */
const retractEase = (): string => rootVar('--droplet-retract-ease') || rootCurve('--ease-surface')

/** 麦克风 → 录音条(方案 3.3):麦克风那颗圆钮拉成一条带浅底的胶囊(录音条本身就是那滴液体,按裁切长开),
 *  内容 0.22D 后露出;录完(转写也完了)= 倒放缩回麦克风那块地方,再卸掉录音条、别的按钮淡回来。
 *  时间轴照抄液滴:展开 --droplet-duration × --ease-surface,倒放 0.7 倍 × --droplet-retract-ease。
 *  减少动态效果 / 只淡入淡出:直接换。不是面板,openPanel 不管这条。
 *  `shown`:录音条要不要挂着(倒放那段 active 已经是 false);`fromMic(el)`:点麦克风时记下它的位置(没记 = 从录音条右端一颗圆钮长开)。 */
export function useVoiceBarFlow(active: boolean, root: RefObject<HTMLElement | null>): { shown: boolean; fromMic: (el: HTMLElement) => void } {
  const [lingering, setLingering] = useState(false)
  const mic = useRef<DOMRect | null>(null)
  const anims = useRef<Animation[]>([])
  const fadeBack = useRef(false)
  const clipAt = (bar: HTMLElement, b: DOMRect): string => {
    const z = zoomOf(bar) || 1
    const m = mic.current ?? new DOMRect(b.right - b.height, b.top, b.height, b.height)
    const top = Math.max(0, m.top - b.top), bottom = Math.max(0, b.bottom - m.bottom)
    const left = Math.max(0, m.left - b.left), right = Math.max(0, b.right - m.right)
    return `inset(${top / z}px ${right / z}px ${bottom / z}px ${left / z}px round 999px)`
  }
  useLayoutEffect(() => {
    const bar = root.current?.querySelector<HTMLElement>('.t2c-row > .t2c-voicebar') ?? null
    anims.current.forEach((a) => a.cancel())
    anims.current = []
    const kids = bar ? (Array.from(bar.children) as HTMLElement[]) : []
    if (active) {
      setLingering(true)
      if (!bar || reducedMotion() || typeof bar.animate !== 'function') return
      const D = rootMs('--droplet-duration', 420), surface = rootCurve('--ease-surface')
      anims.current = [
        bar.animate([{ clipPath: clipAt(bar, bar.getBoundingClientRect()) }, { clipPath: 'inset(0px round 999px)' }], { duration: D, easing: surface }),
        ...kids.map((k) => k.animate([{ opacity: 0 }, { opacity: 1 }], { delay: D * 0.22, duration: D * 0.3, easing: surface, fill: 'backwards' })),
      ]
      return
    }
    if (!lingering) return
    if (!bar || reducedMotion() || typeof bar.animate !== 'function') { fadeBack.current = true; setLingering(false); return }
    const D = rootMs('--droplet-duration', 420) * 0.7
    const shrink = bar.animate([{ clipPath: 'inset(0px round 999px)' }, { clipPath: clipAt(bar, bar.getBoundingClientRect()) }],
      { duration: D, easing: retractEase(), fill: 'forwards' })
    anims.current = [shrink, ...kids.map((k) => k.animate([{ opacity: 1 }, { opacity: 0 }], { duration: D * 0.4, fill: 'forwards' }))]
    shrink.finished.then(() => { fadeBack.current = true; setLingering(false) }, () => {})
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps
  // 录音条卸了:让开的按钮淡回来(＋ 一直在,不动)
  useLayoutEffect(() => {
    if (lingering || !fadeBack.current) return
    fadeBack.current = false
    mic.current = null
    if (reducedMotion()) return
    const row = root.current?.querySelector('.t2c-row')
    for (const el of Array.from(row?.children ?? []) as HTMLElement[]) {
      if (!el.classList.contains('add-pill-wrap')) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: rootMs('--duration-fast', 150), easing: rootCurve('--ease-calm') })
    }
  }, [lingering])
  useEffect(() => () => { anims.current.forEach((a) => a.cancel()) }, [])
  return { shown: active || lingering, fromMic: (el) => { mic.current = el.getBoundingClientRect() } }
}
