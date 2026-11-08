/**
 * 帮助改进 Forsion(匿名遥测)的渲染层那一半:只往主进程报(preload telemetryReport),主进程整形后经 CloudHost.telemetry 转给 Extend,
 * 发不发由 Extend 定(契约 docs/ToBeImproved/默认数据采集方案_2026-10-28/contract.md §3)。本窗口不存、不发、不读任何东西。
 *  - 崩溃:window error / unhandledrejection(原文照报,Extend 先 sanitize;主进程封顶长度)。
 *  - 卡顿:>200 ms 的长任务计数,攒着每 10 分钟报一次(主进程按小时汇总进 perf hourly)。
 *  - 功能使用:换 Space(space_open)、主区前台换成另一种 View(view_open;插件视图记 plugin_open)。只在主窗 / 独立窗记。
 *  - 命令使用(v2):LCL 命令注册表的观察者,每个窗口都接。其余 v2 事件(插件、引导、提示、计数、设置)在各自的落点直接调 telemetrySend。
 * 插件 / Space 的 id 只有内置与商店的报公开 id(商店条目 id / 内置 id):侧载的记 local、用户自建的 Space 记 custom(主进程再按同一条规则核一遍)。
 * 没有 telemetryReport 键(web / 手机 / 没有带遥测的 Extend)整段 no-op。
 */
import { setCommandObserver, useSpaceStore, useWorkspace } from '@lcl/engine'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { pluginSpaceOwner } from './stores/spaceProgress'
import { isUserSpace } from './userSpaces'
import { windowKind } from './windowKind'
import { commandTelemetry, sendTelemetry } from './telemetrySend'
import { telemetryCommandId, telemetryPluginRef, type TelemetryPluginRef } from './telemetryPluginId'

const pluginById = (id: string) => usePluginStore.getState().plugins.find((p) => p.id === id)
/** 按插件 id 换成遥测里的引用(商店条目 id / 内置 id / local,规则见 telemetryPluginId.ts)。 */
const refOf = (id: string): TelemetryPluginRef => telemetryPluginRef(pluginById(id))

/** 一次换 Space → feature 载荷。origin 只有渲染层分得出:插件 Space 的主人在 pluginSpaceOwner、用户自建的在 userSpaces。 */
export function spaceOpenPayload(id: string, deps: { pluginOf: (id: string) => string | undefined; isUser: (id: string) => boolean; ref: (pluginId: string) => TelemetryPluginRef }): Record<string, unknown> {
  const owner = deps.pluginOf(id)
  if (owner) return { name: 'space_open', origin: 'plugin', ...deps.ref(owner) }
  if (deps.isUser(id)) return { name: 'space_open', origin: 'user' }
  return { name: 'space_open', origin: 'builtin', space: id }
}

/** 主区前台的 View 类型 → feature 载荷;插件视图(plugin:<插件 id>:<视图 id>)只报插件。 */
export function viewOpenPayload(type: string, ref: (pluginId: string) => TelemetryPluginRef): Record<string, unknown> {
  if (type.startsWith('plugin:')) return { name: 'plugin_open', ...ref(type.split(':')[1] ?? '') }
  return { name: 'view_open', view: type }
}

/** 浏览器自己会报、但不是我们的错的那几条(ResizeObserver 循环、跨域脚本只剩一句 Script error.)。 */
const NOISE = /^(ResizeObserver loop|Script error\.?$)/

let installed = false
export function installTelemetryReport(): void {
  const report = window.tangu?.telemetryReport
  if (!report || installed) return
  installed = true
  const send = sendTelemetry
  // 命令使用(契约 §9):LCL 命令注册表在面板 / 快捷键 / Ribbon / Agent 触发时回调;插件命令的插件 id 换成公开 id 或 plugin:local。
  // 每个窗口都接(Mini、独立窗里也能跑命令),主进程按小时按 (id, 来源) 攒成 command_use。
  setCommandObserver((id, source) => commandTelemetry(telemetryCommandId(id, pluginById), source))
  const crash = (reason: 'exception' | 'rejection', err: unknown, fallback?: string): void => {
    const e = err && typeof err === 'object' ? err as { name?: unknown; message?: unknown; stack?: unknown } : null
    const message = typeof e?.message === 'string' ? e.message : fallback ?? (err === undefined ? '' : String(err))
    if (!e && !message) return
    if (NOISE.test(message)) return
    send('crash', { reason, errorName: e?.name, stack: e?.stack }) // 报错原文只用来滤噪音,不上报
  }
  window.addEventListener('error', (ev) => crash('exception', ev.error, ev.message))
  window.addEventListener('unhandledrejection', (ev) => crash('rejection', ev.reason))

  let longTasks = 0
  try {
    if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (entry.duration > 200) longTasks++ })
        .observe({ type: 'longtask', buffered: true })
    }
  } catch { /* 不支持就不数 */ }
  const flushLongTasks = (): void => {
    if (longTasks <= 0) return
    send('longtasks', { count: longTasks })
    longTasks = 0
  }
  setInterval(flushLongTasks, 10 * 60_000)
  window.addEventListener('pagehide', flushLongTasks)

  const kind = windowKind()
  if (kind !== 'main' && kind !== 'detached') return
  // 启动后 3 秒内的变化不算:冷启动恢复上次的 Space / 布局也会改它们(同 bootstrapEngine 里 space.switch 成就的口径)。
  const bootQuietUntil = Date.now() + 3000
  // 换 Space 会把新 Space 的主视图翻到前台:那是「开了 Space」,不是「开了 View」,之后一小会儿的前台变化不记。
  let viewQuietUntil = 0
  if (kind === 'main') {
    useSpaceStore.subscribe((s, p) => {
      if (s.activeSpaceId === p.activeSpaceId) return
      viewQuietUntil = Date.now() + 1500
      if (Date.now() <= bootQuietUntil) return
      send('feature', spaceOpenPayload(s.activeSpaceId, { pluginOf: (id) => pluginSpaceOwner.get(id), isUser: isUserSpace, ref: refOf }))
    })
  }
  let lastView: string | null = null
  useWorkspace.subscribe((s, p) => {
    if (s.mainTabs === p.mainTabs || !Array.isArray(s.mainTabs)) return
    const front = s.mainTabs.find((tab) => tab.active)
    if (!front || front.type === lastView) return
    lastView = front.type
    if (Date.now() <= bootQuietUntil || Date.now() <= viewQuietUntil) return
    send('feature', viewOpenPayload(front.type, refOf))
  })
}
