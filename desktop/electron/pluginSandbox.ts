/**
 * 插件沙箱 · 父进程这侧(用户正在用的那份 Forsion)。契约 tangu-agent/docs/plugin-sandbox.md。
 *
 * 沙箱 = 按需另起的一份 Forsion 进程,只装一个插件的开发副本。隔离靠**目录**,不靠逐条改 IPC:
 *   <forsionHome>/sandbox/<插件 id>/{userdata, home, workspace, vault}
 *   ↳ --user-data-dir(单实例锁按它走,所以能与用户的 Forsion 并存)、TANGU_HOME、FORSION_WORKSPACE_DIR、智库配置都指进去。
 * 子进程不登录(home 里没有 auth.json)、引擎地址指向死端口、不连电脑操作助手;精简启动的开关在子进程那侧(sandboxChild.ts)。
 *
 * 控制通道:父进程开一个本机 socket(unix socket / Windows 命名管道),子进程启动后带一次性令牌连上来,
 * 之后按行收发 JSON —— 父 → 子是请求(status / screenshot / command / reload / show / quit),子 → 父是事件(用户在沙箱窗口里点的
 * 报告问题 / 安装 / 重置)。不开远程调试端口:那个端口本机任何进程都能连。
 *
 * ⚠️ 本模块不 import electron(单测直跑);窗口、对话框、IPC 都在 main.ts 接线。
 * ⚠️ 同一时刻只有一个沙箱:起另一个插件先停前一个。
 */
import { randomBytes } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, normalize, sep } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { effectivePluginId } from '../shared/products'
import { parseSandboxStatus, type SandboxStatus } from '../../tangu-agent/src/contracts/pluginSandbox'
import { defineMainMessages } from './mainI18n'

/** 「安装到我的 Forsion」确认框(main.ts 弹)。 */
export const PLUGIN_SANDBOX_MESSAGES = defineMainMessages({
  'main.pluginSandbox.installTitle': { zh: '安装插件', en: 'Install plugin' },
  'main.pluginSandbox.installMessage': { zh: '把「{name}」{version} 安装到你的 Forsion？', en: 'Install "{name}" {version} in your Forsion?' },
  'main.pluginSandbox.installDetail': {
    zh: '会从 {dir} 复制一份到你的插件文件夹。装好后它拿到 manifest.json 里声明的权限，能访问你的智库。',
    en: 'A copy of {dir} goes into your plugins folder. Once installed it gets the permissions declared in its manifest.json and can access your vault.',
  },
  'main.pluginSandbox.install': { zh: '安装', en: 'Install' },
  'main.pluginSandbox.cancel': { zh: '取消', en: 'Cancel' },
})

/** 带给沙箱首屏的界面状态:语言 + 父进程渲染层的主题那几把 localStorage 键(子进程只收 forsion_theme* / forsion_glass*)。 */
export interface PluginSandboxUiSeed { locale: 'zh' | 'en'; storage: Record<string, string> }

export interface SandboxManifest { pluginId: string; name: string; version: string }

/** 给模型 / 卡片的失败:code 走 clientAck 的结果码字符集。 */
export interface SandboxResult { ok: boolean; code?: string; error?: string; text?: string; image?: string }

export class SandboxError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/** 读插件项目的清单(只认 manifest.json;id 规则与宿主装载同一条)。 */
export async function readSandboxManifest(dir: string): Promise<SandboxManifest> {
  if (!isAbsolute(dir)) throw new SandboxError('invalid_args', 'the plugin folder must be an absolute path')
  const st = await stat(dir).catch(() => null)
  if (!st?.isDirectory()) throw new SandboxError('invalid_args', `no such folder: ${dir}`)
  let m: Record<string, unknown>
  try {
    m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  } catch (e) {
    throw new SandboxError('invalid_args', `${dir} has no readable manifest.json (${e instanceof Error ? e.message : String(e)}), so it is not a Forsion plugin`)
  }
  const pluginId = effectivePluginId(dir.split(sep).filter(Boolean).pop() || '', m?.id)
  if (!pluginId || pluginId.startsWith('market-')) throw new SandboxError('invalid_args', 'manifest.json needs an "id" in kebab-case (a-z, 0-9, -)')
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  return { pluginId, name: str(m.name, 120) || pluginId, version: str(m.version, 40) }
}

