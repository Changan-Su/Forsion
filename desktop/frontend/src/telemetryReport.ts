/**
 * 帮助改进 Forsion(匿名遥测)的渲染层那一半:只往主进程报(preload telemetryReport),主进程整形后经 CloudHost.telemetry 转给 Extend,
 * 发不发由 Extend 定(契约 docs/ToBeImproved/默认数据采集方案_2026-10-28/contract.md §3)。本窗口不存、不发、不读任何东西。
 *  - 崩溃:window error / unhandledrejection(原文照报,Extend 先 sanitize;主进程封顶长度)。
 *  - 卡顿:>200 ms 的长任务计数,攒着每 10 分钟报一次(主进程按小时汇总进 perf hourly)。
 *  - 功能使用:换 Space(space_open)、主区前台换成另一种 View(view_open;插件视图记 plugin_open)。只在主窗 / 独立窗记。
 * 插件 / Space 的 id 只有内置与商店的原样报:侧载的记 local、用户自建的 Space 记 custom(主进程再按同一条规则核一遍)。
 * 没有 telemetryReport 键(web / 手机 / 没有带遥测的 Extend)整段 no-op。
 */
import { useSpaceStore, useWorkspace } from '@lcl/engine'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { MARKET_ITEM_ID } from '../../shared/products'
import { pluginSpaceOwner } from './stores/spaceProgress'
import { isUserSpace } from './userSpaces'
import { windowKind } from './windowKind'

/** 这个插件 id 能不能原样报:内置(代码内置 / 随包播种)或商店新装(market-<uuid>),且不是开发副本。 */
export function isOfficialPlugin(plugin: { id: string; builtin?: boolean; preinstalled?: boolean; dev?: boolean } | undefined): boolean {
  return !!plugin && !plugin.dev && (!!plugin.builtin || !!plugin.preinstalled || MARKET_ITEM_ID.test(plugin.id))
}
const officialPluginId = (id: string): boolean => isOfficialPlugin(usePluginStore.getState().plugins.find((p) => p.id === id))

/** 一次换 Space → feature 载荷。origin 只有渲染层分得出:插件 Space 的主人在 pluginSpaceOwner、用户自建的在 userSpaces。 */
export function spaceOpenPayload(id: string, deps: { pluginOf: (id: string) => string | undefined; isUser: (id: string) => boolean; official: (pluginId: string) => boolean }): Record<string, unknown> {
  const owner = deps.pluginOf(id)
  if (owner) return { name: 'space_open', origin: 'plugin', pluginId: owner, pluginOfficial: deps.official(owner) }
  if (deps.isUser(id)) return { name: 'space_open', origin: 'user' }
  return { name: 'space_open', origin: 'builtin', space: id }
}

/** 主区前台的 View 类型 → feature 载荷;插件视图(plugin:<插件 id>:<视图 id>)只报插件。 */
export function viewOpenPayload(type: string, official: (pluginId: string) => boolean): Record<string, unknown> {
  if (type.startsWith('plugin:')) {
    const pluginId = type.split(':')[1] ?? ''
    return { name: 'plugin_open', pluginId, pluginOfficial: official(pluginId) }
  }
  return { name: 'view_open', view: type }
}

/** 浏览器自己会报、但不是我们的错的那几条(ResizeObserver 循环、跨域脚本只剩一句 Script error.)。 */
const NOISE = /^(ResizeObserver loop|Script error\.?$)/

let installed = false
export function installTelemetryReport(): void {
  const report = window.tangu?.telemetryReport
  if (!report || installed) return
  installed = true
  const send = (kind: 'crash' | 'feature' | 'longtasks', props: Record<string, unknown>): void => {
    try { report(kind, props) } catch { /* 上报失败不影响任何事 */ }
  }
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
      send('feature', spaceOpenPayload(s.activeSpaceId, { pluginOf: (id) => pluginSpaceOwner.get(id), isUser: isUserSpace, official: officialPluginId }))
    })
  }
  let lastView: string | null = null
  useWorkspace.subscribe((s, p) => {
    if (s.mainTabs === p.mainTabs || !Array.isArray(s.mainTabs)) return
    const front = s.mainTabs.find((tab) => tab.active)
    if (!front || front.type === lastView) return
    lastView = front.type
    if (Date.now() <= bootQuietUntil || Date.now() <= viewQuietUntil) return
    send('feature', viewOpenPayload(front.type, officialPluginId))
  })
}
