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
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, normalize, relative, sep } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { effectivePluginId } from '../shared/products'
import { sanitizeRequiresPlugins } from '../shared/amadeus/ipc'
import { sanitizeNetworkPatterns } from '../shared/pluginNetwork'
import { parseSandboxStatus, type SandboxInstalled, type SandboxStatus } from '../../tangu-agent/src/contracts/pluginSandbox'
import { defineMainMessages } from './mainI18n'
import { DEFAULT_APPEARANCE } from '../shared/startupAppearance'

/** 「安装到我的 Forsion」确认框(main.ts 弹)。 */
export const PLUGIN_SANDBOX_MESSAGES = defineMainMessages({
  'main.pluginSandbox.installTitle': { zh: '安装插件', en: 'Install plugin' },
  'main.pluginSandbox.installMessage': { zh: '把「{name}」{version} 安装到你的 Forsion？', en: 'Install "{name}" {version} in your Forsion?' },
  'main.pluginSandbox.installDetail': {
    zh: '会从 {dir} 复制一份到你的插件文件夹。装好后它拿到 manifest.json 里声明的权限，能访问你的智库。',
    en: 'A copy of {dir} goes into your plugins folder. Once installed it gets the permissions declared in its manifest.json and can access your vault.',
  },
  'main.pluginSandbox.installNetwork': { zh: '会访问：{domains}', en: 'Accesses: {domains}' },
  'main.pluginSandbox.install': { zh: '安装', en: 'Install' },
  'main.pluginSandbox.updateMessage': { zh: '用沙箱里这份更新你 Forsion 里的「{name}」？', en: 'Update "{name}" in your Forsion with the sandbox copy?' },
  'main.pluginSandbox.update': { zh: '更新', en: 'Update' },
  'main.pluginSandbox.reinstallMessage': { zh: '你的 Forsion 里已经是这一份「{name}」{version}。再装一遍，覆盖装好的那份？', en: 'Your Forsion already has this copy of "{name}" {version}. Install it again over the installed one?' },
  'main.pluginSandbox.reinstall': { zh: '重新安装', en: 'Install again' },
  'main.pluginSandbox.cancel': { zh: '取消', en: 'Cancel' },
  'main.pluginSandbox.windowTitle': { zh: 'Forsion 沙箱 · {name}', en: 'Forsion sandbox · {name}' },
})

/** 带给沙箱首屏的界面状态:语言 + 父进程渲染层的主题那几把 localStorage 键(子进程只收 forsion_theme* / forsion_glass*)。 */
export interface PluginSandboxUiSeed { locale: 'zh' | 'en'; storage: Record<string, string> }

/** network:manifest `network` 里认得出的主机名模式(装好后 ctx.net 只许访问这些);没声明就没有这一项。 */
export interface SandboxManifest { pluginId: string; name: string; version: string; network?: string[] }

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
  const { patterns: network } = sanitizeNetworkPatterns(m.network)
  return { pluginId, name: str(m.name, 120) || pluginId, version: str(m.version, 40), ...(network.length ? { network } : {}) }
}

/** 两种槽位各占一个父目录:开发沙箱在 sandbox/<插件 id>,演示舞台在 stages/<插件 id>(分开放:id 以 stage- 开头的插件不会撞上舞台)。 */
export type SandboxBase = 'sandbox' | 'stages'

export function sandboxPaths(forsionHome: string, pluginId: string, base: SandboxBase = 'sandbox') {
  const root = join(forsionHome, base, pluginId)
  return { root, userData: join(root, 'userdata'), home: join(root, 'home'), workspace: join(root, 'workspace'), vault: join(root, 'vault') }
}

/** 控制通道地址。macOS 的 unix socket 路径上限 104 字节:放 tmpdir,别放在可能很深的数据目录里。 */
export function sandboxSockPath(platform: NodeJS.Platform, pid: number, rand: string): string {
  return platform === 'win32' ? `\\\\.\\pipe\\forsion-sbx-${pid}-${rand}` : join(tmpdir(), `forsion-sbx-${pid}-${rand}.sock`)
}

/** 子进程的环境:父进程自己的 TANGU_HOME(dev 会被 bindDevTanguHome 设上)等一律换成沙箱的。 */
export function sandboxEnv(base: NodeJS.ProcessEnv, p: ReturnType<typeof sandboxPaths>, extra: { dir: string; sock: string; token: string; info: string; backendUrl?: string }): NodeJS.ProcessEnv {
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
    // 引擎指向死端口:沙箱不起、不连任何引擎(界面照常,Tangu 那几页显示连不上)。
    // 舞台选了脚本回放(engine: 'scripted')时指向父进程起的回放服务(stageEngine.ts),只在本机回环上
    TANGU_BACKEND_URL: extra.backendUrl ?? 'http://127.0.0.1:1',
    // 电脑操作助手的 socket 指到不存在的地方:沙箱绝不连上用户那份助手
    PI_CU_SOCKET_PATH: join(p.root, 'no-computer-use.sock'),
    // 子进程的窗口一律 showInactive:不抢用户前台(用户从卡片 / Coding Studio 点「打开沙箱窗口」才叫到前面)
    TANGU_HARNESS_QUIET: '1',
  }
}

/** 沙箱子进程只播种被测插件 requiresPlugins 点名的内置包;清单读不出就一个也不要(沙箱会把它报成拒载)。 */
export async function sandboxRequiredPlugins(dir: string): Promise<Set<string>> {
  let m: { id?: unknown; requiresPlugins?: unknown } = {}
  try { m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) } catch { /* 缺 / 坏 */ }
  return new Set((sanitizeRequiresPlugins(m?.requiresPlugins, typeof m?.id === 'string' ? m.id : undefined) ?? []).map((d) => d.id))
}

/** 删沙箱目录前的最后一道:只删 <forsionHome>/sandbox/<合法 id>(舞台:stages/<合法 id>)。 */
export function isSandboxRoot(forsionHome: string, p: string, folder: SandboxBase = 'sandbox'): boolean {
  const base = normalize(join(forsionHome, folder)) + sep
  const n = normalize(p)
  return n.startsWith(base) && /^[a-z0-9][a-z0-9-]{0,63}$/.test(n.slice(base.length))
}

