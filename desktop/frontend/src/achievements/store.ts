/**
 * 成就系统 · 状态机(依赖铁律见 definitions.ts 头注释)。
 * - 各埋点一行 track(event):fire-and-forget,内部 try/catch 永不抛、永不影响主流程。
 * - counter>=goal 即「达成」(跨线那一刻入 toast 队列一次);面板「领取」后点数才计入系列勋章。
 * - 持久化 localStorage,save=读-合并-写(counter 取 max、claimed 并集,多窗口最终一致)。
 *   ponytail: max 合并意味着将来做「重置成就」须先改此语义。
 * - queue 不持久化:重启不补播 toast,未领取的在面板仍可领。
 */
import { create } from 'zustand'
import { OFFICIAL_SERIES, type AchievementDef, type SeriesDef } from './definitions'

const KEY = 'forsion_tangu_achievements'
const COUNTER_CAP = 999_999

interface Persisted { v: 1; counters: Record<string, number>; claimed: string[] }

export interface AchievementsState {
  /** event -> 累计次数 */
  counters: Record<string, number>
  /** 已领取的成就 id */
  claimed: Record<string, true>
  /** 插件运行时注册的系列(不持久化,禁用插件即消失;计数/领取留在 counters/claimed 无害) */
  pluginSeries: Array<{ pluginId: string; def: SeriesDef }>
  /** 待播成就 toast 的成就 id(FIFO) */
  queue: string[]
  claim(id: string): void
  shiftToast(id: string): void
}

function load(): { counters: Record<string, number>; claimed: Record<string, true> } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null') as Persisted | null
    if (raw?.v === 1) {
      const counters: Record<string, number> = {}
      for (const [k, v] of Object.entries(raw.counters || {})) if (typeof v === 'number' && v > 0) counters[k] = Math.min(v, COUNTER_CAP)
      const claimed: Record<string, true> = {}
      for (const id of raw.claimed || []) if (typeof id === 'string') claimed[id] = true
      return { counters, claimed }
    }
  } catch { /* 首次 / 损坏 / node 测试环境 → 空 */ }
  return { counters: {}, claimed: {} }
}

function save(): void {
  try {
    const { counters, claimed } = useAchievements.getState()
    const disk = load()
    for (const [k, v] of Object.entries(counters)) disk.counters[k] = Math.max(disk.counters[k] || 0, v)
    const data: Persisted = { v: 1, counters: disk.counters, claimed: Object.keys({ ...disk.claimed, ...claimed }) }
    localStorage.setItem(KEY, JSON.stringify(data))
  } catch { /* 配额 / 隐私模式:静默 */ }
}

export const useAchievements = create<AchievementsState>((set, get) => ({
  ...load(),
  pluginSeries: [],
  queue: [],
  claim: (id) => {
    const s = get()
    const a = allSeries(s).flatMap((x) => x.achievements).find((x) => x.id === id)
    if (!a || s.claimed[id] || (s.counters[a.event] || 0) < a.goal) return
    set({ claimed: { ...s.claimed, [id]: true } })
    save()
  },
  // queue[0] 匹配才出队:animationend 与 timeout 兜底双触发下幂等。
  shiftToast: (id) => {
    const q = get().queue
    if (q[0] === id) set({ queue: q.slice(1) })
  },
}))

/** 官方 + 插件系列(传 state 避免组件里重复 getState;不传则取当前)。 */
export function allSeries(s?: Pick<AchievementsState, 'pluginSeries'>): SeriesDef[] {
  const ps = (s || useAchievements.getState()).pluginSeries
  return ps.length ? [...OFFICIAL_SERIES, ...ps.map((x) => x.def)] : OFFICIAL_SERIES
}

export function findAchievement(id: string): { a: AchievementDef; series: SeriesDef } | null {
  for (const series of allSeries()) {
    const a = series.achievements.find((x) => x.id === id)
    if (a) return { a, series }
  }
  return null
}

/** 埋点入口:累计计数,新跨线(before<goal<=after)成就入 toast 队列。 */
export function track(event: string, n = 1): void {
  try {
    if (!event || !(n > 0)) return
    const s = useAchievements.getState()
    const before = s.counters[event] || 0
    const after = Math.min(before + Math.floor(n), COUNTER_CAP)
    if (after === before) return
    const crossed = allSeries(s)
      .flatMap((x) => x.achievements)
      .filter((a) => a.event === event && before < a.goal && after >= a.goal && !s.claimed[a.id] && !s.queue.includes(a.id))
      .map((a) => a.id)
    useAchievements.setState({
      counters: { ...s.counters, [event]: after },
      queue: crossed.length ? [...s.queue, ...crossed] : s.queue,
    })
    save()
  } catch { /* 装饰性功能,绝不拖累调用方 */ }
}

/** 插件系列注册入参(与 amadeus/plugins/types.ts 的 contribution 形状一致,此处不 import 以守铁律)。 */
export interface PluginSeriesInput {
  id: string
  title: string
  medals?: { bronze: number; silver: number; gold: number }
  achievements: Array<{ id: string; title: string; desc: string; event: string; goal: number; points: number }>
}

/** Amadeus 插件注册系列:系列 id/成就 id/event 一律强制 `plugin:<pid>:` 前缀(撞不了官方 id、伪造不了官方计数)。 */
export function registerPluginSeries(pluginId: string, def: PluginSeriesInput): void {
  try {
    if (!def?.id || !Array.isArray(def.achievements) || !def.achievements.length) throw new Error('empty series')
    const p = (x: string): string => `plugin:${pluginId}:${x}`
    const achievements: AchievementDef[] = def.achievements.map((a) => {
      if (!a.id || !a.event || !(a.goal > 0) || !(a.points >= 0)) throw new Error(`bad achievement "${a.id}"`)
      return { id: p(a.id), event: p(a.event), goal: Math.floor(a.goal), points: Math.floor(a.points), title: String(a.title || a.id), desc: String(a.desc || '') }
    })
    const total = achievements.reduce((sum, a) => sum + a.points, 0)
    const medals = def.medals && def.medals.bronze > 0 ? def.medals : { bronze: Math.ceil(total * 0.25), silver: Math.ceil(total * 0.6), gold: total }
    const series: SeriesDef = { id: p(def.id), title: String(def.title || def.id), medals, achievements }
    useAchievements.setState((s) => ({ pluginSeries: [...s.pluginSeries.filter((x) => x.def.id !== series.id), { pluginId, def: series }] }))
  } catch (e) {
    console.error(`[achievements] plugin "${pluginId}" registerSeries failed`, e)
  }
}

/** 插件停用时由宿主 teardown 调用。 */
export function unregisterPluginAchievements(pluginId: string): void {
  useAchievements.setState((s) => (s.pluginSeries.some((x) => x.pluginId === pluginId)
    ? { pluginSeries: s.pluginSeries.filter((x) => x.pluginId !== pluginId) }
    : s))
}
