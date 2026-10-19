/** 手写笔输入的三处修补。引擎(fork 0.18.122)是预编译的 IIFE,改不了源码:
 *  build/copy-excalidraw-assets.cjs 拷副本时往里插三个钩子(调 `globalThis.__forsionPenInput`),
 *  逻辑全在这里。钩子不在(老副本)= 引擎原样,不会报错。
 *
 *  ① 丢点:引擎把拖动中的 pointermove 按帧节流(throttleRAF 只留每帧最后一个),也不读
 *     getCoalescedEvents。安卓手写笔 ~240Hz、屏幕 60–120Hz → 一半到四分之三的采样被扔掉,
 *     写快了笔画发折、缩水。这里把每个事件连同它合并掉的采样都攒下来,自由画笔那一帧全加进去。
 *  ② 断笔:笔画进行中引擎收到**任何** pointerdown 都先把这一笔收掉(maybeCleanupAfterMissingPointerUp),
 *     手指按下还会把不足 10 点的笔画整笔删掉;**任何**指针抬起也会收笔(window pointerup 不认 pointerId)。
 *     笔模式下:笔在画时手指 / 手掌按下一概不交给引擎,笔画的移动 / 抬起只认这支笔。
 *  ③ 手掌先放:手掌按着时笔落下,引擎把两者凑成双指(gesture.pointers.size > 1)→ 笔画根本不开始,
 *     移动还会变成缩放。笔落下时把按着的手指从引擎的手势表里拿掉。
 *
 *  只管笔(pointerType === 'pen');手指 / 鼠标一概不动。笔模式被用户关掉 = 手指也要能画,②③ 不管。
 *  ponytail: 橡皮擦路径(handleEraser)仍是每帧一个点 —— 擦除漏几个点肉眼看不出,要补再挂第四个钩子。
 */

type Ptr = { pointerId: number; pointerType: string }
type Sample = { clientX: number; clientY: number; pressure: number }
type BoardState = {
  penMode: boolean
  penDetected: boolean
  currentStrokeOptions?: { constantPressure?: boolean } | null
}
type Gesture = { pointers: Map<number, unknown> }
/** 引擎的 pointerDownState(每次按下新建一份);我们把这一笔的采样缓冲挂在它上面 */
type DownState = { fsSamples?: PointerEvent[] }
type Throttled = ((e: PointerEvent) => void) & { flush: () => void; cancel?: () => void }
type Freedraw = {
  x: number
  y: number
  points: readonly (readonly [number, number])[]
  pressures: readonly number[]
  simulatePressure: boolean
}
type ToScene = (e: Sample, st: BoardState) => { x: number; y: number }

/** 正在画的那支笔;按着的手指(都是全局唯一的 pointerId,多块白板共用没问题) */
let penId: number | null = null
const touchIds = new Set<number>()

/** 笔模式下才拦手指。penDetected 为假 = 第一次见到笔,引擎这一下就会自己打开笔模式。 */
const penRules = (st: BoardState): boolean => st.penMode || !st.penDetected

/** 钩子 1:handleCanvasPointerDown 开头。返回 true = 这次按下不交给引擎。 */
export function down(e: Ptr, st: BoardState, gesture: Gesture): boolean {
  if (e.pointerType === 'touch') {
    if (penId !== null && st.penMode) return true // ②
    touchIds.add(e.pointerId)
    return false
  }
  if (e.pointerType === 'pen' && penRules(st)) for (const id of touchIds) gesture.pointers.delete(id) // ③
  return false
}

/** 钩子 2:按下后建拖动监听的地方。笔按下时换成「只认这支笔 + 攒采样」的版本。 */
export function wrap<U extends (e: PointerEvent) => void>(
  move: Throttled,
  up: U,
  ds: DownState,
  e: Ptr,
  st: BoardState,
): [Throttled, U] {
  if (e.pointerType !== 'pen') return [move, up]
  const pid = (penId = e.pointerId)
  const strict = penRules(st)
  const buf: PointerEvent[] = (ds.fsSamples = [])
  const m = ((ev: PointerEvent) => {
    if (ev.pointerId === pid) {
      const all = ev.getCoalescedEvents?.()
      buf.push(...(all?.length ? all : [ev]))
    } else if (strict) return
    move(ev)
  }) as Throttled
  m.flush = () => move.flush()
  m.cancel = () => move.cancel?.()
  // 引擎补发抬起(missingPointerEventCleanup)时会传 null 或按下那次的事件 —— 那些照放行
  const u = ((ev?: PointerEvent | null) => {
    if (strict && ev && ev.pointerId !== undefined && ev.pointerId !== pid) return
    if (penId === pid) penId = null
    up(ev as PointerEvent)
  }) as U
  return [m, u]
}

/** 钩子 3:自由画笔追加点。undefined = 不是笔画,走引擎原逻辑;null = 没有新点;否则是要写进元素的字段。 */
export function freedraw(
  el: Freedraw,
  ds: DownState,
  st: BoardState,
  toScene: ToScene,
): { points: [number, number][]; pressures: readonly number[] } | null | undefined {
  const buf = ds.fsSamples
  if (!buf) return undefined
  // 缓冲空 = 这一帧只有别的指针在动(非笔模式才会走到这),不画
  if (!buf.length) return null
  const samples = buf.splice(0)
  const points = el.points.map((p) => [p[0], p[1]] as [number, number])
  const pressures = [...el.pressures]
  const constant = !!st.currentStrokeOptions?.constantPressure
  for (const s of samples) {
    const { x, y } = toScene(s, st)
    const dx = x - el.x
    const dy = y - el.y
    const last = points[points.length - 1]
    if (last && last[0] === dx && last[1] === dy) continue
    points.push([dx, dy])
    pressures.push(constant ? 1 : s.pressure)
  }
  if (points.length === el.points.length) return null
  return { points, pressures: el.simulatePressure ? el.pressures : pressures }
}

/** 抬起 / 取消在 window 捕获阶段记账(先于引擎自己的监听,引擎有时根本没挂监听) */
const release = (e: PointerEvent): void => {
  touchIds.delete(e.pointerId)
  if (e.pointerId === penId) penId = null
}

export function installPenInput(): void {
  ;(globalThis as Record<string, unknown>).__forsionPenInput = { down, wrap, freedraw }
  window.addEventListener('pointerup', release, true)
  window.addEventListener('pointercancel', release, true)
}
