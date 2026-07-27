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
function askHelper(socketPath: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
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
