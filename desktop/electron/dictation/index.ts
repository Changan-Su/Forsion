/**
 * 全局语音输入(听写)的主进程接线。main.ts 只调一次 registerDictation(...)。
 * 状态机在 controller.ts,往别的应用写字在 macDriver.ts / winDriver.ts,胶囊窗口在 capsuleWindow.ts,契约在 shared/dictation.ts。
 *
 * 信任边界:
 *   - 渲染层(官方插件)只经 DICTATION_CHANNELS:挂 / 撤租约、换快捷键、读状态、请辅助功能授权。任何受信窗口都能调 —— 插件今天
 *     在宿主渲染进程里执行、能直调 window.tangu,这一层挡不住第三方;但这几条没有一条能写字。
 *   - 写字的文字只认胶囊那个 webContents(sender.id === capsule.contentsId())交回来、且会话号对得上的那一份。
 *   - 写到哪只认按快捷键那一刻记下的目标;写之前驱动再核一遍。
 *
 * 测试口子(台架用,只在 macOS 有意义):环境变量 FORSION_DICTATION_PASTEBOARD=<名字> → 剪贴板操作改走这个私有剪贴板、绝不发 ⌘V,
 * 并把「辅助功能授权」当作有(不然走不到驱动);FORSION_E2E_DICTATION=1 → 把控制器挂在 globalThis.__forsionDictation 上,
 * 台架直接调 toggle()(不合成全局按键:那会把字敲进用户此刻在用的应用)。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, clipboard, globalShortcut, ipcMain, shell, systemPreferences, webContents, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { DICTATION_CAPSULE_CHANNELS, DICTATION_CHANNELS, DICTATION_DEFAULT_HOTKEY, type DictationCapsuleAction, type DictationState } from '../../shared/dictation'
import { hotkeyToAccelerator } from '../appRefHotkey'
import type { GlobalHotkeyPause } from '../globalHotkeyPause'
import { mainLocale } from '../mainI18n'
import { createCapsuleWindow } from './capsuleWindow'
import { createDictationController, type DictationController, type DictationTarget, type InsertResult } from './controller'
import { createMacDriver } from './macDriver'
import { createWinDriver } from './winDriver'

export interface DictationHostDeps {
  isTrustedSender(e: IpcMainEvent | IpcMainInvokeEvent): boolean
  globalHotkeyPause: GlobalHotkeyPause
  /** 插件沙箱实例:不注册任何全局键。 */
  sandbox: boolean
  /** main 的 __dirname(找 preload / renderer 产物)。 */
  dirname: string
  /** dev:electron-vite 的渲染服务地址。 */
  rendererUrl?: string
  userData: string
}

/** Forsion 自己的窗口:焦点在哪种元素上。在**焦点所在的那个 frame** 里跑(插件 iframe 里的框也得到真答案);
 * 只有确认是可写文本框('text')才写 —— 'frame'(焦点在拿不到的子 frame 里)/ 探测失败都当看不清,不写(可能是密码框)。
 * 主世界里跑,插件能骗它,骗了也只是把字写进 Forsion 自己的窗口。 */
const FIELD_PROBE = `(() => {
  let a = document.activeElement
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement
  if (!a || a === document.body || a === document.documentElement) return 'none'
  if (a.tagName === 'IFRAME' || a.tagName === 'WEBVIEW') return 'frame'
  if (a.tagName === 'INPUT') {
    const t = (a.getAttribute('type') || 'text').toLowerCase()
    if (t === 'password') return 'secure'
    return ['text', 'search', 'url', 'email', 'tel', ''].includes(t) && !a.readOnly && !a.disabled ? 'text' : 'none'
  }
  if (a.tagName === 'TEXTAREA') return a.readOnly || a.disabled ? 'none' : 'text'
  return a.isContentEditable ? 'text' : 'none'
})()`

