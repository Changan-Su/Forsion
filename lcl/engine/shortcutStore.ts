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

// 设置是独立浮窗(09-20 起):在那边改了键,主窗 / 独立窗跟着换,不用重开(storage 事件只发给别的窗口)
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => { if (e.key === LS_KEY || e.key === null) useShortcuts.setState({ overrides: load() }) })

/** 命令的生效热键(覆盖优先;显式空串 = 解绑)。 */
export function effectiveHotkey(cmd: { id: string; hotkey?: string }): string {
  const o = useShortcuts.getState().overrides
  return Object.prototype.hasOwnProperty.call(o, cmd.id) ? (o[cmd.id] || '') : (cmd.hotkey || '')
}

/** 事件的主键(小写)。mac 上按着 ⌥ 时 e.key 是变体字符(⌥⌘V 给 '√'),字母 / 数字键改认物理键位 e.code ——
 *  不然 'mod+alt+v' 永远对不上,录键也会录成 'mod+alt+√'。只在 mac 上这样认:Windows / Linux 的 AltGr = Ctrl+Alt,
 *  那时 e.key 是用户在打的字(波兰语 ż = AltGr+Z),按键位认会把打字当成快捷键。 */
export function hotkeyKeyOf(e: Pick<KeyboardEvent, 'key' | 'code' | 'altKey'>): string {
  if (e.altKey && isMacPlatform()) {
    const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(e.code || '')
    if (m) return (m[1] ?? m[2]).toLowerCase()
  }
  return e.key.toLowerCase()
}

/** 键盘事件 → 热键字符串('mod+shift+k');纯修饰键时返回 null(继续等待真正的键)。 */
export function eventToHotkey(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null
  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('mod')
  if (e.shiftKey) parts.push('shift')
  if (e.altKey) parts.push('alt')
  let key = hotkeyKeyOf(e)
  if (key === ' ') key = 'space'
  else if (key === '{') key = '[' // shift 下 e.key 给 brace,存储统一 bracket(与 hotkeyMatches 归一一致)
  else if (key === '}') key = ']'
  parts.push(key)
  return parts.join('+')
}

/**
 * 「同时按下左右两个同名修饰键」这一招,热键写作 '<键>+<键>':'mod+mod'(mac 两个 ⌘ / 其它两个 Ctrl)、'shift+shift'、
 * 'alt+alt'(两个 ⌥ / Alt)。它没有主键,eventToHotkey 那套认不出(而且 'shift+shift' 交给通用匹配会在每一次单按 Shift
 * 时都对上):这里在捕获阶段记下哪几个修饰键按着,第二个落下的那一下把事件标成「凑齐了哪一对」。其间按过别的键、
 * 带着别的修饰键都不算。捕获阶段装是因为录制框会 stopPropagation,冒泡监听看不到那几下。
 */
export const MOD_PAIR = 'mod+mod'
const PAIRS = [MOD_PAIR, 'shift+shift', 'alt+alt']
export const isPairHotkey = (hk: string): boolean => PAIRS.includes(hk)
const pairDown = new Set<string>()
const pairEvents = new WeakMap<Event, string>()
let pairInstalled = false

/** 'ShiftLeft' → 'shift+shift';不是左右修饰键 → null。 */
function pairOfCode(code: string, mac: boolean): string | null {
  const fam = code.replace(/(Left|Right)$/, '')
  if (fam === code) return null
  if (fam === (mac ? 'Meta' : 'Control')) return MOD_PAIR
  return fam === 'Shift' ? 'shift+shift' : fam === 'Alt' ? 'alt+alt' : null
}

/** 纯函数那一半(单测钉这里):喂一个键盘事件,更新 down,凑齐一对的那一下回答是哪一对。 */
export function trackPair(down: Set<string>, e: Pick<KeyboardEvent, 'type' | 'code' | 'repeat' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey'>, mac: boolean): string | null {
  if (e.type === 'keyup') { down.delete(e.code); return null }
  const pair = pairOfCode(e.code, mac)
  if (!pair) { down.clear(); return null }
  if (e.repeat) return null
  if ([...down].some((c) => pairOfCode(c, mac) !== pair)) down.clear() // 换了一族修饰键:从这一个重新数
  down.add(e.code)
  if (down.size < 2) return null
  const own = pair === MOD_PAIR ? (mac ? 'metaKey' : 'ctrlKey') : pair === 'shift+shift' ? 'shiftKey' : 'altKey'
  if ((['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const).some((k) => k !== own && e[k])) return null
  down.clear() // 两个都松开再按才算下一次
  return pair
}

function installModPair(): void {
  if (pairInstalled || typeof window === 'undefined') return
  pairInstalled = true
  const feed = (e: KeyboardEvent): void => { const pair = trackPair(pairDown, e, isMacPlatform()); if (pair) pairEvents.set(e, pair) }
  window.addEventListener('keydown', feed, true)
  window.addEventListener('keyup', feed, true)
  window.addEventListener('blur', () => pairDown.clear())
}

/** 这个 keydown 若是「左右修饰键同按」凑齐的那一下,回答是哪一对('mod+mod' / 'shift+shift' / 'alt+alt')。 */
export function pairHotkeyOf(e: KeyboardEvent): string | null {
  installModPair()
  return pairEvents.get(e) ?? null
}

/** 宿主启动时写 `<html data-platform>`(与 desktop ShortcutsTab 同一判据);无 DOM 时按非 mac。 */
export function isMacPlatform(): boolean {
  try { return document.documentElement.dataset.platform === 'mac' } catch { return false }
}

/** 热键字符串 → 展示文本(mac 用符号紧排,其它用 Ctrl+Shift+… )。 */
export function formatHotkey(hk: string, isMac: boolean): string {
  if (!hk) return ''
  // 同按一对写成 ⌘⌘(不是「⌘ + ⌘」:那读起来像先后两个组合键);Ctrl 这类单词名照旧「Ctrl + Ctrl」
  if (isPairHotkey(hk)) { const one = formatHotkey(hk.split('+')[0], isMac); return one.length > 1 ? `${one} + ${one}` : `${one}${one}` }
  const sym: Record<string, string> = isMac
    ? { mod: '⌘', shift: '⇧', alt: '⌥', space: 'Space', enter: '↵', escape: 'Esc', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' }
    : { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', space: 'Space', enter: 'Enter', escape: 'Esc', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' }
  const map = (p: string): string => sym[p] || (p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1))
  // mac 按系统菜单的顺序排修饰键(⌥⇧⌘:写 'mod+alt+v' 也显示 ⌥⌘V);其它平台照存的顺序(Ctrl+Alt+V)
  const MAC_ORDER = ['alt', 'shift', 'mod']
  const parts = hk.split('+')
  const keyed = isMac ? [...parts.slice(0, -1).sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b)), parts[parts.length - 1]] : parts
  return keyed.map(map).join(isMac ? '' : '+')
}

installModPair()
