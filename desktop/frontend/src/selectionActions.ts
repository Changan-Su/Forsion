/**
 * 划线条(选中文字后浮出来的那一条)的应用层逻辑:插件动作在哪个视图里该不该列、怎么跑、条的排法偏好。
 * 纯逻辑,不碰 DOM / React —— 聊天(components/selectionBar)、笔记(UnifiedPage)、插件视图(ctx.ui.mountSelectionBar)
 * 三处都从这里取,单测直接断言。注册表就是 usePluginStore.selectionActions;内置的「问 Tangu」「翻译」「朗读」由各视图自己画,
 * 放哪(条上 / ⋯ / 不显示)、谁在前、谁划选后自动跑,一律由这里的 arrangeSelectionActions / autoSelectionAction 定(2026-11-21)。
 */
import type { SelectionBarOrder } from '@lcl/components'
import { registerMessages, translate } from './i18n'
import { broadcastPrefs, broadcastSelectionPrefsChanged, SELECTION_PREFS_EVENT } from './uiPrefsBus'
import { SELECTION_ACTION_PREFS_KEY, SELECTION_BAR_ORDER_KEY } from './types'
import type { SelectionActionContribution } from './amadeus/plugins/types'
import { pluginText } from './amadeus/plugins/pluginText'
import { isCorePlugin } from '../../shared/corePlugins'

registerMessages({
  'selbar.more': { zh: '更多', en: 'More' },
  'selbar.plugins': { zh: '插件', en: 'Plugins' },
  'selbar.err.notString': { zh: 'run() 必须返回字符串，实际是 {type}', en: 'run() must return a string, but returned {type}' },
  'selbar.err.controlChars': { zh: 'run() 返回内容含控制字符', en: 'run() returned content containing control characters' },
  'selbar.err.gone': { zh: '这个动作已经不在了（插件被停用或重载）', en: 'This action is no longer available (the plugin was disabled or reloaded).' },
  'selbar.failed': { zh: '「{title}」没有完成：{e}', en: '"{title}" did not finish: {e}' },
  'selbar.prefsUnreadable': { zh: '划线菜单的设置读不出来，这次改动没有保存（原来的设置没动）', en: 'Could not read the selection menu settings, so this change was not saved (the existing settings were left as they were).' },
})

/** 动作的显示名(插件可给 string / 函数 / { zh, en },画的那一刻求值)。 */
export const selectionActionTitle = (o: OwnedSelectionAction): string => pluginText(o.item.title, o.item.id)

export interface OwnedSelectionAction { pluginId: string; item: SelectionActionContribution }

/** 视图报给动作表的三样。view:'note' | 'chat' | '<插件 id>:<视图 id>';editable:选中的字能不能被结果替换。 */
export interface SelectionWhere { view: string; editable: boolean; length: number }

/** 条上 / ⋯ 里一项的 id(`data-ai`),也是宿主找回这个动作用的键。 */
export const selectionActionKey = (o: OwnedSelectionAction): string => `plugin:${o.pluginId}:${o.item.id}`

/** scope 认不认这个视图。缺省 'note';'own' = 这个插件自己的视图;数组里的一项匹配整个 id 或它的前缀段
 *  ('pdf-reader' 认 'pdf-reader:reader')。写错的 scope(不是这几种)当不匹配,不猜。 */
export function selectionScopeMatches(scope: SelectionActionContribution['scope'], pluginId: string, view: string): boolean {
  if (scope == null || scope === 'note') return view === 'note'
  if (scope === 'all') return true
  if (scope === 'own') return view.startsWith(`${pluginId}:`)
  return Array.isArray(scope) && scope.some((s) => typeof s === 'string' && !!s && (view === s || view.startsWith(`${s}:`)))
}

/** 这次该列哪些插件动作:scope 不认、when 说不要(或抛错)的不列 —— 不画一个点了没反应的按钮。
 *  按插件 id 排(同一个插件的保持注册顺序),⋯ 里同一个插件的挨在一起。 */
export function listSelectionActions(all: readonly OwnedSelectionAction[], where: SelectionWhere): OwnedSelectionAction[] {
  return all
    .filter((o) => {
      if (!selectionScopeMatches(o.item.scope, o.pluginId, where.view)) return false
      if (typeof o.item.when !== 'function') return true
      try { return !!o.item.when({ ...where }) } catch { return false }
    })
    .sort((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0))
}

/** 跑一个插件动作,返回要放进结果卡的 markdown('' = 没有要给人看的)。插件是第三方代码,返回值当外部输入校验
 *  (与 slash 的 run 同一套闸:非字符串会毒化文档,控制字符会污染笔记文件)。output: 'none' 的返回值不看。 */
