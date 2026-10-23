/**
 * 插件沙箱 · 子进程这侧(沙箱那份 Forsion 的主进程)。父进程那侧见 pluginSandbox.ts,契约 tangu-agent/docs/plugin-sandbox.md。
 *
 * 只在 FORSION_SANDBOX=1 时启用(父进程 spawn 时带上,同时带插件目录、控制通道地址和一次性令牌):
 *  · 连回父进程的 socket,先报令牌,之后按行收请求:status / screenshot / command / reload / show / quit;
 *  · 状态与命令交给渲染层的 `window.__forsionSandbox`(frontend/src/sandbox/sandboxWindow.ts),主进程只负责截图和窗口;
 *  · 监视插件文件夹,保存即重载(Coding Studio 的「保存即重载」靠项目开着,沙箱里没有 Coding Studio);
 *  · 渲染层沙箱条上的按钮(报告问题 / 安装 / 重置)经 IPC 到这里,再作为事件转给父进程。
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { connect, type Socket } from 'node:net'
import { watch, type FSWatcher } from 'node:fs'

export interface SandboxSelf {
  pluginId: string
  name: string
  version: string
  dir: string
  /** 父进程带来的语言与主题(PluginSandboxUiSeed),渲染层首屏写进 localStorage。 */
  ui?: unknown
}

/** 本进程是不是沙箱。只认父进程给的三件:标志、通道、令牌。 */
export function sandboxSelf(env: NodeJS.ProcessEnv = process.env): SandboxSelf | null {
  if (env.FORSION_SANDBOX !== '1' || !env.FORSION_SANDBOX_SOCK || !env.FORSION_SANDBOX_TOKEN || !env.FORSION_SANDBOX_PLUGIN) return null
  try {
    const info = JSON.parse(env.FORSION_SANDBOX_INFO || '{}') as Partial<SandboxSelf>
    if (typeof info.pluginId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(info.pluginId)) return null
    return { pluginId: info.pluginId, name: String(info.name || info.pluginId), version: String(info.version || ''), dir: env.FORSION_SANDBOX_PLUGIN, ui: info.ui }
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
/** 改过的文件不算数的:依赖、版本库、编辑器的临时文件。 */
const IGNORE = /(^|[\\/])(node_modules|\.git|\.forsion)([\\/]|$)|(~|\.swp|\.tmp)$/

export function startSandboxChild(self: SandboxSelf, opts: { getWindow(): BrowserWindow | null; quit(): void; log(m: string): void }): void {
  const win = (): BrowserWindow | null => {
    const w = opts.getWindow()
    return w && !w.isDestroyed() ? w : null
  }
  /** 调渲染层的沙箱钩子;钩子还没装上(渲染层在启动)= null。 */
  const hook = async (call: string): Promise<unknown> => {
    const w = win()
    if (!w) return null
    return w.webContents.executeJavaScript(`(window.__forsionSandbox ? window.__forsionSandbox.${call} : null)`, true).catch(() => null)
  }
  const status = async (): Promise<unknown> => {
    const st = await hook('status()')
    const w = win()
    if (!st || typeof st !== 'object') {
      return { v: 1, state: 'starting', pluginId: self.pluginId, name: self.name, version: self.version, dir: self.dir, views: [], spaces: [], hiddenSpaces: [], setupError: null, blocked: null, mountErrors: [], logs: [], warnCount: 0, errorCount: 0, loads: 0, windowVisible: false }
    }
    return { ...(st as object), windowVisible: !!w && w.isVisible() && !w.isMinimized() }
  }
  const screenshot = async (view?: string): Promise<string | null> => {
    if (view) { await hook(`openView(${JSON.stringify(view)})`); await new Promise((r) => setTimeout(r, 700)) }
    const w = win()
    if (!w) return null
    const img = await w.webContents.capturePage().catch(() => null)
    if (!img || img.isEmpty()) return null
    const { width } = img.getSize()
    const out = width > SHOT_WIDTH ? img.resize({ width: SHOT_WIDTH, quality: 'good' }) : img
    return `data:image/jpeg;base64,${out.toJPEG(80).toString('base64')}`
  }

  const send = (msg: Record<string, unknown>): void => { try { if (authed) sock?.write(JSON.stringify(msg) + '\n'); else queued.push(msg) } catch { /* 通道断了:父进程会当子进程没了 */ } }
  forward = (kind, value) => send({ event: 'forward', kind, value })
  const pushState = async (): Promise<void> => send({ event: 'state', status: await status() })

  async function handle(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const args = (msg.args && typeof msg.args === 'object' ? msg.args : {}) as Record<string, unknown>
    switch (msg.op) {
      case 'status': return { status: await status() }
      case 'screenshot': return { image: await screenshot(typeof args.view === 'string' ? args.view : undefined) }
      case 'command': {
        const r = await hook(`command(${JSON.stringify(String(args.command ?? ''))}, ${JSON.stringify(args.args ?? {})})`) as { error?: string } | null
        return r ?? { error: 'the sandbox window is still starting' }
      }
      case 'reload': await hook('reload()'); return {}
      case 'show': {
        const w = win()
        if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); if (process.platform === 'darwin') app.focus({ steal: true }) }
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
  sock.on('close', () => { opts.log('[sandbox] control channel closed, quitting'); opts.quit() })
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
  // 渲染层装载落定 / 重载完会报一次,父进程那边的卡片跟着变
  ipcMain.on('pluginSandbox:changed', () => { void pushState() })
}
