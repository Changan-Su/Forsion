/**
 * 插件主页小组件的数据面(2026-11-07,方案 A):卡声明在插件 manifest `widgets`(这一版只开「列表」型,主进程读进来挂在插件元数据上),
 * 行由插件经只读的 `ctx.widgets.provide(id, fn)` 喂 —— 宿主在卡挂着的时候调 fn 拿行,照主页卡的样子画。不开 DOM 挂载。
 *
 * 什么时候调:卡挂上、插件 `invalidate()`、窗口回到前台(距上次 ≥30 秒)。同一张卡同一时刻只有一次在飞,新的一次把旧的取消。
 * 插件停用 / 重载:`revokePluginWidgets` 撤掉它的全部 provider 与缓存的行,在飞的取消。
 * ⚠️读不到 ≠ 没有:fn 抛错 / 超时画「读不到」占位,不当成空列表。
 */
import { useEffect, useSyncExternalStore } from 'react'
import { subscribeLocale } from '../../i18n'

/** 列表卡的一行。文字由插件按当前界面语言给好(宿主不翻译)。 */
export interface WidgetListRow {
  id: string
  title: string
  /** 左边那一列(如 `10:00`、`全天`)。 */
  time?: string
  /** 右边的小字(如 `还有 1 小时`、`逾期`)。 */
  meta?: string
  /** 右边小字的语气:accent 主题色 / warn 警示红 / muted 缺省灰。 */
  tone?: 'accent' | 'warn' | 'muted'
  /** 有这个字段 = 这一行画勾选框(只读,第一版不回写);true = 已勾、划线。 */
  done?: boolean
  /** 正在进行(实心点)。 */
  now?: boolean
  /** 分组名(如 `明天`):和上一行不同时在这行上面画一个小标题。 */
  group?: string
}
export interface WidgetList { rows: WidgetListRow[]; footer?: string; empty?: string }
export type PluginWidgetProvider = (params: Record<string, never>, opts: { signal: AbortSignal }) => unknown
export type PluginWidgetData =
  | { status: 'none' } // 插件还没 provide(还在装载)
  | { status: 'loading'; list?: WidgetList }
  | { status: 'ok'; list: WidgetList }
  | { status: 'error'; error: string; list?: WidgetList }

const ROWS_MAX = 50
const TIMEOUT_MS = 10_000
const FOCUS_STALE_MS = 30_000

const key = (pluginId: string, widgetId: string): string => `${pluginId}/${widgetId}`
const providers = new Map<string, PluginWidgetProvider>()
const data = new Map<string, PluginWidgetData>()
const inflight = new Map<string, AbortController>()
const lastRun = new Map<string, number>()
const watching = new Map<string, number>()
const subs = new Set<() => void>()
const emit = (): void => { for (const f of [...subs]) f() }

const text = (v: unknown, cap: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, cap) : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined)
/** fn 的返回 → 列表:行的数组,或 `{ rows, footer?, empty? }`。没有 title 的行丢掉;最多 50 行。 */
export function normalizeWidgetList(raw: unknown): WidgetList {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  const list = Array.isArray(raw) ? raw : Array.isArray(o?.rows) ? (o!.rows as unknown[]) : null
  if (!list) throw new Error('provider must return an array of rows or { rows }')
  const rows: WidgetListRow[] = []
  for (const [i, item] of list.entries()) {
    if (rows.length >= ROWS_MAX) break
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const r = item as Record<string, unknown>
    const title = text(r.title, 200)
    if (!title) continue
    const tone = r.tone === 'accent' || r.tone === 'warn' || r.tone === 'muted' ? r.tone : undefined
    rows.push({
      id: text(r.id, 120) ?? String(i),
      title,
      ...(text(r.time, 24) ? { time: text(r.time, 24) } : {}),
      ...(text(r.meta, 40) ? { meta: text(r.meta, 40) } : {}),
      ...(tone ? { tone } : {}),
      ...(typeof r.done === 'boolean' ? { done: r.done } : {}),
      ...(r.now === true ? { now: true } : {}),
      ...(text(r.group, 40) ? { group: text(r.group, 40) } : {}),
    })
  }
  return { rows, ...(text(o?.footer, 80) ? { footer: text(o?.footer, 80) } : {}), ...(text(o?.empty, 80) ? { empty: text(o?.empty, 80) } : {}) }
}

