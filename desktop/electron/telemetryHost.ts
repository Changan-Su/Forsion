/**
 * 匿名遥测「帮助改进 Forsion」的宿主那一半(契约 docs/ToBeImproved/默认数据采集方案_2026-10-28/contract.md §3)。
 * 宿主只**采集、整形、转发**:事件经 CloudHost.telemetry 交给 Forsion Extend 的主进程半身,发不发、开没开、排队与上传全归 Extend。
 * 宿主自己不落盘、不联网;没有订阅者(Extend 没装 / 老 Extend)时最多先攒 50 条,等首个订阅者来一次性回放,之后不再攒。
 *
 * 本文件不 import electron:main.ts 负责把 app / BackendManager / ipcMain 的事件接进来,这里只有纯整形与缓冲,单测直接跑。
 * 字段名与取值范围按白名单 telemetry-schema.json;报错原文照传(Extend 先 sanitize 再截到白名单的 max),这里只封顶长度,
 * 免得无界的字符串跨 IPC / 进内存。
 */

import type { CloudHost, HostTelemetryEvent } from './cloudHost'

export type { HostTelemetryEvent }
/** CloudHost.telemetry 接缝本身(声明在 cloudHost.ts,Extend host.d.ts 镜像那一份)。 */
export type HostTelemetry = NonNullable<CloudHost['telemetry']>

/** 渲染层经 preload telemetryReport 报上来的种类;别的一律丢。 */
export type RendererReportKind = 'crash' | 'feature' | 'longtasks'

export const BUFFER_CAP = 50
/** 跨 IPC 的原文封顶(Extend 再按白名单截到 300 / 4000)。 */
export const MESSAGE_CAP = 2000
export const STACK_CAP = 8000
/** 每小时每类事件的上限:渲染层报错死循环 / 来回切 View 不能把队列灌满。超出的直接丢。 */
export const HOURLY_CAP: Record<'crash' | 'feature', number> = { crash: 60, feature: 600 }
const INT_MAX = 2147483647
/** 白名单 id 类型:^[A-Za-z0-9._:/@+-]{1,max}$。 */
const ID_RE = /^[A-Za-z0-9._:/@+-]+$/
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/

const PROCESS_REASONS = ['crashed', 'oom', 'killed', 'abnormal-exit', 'launch-failed', 'integrity-failure'] as const

/** 合白名单的短 id;不合格返回 undefined。 */
export function safeId(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max && ID_RE.test(v) ? v : undefined
}
const int = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= INT_MAX ? v : undefined
const cap = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v ? v.slice(0, max) : undefined)
/** 错误名(TypeError / AbortError …):挑出合法字符再截 60;剩不下就不带。 */
function errorName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.replace(/\s+/g, '-').replace(/[^A-Za-z0-9._:/@+-]/g, '').slice(0, 60)
  return s || undefined
}
const compact = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

/**
 * 插件 id 能不能原样发:只有内置 / 商店的才行(渲染层按插件记录判,official = builtin / preinstalled / market-<uuid> 且不是开发副本),
 * 侧载的、看不出来源的、长得不合白名单的一律 `local` —— 用户自己的插件名本身就可能是隐私。
 */
export function publicPluginId(id: unknown, official: unknown, max = 80): string {
  // 插件 id 的形状比白名单的 id 类型更窄(kebab-case,同 shared/products.ts 的 SAFE_PLUGIN_ID;market-<uuid> 也合)
  return official === true && typeof id === 'string' && id.length <= max && PLUGIN_ID_RE.test(id) ? id : 'local'
}

/** Electron render-process-gone / child-process-gone 的 reason → 白名单 reason。clean-exit 不算崩溃,返回 null。 */
export function goneReason(reason: unknown): string | null {
  if (reason === 'clean-exit') return null
  return (PROCESS_REASONS as readonly unknown[]).includes(reason) ? String(reason) : 'other'
}

/** 一个 Error(或随便什么 throw 出来的东西)→ crash props。 */
export function crashFromError(proc: string, reason: 'exception' | 'rejection', err: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const e = err as { name?: unknown; message?: unknown; stack?: unknown } | null
  const isObj = !!e && typeof e === 'object'
  return compact({
    process: proc,
    reason,
    errorName: errorName(isObj ? e!.name : typeof err),
    message: cap(isObj ? e!.message : String(err), MESSAGE_CAP),
    stack: cap(isObj ? e!.stack : undefined, STACK_CAP),
    ...extra,
  })
}

/** 引擎进程意外退出 → crash props。Windows 的 NTSTATUS(0xC0000005 …)超出 int,改记进 errorName。 */
export function engineExitProps(code: number | null, signal: string | null, uptimeS?: number): Record<string, unknown> {
  const exitCode = int(code)
  const fatal = /^SIG(SEGV|BUS|ABRT|ILL|FPE)$/.test(signal ?? '')
  return compact({
    process: 'engine',
    reason: signal ? (fatal ? 'crashed' : signal === 'SIGKILL' || signal === 'SIGTERM' ? 'killed' : 'abnormal-exit') : 'abnormal-exit',
    exitCode,
    errorName: signal ? errorName(signal) : exitCode === undefined && typeof code === 'number' ? `0x${(code >>> 0).toString(16).toUpperCase()}` : undefined,
    uptimeS: int(uptimeS),
  })
}

