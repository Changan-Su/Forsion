export type FloatingPanelBuiltin = 'settings' | 'market' | 'achievements' | 'feedback'

export interface FloatingPanelViewTarget {
  type: string
  params?: Record<string, unknown>
}

/** Cross-window payload for the sixth panel surface. Only serializable data crosses IPC. */
export interface FloatingPanelOpenOptions {
  /** Stable identity. Opening the same id focuses and retargets the existing window. */
  id: string
  title: string
  builtin?: FloatingPanelBuiltin
  view?: FloatingPanelViewTarget
  params?: Record<string, unknown>
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
}

const BUILTINS = new Set<FloatingPanelBuiltin>(['settings', 'market', 'achievements', 'feedback'])
const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' ? value.trim().slice(0, max) || undefined : undefined
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const size = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : fallback

export function normalizeFloatingPanelOpenOptions(raw: unknown): FloatingPanelOpenOptions | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const id = text(value.id, 256)
  const title = text(value.title, 256)
  const builtin = BUILTINS.has(value.builtin as FloatingPanelBuiltin) ? value.builtin as FloatingPanelBuiltin : undefined
  const rawView = object(value.view)
  const viewType = text(rawView?.type, 256)
  const view = viewType ? { type: viewType, params: object(rawView?.params) } : undefined
  if (!id || !title || Number(!!builtin) + Number(!!view) !== 1) return undefined
  const width = size(value.width, builtin === 'feedback' ? 720 : 1040, 480, 1800)
  const height = size(value.height, builtin === 'feedback' ? 760 : 720, 360, 1200)
  return {
    id, title, builtin, view, params: object(value.params), width, height,
    minWidth: size(value.minWidth, builtin === 'feedback' ? 560 : 720, 360, width),
    minHeight: size(value.minHeight, builtin === 'feedback' ? 480 : 520, 280, height),
  }
}

/** 卫星窗(设置 / 反馈等浮窗)请主窗代办的动作:每个窗口一份 store,作用在工作台上的事必须由主窗自己做。
 *  带载荷的:space-removed = 已从磁盘删掉的 Space id(主窗撤注册 / ribbon);chat-draft = 预填进主窗聊天输入框的草稿。 */
export type MainAction = 'onboarding' | 'dev-commands' | 'test-notification' | 'reset-layout' | 'achievement-toast' | 'space-removed' | 'chat-draft'
const MAIN_ACTIONS = new Set<MainAction>(['onboarding', 'dev-commands', 'test-notification', 'reset-layout', 'achievement-toast', 'space-removed', 'chat-draft'])
const MAIN_ACTION_PAYLOAD_MAX: Partial<Record<MainAction, number>> = { 'space-removed': 256, 'chat-draft': 20000 }

/** 主进程转发前的闸:动作在白名单里;带载荷的要求非空字符串且不超长,不带载荷的动作丢掉载荷。 */
export function normalizeMainAction(action: unknown, payload: unknown): { action: MainAction; payload?: string } | undefined {
  if (!MAIN_ACTIONS.has(action as MainAction)) return undefined
  const max = MAIN_ACTION_PAYLOAD_MAX[action as MainAction]
  if (!max) return { action: action as MainAction }
  return typeof payload === 'string' && payload && payload.length <= max ? { action: action as MainAction, payload } : undefined
}
