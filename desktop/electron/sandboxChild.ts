/**
 * 插件沙箱 · 子进程这侧(沙箱那份 Forsion 的主进程)。父进程那侧见 pluginSandbox.ts,契约 tangu-agent/docs/plugin-sandbox.md。
 *
 * 只在 FORSION_SANDBOX=1 时启用(父进程 spawn 时带上,同时带插件目录、控制通道地址和一次性令牌):
 *  · 连回父进程的 socket,先报令牌,之后按行收请求:status / screenshot / command / reload / show / quit,
 *    以及 agent 在沙箱里动手的 read / click / type / press / scroll / space / files(11-03 起);
 *  · 状态、命令、找元素交给渲染层的 `window.__forsionSandbox`(frontend/src/sandbox/sandboxWindow.ts),主进程负责截图、窗口、
 *    真输入事件(sendInputEvent / insertText)和原生文件对话框(files 先备好答案,对话框就不弹);
 *  · 监视插件文件夹,保存即重载(Coding Studio 的「保存即重载」靠项目开着,沙箱里没有 Coding Studio);
 *  · 渲染层沙箱条上的按钮(报告问题 / 安装 / 重置)经 IPC 到这里,再作为事件转给父进程。
 */
import { app, BrowserWindow, dialog, ipcMain, session, type WebContents } from 'electron'
import { connect, type Socket } from 'node:net'
import { watch, lstatSync, realpathSync, type FSWatcher } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { parseStageInfo, type StageChildInfo } from '../shared/pluginStage'
import { mtFor } from './mainI18n'
import './pluginSandbox' // 窗口标题的文案片段(PLUGIN_SANDBOX_MESSAGES)在那边注册

export interface SandboxSelf {
  pluginId: string
  name: string
  version: string
  dir: string
  /** 沙箱自己的智库与根目录(<forsionHome>/sandbox/<id>);老父进程不带 = ''。 */
  vault: string
  root: string
  /** 父进程带来的语言与主题(PluginSandboxUiSeed),渲染层首屏写进 localStorage。 */
  ui?: unknown
  /** 演示舞台(pluginStage.ts):不装开发副本、不监视目录;窗口尺寸 / 像素密度 / 时钟按这里给。普通沙箱没有这一段。 */
  stage?: StageChildInfo
}

/** 本进程是不是沙箱。只认父进程给的三件:标志、通道、令牌。 */
export function sandboxSelf(env: NodeJS.ProcessEnv = process.env): SandboxSelf | null {
  if (env.FORSION_SANDBOX !== '1' || !env.FORSION_SANDBOX_SOCK || !env.FORSION_SANDBOX_TOKEN || !env.FORSION_SANDBOX_PLUGIN) return null
  try {
    const info = JSON.parse(env.FORSION_SANDBOX_INFO || '{}') as Partial<SandboxSelf>
    if (typeof info.pluginId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(info.pluginId)) return null
    return {
      pluginId: info.pluginId, name: String(info.name || info.pluginId), version: String(info.version || ''), dir: env.FORSION_SANDBOX_PLUGIN,
      vault: typeof info.vault === 'string' ? info.vault : '', root: typeof info.root === 'string' ? info.root : '', ui: info.ui,
      ...(info.stage ? (() => { const st = parseStageInfo(info.stage); return st ? { stage: st } : {} })() : {}),
    }
  } catch {
    return null
  }
}

let sock: Socket | null = null
let authed = false
const queued: Array<Record<string, unknown>> = []
let forward = (kind: 'url' | 'file', value: string): void => { queued.push({ event: 'forward', kind, value }) }
/** 系统把链接 / 文件投给了沙箱(与用户那份同一个 bundle):转给父进程去开。启动早期通道还没连上就先排队。 */
export function sandboxForward(kind: 'url' | 'file', value: string): void { forward(kind, value) }

