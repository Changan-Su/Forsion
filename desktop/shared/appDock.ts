/**
 * 侧边拼接(App Dock):Forsion 的对话面板贴在某个 App 窗口旁边,拖动 / 移动 / 缩放都像一个窗口。
 * 跨 IPC 的只有这些纯数据;主进程从 helper 拿到的一律在这里逐字段挑,不透传未知结构。
 */

/** 被贴靠的那扇窗口。pid + windowId 定位,app / bundleId / title 给人看、也给模型找 root 用。 */
export interface DockWindow {
  pid: number
  windowId: number
  app: string
  bundleId?: string
  title: string
}

export interface DockCandidate extends DockWindow {
  x: number
  y: number
  width: number
  height: number
}

/** 目标 App 此刻的划线文本;没有文本选区时给选中项(Finder 里选中的文件、邮件列表里的邮件……)。 */
export interface DockSelection {
  text?: string
  items?: string[]
  windowTitle?: string
}

/** 主进程 → 面板:现在贴着谁。target=null = 还没选(面板显示候选列表)。 */
export interface DockState {
  target: DockWindow | null
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0)

export function normalizeDockWindow(raw: unknown): DockWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const pid = int(r.pid)
  const windowId = int(r.windowId)
  if (!pid || !windowId) return undefined
  const bundleId = str(r.bundleId, 256)
  return { pid, windowId, app: str(r.app, 128), ...(bundleId ? { bundleId } : {}), title: str(r.title, 256) }
}

/** helper `dockCandidates` 回包 → 候选。helper 给的是 w/h,这里统一成 width/height。 */
export function normalizeDockCandidates(raw: unknown): DockCandidate[] {
  const list = (raw as { windows?: unknown } | null)?.windows
  if (!Array.isArray(list)) return []
  return list.slice(0, 40).flatMap((item) => {
    const w = normalizeDockWindow(item)
    if (!w) return []
    const r = item as Record<string, unknown>
    return [{ ...w, x: num(r.x), y: num(r.y), width: num(r.w), height: num(r.h) }]
  })
}

export function normalizeDockSelection(raw: unknown): DockSelection {
  const r = (raw ?? {}) as Record<string, unknown>
  const text = str(r.text, 20_000).trim()
  const items = Array.isArray(r.items) ? r.items.map((v) => str(v, 200).trim()).filter(Boolean).slice(0, 20) : []
  const windowTitle = str(r.windowTitle, 256)
  return { ...(text ? { text } : {}), ...(items.length ? { items } : {}), ...(windowTitle ? { windowTitle } : {}) }
}
