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
import { app, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { connect, type Socket } from 'node:net'
import { watch, lstatSync, realpathSync, type FSWatcher } from 'node:fs'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
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

export function startSandboxChild(self: SandboxSelf, opts: { getWindow(): BrowserWindow | null; quit(): void; log(m: string): void }): void {
  const win = (): BrowserWindow | null => {
    const w = opts.getWindow()
    return w && !w.isDestroyed() ? w : null
  }
  /** 调渲染层的沙箱钩子;钩子还没装上(渲染层在启动)= null。插件把渲染层卡死时等不回来:超时也回 null。 */
  const hook = async (call: string, ms = 10_000): Promise<unknown> => {
    const w = win()
    if (!w) return null
    return withTimeout(w.webContents.executeJavaScript(`(window.__forsionSandbox ? window.__forsionSandbox.${call} : null)`, true).catch(() => null), ms, null)
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
  const take = (): { paths: string[] } | { cancel: true } | null => { const a = armed; armed = null; if (a) { void pushState(); void fileInputs(false) } return a }
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
    // 「用户正在用沙箱窗口」= 它在前台。静默模式下窗口压在普通窗口之下,isVisible 恒真,拿它判闲置就永远不停
    return { ...(st as object), windowVisible: !!w && w.isFocused(), ...host }
  }
  const screenshot = async (view?: string, settleFirst = false): Promise<string | null> => {
    if (view) await hook(`openView(${JSON.stringify(view)})`)
    if (view || settleFirst) await hook('settle()')
    const w = win()
    if (!w) return null
    // 先要一帧新的再截:不然截到的可能是上一次画好的那一帧(窗口在后台时尤其)
    w.webContents.invalidate()
    await hook('frames(2)', 1500)
    const img = await w.webContents.capturePage().catch(() => null)
    if (!img || img.isEmpty()) return null
    const { width } = img.getSize()
    const out = width > SHOT_WIDTH ? img.resize({ width: SHOT_WIDTH, quality: 'good' }) : img
    return `data:image/jpeg;base64,${out.toJPEG(80).toString('base64')}`
  }

  type Loc = { x: number; y: number; label: string; covered?: string } | { error: string }
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
    const w = win()
    if (!w) return { error: 'the sandbox window is not open' }
    if (openDialog) return { error: `a native ${openDialog.kind} dialog is open in the sandbox ("${openDialog.title}") and blocks the window; ask the user to close it, and next time arm it first with action "files"` }
    const wc = w.webContents
    const target = typeof args.target === 'string' ? args.target.slice(0, 300) : ''
    if (!(await hook('begin()'))) return { error: STARTING }
    let did = ''
    let label = ''
    const focus = async (): Promise<string | null> => {
      const loc = await hook(`locate(${JSON.stringify(target)})`) as Loc | null
      if (!loc) return STARTING
      if ('error' in loc) return loc.error
      clickAt(wc, loc)
      // 元素名是插件的字:只进 target(引擎圈进数据区),did 只放宿主自己的话(Codex 评审:covered 曾拼进 did,漏出围栏)
      label = loc.covered ? `${loc.label}; another element was on top of it: ${loc.covered}` : loc.label
      if (loc.covered) did += ' (something else was on top of it, see target)'
      return null
    }
    if (op === 'space' || op === 'scroll') {
      const r = await hook(op === 'space' ? `space(${JSON.stringify(String(args.space ?? ''))})` : `scroll(${JSON.stringify(target)}, ${Number(args.amount) || 600})`) as { label?: string; did?: string; error?: string } | null
      if (!r) return { error: STARTING }
      if (r.error) return { error: r.error }
      did = r.did ?? op
      label = r.label ?? ''
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
        await hook('frames(1)', 500)
      }
      // 缺省替换框里原有的字(选中后再插入);append 才接在后面
      if (args.append !== true && !(await hook('selectFocused()'))) return { error: 'nothing is focused to type into; pass target (the input to type in)' }
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
    await hook('settle()')
    const end = (await hook('end()')) as { newLogs?: unknown; newNotices?: unknown } | null
    return { action: { did, target: label, outline: '', newLogs: end?.newLogs ?? [], newNotices: end?.newNotices ?? [] }, image: await screenshot() }
  }

  // <input type="file"> 弹的选择框不走 dialog 模块:备了答案时经 CDP 拦下它,把路径直接填进那个 input(Playwright 同款做法)。
  // 只在备着的时候拦;没备就是普通的系统选择框
  const fileInputs = async (on: boolean): Promise<void> => {
    const wc = win()?.webContents
    if (!wc) return
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
      if (wc.debugger.isAttached()) await wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: on })
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

  async function handle(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const args = (msg.args && typeof msg.args === 'object' ? msg.args : {}) as Record<string, unknown>
    switch (msg.op) {
      case 'status': return { status: await status() }
      case 'screenshot': return { image: await screenshot(typeof args.view === 'string' ? args.view : undefined, args.settle === true) }
      case 'command': {
        const r = await hook(`command(${JSON.stringify(String(args.command ?? ''))}, ${JSON.stringify(args.args ?? {})})`) as { error?: string } | null
        return r ?? { error: 'the sandbox window is still starting' }
      }
      case 'read': {
        const r = await hook(`read(${JSON.stringify(typeof args.target === 'string' ? args.target.slice(0, 300) : '')})`) as { outline?: string; count?: number; error?: string } | null
        if (!r) return { error: STARTING }
        if (r.error) return { error: r.error }
        return { action: { did: `read ${r.count ?? 0} element(s)`, target: '', outline: r.outline ?? '', newLogs: [], newNotices: [] } }
      }
      case 'click': case 'type': case 'press': case 'scroll': case 'space': return act(String(msg.op), args)
      case 'files': return arm(args)
      case 'reload': await hook('reload()', 30_000); return {}
      case 'show': {
        const w = win()
        // 沙箱是后台进程,叫不动前台:Windows 有前台锁(只有前台进程能 SetForegroundWindow,别人调 focus 只闪任务栏),
        // macOS 是协作式激活。临时置顶再放下只改 z 序、不要前台权,窗口一定排到最前,也顺带把静默模式压到 -1 层
        // (main.ts sinkForHarness)的窗口抬回普通层;能不能顺带拿到键盘焦点看系统
        if (w) {
          if (w.isMinimized()) w.restore()
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
  try {
    watcher = watch(self.dir, { recursive: true }, (_ev, file) => {
      if (file && IGNORE.test(String(file))) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => { void hook('reload()').then(() => setTimeout(() => void pushState(), 600)) }, 400)
    })
  } catch (e) {
    opts.log(`[sandbox] cannot watch ${self.dir}: ${e instanceof Error ? e.message : String(e)}`)
  }
  app.on('will-quit', () => { watcher?.close(); sock?.destroy() })

  // 沙箱条上的按钮:报告问题 / 安装到我的 Forsion / 重置 —— 只转给父进程,决定在那边做
  ipcMain.handle('pluginSandbox:childAction', (_e, action: unknown, note: unknown) => {
    if (action === 'report') send({ event: 'report', note: typeof note === 'string' ? note.slice(0, 2000) : '' })
    else if (action === 'install' || action === 'reset') send({ event: action })
    else return false
    return true
  })
  // 渲染层装载落定 / 重载完会报一次,父进程那边的卡片跟着变;用户切进 / 切出沙箱窗口也报(父进程据此算闲置)
  ipcMain.on('pluginSandbox:changed', () => { void pushState() })
  app.on('browser-window-focus', () => { void pushState() })
  app.on('browser-window-blur', () => { void pushState() })
}
