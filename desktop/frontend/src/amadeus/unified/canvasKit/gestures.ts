/**
 * 画布手势状态机(View 基座方案 §6.4 S3)—— 对**一组带 key 的矩形**泛化。
 *
 * 覆盖:空白框选 / 单选与 Shift 加减选 / 多选刚体拖动 / 八向调整尺寸 / 点阵吸附 / 松手排斥 /
 * 双击 / 右键与长按菜单 / 触屏双指平移缩放 / 键盘(删除·方向键微移·Esc·空格进编辑·全选)。
 *
 * 调用方只需给一个 `GestureAdapter`:盒子从哪来、落笔往哪去、DOM 命中怎么判。渲染完全归调用方
 * (手势期的临时几何经返回值 `live` 给出),所以这套东西对「卡片 DOM 归谁所有」不做任何假设 ——
 * 那正是 canvasStage 里 dragCss / pmOwns 那一堆东西存在的原因,它们**刻意留在那边**。
 *
 * 几条踩过的纪律,别退回去:
 *  · 起手这一笔要记 **owner pointerId**(在 capture 里记)。不记的话:第一根手指在拖卡、第二根落在
 *    chrome 上抬起,冒泡到舞台就把第一根的拖拽提前落笔(Codex 2026-08-23)。
 *  · 第二根手指落下 → `abort`(cancel 语义,**绝不落笔**),且全部抬起前不回单指逻辑。
 *  · 触屏 slop 是**屏幕像素**,进 onDown 时才 ÷(z × 页面 zoom);写死舞台单位会在缩小后把
 *    「点一下」判成拖动(08-23 实证)。
 *  · 捏合基线记 pointerId 对,换手就重建基线。
 *  · 卡内可交互控件(button/a/input/…)一律放行:pointerdown 一 preventDefault,浏览器就不补发
 *    mousedown/click(08-21 实证),点不动是这么来的。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { zoomOf } from '@lcl/engine'
import { resolveCardRepulsion } from '../canvasGeometry'
import {
  CLICK_SLOP, LONG_PRESS_MS, NUDGE, PRESS_SLOP, TOUCH_SLOP, boxFromPoints,
  marqueeHit, resizeBox, snapGrid, type Box, type ResizeEdge,
} from './geometry'
import type { CanvasViewportApi } from './viewport'
import { clampZ } from './viewport'

/** 卡内**可交互控件**:点它的语义是「用这个控件」,不是「选中或拖动这张卡」。 */
export const CARD_CTL = 'button, a[href], input, select, textarea, [contenteditable="true"]'
/** chrome 层(缩放胶囊/缩略图/菜单):手势一概不接管。 */
export const STAGE_CHROME = '.amx-stage-hud, .amx-stage-minimap, .amx-stage-tools, .ctx-menu, .dash-add-menu, .dash-menu-scrim'