/** 删 / 写沙箱目录前再按真实路径核一遍:<forsionHome> 自己是软链没关系(dev 的 ~/.forsion-dev 就是),sandbox/<id> 和下面那几层不能是。 */
export async function insideSandbox(forsionHome: string, p: ReturnType<typeof sandboxPaths>, dirs: string[] = [], folder: SandboxBase = 'sandbox'): Promise<boolean> {
  if (!isSandboxRoot(forsionHome, p.root, folder)) return false
  const base = await realpath(join(forsionHome, folder)).catch(() => null)
  // 父目录本身也不能是软链(Codex 11-20:stages 若被链到 plugins,清空舞台就成了删真插件目录):它的真实路径必须正好是 <home 的真实路径>/<folder>
  const homeReal = await realpath(forsionHome).catch(() => null)
  if (!base || !homeReal || base !== join(homeReal, folder)) return false
  const root = join(base, basename(p.root))
  for (const d of [p.root, ...dirs]) if ((await realpath(d).catch(() => null)) !== join(root, relative(p.root, d))) return false
  return true
}

/** 「安装到我的 Forsion」不拷的东西。 */
export const INSTALL_SKIP = /(^|[\\/])(node_modules|\.git|\.forsion|\.DS_Store)([\\/]|$)/

/** 比对上限:超了就不比(unknown,按钮照旧能装),免得带大素材的插件每次重载都去读几百兆。 */
const DIGEST_MAX_FILES = 4000
const DIGEST_MAX_BYTES = 256 * 1024 * 1024

/** 插件目录的逐文件摘要(相对路径 → sha256),范围和「安装」拷的一样:按真实目录走、软链跟进去、跳过 INSTALL_SKIP。超上限 / 读不了 = null。 */
export async function pluginDigest(dir: string, limits = { files: DIGEST_MAX_FILES, bytes: DIGEST_MAX_BYTES }): Promise<Map<string, string> | null> {
  const root = await realpath(dir).catch(() => null)
  if (!root) return null
  const out = new Map<string, string>()
  let bytes = 0
  // 读不了的目录 / 文件 = 比不了(null),不当没有;同一个目录被软链两处 cp 会拷两份,这里也各算一份,只有绕回祖先才停
  const walk = async (abs: string, rel: string, up: ReadonlySet<string>): Promise<boolean> => {
    const real = await realpath(abs).catch(() => null)
    if (!real) return false
    if (up.has(real)) return true
    const chain = new Set(up).add(real)
    const names = await readdir(abs).catch(() => null)
    if (!names) return false
    for (const name of names.sort()) {
      const r = rel ? `${rel}/${name}` : name
      if (INSTALL_SKIP.test(`/${r}`)) continue
      const p = join(abs, name)
      const st = await stat(p).catch(() => null)
      if (!st) return false
      if (st.isDirectory()) { if (!(await walk(p, r, chain))) return false; continue }
      if (!st.isFile()) continue
      bytes += st.size
      if (out.size >= limits.files || bytes > limits.bytes) return false
      const data = await readFile(p).catch(() => null)
      if (!data) return false
      out.set(r, createHash('sha256').update(data).digest('hex'))
    }
    return true
  }
  return (await walk(root, '', new Set())) ? out : null
}

/** 安装换目录时的临时目录。新的以点开头(装载器跳过点目录);老版本留下的 <id>.installing- / .old- 也不算另装了一份。 */
const INSTALL_TEMP = /\.(installing|old)-[0-9a-f]+$/
const MARKET_DIR = /^market-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * 用户那份 Forsion 里这个插件装没装、装的是不是沙箱里这一份(契约 SandboxInstalled)。同一个 id 以别的目录名装着(商店的
 * market-… / install_slug)= store,和 install 的拒绝条件一致。比不了(太大 / 读不了)= unknown。
 */
export async function sandboxInstalledState(forsionHome: string, dir: string, pluginId: string, limits?: { files: number; bytes: number }): Promise<SandboxInstalled> {
  const root = join(forsionHome, 'plugins')
  const blank = { version: '', changed: 0, folder: '' }
  // 读不到 = null;读到了解析不了 = id 未知(.then 的第二个参数接不住 JSON.parse 抛的错,所以 parse 自己兜)
  const manifestOf = (d: string): Promise<{ id: unknown; version: string } | null> => readFile(join(d, 'manifest.json'), 'utf8').then((t) => {
    let m: Record<string, unknown> | null = null
    try { m = JSON.parse(t) as Record<string, unknown> | null } catch { /* 写坏了 */ }
    return { id: m?.id, version: typeof m?.version === 'string' ? m.version.trim().slice(0, 40) : '' }
  }, () => null)
  for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || e.name === pluginId || e.name.startsWith('.') || INSTALL_TEMP.test(e.name)) continue
    const m = await manifestOf(join(root, e.name))
    if (!m) continue
    // 普通目录(install_slug)按 manifest id 跑;商店的 market-<uuid> 按目录名跑,但装载器会拿它顶掉同 manifest id 的普通目录
    // (supersededPlainInstalls)—— 装进 plugins/<id> 的这份就不会被装载,所以也算另装着一份
    if (effectivePluginId(e.name, m.id) === pluginId || (MARKET_DIR.test(e.name) && m.id === pluginId)) return { ...blank, state: 'store', version: m.version, folder: e.name }
  }
  const dest = join(root, pluginId)
  const there = await lstat(dest).then(() => true, () => false)
  if (!there) return { ...blank, state: 'none' }
  // 目录在、清单读不了 / 写坏了:仍是「装着一份(坏的)」,按逐文件比对算,好让「更新」把它修好
  const mine = (await manifestOf(dest)) ?? { id: undefined, version: '' }
  const [a, b] = await Promise.all([pluginDigest(dir, limits), pluginDigest(dest, limits)])
  if (!a || !b) return { ...blank, state: 'unknown', version: mine.version }
  let changed = 0
  for (const [k, h] of a) if (b.get(k) !== h) changed++
  for (const k of b.keys()) if (!a.has(k)) changed++
  return { ...blank, state: changed ? 'older' : 'same', version: mine.version, changed }
}

