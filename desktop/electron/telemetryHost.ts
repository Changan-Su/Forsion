/**
 * 匿名遥测「帮助改进 Forsion」的宿主那一半(契约 docs/ToBeImproved/默认数据采集方案_2026-10-28/contract.md §3)。
 * 宿主只**采集、整形、转发**:事件经 CloudHost.telemetry 交给 Forsion Extend 的主进程半身,发不发、开没开、排队与上传全归 Extend。
 * 宿主自己不落盘、不联网;没有订阅者(Extend 没装 / 老 Extend)时最多先攒 50 条,等首个订阅者来一次性回放,之后不再攒。
 *
 * 本文件不 import electron:main.ts 负责把 app / BackendManager / ipcMain 的事件接进来,这里只有纯整形与缓冲,单测直接跑。
 * 字段名与取值范围按白名单 telemetry-schema.json;报错原文照传(Extend 先 sanitize 再截到白名单的 max),这里只封顶长度,
 * 免得无界的字符串跨 IPC / 进内存。
 */

import { isSourceCardId } from '../shared/storeSources'
import type { CloudHost, HostTelemetryEvent } from './cloudHost'
import {
  COMMAND_SOURCES, LIFECYCLE_REASONS, MODEL_COUNT_KEYS, QUOTA_PROMPT_ACTIONS, QUOTA_PROMPT_ENTRIES, classifyUpdateError, isAppCountKey, providerKindOf, runErrorClass,
  settingChange, type AppCountKey, type ModelCountKey, type QuotaPromptAction, type QuotaPromptEntry,
} from '../shared/telemetryKeys'

export type { HostTelemetryEvent }
/** CloudHost.telemetry 接缝本身(声明在 cloudHost.ts,Extend host.d.ts 镜像那一份)。 */
export type HostTelemetry = NonNullable<CloudHost['telemetry']>
type HostEventName = HostTelemetryEvent['event']

export { RENDERER_REPORT_KINDS, type RendererReportKind } from '../shared/telemetryKeys'

export const BUFFER_CAP = 50
/** 跨 IPC 的原文封顶(Extend 再按白名单截到 300 / 4000)。 */
export const STACK_CAP = 8000
/** 汇总事件(perf / app_counts / command_use / quota_prompt / model_feedback)本身按小时攒成一条(一组),不设上限,组数另有封顶;
 *  其余每小时每类的上限:渲染层报错死循环 / 来回切 View 不能把队列灌满。超出的直接丢。 */
type AggregateEvent = 'perf' | 'app_counts' | 'command_use' | 'quota_prompt' | 'model_feedback'
type CappedEvent = Exclude<HostEventName, AggregateEvent>
const AGGREGATE_EVENTS: ReadonlySet<string> = new Set<AggregateEvent>(['perf', 'app_counts', 'command_use', 'quota_prompt', 'model_feedback'])
export const HOURLY_CAP: Record<CappedEvent, number> = {
  crash: 60, feature: 600, plugin_install: 120, plugin_deps: 60, plugin_lifecycle: 200, plugin_load: 200, update: 60, onboarding: 10, guide_tip: 60,
  // v3:插件清单一天一份、一份最多 INVENTORY_CAP 条(单列上限,不和别的事件抢);首次运行一台一次
  plugin_inventory: 160, first_run: 5,
}
/** 一份插件清单最多展开成多少条事件(契约 §19:≤ 150);超出的截掉并在本机日志记一笔。 */
export const INVENTORY_CAP = 150
/** 一小时里最多攒多少个不同的模型(model_feedback):超出的新模型这一小时不记。 */
export const MODEL_PAIR_CAP = 100
/** 模型 id 交给 Extend 之前的形状封顶(公开化在 Extend:托管 / Codex 原样,自带 key 与本地只留最后一段模型名)。 */
const MODEL_ID_MAX = 160
/** 一小时里最多攒多少个不同的 (命令 id, 来源):超出的新组合这一小时不记(已记下的照常累加)。 */
export const COMMAND_PAIR_CAP = 300
/** 渲染层一次 count 最多加多少(成就 track 可以一次加 n)。 */
const COUNT_STEP_MAX = 1000
const INT_MAX = 2147483647
/** 白名单 id 类型:^[A-Za-z0-9._:/@+-]{1,max}$。 */
const ID_RE = /^[A-Za-z0-9._:/@+-]+$/
/** 能原样发的插件 id:内置插件 id、商店条目 id(UUID)、market-<UUID> 目录名都是 kebab 小写。 */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/
/** 命令 id:内置命令是静态的 kebab / 点分串;插件命令由渲染层换成 amadeus:<公开插件 id>:<命令> 或 plugin:local。 */
const COMMAND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
/** 插件清单里提示的 id(shared/amadeus/ipc.ts 的 TIP_ID)。 */
/** count 的去重 id(工具调用 id 等):短、无空白。 */
const ONCE_RE = /^[A-Za-z0-9_.:-]{1,128}$/
/** 主进程记住的去重 id 个数(先进先出):一条运行在几个窗口里 / 重连时整段回放,都在同一个进程里判。 */
export const ONCE_CAP = 5000
const TIP_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/