const SHOT_WIDTH = 1280
/** 沙箱窗口平时压在别的窗口底下:Chromium 把被遮住的窗口当后台、不出新帧,截到的是旧画面(11-03 反馈)。app ready 之前加(main.ts)。 */
export const SANDBOX_SWITCHES = ['disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows', 'disable-background-timer-throttling'] as const
const STARTING = 'the sandbox window is still starting'
const NAMED_KEYS = new Set(['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Space', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown'])
const KEY_ALIAS: Record<string, string> = { arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', esc: 'Escape', return: 'Enter', del: 'Delete', pageup: 'PageUp', pagedown: 'PageDown' }
const MODS: Record<string, string> = { cmd: 'meta', command: 'meta', meta: 'meta', ctrl: 'control', control: 'control', alt: 'alt', option: 'alt', shift: 'shift' }

/** "Meta+K" / "Mod+Enter" / "ArrowDown" → sendInputEvent 的一组事件;认不出的键回 null。纯函数,单测钉。 */
export function keyEvents(combo: string, platform: NodeJS.Platform = process.platform): Array<Record<string, unknown>> | null {
  const parts = combo.split('+').map((x) => x.trim())
  const raw = parts.pop() ?? ''
  const modifiers: string[] = []
  for (const m of parts) {
    const k = m.toLowerCase() === 'mod' ? (platform === 'darwin' ? 'meta' : 'control') : MODS[m.toLowerCase()]
    if (!k) return null
    modifiers.push(k)
  }
  const named = KEY_ALIAS[raw.toLowerCase()] ?? [...NAMED_KEYS].find((k) => k.toLowerCase() === raw.toLowerCase())
  if (!named && !/^(.|F([1-9]|1[0-2]))$/u.test(raw)) return null
  const keyCode = named ?? raw
  // 字符事件才会真把字打进输入框:带 shift 以外修饰键的是快捷键,不打字
  const text = modifiers.some((m) => m !== 'shift') ? '' : keyCode === 'Enter' ? '\r' : keyCode === 'Space' ? ' ' : keyCode === 'Tab' ? '\t' : raw.length === 1 ? raw : ''
  return [
    { type: 'keyDown', keyCode, modifiers },
    ...(text ? [{ type: 'char', keyCode: text, modifiers }] : []),
    { type: 'keyUp', keyCode, modifiers },
  ]
}

/** files 动作给的路径:只认插件目录与沙箱根里面的(按真实路径核,软链指出去的不算)。save 的文件可以还不存在,核它的父目录。 */
export function sandboxFilePath(p: string, base: { dir: string; root: string }, mustExist: boolean): string | null {
  if (!p || p.length > 4096) return null
  const abs = isAbsolute(p) ? resolve(p) : resolve(base.dir, p)
  // The Windows native resolver canonicalizes drive case and extended-length paths
  // while still following junctions before the containment check.
  const resolveReal = process.platform === 'win32' ? realpathSync.native : realpathSync
  const real = (x: string): string | null => { try { return resolveReal(x) } catch { return null } }
  // 已经在的(哪怕是软链)一律按它真实指向核:save 到一个指出去的软链 = 写穿到沙箱外面(Codex 评审);只有还不存在的才按父目录核
  const there = (() => { try { lstatSync(abs); return true } catch { return false } })()
  const target = mustExist || there ? real(abs) : (() => { const d = real(dirname(abs)); return d && resolve(d, basename(abs)) })()
  if (!target) return null
  const inside = (root: string): boolean => { const r = root && real(root); return !!r && (target === r || target.startsWith(r + sep)) }
  return inside(base.dir) || inside(base.root) ? target : null
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))])
/** 改过的文件不算数的:依赖、版本库、编辑器的临时文件。 */
const IGNORE = /(^|[\\/])(node_modules|\.git|\.forsion)([\\/]|$)|(~|\.swp|\.tmp)$/

/** 一次钩子调用的结果。没做成的分四种,报给 agent 的话各不相同(11-15 反馈:以前一律报「还在启动」,
 *  其实是命令在等自己弹的对话框):窗口没开 / 钩子还没装上(渲染层在启动)/ 等超时(页面忙或卡住)/ 调用本身抛了。 */
export type HookCall = { ok: true; value: unknown } | { ok: false; miss: 'closed' | 'starting' | 'timeout' | 'failed'; ms?: number }
/** 没做成 → 给 agent 的一句话。纯函数,单测钉。 */
export function hookMissText(r: Extract<HookCall, { ok: false }>, where: 'main' | 'settings' = 'main'): string {
  const w = where === 'settings' ? 'the sandbox settings window' : 'the sandbox window'
  switch (r.miss) {
    case 'closed': return `${w} is not open`
    case 'starting': return where === 'settings' ? `${w} is still loading` : STARTING
    case 'timeout': return `${w} did not answer within ${Math.round((r.ms ?? 10_000) / 1000)}s: its page is busy or stuck (the plugin may be in a long loop or blocking it); take a screenshot or check status`
    default: return `${w} could not run the request (its page may have reloaded meanwhile); try again`
  }
}
const TIMED_OUT = Symbol('timeout')
const FAILED = Symbol('failed')
/** 窗口要等一会儿才出现 / 才就绪:每 200ms 问一次,到点了还不行回 null。 */
async function waitFor<T>(probe: () => T | null | Promise<T | null>, ms: number): Promise<T | null> {
  const end = Date.now() + ms
  for (;;) {
    const v = await probe()
    if (v) return v
    if (Date.now() >= end) return null
    await new Promise((r) => setTimeout(r, 200))
  }
}

