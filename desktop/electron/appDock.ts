/**
 * 侧边拼接(App Dock)的主进程半身:把一扇 Forsion 面板贴在别的 App 的窗口旁边,像一个窗口那样一起动。
 *
 * 两个方向:
 *  - **目标 → 面板**:每 16ms 问一次 helper 的 `dockProbe`(CGWindowList 的实时 bounds,用户拖目标窗口的过程中也在变;
 *    一次 ~0.3ms),面板跟着摆到它旁边、高度跟它一样;目标最小化 / 隐藏 / 去了别的桌面 / 全屏 → 面板藏起来;关了 → onGone。
 *  - **面板 → 目标**:用户拖面板 / 拉面板边,经 `setWindowFrame` 把目标带过去(只挪不缩放时不写尺寸)。
 *    此间暂停「目标 → 面板」的摆放(否则两边对打),松手 300ms 后再按目标的真实位置收一次尾(目标拒绝挪也能对齐回来)。
 *
 * 层级:跨进程的窗口没法互相挂靠(NSWindow 的 child window 只认同进程),所以只在**目标 App 刚变成前台**那一下
 * 用 showInactive(orderFrontRegardless)把面板提到最前、不抢焦点;用户切到别的 App 时面板跟目标一起被正常盖住。
 */
import type { BrowserWindow, Rectangle } from 'electron'
import type { DockWindow } from '../shared/appDock'

export type DockSide = 'left' | 'right'

export const DOCK_PANEL_WIDTH = 400
export const DOCK_PANEL_MIN_WIDTH = 320
/** 给面板腾位时目标最窄缩到多少(再窄多数 App 就不成样子了)。 */
const MIN_TARGET_WIDTH = 480
/** 用户最后一次拖 / 拉面板之后多久恢复「目标 → 面板」的摆放。 */
const USER_SETTLE_MS = 300
/** 连续这么多次问不到 helper(≈1s)就当 helper 没了,收摊。 */
const MAX_PROBE_FAILURES = 60
/** 目标不在屏上(最小化 / 隐藏 / 别的桌面)时的轮询间隔:helper 那边此时要扫全量窗口表,没必要 60Hz。 */
const HIDDEN_PROBE_MS = 250

/**
 * 两次采样之间尺寸跳变 = 系统动画(最小化的神灯、还原、绿钮缩放、窗口管理器一键贴边),不是用户在拖边:
 * 用户拖边每帧只变几个像素。这时面板先藏起,等目标连续稳住再贴回去 —— 逐帧跟着神灯变形比消失难看得多。
 */
export function isSizeJump(prev: Rectangle, next: Rectangle): boolean {
  const jump = (a: number, b: number): boolean => Math.abs(a - b) > Math.max(120, a * 0.2)
  return jump(prev.width, next.width) || jump(prev.height, next.height)
}

/** 贴哪边:右边放得下就右边,否则左边放得下就左边,都不行仍贴右边(由 makeRoom 腾位)。 */
export function chooseSide(target: Rectangle, panelWidth: number, workArea: Rectangle): DockSide {
  if (target.x + target.width + panelWidth <= workArea.x + workArea.width) return 'right'
  if (target.x - panelWidth >= workArea.x) return 'left'
  return 'right'
}

/** 两边都放不下时给右侧面板腾位:目标往左挪,挪到头还不够就缩窄。null = 不用动。 */
export function makeRoom(target: Rectangle, panelWidth: number, workArea: Rectangle): Rectangle | null {
  const limit = workArea.x + workArea.width - panelWidth
  if (target.x + target.width <= limit) return null
  const width = Math.max(MIN_TARGET_WIDTH, Math.min(target.width, limit - workArea.x))
  return { x: Math.max(workArea.x, limit - width), y: target.y, width, height: target.height }
}

/** 面板该在哪:紧贴目标的一侧,上沿与高度跟目标一样。 */
export function panelRectFor(target: Rectangle, side: DockSide, panelWidth: number): Rectangle {
  return {
    x: side === 'right' ? target.x + target.width : target.x - panelWidth,
    y: target.y,
    width: panelWidth,
    height: target.height,
  }
}

/**
 * 用户动了面板 → 目标该去哪。尺寸没变 = 整体拖动(目标只挪不缩放);尺寸变了 = 拉边:
 * 上下沿两边同步;拉的是贴着目标的那条缝 → 目标跟着变宽/变窄;拉的是外沿 → 只改面板自己的宽度。
 */
export function targetRectFor(prevPanel: Rectangle, panel: Rectangle, target: Rectangle, side: DockSide): { rect: Rectangle; resized: boolean } {
  const resized = panel.width !== prevPanel.width || panel.height !== prevPanel.height
  if (!resized) {
    const x = side === 'right' ? panel.x - target.width : panel.x + panel.width
    return { rect: { x, y: panel.y, width: target.width, height: target.height }, resized: false }
  }
  if (side === 'right') {
    // 缝 = 面板左沿;目标左沿不动
    return { rect: { x: target.x, y: panel.y, width: Math.max(MIN_TARGET_WIDTH / 2, panel.x - target.x), height: panel.height }, resized: true }
  }
  // 缝 = 面板右沿;目标右沿不动
  const seam = panel.x + panel.width
  const right = target.x + target.width
  return { rect: { x: seam, y: panel.y, width: Math.max(MIN_TARGET_WIDTH / 2, right - seam), height: panel.height }, resized: true }
}

const sameRect = (a: Rectangle | null, b: Rectangle | null): boolean =>
  !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

interface Probe { exists: boolean; onScreen: boolean; rect: Rectangle; frontPid: number }