const PROCESS_REASONS = ['crashed', 'oom', 'killed', 'abnormal-exit', 'launch-failed', 'integrity-failure'] as const

/** 合白名单的短 id;不合格返回 undefined。 */
export function safeId(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max && ID_RE.test(v) ? v : undefined
}
const int = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= INT_MAX ? v : undefined
const cap = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v ? v.slice(0, max) : undefined)
/** 调用栈只留「    at …」帧:V8 的栈头是 `名字: 报错原文`(可能多行),原文不交给 Extend(Extend 那边同样再剥一遍)。 */
const frames = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined
  const i = v.search(/^\s+at /m)
  return i < 0 ? undefined : cap(v.slice(i), max)
}
/** 错误名(TypeError / AbortError …):挑出合法字符再截 60;剩不下就不带。 */
function errorName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.replace(/\s+/g, '-').replace(/[^A-Za-z0-9._:/@+-]/g, '').slice(0, 60)
  return s || undefined
}
const compact = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | undefined => (typeof v === 'string' && (values as readonly string[]).includes(v) ? v as T : undefined)
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

/**
 * 插件 id 能不能原样发(契约 §9):渲染层先按插件记录换好 —— 商店装的(market-<UUID> 目录或作者自起名的老条目)换成**商店条目 id**,
 * 内置 / 预装的给插件 id,开发副本 / 沙箱 / 本地路径给 local —— 并带 official = true。这里再核一遍:official 必须是 true 本身、
 * 形状必须是 kebab 小写短串(商店条目 id 是 UUID 也合),否则一律 `local` —— 用户自己的插件名本身就可能是隐私。
 */
export function publicPluginId(id: unknown, official: unknown, max = 80): string {
  return official === true && typeof id === 'string' && id.length <= max && PLUGIN_ID_RE.test(id) && !isSourceCardId(id) ? id : 'local'
}

/** Electron render-process-gone / child-process-gone 的 reason → 白名单 reason。clean-exit 不算崩溃,返回 null。 */
export function goneReason(reason: unknown): string | null {
  if (reason === 'clean-exit') return null
  return (PROCESS_REASONS as readonly unknown[]).includes(reason) ? String(reason) : 'other'
}

/** 一个 Error(或随便什么 throw 出来的东西)→ crash props。 */
export function crashFromError(proc: string, reason: 'exception' | 'rejection', err: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  // 报错原文不转发(里面什么都可能有:库内路径、笔记标题);只给错误名 + 调用栈,栈头那几行原文由 Extend 剥掉
  const e = err as { name?: unknown; stack?: unknown } | null
  const isObj = !!e && typeof e === 'object'
  return compact({
    process: proc,
    reason,
    errorName: errorName(isObj ? e!.name : typeof err),
    stack: frames(isObj ? e!.stack : undefined, STACK_CAP),
    ...extra,
  })
}

/**
 * Windows 结束会话(关机 / 重启 / 注销)时,系统把没及时退出的进程一起强杀,退出码是 0x40010004(DBG_TERMINATE_PROCESS)。
 * 那不是崩溃:11-20 查生产遥测,21 次 crash 里 12 次是它,每一次都是所在那次运行的最后一条事件(主进程也跟着没了)。
 * Electron 42+ 才在会话结束时自己先退(electron#52604),本仓的 40 还会撞上。
 */
export const WIN_SESSION_END_EXIT = 0x40010004
export const killedBySessionEnd = (code: unknown, platform: string = process.platform): boolean =>
  platform === 'win32' && typeof code === 'number' && (code >>> 0) === WIN_SESSION_END_EXIT
/** 退出码超出白名单 int 时(Windows NTSTATUS 0xC0000005 …,Electron 给的还常是负数)换成十六进制串。 */
const hexCode = (code: unknown): string | undefined =>
  typeof code === 'number' && Number.isInteger(code) && int(code) === undefined ? `0x${(code >>> 0).toString(16).toUpperCase()}` : undefined

/** 引擎进程意外退出 → crash props;Windows 结束会话被强杀的不算,返回 null。Windows 的 NTSTATUS 超出 int,改记进 errorName。 */
export function engineExitProps(code: number | null, signal: string | null, uptimeS?: number, platform: string = process.platform): Record<string, unknown> | null {
  if (killedBySessionEnd(code, platform)) return null
  const exitCode = int(code)
  const fatal = /^SIG(SEGV|BUS|ABRT|ILL|FPE)$/.test(signal ?? '')
  return compact({
    process: 'engine',
    reason: signal ? (fatal ? 'crashed' : signal === 'SIGKILL' || signal === 'SIGTERM' ? 'killed' : 'abnormal-exit') : 'abnormal-exit',
    exitCode,
    errorName: signal ? errorName(signal) : hexCode(code),
    uptimeS: int(uptimeS),
  })
}