/** 渲染进程 / 子进程没了 → crash props(clean-exit 返回 null)。child-process-gone 的类型(GPU / Utility …)记进 errorName。 */
export function processGoneProps(proc: 'renderer' | 'other', details: { reason?: unknown; exitCode?: unknown; type?: unknown }, uptimeS?: number): Record<string, unknown> | null {
  const reason = goneReason(details.reason)
  if (!reason) return null
  return compact({ process: proc, reason, exitCode: int(details.exitCode), errorName: errorName(details.type), uptimeS: int(uptimeS) })
}

/**
 * 渲染层报上来的一条 → 契约形状。返回:
 *  - `{ event, props }`:要转发的事件;
 *  - `{ longTasks }`:长任务计数,由宿主攒进本小时的 perf;
 *  - `null`:种类不对 / 形状不对,丢掉。
 * 渲染层是受信的(isTrustedSender 先挡过),这里防的是无界输入和 id 外泄,不防恶意。
 */
export function shapeRendererReport(kind: unknown, raw: unknown):
  | { event: 'crash' | 'feature'; props: Record<string, unknown> }
  | { longTasks: number }
  | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const p = raw as Record<string, unknown>
  if (kind === 'longtasks') {
    const n = int(p.count)
    return n ? { longTasks: n } : null
  }
  if (kind === 'crash') {
    const reason = p.reason === 'rejection' ? 'rejection' : 'exception'
    const props = compact({
      process: 'renderer',
      reason,
      errorName: errorName(p.errorName),
      message: cap(p.message, MESSAGE_CAP),
      stack: cap(p.stack, STACK_CAP),
      // 插件宿主分得出是哪个插件时才带;同样只给内置 / 商店的 id
      pluginId: p.pluginId === undefined ? undefined : publicPluginId(p.pluginId, p.pluginOfficial, 64),
    })
    return props.message || props.stack || props.errorName ? { event: 'crash', props } : null
  }
  if (kind === 'feature') {
    if (p.name === 'space_open') {
      // origin 由渲染层判(内置 / 插件 / 用户自建 Space 的账只有它有):用户自建的连 id 都不发
      if (p.origin === 'user') return { event: 'feature', props: { name: 'space_open', kind: 'custom' } }
      if (p.origin === 'plugin') return { event: 'feature', props: { name: 'space_open', kind: 'plugin', id: publicPluginId(p.pluginId, p.pluginOfficial) } }
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
      return { event: 'feature', props: { name: 'plugin_open', id: publicPluginId(p.pluginId, p.pluginOfficial) } }
    }
    return null
  }
  return null
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
}

export function createTelemetryHost(o: TelemetryHostOptions) {
  const now = o.now ?? Date.now
  const subscribers = new Set<(ev: HostTelemetryEvent) => void>()
  let buffer: HostTelemetryEvent[] | null = []
  let longTasks = 0
  const sent = { crash: 0, feature: 0 }

  const deliver = (ev: HostTelemetryEvent): void => {
    for (const cb of subscribers) {
      try { cb(ev) } catch (e) { o.log?.(`[telemetry] subscriber threw: ${(e as Error)?.message || e}`) }
    }
  }
  const emit = (event: HostTelemetryEvent['event'], props: Record<string, unknown>): void => {
    if (event !== 'perf') {
      if (sent[event] >= HOURLY_CAP[event]) return
      sent[event]++
    }
    const ev: HostTelemetryEvent = { event, ts: new Date(now()).toISOString(), props }
    if (buffer) { if (buffer.length < BUFFER_CAP) buffer.push(ev); return } // 留最早的:启动耗时 / 启动期崩溃最要紧
    deliver(ev)
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
    /** preload telemetryReport 的落点(调用方先过 isTrustedSender)。 */
    report(kind: unknown, props: unknown): void {
      const shaped = shapeRendererReport(kind, props)
      if (!shaped) return
      if ('longTasks' in shaped) longTasks = Math.min(INT_MAX, longTasks + shaped.longTasks)
      else emit(shaped.event, shaped.props)
    },
    /** 每小时一次:读走本小时的长任务数并清零,同时重置每小时的事件上限。 */
    takeHour(): { longTasks: number } {
      const n = longTasks
      longTasks = 0
      sent.crash = 0
      sent.feature = 0
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
      if (!o.expectEngine || engineReadyMs !== undefined) flush()
      else setTimer(flush, o.waitMs)
    },
    engineReady(ms: number): void {
      if (engineReadyMs !== undefined || done) return
      engineReadyMs = Math.max(0, Math.round(ms))
      if (startupMs !== undefined) flush()
    },
  }
}