export async function runSelectionAction(o: OwnedSelectionAction, cx: Parameters<SelectionActionContribution['run']>[0]): Promise<string> {
  const md = await o.item.run(cx)
  if (o.item.output === 'none' || md == null || md === '') return ''
  if (typeof md !== 'string') throw new Error(translate('selbar.err.notString', { type: typeof md }))
  // 控制字符逐码点判(放行 \t \n):正则字面量写法会把真控制字节带进源文件。
  if (Array.from(md).some((c) => c.charCodeAt(0) < 32 && c !== String.fromCharCode(9) && c !== String.fromCharCode(10))) {
    throw new Error(translate('selbar.err.controlChars'))
  }
  return md
}

/** 条的排法。没存过 = 'tools'(本视图的工具在前;2026-10-13 用户定),设置 → 外观里能换成 'actions'(动作在前)。
 *  条每次出现时现读,不用订阅。 */
export function selectionBarOrder(): SelectionBarOrder {
  try { return localStorage.getItem(SELECTION_BAR_ORDER_KEY) === 'actions' ? 'actions' : 'tools' } catch { return 'tools' }
}
export function setSelectionBarOrder(order: SelectionBarOrder): void {
  try { localStorage.setItem(SELECTION_BAR_ORDER_KEY, order) } catch { /* private mode */ }
  broadcastPrefs()
}

// ── 放哪、谁在前、谁自动(2026-11-21 用户「都按建议」:划线插件常驻方案 C)────────────────────────────────

/** 宿主自己的通用动作的键(和插件的 `plugin:<插件>:<项>` 同一张偏好表)。host:ask 管「带去对话」那一格的全部按钮
 *  (聊天的引用 / 在侧栏提问 / 顺便问,别处的「问 Tangu」)。 */
export const HOST_SELECTION_KEYS = { ask: 'host:ask', translate: 'host:translate', speak: 'host:speak' } as const
/** 接管宿主「翻译」的插件 id(契约 §5,11-21 评审后收紧):它是宿主认的核心插件(随包 / 预装,停用也算),或者它启用着且
 *  注册了划线动作,宿主就不画自己的翻译 —— 条上恰好一颗。接管它的动作沿用 host:translate 的「放在哪」。 */
export const TRANSLATION_PLUGIN_ID = 'translation'
/** 条上的插件位(不含视图工具、宿主通用动作、核心插件的动作)。 */
export const SELECTION_BAR_PLUGIN_SLOTS = 3

export type SelectionPlacement = 'bar' | 'more' | 'hidden'
export interface SelectionActionPrefs {
  placement: Record<string, SelectionPlacement>
  order: string[]
  auto: Record<string, boolean>
  /** 结果卡卡头的目标语言:按动作记上次选的。 */
  language: Record<string, string>
}
const emptyPrefs = (): SelectionActionPrefs => ({ placement: {}, order: [], auto: {}, language: {} })

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const PLACEMENTS = new Set(['bar', 'more', 'hidden'])

/** 读偏好。没存过 = 空(全按缺省);**读不出来 / 形状不对 = 不知道**(ok: false):调用方照缺省显示,不能据此写回。
 *  认得的字段里单个值写坏了只丢那一个值(不连累别的)。 */
export function readSelectionActionPrefs(): { ok: true; prefs: SelectionActionPrefs } | { ok: false } {
  let raw: string | null
  try { raw = localStorage.getItem(SELECTION_ACTION_PREFS_KEY) } catch { return { ok: false } }
  if (raw == null) return { ok: true, prefs: emptyPrefs() }
  let o: unknown
  try { o = JSON.parse(raw) } catch { return { ok: false } }
  if (!isRecord(o)) return { ok: false }
  for (const k of ['placement', 'auto', 'language'] as const) if (o[k] != null && !isRecord(o[k])) return { ok: false }
  if (o.order != null && !Array.isArray(o.order)) return { ok: false }
  const prefs = emptyPrefs()
  for (const [k, v] of Object.entries((o.placement ?? {}) as Record<string, unknown>)) if (typeof v === 'string' && PLACEMENTS.has(v)) prefs.placement[k] = v as SelectionPlacement
  for (const [k, v] of Object.entries((o.auto ?? {}) as Record<string, unknown>)) if (typeof v === 'boolean') prefs.auto[k] = v
  for (const [k, v] of Object.entries((o.language ?? {}) as Record<string, unknown>)) if (typeof v === 'string' && v) prefs.language[k] = v
  prefs.order = ((o.order ?? []) as unknown[]).filter((k): k is string => typeof k === 'string' && !!k)
  return { ok: true, prefs }
}