/**
 * 渲染进程 / 子进程没了 → crash props(clean-exit、Windows 结束会话被强杀的返回 null)。child-process-gone 的类型(GPU / Utility …)
 * 记进 errorName;退出码超出 int 的(Windows 崩溃码)也进 errorName:渲染进程就是那串码,子进程是「类型:码」。
 */
export function processGoneProps(proc: 'renderer' | 'other', details: { reason?: unknown; exitCode?: unknown; type?: unknown }, uptimeS?: number, platform: string = process.platform): Record<string, unknown> | null {
  const reason = goneReason(details.reason)
  if (!reason || killedBySessionEnd(details.exitCode, platform)) return null
  const hex = hexCode(details.exitCode)
  const type = errorName(details.type)
  return compact({ process: proc, reason, exitCode: int(details.exitCode), errorName: type && hex ? errorName(`${type}:${hex}`) : type ?? hex, uptimeS: int(uptimeS) })
}

// ── update(契约 §9):安装包、引擎 npm 热更新、界面热更新退回、内置插件 npm 更新、首启预取。报错原文只拿来归类,不转发 ──
export type UpdateTarget = 'app' | 'engine' | 'ui' | 'builtin-plugin' | 'store-plugin' | 'first-boot-prefetch'
/** 内置插件的 id 也走插件 id 的形状;引擎那条不带 id。 */
export function updateProps(target: UpdateTarget, outcome: string, o: { id?: string; error?: unknown } = {}): Record<string, unknown> {
  return compact({
    target,
    // 商店来源(第三方目录)装的不报条目 id:那是第三方的名字,只记得到「哪一类」。
    id: o.id !== undefined && PLUGIN_ID_RE.test(o.id) && !isSourceCardId(o.id) ? o.id : undefined,
    outcome,
    errorClass: outcome === 'error' ? classifyUpdateError(o.error) : undefined,
  })
}
/**
 * 商店插件更新器(marketPluginUpdates)每次广播的整份状态 → update{ target: 'store-plugin' } 与设置改动 plugins.autoUpdate。
 * 第一次广播只记基线(启动时读回来的不算);之后某一项的阶段变了才报:检查完没新版(checking → current)/ 新版下好待换(→ staged)/ 出错(→ error)。
 * 用户点的回退(pendingRollback)不算更新;id 是商店条目 id(公开的)。报错原文只拿来归类。
 */
export function storeUpdateTelemetry(report: { update: (props: Record<string, unknown>) => void; setting: (key: string, value: unknown) => void }) {
  let autoAll: boolean | null = null
  const phases = new Map<string, string>()
  return (st: unknown): void => {
    try {
      const s = st as { autoUpdateAll?: unknown; items?: unknown } | null
      if (!s || typeof s !== 'object') return
      if (typeof s.autoUpdateAll === 'boolean') {
        if (autoAll !== null && s.autoUpdateAll !== autoAll) report.setting('plugins.autoUpdate', s.autoUpdateAll)
        autoAll = s.autoUpdateAll
      }
      for (const x of Array.isArray(s.items) ? s.items as Array<{ id?: unknown; phase?: unknown; error?: unknown; pendingRollback?: unknown }> : []) {
        if (typeof x?.id !== 'string' || typeof x.phase !== 'string') continue
        const prev = phases.get(x.id)
        phases.set(x.id, x.phase)
        if (prev === undefined || prev === x.phase || x.pendingRollback) continue
        const outcome = x.phase === 'staged' ? 'staged' : x.phase === 'error' ? 'error' : x.phase === 'current' && prev === 'checking' ? 'current' : null
        if (outcome) report.update(updateProps('store-plugin', outcome, { id: x.id, error: x.error }))
      }
    } catch { /* 遥测不影响更新器 */ }
  }
}
/** 引擎 / 内置插件那一路(shared/corePlugins 的 CorePluginUpdate)的状态 → update props;中间态(checking / downloading)与 dev 不报。 */
export function coreUpdateProps(st: { id: string; phase: string; error?: string }, engineId: string): Record<string, unknown> | null {
  const outcome = st.phase === 'current' ? 'current' : st.phase === 'staged' ? 'staged' : st.phase === 'incompatible' ? 'incompatible' : st.phase === 'error' ? 'error' : null
  if (!outcome) return null
  return st.id === engineId ? updateProps('engine', outcome, { error: st.error }) : updateProps('builtin-plugin', outcome, { id: st.id, error: st.error })
}
/** 安装包更新器(updater.ts)的阶段 → update props:只报有结论的几步。 */
export function appUpdateProps(st: { phase: string; error?: string }): Record<string, unknown> | null {
  const outcome = st.phase === 'available' ? 'available' : st.phase === 'not-available' ? 'not-available' : st.phase === 'downloaded' ? 'staged' : st.phase === 'error' ? 'error' : null
  return outcome ? updateProps('app', outcome, { error: st.error }) : null
}

