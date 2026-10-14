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
export function effectiveHotkeys(cmd: { id: string; hotkey?: string; hotkeys?: readonly string[] }): string[] {
  const o = useShortcuts.getState().overrides
  if (Object.prototype.hasOwnProperty.call(o, cmd.id)) return o[cmd.id] ? [o[cmd.id]] : []
  return [...new Set([cmd.hotkey, ...(cmd.hotkeys || [])].filter((key): key is string => !!key))]
}

/** First effective binding, for compact labels. Use effectiveHotkeys for dispatch/conflict checks. */
export function effectiveHotkey(cmd: { id: string; hotkey?: string; hotkeys?: readonly string[] }): string {
  return effectiveHotkeys(cmd)[0] || ''
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

/**
 * 「同时按下左右两个 ⌘(mac)/ 两个 Ctrl(其它)」这一招,热键写作 'mod+mod'。它没有主键,eventToHotkey 那套认不出:
 * 这里在捕获阶段记下哪几个修饰键按着,第二个落下的那一下把事件标成「成对」。其间按过别的键、带了 Shift / Alt 都不算。
 * 捕获阶段装是因为录制框会 stopPropagation,冒泡监听看不到那几下。
 */
export const MOD_PAIR = 'mod+mod'
const pairDown = new Set<string>()
const pairEvents = new WeakSet<Event>()
let pairInstalled = false

/** 纯函数那一半(单测钉这里):喂一个键盘事件,更新 down 并回答「这一下是不是凑齐了一对」。 */
export function trackModPair(down: Set<string>, e: Pick<KeyboardEvent, 'type' | 'code' | 'repeat' | 'shiftKey' | 'altKey'>, mac: boolean): boolean {
  if (e.type === 'keyup') { down.delete(e.code); return false }
  const fam = mac ? 'Meta' : 'Control'
  if (e.code !== `${fam}Left` && e.code !== `${fam}Right`) { down.clear(); return false }
  if (e.repeat) return false
  down.add(e.code)
  if (down.size < 2 || e.shiftKey || e.altKey) return false
  down.clear() // 两个都松开再按才算下一次
  return true
}

function installModPair(): void {
  if (pairInstalled || typeof window === 'undefined') return
  pairInstalled = true
  const feed = (e: KeyboardEvent): void => { if (trackModPair(pairDown, e, isMacPlatform())) pairEvents.add(e) }
  window.addEventListener('keydown', feed, true)
  window.addEventListener('keyup', feed, true)
  window.addEventListener('blur', () => pairDown.clear())
}

/** 这个 keydown 是不是「左右修饰键同按」凑齐的那一下。 */
export function isModPair(e: KeyboardEvent): boolean {
  installModPair()
  return pairEvents.has(e)
}

/** 宿主启动时写 `<html data-platform>`(与 desktop ShortcutsTab 同一判据);无 DOM 时按非 mac。 */
export function isMacPlatform(): boolean {
  try { return document.documentElement.dataset.platform === 'mac' } catch { return false }
}

/** 热键字符串 → 展示文本(mac 用符号紧排,其它用 Ctrl+Shift+… )。 */
export function formatHotkey(hk: string, isMac: boolean): string {
  if (!hk) return ''
  if (hk === MOD_PAIR) return isMac ? '⌘ + ⌘' : 'Ctrl + Ctrl'
  const sym: Record<string, string> = isMac
    ? { ctrl: '⌃', meta: '⌘', mod: '⌘', shift: '⇧', alt: '⌥', space: 'Space', enter: '↵', escape: 'Esc', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' }
    : { ctrl: 'Ctrl', meta: 'Meta', mod: 'Ctrl', shift: 'Shift', alt: 'Alt', space: 'Space', enter: 'Enter', escape: 'Esc', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' }
  const map = (p: string): string => sym[p] || (p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1))
  return hk.split('+').map(map).join(isMac ? '' : '+')
}

installModPair()

// Settings live in a separate renderer. Updating a binding must affect the main editor immediately.
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === LS_KEY || event.key === null) useShortcuts.setState({ overrides: load() })
})

/** Compare bindings by the modifiers the dispatcher accepts (including the legacy mod alias). */
export function hotkeysConflict(a: string, b: string): boolean {
  const signatures = (key: string): string[] => {
    const parts = key.toLowerCase().split('+').map(p => p.trim())
    const main = parts.pop() || ''
    if (!parts.includes('mod')) return [[...new Set(parts)].sort().join('+') + '+' + main]
    return ['ctrl', 'meta', 'ctrl+meta'].map(mod => [...new Set([...parts.filter(p => p !== 'mod'), ...mod.split('+')])].sort().join('+') + '+' + main)
  }
  const left = signatures(a)
  return signatures(b).some(key => left.includes(key))
}