async function insertIntoSelf(id: number, text: string): Promise<InsertResult> {
  const wc = webContents.fromId(id)
  const focused = webContents.getFocusedWebContents()
  if (!wc || wc.isDestroyed() || !focused || focused.id !== id) return { ok: false, failure: 'target-changed' }
  let field = 'unknown'
  try {
    const frame = wc.focusedFrame ?? wc.mainFrame
    field = String(await frame.executeJavaScript(FIELD_PROBE, true))
  } catch { /* 看不清 = 不写 */ }
  if (field === 'secure') return { ok: false, failure: 'secure-field' }
  if (field !== 'text') return { ok: false, failure: 'no-field' }
  if (wc.isDestroyed() || webContents.getFocusedWebContents()?.id !== id) return { ok: false, failure: 'target-changed' }
  try { await wc.insertText(text) } catch { return { ok: false, failure: 'paste-failed' } }
  return { ok: true }
}

async function readHotkey(file: string): Promise<string> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { hotkey?: unknown }
    if (typeof raw.hotkey === 'string' && hotkeyToAccelerator(raw.hotkey)) return raw.hotkey
  } catch { /* 没有 / 读不了 / 坏了 = 不知道:用缺省,但不写回(只有用户换键时才写) */ }
  return DICTATION_DEFAULT_HOTKEY
}