const INSTALL_ENTRIES = ['store', 'chat-card', 'muse-card', 'plugin-onboarding', 'deps', 'other'] as const
const INSTALL_KINDS = ['plugin', 'skill', 'agent', 'space', 'theme', 'amadeus-plugin', 'other'] as const
const INSTALL_SOURCES = ['github', 'npm', 'zip', 'other'] as const
const INSTALL_STAGES = ['resolve', 'download', 'install', 'activate', 'done'] as const
const INSTALL_ERRORS = ['timeout', 'network', 'http', 'too-large', 'not-zip', 'integrity', 'identity', 'version', 'min-app', 'platform', 'deps', 'builtin', 'activate', 'disk', 'other'] as const
const BLOCKED_REASONS = ['min-app', 'api', 'invalid', 'dev-fileext', 'deps', 'other'] as const
const ONBOARDING_BOOLS = ['signedIn', 'syncNotes', 'syncAgents', 'syncPlugins', 'addedAgent', 'museOn', 'computerHistoryOn', 'youWritten'] as const
const ONBOARDING_INTS = ['screens', 'backJumps', 'msStart', 'msTheme', 'msYou', 'msTeam', 'msWelcome'] as const

/** 渲染层报来的插件引用(pluginId + pluginOfficial,渲染层已按 §9 换成商店条目 id / 内置 id)→ 能发的 id。 */
const pluginRef = (p: Record<string, unknown>, max = 80): string => publicPluginId(p.pluginId, p.pluginOfficial, max)

export type ShapedReport =
  | { event: Exclude<HostEventName, AggregateEvent | 'update' | 'plugin_inventory'>; props: Record<string, unknown> }
  | { longTasks: number }
  | { count: AppCountKey; n: number; once?: string }
  | { command: { id: string; source: string } }
  | { quotaPrompt: { entry: QuotaPromptEntry; action: QuotaPromptAction } }
  | { modelCount: { key: ModelCountKey; modelId: string; providerKind: string } }
  | { inventory: Array<Record<string, unknown>>; truncated: number }

/**
 * 渲染层报上来的一条 → 契约形状。返回:
 *  - `{ event, props }`:要转发的事件;
 *  - `{ longTasks }`:长任务计数,由宿主攒进本小时的 perf;
 *  - `{ count, n }` / `{ command }`:计数,由宿主按小时攒成 app_counts / command_use;
 *  - `null`:种类不对 / 形状不对,丢掉。
 * 渲染层是受信的(isTrustedSender 先挡过),这里防的是无界输入和 id 外泄,不防恶意。每个字段按白名单的类型过,多出来的字段一律不带。
 */