export function sandboxPaths(forsionHome: string, pluginId: string) {
  const root = join(forsionHome, 'sandbox', pluginId)
  return { root, userData: join(root, 'userdata'), home: join(root, 'home'), workspace: join(root, 'workspace'), vault: join(root, 'vault') }
}

/** 控制通道地址。macOS 的 unix socket 路径上限 104 字节:放 tmpdir,别放在可能很深的数据目录里。 */
export function sandboxSockPath(platform: NodeJS.Platform, pid: number, rand: string): string {
  return platform === 'win32' ? `\\\\.\\pipe\\forsion-sbx-${pid}-${rand}` : join(tmpdir(), `forsion-sbx-${pid}-${rand}.sock`)
}

/** 子进程的环境:父进程自己的 TANGU_HOME(dev 会被 bindDevTanguHome 设上)等一律换成沙箱的。 */
export function sandboxEnv(base: NodeJS.ProcessEnv, p: ReturnType<typeof sandboxPaths>, extra: { dir: string; sock: string; token: string; info: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) if (!/^(TANGU_HOME|FORSION_WORKSPACE_DIR|FORSION_SANDBOX.*|PI_CU_SOCKET_PATH|TANGU_BACKEND_URL)$/.test(k)) env[k] = v
  return {
    ...env,
    FORSION_SANDBOX: '1',
    FORSION_SANDBOX_PLUGIN: extra.dir,
    FORSION_SANDBOX_SOCK: extra.sock,
    FORSION_SANDBOX_TOKEN: extra.token,
    FORSION_SANDBOX_INFO: extra.info,
    TANGU_HOME: p.home,
    FORSION_WORKSPACE_DIR: p.workspace,
    // 引擎指向死端口:沙箱不起、不连任何引擎(界面照常,Tangu 那几页显示连不上)
    TANGU_BACKEND_URL: 'http://127.0.0.1:1',
    // 电脑操作助手的 socket 指到不存在的地方:沙箱绝不连上用户那份助手
    PI_CU_SOCKET_PATH: join(p.root, 'no-computer-use.sock'),
    // 子进程的窗口一律 showInactive:不抢用户前台(用户从卡片 / Coding Studio 点「打开沙箱窗口」才叫到前面)
    TANGU_HARNESS_QUIET: '1',
  }
}

/** 删沙箱目录前的最后一道:只删 <forsionHome>/sandbox/<合法 id>。 */
export function isSandboxRoot(forsionHome: string, p: string): boolean {
  const base = normalize(join(forsionHome, 'sandbox')) + sep
  const n = normalize(p)
  return n.startsWith(base) && /^[a-z0-9][a-z0-9-]{0,63}$/.test(n.slice(base.length))
}

/** 「安装到我的 Forsion」不拷的东西。 */
export const INSTALL_SKIP = /(^|[\\/])(node_modules|\.git|\.forsion|\.DS_Store)([\\/]|$)/

export interface SandboxDeps {
  forsionHome(): string
  spawn(args: string[], env: NodeJS.ProcessEnv): ChildProcess
  /** dev = [app 路径];打包态 = []。 */
  appArgs: string[]
  platform: NodeJS.Platform
  pid: number
  ui(): PluginSandboxUiSeed
  onChange(state: SandboxPublicState): void
  /** 用户在沙箱窗口里点的:报告问题 / 安装 / 重置;系统投错给沙箱的链接 / 文件(forward)。 */
  onChildEvent(ev: SandboxChildEvent): void
  log(msg: string): void
  /** 闲置多久自动停(缺省 15 分钟;测试注入)。 */
  idleMs?: number
}

export interface SandboxPublicState {
  running: boolean
  pluginId?: string
  name?: string
  version?: string
  dir?: string
  /** 发起这个沙箱的对话(报告问题往那里发)。 */
  sessionId?: string
  status?: SandboxStatus | null
}

export type SandboxChildEvent =
  | { event: 'report'; note: string; sessionId?: string; pluginId: string; name: string }
  | { event: 'install'; pluginId: string }
  | { event: 'reset'; pluginId: string }
  | { event: 'forward'; kind: 'url' | 'file'; value: string }

interface Child {
  proc: ChildProcess
  server: Server
  sockPath: string
  sock: Socket | null
  manifest: SandboxManifest
  dir: string
  paths: ReturnType<typeof sandboxPaths>
  sessionId?: string
  pending: Map<number, (msg: Record<string, unknown>) => void>
  seq: number
  exited: boolean
  lastUsed: number
  status: SandboxStatus | null
}