/** 安装的结果。code:no_sandbox 没在跑 / changed 确认期间沙箱换了插件 / store 同一个插件以别的目录名装着 / same 装的就是这一份(要 force 才重装)/ error 其余。 */
export interface SandboxInstallResult { ok: boolean; pluginId?: string; code?: 'no_sandbox' | 'changed' | 'store' | 'same' | 'error'; error?: string; installed?: SandboxInstalled | null; cancelled?: boolean }

export interface SandboxDeps {
  focusWindow?(hwnd: number, pid: number): Promise<boolean>
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
  /** 闲置检查的间隔(缺省 1 分钟,单测调小)。自停前提前一个间隔在沙箱窗口里提示。 */
  idleTickMs?: number
  /** 槽位的父目录(缺省 sandbox = 开发沙箱;演示舞台另起一个实例,用 stages)。 */
  base?: SandboxBase
}

/** 演示舞台(pluginStage.ts)起子进程时额外带的:写进 FORSION_SANDBOX_INFO 的 stage 段、起进程前的准备(拷演示库 / 插件包)、
 *  首屏界面(不跟用户的主题走)、多给的命令行开关、引擎地址(脚本回放)。 */
export interface StageSpawn {
  info: Record<string, unknown>
  prepare(paths: ReturnType<typeof sandboxPaths>): Promise<void>
  ui: PluginSandboxUiSeed
  args: string[]
  backendUrl?: string
  /** 回放服务只认的令牌(每次起舞台现生成);没有 = 'sandbox'。 */
  backendToken?: string
}

export interface SandboxPublicState {
  running: boolean
  pluginId?: string
  name?: string
  version?: string
  dir?: string
  /** 发起这个沙箱的对话(报告问题往那里发;右栏的沙箱卡只在这个对话里出现)。 */
  sessionId?: string
  status?: SandboxStatus | null
  /** 用户那份 Forsion 里装没装这一份(11-28;status 里也有一份,status 还没回来时看这里)。 */
  installed?: SandboxInstalled | null
  /** 最近一步(agent 或卡片做的):op = 契约里的动作名,target = 点 / 输入的那个元素(插件的字)。 */
  lastOp?: { op: string; at: number; target?: string }
  /** 最近一张截图的时刻;图本身另向 lastShot 要(几百 KB,不跟着每次状态广播走)。 */
  shotAt?: number
  /** 没在跑时:上一个沙箱是谁、为什么停的(卡片据此显示「闲置已停」+ 重新启动)。 */
  last?: SandboxLast
}

export interface SandboxLast { pluginId: string; name: string; version: string; dir: string; sessionId?: string; reason: 'stopped' | 'idle' | 'exited'; at: number }

/** 只看、不动沙箱界面的动作:不算「最近一步」。 */
const QUIET_OPS = new Set(['status', 'logs'])
/** 转给子进程原样做的动作(11-03 起;settings 11-15 起);回来的 action 挂在 text 的 `action` 键上。 */
const CHILD_OPS = new Set(['read', 'click', 'type', 'press', 'scroll', 'space', 'files', 'settings'])

export type SandboxChildEvent =
  | { event: 'report'; note: string; sessionId?: string; pluginId: string; name: string }
  | { event: 'install'; pluginId: string; force?: boolean }
  /** gen = 发出这个按钮的那一个沙箱:排队的工夫被换成了新的一个,就不动新的(11-28 评审)。 */
  | { event: 'reset'; pluginId: string; gen?: number }
  /** 沙箱窗口回执卡上的「在我的 Forsion 打开」/「关闭沙箱」(11-28)。 */
  | { event: 'openHost'; pluginId: string; settings?: boolean }
  | { event: 'close'; pluginId: string; gen?: number }
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
  /** 进程没了(正常退出 / 被杀 / 根本没起来)且通道已收拾干净。 */
  done: Promise<void>
  lastUsed: number
  status: SandboxStatus | null
  lastOp?: { op: string; at: number; target?: string }
  shot?: string
  shotAt?: number
  /** 起它时被测插件点名的内置包(排好序拼起来):变了 = start 要重起而不是就地重载。 */
  needs?: string
  /** 用户那份 Forsion 里装没装这一份(refreshInstalled 算);正在算时又要算 = again。 */
  installed?: SandboxInstalled | null
  refreshing?: Promise<void> | null
  again?: boolean
  /** 闲置自停的提示已经推给沙箱窗口的时刻(0 = 没在提示)。 */
  idleWarnAt?: number
  /** 第几个沙箱(进程级递增):确认框 / 安装 / 回执都绑在点按钮那一刻的这一个上,重置换了一个就不算数。 */
  gen: number
}
let sandboxGen = 0

const HELLO_MS = 45_000
const SETTLE_MS = 30_000
const REQ_MS = 15_000