/** 条每次出现时现读;读不出来按缺省(空)走,不写。 */
export function selectionActionPrefs(): SelectionActionPrefs {
  const r = readSelectionActionPrefs()
  return r.ok ? r.prefs : emptyPrefs()
}

/** 用户动了一处(钉 / 收进 ⋯ / 管理表 / 卡头开关 / 卡头换语言):**从 localStorage 现读 → 只改这一处 → 写回**,别的原样留着
 *  —— 包括此刻没注册的动作(插件停用着 / 还没加载)的选择,不按「现在列得出的动作」修剪;不认识的字段照抄。
 *  跨窗只发一个不带值的「变了」信号,收方自己重读(不整表互发:晚到的旧快照会盖掉另一窗刚写的,整表也会超出 IPC 的长度上限)。
 *  **原来那份读不出来 = 不写**(读失败 ≠ 空,覆盖了就找不回):返回 false,提示用户这次没保存,界面按原样重画(开关回弹)。 */
export function updateSelectionActionPrefs(fn: (p: SelectionActionPrefs) => void): boolean {
  const r = readSelectionActionPrefs()
  if (!r.ok) { selectionPrefsUnwritable(); return false }
  let base: Record<string, unknown> = {}
  try { const o = JSON.parse(localStorage.getItem(SELECTION_ACTION_PREFS_KEY) ?? '{}'); if (isRecord(o)) base = o } catch { selectionPrefsUnwritable(); return false }
  const prefs = r.prefs
  fn(prefs)
  const out = { ...base, placement: prefs.placement, order: prefs.order, auto: prefs.auto, language: prefs.language }
  try { localStorage.setItem(SELECTION_ACTION_PREFS_KEY, JSON.stringify(out)) } catch { selectionPrefsUnwritable(); return false }
  broadcastSelectionPrefsChanged()
  emitSelectionPrefsChanged()
  return true
}

const emitSelectionPrefsChanged = (): void => { try { window.dispatchEvent(new Event(SELECTION_PREFS_EVENT)) } catch { /* 非浏览器 */ } }

/** 没写成:让订阅者按原样重画(开关回弹),再提示一句。toast 动态取,免得这个纯逻辑模块拖上整个应用 store。 */
function selectionPrefsUnwritable(): void {
  emitSelectionPrefsChanged()
  void import('./stores/appStore').then((m) => m.useApp.getState().toast(translate('selbar.prefsUnreadable'), true)).catch(() => {})
}

// 别的窗口写了:Chromium 的跨进程 storage 同步到了也算一次「变了」(和 IPC 信号谁先到没谱,两边都听)
try {
  window.addEventListener('storage', (e) => { if (e.key === SELECTION_ACTION_PREFS_KEY || e.key === null) emitSelectionPrefsChanged() })
} catch { /* 非浏览器 */ }

/** 排一个动作要知道的几样。kind:host = 宿主自己的;core = 核心插件(和宿主那组站一起、不占插件位);plugin = 其余插件。
 *  want = 缺省放哪(插件的 placement;宿主的恒为 'bar');rank = 缺省先后(宿主固定次序,插件按装的先后 + 注册先后);
 *  auto = 支持划选后自动(插件声明了 auto 且出结果卡)。 */
export interface SelectionEntry {
  key: string; kind: 'host' | 'core' | 'plugin'; want: 'bar' | 'more'; rank: number; auto?: boolean
  /** 没给自己设过「放在哪」时沿用这个键的(接管宿主翻译的那个插件动作沿用 host:translate)。 */
  alias?: string
}

const HOST_RANK: Record<string, number> = { [HOST_SELECTION_KEYS.ask]: 0, [HOST_SELECTION_KEYS.translate]: 1_000, [HOST_SELECTION_KEYS.speak]: 1e9 }

export function hostSelectionEntry(key: string): SelectionEntry {
  return { key, kind: 'host', want: 'bar', rank: HOST_RANK[key] ?? 5e8 }
}

/** 插件动作 → 排序项。plugins = usePluginStore 的 plugins(装着的,含停用的;顺序 = 装的先后)。
 *  核心插件的动作排在宿主「翻译」那一格之后、「朗读」之前(翻译插件接管后,用户看到的位置和以前一样)。 */
