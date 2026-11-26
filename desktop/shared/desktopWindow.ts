/**
 * 插件桌面小窗(2026-11-26,方案页 docs/ToBeImproved/插件桌面小窗方案_2026-11-26):主进程 electron/pluginDesktopWindows.ts 与
 * 渲染层 frontend/src/pluginDesktopWindow.ts 共用的契约和纯函数。
 *
 * 做法是「同进程子窗」(方案页第五节,第 0 步实测过关,探针 scripts/desktop-window-route.probe.cjs):主窗页面先向主进程
 * 要一个一次性的窗口名(prepare,护栏和第一次询问都在这一步),再 window.open('about:blank', 那个名字);主进程只放行这个名字,
 * 按下面的窗口选项开一扇透明、没有外壳、不进任务栏、不抢焦点的子窗。插件的视图由主窗那份插件实例直接画进子窗,不另起一份界面。
 *
 * 护栏(方案页第七节第 3 件,用户 11-26 按建议定):每个插件同时最多 3 扇;单扇不超过所在屏幕工作区宽、高各一半;
 * 至少 32 px 留在屏幕里(能从屏幕边探头);缺省不盖在 mac 全屏应用上。
 */

export interface DesktopRect { x: number; y: number; width: number; height: number }
export interface DesktopScreen { id: number; bounds: DesktopRect; workArea: DesktopRect; scaleFactor: number }

export const DESKTOP_WINDOW_LIMIT = 3
/** 窗口至少留多少在屏幕里(两个方向各算)。 */
export const DESKTOP_WINDOW_MIN_VISIBLE = 32
export const DESKTOP_WINDOW_MIN_SIZE = 16
export const DESKTOP_WINDOW_DEFAULT_SIZE = 160
/** 窗口名前缀:主进程只放行带这个前缀、且是自己刚发出去的名字。 */
export const DESKTOP_WINDOW_FRAME_PREFIX = 'forsion-plugin-desktop-'

export const DESKTOP_WINDOW_CHANNELS = {
  prepare: 'desktopWindow:prepare',
  setBounds: 'desktopWindow:setBounds',
  passThrough: 'desktopWindow:passThrough',
  released: 'desktopWindow:released',
  close: 'desktopWindow:close',
  closePlugin: 'desktopWindow:closePlugin',
  screens: 'desktopWindow:screens',
  grant: 'desktopWindow:grant',
  revoke: 'desktopWindow:revoke',
  /** 主进程 → 主窗:某扇小窗没了(用户在托盘关的、插件被收回授权、主进程关的)。 */
  closed: 'desktopWindow:closed',
  /** 主进程 → 主窗:屏幕变了(插拔显示器、改缩放),附新的屏幕表。 */
  screensChanged: 'desktopWindow:screensChanged',
} as const

export interface DesktopWindowPrepareRequest {
  pluginId: string
  /** 第一次询问和托盘里显示的插件名(当前语言)。 */
  pluginName: string
  /** 同一插件里区分「哪一扇」;空串 = 缺省那扇。 */
  key: string
  /** 托盘里这扇的名字;空 = 只显示插件名。 */
  title: string
  width: number
  height: number
  /** 盖在别的应用的普通窗口上;缺省 true(同 Mini)。 */
  pin: boolean
}

export type DesktopWindowPrepareReply =
  | {
    ok: true
    id: string
    /** window.open 用的名字。existing = 这扇已经开着(同插件同 key):渲染层按名字找回它,不新开。 */
    frameName: string
    existing: boolean
    bounds: DesktopRect
    screens: DesktopScreen[]
    /** 这台机器能不能「空白处点穿、鼠标移动照样转给页面」(Electron 的 forward 只在 mac / Windows 上有)。 */
    clickThrough: boolean
  }
  /** elsewhere = 请求不是主窗发的,但这扇已经在主窗那边开着(Mini / 独立窗里的插件实例跑 setup 时据此报 ok、什么都不做)。 */
  | { ok: false; reason: 'denied' | 'limit' | 'unavailable' | 'elsewhere'; limit?: number }

export type DesktopWindowGrant = 'allow' | 'deny' | null

const finite = (n: unknown, fallback: number): number => (typeof n === 'number' && Number.isFinite(n) ? n : fallback)