export interface GestureAdapter {
  /** 当前全部可操作盒子(舞台坐标)。每次手势起手时现读 —— 不缓存。 */
  boxes(): Map<string, Box>
  /** 落笔。`next` 只含被这次手势改动的键。 */
  commit(next: Map<string, Box>): void
  /**
   * 可选的在途几何约束。返回值会同时用于屏幕上的 `live` 几何与最终落笔，所以有限画布可以在
   * 指针仍按着时就截住边界，而不是松手后才突然跳回去。移动含方向键微移；缩放额外给出手柄边。
   */
  constrain?(next: Map<string, Box>, op: { kind: 'move' } | { kind: 'resize'; key: string; edge: ResizeEdge }): Map<string, Box>
  /** 有限画布的防穿透候选也必须落在这张边界里；无限 Canvas 缺省不传。 */
  repelBounds?: Box
  /** 松手位置与最终吸附位置不同时，让渲染层播放与 Canvas 同款的 settle。 */
  onSettle?(from: Map<string, Box>, to: Map<string, Box>, kind: 'snap' | 'repel'): void
  /** DOM 目标属于哪张卡?null = 空白。 */
  hitKey(target: HTMLElement): string | null
  /** 目标是调整尺寸的手柄吗?给出它调的是哪条边。 */
  hitEdge?(target: HTMLElement): ResizeEdge | null
  onDoubleClick?(key: string | null, at: { x: number; y: number }): void
  onContextMenu?(key: string | null, at: { x: number; y: number; clientX: number; clientY: number }): void
  onDelete?(keys: string[]): void
  /** 选中后按空格 = 进这张卡的交互态(与画布「空格进编辑」同构)。 */
  onEnterEdit?(key: string): void
  /** 这张卡正处在交互态(卡内容自己收事件)→ 手势层整个让路:不 preventDefault、不选、不拖。
   *  与 canvasStage 的 `editing` 同构,也是 08-21 那口坑的正解(让路,而不是在卡里拦事件)。 */
  isEditing?(key: string): boolean
  /**
   * **这一笔手势属于谁**(通常 = 文件路径 + 装载序号)。起手时记一份,落笔前逐字复核,不一致就整笔
   * 作废 —— **绝不落到别人的文件上**。
   *
   * ⚠️ 为什么路径守卫不够(Codex 2026-08-25):拖拽基线活在起手那一刻的闭包里,而 `commit` 走的是
   * **实时** adapter。同一个 leaf 在拖拽期间就地换到另一份仪表盘,松手时 `commit` 已经是新页那份;
   * 块 id 通常都从 1 起,新页的「这个 id 存在吗 / activePage 对不对」两道检查**都会通过** ——
   * 于是旧页的几何被写进了新页。A→B→A 重载(路径没变但已是另一份文档)同样绕得过去。
   */
  identity?(): unknown
  /** 锁定 = 只能看与导航:选择/拖动/缩放/删除全部停用。 */
  locked?: boolean
  minW: number
  minH: number
  /** 松手后把重叠的卡推开(与画布同款);关掉则允许叠放。 */
  repel?: boolean
}

export interface GestureApi {
  sel: string[]
  setSel: (next: string[]) => void
  /** 手势期的临时几何(渲染时覆盖在真布局上)。 */
  live: Map<string, Box> | null
  /** 框选矩形(舞台坐标),渲染成一个半透明框。 */
  marquee: Box | null
  /** 正在拖 / 正在缩放。 */
  busy: boolean
  /** 挂到舞台宿主上;返回卸载函数。 */
  bind: (host: HTMLElement | null) => () => void
}

type DragBase = { id: number; x0: number; y0: number; live: boolean; who: unknown }
type Drag =
  | (DragBase & { kind: 'pan'; vx: number; vy: number })
  | (DragBase & { kind: 'move'; keys: string[]; base: Map<string, Box>; slop: number })
  | (DragBase & { kind: 'size'; key: string; edge: ResizeEdge; b0: Box; slop: number })
  | (DragBase & { kind: 'marquee'; sx: number; sy: number; additive: boolean; base: string[] })

