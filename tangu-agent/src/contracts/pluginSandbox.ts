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
/** plugin_sandbox_inspect(只看 / 在沙箱里点,不审批)的动作。read 之后的几个(11-03 起)老桌面不认,回 unknown。 */
export const SANDBOX_INSPECT_OPS = ['status', 'screenshot', 'logs', 'command', 'read', 'click', 'type', 'press', 'scroll', 'space', 'files'] as const
/** 会动沙箱界面的那几个:做完等界面落定、截一张,带上这期间插件新写的 console 与弹出的提示。 */
export const SANDBOX_INPUT_OPS = ['click', 'type', 'press', 'scroll', 'space'] as const
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
  // ── 11-03 起(老桌面不报:解析成空值)──
  /** 沙箱自己的智库(桌面本机的绝对路径);插件读写笔记落在这里。 */
  vault: string
  /** 沙箱窗口此刻在哪个 Space。 */
  activeSpace: string | null
  /** 最近弹出的提示(toast),旧的在前。 */
  notices: Array<{ level: string; text: string }>
  /** 正开着的原生对话框(文件选择 / 消息框):它挡着界面,截图里看不见。 */
  dialog: { kind: 'open' | 'save' | 'message'; title: string } | null
  /** 下一个文件对话框已经备好的答案(files 动作):paths = 备了路径,cancel = 会当用户点了取消。 */
  filesArmed: 'paths' | 'cancel' | null
}

/** 动作做完的回执(read / click / type / press / scroll / space / files),挂在桌面回来的 text 的 `action` 键上。 */
export interface SandboxActionReport {
  /** 宿主的话(英文):做了什么。 */
  did: string
  /** 点 / 输入的那个元素在页面上叫什么(插件的字)。 */
  target: string
  /** read:页面大纲,每行一个元素,`[e12]` 是之后 click / type 能用的引用(插件的字)。 */
  outline: string
  /** 动作期间插件新写的 console。 */
  newLogs: Array<{ level: SandboxLogLevel; text: string }>
  /** 动作期间弹出的提示。 */
  newNotices: string[]
}

const LEVELS: readonly SandboxLogLevel[] = ['log', 'info', 'warn', 'error', 'debug']
const STATES: readonly SandboxState[] = ['starting', 'running', 'failed', 'blocked', 'stopped']
export const SANDBOX_LIMITS = { name: 120, dir: 1024, item: 120, list: 40, text: 2000, logs: 40, logText: 500, reason: 400, notices: 8 } as const
/** read 的大纲上限:和状态(≤ SANDBOX_STATUS_BUDGET)一起放进 client_cmd 结果 text 的 48k 帽。 */
export const SANDBOX_OUTLINE_BUDGET = 16_000
const DIALOG_KINDS = ['open', 'save', 'message'] as const
const ARMED = ['paths', 'cancel'] as const
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
    vault: s(o.vault, SANDBOX_LIMITS.dir),
    activeSpace: typeof o.activeSpace === 'string' && o.activeSpace ? s(o.activeSpace, SANDBOX_LIMITS.item) : null,
    notices: Array.isArray(o.notices)
      ? o.notices.slice(-SANDBOX_LIMITS.notices).flatMap((x) => {
        const r = x && typeof x === 'object' ? (x as Record<string, unknown>) : null
        return r && typeof r.text === 'string' ? [{ level: s(r.level, 16) || 'info', text: s(r.text, SANDBOX_LIMITS.logText) }] : []
      })
      : [],
    dialog: dialogOf(o.dialog),
    filesArmed: (ARMED as readonly string[]).includes(o.filesArmed as string) ? (o.filesArmed as SandboxStatus['filesArmed']) : null,
  })
}

function dialogOf(v: unknown): SandboxStatus['dialog'] {
  const r = v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  return r && (DIALOG_KINDS as readonly string[]).includes(r.kind as string) ? { kind: r.kind as 'open' | 'save' | 'message', title: s(r.title, SANDBOX_LIMITS.reason) } : null
}

/** 桌面回来的 text 里 `action` 那一段 → 规整后的回执;没有 / 不像就回 null。 */
export function parseSandboxAction(raw: unknown): SandboxActionReport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.did !== 'string' || !o.did) return null
  const logs = Array.isArray(o.newLogs)
    ? o.newLogs.slice(-SANDBOX_LIMITS.logs).flatMap((x) => {
      const r = x && typeof x === 'object' ? (x as Record<string, unknown>) : null
      return r && typeof r.text === 'string' ? [{ level: LEVELS.includes(r.level as SandboxLogLevel) ? (r.level as SandboxLogLevel) : 'log', text: s(r.text, SANDBOX_LIMITS.logText) }] : []
    })
    : []
  return {
    did: s(o.did, SANDBOX_LIMITS.reason),
    target: s(o.target, SANDBOX_LIMITS.reason),
    outline: s(o.outline, SANDBOX_OUTLINE_BUDGET),
    newLogs: logs,
    newNotices: Array.isArray(o.newNotices) ? o.newNotices.filter((x): x is string => typeof x === 'string').slice(-SANDBOX_LIMITS.notices).map((x) => x.slice(0, SANDBOX_LIMITS.logText)) : [],
  }
}

/** 超预算就轮流丢最早的 console 与最后的挂载报错,还不够再丢别的列表尾巴:截断 JSON 会让整份状态解析不出来,宁可少几条。 */
function fitSandboxStatus(st: SandboxStatus): SandboxStatus {
  const over = (): boolean => embedSandboxStatus(st).length > SANDBOX_STATUS_BUDGET
  // ponytail: 每丢一轮重算一次(O(n²),n ≤ 40),只在超预算时才走到
  while (over() && (st.logs.length || st.mountErrors.length || st.notices.length)) { st.logs.shift(); st.mountErrors.pop(); st.notices.shift() }
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
