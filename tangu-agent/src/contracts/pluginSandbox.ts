/**
 * 插件沙箱(Plugin Sandbox)的线上形状:引擎工具 plugin_sandbox / plugin_sandbox_inspect、桌面渲染层的能力面与卡片、
 * 桌面主进程的沙箱控制器三方共用。契约正典 tangu-agent/docs/plugin-sandbox.md。
 *
 * 通道是 client_cmd(services/clientAck.ts):能力 `plugin.sandbox`,命名空间 `plugin`,只给桌面端(toolRegistry CLIENT_FOR_NS)。
 * 沙箱 = 桌面宿主按需另起的一份 Forsion 进程(独立 userData / 数据目录 / 智库、未登录、不起引擎),只装这一个插件的开发副本。
 *
 * ⚠️ 状态里的文本(插件名、console、报错、视图名)全是**插件自己说的**:进模型上下文前圈成数据区,渲染时只当纯文本。
 */

export const PLUGIN_SANDBOX_CAPABILITY = 'plugin.sandbox'
export const PLUGIN_SANDBOX_NS = 'plugin'

/** plugin_sandbox(起停,要审批)的动作。 */
export const SANDBOX_CONTROL_OPS = ['start', 'stop', 'reset'] as const
/** plugin_sandbox_inspect(只看 / 在沙箱里点,不审批)的动作。 */
export const SANDBOX_INSPECT_OPS = ['status', 'screenshot', 'logs', 'command'] as const
export type SandboxOp = (typeof SANDBOX_CONTROL_OPS)[number] | (typeof SANDBOX_INSPECT_OPS)[number]
export const isSandboxOp = (v: unknown): v is SandboxOp =>
  (SANDBOX_CONTROL_OPS as readonly string[]).includes(v as string) || (SANDBOX_INSPECT_OPS as readonly string[]).includes(v as string)

export type SandboxState = 'starting' | 'running' | 'failed' | 'blocked' | 'stopped'
export type SandboxLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

export interface SandboxStatus {
  v: 1
  state: SandboxState
  pluginId: string
  name: string
  version: string
  /** 插件项目目录(桌面本机的绝对路径)。 */
  dir: string
  /** 这次加载注册的视图 id(不带 `plugin:<id>:` 前缀)。 */
  views: string[]
  /** 插件带的、这次显示出来的 Space(slug)。 */
  spaces: string[]
  /** 插件带的、被宿主跳过的 Space 与原因(英文,给模型)。 */
  hiddenSpaces: Array<{ slug: string; reason: string }>
  setupError: string | null
  /** 宿主拒载的原因(apiVersion / minAppVersion / 清单坏 / 自定义文件类型)。 */
  blocked: string | null
  mountErrors: Array<{ view: string; message: string }>
  /** 这个插件自己的 console(最近若干条)。 */
  logs: Array<{ level: SandboxLogLevel; text: string }>
  warnCount: number
  errorCount: number
  /** 自启动以来加载了几次(保存即重载会累加)。 */
  loads: number
  /** 用户此刻正在用沙箱窗口(它在前台)。窗口平时压在普通窗口之下,看得见不算。 */
  windowVisible: boolean
}

const LEVELS: readonly SandboxLogLevel[] = ['log', 'info', 'warn', 'error', 'debug']
const STATES: readonly SandboxState[] = ['starting', 'running', 'failed', 'blocked', 'stopped']
export const SANDBOX_LIMITS = { name: 120, dir: 1024, item: 120, list: 40, text: 2000, logs: 40, logText: 500, reason: 400 } as const
/** 整份状态(按 embedSandboxStatus 的转义后长度算)的上限:要在 client_cmd 结果 text 的 48k 帽、和工具结果的 48k 帽里都放得下。 */
export const SANDBOX_STATUS_BUDGET = 24_000

const s = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x).slice(0, SANDBOX_LIMITS.list).map((x) => x.slice(0, SANDBOX_LIMITS.item)) : []