export function shapeRendererReport(kind: unknown, raw: unknown): ShapedReport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const p = raw as Record<string, unknown>
  switch (kind) {
    case 'longtasks': {
      const n = int(p.count)
      return n ? { longTasks: n } : null
    }
    case 'crash': {
      const reason = p.reason === 'rejection' ? 'rejection' : 'exception'
      const props = compact({
        process: 'renderer',
        reason,
        errorName: errorName(p.errorName),
        stack: frames(p.stack, STACK_CAP), // 报错原文不转发,同 crashFromError
        // 插件宿主分得出是哪个插件时才带;同样只给内置 / 商店的 id
        pluginId: p.pluginId === undefined ? undefined : pluginRef(p, 64),
      })
      return props.stack || props.errorName ? { event: 'crash', props } : null
    }
    case 'feature': return shapeFeature(p)
    case 'setting': {
      // 设置改动:键不在契约 §9 的表里、值归不了档,整条丢
      const c = settingChange(p.key, p.value)
      return c ? { event: 'feature', props: { name: 'setting_change', key: c.key, value: c.value } } : null
    }
    case 'count': {
      if (!isAppCountKey(p.key)) return null
      const n = p.n === undefined ? 1 : int(p.n)
      // once = 引擎事件自己的 id(工具调用 id):只在主进程里去重用,不转发
      const once = typeof p.once === 'string' && ONCE_RE.test(p.once) ? `${p.key}\n${p.once}` : undefined
      return n ? { count: p.key, n: Math.min(n, COUNT_STEP_MAX), ...(once ? { once } : {}) } : null
    }
    case 'command': {
      const id = typeof p.id === 'string' && COMMAND_ID_RE.test(p.id) && !looksLikeSecret(p.id) ? p.id : undefined
      return id ? { command: { id, source: oneOf(p.source, COMMAND_SOURCES) ?? 'other' } } : null
    }
    case 'plugin_install': {
      const outcome = oneOf(p.outcome, ['done', 'error', 'canceled'] as const)
      if (!outcome || p.pluginId === undefined) return null
      return {
        event: 'plugin_install',
        props: compact({
          id: pluginRef(p),
          entry: oneOf(p.entry, INSTALL_ENTRIES) ?? 'other',
          kind: oneOf(p.kind, INSTALL_KINDS) ?? 'other',
          source: oneOf(p.source, INSTALL_SOURCES) ?? 'other',
          stage: oneOf(p.stage, INSTALL_STAGES),
          outcome,
          errorClass: outcome === 'error' ? oneOf(p.errorClass, INSTALL_ERRORS) ?? 'other' : undefined,
          durationMs: int(p.durationMs),
          sizeKb: int(p.sizeKb),
          restart: bool(p.restart),
        }),
      }
    }
    case 'plugin_deps': {
      const outcome = oneOf(p.outcome, ['ready', 'not-ready', 'not-running', 'failed'] as const)
      return outcome ? { event: 'plugin_deps', props: compact({ total: int(p.total), installed: int(p.installed), failedAt: int(p.failedAt), outcome }) } : null
    }
    case 'plugin_lifecycle': {
      const action = oneOf(p.action, ['uninstall', 'enable', 'disable', 'blocked'] as const)
      if (!action || p.pluginId === undefined) return null
      return {
        event: 'plugin_lifecycle',
        props: compact({
          id: pluginRef(p),
          action,
          blockedReason: action === 'blocked' ? oneOf(p.blockedReason, BLOCKED_REASONS) ?? 'other' : undefined,
          daysSinceInstall: int(p.daysSinceInstall),
          // v3:卸载 / 停用时用户选的理由(可跳过);别的动作不带
          reason: action === 'uninstall' || action === 'disable' ? oneOf(p.reason, LIFECYCLE_REASONS) : undefined,
        }),
      }
    }
    case 'plugin_load': {
      const outcome = oneOf(p.outcome, ['ok', 'error'] as const)
      if (!outcome || p.pluginId === undefined) return null
      return { event: 'plugin_load', props: compact({ id: pluginRef(p), outcome, activateMs: int(p.activateMs) }) }
    }
    case 'onboarding': {
      const outcome = oneOf(p.outcome, ['finish', 'skip', 'error-skip'] as const)
      const mode = oneOf(p.mode, ['full', 'returning', 'brief', 'update'] as const)
      if (!outcome || !mode) return null
      const props: Record<string, unknown> = { mode, outcome }
      for (const k of ONBOARDING_INTS) props[k] = int(p[k])
      for (const k of ONBOARDING_BOOLS) props[k] = bool(p[k])
      return { event: 'onboarding', props: compact(props) }
    }
    case 'guide_tip': {
      // 只发公开插件(内置 / 商店)的提示:侧载插件的提示 id 是作者私起的
      const pluginId = pluginRef(p)
      const tipId = typeof p.tipId === 'string' && TIP_ID_RE.test(p.tipId) ? p.tipId : undefined
      const result = oneOf(p.result, ['ok', 'learned', 'mute', 'gone', 'missing', 'replaced', 'closed'] as const)
      return pluginId !== 'local' && tipId && result ? { event: 'guide_tip', props: { pluginId, tipId, result } } : null
    }
    case 'quotaPrompt': {
      // 额度提示的露出 / 动作(契约 §19):不带提示文案、不带额度数值,只有入口 × 动作;主进程按小时按入口攒成 quota_prompt
      const entry = oneOf(p.entry, QUOTA_PROMPT_ENTRIES)
      const action = oneOf(p.action, QUOTA_PROMPT_ACTIONS)
      return entry && action ? { quotaPrompt: { entry, action } } : null
    }
    case 'modelCount': {
      // 重新生成 / 停止 / 改了再发 × 模型(契约 §19):模型 id 原样交给 Extend,由它公开化(publicModelId);来源类别在这里按 id 算
      const key = oneOf(p.key, MODEL_COUNT_KEYS)
      const modelId = safeId(p.modelId, MODEL_ID_MAX)
      return key && modelId ? { modelCount: { key, modelId, providerKind: providerKindOf(modelId) } } : null
    }
    case 'pluginInventory': return shapeInventory(p)
    case 'firstRun': {
      // 首次运行的结果(契约 §19):报错原文只拿来归类,不转发
      const outcome = oneOf(p.outcome, ['done', 'error', 'aborted'] as const)
      if (!outcome) return null
      return {
        event: 'first_run',
        props: compact({
          outcome,
          errorClass: outcome === 'done' ? undefined : runErrorClass(typeof p.error === 'string' ? p.error.slice(0, 2000) : '', outcome === 'aborted'),
          sinceFirstLaunchS: int(p.sinceFirstLaunchS),
          durationMs: int(p.durationMs),
        }),
      }
    }
    default: return null
  }
}