export function pluginSelectionEntry(o: OwnedSelectionAction, index: number, plugins: readonly { id: string; builtin?: boolean; preinstalled?: boolean }[]): SelectionEntry {
  const at = plugins.findIndex((p) => p.id === o.pluginId)
  const pluginRank = (at < 0 ? plugins.length : at) * 1000 + Math.min(index, 999)
  const core = at >= 0 && isCorePlugin(plugins[at])
  return {
    key: selectionActionKey(o),
    kind: core ? 'core' : 'plugin',
    want: o.item.placement === 'bar' ? 'bar' : 'more',
    rank: core ? 2_000 + pluginRank / 1e4 : pluginRank,
    // 自动只在聊天 / 插件视图跑(笔记的卡能写,不自动):只认笔记的动作在哪都跑不到,不算支持
    auto: o.item.auto === true && o.item.output !== 'none' && selectionAutoReachable(o),
    ...(o.pluginId === TRANSLATION_PLUGIN_ID ? { alias: HOST_SELECTION_KEYS.translate } : {}),
  }
}

/** 这个动作有没有能自动跑的视图:scope 缺省 / 'note' = 只在笔记,没有。 */
export function selectionAutoReachable(o: OwnedSelectionAction): boolean {
  const sc = o.item.scope
  if (sc == null || sc === 'note') return false
  if (sc === 'all' || sc === 'own') return true
  return Array.isArray(sc) && sc.some((v) => typeof v === 'string' && !!v && v !== 'note')
}

/** 宿主的「翻译」这次出不出。plugins = 装着的(含停用的);registered = 这个窗口注册着的划线动作。
 *  不出的两种:翻译插件是宿主认的核心插件(随包 / 预装,停用也算);或它启用着、且真注册了划线动作。
 *  同名的普通插件只是装着、没注册动作,宿主翻译照旧 —— 别让一个空壳把翻译弄没了。 */
export function hostTranslateAllowed(
  plugins: readonly { id: string; enabled?: boolean; builtin?: boolean; preinstalled?: boolean }[],
  registered: readonly OwnedSelectionAction[],
): boolean {
  const p = plugins.find((x) => x.id === TRANSLATION_PLUGIN_ID)
  if (!p) return true
  if (isCorePlugin(p)) return false
  return !(p.enabled !== false && registered.some((o) => o.pluginId === TRANSLATION_PLUGIN_ID))
}

/** 用户自己设过的「放在哪」(含沿用的那个键的);没设过 = undefined。 */
const explicitPlacement = (e: SelectionEntry, prefs: SelectionActionPrefs): SelectionPlacement | undefined =>
  prefs.placement[e.key] ?? (e.alias ? prefs.placement[e.alias] : undefined)

export const placementOf = (e: SelectionEntry, prefs: SelectionActionPrefs): SelectionPlacement => explicitPlacement(e, prefs) ?? e.want

/** 一组里的先后:用户排过的在前(按他排的),没排过的按缺省 rank 接在后面。 */
function ordered<T extends SelectionEntry>(list: readonly T[], prefs: SelectionActionPrefs): T[] {
  const at = new Map(prefs.order.map((k, i) => [k, i] as const))
  return [...list].sort((a, b) => {
    const ia = at.get(a.key) ?? Infinity
    const ib = at.get(b.key) ?? Infinity
    return ia !== ib ? ia - ib : a.rank - b.rank
  })
}

export interface ArrangedSelection<T extends SelectionEntry> {
  /** 竖线前那组:宿主通用动作 + 核心插件的动作。 */
  lead: T[]
  /** 竖线后那组:条上的插件动作,最多 SELECTION_BAR_PLUGIN_SLOTS 个。 */
  plugins: T[]
  /** ⋯ 里的:先宿主那组收进去的,再插件(想上条却放不下的也在这里,按插件次序)。 */
  more: T[]
  /** 想上条却放不下、落进 ⋯ 的个数(⋯ 顶上「还有 N 个放不下」)。 */
  overflow: number
}