/** 来自桌面(经网关,不可信)的状态 → 规整后的形状;不像状态就回 null。引擎与卡片都过这一道。 */
export function parseSandboxStatus(raw: unknown): SandboxStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.v !== 1 || !STATES.includes(o.state as SandboxState)) return null
  const pluginId = s(o.pluginId, 64)
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(pluginId)) return null
  const pairs = <K extends string, L extends string>(v: unknown, a: K, b: L, max: number): Array<Record<K | L, string>> =>
    Array.isArray(v)
      ? v.slice(0, SANDBOX_LIMITS.list).flatMap((x) => {
        const r = x && typeof x === 'object' ? (x as Record<string, unknown>) : null
        return r && typeof r[a] === 'string' ? [{ [a]: s(r[a], SANDBOX_LIMITS.item), [b]: s(r[b], max) } as Record<K | L, string>] : []
      })
      : []
  const logs = Array.isArray(o.logs)
    ? o.logs.slice(-SANDBOX_LIMITS.logs).flatMap((x) => {
      const r = x && typeof x === 'object' ? (x as Record<string, unknown>) : null
      return r && typeof r.text === 'string'
        ? [{ level: LEVELS.includes(r.level as SandboxLogLevel) ? (r.level as SandboxLogLevel) : 'log', text: s(r.text, SANDBOX_LIMITS.logText) }]
        : []
    })
    : []
  return fitSandboxStatus({
    v: 1,
    state: o.state as SandboxState,
    pluginId,
    name: s(o.name, SANDBOX_LIMITS.name) || pluginId,
    version: s(o.version, 40),
    dir: s(o.dir, SANDBOX_LIMITS.dir),
    views: strs(o.views),
    spaces: strs(o.spaces),
    hiddenSpaces: pairs(o.hiddenSpaces, 'slug', 'reason', SANDBOX_LIMITS.reason),
    setupError: typeof o.setupError === 'string' && o.setupError ? s(o.setupError, SANDBOX_LIMITS.text) : null,
    blocked: typeof o.blocked === 'string' && o.blocked ? s(o.blocked, SANDBOX_LIMITS.reason) : null,
    mountErrors: pairs(o.mountErrors, 'view', 'message', SANDBOX_LIMITS.text),
    logs,
    warnCount: n(o.warnCount),
    errorCount: n(o.errorCount),
    loads: n(o.loads),
    windowVisible: o.windowVisible === true,
  })
}

/** 超预算就轮流丢最早的 console 与最后的挂载报错,还不够再丢别的列表尾巴:截断 JSON 会让整份状态解析不出来,宁可少几条。 */
function fitSandboxStatus(st: SandboxStatus): SandboxStatus {
  const over = (): boolean => embedSandboxStatus(st).length > SANDBOX_STATUS_BUDGET
  // ponytail: 每丢一轮重算一次(O(n²),n ≤ 40),只在超预算时才走到
  while (over() && (st.logs.length || st.mountErrors.length)) { st.logs.shift(); st.mountErrors.pop() }
  for (const list of [st.hiddenSpaces, st.views, st.spaces] as unknown[][]) while (over() && list.length) list.pop()
  return st
}

/** 工具结果末尾挂一份状态,卡片据此重画历史(实时状态另向桌面要)。标签名不能出现在插件文本里:文本先换掉尖括号。 */
const TAG = 'sandbox-status'
export function embedSandboxStatus(status: SandboxStatus): string {
  return `<${TAG}>${JSON.stringify(status).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}</${TAG}>`
}
export function extractSandboxStatus(result: string | undefined): SandboxStatus | null {
  if (!result) return null
  const m = result.match(new RegExp(`<${TAG}>([\\s\\S]*?)</${TAG}>\\s*$`))
  if (!m) return null
  try { return parseSandboxStatus(JSON.parse(m[1])) } catch { return null }
}
