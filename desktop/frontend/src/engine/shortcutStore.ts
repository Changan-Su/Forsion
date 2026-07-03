/**
 * 自定义快捷键:命令 id → 热键覆盖(持久化 localStorage)。
 * 生效热键 = 用户覆盖(含显式空串 = 解绑)优先,否则命令默认 hotkey。
 * 字符串格式与 commandRegistry 的 hotkeyMatches 一致('mod+shift+k';mod = mac⌘ / 其它 Ctrl)。
 */
import { create } from 'zustand'

const LS_KEY = 'forsion_shortcuts'

function load(): Record<string, string> {
  try {
    const o = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
    return o && typeof o === 'object' ? o : {}
  } catch { return {} }
}
function persist(o: Record<string, string>): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(o)) } catch { /* private mode */ }
}

interface ShortcutState {
  /** commandId → 热键('' = 显式解绑)。仅此字段持久化。 */
  overrides: Record<string, string>
  /** 录制中:全局热键分发暂停,避免录制时误触发命令。不持久化。 */
  recording: boolean
  setOverride(id: string, hotkey: string): void
  clearOverride(id: string): void // 删除覆盖 → 回落命令默认
  resetAll(): void
  setRecording(on: boolean): void
}

export const useShortcuts = create<ShortcutState>((set) => ({
  overrides: load(),
  recording: false,
  setOverride: (id, hotkey) => set((s) => { const o = { ...s.overrides, [id]: hotkey }; persist(o); return { overrides: o } }),
  clearOverride: (id) => set((s) => { const o = { ...s.overrides }; delete o[id]; persist(o); return { overrides: o } }),
  resetAll: () => { persist({}); set({ overrides: {} }) },
  setRecording: (on) => set({ recording: on }),
}))

/** 命令的生效热键(覆盖优先;显式空串 = 解绑)。 */
export function effectiveHotkey(cmd: { id: string; hotkey?: string }): string {
  const o = useShortcuts.getState().overrides
  return Object.prototype.hasOwnProperty.call(o, cmd.id) ? (o[cmd.id] || '') : (cmd.hotkey || '')
}

/** 键盘事件 → 热键字符串('mod+shift+k');纯修饰键时返回 null(继续等待真正的键)。 */
export function eventToHotkey(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null
  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('mod')
  if (e.shiftKey) parts.push('shift')
  if (e.altKey) parts.push('alt')
  let key = e.key.toLowerCase()
  if (key === ' ') key = 'space'
  else if (key === '{') key = '[' // shift 下 e.key 给 brace,存储统一 bracket(与 hotkeyMatches 归一一致)
  else if (key === '}') key = ']'
  parts.push(key)
  return parts.join('+')
}

/** 热键字符串 → 展示文本(mac 用符号紧排,其它用 Ctrl+Shift+… )。 */
export function formatHotkey(hk: string, isMac: boolean): string {
  if (!hk) return ''
  const sym: Record<string, string> = isMac
    ? { mod: '⌘', shift: '⇧', alt: '⌥', space: 'Space', enter: '↵', escape: 'Esc', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' }
    : { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', space: 'Space', enter: 'Enter', escape: 'Esc', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' }
  const map = (p: string): string => sym[p] || (p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1))
  return hk.split('+').map(map).join(isMac ? '' : '+')
}
