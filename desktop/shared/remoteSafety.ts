/**
 * 急停 + 远程锁定(设备能力 MCP 方案 P1 · K2;INTEGRATION R-01 改名为 remoteSafety*)的跨层契约:
 * 主进程 electron/remoteSafety.ts、IPC、preload window.tangu.remoteSafety、渲染层 RemoteSafetyPanel 共用。刻意零依赖。
 *
 * 锁状态真源 = 主进程独占的 <userData>/remote-lock.json `{v:1, lock:null|{locked,at,source}, hotkey}`
 * (不进 tangu-desktop-config.json:渲染层 config:set 可无认证写那份;不与 K4 的 remote-sessions.json 合用:
 * 引擎对锁文件「读错即锁」,开关 / 信任列表的写入绝不能落进同一个文件)。引擎经 FORSION_REMOTE_LOCK_FILE 每次现读。
 */

export const REMOTE_LOCK_FILE = 'remote-lock.json'
/** ⚠️ 与 tangu-agent/src/services/remoteLock.ts 的 REMOTE_LOCK_FILE_ENV 同名(改名两处同步,各有一条测试钉字符串)。 */
export const REMOTE_LOCK_FILE_ENV = 'FORSION_REMOTE_LOCK_FILE'
/** unitWeb 与引擎中间件锁定时的 423 码(渲染层 services/localOnly.ts 本地化)。 */
export const REMOTE_LOCKED = 'REMOTE_LOCKED'
/** D13 缺省急停热键:mac 上是 ⌃⌥⇧.(不是 mini 那种 CommandOrControl)。 */
export const DEFAULT_ESTOP_HOTKEY = 'Control+Alt+Shift+.'
/** 热键字符串长度上限(IPC 入参校验)。 */
export const HOTKEY_MAX = 64

export type EstopSource = 'hotkey' | 'tray' | 'settings'
/** in_use = 注册返回 false(被别的 App 占了);invalid = 注册抛异常(写法不对);disabled = 用户关掉了热键。 */
export type HotkeyError = 'in_use' | 'invalid' | 'disabled' | null

export interface RemoteSafetyHotkey {
  /** '' = 关掉。 */
  accelerator: string
  registered: boolean
  error: HotkeyError
}

export interface RemoteSafetyRun {
  runId: string
  sessionId: string
  category: 'remote' | 'channel' | 'unattended'
  /** 已按界面语言解析好的来源名(设备名 / 「本账号的浏览器与网页版」/ 微信 / Muse …);纯文本。 */
  label: string
  pendingApprovals: number
  pendingInquiries: number
  startedAt: number
}

export interface RemoteSafetyState {
  locked: boolean
  lockedAt: number | null
  lockSource: EstopSource | null
  /** 急停时锁文件没写成(闩在引擎进程内兜到下次重启;面板与通知如实说)。 */
  lockPersistFailed: boolean
  hotkey: RemoteSafetyHotkey
  engine: 'connected' | 'unavailable'
  /** 引擎当时不可达,急停待补发(引擎 ready 后自动补)。 */
  pendingEstop: boolean
  remoteRuns: RemoteSafetyRun[]
  lastEstop: { at: number; aborted: number; killedProcesses: number; revertedEntries: number; engineReached: boolean } | null
}

export type UnlockResult = { ok: true } | { ok: false; reason: 'cancelled' | 'unavailable' | 'failed' }

/** window.tangu.remoteSafety(只在执行设备本机的主窗口;设备页 / web / 手机没有)。 */
export interface RemoteSafetyApi {
  get(): Promise<RemoteSafetyState>
  /** 立即急停(source 固定 settings)。 */
  estop(): Promise<RemoteSafetyState>
  /** 本机系统认证后解锁。 */
  unlock(): Promise<UnlockResult>
  /** '' = 关掉热键;失败时保留旧键,回最新热键子状态。 */
  setHotkey(accelerator: string): Promise<RemoteSafetyHotkey>
  onChanged(cb: (s: RemoteSafetyState) => void): () => void
}

const MAC_SYMBOL: Record<string, string> = {
  Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', AltGr: '⌥', Shift: '⇧', Command: '⌘', Cmd: '⌘', Super: '⌘', Meta: '⌘',
  CommandOrControl: '⌘', CmdOrCtrl: '⌘',
}
const OTHER_LABEL: Record<string, string> = { Control: 'Ctrl', Ctrl: 'Ctrl', CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Command: 'Win', Cmd: 'Win', Super: 'Win', Meta: 'Win', Option: 'Alt' }

/** Electron accelerator → 显示串:mac `⌃⌥⇧.`,其余 `Ctrl+Alt+Shift+.`。'' → ''。 */
export function formatAccelerator(acc: string, mac: boolean): string {
  if (!acc) return ''
  const parts = acc.split('+').filter(Boolean) // Electron 的 '+' 键写作 Plus,不会出现空段
  if (mac) return parts.map((p) => MAC_SYMBOL[p] ?? p).join('')
  return parts.map((p) => OTHER_LABEL[p] ?? p).join('+')
}

const CODE_KEYS: Record<string, string> = {
  Period: '.', Comma: ',', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Minus: '-', Equal: '=', Backquote: '`', Escape: 'Esc', Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
  Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
}

/**
 * 录制热键:键盘事件 → Electron accelerator。按物理键位(code)取键,不看 key —— ⇧ / ⌥ 会把 key 变成别的字符(⌥. = ≥)。
 * 只按修饰键 / 没有修饰键 / 认不出的键 → null(继续录)。至少两个修饰键:急停不该被一个 Ctrl+X 这类常用组合误触。
 */
export function acceleratorFromKeyEvent(e: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super') // Super:mac 上 = ⌘,Windows / Linux 上 = Win 键(Electron 语义)
  if (mods.length < 2) return null
  let key: string | undefined
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5)
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code
  else key = CODE_KEYS[e.code]
  return key ? [...mods, key].join('+') : null
}