export function normalizeProbe(raw: unknown): Probe {
  const r = (raw ?? {}) as Record<string, unknown>
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0)
  return {
    exists: r.exists === true,
    onScreen: r.onScreen === true,
    rect: { x: n(r.x), y: n(r.y), width: n(r.w), height: n(r.h) },
    frontPid: n(r.frontPid),
  }
}

export interface DockFollowDeps {
  win: BrowserWindow
  target: DockWindow
  side: DockSide
  request(payload: Record<string, unknown>): Promise<unknown>
  /** 显示器整块(含菜单栏):目标铺满它 = 全屏,面板放不过去,藏起来。 */
  displayBoundsOf(rect: Rectangle): Rectangle
  /** 目标关了 / helper 没了。调用方负责收面板。 */
  onGone(reason: 'closed' | 'helper'): void
  intervalMs?: number
}

export function startDockFollow(deps: DockFollowDeps): () => void {
  const { win, target, side } = deps
  let stopped = false
  let probing = false
  let failures = 0
  let hidden = false
  let lastFront = 0
  let target_: Rectangle | null = null
  /** 我们自己 setBounds 摆的位置:move/resize 事件里与它相同 = 程序化,不算用户。 */
  let placed: Rectangle | null = null
  /** 面板最近一次的已知位置(程序化或用户),用来区分「拖」与「拉边」。 */
  let lastPanel: Rectangle | null = null
  let placedAt = 0
  let userUntil = 0
  let panelWidth = win.getBounds().width
  let moving = false
  let queued: { rect: Rectangle; resized: boolean } | null = null
  let lastProbeAt = 0
  /** 尺寸刚跳变过:藏着等目标稳住(同一个 rect 连续出现 STABLE_PROBES 次)。 */
  let settling = false
  let offscreen = false
  let stableProbes = 0
  const STABLE_PROBES = 3

  const place = (rect: Rectangle): void => {
    if (win.isDestroyed() || sameRect(rect, win.getBounds())) return
    placed = rect
    lastPanel = rect
    placedAt = Date.now()
    win.setBounds(rect)
  }

  const pushTarget = (next: { rect: Rectangle; resized: boolean }): void => {
    if (moving) { queued = next; return } // 只留最新的:拖动中间的位置没意义
    moving = true
    const { rect, resized } = next
    void deps.request({ cmd: 'setWindowFrame', pid: target.pid, windowId: target.windowId, x: rect.x, y: rect.y, ...(resized ? { width: rect.width, height: rect.height } : {}) })
      .catch(() => {})
      .finally(() => {
        moving = false
        const more = queued
        queued = null
        if (more && !stopped) pushTarget(more)
      })
  }

  const onUserChange = (): void => {
    if (stopped || win.isDestroyed()) return
    const b = win.getBounds()
    // 我们自己摆的。系统可能把摆的位置再夹一下(实际 bounds ≠ 请求的),所以刚摆完的一小会儿也不算用户 ——
    // 否则被夹过的位置会被当成「用户拖了面板」再推给目标,两边互相推着跑。
    if (sameRect(b, placed) || Date.now() - placedAt < 80) return
    placed = null
    const prev = lastPanel ?? b
    lastPanel = b
    userUntil = Date.now() + USER_SETTLE_MS
    if (b.width !== prev.width) panelWidth = Math.max(DOCK_PANEL_MIN_WIDTH, b.width)
    if (target_) pushTarget(targetRectFor(prev, b, target_, side))
  }
  win.on('move', onUserChange)
  win.on('resize', onUserChange)

  const tick = async (): Promise<void> => {
    if (stopped || probing || win.isDestroyed()) return
    if (offscreen && Date.now() - lastProbeAt < HIDDEN_PROBE_MS) return
    lastProbeAt = Date.now()
    probing = true
    let probe: Probe
    try {
      probe = normalizeProbe(await deps.request({ cmd: 'dockProbe', windowId: target.windowId }))
      failures = 0
    } catch {
      if (++failures >= MAX_PROBE_FAILURES) { stop(); deps.onGone('helper') }
      return
    } finally {
      probing = false
    }
    if (stopped || win.isDestroyed()) return
    if (!probe.exists) { stop(); deps.onGone('closed'); return }
    const prev = target_
    target_ = probe.rect
    // 用户正拉着面板的缝时目标会跟着大幅变宽,那不是系统动画,别把用户手里的面板藏了
    const userActive = Date.now() < userUntil
    if (!userActive && prev && !sameRect(prev, probe.rect) && isSizeJump(prev, probe.rect)) { settling = true; stableProbes = 0 }
    else if (settling) stableProbes = prev && sameRect(prev, probe.rect) ? stableProbes + 1 : 0
    if (settling && stableProbes >= STABLE_PROBES) settling = false
    const fullscreen = sameRect(probe.rect, deps.displayBoundsOf(probe.rect))
    offscreen = !probe.onScreen
    if (offscreen || fullscreen || settling) {
      if (!hidden) { hidden = true; win.hide() }
      lastFront = probe.frontPid
      return
    }
    if (Date.now() >= userUntil) place(panelRectFor(probe.rect, side, panelWidth))
    // 目标 App 刚到前台 → 面板跟着提到最前(不抢焦点)。藏着的这时一并露面。
    const cameForward = probe.frontPid === target.pid && lastFront !== target.pid
    if (hidden || cameForward) { hidden = false; win.showInactive() }
    lastFront = probe.frontPid
  }

  const timer = setInterval(() => { void tick() }, deps.intervalMs ?? 16)
  void tick()

  function stop(): void {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    if (!win.isDestroyed()) {
      win.off('move', onUserChange)
      win.off('resize', onUserChange)
    }
  }
  return stop
}
