/**
 * Computer Use 实时画面桥(只读)。
 *
 * 为什么在主进程:CU 的原生 helper 是个常驻辅助 App,只在 unix socket 上说话;渲染进程连不了 socket。
 * 为什么不经引擎:helper 自己就知道"最近在操控哪个窗口"(它是唯一执行动作的进程),问它一句比让
 * 引擎插件把状态转发出来短得多,而且引擎没跑的时候也能如实回答"没在操控"。
 *
 * 三条纪律:
 *  1. **只读,绝不启动 helper**。socket 不在 = 没在用 computer use,如实回 inactive;
 *     绝不能因为用户打开了一个视图就把辅助 App 拉起来(那会顺带弹权限框)。
 *  2. **绝不伪造画面**。拿不到图就带 error 回去,由 UI 说明原因(常见:没给录屏权限)。
 *  3. **macOS only**。Windows 的 helper 是 stdin/stdout 子进程(没有服务端),桌面够不着;
 *     要支持得先给 Rust bridge 加一个命名管道服务端 —— 那是另一件事。
 */
import { execFile } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export interface CuLiveFrame {
  active: boolean
  windowId?: number
  pid?: number
  app?: string
  bundleId?: string
  title?: string
  width?: number
  height?: number
  /** JPEG,base64(不含 data: 前缀)。缺失即本次没取到画面,看 error。 */
  jpegBase64?: string
  /** 这一帧的序号(字符串,helper 侧是 64 位无符号,别用 number 接)。带回给下次请求即可跳过没变的帧。 */
  frameSeq?: string
  /** true = 画面与你上次见到的那一帧相同,本次不含图。保留正在显示的画面即可。 */
  unchanged?: boolean
  /** 距最近一次观察/操作多久(毫秒)。 */
  ageMs?: number
  /** 机器可读的失败原因:unsupported_platform / helper_not_running / unsupported_helper / 或 helper 的错误码。 */
  error?: string
}

/** helper 的 socket 路径。与 vendor 的 HELPER_SOCKET_PATH 同源(同一个 env 覆盖 + 同一个默认值)。 */
export function helperSocketPath(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): string {
  return env.PI_CU_SOCKET_PATH || path.join(homeDir, 'Library', 'Caches', 'tangu-computer-use', 'bridge.sock')
}

/** helper 的 liveView 回包 → CuLiveFrame。字段一律显式挑,不透传未知结构。 */
export function normalizeLiveView(raw: unknown): CuLiveFrame {
  const r = (raw ?? {}) as Record<string, unknown>
  if (r.active !== true) return { active: false }
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  return {
    active: true,
    windowId: num(r.windowId),
    pid: num(r.pid),
    app: str(r.app),
    bundleId: str(r.bundleId),
    title: str(r.title),
    width: num(r.width),
    height: num(r.height),
    jpegBase64: str(r.jpegBase64),
    frameSeq: str(r.frameSeq),
    unchanged: r.unchanged === true ? true : undefined,
    ageMs: num(r.ageMs),
    error: str(r.error),
  }
}

/** 「最近被操控」的最长有效期上限(毫秒)。见 computerUseLiveView 里的说明。 */
const MAX_ACTIVE_WITHIN_MS = 120_000
/** 等 helper 的上限:必须 > 它内部截图的 8s,否则我们先放弃、它还在干,下一轮再叠一个。 */
const HELPER_TIMEOUT_MS = 12_000

let requestSeq = 0