/**
 * 插件清单(契约 §19 plugin_inventory):渲染层给 `{ plugins: [{ pluginId, pluginOfficial, source, enabled }], localCount }`,
 * id 已按 telemetryPluginRef 换好;这里再按 publicPluginId 核一遍 —— 核不过的(侧载 / 开发副本 / 形状不对)并进 local 计数,id 不发。
 * 同一个 id 出现两次(内置包的 Forsion 插件 + 它带的引擎插件)合成一条,开着取「有一处开着」。day 由宿主按 UTC 填。
 */
function shapeInventory(p: Record<string, unknown>): ShapedReport | null {
  if (!Array.isArray(p.plugins)) return null
  const byId = new Map<string, { source: 'store' | 'builtin'; enabled: boolean }>()
  let local = int(p.localCount) ?? 0
  for (const raw of p.plugins as unknown[]) {
    if (!raw || typeof raw !== 'object') continue
    const x = raw as Record<string, unknown>
    const id = publicPluginId(x.pluginId, x.pluginOfficial)
    const source = oneOf(x.source, ['store', 'builtin'] as const)
    if (id === 'local' || !source) { local++; continue }
    const prev = byId.get(id)
    byId.set(id, { source: prev?.source ?? source, enabled: !!prev?.enabled || x.enabled === true })
  }
  const items: Array<Record<string, unknown>> = [...byId].map(([id, v]) => ({ id, source: v.source, installed: 1, enabled: v.enabled ? 1 : 0 }))
  if (local > 0) items.unshift({ id: 'local', source: 'local', localCount: Math.min(local, INT_MAX) }) // 排最前:截断时不丢本地插件的个数
  if (!items.length) return null
  const truncated = Math.max(0, items.length - INVENTORY_CAP)
  return { inventory: items.slice(0, INVENTORY_CAP), truncated }
}

/** 长得像密钥 / 一长串十六进制的 id 不收(Extend 与 server 照样会丢,这里先挡,免得占掉每小时的配额)。 */
function looksLikeSecret(v: string): boolean {
  return /[0-9a-f]{32,}/i.test(v) || /[A-Za-z0-9_-]{40,}/.test(v) || /sk-[A-Za-z0-9_-]{10,}/.test(v)
}

function shapeFeature(p: Record<string, unknown>): ShapedReport | null {
  if (p.name === 'space_open') {
    // origin 由渲染层判(内置 / 插件 / 用户自建 Space 的账只有它有):用户自建的连 id 都不发
    if (p.origin === 'user') return { event: 'feature', props: { name: 'space_open', kind: 'custom' } }
    if (p.origin === 'plugin') return { event: 'feature', props: { name: 'space_open', kind: 'plugin', id: pluginRef(p) } }
    if (p.origin === 'builtin') {
      const space = safeId(p.space, 60)
      return space ? { event: 'feature', props: { name: 'space_open', kind: space } } : null
    }
    return null
  }
  if (p.name === 'view_open') {
    const view = safeId(p.view, 60)
    if (!view) return null
    // 插件视图的类型是 plugin:<插件 id>:<视图 id>,原样发就漏了侧栏插件的 id:只记 plugin,插件本身走 plugin_open
    return { event: 'feature', props: { name: 'view_open', kind: view.startsWith('plugin:') ? 'plugin' : view } }
  }
  if (p.name === 'plugin_open') {
    if (p.pluginId === undefined) return null
    return { event: 'feature', props: { name: 'plugin_open', id: pluginRef(p) } }
  }
  return null // setting_change 走 setting 种类(值要先归档)
}

/** FORSION_TELEMETRY:force 让 dev / 台架也算正式版(本机联调);off 永远不算;其余只认「打包版且不是台架 / 插件沙箱」。 */
export function telemetryPackaged(o: { isPackaged: boolean; harness: boolean; sandbox: boolean; env: string | undefined }): boolean {
  if (o.env === 'force') return true
  if (o.env === 'off') return false
  return o.isPackaged && !o.harness && !o.sandbox
}

export interface TelemetryHostOptions {
  packaged: boolean
  sessionId: string
  channel: () => 'stable' | 'beta'
  coreVersion: () => string | null
  now?: () => number
  log?: (m: string) => void
  /** 台架用的旁路:每条过了上限、要交给 Extend 的事件(含还在缓冲里的)抄一份,不占订阅、不吃启动缓冲。
   *  main.ts 只在设了 FORSION_TELEMETRY_TRACE 时接上(e2e:telemetry 用它在宿主 → Extend 这一侧断言)。 */
  tap?: (ev: HostTelemetryEvent) => void
}

