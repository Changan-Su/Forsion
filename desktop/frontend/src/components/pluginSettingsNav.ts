/**
 * 「设置 › 扩展 › 插件设置」折叠组(方案 P4,2026-11-18 用户定):有设置的插件(引擎插件 `plugin:<id>` 与
 * Forsion 插件 `fplugin:<id>`,开着的、关着的都列)按显示名排成子项;超过 8 个时只列最近打开的 5 个,
 * 末尾一项「另外 N 个…」进列表页(`plugin-settings`)。
 *
 * 纯函数 + 两份本机偏好(每台设备自己的便利,不进同步):
 *  - recent:最近打开的插件设置页(tab id,新的在前);
 *  - known:开着时出现过设置的 Forsion 插件 id。插件关着时 setup 没跑,registerSetting 之类一条也没有 ——
 *    靠它在关着时照样列出来(灰的),点进去是「已停用 · 启用」。
 * 读不出来(存储抛错、内容坏了)= 不知道:照常列,但**不写回**(免得拿空表盖掉原来的)。
 */
export type PluginSettingsTab = `plugin:${string}` | `fplugin:${string}`

export interface PluginSettingsEntry {
  tab: PluginSettingsTab
  kind: 'engine' | 'forsion'
  id: string
  /** 当前语言的显示名。 */
  name: string
  /** 用户意图:开着(引擎 enabled / Forsion 想开)。关着的照样列,子项画成灰的。 */
  enabled: boolean
  /** 搜索别名:插件 id、两种语言的名字、registerSettingsPage 的 keywords。 */
  keywords: string
  /** 列表页那一行的第二行(`v1.2.0 · 商店`)。 */
  meta?: string
}

/** 超过这么多个就折起来。 */
export const NAV_LIMIT = 8
/** 折起来时列出的个数(最近打开的优先)。 */
export const NAV_SHOWN = 5

export function isPluginSettingsTab(tab: string): tab is PluginSettingsTab {
  return /^f?plugin:./.test(tab)
}

/** 按显示名排(中文按拼音 / 英文按字母,不分大小写);同名按种类、再按 id,顺序稳定。 */
export function sortPluginSettingsEntries(entries: readonly PluginSettingsEntry[], locale: 'zh' | 'en'): PluginSettingsEntry[] {
  let collator: Intl.Collator | null = null
  try { collator = new Intl.Collator(locale === 'zh' ? 'zh-Hans-CN' : 'en', { sensitivity: 'base', numeric: true }) } catch { /* 没有 Intl:退回码点序 */ }
  const cmp = (a: string, b: string): number => (collator ? collator.compare(a, b) : a < b ? -1 : a > b ? 1 : 0)
  return [...entries].sort((a, b) => cmp(a.name, b.name) || (a.kind === b.kind ? 0 : a.kind === 'forsion' ? -1 : 1) || cmp(a.id, b.id))
}

/**
 * 左栏要列的子项。不超过 NAV_LIMIT 个 → 全列;否则挑 NAV_SHOWN 个:当前打开的那个必在,其余按最近打开、
 * 再按名字补齐,挑出来的仍按名字排(点一下不让整列跳)。`more` = 没列出来的个数。
 */
export function pluginSettingsNavEntries(
  sorted: readonly PluginSettingsEntry[],
  recent: readonly string[],
  activeTab?: string,
): { shown: PluginSettingsEntry[]; more: number } {
  if (sorted.length <= NAV_LIMIT) return { shown: [...sorted], more: 0 }
  const byTab = new Map(sorted.map((e) => [e.tab as string, e]))
  const pick = new Set<string>()
  if (activeTab && byTab.has(activeTab)) pick.add(activeTab)
  for (const tab of recent) {
    if (pick.size >= NAV_SHOWN) break
    if (byTab.has(tab)) pick.add(tab)
  }
  for (const e of sorted) {
    if (pick.size >= NAV_SHOWN) break
    pick.add(e.tab)
  }
  const shown = sorted.filter((e) => pick.has(e.tab))
  return { shown, more: sorted.length - shown.length }
}

/** 列表页 / 搜索的过滤:名字或别名里有这段字(不分大小写)。 */
export function matchPluginSettingsEntry(e: PluginSettingsEntry, query: string): boolean {
  const q = query.trim().toLowerCase()
  return !q || e.name.toLowerCase().includes(q) || e.keywords.toLowerCase().includes(q)
}

/** Forsion 插件此刻算不算「有设置」:在跑 → 看它注册了什么(live);没在跑 → 看以前见过没有(known)。 */
export function forsionPluginHasSettings(id: string, active: boolean, live: ReadonlySet<string>, known: ReadonlySet<string> | null): boolean {
  return active ? live.has(id) : !!known?.has(id)
}

const RECENT_KEY = 'forsion.pluginSettings.recent'
const KNOWN_KEY = 'forsion.pluginSettings.known'
const RECENT_MAX = 20

/** 没写过 → []; 读不出来 / 不是字符串数组 → null(不知道)。 */
function readList(key: string): string[] | null {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return []
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null
  } catch {
    return null
  }
}
function writeList(key: string, list: readonly string[]): void {
  try { localStorage.setItem(key, JSON.stringify(list)) } catch { /* 存不进:只是少了这份便利 */ }
}

export function readRecentPluginSettings(): string[] {
  return readList(RECENT_KEY) ?? []
}

/** 记一次打开,返回新的最近列表。原来的读不出来就从这一条重新记(这份只是便利,丢了不伤数据)。 */
export function touchRecentPluginSettings(tab: string): string[] {
  const prev = readList(RECENT_KEY) ?? []
  if (prev[0] === tab) return prev
  const next = [tab, ...prev.filter((x) => x !== tab)].slice(0, RECENT_MAX)
  writeList(RECENT_KEY, next)
  return next
}

/** 见过设置的 Forsion 插件;读不出来 → null。 */
export function readKnownPluginSettings(): Set<string> | null {
  const list = readList(KNOWN_KEY)
  return list ? new Set(list) : null
}

/**
 * 对一遍:在跑且有设置的记上,在跑却没有设置的摘掉(新版本去掉了设置);没在跑的原样留着。
 * 原来的读不出来就不写(不知道 ≠ 空)。返回写后的集合(没变 / 没写 = 原集合)。
 */
export function syncKnownPluginSettings(running: readonly string[], live: ReadonlySet<string>): Set<string> | null {
  const known = readKnownPluginSettings()
  if (!known) return null
  const next = new Set(known)
  for (const id of running) {
    if (live.has(id)) next.add(id)
    else next.delete(id)
  }
  if (next.size === known.size && [...next].every((id) => known.has(id))) return known
  writeList(KNOWN_KEY, [...next].sort())
  return next
}