export function startSandboxChild(self: SandboxSelf, opts: {
  getWindow(): BrowserWindow | null
  /** 设置窗口(独立的浮动面板,11-15 起 agent 能经 settings 动作打开它、按 window 选它动手);老接线不给 = 没有。 */
  getSettingsWindow?(): BrowserWindow | null
  /** 安装确认框弹着时让开置顶的浮窗(钉住的浮动面板 / 插件桌面小窗),回放回去的函数(main.ts yieldPinnedWindows)。 */
  yieldPinned?(): () => void
  quit(): void
  log(m: string): void
}): void {
  const win = (): BrowserWindow | null => {
    const w = opts.getWindow()
    return w && !w.isDestroyed() ? w : null
  }
  const settingsWin = (): BrowserWindow | null => {
    const w = opts.getSettingsWindow?.() ?? null
    return w && !w.isDestroyed() ? w : null
  }
  /** 调渲染层的沙箱钩子(缺省主窗)。钩子还没装上 = starting;插件把渲染层卡死时等不回来 = timeout。 */
  const call = async (expr: string, ms = 10_000, w: BrowserWindow | null = win()): Promise<HookCall> => {
    if (!w || w.isDestroyed()) return { ok: false, miss: 'closed' }
    const js = `(async () => { const h = window.__forsionSandbox; if (!h) return { missing: true }; return { v: await h.${expr} } })()`
    const r = await withTimeout<unknown>(w.webContents.executeJavaScript(js, true).catch(() => FAILED), ms, TIMED_OUT)
    if (r === TIMED_OUT) return { ok: false, miss: 'timeout', ms }
    if (r === FAILED || !r || typeof r !== 'object') return { ok: false, miss: 'failed' }
    if ((r as { missing?: unknown }).missing === true) return { ok: false, miss: 'starting' }
    return { ok: true, value: (r as { v?: unknown }).v }
  }
  /** 只要值、不管为什么没拿到的地方(等落定 / 截图前等帧 / 收尾):没拿到 = null。 */
  const hook = async (expr: string, ms = 10_000, w: BrowserWindow | null = win()): Promise<unknown> => {
    const r = await call(expr, ms, w)
    return r.ok ? r.value : null
  }

  // 原生文件对话框:agent 先用 files 备好答案,插件弹框时直接拿到,不弹(弹出来的框截图里看不见,agent 也点不了);
  // 没备就照常弹(用户可能正亲手在试),弹着的时候状态里报出来
  let armed: { paths: string[] } | { cancel: true } | null = null
  let openDialog: { kind: 'open' | 'save' | 'message'; title: string } | null = null
  const optsOf = (a: unknown[]): { title?: unknown } | undefined => a.find((x): x is { title?: unknown } => !!x && typeof x === 'object' && !(x instanceof BrowserWindow))
  const tracked = <T>(kind: 'open' | 'save' | 'message', a: unknown[], real: () => Promise<T>): Promise<T> => {
    const t = optsOf(a)?.title
    openDialog = { kind, title: typeof t === 'string' ? t.slice(0, 200) : '' }
    void pushState()
    return real().finally(() => { openDialog = null; void pushState() })
  }
  const take = (): { paths: string[] } | { cancel: true } | null => { const a = armed; armed = null; if (a) { void pushState(); void fileInputs(false).catch(() => {}) } return a }
  const realOpen = dialog.showOpenDialog.bind(dialog) as (...a: unknown[]) => Promise<Electron.OpenDialogReturnValue>
  const realSave = dialog.showSaveDialog.bind(dialog) as (...a: unknown[]) => Promise<Electron.SaveDialogReturnValue>
  const realMsg = dialog.showMessageBox.bind(dialog) as (...a: unknown[]) => Promise<Electron.MessageBoxReturnValue>
  dialog.showOpenDialog = ((...a: unknown[]) => {
    const r = take()
    if (r) return Promise.resolve('cancel' in r ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: r.paths })
    return tracked('open', a, () => realOpen(...a))
  }) as typeof dialog.showOpenDialog
  dialog.showSaveDialog = ((...a: unknown[]) => {
    const r = take()
    if (r) return Promise.resolve('cancel' in r ? { canceled: true, filePath: '' } : { canceled: false, filePath: r.paths[0] })
    return tracked('save', a, () => realSave(...a))
  }) as typeof dialog.showSaveDialog
  dialog.showMessageBox = ((...a: unknown[]) => tracked('message', a, () => realMsg(...a))) as typeof dialog.showMessageBox

  const status = async (): Promise<unknown> => {
    const st = await hook('status()')
    const w = win()
    const host = { vault: self.vault, dialog: openDialog, filesArmed: armed ? ('cancel' in armed ? 'cancel' : 'paths') : null }
    if (!st || typeof st !== 'object') {
      return { v: 1, state: 'starting', pluginId: self.pluginId, name: self.name, version: self.version, dir: self.dir, views: [], spaces: [], hiddenSpaces: [], setupError: null, blocked: null, mountErrors: [], logs: [], warnCount: 0, errorCount: 0, loads: 0, windowVisible: false, ...host }
    }
    // 「用户正在用沙箱窗口」= 它(或它的设置窗口)在前台。静默模式下窗口压在普通窗口之下,isVisible 恒真,拿它判闲置就永远不停
    return { ...(st as object), windowVisible: (!!w && w.isFocused()) || !!settingsWin()?.isFocused(), ...host }
  }
  /** 截一扇窗(缺省主窗);view 只对主窗有意义(先开插件的那个视图)。 */
  const screenshot = async (view?: string, settleFirst = false, w: BrowserWindow | null = win()): Promise<string | null> => {
    if (!w) return null
    if (view) await hook(`openView(${JSON.stringify(view)})`, 10_000, w)
    if (view || settleFirst) await hook('settle()', 10_000, w)
    if (w.isDestroyed()) return null
    // 先要一帧新的再截:不然截到的可能是上一次画好的那一帧(窗口在后台时尤其)
    w.webContents.invalidate()
    await hook('frames(2)', 1500, w)
    const img = await w.webContents.capturePage().catch(() => null)
    if (!img || img.isEmpty()) return null
    const { width } = img.getSize()
    const out = width > SHOT_WIDTH ? img.resize({ width: SHOT_WIDTH, quality: 'good' }) : img
    return `data:image/jpeg;base64,${out.toJPEG(80).toString('base64')}`
  }

  /** 动手的那扇窗:window "settings",或没写 window 而 target 是设置窗口给的引用(s12)。 */
  type Pick = { w: BrowserWindow; where: 'main' | 'settings' } | { error: string }
  const pick = (args: Record<string, unknown>): Pick => {
    const ref = typeof args.target === 'string' && /^s\d+$/.test(args.target.trim())
    if (args.window === 'settings' || (args.window == null && ref)) {
      const s = settingsWin()
      return s ? { w: s, where: 'settings' } : { error: 'the settings window is not open; open it with action "settings" first' }
    }
    const w = win()
    return w ? { w, where: 'main' } : { error: 'the sandbox window is not open' }
  }
  const inWhere = (where: 'main' | 'settings'): string => (where === 'settings' ? ' in the settings window' : '')

  type Loc = { x: number; y: number; label: string; covered?: string; dismissed?: string[] } | { error: string }
  /** 在元素中心点一下(真鼠标事件:按下 / 抬起都走,菜单、拖拽库认得出来)。 */
  const clickAt = (wc: WebContents, loc: { x: number; y: number }): void => {
    const z = wc.getZoomFactor()
    const x = Math.round(loc.x * z), y = Math.round(loc.y * z)
    wc.sendInputEvent({ type: 'mouseMove', x, y })
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  }
  /** click / type / press / scroll / space:做完等界面落定,截一张,带上这期间插件新写的 console 与弹出的提示。 */
  async function act(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const p = pick(args)
    if ('error' in p) return p
    const { w, where } = p
    if (op === 'space' && where === 'settings') return { error: 'Spaces live in the main window; leave out window (or pass "main")' }
    if (openDialog) return { error: `a native ${openDialog.kind} dialog is open in the sandbox ("${openDialog.title}") and blocks the window; ask the user to close it, and next time arm it first with action "files"` }
    const wc = w.webContents
    const target = typeof args.target === 'string' ? args.target.slice(0, 300) : ''
    const began = await call('begin()', 10_000, w)
    if (!began.ok) return { error: hookMissText(began, where) }
    let did = ''
    let label = ''
    const focus = async (): Promise<string | null> => {
      const r = await call(`locate(${JSON.stringify(target)})`, 10_000, w)
      if (!r.ok) return hookMissText(r, where)
      const loc = r.value as Loc
      if (!loc || typeof loc !== 'object') return hookMissText({ ok: false, miss: 'failed' }, where)
      if ('error' in loc) return loc.error
      // 舞台录着且要假指针:先把指针挪到要点的地方(渲染层画的,录像里看得见点了哪),再点
      if (rec?.cursor && where === 'main') await hook(`cursorTo(${Math.round(loc.x)}, ${Math.round(loc.y)})`, 3_000, w)
      clickAt(wc, loc)
      // 元素名、通知的字是插件的:只进 target(引擎圈进数据区),did 只放宿主自己的话(Codex 评审:covered 曾拼进 did,漏出围栏)
      label = loc.label
      if (loc.dismissed) {
        label += `; notification(s) dismissed first: ${loc.dismissed.join(' | ') || '(no text)'}`
        did += ' (a notification was covering it, so it was dismissed first)'
      }
      if (loc.covered) {
        label += `; another element was on top of it: ${loc.covered}`
        did += ' (something else was on top of it, see target)'
      }
      return null
    }
    if (op === 'space' || op === 'scroll') {
      const r = await call(op === 'space' ? `space(${JSON.stringify(String(args.space ?? ''))})` : `scroll(${JSON.stringify(target)}, ${Number(args.amount) || 600})`, 10_000, w)
      if (!r.ok) return { error: hookMissText(r, where) }
      const v = (r.value ?? {}) as { label?: string; did?: string; error?: string }
      if (v.error) return { error: v.error }
      did = v.did ?? op
      label = v.label ?? ''
    } else if (op === 'click') {
      if (!target) return { error: 'target is required for "click"' }
      const e = await focus()
      if (e) return { error: e }
      did = `clicked${did}`
    } else if (op === 'type') {
      const text = typeof args.text === 'string' ? args.text.slice(0, 10_000) : ''
      if (!text) return { error: 'text is required for "type"' }
      if (target) {
        const e = await focus()
        if (e) return { error: e }
        await hook('frames(1)', 500, w)
      }
      // 缺省替换框里原有的字(选中后再插入);append 才接在后面
      if (args.append !== true && !(await hook('selectFocused()', 10_000, w))) return { error: 'nothing is focused to type into; pass target (the input to type in)' }
      wc.insertText(text)
      did = `typed ${text.length} character(s)${did}`
    } else if (op === 'press') {
      const keys = String(args.key ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 20)
      const events = keys.map((k) => keyEvents(k))
      const bad = keys.find((_, i) => !events[i])
      if (!keys.length || bad) return { error: `unknown key "${bad ?? ''}"; use names like Enter, Escape, Tab, Backspace, ArrowDown, a, Meta+K, Mod+Enter` }
      if (target) { const e = await focus(); if (e) return { error: e } }
      for (const list of events) for (const ev of list!) wc.sendInputEvent(ev as unknown as Electron.KeyboardInputEvent)
      did = `pressed ${keys.join(' ')}${did}`
    }
    await hook('settle()', 10_000, w)
    const end = (await hook('end()', 10_000, w)) as { newLogs?: unknown; newNotices?: unknown } | null
    return { action: { did: `${did}${inWhere(where)}`, target: label, outline: '', newLogs: end?.newLogs ?? [], newNotices: end?.newNotices ?? [] }, image: await screenshot(undefined, false, w) }
  }

  // ── 设置窗口(11-15):设置是独立的浮动窗口,不是主窗的子窗;agent 开的那次压到普通窗口之下,和主窗一样不盖住用户正在用的 App ──
  const quiet = process.env.TANGU_HARNESS_QUIET === '1' && process.platform === 'darwin'
  const sunk = new WeakSet<BrowserWindow>()
  const sink = (w: BrowserWindow): void => {
    // 用户正在用沙箱(哪扇窗在前台)就不压:那是用户自己要看
    if (!quiet || sunk.has(w) || BrowserWindow.getFocusedWindow()) return
    w.setAlwaysOnTop(true, 'normal', -1)
    sunk.add(w)
  }
  /** 用户进了沙箱(点了某扇窗 / 卡片上的「打开沙箱窗口」):放回普通层级,不然它压在主窗底下、从齿轮再打开也看不见。 */
  const unsink = (): void => {
    for (const w of BrowserWindow.getAllWindows()) if (sunk.has(w)) { sunk.delete(w); if (!w.isDestroyed()) w.setAlwaysOnTop(false) }
  }

  /** settings:开「设置 → 插件 → 本插件」(close: true = 关掉),回设置窗口的大纲(s12 引用)和一张截图。 */
  async function settings(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const report = (did: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({ action: { did, target: '', outline: '', newLogs: [], newNotices: [], ...more } })
    if (args.close === true) {
      const s = settingsWin()
      if (!s) return report('the settings window was not open')
      s.close()
      return report('closed the settings window')
    }
    if (openDialog) return { error: `a native ${openDialog.kind} dialog is open in the sandbox ("${openDialog.title}") and blocks the window; ask the user to close it` }
    if (!opts.getSettingsWindow) return { error: 'this Forsion cannot reach the settings window from the sandbox tools' }
    const opened = await call('openSettings()')
    if (!opened.ok) return { error: hookMissText(opened) }
    const v = (opened.value ?? {}) as { error?: string }
    if (v.error) return { error: v.error }
    const s = await waitFor(() => { const x = settingsWin(); if (x) sink(x); return x }, 8_000)
    if (!s) return { error: 'the settings window did not open' }
    // 设置窗口是一份新渲染层:等钩子装上、插件在它那份插件仓里装上(详情页靠它),再等落定
    const ready = await waitFor(async () => { const r = await call('pluginReady()', 2_000, s); return r.ok && r.value === true }, 15_000)
    if (!ready) return { error: 'the settings window opened, but the plugin did not load in it in time; take a screenshot with window "settings"' }
    if (armed) await fileInputs(true) // files 备着的时候开的:这扇窗的 <input type=file> 也要拦
    await hook('settle()', 10_000, s)
    const r = await call('read("")', 10_000, s)
    const out = r.ok ? (r.value ?? {}) as { outline?: string; count?: number; error?: string } : null
    return {
      ...report(`opened Settings > Plugins > this plugin in the settings window and read ${out?.count ?? 0} element(s)`, { outline: out?.outline ?? '' }),
      image: await screenshot(undefined, false, s),
    }
  }

  // <input type="file"> 弹的选择框不走 dialog 模块:备了答案时经 CDP 拦下它,把路径直接填进那个 input(Playwright 同款做法)。
  // 只在备着的时候拦;没备就是普通的系统选择框
  // 主窗与设置窗口各拦各的(插件的设置面板里也可能有 <input type=file>)。开 / 关排成一队:设置窗口那份的初始化
  // 还在 await 时答案被主窗用掉、关闭先跑完,晚到的初始化再把拦截打开,下一个选择框就被当成取消(Codex 评审)
  let fileQueue: Promise<void> = Promise.resolve()
  const fileInputs = (on: boolean): Promise<void> => {
    fileQueue = fileQueue.then(async () => {
      for (const get of [win, settingsWin]) {
        const w = get() // 每扇窗现取:上一扇等着的时候这扇可能关了
        if (!w) continue
        try { await fileInputsOf(w.webContents, on) } catch (e) { opts.log(`[sandbox] file input interception skipped: ${e instanceof Error ? e.message : String(e)}`) }
      }
    })
    return fileQueue
  }
  const fileInputsOf = async (wc: WebContents, on: boolean): Promise<void> => {
    if (wc.isDestroyed()) return
    try {
      if (on && !wc.debugger.isAttached()) {
        wc.debugger.attach('1.3')
        wc.debugger.on('message', (_e, method, params: { backendNodeId?: number; mode?: string }) => {
          if (method !== 'Page.fileChooserOpened') return
          const a = take()
          const files = a && 'paths' in a ? (params.mode === 'selectSingle' ? a.paths.slice(0, 1) : a.paths) : []
          void wc.debugger.sendCommand('DOM.setFileInputFiles', { files, backendNodeId: params.backendNodeId })
            .catch((e) => opts.log(`[sandbox] could not fill the file input: ${e instanceof Error ? e.message : String(e)}`))
            .finally(() => void fileInputs(false))
        })
        await wc.debugger.sendCommand('Page.enable')
      }
      // 开的那一下按现状:排队等着的工夫答案可能已经被用掉了
      if (!wc.isDestroyed() && wc.debugger.isAttached()) await wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: on && armed !== null })
    } catch (e) {
      opts.log(`[sandbox] file input interception ${on ? 'on' : 'off'} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** files:备好下一个文件对话框的答案(路径只认插件目录 / 沙箱目录里的);paths 为空 = 下一个对话框当用户点了取消。 */
  async function arm(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const raw = Array.isArray(args.paths) ? args.paths.filter((x): x is string => typeof x === 'string').slice(0, 20) : []
    if (!raw.length) { armed = { cancel: true }; await fileInputs(true); void pushState(); return { action: { did: 'the next file dialog will be cancelled', target: '', outline: '', newLogs: [], newNotices: [] } } }
    const save = args.mode === 'save'
    const paths = raw.map((p) => sandboxFilePath(p, self, !save))
    const bad = raw.find((_, i) => !paths[i])
    if (bad) return { error: `"${bad.slice(0, 200)}" is not usable: paths must be inside the plugin folder (${self.dir}) or the sandbox folder${self.root ? ` (${self.root})` : ''}${save ? '' : ', and must exist'}` }
    armed = { paths: paths as string[] }
    await fileInputs(true)
    void pushState()
    return { action: { did: `the next file dialog will answer with ${paths.length} path(s)`, target: (paths as string[]).join(', '), outline: '', newLogs: [], newNotices: [] } }
  }

  // ── 演示舞台(pluginStage.ts,11-20):全分辨率截图、录像。普通沙箱没有这些动作 ──
  const stage = self.stage
  let outSeq = 0
  const outDir = (): string => join(self.root, 'out')
  /** 录着的那一段。armed = 下一次 getDisplayMedia 请求给不给;cursor = 点击前把假指针挪过去。 */
  let rec: { cursor: boolean; armed: boolean; saved?: boolean; finalizing?: boolean } | null = null
  /** 120 秒 × 16 Mbit/s ≈ 240 MB,再留些余量。 */
  const MAX_RECORDING_BYTES = 320 * 1024 * 1024
  if (stage) {
    // 录像走「录本页签」:渲染层 getDisplayMedia,这里把请求它的那个顶层 frame 交回去。不是录屏幕:不要系统的屏幕录制权限,
    // 窗口压在别的窗口底下照样出帧(11-20 探针实测 2880×1800@30)。只给 recordStart 武装过的那一次,其余一律拒
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      const w = win()
      if (rec?.armed && w && request.frame && request.frame === w.webContents.mainFrame) { rec.armed = false; callback({ video: request.frame }); return }
      try { callback({} as Electron.Streams) } catch { /* 拒绝必抛(见 main.ts 屏幕共享那段),吞掉 */ }
    })
    ipcMain.handle('pluginSandbox:saveRecording', async (e, bytes: unknown, ext: unknown) => {
      const w = win()
      // 只收正在收尾的那一段、只收一次(Codex 11-20:舞台里的插件也能调这条,不拦就能一直往盘里写)
      // 只在 recordStop 收尾时收(Codex 11-20:录着的时候先交一份就占掉了名额)、有大小上限
      if (!w || e.sender !== w.webContents || !rec || !rec.finalizing || rec.saved) return null
      const buf = bytes instanceof ArrayBuffer ? Buffer.from(new Uint8Array(bytes)) : ArrayBuffer.isView(bytes) ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null
      if (!buf || buf.length > MAX_RECORDING_BYTES) return null
      rec.saved = true
      await mkdir(outDir(), { recursive: true })
      const file = join(outDir(), `rec-${++outSeq}.${ext === 'webm' ? 'webm' : 'mp4'}`)
      await writeFile(file, buf, { flag: 'wx' }) // 独占新建:不写穿事先放在那里的软链
      return file
    })
  }

  type Rect = { x: number; y: number; width: number; height: number }
  /** capture:舞台主窗(或其中一块)按原生像素密度截 PNG,写进 <舞台>/out/,回路径与像素尺寸(父进程读出来交给插件)。 */
  async function capture(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const w = win()
    if (!w) return { error: 'the stage window is not open' }
    let rect = args.rect && typeof args.rect === 'object' ? args.rect as Rect : undefined
    if (typeof args.selector === 'string') {
      const r = await call(`rectOf(${JSON.stringify(args.selector)})`, 10_000, w)
      if (!r.ok) return { error: hookMissText(r) }
      const v = (r.value ?? {}) as Rect & { error?: string }
      if (v.error) return { error: v.error }
      rect = { x: v.x, y: v.y, width: v.width, height: v.height }
    }
    await hook('settle()', 10_000, w)
    if (w.isDestroyed()) return { error: 'the stage window closed' }
    w.webContents.invalidate()
    await hook('frames(2)', 1500, w)
    const img = await (rect ? w.webContents.capturePage(rect) : w.webContents.capturePage()).catch(() => null)
    if (!img || img.isEmpty()) return { error: 'the stage window could not be captured' }
    await mkdir(outDir(), { recursive: true })
    const file = join(outDir(), `shot-${++outSeq}.png`)
    await writeFile(file, img.toPNG(), { flag: 'wx' })
    const { width, height } = img.getSize()
    return { path: file, width, height }
  }

  async function recordStart(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const w = win()
    if (!w) return { error: 'the stage window is not open' }
    if (rec) return { error: 'the stage is already recording; stop it first' }
    rec = { cursor: args.cursor !== false, armed: true }
    const opts = { fps: Number(args.fps) || 30, maxMs: Number(args.maxMs) || 120_000, cursor: rec.cursor, format: args.format === 'webm' ? 'webm' : 'mp4' }
    const r = await call(`recordStart(${JSON.stringify(opts)})`, 15_000, w)
    const v = (r.ok ? r.value ?? {} : {}) as { mime?: string; error?: string }
    if (!r.ok || v.error) { rec = null; return { error: r.ok ? v.error! : hookMissText(r) } }
    return { mime: v.mime }
  }

  async function recordToggle(op: 'recordPause' | 'recordResume'): Promise<Record<string, unknown>> {
    const w = win()
    if (!w) return { error: 'the stage window is not open' }
    if (!rec || rec.finalizing) return { error: 'the stage is not recording' }
    const r = await call(`${op}()`, 10_000, w)
    if (!r.ok) return { error: hookMissText(r) }
    const v = (r.value ?? {}) as Record<string, unknown>
    return typeof v.error === 'string' ? { error: v.error } : {}
  }

  async function recordStop(): Promise<Record<string, unknown>> {
    const w = win()
    if (!rec) return { error: 'the stage is not recording' }
    rec.finalizing = true
    const r = await call('recordStop()', 80_000, w)
    rec = null
    if (!r.ok) return { error: hookMissText(r) }
    const v = (r.value ?? {}) as Record<string, unknown>
    return typeof v.error === 'string' ? { error: v.error } : v
  }

  // 窗口标题写明是沙箱(以前就叫 Forsion,和用户那份分不清);页面自己的 <title> 不许盖掉它
  const locale = (self.ui as { locale?: unknown } | undefined)?.locale === 'en' ? 'en' : 'zh'
  const dress = (w: BrowserWindow): void => {
    w.webContents.setBackgroundThrottling(false)
    w.on('page-title-updated', (e) => e.preventDefault())
    w.setTitle(mtFor(locale, 'main.pluginSandbox.windowTitle', { name: self.name }))
  }
  for (const w of BrowserWindow.getAllWindows()) dress(w)
  app.on('browser-window-created', (_e, w) => dress(w))

  const send = (msg: Record<string, unknown>): void => { try { if (authed) sock?.write(JSON.stringify(msg) + '\n'); else queued.push(msg) } catch { /* 通道断了:父进程会当子进程没了 */ } }
  forward = (kind, value) => send({ event: 'forward', kind, value })
  const pushState = async (): Promise<void> => send({ event: 'state', status: await status() })
  /** 重载插件:主窗整套(reload:重扫 Space、落脚);设置窗口开着就让它那份插件实例也换成新代码(每扇窗各有一份)。 */
  const reloadAll = async (): Promise<void> => {
    await hook('reload()', 30_000)
    const s = settingsWin()
    if (s) await hook('reloadPlugin()', 30_000, s)
  }

  // ── 安装到用户那份 Forsion(11-28 方案 A):确认框挂在沙箱窗口上;装没装 / 装的结果给顶条 ──
  /** 父进程最近一次说的「用户那份装没装这一份」(SandboxInstalled);渲染层起来时先要一次,之后跟着推。 */
  let hostInstalled: unknown = null
  let yielded: (() => void) | null = null
  const toRenderer = (channel: string, payload: unknown): void => {
    for (const w of [win(), settingsWin()]) if (w && !w.webContents.isDestroyed()) w.webContents.send(channel, payload)
  }
  const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
  /** 父进程给的确认框(文案它按用户那份的语言写好):系统框挂在沙箱主窗上,插件的网页代码点不到。弹着的时候钉住的浮窗先让开。 */
  async function confirmInstall(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const w = win()
    if (!w) return { error: 'the sandbox window is closed' }
    const buttons = Array.isArray(args.buttons) ? args.buttons.slice(0, 2).map((b) => text(b, 40)) : []
    if (buttons.length !== 2 || buttons.some((b) => !b)) return { error: 'bad dialog' }
    unsink()
    if (w.isMinimized()) w.restore()
    w.show(); w.focus()
    // 台架(check:pluginsandbox)替用户点:只认开发构建,打包版里这个环境变量不起作用
    const auto = !app.isPackaged ? process.env.FORSION_HARNESS_SANDBOX_CONFIRM : undefined
    if (auto === '0' || auto === '1') return { response: Number(auto) }
    const restore = opts.yieldPinned?.() ?? null
    try {
      // 走包过的 dialog.showMessageBox:弹着的时候状态里 dialog 有值,agent 的动作一律先拒(它会挡住窗口)
      const r = await dialog.showMessageBox(w, {
        type: 'question', title: text(args.title, 200), message: text(args.message, 600), detail: text(args.detail, 2000),
        buttons, defaultId: 0, cancelId: 1, noLink: true,
      })
      return { response: r.response }
    } finally { restore?.() }
  }

  async function handle(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const args = (msg.args && typeof msg.args === 'object' ? msg.args : {}) as Record<string, unknown>
    switch (msg.op) {
      case 'confirmInstall': return stage ? { error: 'unknown op' } : confirmInstall(args)
      case 'yieldPinned': {
        // 用户那份的主窗上弹确认框期间(卡片上点的安装):这边钉住的浮窗先让开,不然盖在它上面
        if (args.on === true && !yielded) yielded = opts.yieldPinned?.() ?? null
        else if (args.on !== true && yielded) { yielded(); yielded = null }
        return {}
      }
      case 'installed': hostInstalled = args.installed ?? null; toRenderer('pluginSandbox:installed', hostInstalled); return {}
      case 'installResult': toRenderer('pluginSandbox:installResult', args); return {}
      case 'status': return { status: await status() }
      case 'screenshot': {
        const p = pick(args)
        if ('error' in p) return { image: null, error: p.error }
        return { image: await screenshot(p.where === 'main' && typeof args.view === 'string' ? args.view : undefined, args.settle === true, p.w) }
      }
      case 'command': {
        // allowPending(新引擎才带):渲染层 1.5s 内没跑完就回 pending(多半在等自己弹的框),这里的 10s 只兜「页面卡死」;
        // 老引擎照旧等它跑完,等不完时说清楚是命令没跑完,不说成窗口还在启动
        const r = await call(`command(${JSON.stringify(String(args.command ?? ''))}, ${JSON.stringify(args.args ?? {})}, ${args.allowPending === true})`)
        if (!r.ok && r.miss === 'timeout') return { error: `the command did not finish within ${Math.round((r.ms ?? 10_000) / 1000)}s: it may be waiting on a dialog or picker it opened (read or screenshot the window), or its page is stuck` }
        if (!r.ok) return { error: hookMissText(r) }
        return (r.value && typeof r.value === 'object' ? r.value : { error: hookMissText({ ok: false, miss: 'failed' }) }) as Record<string, unknown>
      }
      case 'read': {
        const p = pick(args)
        if ('error' in p) return p
        const r = await call(`read(${JSON.stringify(typeof args.target === 'string' ? args.target.slice(0, 300) : '')})`, 10_000, p.w)
        if (!r.ok) return { error: hookMissText(r, p.where) }
        const v = (r.value ?? {}) as { outline?: string; count?: number; error?: string }
        if (v.error) return { error: v.error }
        return { action: { did: `read ${v.count ?? 0} element(s)${inWhere(p.where)}`, target: '', outline: v.outline ?? '', newLogs: [], newNotices: [] } }
      }
      case 'click': case 'type': case 'press': case 'scroll': case 'space': return act(String(msg.op), args)
      case 'files': return arm(args)
      case 'settings': return settings(args)
      case 'capture': return stage ? capture(args) : { error: 'unknown op' }
      case 'recordStart': return stage ? recordStart(args) : { error: 'unknown op' }
      case 'recordStop': return stage ? recordStop() : { error: 'unknown op' }
      case 'recordPause': case 'recordResume': return stage ? recordToggle(msg.op) : { error: 'unknown op' }
      case 'reload': await reloadAll(); return {}
      case 'show': {
        unsink()
        const w = win()
        if (w) {
          if (process.platform === 'win32') {
            // The foreground parent hands focus to this window after verifying the HWND belongs to us.
            if (!w.isVisible() && !w.isMinimized()) w.showInactive()
            const handle = w.getNativeWindowHandle()
            return { hwnd: handle.length === 8 ? Number(handle.readBigUInt64LE()) : handle.readUInt32LE() }
          }
          if (w.isMinimized()) w.restore()
          // Also restores the normal level for the macOS quiet harness (main.ts sinkForHarness).
          w.setAlwaysOnTop(true); w.show(); w.focus(); w.setAlwaysOnTop(false)
          if (process.platform === 'darwin') app.focus({ steal: true })
        }
        return {}
      }
      case 'quit': setImmediate(opts.quit); return {}
      default: return { error: 'unknown op' }
    }
  }

  sock = connect(process.env.FORSION_SANDBOX_SOCK!)
  sock.setEncoding('utf8')
  sock.on('connect', () => {
    sock!.write(JSON.stringify({ hello: process.env.FORSION_SANDBOX_TOKEN }) + '\n')
    authed = true
    for (const m of queued.splice(0)) send(m)
  })
  let buf = ''
  sock.on('data', (chunk: string) => {
    buf += chunk
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let msg: Record<string, unknown>
      try { msg = JSON.parse(line) } catch { continue }
      void handle(msg).then((r) => { if (typeof msg.id === 'number' && msg.id > 0) send({ id: msg.id, ...r }) }, (e) => send({ id: msg.id, error: String(e?.message || e) }))
    }
  })
  // 父进程没了(退出 / 崩了)→ 沙箱跟着走,不留孤儿窗口
  // 退出守卫(插件说还没做完)会拦下这次 quit:父进程已经没了,没人能点「仍要退出」,过一会儿硬退
  sock.on('close', () => { opts.log('[sandbox] control channel closed, quitting'); opts.quit(); setTimeout(() => app.exit(0), 3_000).unref() })
  sock.on('error', (e) => opts.log(`[sandbox] control channel error: ${e.message}`))

  // 保存即重载
  let watcher: FSWatcher | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null
  // 舞台不监视:它的 dir 是舞台根目录,截图 / 录像就写在下面,一写就重载
  if (!stage) try {
    watcher = watch(self.dir, { recursive: true }, (_ev, file) => {
      if (file && IGNORE.test(String(file))) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => { void reloadAll().then(() => setTimeout(() => void pushState(), 600)) }, 400)
    })
  } catch (e) {
    opts.log(`[sandbox] cannot watch ${self.dir}: ${e instanceof Error ? e.message : String(e)}`)
  }
  app.on('will-quit', () => { watcher?.close(); sock?.destroy() })

  // 沙箱条上的按钮:报告问题 / 安装到我的 Forsion / 重置 —— 只转给父进程,决定在那边做
  ipcMain.handle('pluginSandbox:childAction', (_e, action: unknown, note: unknown) => {
    if (action === 'report') send({ event: 'report', note: typeof note === 'string' ? note.slice(0, 2000) : '' })
    // 回执卡上的「重新安装」= install + force(装的就是这一份时父进程不再悄悄覆盖)
    else if (action === 'install') send({ event: 'install', ...(note === 'force' ? { force: true } : {}) })
    // openHost 带 note 'settings' = 直接开它的设置页(另装着一份、要先卸载的那种)
    else if (action === 'openHost') send({ event: 'openHost', ...(note === 'settings' ? { settings: true } : {}) })
    else if (action === 'reset' || action === 'close') send({ event: action })
    else return false
    return true
  })
  ipcMain.handle('pluginSandbox:installedNow', () => hostInstalled)
  // 渲染层装载落定 / 重载完会报一次,父进程那边的卡片跟着变;用户切进 / 切出沙箱窗口也报(父进程据此算闲置)
  ipcMain.on('pluginSandbox:changed', () => { void pushState() })
  app.on('browser-window-focus', () => { unsink(); void pushState() })
  app.on('browser-window-blur', () => { void pushState() })
}
