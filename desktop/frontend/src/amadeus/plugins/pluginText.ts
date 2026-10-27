/**
 * 插件给宿主的文案(走查续八 8.20,2026-10-26):字符串、函数(每次渲染求值)或 `{ zh, en }`。宿主在**画的那一刻**求值,
 * 所以切语言时宿主替插件画的部分(列表源标题、动作名、视图标题、菜单、对话框…)跟着重算,不用插件逐个 update。
 * 列表源进仓前包一层(hostListSource):文本字段是 getter,工作区视图拿到的永远是当前语言的字符串。
 */
import { currentLocale } from '../../i18n'
import type { ListAction, ListItem, ListSourceContribution, PluginText } from './types'

export function pluginText(v: unknown, fallback = ''): string {
  try {
    const r = typeof v === 'function' ? (v as () => unknown)() : v
    if (typeof r === 'string') return r
    if (r && typeof r === 'object') {
      const o = r as { zh?: unknown; en?: unknown }
      const s = currentLocale() === 'en' ? o.en ?? o.zh : o.zh ?? o.en
      if (typeof s === 'string') return s
    }
  } catch (e) { console.error('[amadeus] plugin text threw', e) }
  return fallback
}

export const isPluginText = (v: unknown): v is PluginText => typeof v === 'string' || typeof v === 'function'
  || (!!v && typeof v === 'object' && (typeof (v as { zh?: unknown }).zh === 'string' || typeof (v as { en?: unknown }).en === 'string'))

/** 宿主仓里那一份:文本字段已按当前语言求值。内置源(收件箱、自动化)直接写字符串,天然就是这个形状。 */
export type HostListAction = Omit<ListAction, 'label'> & { label: string }
export type HostListSource = Omit<ListSourceContribution, 'title' | 'actions' | 'groupActions' | 'itemMenu' | 'empty'> & {
  title: string
  actions?: HostListAction[]
  groupActions?: HostListAction[]
  itemMenu?(item: ListItem): HostListAction[]
}

/** 普通对象拷贝(不是 Proxy:冻结的动作对象上,Proxy 改写只读的 label 会抛 TypeError);函数照原对象调用(保住 this)。 */
const hostAction = (a: ListAction): HostListAction => {
  const o: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(a)) o[k] = typeof v === 'function' ? (...x: unknown[]) => (v as (...y: unknown[]) => unknown).apply(a, x) : v
  o.label = pluginText(a.label)
  return o as unknown as HostListAction
}
const list = (arr: ListAction[] | undefined): HostListAction[] | undefined => (Array.isArray(arr) ? arr.filter(Boolean).map(hostAction) : arr)

/** 包一层:title / 动作名在读的那一刻求值;动作数组每次读都按插件当前的数组重拷(插件 push / splice 后通知,宿主看到的是新的)。
 *  目标是空对象而不是 src:冻结的源、类实例的私有字段都不受影响(方法照 src 调用,绑定后的函数按原函数缓存,身份稳定)。 */
export function hostListSource(src: ListSourceContribution): HostListSource {
  const bound = new WeakMap<object, unknown>()
  const s = src as unknown as Record<PropertyKey, unknown>
  return new Proxy({}, {
    get(_t, k) {
      if (k === 'title') return pluginText(src.title)
      if (k === 'actions' || k === 'groupActions') return list(src[k])
      if (k === 'itemMenu') return typeof src.itemMenu === 'function' ? (item: ListItem) => list(src.itemMenu!(item) ?? []) ?? [] : undefined
      const v = s[k]
      if (typeof v !== 'function') return v
      let f = bound.get(v)
      if (!f) { f = (v as (...y: unknown[]) => unknown).bind(src); bound.set(v, f) }
      return f
    },
    has: (_t, k) => k in src,
  }) as unknown as HostListSource
}

/** `ctx.i18n.define({ zh, en })` → `t(key, vars)`:当前语言 → zh → key(与宿主同一条回退链),`{var}` 占位。
 *  zh 有、en 缺的键在定义时警告一次(切英文时那几条会原样显示中文)。 */
export function defineMessages(pluginId: string, dict: unknown): (key: string, vars?: Record<string, string | number>) => string {
  const d = (dict && typeof dict === 'object' ? dict : {}) as { zh?: Record<string, unknown>; en?: Record<string, unknown> }
  const zh = d.zh && typeof d.zh === 'object' ? d.zh : {}
  const en = d.en && typeof d.en === 'object' ? d.en : {}
  const missing = Object.keys(zh).filter((k) => typeof en[k] !== 'string')
  if (missing.length) console.warn(`[${pluginId}] i18n: ${missing.length} key(s) have no English text: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`)
  const get = (table: Record<string, unknown>, k: string): string | undefined => (Object.prototype.hasOwnProperty.call(table, k) && typeof table[k] === 'string' ? table[k] as string : undefined)
  return (key, vars) => {
    const k = String(key)
    const s = (currentLocale() === 'en' ? get(en, k) : undefined) ?? get(zh, k) ?? get(en, k) ?? k
    return vars ? s.replace(/\{(\w+)\}/g, (m, v: string) => (Object.prototype.hasOwnProperty.call(vars, v) ? String(vars[v]) : m)) : s
  }
}