async function writeHotkey(file: string, hotkey: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify({ hotkey }, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

export function registerDictation(h: DictationHostDeps): DictationController | null {
  const platform = process.platform
  if (platform !== 'darwin' && platform !== 'win32') return null
  const testBoard = platform === 'darwin' ? (process.env.FORSION_DICTATION_PASTEBOARD || '').trim() : ''
  const mac = platform === 'darwin' ? createMacDriver() : null
  const win = platform === 'win32' ? createWinDriver() : null
  const file = join(h.userData, 'dictation.json')
  const capsule = createCapsuleWindow({ dirname: h.dirname, rendererUrl: h.rendererUrl, title: 'Forsion voice input' })
  const accels = new Map<string, string>() // hotkey → 注册时用的 accelerator
  const owners = new Map<number, () => void>() // 租约:webContents id → 撤监听

  const accessibility = (): boolean => {
    if (platform !== 'darwin' || testBoard) return true
    try { return systemPreferences.isTrustedAccessibilityClient(false) } catch { return false }
  }
  const broadcast = (s: DictationState): void => {
    const capsuleId = capsule.contentsId()
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || w.webContents.id === capsuleId) continue
      w.webContents.send(DICTATION_CHANNELS.changed, s)
    }
  }

  const controller = createDictationController({
    platform,
    async captureTarget(): Promise<DictationTarget | null> {
      win?.warm()
      const focused = webContents.getFocusedWebContents()
      if (focused && !focused.isDestroyed() && focused.id !== capsule.contentsId() && BrowserWindow.getFocusedWindow()) {
        return { kind: 'self', webContentsId: focused.id }
      }
      const f = mac ? await mac.front() : win ? await win.front() : null
      if (!f || f.pid === process.pid) return null // Forsion 在前台却没有聚焦的窗口:不猜
      const app = 'name' in f && typeof f.name === 'string' ? f.name : ''
      return { kind: 'external', pid: f.pid, ...(f.window ? { window: f.window } : {}), ...(app ? { app } : {}) }
    },
    async insert(target, text) {
      if (target.kind === 'self') return insertIntoSelf(target.webContentsId, text)
      const tgt = { pid: target.pid, ...(target.window ? { window: target.window } : {}) }
      const r = mac ? await mac.insert({ text, target: tgt, ...(testBoard ? { pasteboard: testBoard } : {}) })
        : win ? await win.insert({ text, target: tgt })
        : { outcome: 'unsupported' as const }
      if (r.outcome === 'pasted') return { ok: true, restored: r.restored === true }
      return { ok: false, failure: r.outcome }
    },
    async copy(text) {
      if (mac) { if (!(await mac.copy(text, testBoard || undefined))) throw new Error('copy failed') }
      else clipboard.writeText(text)
    },
    accessibility,
    requestAccessibility() {
      if (platform !== 'darwin') return
      try { if (systemPreferences.isTrustedAccessibilityClient(true)) return } catch { /* 下面直接开设置 */ }
      void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
    },
    register(hotkey, cb) {
      const accel = hotkeyToAccelerator(hotkey)
      if (!accel) return false
      try {
        if (!globalShortcut.register(accel, cb)) return false
      } catch { return false }
      accels.set(hotkey, accel)
      return true
    },
    unregister(hotkey) {
      const accel = accels.get(hotkey)
      accels.delete(hotkey)
      if (accel) try { globalShortcut.unregister(accel) } catch { /* 已不在 */ }
    },
    registerEscape(cb) {
      try { return globalShortcut.register('Escape', cb) } catch { return false }
    },
    unregisterEscape() {
      try { globalShortcut.unregister('Escape') } catch { /* 已不在 */ }
    },
    capsule,
    emit: broadcast,
    locale: mainLocale,
    newId: randomUUID,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    log: (m) => console.warn(m),
  }, { hotkey: DICTATION_DEFAULT_HOTKEY })

  void readHotkey(file).then((hk) => { if (hk !== DICTATION_DEFAULT_HOTKEY) controller.setHotkey(hk) })
  if (!h.sandbox) h.globalHotkeyPause.add({ pause: () => controller.pause(), resume: () => controller.resume() })

  const release = (id: number): void => {
    const off = owners.get(id)
    if (!off) return
    owners.delete(id)
    off()
    controller.detach(id)
    win?.keepWarm(owners.size > 0)
  }
  ipcMain.handle(DICTATION_CHANNELS.state, (e) => (h.isTrustedSender(e) ? controller.state() : null))
  ipcMain.handle(DICTATION_CHANNELS.attach, (e, on: unknown) => {
    if (!h.isTrustedSender(e) || h.sandbox) return null
    const wc = e.sender
    if (on !== true) { release(wc.id); return controller.state() }
    if (!owners.has(wc.id)) {
      const id = wc.id
      const gone = (): void => release(id)
      const nav = (_e: unknown, _url: string, inPlace: boolean, mainFrame: boolean): void => { if (mainFrame && !inPlace) release(id) }
      wc.once('destroyed', gone)
      wc.on('did-start-navigation', nav)
      owners.set(id, () => { wc.removeListener('destroyed', gone); wc.removeListener('did-start-navigation', nav) })
      controller.attach(id)
      win?.keepWarm(true)
    }
    return controller.state()
  })
  ipcMain.handle(DICTATION_CHANNELS.setHotkey, async (e, raw: unknown) => {
    if (!h.isTrustedSender(e)) return null
    const hk = typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 64) : ''
    if (!hotkeyToAccelerator(hk)) return controller.state()
    const s = controller.setHotkey(hk)
    await writeHotkey(file, hk).catch((err) => console.warn('[dictation] save hotkey failed:', err))
    return s
  })
  ipcMain.handle(DICTATION_CHANNELS.allow, (e) => {
    if (!h.isTrustedSender(e)) return null
    if (platform === 'darwin') {
      try { if (!systemPreferences.isTrustedAccessibilityClient(true)) void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility') } catch { /* ignore */ }
    }
    return controller.state()
  })

  // 胶囊交回来的:只认胶囊那个 webContents。
  const fromCapsule = (e: IpcMainEvent): boolean => e.sender.id === capsule.contentsId() && e.senderFrame === e.sender.mainFrame
  ipcMain.on(DICTATION_CAPSULE_CHANNELS.result, (e, id: unknown, text: unknown) => {
    if (fromCapsule(e) && typeof id === 'string' && typeof text === 'string') controller.capsuleResult(id, text.slice(0, 20_000))
  })
  ipcMain.on(DICTATION_CAPSULE_CHANNELS.error, (e, id: unknown, msg: unknown) => {
    if (fromCapsule(e) && typeof id === 'string') controller.capsuleError(id, typeof msg === 'string' ? msg : '')
  })
  ipcMain.on(DICTATION_CAPSULE_CHANNELS.action, (e, id: unknown, action: unknown) => {
    const ok: readonly DictationCapsuleAction[] = ['stop', 'cancel', 'copy', 'dismiss', 'allow']
    if (fromCapsule(e) && typeof id === 'string' && ok.includes(action as DictationCapsuleAction)) controller.capsuleAction(id, action as DictationCapsuleAction)
  })

  if (process.env.FORSION_E2E_DICTATION === '1') (globalThis as { __forsionDictation?: unknown }).__forsionDictation = { controller, capsule }
  // 退出时全局键由 main 的 globalShortcut.unregisterAll() 一并撤;Windows 助手进程 stdin 一断就自己退。
  return controller
}