export function createTelemetryHost(o: TelemetryHostOptions) {
  const now = o.now ?? Date.now
  const subscribers = new Set<(ev: HostTelemetryEvent) => void>()
  let buffer: HostTelemetryEvent[] | null = []
  let longTasks = 0
  const sent: Partial<Record<CappedEvent, number>> = {}
  /** 本小时的 app_counts 增量(只有非零的键)。 */
  let counts = new Map<AppCountKey, number>()
  /** 本小时的命令使用:`<来源>\n<id>` → 次数。 */
  let commands = new Map<string, number>()
  /** 本小时的额度提示:入口 → { 动作 → 次数 }(v3 quota_prompt)。 */
  let quotaPrompts = new Map<QuotaPromptEntry, Partial<Record<QuotaPromptAction, number>>>()
  /** 本小时按模型的计数:`<来源类别>\n<模型 id>` → { regenerate / stop / editResend → 次数 }(v3 model_feedback)。 */
  let modelCounts = new Map<string, Partial<Record<ModelCountKey, number>>>()
  /** 插件清单这次启动已经交出的 UTC 日(渲染层按天记,这里再挡一道:多个窗口 / 重载各报一次也只交一份)。 */
  let inventoryDay: string | null = null
  /** 首次运行一个进程只交一次(渲染层另在本机记已发)。 */
  let firstRunSent = false
  /** plugin_load 同一插件同一次启动只报一次;被挡下的(blocked)同一插件同一原因也只报一次。local 不去重(分不出是哪个)。 */
  const loadedOnce = new Set<string>()
  /** 引擎事件派生的计数已经数过的事件 id(见 ONCE_CAP)。 */
  const countedOnce = new Set<string>()
  const blockedOnce = new Set<string>()

  const deliver = (ev: HostTelemetryEvent): void => {
    for (const cb of subscribers) {
      try { cb(ev) } catch (e) { o.log?.(`[telemetry] subscriber threw: ${(e as Error)?.message || e}`) }
    }
  }
  const emit = (event: HostEventName, props: Record<string, unknown>): void => {
    if (!AGGREGATE_EVENTS.has(event)) {
      const k = event as CappedEvent
      const n = sent[k] ?? 0
      if (n >= HOURLY_CAP[k]) return
      sent[k] = n + 1
    }
    const ev: HostTelemetryEvent = { event, ts: new Date(now()).toISOString(), props }
    if (o.tap) try { o.tap(ev) } catch { /* 旁路出错不影响上报 */ }
    if (buffer) { if (buffer.length < BUFFER_CAP) buffer.push(ev); return } // 留最早的:启动耗时 / 启动期崩溃最要紧
    deliver(ev)
  }
  const bump = <K extends string>(rec: Partial<Record<K, number>>, k: K): void => { rec[k] = Math.min(INT_MAX, (rec[k] ?? 0) + 1) }
  const count = (key: AppCountKey, n = 1): void => {
    counts.set(key, Math.min(INT_MAX, (counts.get(key) ?? 0) + n))
  }
  const command = (id: string, source: string): void => {
    const k = `${source}\n${id}`
    const cur = commands.get(k)
    if (cur === undefined && commands.size >= COMMAND_PAIR_CAP) return
    commands.set(k, Math.min(INT_MAX, (cur ?? 0) + 1))
  }

  const seam: HostTelemetry = {
    subscribe(cb) {
      subscribers.add(cb)
      if (buffer) {
        const replay = buffer
        buffer = null
        for (const ev of replay) {
          try { cb(ev) } catch (e) { o.log?.(`[telemetry] subscriber threw: ${(e as Error)?.message || e}`) }
        }
      }
      return () => { subscribers.delete(cb) }
    },
    sessionId: o.sessionId,
    packaged: o.packaged,
    channel: () => o.channel(),
    coreVersion: () => o.coreVersion(),
  }

  return {
    seam,
    emit,
    /** 主进程自己的计数(订阅登录、自带 key 增删等落在 IPC 里的);和渲染层报的 count 攒在一起。 */
    count(key: AppCountKey, n = 1): void { if (isAppCountKey(key) && Number.isInteger(n) && n > 0) count(key, Math.min(n, COUNT_STEP_MAX)) },
    /** 主进程这边的设置改动(电脑历史开关、更新通道):同渲染层 setting 一样只收契约表里的键、值先归档。 */
    setting(key: string, value: unknown): void {
      const c = settingChange(key, value)
      if (c) emit('feature', { name: 'setting_change', key: c.key, value: c.value })
    },
    /** preload telemetryReport 的落点(调用方先过 isTrustedSender)。 */
    report(kind: unknown, props: unknown): void {
      const shaped = shapeRendererReport(kind, props)
      if (!shaped) return
      if ('longTasks' in shaped) { longTasks = Math.min(INT_MAX, longTasks + shaped.longTasks); return }
      if ('count' in shaped) {
        if (shaped.once) {
          if (countedOnce.has(shaped.once)) return
          countedOnce.add(shaped.once)
          if (countedOnce.size > ONCE_CAP) countedOnce.delete(countedOnce.values().next().value!)
        }
        count(shaped.count, shaped.n)
        return
      }
      if ('command' in shaped) { command(shaped.command.id, shaped.command.source); return }
      if ('quotaPrompt' in shaped) {
        const { entry, action } = shaped.quotaPrompt
        const rec = quotaPrompts.get(entry) ?? {}
        bump(rec, action)
        quotaPrompts.set(entry, rec)
        return
      }
      if ('modelCount' in shaped) {
        const { key, modelId, providerKind } = shaped.modelCount
        const k = `${providerKind}\n${modelId}`
        const rec = modelCounts.get(k)
        if (!rec && modelCounts.size >= MODEL_PAIR_CAP) return
        const next = rec ?? {}
        bump(next, key)
        modelCounts.set(k, next)
        return
      }
      if ('inventory' in shaped) {
        // 一天一份,不进启动缓冲:渲染层只在 Extend 报 active 之后才报,这时还没有订阅者 = Extend 没接上,这份丢掉(明天 / 下次启动再报)
        const day = new Date(now()).toISOString().slice(0, 10)
        if (inventoryDay === day) return
        if (buffer) { o.log?.('[telemetry] plugin_inventory dropped: no subscriber yet'); return }
        inventoryDay = day
        if (shaped.truncated) o.log?.(`[telemetry] plugin_inventory truncated: ${shaped.truncated} item(s) over ${INVENTORY_CAP}`)
        let capped = 0
        for (const props of shaped.inventory) {
          if ((sent.plugin_inventory ?? 0) >= HOURLY_CAP.plugin_inventory) { capped++; continue }
          emit('plugin_inventory', { day, ...props })
        }
        if (capped) o.log?.(`[telemetry] plugin_inventory hourly cap: ${capped} item(s) dropped`)
        return
      }
      if (shaped.event === 'first_run') {
        if (firstRunSent) return
        firstRunSent = true
      }
      const id = shaped.props.id
      if (shaped.event === 'plugin_load' && id !== 'local') {
        if (loadedOnce.has(String(id))) return
        loadedOnce.add(String(id))
      }
      if (shaped.event === 'plugin_lifecycle' && shaped.props.action === 'blocked' && id !== 'local') {
        const k = `${id}\n${shaped.props.blockedReason}`
        if (blockedOnce.has(k)) return
        blockedOnce.add(k)
      }
      emit(shaped.event, shaped.props)
    },
    /** 把本小时攒下的计数发出去:一条 app_counts(只带非零的键)+ 每个 (命令, 来源) 一条 command_use。整点与退出前各调一次;没攒到就什么都不发。 */
    flushCounts(): void {
      if (counts.size) emit('app_counts', Object.fromEntries(counts))
      for (const [k, n] of commands) {
        const i = k.indexOf('\n')
        emit('command_use', { id: k.slice(i + 1), source: k.slice(0, i), n })
      }
      // v3:每个入口一条 quota_prompt、每个模型一条 model_feedback(只带非零的计数字段)
      for (const [entry, rec] of quotaPrompts) emit('quota_prompt', { entry, ...rec })
      for (const [k, rec] of modelCounts) {
        const i = k.indexOf('\n')
        emit('model_feedback', { modelId: k.slice(i + 1), providerKind: k.slice(0, i), ...rec })
      }
      counts = new Map()
      commands = new Map()
      quotaPrompts = new Map()
      modelCounts = new Map()
    },
    /** 每小时一次:读走本小时的长任务数并清零,同时重置每小时的事件上限。 */
    takeHour(): { longTasks: number } {
      const n = longTasks
      longTasks = 0
      for (const k of Object.keys(sent) as CappedEvent[]) sent[k] = 0
      return { longTasks: n }
    },
  }
}
export type TelemetryHostHandle = ReturnType<typeof createTelemetryHost>