function run(k: string): void {
  const fn = providers.get(k)
  if (!fn) return
  inflight.get(k)?.abort()
  const ctl = new AbortController()
  inflight.set(k, ctl)
  lastRun.set(k, Date.now())
  const prev = data.get(k)
  const list = prev && prev.status !== 'none' ? prev.list : undefined
  data.set(k, { status: 'loading', list })
  emit()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  Promise.resolve()
    .then(() => fn({}, { signal: ctl.signal }))
    .then((raw) => {
      if (ctl.signal.aborted && inflight.get(k) !== ctl) return
      if (ctl.signal.aborted) throw new Error('timed out')
      data.set(k, { status: 'ok', list: normalizeWidgetList(raw) })
    })
    .catch((e: unknown) => {
      if (inflight.get(k) !== ctl) return // 被更新的一次顶掉了
      data.set(k, { status: 'error', error: e instanceof Error ? e.message : String(e), list })
    })
    .finally(() => {
      clearTimeout(timer)
      if (inflight.get(k) === ctl) { inflight.delete(k); emit() }
    })
}

/** ctx.widgets.provide 的宿主那半:同一张卡再 provide 一次 = 换成新的 fn。返回撤销。 */
export function providePluginWidget(pluginId: string, widgetId: string, fn: PluginWidgetProvider): () => void {
  const k = key(pluginId, widgetId)
  providers.set(k, fn)
  if (watching.get(k)) run(k)
  else { data.delete(k); emit() }
  return () => {
    if (providers.get(k) !== fn) return
    providers.delete(k)
    inflight.get(k)?.abort()
    inflight.delete(k)
    data.delete(k)
    emit()
  }
}

/** 插件说数据变了:正挂着的卡重拿,没挂着的丢掉缓存(下次挂上再拿)。不给 widgetId = 这个插件的全部卡。 */
export function invalidatePluginWidget(pluginId: string, widgetId?: string): void {
  for (const k of [...providers.keys()]) {
    if (widgetId ? k !== key(pluginId, widgetId) : !k.startsWith(`${pluginId}/`)) continue
    if (watching.get(k)) run(k)
    else data.delete(k)
  }
  emit()
}

/** 停用 / 重载:这个插件的 provider、缓存的行、在飞的请求一并撤掉。 */
export function revokePluginWidgets(pluginId: string): void {
  for (const k of [...providers.keys(), ...data.keys()]) {
    if (!k.startsWith(`${pluginId}/`)) continue
    providers.delete(k)
    inflight.get(k)?.abort()
    inflight.delete(k)
    data.delete(k)
  }
  emit()
}

let wired = false
function wire(): void {
  if (wired || typeof window === 'undefined') return
  wired = true
  window.addEventListener('focus', () => {
    const now = Date.now()
    for (const [k, n] of watching) if (n > 0 && providers.has(k) && now - (lastRun.get(k) ?? 0) >= FOCUS_STALE_MS) run(k)
  })
  // 行里的文字是插件按语言给好的:切语言就整份重拿(没挂着的丢缓存)
  subscribeLocale(() => {
    for (const k of [...providers.keys()]) { if (watching.get(k)) run(k); else data.delete(k) }
    emit()
  })
}

const NONE: PluginWidgetData = { status: 'none' }
/** 主页上一张插件卡的数据:挂着就算在看(重拿只拿在看的)。 */
export function usePluginWidgetData(pluginId: string, widgetId: string): PluginWidgetData {
  const k = key(pluginId, widgetId)
  useEffect(() => {
    wire()
    watching.set(k, (watching.get(k) ?? 0) + 1)
    if (providers.has(k) && !data.has(k)) run(k)
    return () => {
      const n = (watching.get(k) ?? 1) - 1
      if (n > 0) watching.set(k, n)
      else watching.delete(k)
    }
  }, [k])
  return useSyncExternalStore(
    (f) => { subs.add(f); return () => { subs.delete(f) } },
    () => data.get(k) ?? NONE,
  )
}

/** 测试用:清空全部状态。 */
export function resetPluginWidgetsForTest(): void {
  for (const c of inflight.values()) c.abort()
  providers.clear(); data.clear(); inflight.clear(); lastRun.clear(); watching.clear()
}