export function createPluginSandbox(deps: SandboxDeps) {
  let child: Child | null = null
  let disposed = false
  const idleMs = deps.idleMs ?? 15 * 60_000
  const idleTick = deps.idleTickMs ?? 60_000
  const folder: SandboxBase = deps.base ?? 'sandbox'

  // 起 / 停 / 重置 / 安装 / 闲置停 / 退出排成一队,一件做完再做下一件:agent、卡片、沙箱窗口三处都能点,
  // 交错起来会出「停先返回、起后落地」或「重置删数据时另一次 start 已经起在同一个目录上」。
  let chain: Promise<unknown> = Promise.resolve()
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn)
    chain = p.catch(() => {})
    return p
  }
  const fail = (e: unknown): SandboxResult =>
    ({ ok: false, code: e instanceof SandboxError ? e.code : 'error', error: e instanceof Error ? e.message : String(e) })

  let last: SandboxLast | null = null
  const remember = (c: Child, reason: SandboxLast['reason']): void => {
    last = { pluginId: c.manifest.pluginId, name: c.manifest.name, version: c.manifest.version, dir: c.dir, sessionId: c.sessionId, reason, at: Date.now() }
  }
  const publicState = (): SandboxPublicState => child && !child.exited
    ? { running: true, pluginId: child.manifest.pluginId, name: child.manifest.name, version: child.manifest.version, dir: child.dir, sessionId: child.sessionId, status: child.status, installed: child.installed ?? null, lastOp: child.lastOp, shotAt: child.shotAt }
    : { running: false, ...(last ? { last } : {}) }
  /** 记最近一步与最近一张图(卡片的缩略图 / 「最近一步」行)。 */
  const note = (c: Child, op: string, r: SandboxResult, target?: string): SandboxResult => {
    if (!QUIET_OPS.has(op)) c.lastOp = { op, at: Date.now(), ...(target ? { target: target.slice(0, 120) } : {}) }
    if (r.image) { c.shot = r.image; c.shotAt = Date.now() }
    if (child === c) changed()
    return r
  }
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
    if (st) { st.installed = c.installed ?? null; c.status = st; changed() }
    return st
  }

  /** 父 → 子的通知(id 0:子进程不回)。 */
  const installedOfInflight = new Map<string, Promise<SandboxInstalled | null>>()
  /** 有人用了(agent 的动作、用户切进窗口、点「继续用」):闲置从头算,正在提示的「快自动停了」收回去。 */
  const touch = (c: Child): void => {
    c.lastUsed = Date.now()
    if (c.idleWarnAt) { c.idleWarnAt = 0; push(c, 'idleWarn', { on: false }) }
  }
  const push = (c: Child, op: string, args: Record<string, unknown>): void => {
    try { if (c.sock && !c.exited) c.sock.write(JSON.stringify({ id: 0, op, args }) + '\n') } catch { /* 通道断了 */ }
  }

  /** 重算「用户那份装没装这一份」:起好 / 重载完 / 装完各一次。变了就广播(卡片)并告诉沙箱窗口(顶条的按钮)。舞台不装,不算。 */
  // 正在算时又要算:记一笔 again,等的人拿到的是那一轮(含补算)算完的结果,不是开头那份旧的
  function refreshInstalled(c: Child): Promise<void> {
    if (folder !== 'sandbox') return Promise.resolve()
    if (c.refreshing) { c.again = true; return c.refreshing }
    const run = (async () => {
      do {
        c.again = false
        const next = await sandboxInstalledState(deps.forsionHome(), c.dir, c.manifest.pluginId).catch(() => null)
        if (child !== c || c.exited) return
        const same = JSON.stringify(next) === JSON.stringify(c.installed ?? null)
        c.installed = next
        if (c.status) c.status = { ...c.status, installed: next }
        if (!same) { changed(); push(c, 'installed', { installed: next }) }
      } while (c.again)
    })().finally(() => { c.refreshing = null })
    c.refreshing = run
    return run
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

  async function shoot(c: Child, view?: string, settleFirst = false): Promise<string | undefined> {
    return (await shootIn(c, { view, settle: settleFirst })).image
  }
  /** window = 'settings':截设置窗口(没开着 → error 说清楚)。 */
  async function shootIn(c: Child, o: { view?: string; settle?: boolean; window?: string }): Promise<{ image?: string; error?: string }> {
    const r = await request(c, 'screenshot', { ...(o.view ? { view: o.view } : {}), ...(o.settle ? { settle: true } : {}), ...(o.window === 'settings' ? { window: 'settings' } : {}) }, 20_000).catch(() => null)
    return { ...(typeof r?.image === 'string' ? { image: r.image } : {}), ...(typeof r?.error === 'string' ? { error: r.error.slice(0, 300) } : {}) }
  }

  const ok = (st: SandboxStatus | null, image?: string, error?: string): SandboxResult =>
    st ? { ok: true, text: JSON.stringify(st), ...(image ? { image } : {}), ...(error ? { error } : {}) } : { ok: false, code: 'error', error: 'the sandbox did not report its status' }

  function onLine(c: Child, line: string): void {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(line) } catch { return }
    if (typeof msg.id === 'number') { c.pending.get(msg.id)?.(msg); c.pending.delete(msg.id); return }
    const ev = msg.event
    if (ev === 'state') {
      const st = parseSandboxStatus(msg.status)
      // 用户切进 / 切出沙箱窗口都会报一次:在用的时候和刚离开的那一刻都算「用过」,闲置从离开那一刻算起
      if (st) {
        const was = c.status?.windowVisible
        // 保存即重载过(loads 变了):插件文件变了,「已安装」可能变成「更新」
        const reloaded = !!c.status && st.loads !== c.status.loads
        st.installed = c.installed ?? null
        c.status = st
        if (st.windowVisible || was) touch(c)
        changed()
        if (reloaded) void refreshInstalled(c)
      }
      return
    }
    if (ev === 'report') {
      deps.onChildEvent({ event: 'report', note: typeof msg.note === 'string' ? msg.note.slice(0, 2000) : '', sessionId: c.sessionId, pluginId: c.manifest.pluginId, name: c.manifest.name })
      return
    }
    if (ev === 'install') deps.onChildEvent({ event: 'install', pluginId: c.manifest.pluginId, ...(msg.force === true ? { force: true } : {}) })
    if (ev === 'openHost') deps.onChildEvent({ event: 'openHost', pluginId: c.manifest.pluginId, ...(msg.settings === true ? { settings: true } : {}) })
    if (ev === 'reset' || ev === 'close') deps.onChildEvent({ event: ev, pluginId: c.manifest.pluginId, gen: c.gen })
    // 闲置提示上的「继续用」(子进程只在沙箱窗口有焦点时才转过来,插件代码在后台续不了命)
    if (ev === 'keepAlive') touch(c)
    if (ev === 'forward' && (msg.kind === 'url' || msg.kind === 'file') && typeof msg.value === 'string') deps.onChildEvent({ event: 'forward', kind: msg.kind, value: msg.value.slice(0, 4096) })
  }

  async function spawnChild(dir: string, manifest: SandboxManifest, sessionId?: string, stage?: StageSpawn): Promise<Child> {
    const home = deps.forsionHome()
    const paths = sandboxPaths(home, manifest.pluginId, folder)
    const dirs = [paths.userData, `${paths.userData}-dev`, paths.home, paths.workspace, paths.vault]
    for (const d of dirs) await mkdir(d, { recursive: true })
    if (!(await insideSandbox(home, paths, dirs, folder))) throw new SandboxError('error', `refusing to use ${paths.root}: it links outside the sandbox folder`)
    if (stage) await stage.prepare(paths)
    // 先删再写:配置文件若是软链,写穿到别处
    const put = async (f: string, data: unknown): Promise<void> => { await rm(f, { force: true }); await writeFile(f, JSON.stringify(data)) }
    // 两份 userData 都写:dev 态的 Electron 会给 --user-data-dir 再挂一个 -dev(main.ts)
    for (const d of [paths.userData, `${paths.userData}-dev`]) {
      await put(join(d, 'tangu-desktop-config.json'), { mode: 'external', backendUrl: stage?.backendUrl ?? 'http://127.0.0.1:1', token: stage?.backendToken ?? 'sandbox' })
      for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) await put(join(d, f), { localVault: paths.vault, lastVault: paths.vault })
      // 不放开屏:沙箱窗口压在普通窗口之下,开屏等不到「窗口已显示」会一直盖到 10 秒上限,第一张截图拍到的全是它
      await put(join(d, 'startup-appearance.json'), { ...DEFAULT_APPEARANCE, showSplash: false })
    }
    const token = randomBytes(24).toString('base64url')
    const sockPath = sandboxSockPath(deps.platform, deps.pid, randomBytes(6).toString('hex'))
    if (deps.platform !== 'win32') await rm(sockPath, { force: true })
    const server = createServer()
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(sockPath, () => { server.off('error', reject); resolve() }) })
    const ui = stage ? stage.ui : deps.ui()
    const info = JSON.stringify({ pluginId: manifest.pluginId, name: manifest.name, version: manifest.version, dir, vault: paths.vault, root: paths.root, ui, ...(stage ? { stage: stage.info } : {}) })
    const args = [...deps.appArgs, `--user-data-dir=${paths.userData}`, `--lang=${ui.locale === 'en' ? 'en' : 'zh-CN'}`, ...(stage?.args ?? []), ...(deps.platform === 'darwin' ? ['-ApplePersistenceIgnoreState', 'YES'] : [])]
    const dropServer = (): void => { server.close(); if (deps.platform !== 'win32') void rm(sockPath, { force: true }) }
    let proc: ChildProcess
    try {
      proc = deps.spawn(args, sandboxEnv(process.env, paths, { dir, sock: sockPath, token, info, ...(stage?.backendUrl ? { backendUrl: stage.backendUrl } : {}) }))
    } catch (e) {
      dropServer()
      throw new SandboxError('error', `could not start the sandbox: ${e instanceof Error ? e.message : String(e)}`)
    }
    let markDone!: () => void
    const c: Child = { proc, server, sockPath, sock: null, manifest, dir, paths, sessionId, pending: new Map(), seq: 0, exited: false, done: new Promise((r) => { markDone = r }), lastUsed: Date.now(), status: null, gen: ++sandboxGen }
    let helloFail: (e: Error) => void = () => {}
    // 正常退出 / 被杀 / 根本没起来(spawn 失败只发 error + close,不发 exit)都走这一条,只收拾一次
    const finish = (why: string): void => {
      if (c.exited) return
      c.exited = true
      helloFail(new SandboxError('error', 'the sandbox window exited while starting'))
      for (const fn of c.pending.values()) fn({ ok: false, error: 'exited' })
      c.pending.clear()
      dropServer()
      deps.log(`[plugin-sandbox] ${manifest.pluginId} ${why}`)
      if (child === c) { remember(c, 'exited'); child = null; changed() }
      markDone()
    }
    proc.once('exit', (code) => finish(`exited (${code})`))
    proc.once('close', (code) => finish(`closed (${code})`))
    proc.on('error', (e) => finish(`spawn failed: ${e.message}`))
    const hello = new Promise<void>((resolve, reject) => {
      helloFail = reject
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
      void c.done.then(() => clearTimeout(timer))
    })
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

  async function stop(reason: SandboxLast['reason'] = 'stopped'): Promise<void> {
    const c = child
    if (!c) return
    remember(c, reason)
    child = null
    changed()
    if (c.exited) return
    try { c.sock?.write(JSON.stringify({ id: 0, op: 'quit' }) + '\n') } catch { /* 通道已断 */ }
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => { try { c.proc.kill('SIGKILL') } catch { /* 已退 */ } resolve() }, 5_000)
      void c.done.then(() => { clearTimeout(kill); resolve() })
    })
  }

  async function start(dir: string, sessionId?: string): Promise<SandboxResult> {
    if (disposed) return { ok: false, code: 'error', error: 'Forsion is quitting' }
    const manifest = await readSandboxManifest(dir)
    let c = child && !child.exited ? child : null
    // 改了 requiresPlugins:内置包只在子进程启动时播种,就地重载装不上新点名的那个,得重起(Codex 评审)
    const needs = [...await sandboxRequiredPlugins(dir)].sort().join(',')
    if (c && (c.dir !== dir || c.manifest.pluginId !== manifest.pluginId || c.needs !== needs)) { await stop(); c = null }
    if (c) {
      // 同一个插件:就地重载(改过 manifest 也算),不重开窗口
      if (sessionId) c.sessionId = sessionId
      await request(c, 'reload', {}, 30_000)
    } else {
      c = await spawnChild(dir, manifest, sessionId)
      c.needs = needs
    }
    await refreshInstalled(c)
    const st = await settle(c)
    // 等界面落定再截:插件的 Space / 视图是装载落定之后才开出来的,马上截只截到一页空白(11-03 台架抓到)
    return note(c, 'start', ok(st, await shoot(c, undefined, true)))
  }

  async function reset(): Promise<SandboxResult> {
    const c = child
    if (!c) return { ok: false, code: 'no_sandbox', error: 'no sandbox is running' }
    const { dir, sessionId, paths } = c
    await stop()
    const home = deps.forsionHome()
    const there = await lstat(paths.root).then(() => true, () => false)
    if (there && !(await insideSandbox(home, paths, [], folder))) return { ok: false, code: 'error', error: 'refusing to wipe an unexpected folder' }
    if (there) await rm(paths.root, { recursive: true, force: true })
    return start(dir, sessionId)
  }

  /**
   * origin.deadline = 引擎给这次动作的期限(本机时钟);排队排过了就不做了 —— 引擎那边已按「可能发生了」兑现。
   * origin.reveal = 用户在界面上点的(卡片 / Coding Studio):起好后把沙箱窗口叫到前面。agent 起的不叫,不抢用户前台。
   */
  async function exec(op: string, args: Record<string, unknown>, origin: { sessionId?: string; deadline?: number; reveal?: boolean } = {}): Promise<SandboxResult> {
    const expired = (): boolean => typeof origin.deadline === 'number' && Date.now() > origin.deadline
    const queued = (fn: () => Promise<SandboxResult>): Promise<SandboxResult> =>
      serial(() => (expired() ? Promise.resolve({ ok: false, code: 'error', error: 'timed out waiting for another sandbox action' }) : fn().catch(fail)))
    try {
      if (op === 'start') {
        const r = await revealed(queued(() => start(typeof args.dir === 'string' ? args.dir : '', origin.sessionId)), origin.reveal)
        // 同一个插件再 start = 就地重载,还是原来那个沙箱:算用过,正挂着的「快自动停了」收回(11-28 评审)
        if (r.ok && child && !child.exited) touch(child)
        return r
      }
      if (op === 'stop') return await queued(async () => { await stop(); return { ok: true, text: JSON.stringify({ stopped: true }) } })
      if (op === 'reset') return await revealed(queued(reset), origin.reveal)
      const c = child && !child.exited ? child : null
      if (!c || !c.sock) return { ok: false, code: 'no_sandbox', error: 'no sandbox is running' }
      touch(c)
      if (op === 'status' || op === 'logs') return ok(await readStatus(c))
      if (op === 'screenshot') {
        const view = typeof args.view === 'string' ? args.view : undefined
        const shot = await shootIn(c, { view, window: typeof args.window === 'string' ? args.window : undefined })
        return note(c, op, ok(await readStatus(c), shot.image, shot.image ? undefined : shot.error || 'no screenshot'))
      }
      if (op === 'command') {
        const r = await request(c, 'command', { command: args.command, args: args.args ?? {}, ...(args.allowPending === true ? { allowPending: true } : {}) }, 20_000)
        // shot:做完顺手截一张(命令多半改了界面,agent 不必再要一次;还在等它自己弹的框时截到的正是那个框)
        const image = args.shot === true ? await shoot(c, undefined, true) : undefined
        const res = ok(await readStatus(c), image, typeof r.error === 'string' ? r.error.slice(0, 300) : undefined)
        // 命令开始了还没跑完(多半在等它自己弹的选择框):挂在 text 的 command 键上,老引擎不看它
        if (r.pending === true && res.text) res.text = JSON.stringify({ ...JSON.parse(res.text), command: { pending: true } })
        return note(c, op, res, typeof args.command === 'string' ? args.command : undefined)
      }
      if (CHILD_OPS.has(op)) {
        // 动手的动作排进同一队:两个对话同时 type 会先后把焦点抢走,字打进别的框、回执也串(Codex 评审)
        return await queued(async () => {
        if (child !== c || c.exited) return { ok: false, code: 'no_sandbox', error: 'the sandbox stopped meanwhile' }
        // settings 要等一扇新窗口起来、插件在里面装上:给足时间
        const r = await request(c, op, args, op === 'settings' ? 40_000 : 25_000)
        const st = await readStatus(c)
        const base = ok(st, typeof r.image === 'string' ? r.image : undefined, typeof r.error === 'string' ? r.error.slice(0, 500) : undefined)
        const action = r.action && typeof r.action === 'object' ? { ...(r.action as Record<string, unknown>) } : null
        if (st && action) {
          // 状态 + 大纲要一起放进 client_cmd 结果 text 的 48k 帽:超了先削大纲
          let text = JSON.stringify({ ...st, action })
          const over = text.length - 46_000
          if (over > 0 && typeof action.outline === 'string') { action.outline = `${action.outline.slice(0, Math.max(0, action.outline.length - over - 40))}\n… (cut)`; text = JSON.stringify({ ...st, action }) }
          base.text = text
        }
        return note(c, op, base, typeof action?.target === 'string' ? action.target : undefined)
        })
      }
      return { ok: false, code: 'unsupported', error: `unknown sandbox action "${op}"` }
    } catch (e) {
      return fail(e)
    }
  }

  /**
   * 演示舞台(pluginStage.ts)起一份:先停掉同一槽位里的前一份、清空舞台目录(每次都从演示库重新开始,上一次留下的标签页、
   * localStorage 不带过来),再按 stage 带的准备 / 开关 / 首屏起。等子进程报就绪:渲染层判「点名的插件都列出来、装载落定」。
   * dir = 舞台根目录:子进程在舞台模式下不装开发副本、不监视目录。
   */
  function openStage(owner: SandboxManifest, stage: StageSpawn): Promise<SandboxResult> {
    return serial(async () => {
      if (disposed) return { ok: false, code: 'error', error: 'Forsion is quitting' }
      await stop()
      const home = deps.forsionHome()
      const paths = sandboxPaths(home, owner.pluginId, folder)
      const there = await lstat(paths.root).then(() => true, () => false)
      if (there && !(await insideSandbox(home, paths, [], folder))) return { ok: false, code: 'error', error: 'refusing to wipe an unexpected folder' }
      if (there) await rm(paths.root, { recursive: true, force: true })
      const c = await spawnChild(paths.root, owner, undefined, stage)
      const st = await settle(c)
      return note(c, 'start', ok(st))
    }).catch(fail)
  }

  /** 舞台自己的动作(capture / recordStart / recordStop):原样转给子进程、原样回,和动手的动作排同一队。 */
  function raw(op: string, args: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    return serial(async () => {
      const c = child && !child.exited ? child : null
      if (!c || !c.sock) throw new SandboxError('no_sandbox', 'no sandbox is running')
      touch(c)
      return request(c, op, args, timeoutMs)
    })
  }

  /** 不排队的 raw:只给舞台录像的暂停 / 继续。动作(点击、按键)在子进程里要等 1.5 秒左右画面稳住才回,排在它后面的暂停
   *  只能等动作整个做完才生效,插件就剪不掉这段收尾(11-26 台架:每步至少录进 1.6 秒)。子进程按消息并发处理、
   *  回包按 id 对,暂停 / 继续只动渲染层的 MediaRecorder,不改舞台结构,所以可以插队。 */
  function rawNow(op: string, args: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const c = child && !child.exited ? child : null
    if (!c || !c.sock) return Promise.reject(new SandboxError('no_sandbox', 'no sandbox is running'))
    touch(c)
    return request(c, op, args, timeoutMs)
  }

  /** 把沙箱窗口叫到前面(卡片 / Coding Studio 的「打开沙箱窗口」)。 */
  /** 新起的沙箱窗口压在所有窗口之下(子进程是静默模式):用户自己点出来的起 / 重置,成功了就叫到前面。 */
  async function revealed(p: Promise<SandboxResult>, reveal?: boolean): Promise<SandboxResult> {
    const r = await p
    if (reveal && r.ok) await show()
    return r
  }

  async function show(): Promise<boolean> {
    const c = child && !child.exited ? child : null
    if (!c) return false
    touch(c)
    const reply = await request(c, 'show').catch(() => null)
    if (deps.focusWindow) {
      const hwnd = reply?.hwnd
      const pid = c.proc.pid
      if (child !== c || c.exited || !pid || typeof hwnd !== 'number' || !Number.isSafeInteger(hwnd) || hwnd <= 0) return false
      return deps.focusWindow(hwnd, pid)
    }
    return true
  }

  /**
   * 「安装到我的 Forsion」:拷进 <forsionHome>/plugins/<插件 id>(先拷到旁边再换,失败不留半截)。确认框由 main.ts 先弹,
   * expect = 确认框里给用户看的那个插件:等用户点的工夫沙箱换了插件 / manifest 换了 id,就不拿这次同意去装别的。
   */
  async function install(expect: { pluginId?: string; dir?: string; gen?: number }, opts: { force?: boolean } = {}): Promise<SandboxInstallResult> {
    const c = child && !child.exited ? child : null
    if (!c) return { ok: false, code: 'no_sandbox', error: 'no sandbox is running' }
    const changedMeanwhile: SandboxInstallResult = { ok: false, code: 'changed', error: 'the sandbox changed while you were confirming; try installing again' }
    if (c.dir !== expect.dir || c.manifest.pluginId !== expect.pluginId || (expect.gen !== undefined && c.gen !== expect.gen)) return changedMeanwhile
    const rand = randomBytes(4).toString('hex')
    let tmp = ''
    try {
      const manifest = await readSandboxManifest(c.dir)
      if (manifest.pluginId !== expect.pluginId) return changedMeanwhile
      const root = join(deps.forsionHome(), 'plugins')
      await mkdir(root, { recursive: true })
      // 同一个插件已从商店装在别的目录名下(market-<uuid> 或 install_slug):再装一份就是两个同 id 的插件抢位置;
      // 装的就是这一份:不悄悄再覆盖一遍(用户在沙箱窗口回执卡上点「重新安装」才带 force)
      const inst = await sandboxInstalledState(deps.forsionHome(), c.dir, manifest.pluginId)
      if (inst.state === 'store') return { ok: false, code: 'store', error: `the same plugin is already installed in plugins/${inst.folder}; uninstall it first`, installed: inst }
      if (inst.state === 'same' && !opts.force) return { ok: false, code: 'same', error: 'this exact copy is already installed', installed: inst }
      const dest = join(root, manifest.pluginId)
      // 临时目录以点开头:装载器跳过点目录,中途崩了留下的半截不会被当成第二份插件装上
      tmp = join(root, `.${manifest.pluginId}.installing-${rand}`)
      const old = join(root, `.${manifest.pluginId}.old-${rand}`)
      // 插件目录常是软链(开发者把项目链过来):按真实目录拷,里面的软链也拷成实体,装好的是一份真目录
      const src = await realpath(c.dir)
      await cp(src, tmp, { recursive: true, dereference: true, filter: (p) => !INSTALL_SKIP.test(p.slice(src.length)) })
      const had = await lstat(dest).then(() => true, () => false)
      if (had) await rename(dest, old)
      try {
        await rename(tmp, dest)
      } catch (e) {
        if (had) await rename(old, dest).catch((r) => deps.log(`[plugin-sandbox] could not put the previous copy back from ${old}: ${r instanceof Error ? r.message : String(r)}`))
        throw e
      }
      // 旧的那份删不掉不算装失败(新的已经在位),记一笔
      if (had) await rm(old, { recursive: true, force: true }).catch((r) => deps.log(`[plugin-sandbox] could not remove the previous copy ${old}: ${r instanceof Error ? r.message : String(r)}`))
      await refreshInstalled(c)
      return { ok: true, pluginId: manifest.pluginId, installed: c.installed ?? null }
    } catch (e) {
      if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {})
      return { ok: false, code: 'error', error: e instanceof Error ? e.message : String(e) }
    }
  }

  // 闲置自动停:沙箱窗口不在前台、15 分钟没人用(agent 没调、用户没切进去过)。只有一份新鲜的「在前台」才留它;
  // 状态要不回来(插件把渲染层卡死了)也停。停前一个检查间隔(1 分钟)先在沙箱窗口里提示「快自动停了」(11-28 细节页第 4 条):
  // 胶囊换字 + 一张「继续用 / 停掉」;提示推出去满一个间隔才真停,用户切回来正好看得到
  const idle = setInterval(() => {
    const c = child
    if (!c || c.exited || Date.now() - c.lastUsed < idleMs - idleTick) return
    void serial(async () => {
      const quiet = (): boolean => child === c && !c.exited && Date.now() - c.lastUsed >= idleMs - idleTick
      if (!quiet()) return
      const st = await readStatus(c).catch(() => null)
      // 等状态的工夫有人用过(录像的暂停 / 继续走 rawNow 不排队,会插在这中间):不算闲置
      if (st?.windowVisible || !quiet()) return
      if (!c.idleWarnAt) {
        c.idleWarnAt = Date.now()
        push(c, 'idleWarn', { on: true, stopAt: c.idleWarnAt + idleTick, idleMinutes: Math.max(1, Math.round(idleMs / 60_000)) })
        return
      }
      // 提示要挂过一个间隔才停(下一次检查就停;按半个间隔判,两次读状态快慢不一也不会多拖一整轮)
      if (Date.now() - c.lastUsed < idleMs || Date.now() - c.idleWarnAt < idleTick / 2) return
      deps.log(`[plugin-sandbox] ${c.manifest.pluginId} idle, stopping`)
      await stop('idle')
    })
  }, idleTick)
  idle.unref?.()

  return {
    exec,
    show,
    /** gen:只停这一个沙箱(沙箱窗口自己的「关闭沙箱 / 停掉」);排到时已经换成别的就不动。 */
    stop: (gen?: number) => serial(() => (gen === undefined || (child && !child.exited && child.gen === gen) ? stop() : Promise.resolve())),
    // 直接调的重置都是用户点的(卡片 / Coding Studio / 沙箱窗口自己的按钮);agent 的走 exec
    reset: (gen?: number) => revealed(serial(() => (gen === undefined || (child && !child.exited && child.gen === gen)
      ? reset().catch(fail) : Promise.resolve<SandboxResult>({ ok: false, code: 'no_sandbox', error: 'the sandbox changed; nothing was reset' }))), true),
    install: (expect: { pluginId?: string; dir?: string; gen?: number }, opts?: { force?: boolean }) => serial(() => install(expect, opts)),
    /** 现在这个沙箱是第几个(没在跑 = null):main.ts 在用户点按钮那一刻记下,确认 / 安装 / 回执都对它。 */
    gen: (): number | null => (child && !child.exited ? child.gen : null),
    /** 重算一次装没装再回(要弹框前用:缓存的那份可能是用户在设置里卸载之前的)。 */
    installedNow: async (): Promise<SandboxInstalled | null> => {
      const c = child && !child.exited ? child : null
      if (!c) return null
      await refreshInstalled(c)
      return c.installed ?? null
    },
    /** 用户那份的插件变了(商店装 / 卸、设置里卸):重算。 */
    hostPluginsChanged: (): void => { const c = child && !child.exited ? child : null; if (c) void refreshInstalled(c) },
    /**
     * 沙箱窗口里点的安装:确认框挂在沙箱窗口上(子进程弹的系统框 —— 插件的网页代码和沙箱条同在一个渲染层,画在网页里的「同意」
     * 插件能自己点掉,系统框它够不着)。回用户点的按钮下标;通道断了 / 等不回来 = null。不排队:等人点的工夫别的动作照做。
     */
    confirmInChild: async (gen: number, box: { title: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number }): Promise<number | null> => {
      const c = child && !child.exited ? child : null
      if (!c || c.gen !== gen) return null
      touch(c)
      const r = await request(c, 'confirmInstall', box, 15 * 60_000).catch(() => null)
      return typeof r?.response === 'number' && child === c ? r.response : null
    },
    /** 用户那份 Forsion 弹确认框期间:沙箱里钉住的浮窗 / 桌面小窗先让开(on = false 放回去)。 */
    yieldChild: (on: boolean): void => { const c = child && !child.exited ? child : null; if (c) push(c, 'yieldPinned', { on }) },
    /** 装完告诉沙箱窗口(顶条换「已安装」、从沙箱窗口点的那次垂回执卡 / 报错)。 */
    tellInstallResult: (gen: number, r: SandboxInstallResult & { origin: 'sandbox' | 'host' }): void => { const c = child && !child.exited ? child : null; if (c && c.gen === gen) push(c, 'installResult', { ...r }) },
    /** 卡片上沙箱已经停了的那份:还是要知道装没装(只读;不是插件目录 = null)。 */
    installedOf: (dir: string): Promise<SandboxInstalled | null> => {
      if (folder !== 'sandbox') return Promise.resolve(null)
      // 对话里好几张历史卡同时问同一个目录:并成一次
      const hit = installedOfInflight.get(dir)
      if (hit) return hit
      const run = (async () => {
        const m = await readSandboxManifest(dir).catch(() => null)
        return m ? sandboxInstalledState(deps.forsionHome(), dir, m.pluginId).catch(() => null) : null
      })().finally(() => installedOfInflight.delete(dir))
      installedOfInflight.set(dir, run)
      return run
    },
    state: publicState,
    openStage,
    raw,
    rawNow,
    /** 最近一张截图(右栏卡的缩略图):只给发起这个沙箱的对话。 */
    lastShot: (sessionId?: string): { image: string; at: number } | null => {
      const c = child && !child.exited ? child : null
      return c?.shot && c.shotAt && sessionId && c.sessionId === sessionId ? { image: c.shot, at: c.shotAt } : null
    },
    dispose: () => { disposed = true; clearInterval(idle); return serial(() => stop()) },
  }
}

export type PluginSandbox = ReturnType<typeof createPluginSandbox>