/** 一问一答:连 socket → 发一行 JSON → 读一行 JSON → 关。与 vendor daemonCommand 同款线协议。 */
export function askHelper(socketPath: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let buffer = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      fn()
    }
    // 带 code:上层要把"我方等不及了"和"helper 说它截图超时"分开报,不能都归成 unavailable
    const timer = setTimeout(() => finish(() => reject(Object.assign(new Error('timeout'), { code: 'client_timeout' }))), timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: `fv_${++requestSeq}`, ...payload })}\n`))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 16 * 1024 * 1024) {
        finish(() => reject(new Error('helper response too large')))
        return
      }
      const nl = buffer.indexOf('\n')
      if (nl < 0) return
      finish(() => {
        try {
          const parsed = JSON.parse(buffer.slice(0, nl)) as { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } }
          if (parsed.ok === true) resolve(parsed.result)
          else reject(Object.assign(new Error(parsed.error?.message || 'helper error'), { code: parsed.error?.code }))
        } catch (err) {
          reject(err)
        }
      })
    })
    socket.on('error', (err) => finish(() => reject(err)))
    socket.on('close', () => finish(() => reject(new Error('closed'))))
  })
}

export interface LiveViewOptions {
  maxDimension?: number
  quality?: number
  activeWithinMs?: number
  image?: boolean
  /** 上次拿到的 frameSeq。画面没变的话 helper 只回 unchanged,不再重编一遍 JPEG。 */
  sinceFrame?: string
}

/**
 * 请求参数收敛。调用方是**任意已安装插件**,一律当不可信输入夹紧。
 * `activeWithinMs`(最近被操控的窗口还算数多久)的**上界必须封死** —— 放开就等于把一次早已结束的
 * 操控变成对那个窗口的长期取景权,用户回去做私事时还在被截。
 */
export function clampLiveViewOptions(opts: LiveViewOptions): Required<LiveViewOptions> {
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  return {
    maxDimension: Math.max(160, Math.min(2560, Math.trunc(num(opts.maxDimension, 1280)))),
    quality: Math.max(0.2, Math.min(0.95, num(opts.quality, 0.6))),
    activeWithinMs: Math.min(MAX_ACTIVE_WITHIN_MS, Math.max(1_000, Math.trunc(num(opts.activeWithinMs, 120_000)))),
    image: opts.image !== false,
    // 纯回声值,但仍当不可信输入夹紧长度 —— 它会原样进 helper 的请求 JSON
    sinceFrame: typeof opts.sinceFrame === 'string' ? opts.sinceFrame.slice(0, 32) : '',
  }
}

export async function computerUseLiveView(opts: LiveViewOptions = {}): Promise<CuLiveFrame> {
  if (process.platform !== 'darwin') return { active: false, error: 'unsupported_platform' }
  try {
    const result = await askHelper(
      helperSocketPath(),
      { cmd: 'liveView', ...clampLiveViewOptions(opts) },
      // 必须大于 helper 自己的截图上限(ScreenCaptureKit 等 8s 再走 CGWindowList 兜底)。
      // 客户端先超时 = 我们放弃了但 helper 还在截,视图下一轮又发一次 → 捕获叠加。
      HELPER_TIMEOUT_MS,
    )
    return normalizeLiveView(result)
  } catch (err) {
    // socket 不在 = helper 没跑 = 现在没人在操控任何窗口。这是常态,不是错误。
    const code = (err as { code?: string }).code
    if (code === 'ENOENT' || code === 'ECONNREFUSED') return { active: false, error: 'helper_not_running' }
    // 老 helper 不认识 liveView(加这条命令之前装的)——同样如实报,别把它当成"没在操控"。
    if (code === 'unknown_command') return { active: false, error: 'unsupported_helper' }
    return { active: false, error: code || 'unavailable' }
  }
}

// ── 侧边拼接(App Dock)用的两样:长连接 + 按需拉起 helper ─────────────────────────────────────────

/**
 * 一条长开的 helper 连接,逐行一问一答(helper 每条连接一个线程、按行顺序处理,所以回包严格 FIFO)。
 * 贴边面板每 16ms 问一次 dockProbe:每次新建连接 = helper 每秒起 60 个线程,这里只起一个。
 * 断了就让在途的全部失败,下次 request 自动重连。
 */
export class HelperLink {
  private socket: net.Socket | null = null
  private buffer = ''
  private pending: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = []

  constructor(private readonly socketPath: string, private readonly timeoutMs = 3_000) {}

  request(payload: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket ?? this.connect()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(Object.assign(new Error('timeout'), { code: 'client_timeout' })), this.timeoutMs)
      this.pending.push({ resolve, reject, timer })
      socket.write(`${JSON.stringify({ id: `fd_${++requestSeq}`, ...payload })}\n`)
    })
  }

  close(): void { this.fail(new Error('closed')) }

  private connect(): net.Socket {
    const socket = net.createConnection(this.socketPath)
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      if (this.socket !== socket) return
      this.buffer += chunk
      let nl: number
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl)
        this.buffer = this.buffer.slice(nl + 1)
        const head = this.pending.shift()
        if (!head) continue
        clearTimeout(head.timer)
        try {
          const parsed = JSON.parse(line) as { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } }
          if (parsed.ok === true) head.resolve(parsed.result)
          else head.reject(Object.assign(new Error(parsed.error?.message || 'helper error'), { code: parsed.error?.code }))
        } catch (err) { head.reject(err as Error) }
      }
    })
    // 只认当前这条:作废的旧连接晚到的 close 不能把刚建好的新连接一起拆掉。
    socket.on('error', (err) => { if (this.socket === socket) this.fail(err) })
    socket.on('close', () => { if (this.socket === socket) this.fail(new Error('closed')) })
    this.socket = socket
    return socket
  }

  /** 一旦超时或断线,整条连接作废:FIFO 对不上号了,不能拿下一个回包配给错的请求。 */
  private fail(err: Error): void {
    const socket = this.socket
    this.socket = null
    this.buffer = ''
    socket?.destroy()
    for (const p of this.pending.splice(0)) { clearTimeout(p.timer); p.reject(err) }
  }
}

/** helper 装在哪:与 vendor helper-path.mjs 同一规则(env 覆盖 → 可写的 /Applications 里已有 → ~/Applications)。 */
export function helperAppPath(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir(), exists = existsSync, writable = (dir: string): boolean => {
  try { accessSync(dir, fsConstants.W_OK); return true } catch { return false }
}): string {
  const explicit = env.PI_COMPUTER_USE_HELPER_APP_PATH?.trim()
  if (explicit) return path.resolve(explicit)
  const system = '/Applications/tangu-computer-use.app'
  if (exists(system) && writable('/Applications')) return system
  return path.join(homeDir, 'Applications', 'tangu-computer-use.app')
}

/**
 * 确保 helper 在跑(只在用户**主动**要贴边时调用;实时画面那条只读通道依旧绝不拉起它)。
 * 必须 `open -n -g <app> --args serve`:直接 spawn 二进制会把 TCC 的归属记到 Forsion 头上,辅助功能看着像没授权。
 * 没装 → helper_not_installed(装是 CU 工具第一次运行时自己做的,桌面这边不重复一套安装)。
 */
export async function ensureHelperRunning(socketPath = helperSocketPath()): Promise<void> {
  const alive = (): Promise<boolean> => askHelper(socketPath, { cmd: 'diagnostics' }, 1_000).then(() => true, () => false)
  if (await alive()) return
  // dev 指到了自己的 socket(dev-recorder 起的那个),别替它去拉正式 helper —— 拉起来也不在这个 socket 上。
  if (process.env.PI_CU_SOCKET_PATH) throw Object.assign(new Error('helper not running'), { code: 'helper_not_running' })
  const appPath = helperAppPath()
  if (!existsSync(appPath)) throw Object.assign(new Error('helper not installed'), { code: 'helper_not_installed' })
  await new Promise<void>((resolve, reject) => execFile('open', ['-n', '-g', appPath, '--args', 'serve', '--socket', socketPath], (err) => (err ? reject(err) : resolve())))
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200))
    if (await alive()) return
  }
  throw Object.assign(new Error('helper did not start'), { code: 'helper_not_running' })
}