/** 尺寸:整数,不小于 16,不超过工作区宽、高各一半。 */
export function clampDesktopSize(size: { width?: unknown; height?: unknown }, workArea: DesktopRect): { width: number; height: number } {
  const w = Math.round(finite(size.width, DESKTOP_WINDOW_DEFAULT_SIZE))
  const h = Math.round(finite(size.height, DESKTOP_WINDOW_DEFAULT_SIZE))
  const maxW = Math.max(DESKTOP_WINDOW_MIN_SIZE, Math.floor(workArea.width / 2))
  const maxH = Math.max(DESKTOP_WINDOW_MIN_SIZE, Math.floor(workArea.height / 2))
  return { width: Math.min(maxW, Math.max(DESKTOP_WINDOW_MIN_SIZE, w)), height: Math.min(maxH, Math.max(DESKTOP_WINDOW_MIN_SIZE, h)) }
}

const overlap = (a: DesktopRect, b: DesktopRect): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
const centerDist = (a: DesktopRect, b: DesktopRect): number =>
  Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2))

/** 窗口所在的那块屏:重叠最多的;一块都不重叠 = 中心最近的。没有屏幕表 = null。 */
export function screenOf(rect: DesktopRect, screens: readonly DesktopScreen[]): DesktopScreen | null {
  if (!screens.length) return null
  let best = screens[0], bestArea = -1
  for (const s of screens) { const a = overlap(rect, s.bounds); if (a > bestArea) { best = s; bestArea = a } }
  if (bestArea > 0) return best
  return [...screens].sort((a, b) => centerDist(rect, a.bounds) - centerDist(rect, b.bounds))[0]
}

/** 位置与尺寸一起夹:尺寸按所在屏的工作区夹;位置夹到「两个方向都至少 32 px 留在那块屏里」。
 *  按屏幕的整块(不是工作区)算位置:宠物可以站在 Dock / 任务栏上。
 *  夹到不动为止:缩小以后窗口可能换成压在另一块屏上更多,那块屏的一半更小,再夹一次 —— 渲染层先夹、主进程再夹,
 *  两边必须得到同一个结果(夹一次的结果再夹会变,控制器报的尺寸就和真窗口对不上)。 */
export function clampDesktopBounds(rect: { x?: unknown; y?: unknown; width?: unknown; height?: unknown }, screens: readonly DesktopScreen[]): DesktopRect {
  let cur: DesktopRect = {
    x: Math.round(finite(rect.x, 0)), y: Math.round(finite(rect.y, 0)),
    width: Math.round(finite(rect.width, DESKTOP_WINDOW_DEFAULT_SIZE)), height: Math.round(finite(rect.height, DESKTOP_WINDOW_DEFAULT_SIZE)),
  }
  for (let i = 0; i < 6; i++) { // 尺寸第一次以后只会变小,几次就停
    const next = clampOnce(cur, screens)
    if (next.x === cur.x && next.y === cur.y && next.width === cur.width && next.height === cur.height) return next
    cur = next
  }
  return cur
}

function clampOnce(raw: DesktopRect, screens: readonly DesktopScreen[]): DesktopRect {
  const s = screenOf(raw, screens)
  if (!s) return raw
  const { width, height } = clampDesktopSize(raw, s.workArea)
  const keep = DESKTOP_WINDOW_MIN_VISIBLE
  const b = s.bounds
  const x = Math.min(b.x + b.width - Math.min(keep, width), Math.max(b.x - width + Math.min(keep, width), raw.x))
  const y = Math.min(b.y + b.height - Math.min(keep, height), Math.max(b.y - height + Math.min(keep, height), raw.y))
  return { x, y, width, height }
}

/** 第一次开、没有记住的位置:工作区右下角,离边 24。 */
export function defaultDesktopBounds(size: { width: number; height: number }, workArea: DesktopRect): DesktopRect {
  const m = 24
  return { x: Math.round(workArea.x + workArea.width - size.width - m), y: Math.round(workArea.y + workArea.height - size.height - m), width: size.width, height: size.height }
}

/** 主进程收到的开窗请求:形状不对的一律拒(渲染层是插件能摸到的那一层,别信它)。 */
export function normalizePrepareRequest(raw: unknown): DesktopWindowPrepareRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const pluginId = typeof r.pluginId === 'string' ? r.pluginId.trim() : ''
  if (!pluginId || pluginId.length > 128) return null
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  return {
    pluginId,
    pluginName: str(r.pluginName, 80) || pluginId,
    key: str(r.key, 128),
    title: str(r.title, 80),
    width: finite(r.width, DESKTOP_WINDOW_DEFAULT_SIZE),
    height: finite(r.height, DESKTOP_WINDOW_DEFAULT_SIZE),
    pin: r.pin !== false,
  }
}

export const desktopWindowIdent = (pluginId: string, key: string): string => `${pluginId}#${key}`