/**
 * 启动耗时的拼装:主窗首帧与引擎就绪各报一次(进程起来之后的毫秒数),两样都齐了发一条 startup;
 * 没有托管引擎(external / 无 agent 后端)或引擎迟迟不就绪,首帧之后等到 waitMs 就只带 startupMs 发。只发一次。
 */
export function createStartupTracker(o: { expectEngine: boolean; waitMs: number; emit: (props: Record<string, unknown>) => void; setTimer?: (fn: () => void, ms: number) => unknown }) {
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t })
  let expectEngine = o.expectEngine
  let startupMs: number | undefined
  let engineReadyMs: number | undefined
  let done = false
  const flush = (): void => {
    if (done || startupMs === undefined) return
    done = true
    o.emit(compact({ kind: 'startup', startupMs, engineReadyMs }))
  }
  return {
    firstFrame(ms: number): void {
      if (startupMs !== undefined || done) return
      startupMs = Math.max(0, Math.round(ms))
      if (!expectEngine || engineReadyMs !== undefined) flush()
      else setTimer(flush, o.waitMs)
    },
    engineReady(ms: number): void {
      if (engineReadyMs !== undefined || done) return
      engineReadyMs = Math.max(0, Math.round(ms))
      if (startupMs !== undefined) flush()
    },
    /** 这次启动不拉起托管引擎(外接引擎、也没开设备互联):首帧到了就发,不空等。 */
    noEngine(): void {
      expectEngine = false
      flush()
    },
  }
}