export function useCanvasGestures(
  hostRef: React.RefObject<HTMLElement | null>,
  view: CanvasViewportApi,
  adapter: GestureAdapter,
  snapEnabled: boolean,
): GestureApi {
  const [sel, setSelState] = useState<string[]>([])
  const [live, setLive] = useState<Map<string, Box> | null>(null)
  const [marquee, setMarquee] = useState<Box | null>(null)
  const [busy, setBusy] = useState(false)

  // ⚠️ 手势处理器住在只挂一次的 effect 里,读 state 拿到的是**上一次渲染**那份 —— 同一帧里发生
  //    两下(框选完立刻按删除)时后一下会看到前一下之前的值。故选中与 adapter 一律 ref+state 同写。
  const selRef = useRef<string[]>([])
  const setSel = useCallback((next: string[]): void => { selRef.current = next; setSelState(next) }, [])
  const aRef = useRef(adapter)
  aRef.current = adapter
  const snapRef = useRef(snapEnabled)
  snapRef.current = snapEnabled
  // ⚠️ **视口也必须走 ref**。`view` 每次渲染都是新对象(里头有 `vp`),把它放进 `bind` 的依赖里
  //    就等于「每渲染一次就重挂一次监听」—— 而重挂会连同闭包里的 `drag` 一起清掉:onDown 里
  //    setSel 一触发渲染,起手那一笔当场蒸发,现象是**拖不动**(2026-08-25 实测,check:dashboard
  //    的 D4/D5/D6 全红)。合成事件测不出来:它们不经过 React 的渲染循环。
  const viewRef = useRef(view)
  viewRef.current = view

  // 选中的卡被删掉 → 从选区里摘掉(否则删除键会去删已经不存在的键)。
  useEffect(() => {
    if (!selRef.current.length) return
    const boxes = adapter.boxes()
    const kept = selRef.current.filter((k) => boxes.has(k))
    if (kept.length !== selRef.current.length) setSel(kept)
  })

  const bind = useCallback((host: HTMLElement | null) => {
    if (!host) return () => {}
    const A = (): GestureAdapter => aRef.current
    const V = (): CanvasViewportApi => viewRef.current
    /** 当下这一笔归谁(缺省 = 调用方不关心身份,恒相等)。**按引用比**,所以调用方可以直接把
     *  「整页装载身份」那种对象交出来,不必自己编码成字符串。 */
    const whoNow = (): unknown => A().identity?.() ?? null
    const release = (id: number): void => { try { if (host.hasPointerCapture(id)) host.releasePointerCapture(id) } catch { /* 无所谓 */ } }
    let drag: Drag | null = null
    /** 手势期几何的**权威副本**。只靠 `live` state 会差一帧:同一 tick 里 move→up 时,
     *  最后一次 setLive 还没渲染,落笔就会写成上一帧的位置。 */
    let liveNow: Map<string, Box> | null = null
    const putLive = (v: Map<string, Box> | null): void => { liveNow = v; setLive(v) }
    /** 触屏触点表(pointerId → 屏幕坐标)。双指手势与幽灵手指兜底都靠它。 */
    const touches = new Map<number, { x: number; y: number }>()
    let pinch: { ids: string; d: number; cx: number; cy: number; anchor: { x: number; y: number }; z: number } | null = null
    let press: { t: number; x: number; y: number; id: number; timer: number } | null = null

    const stageOf = (e: PointerEvent | MouseEvent): { x: number; y: number } => V().toStage(e.clientX, e.clientY)
    const unit = (): number => (zoomOf(host) || 1) * V().vpRef.current.z

    const clearPress = (): void => {
      if (!press) return
      clearTimeout(press.timer)
      press = null
    }

    /** 手势被别的东西接管:只回滚外观,**绝不落笔**。 */
    const abort = (): void => {
      drag = null
      putLive(null)
      setMarquee(null)
      setBusy(false)
    }

    /**
     * 把这一层的**全部**在途状态清干净:在途手势、临时几何、框选、长按计时器、触点表、
     * 捏合基线、指针捕获。
     *
     * ⚠️ 光调 `abort()` 不够(Codex 2026-08-25):它不清 `touches` / `pinch` / `press`。窗口失焦时
     * 手指还按着 → 触点表里留下幽灵 id,而 `onWinUp` 又要求 drag 还在,迟到的 pointerup 清不掉它
     * —— 下一次单指触摸会被当成「第二根手指」直接进捏合。卸载监听同理:不清就把临时几何留在屏上。
     */
    const resetGesture = (): void => {
      clearPress()
      for (const id of touches.keys()) release(id)
      touches.clear()
      pinch = null
      if (drag) release(drag.id)
      abort()
    }

    // ── 触屏双指:平移 + 缩放。锚 = 起手时两指中心底下的那个舞台点,整场手势里它跟着中心走。 ──
    const pinchAt = (): { x: number; y: number; d: number; ids: string } | null => {
      if (touches.size < 2) return null
      const [[ia, a], [ib, b]] = [...touches.entries()].slice(0, 2)
      const r = host.getBoundingClientRect()
      const u = zoomOf(host) || 1
      return {
        x: ((a.x + b.x) / 2 - r.left) / u,
        y: ((a.y + b.y) / 2 - r.top) / u,
        d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        ids: [ia, ib].sort((m, n) => m - n).join(','),
      }
    }
    const beginPinch = (): void => {
      const p = pinchAt()
      if (!p) return
      const vp = V().vpRef.current
      pinch = { ids: p.ids, d: p.d, cx: p.x, cy: p.y, anchor: { x: (p.x - vp.x) / vp.z, y: (p.y - vp.y) / vp.z }, z: vp.z }
    }
    const updatePinch = (): void => {
      const p = pinchAt()
      if (!p || !pinch) return
      if (p.ids !== pinch.ids) { beginPinch(); return } // 换了一根手指 → 基线重建
      const z = clampZ(pinch.z * (p.d / pinch.d))
      V().setVp({ z, x: p.x - pinch.anchor.x * z, y: p.y - pinch.anchor.y * z })
    }

    const onDown = (e: PointerEvent): void => {
      const target = e.target as HTMLElement
      if (target.closest?.(STAGE_CHROME)) return // chrome 自己的按钮
      // ⚠️ 锁定(成品页)必须在**登记触点之前**判掉。放到后面的话双指依然会 beginPinch/setVp ——
      //    成品页的滚轮和单指平移都掐了,却还能捏合缩放(Codex 2026-08-25);而且触点被登记下来
      //    就不再交还给卡内容自己的手势。
      if (A().locked) {
        touches.clear()
        pinch = null
        const lockedKey = A().hitKey(target)
        // 单击不穿透(双击才进卡片);卡内控件与交互态那张卡照常放行。
        if (lockedKey && !A().isEditing?.(lockedKey) && !target.closest?.(CARD_CTL)) {
          e.preventDefault()
          try { host.setPointerCapture(e.pointerId) } catch { /* 合成事件可没有有效 id */ }
        }
        if (!lockedKey) setSel([]) // 点空白 = 退出交互态
        return
      }
      if (e.pointerType === 'touch') touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touches.size >= 2) { clearPress(); abort(); beginPinch(); return }
      if (e.button === 2) return // 右键归 contextmenu

      const key = A().hitKey(target)
      // ⚠️ 让路判定**必须在 preventDefault 之前**(08-21:一 preventDefault 就不补发 mousedown/click)。
      //    交互态那张卡、以及任何卡内的可交互控件,一律直接放行。
      if (key && (A().isEditing?.(key) || target.closest?.(CARD_CTL))) return

      const edge = key ? A().hitEdge?.(target) ?? null : null
      const locked = !!A().locked
      const u = unit()
      const slop = e.pointerType === 'touch' ? TOUCH_SLOP / u : CLICK_SLOP

      if (e.pointerType === 'touch') {
        // 长按 = 触屏的右键。移动超过 PRESS_SLOP / 第二指落下 / 抬手,三者任一都作废。
        clearPress()
        const at = stageOf(e)
        press = {
          t: Date.now(), x: e.clientX, y: e.clientY, id: e.pointerId,
          timer: window.setTimeout(() => {
            press = null
            abort()
            A().onContextMenu?.(key, { ...at, clientX: e.clientX, clientY: e.clientY })
          }, LONG_PRESS_MS),
        }
      }

      // ⚠️ **指针捕获只在真要起手时才设**。锁定态(展示页)点卡片的语义是「用卡里那个东西」,
      //    而捕获会把后续 click 重定向到宿主 —— 卡内按钮当场点不动(与 08-21 那口坑同族)。
      const capture = (): void => { try { host.setPointerCapture(e.pointerId) } catch { /* 合成事件可没有有效 id */ } }

      if (key && !locked && edge) {
        const b0 = A().boxes().get(key)
        if (!b0) return
        e.preventDefault()
        capture()
        setSel([key])
        drag = { kind: 'size', id: e.pointerId, who: whoNow(), key, edge, b0, x0: e.clientX, y0: e.clientY, live: false, slop }
        return
      }
      if (key && !locked) {
        e.preventDefault()
        capture()
        const additive = e.shiftKey || e.metaKey
        const next = additive
          ? (selRef.current.includes(key) ? selRef.current.filter((k) => k !== key) : [...selRef.current, key])
          : (selRef.current.includes(key) ? selRef.current : [key])
        setSel(next)
        const boxes = A().boxes()
        const keys = next.includes(key) ? next : [key]
        const base = new Map<string, Box>()
        for (const k of keys) { const b = boxes.get(k); if (b) base.set(k, b) }
        drag = { kind: 'move', id: e.pointerId, who: whoNow(), keys: [...base.keys()], base, x0: e.clientX, y0: e.clientY, live: false, slop }
        return
      }
      if (key) {
        // (锁定态已在 onDown 顶部整段处理掉了;这里只剩「排版台里点了一张不该拖的卡」这种兜底。)
        // 锁定(成品页)里点卡片:**单击不穿透** —— 与画布同一条规则「双击才进卡片」。
        // ⚠️ **拦住这一击的是 `capture()`,不是 `preventDefault()`**(2026-08-25 实测踩过):鼠标指针
        //    的 pointerdown 被 preventDefault 只挡得住选中/聚焦这类默认动作,**click 照发**;真正让
        //    卡内容收不到的是指针捕获 —— 它把后续 mouse/click 整个重定向到宿主(这也正是画布的
        //    onDblClick 必须用 elementFromPoint 现场取命中的原因)。少了它就是用户实报的
        //    「Canvas 里是双击进入卡片编辑,这个怎么直接就点进去了」。
        //    卡里的按钮/链接不受影响 —— CARD_CTL 在上面已经放行(08-20「画布里点图片的 `</>` 没反应」)。
        e.preventDefault()
        capture()
        return
      }

      // ── 空白 ──
      setSel([])
      // 成品页的空白处什么都不做:不平移、不框选。点空白 = 退出交互态(上面那句 setSel 触发)。
      if (locked) return
      // 触屏 / 中键 / 空格 / pan 键:空白拖 = 平移(08-23 拍板,代价 = 触屏没有框选)。
      const wantPan = e.pointerType === 'touch' || e.button === 1 || e.altKey
      const vp = V().vpRef.current
      capture()
      if (wantPan) {
        drag = { kind: 'pan', id: e.pointerId, who: whoNow(), x0: e.clientX, y0: e.clientY, vx: vp.x, vy: vp.y, live: false }
      } else {
        const at = stageOf(e)
        drag = { kind: 'marquee', id: e.pointerId, who: whoNow(), x0: e.clientX, y0: e.clientY, sx: at.x, sy: at.y, additive: e.shiftKey, base: [...selRef.current], live: false }
      }
      host.focus({ preventScroll: true }) // 键盘(删除/微移/空格进编辑)要焦点在舞台上
    }

    const onMove = (e: PointerEvent): void => {
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > PRESS_SLOP) clearPress()
      if (touches.size >= 2) { updatePinch(); return }
      if (!drag || e.pointerId !== drag.id) return
      const dxs = e.clientX - drag.x0
      const dys = e.clientY - drag.y0

      if (drag.kind === 'pan') {
        const u = zoomOf(host) || 1
        const vp = V().vpRef.current
        V().setVp({ z: vp.z, x: drag.vx + dxs / u, y: drag.vy + dys / u })
        drag.live = true
        return
      }
      const { dx, dy } = V().toStageDelta(dxs, dys)
      if (!drag.live && drag.kind !== 'marquee' && Math.hypot(dx, dy) < drag.slop) return
      if (!drag.live) { drag.live = true; setBusy(true); clearPress() }

      if (drag.kind === 'move') {
        // 与生产 Canvas 同款：过程逐像素跟手，点阵只在 release 时参与；否则手会被网格黏住。
        const next = new Map<string, Box>()
        for (const [k, b] of drag.base) next.set(k, { ...b, x: Math.round(b.x + dx), y: Math.round(b.y + dy) })
        putLive(A().constrain?.(next, { kind: 'move' }) ?? next)
        return
      }
      if (drag.kind === 'size') {
        const { minW, minH } = A()
        const box = resizeBox(drag.b0, drag.edge, dx, dy, false, minW, minH)
        const next = new Map([[drag.key, box]])
        putLive(A().constrain?.(next, { kind: 'resize', key: drag.key, edge: drag.edge }) ?? next)
        return
      }
      const at = V().toStage(e.clientX, e.clientY)
      const box = boxFromPoints(drag.sx, drag.sy, at.x, at.y)
      setMarquee(box)
      const hit = marqueeHit(box, A().boxes())
      setSel(drag.additive ? [...new Set([...drag.base, ...hit])] : hit)
    }

    const finish = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return
      const d = drag
      drag = null
      setBusy(false)
      setMarquee(null)
      try { if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId) } catch { /* 同上 */ }
      if (d.kind === 'pan' || d.kind === 'marquee') return
      if (!d.live) { putLive(null); return } // 纯点击:选中已在 onDown 落定,不写几何
      // ⚠️ 起手到松手之间换了文档 → **整笔作废**(见 GestureAdapter.identity 顶注)。
      if (d.who !== whoNow()) { putLive(null); return }
      const released = new Map(liveNow ?? [])
      putLive(null)
      if (!released.size) return
      let moved = new Map(released)

      // Canvas 的顺序：先自由跟手；松手后才点阵量化。移动按起手卡量化整批刚体，缩放只量化
      // 正在动的边，固定对边不漂。Dashboard 的有限边界再包在目标几何外层。
      if (snapRef.current && d.kind === 'move') {
        const key = d.keys[0]
        const base = d.base.get(key)
        const live = moved.get(key)
        if (base && live) {
          const sx = snapGrid(live.x) - live.x
          const sy = snapGrid(live.y) - live.y
          if (sx || sy) for (const [k, b] of moved) moved.set(k, { ...b, x: b.x + sx, y: b.y + sy })
          moved = A().constrain?.(moved, { kind: 'move' }) ?? moved
        }
      } else if (snapRef.current && d.kind === 'size') {
        const live = moved.get(d.key)
        if (live) {
          const west = d.edge.includes('w')
          const east = d.edge.includes('e')
          const north = d.edge.includes('n')
          const south = d.edge.includes('s')
          const dx = west ? live.x - d.b0.x : east ? live.x + live.w - (d.b0.x + d.b0.w) : 0
          const dy = north ? live.y - d.b0.y : south ? live.y + live.h - (d.b0.y + d.b0.h) : 0
          const { minW, minH } = A()
          moved = new Map([[d.key, resizeBox(d.b0, d.edge, dx, dy, true, minW, minH)]])
          moved = A().constrain?.(moved, { kind: 'resize', key: d.key, edge: d.edge }) ?? moved
        }
      }

      let repelled = false
      if (d.kind === 'move' && A().repel !== false) {
        // 松手排斥:与画布同款,两张卡不会视觉粘连。障碍 = 没被这次手势碰过的卡。
        const boxes = A().boxes()
        const obstacles: Box[] = []
        for (const [k, b] of boxes) if (!moved.has(k)) obstacles.push(b)
        const firstKey = d.keys[0]
        const base = d.base.get(firstKey)
        const target = moved.get(firstKey)
        const intent = base && target ? { x: target.x - base.x, y: target.y - base.y } : { x: 0, y: 0 }
        const push = resolveCardRepulsion([...moved.values()], obstacles, intent, undefined, A().repelBounds)
        if (push.x || push.y) {
          repelled = true
          for (const [k, b] of moved) moved.set(k, { ...b, x: b.x + push.x, y: b.y + push.y })
          moved = A().constrain?.(moved, { kind: 'move' }) ?? moved
        }
      }
      A().commit(moved)
      const changed = [...moved].some(([k, b]) => {
        const from = released.get(k)
        return !!from && (from.x !== b.x || from.y !== b.y || from.w !== b.w || from.h !== b.h)
      })
      if (changed) A().onSettle?.(released, moved, repelled ? 'repel' : 'snap')
    }

    const onUp = (e: PointerEvent): void => {
      clearPress()
      if (e.pointerType === 'touch') {
        touches.delete(e.pointerId)
        if (touches.size < 2) pinch = null
        if (touches.size >= 1) { abort(); return } // 还有手指在屏上:不回单指逻辑
      }
      finish(e)
    }
    const onCancel = (e: PointerEvent): void => {
      clearPress()
      if (e.pointerType === 'touch') { touches.delete(e.pointerId); if (touches.size < 2) pinch = null }
      if (drag && e.pointerId === drag.id) abort()
    }
    /** ⚠️ `e.target` 不可信:onDown 里 `setPointerCapture` 之后,派生的 click / dblclick / contextmenu
     *  会被**重定向到宿主**——「双击卡片」于是被当成「双击空白」,交互态永远进不去(2026-08-25
     *  实测 D10 整格红)。按坐标现场取真实命中,capture 影响不到 `elementFromPoint`。 */
    const realTarget = (e: MouseEvent): HTMLElement =>
      (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null) ?? (e.target as HTMLElement)

    const onDbl = (e: MouseEvent): void => {
      const target = realTarget(e)
      if (target.closest?.(STAGE_CHROME)) return
      A().onDoubleClick?.(A().hitKey(target), stageOf(e))
    }
    const onCtx = (e: MouseEvent): void => {
      const target = realTarget(e)
      if (target.closest?.(STAGE_CHROME)) return
      const key = A().hitKey(target)
      if (!A().onContextMenu) return
      e.preventDefault()
      const at = stageOf(e)
      A().onContextMenu?.(key, { ...at, clientX: e.clientX, clientY: e.clientY })
    }
    const onKey = (e: KeyboardEvent): void => {
      if (A().locked) return
      const t = e.target as HTMLElement | null
      if (t?.closest?.(CARD_CTL)) return // 卡内正在打字:键盘归它
      const keys = selRef.current
      if (e.key === 'Escape') { setSel([]); return }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setSel([...A().boxes().keys()])
        return
      }
      if (!keys.length) return
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); A().onDelete?.(keys); return }
      if (e.key === ' ' && keys.length === 1) { e.preventDefault(); A().onEnterEdit?.(keys[0]); return }
      const dx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
      const dy = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
      if (!dx && !dy) return
      e.preventDefault()
      const step = snapRef.current ? 24 : e.shiftKey ? NUDGE * 4 : NUDGE
      const boxes = A().boxes()
      const next = new Map<string, Box>()
      for (const k of keys) { const b = boxes.get(k); if (b) next.set(k, { ...b, x: b.x + dx * step, y: b.y + dy * step }) }
      if (next.size) A().commit(A().constrain?.(next, { kind: 'move' }) ?? next)
    }

    /** 幽灵手指兜底(触屏指针有隐式捕获,pointerup 可能落在别处)。 */
    const onWinUp = (e: PointerEvent): void => { if (drag && e.pointerId === drag.id) onUp(e) }

    host.addEventListener('pointerdown', onDown)
    host.addEventListener('pointermove', onMove)
    host.addEventListener('pointerup', onUp)
    host.addEventListener('pointercancel', onCancel)
    host.addEventListener('dblclick', onDbl)
    host.addEventListener('contextmenu', onCtx)
    host.addEventListener('keydown', onKey)
    window.addEventListener('pointerup', onWinUp, true)
    window.addEventListener('blur', resetGesture)
    return () => {
      resetGesture()
      host.removeEventListener('pointerdown', onDown)
      host.removeEventListener('pointermove', onMove)
      host.removeEventListener('pointerup', onUp)
      host.removeEventListener('pointercancel', onCancel)
      host.removeEventListener('dblclick', onDbl)
      host.removeEventListener('contextmenu', onCtx)
      host.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerup', onWinUp, true)
      window.removeEventListener('blur', resetGesture)
    }
  }, [setSel])

  return { sel, setSel, live, marquee, busy, bind }
}
