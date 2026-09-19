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
