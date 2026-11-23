/**
 * 插件清单(遥测 v3 契约 §19 plugin_inventory):每个 UTC 日一份,只在主窗报。
 *  - 等渲染层插件仓把外部插件也读进来(externalPluginsLoaded,不是 initialized —— 那只代表内置插件到位);
 *  - 遥测处于可发状态(Extend telemetry:get 报 active)才报;不可发就跳过,当天下次启动再试(本机不记已报);
 *  - Forsion 插件(pluginStore)+ 引擎插件(/agent/plugins);引擎插件**读失败 ≠ 没装**:这次不报、不记,隔一会儿再试几次。
 *    server 取每台「最近一份快照」,残缺的一份会把引擎插件全算成没装。
 * id 一律按 telemetryPluginId 的规则换(商店条目 id / 内置 id / local),主进程再按 publicPluginId 核一遍、本地插件只给个数、
 * 一份最多 150 条、单列每小时上限、不进启动缓冲。
 */
import { externalPluginsLoaded, pluginWanted, usePluginStore } from '@amadeus/plugins/pluginStore'
import type { PluginInfo } from './services/backendService'
import { request } from './services/backendService'
import { homeTarget } from './services/engine/targets'
import { sendTelemetry, telemetryOn } from './telemetrySend'
import { telemetryPluginEntry } from './telemetryPluginId'

const DAY_KEY = 'forsion_plugin_inventory_day'
/** 第一次读在插件仓就绪之后再等一会儿(引擎刚起、商店更新器的名单还没广播);引擎读失败按这张表再试。 */
const FIRST_DELAY_MS = 20_000
const ENGINE_RETRY_MS = [2 * 60_000, 10 * 60_000]

export interface InventoryItem { pluginId: string; pluginOfficial: boolean; source: 'store' | 'builtin'; enabled: boolean }
const utcDay = (now = Date.now()): string => new Date(now).toISOString().slice(0, 10)

/**
 * 两份插件名单 → 上报载荷。engine = null 表示这个宿主没有引擎(不是读失败)。公开的每个一条;其余只数个数。
 */
export function inventoryPayload(
  forsion: ReadonlyArray<{ entry: ReturnType<typeof telemetryPluginEntry>; enabled: boolean }>,
  engine: ReadonlyArray<{ entry: ReturnType<typeof telemetryPluginEntry>; enabled: boolean }> | null,
): { plugins: InventoryItem[]; localCount: number } {
  const plugins: InventoryItem[] = []
  let localCount = 0
  for (const x of [...forsion, ...(engine ?? [])]) {
    if (x.entry.source === 'local' || !x.entry.pluginOfficial) { localCount++; continue }
    plugins.push({ pluginId: x.entry.pluginId, pluginOfficial: true, source: x.entry.source, enabled: x.enabled })
  }
  return { plugins, localCount }
}

function forsionPlugins(): Array<{ entry: ReturnType<typeof telemetryPluginEntry>; enabled: boolean }> {
  const s = usePluginStore.getState()
  return s.plugins.map((p) => ({ entry: telemetryPluginEntry(p), enabled: !p.blocked && pluginWanted(p, s.disabledIds) }))
}
/** 引擎插件。没有引擎的宿主 → null;读失败 → 抛(调用方不报)。 */
async function enginePlugins(): Promise<Array<{ entry: ReturnType<typeof telemetryPluginEntry>; enabled: boolean }> | null> {
  if (!window.tangu?.backendStatus) return null
  const r = await request<{ plugins?: PluginInfo[] }>(homeTarget(), '/agent/plugins', undefined, { timeoutMs: 10_000 })
  if (!Array.isArray(r?.plugins)) throw new Error('bad /agent/plugins response')
  return r.plugins.map((p) => ({ entry: telemetryPluginEntry({ id: p.id, builtin: p.source === 'builtin' || p.official === true }, 'plugin'), enabled: !!p.enabled }))
}

async function telemetryActive(): Promise<boolean> {
  try { return (await window.tangu?.cloudInvoke?.('telemetry:get') as { active?: unknown } | null)?.active === true } catch { return false }
}
const reportedToday = (): boolean => { try { return localStorage.getItem(DAY_KEY) === utcDay() } catch { return false } }
const markReported = (): void => { try { localStorage.setItem(DAY_KEY, utcDay()) } catch { /* 记不下:主进程按天再挡一道 */ } }

/** 试一次:返回 'done'(报了或今天已报)/ 'skip'(不可发,今天下次启动再试)/ 'retry'(引擎没读到)。 */
export async function reportPluginInventoryOnce(): Promise<'done' | 'skip' | 'retry'> {
  if (reportedToday()) return 'done'
  if (!(await telemetryActive())) return 'skip'
  let engine: Awaited<ReturnType<typeof enginePlugins>>
  try { engine = await enginePlugins() } catch { return 'retry' }
  const payload = inventoryPayload(forsionPlugins(), engine)
  if (!payload.plugins.length && !payload.localCount) return 'done'
  sendTelemetry('pluginInventory', payload as unknown as Record<string, unknown>)
  markReported()
  return 'done'
}

let installed = false
/** 主窗启动时调一次(telemetryReport.ts)。没有遥测通道就什么都不做。 */
export function installPluginInventoryReport(): void {
  if (installed || !telemetryOn()) return
  installed = true
  const run = (attempt: number): void => {
    void reportPluginInventoryOnce().then((r) => {
      if (r === 'retry' && attempt < ENGINE_RETRY_MS.length) setTimeout(() => run(attempt + 1), ENGINE_RETRY_MS[attempt])
    }).catch(() => {})
  }
  // 外部插件读进来那一刻不一定伴随一次 store 变化(标记在 applySources 之后才置):轮询,最多等 5 分钟
  let waited = 0
  const poll = setInterval(() => {
    waited += 2000
    if (!externalPluginsLoaded() && waited < 5 * 60_000) return
    clearInterval(poll)
    if (externalPluginsLoaded()) setTimeout(() => run(0), FIRST_DELAY_MS)
  }, 2000)
}