/** 这一次条上 / ⋯ 里各放谁。entries 只给这次列得出的(scope / when 已过滤);'hidden' 的哪儿都不出。 */
export function arrangeSelectionActions<T extends SelectionEntry>(entries: readonly T[], prefs: SelectionActionPrefs = selectionActionPrefs()): ArrangedSelection<T> {
  const lead: T[] = []
  const plugins: T[] = []
  const hostMore: T[] = []
  const pluginMore: T[] = []
  let overflow = 0
  for (const e of ordered(entries.filter((x) => x.kind !== 'plugin'), prefs)) {
    const at = placementOf(e, prefs)
    if (at === 'bar') lead.push(e)
    else if (at === 'more') hostMore.push(e)
  }
  // 插件位先给用户自己设成「条上」的,剩下的再按缺省(插件 placement: 'bar')排 —— 缺省上条的占不掉用户点名要的
  const pl = ordered(entries.filter((x) => x.kind === 'plugin'), prefs)
  const want = pl.filter((e) => placementOf(e, prefs) === 'bar')
  const seats = new Set([...want.filter((e) => explicitPlacement(e, prefs) === 'bar'), ...want.filter((e) => explicitPlacement(e, prefs) !== 'bar')]
    .slice(0, SELECTION_BAR_PLUGIN_SLOTS).map((e) => e.key))
  for (const e of pl) {
    const at = placementOf(e, prefs)
    if (at === 'bar' && seats.has(e.key)) plugins.push(e)
    else if (at === 'bar') { pluginMore.push(e); overflow++ } else if (at === 'more') pluginMore.push(e)
  }
  return { lead, plugins, more: [...hostMore, ...pluginMore], overflow }
}

/** 全部动作的完整先后(宿主那组在前):管理表的行序,也是「多个开了自动只跑最前那个」的「前」。 */
export function orderedSelectionEntries<T extends SelectionEntry>(entries: readonly T[], prefs: SelectionActionPrefs = selectionActionPrefs()): T[] {
  return [...ordered(entries.filter((x) => x.kind !== 'plugin'), prefs), ...ordered(entries.filter((x) => x.kind === 'plugin'), prefs)]
}

/** 划选后自动跑哪一个:支持自动、用户开了、没被设成「不显示」的里面,排在最前那个;一个都没有 = null。 */
export function autoSelectionAction<T extends SelectionEntry>(entries: readonly T[], prefs: SelectionActionPrefs = selectionActionPrefs()): T | null {
  return orderedSelectionEntries(entries, prefs).find((e) => e.auto && prefs.auto[e.key] === true && placementOf(e, prefs) !== 'hidden') ?? null
}

/** 在 order 里只挪 key 一个:放到 target 前(after = 后)。visible = 这次列得出的全部键(按现在的先后);它们里还没进 order 的
 *  先按现在的先后接到末尾(没排过的本来就排在排过的后面,接上去先后不变),表外 / 别的视图里的键位置一概不动。 */
function moveKey(order: readonly string[], visible: readonly string[], key: string, target: string, after: boolean): string[] {
  const out = [...order]
  for (const k of visible) if (!out.includes(k)) out.push(k)
  const i = out.indexOf(key)
  if (i >= 0) out.splice(i, 1)
  const j = out.indexOf(target)
  out.splice(j < 0 ? out.length : j + (after ? 1 : 0), 0, key)
  return out
}

/** ⋯ 里的钉 / 条上右键「收进 ⋯」。钉上 = 用户点名要上条,先分到插件位;三个位都已被用户点名的占着,才把它挪到条上
 *  第一个插件前面(只挪它一个),挤下去的那个落进 ⋯(顶上写「还有 N 个放不下」)。all = 这次列得出的全部。 */
export function pinSelectionAction(key: string, on: boolean, all: readonly SelectionEntry[]): boolean {
  return updateSelectionActionPrefs((p) => {
    p.placement[key] = on ? 'bar' : 'more'
    if (!on) return
    const me = all.find((e) => e.key === key)
    if (!me || me.kind !== 'plugin') return
    const { plugins } = arrangeSelectionActions(all, p)
    if (!plugins.length || plugins.some((e) => e.key === key)) return
    p.order = moveKey(p.order, orderedSelectionEntries(all, p).map((e) => e.key), key, plugins[0].key, false)
  })
}

/** 管理表拖排序:把 key 挪到 target 前 / 后,只动它一个。visible = 表里这一刻的整张先后。 */
export function moveSelectionAction(key: string, target: string, after: boolean, visible: readonly string[]): boolean {
  if (key === target) return true
  return updateSelectionActionPrefs((p) => { p.order = moveKey(p.order, visible, key, target, after) })
}
export function setSelectionPlacement(key: string, at: SelectionPlacement): boolean {
  return updateSelectionActionPrefs((p) => { p.placement[key] = at })
}
export function setSelectionAuto(key: string, on: boolean): boolean {
  return updateSelectionActionPrefs((p) => { p.auto[key] = on })
}
/** 结果卡卡头换过语言:按动作记住(下次初值用它)。 */
export function rememberSelectionLanguage(key: string, language: string): boolean {
  if (selectionActionPrefs().language[key] === language) return true
  return updateSelectionActionPrefs((p) => { p.language[key] = language })
}