const HELLO_MS = 45_000
const SETTLE_MS = 30_000
const REQ_MS = 15_000

export function createPluginSandbox(deps: SandboxDeps) {
  let child: Child | null = null
  let starting: Promise<SandboxResult> | null = null
  const idleMs = deps.idleMs ?? 15 * 60_000

  const publicState = (): SandboxPublicState => child && !child.exited
    ? { running: true, pluginId: child.manifest.pluginId, name: child.manifest.name, version: child.manifest.version, dir: child.dir, sessionId: child.sessionId, status: child.status }
    : { running: false }
  const changed = (): void => { try { deps.onChange(publicState()) } catch { /* 监听方的错不连累沙箱 */ } }

  function request(c: Child, op: string, args: Record<string, unknown> = {}, timeoutMs = REQ_MS): Promise<Record<string, unknown>> {
    if (!c.sock || c.exited) return Promise.reject(new SandboxError('no_sandbox', 'the sandbox window is not running'))
    const id = ++c.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { c.pending.delete(id); reject(new SandboxError('error', `the sandbox did not answer "${op}" in time`)) }, timeoutMs)
      c.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
      c.sock!.write(JSON.stringify({ id, op, args }) + '\n')
    })
  }

  async function readStatus(c: Child): Promise<SandboxStatus | null> {
    const r = await request(c, 'status')
    const st = parseSandboxStatus(r.status)
    if (st) { c.status = st; changed() }
    return st
  }

  /** 等插件装载落定(不是 starting)。超时就按当时的样子报,不当失败。 */
  async function settle(c: Child): Promise<SandboxStatus | null> {
    const end = Date.now() + SETTLE_MS
    let st: SandboxStatus | null = null
    while (Date.now() < end && !c.exited) {
      st = await readStatus(c).catch(() => null)
      if (st && st.state !== 'starting') return st
      await new Promise((r) => setTimeout(r, 400))
    }
    return st
  }

  async function shoot(c: Child, view?: string): Promise<string | undefined> {
    const r = await request(c, 'screenshot', view ? { view } : {}, 20_000).catch(() => null)
    return typeof r?.image === 'string' ? r.image : undefined
  }

  const ok = (st: SandboxStatus | null, image?: string, error?: string): SandboxResult =>
    st ? { ok: true, text: JSON.stringify(st), ...(image ? { image } : {}), ...(error ? { error } : {}) } : { ok: false, code: 'error', error: 'the sandbox did not report its status' }

  function onLine(c: Child, line: string): void {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(line) } catch { return }
    if (typeof msg.id === 'number') { c.pending.get(msg.id)?.(msg); c.pending.delete(msg.id); return }
    const ev = msg.event
    if (ev === 'state') { const st = parseSandboxStatus(msg.status); if (st) { c.status = st; changed() } return }
    if (ev === 'report') {
      deps.onChildEvent({ event: 'report', note: typeof msg.note === 'string' ? msg.note.slice(0, 2000) : '', sessionId: c.sessionId, pluginId: c.manifest.pluginId, name: c.manifest.name })
      return
    }
    if (ev === 'install' || ev === 'reset') deps.onChildEvent({ event: ev, pluginId: c.manifest.pluginId })
    if (ev === 'forward' && (msg.kind === 'url' || msg.kind === 'file') && typeof msg.value === 'string') deps.onChildEvent({ event: 'forward', kind: msg.kind, value: msg.value.slice(0, 4096) })
  }

  async function spawnChild(dir: string, manifest: SandboxManifest, sessionId?: string): Promise<Child> {
    const home = deps.forsionHome()
    const paths = sandboxPaths(home, manifest.pluginId)
    for (const d of [paths.userData, `${paths.userData}-dev`, paths.home, paths.workspace, paths.vault]) await mkdir(d, { recursive: true })
    // 两份 userData 都写:dev 态的 Electron 会给 --user-data-dir 再挂一个 -dev(main.ts)
    for (const d of [paths.userData, `${paths.userData}-dev`]) {
      await writeFile(join(d, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: 'http://127.0.0.1:1', token: 'sandbox' }))
      for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) await writeFile(join(d, f), JSON.stringify({ localVault: paths.vault, lastVault: paths.vault }))
    }
    const token = randomBytes(24).toString('base64url')
    const sockPath = sandboxSockPath(deps.platform, deps.pid, randomBytes(6).toString('hex'))
    if (deps.platform !== 'win32') await rm(sockPath, { force: true })
    const server = createServer()
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(sockPath, () => { server.off('error', reject); resolve() }) })
    const ui = deps.ui()
    const info = JSON.stringify({ pluginId: manifest.pluginId, name: manifest.name, version: manifest.version, dir, ui })
    const args = [...deps.appArgs, `--user-data-dir=${paths.userData}`, `--lang=${ui.locale === 'en' ? 'en' : 'zh-CN'}`, ...(deps.platform === 'darwin' ? ['-ApplePersistenceIgnoreState', 'YES'] : [])]
    const proc = deps.spawn(args, sandboxEnv(process.env, paths, { dir, sock: sockPath, token, info }))
    const c: Child = { proc, server, sockPath, sock: null, manifest, dir, paths, sessionId, pending: new Map(), seq: 0, exited: false, lastUsed: Date.now(), status: null }
    const hello = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new SandboxError('error', 'the sandbox window did not start in time')), HELLO_MS)
      server.on('connection', (sock) => {
        if (c.sock) { sock.destroy(); return } // 只收一个:令牌只给了这一个子进程
        let buf = ''
        let authed = false
        sock.setEncoding('utf8')
        sock.on('data', (chunk: string) => {
          buf += chunk
          if (buf.length > 16 * 1024 * 1024) { sock.destroy(); return }
          let i: number
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i)
            buf = buf.slice(i + 1)
            if (!authed) {
              let m: Record<string, unknown> | null = null
              try { m = JSON.parse(line) } catch { /* 不是 JSON */ }
              if (!m || m.hello !== token) { sock.destroy(); return }
              authed = true
              c.sock = sock
              clearTimeout(timer)
              resolve()
              continue
            }
            onLine(c, line)
          }
        })
        sock.on('close', () => { if (c.sock === sock) c.sock = null })
        sock.on('error', () => {})
      })
      proc.once('exit', () => { clearTimeout(timer); reject(new SandboxError('error', 'the sandbox window exited while starting')) })
    })
    proc.once('exit', (code) => {
      c.exited = true
      for (const fn of c.pending.values()) fn({ ok: false, error: 'exited' })
      c.pending.clear()
      server.close()
      if (deps.platform !== 'win32') void rm(sockPath, { force: true })
      deps.log(`[plugin-sandbox] ${manifest.pluginId} exited (${code})`)
      if (child === c) { child = null; changed() }
    })
    proc.on('error', (e) => deps.log(`[plugin-sandbox] spawn failed: ${e.message}`))
    child = c
    changed()
    try {
      await hello
    } catch (e) {
      await stop()
      throw e
    }
    deps.log(`[plugin-sandbox] ${manifest.pluginId} started (pid ${proc.pid})`)
    return c
  }

  async function stop(): Promise<void> {
    const c = child
    if (!c) return
    child = null
    changed()
    if (c.exited) return
    try { c.sock?.write(JSON.stringify({ id: 0, op: 'quit' }) + '\n') } catch { /* 通道已断 */ }
    await new Promise<void>((resolve) => {
      if (c.exited) return resolve()
      const kill = setTimeout(() => { try { c.proc.kill('SIGKILL') } catch { /* 已退 */ } resolve() }, 5_000)
      c.proc.once('exit', () => { clearTimeout(kill); resolve() })
    })
  }

  async function start(dir: string, sessionId?: string): Promise<SandboxResult> {
    const manifest = await readSandboxManifest(dir)
    let c = child && !child.exited ? child : null
    if (c && (c.dir !== dir || c.manifest.pluginId !== manifest.pluginId)) { await stop(); c = null }
    if (c) {
      // 同一个插件:就地重载(改过 manifest 也算),不重开窗口
      if (sessionId) c.sessionId = sessionId
      await request(c, 'reload', {}, 30_000)
    } else {
      c = await spawnChild(dir, manifest, sessionId)
    }
    const st = await settle(c)
    return ok(st, await shoot(c))
  }

  async function reset(): Promise<SandboxResult> {
    const c = child
    if (!c) return { ok: false, code: 'no_sandbox', error: 'no sandbox is running' }
    const { dir, sessionId, paths } = c
    await stop()
    if (!isSandboxRoot(deps.forsionHome(), paths.root)) return { ok: false, code: 'error', error: 'refusing to wipe an unexpected folder' }
    await rm(paths.root, { recursive: true, force: true })
    return start(dir, sessionId)
  }

  async function exec(op: string, args: Record<string, unknown>, origin: { sessionId?: string } = {}): Promise<SandboxResult> {
    try {
      if (op === 'start') {
        const dir = typeof args.dir === 'string' ? args.dir : ''
        // 两个 start 撞在一起(agent 和用户同时点):后一个等前一个落定再走,不并发起两份
        while (starting) await starting.catch(() => {})
        starting = start(dir, origin.sessionId)
        try { return await starting } finally { starting = null }
      }
      if (op === 'stop') { await stop(); return { ok: true, text: JSON.stringify({ stopped: true }) } }
      if (op === 'reset') return await reset()
      const c = child && !child.exited ? child : null
      if (!c || !c.sock) return { ok: false, code: 'no_sandbox', error: 'no sandbox is running' }
      c.lastUsed = Date.now()
      if (op === 'status' || op === 'logs') return ok(await readStatus(c))
      if (op === 'screenshot') {
        const view = typeof args.view === 'string' ? args.view : undefined
        const image = await shoot(c, view)
        return ok(await readStatus(c), image, image ? undefined : 'no screenshot')
      }
      if (op === 'command') {
        const r = await request(c, 'command', { command: args.command, args: args.args ?? {} }, 20_000)
        return ok(await readStatus(c), undefined, typeof r.error === 'string' ? r.error.slice(0, 300) : undefined)
      }
      return { ok: false, code: 'unsupported', error: `unknown sandbox action "${op}"` }
    } catch (e) {
      const code = e instanceof SandboxError ? e.code : 'error'
      return { ok: false, code, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** 把沙箱窗口叫到前面(卡片 / Coding Studio 的「打开沙箱窗口」)。 */
  async function show(): Promise<boolean> {
    const c = child && !child.exited ? child : null
    if (!c) return false
    c.lastUsed = Date.now()
    await request(c, 'show').catch(() => null)
    return true
  }

  /** 「安装到我的 Forsion」:拷进 <forsionHome>/plugins/<插件 id>(先拷到旁边再换,失败不留半截)。确认框由 main.ts 先弹。 */
  async function install(): Promise<{ ok: boolean; pluginId?: string; error?: string }> {
    const c = child && !child.exited ? child : null
    if (!c) return { ok: false, error: 'no sandbox is running' }
    const manifest = await readSandboxManifest(c.dir)
    const root = join(deps.forsionHome(), 'plugins')
    await mkdir(root, { recursive: true })
    // 同一个插件已从商店装在别的目录名下(market-<uuid> 或 install_slug):再装一份就是两个同 id 的插件抢位置
    for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || e.name === manifest.pluginId || e.name.startsWith('.')) continue
      const m = await readFile(join(root, e.name, 'manifest.json'), 'utf8').then((s) => JSON.parse(s), () => null)
      if (m && effectivePluginId(e.name, m.id) === manifest.pluginId) return { ok: false, error: `the same plugin is already installed in plugins/${e.name}; uninstall it first` }
    }
    const dest = join(root, manifest.pluginId)
    const rand = randomBytes(4).toString('hex')
    const tmp = `${dest}.installing-${rand}`
    const old = `${dest}.old-${rand}`
    try {
      await cp(c.dir, tmp, { recursive: true, filter: (src) => !INSTALL_SKIP.test(src.slice(c.dir.length)) })
      const had = await stat(dest).then(() => true, () => false)
      if (had) await rename(dest, old)
      await rename(tmp, dest)
      if (had) await rm(old, { recursive: true, force: true })
      return { ok: true, pluginId: manifest.pluginId }
    } catch (e) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  // 闲置自动停:窗口没开着、15 分钟没人用
  const idle = setInterval(() => {
    const c = child
    if (!c || c.exited || Date.now() - c.lastUsed < idleMs) return
    void readStatus(c).then((st) => { if (!st?.windowVisible && child === c) { deps.log(`[plugin-sandbox] ${c.manifest.pluginId} idle, stopping`); void stop() } }, () => {})
  }, 60_000)
  idle.unref?.()

  return {
    exec,
    show,
    stop,
    reset,
    install,
    state: publicState,
    dispose: async () => { clearInterval(idle); await stop() },
  }
}

export type PluginSandbox = ReturnType<typeof createPluginSandbox>
