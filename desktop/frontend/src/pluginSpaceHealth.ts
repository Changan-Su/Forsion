/** 「插件装着、也开着,它带的 Space 为什么没出现」—— 宿主本来就算得出原因,这里把它留下来给人和 agent 看。
 *
 *  起因(2026-10-10):一份用户插件的 main.js 有个函数没收口,把 registerView 包了进去 —— 求值不报错、零注册,
 *  随包 Space 以「引用了未注册的视图」被跳过。那条原因当时只进 console.warn:插件卡片上什么都没有,
 *  Tangu 也读不到,真模型六次都只能请用户去翻渲染端控制台。
 *
 *  三处消费:插件设置页(徽标 + 详情)、编码工作室的 Sandbox 面板、给 agent 的只读命令 `plugin-status`。
 *  ⚠️ 本模块不许在顶层碰 window(SandboxPanel 的单测跑在 node 环境);写入方是 userSpaces.tsx 的 loadUserSpacesOnce。 */
import { useMemo } from 'react'
import { create } from 'zustand'
import { pluginWanted, unmetPluginDeps, usePluginStore } from '@amadeus/plugins/pluginStore'
import type { AmadeusPlugin } from '@amadeus/plugins/types'
import { registerMessages } from './i18n'

registerMessages({
  'plugins.cmd.status': { zh: '插件状态', en: 'Plugin status' },
  'plugins.spaceHidden.badge': { zh: 'Space 未显示', en: 'Space hidden' },
  'plugins.spaceHidden.title': { zh: '没有显示的 Space', en: 'Hidden Spaces' },
  'plugins.spaceHidden.ownViews': {
    zh: '它需要的视图 {views} 没有注册。插件加载时没有报错，但它的代码没有注册这个视图，问题多半在插件自己的 main.js 里。',
    en: 'The view it needs ({views}) was never registered. The plugin loaded without an error, but its code did not register this view, so the problem is most likely in the plugin’s own main.js.',
  },
  'plugins.spaceHidden.otherViews': {
    zh: '它需要的视图 {views} 在这台设备上没有注册。可能是提供它的插件没装或没开、需要更新版本的 Forsion，或者 space.json 里的类型写错了。',
    en: 'The view it needs ({views}) is not registered on this device. The plugin that provides it may be missing or switched off, it may need a newer version of Forsion, or the type in space.json may be misspelled.',
  },
  'plugins.spaceHidden.minApp': { zh: '需要 Forsion {need} 或更高版本（当前 {have}）。', en: 'Needs Forsion {need} or later (this is {have}).' },
  'plugins.spaceHidden.invalid': { zh: '它的 space.json 没有通过校验。', en: 'Its space.json did not pass validation.' },
  'plugins.registeredViews': { zh: '这次加载注册的视图：{list}', en: 'Views registered by this load: {list}' },
  'plugins.registeredViewsNone': { zh: '这次加载没有注册任何视图。', en: 'This load registered no views.' },
})

export interface HiddenSpace {
  /** 包里的目录名(spaces/<slug>)。 */
  slug: string
  id?: string
  name?: string | { zh?: string; en?: string }
  /** invalid = 配方本身写坏了(parseSpaceJson 没给原因码的那些)。 */
  code: 'missing-views' | 'min-app-version' | 'invalid'
  views?: string[]
  need?: string
  have?: string | null
  /** parseSpaceJson 的原始说明(中文开发日志串):只进悬停提示,不当正文。 */
  detail: string
}

export const useHiddenPluginSpaces = create<{ byPlugin: Record<string, HiddenSpace[]> }>(() => ({ byPlugin: {} }))

/** 内容没变就保持原引用(订阅者不白白重渲)。 */
function apply(byPlugin: Record<string, HiddenSpace[]>): void {
  if (JSON.stringify(byPlugin) !== JSON.stringify(useHiddenPluginSpaces.getState().byPlugin)) useHiddenPluginSpaces.setState({ byPlugin })
}

/** Space 出没出现以**主窗**为准(只有它有功能条)。设置浮窗 / mini / 独立窗各有自己的插件宿主,能注册的视图可以和主窗不同
 *  (ctx.viewLocations 按窗口给,插件可以据此决定注册什么)—— 拿自己那份算,会把主窗里好好的 Space 报成「未显示」。
 *  所以主窗把结果写进 localStorage,别的窗口只读它(followMainWindowSpaceHealth)。 */
const SHARED_KEY = 'forsion_plugin_space_health'
let follower = false

/** 主窗每跑完一遍配方装载整份换掉。别的窗口调它是空操作(它们跟主窗的)。 */
export function setHiddenPluginSpaces(byPlugin: Record<string, HiddenSpace[]>): void {
  if (follower) return
  apply(byPlugin)
  try { localStorage.setItem(SHARED_KEY, JSON.stringify(byPlugin)) } catch { /* 没有 localStorage(单测 / 存储满):本窗照常 */ }
}

/** 非主窗装插件宿主时调一次:此后本窗的「没出现的 Space」跟主窗的记录走。 */
export function followMainWindowSpaceHealth(): void {
  follower = true
  const read = (): void => {
    let raw: unknown = null
    try { raw = JSON.parse(localStorage.getItem(SHARED_KEY) || '{}') } catch { /* 写坏了当作没有 */ }
    const out: Record<string, HiddenSpace[]> = {}
    if (raw && typeof raw === 'object') {
      for (const [id, list] of Object.entries(raw as Record<string, unknown>)) {
        if (Array.isArray(list)) out[id] = list.filter((h): h is HiddenSpace => !!h && typeof h === 'object' && typeof (h as HiddenSpace).slug === 'string')
      }
    }
    apply(out)
  }
  read()
  window.addEventListener('storage', (event) => { if (event.key === SHARED_KEY || event.key === null) read() })
}

type Translate = (key: string, vars?: Record<string, string | number>) => string

const short = (view: string): string => view.replace(/^plugin:[^:]+:/, '')
/** 缺的视图里属于这个插件自己的那些:它们没注册 = 插件自己的代码没走到,跟「设备上没有」是两回事,给的建议也不同。 */
const ownMissing = (pluginId: string, h: HiddenSpace): string[] => (h.views ?? []).filter((v) => v.startsWith(`plugin:${pluginId}:`))

export function hiddenSpaceName(h: HiddenSpace, locale: string): string {
  // 配方校验只要求 zh / en 里有一个是字符串,另一个可以是任何东西:只认字符串,别把对象交给 React 去渲染。
  const n = h.name
  const pick = typeof n === 'string' ? [n] : locale === 'zh' ? [n?.zh, n?.en] : [n?.en, n?.zh]
  return pick.find((x): x is string => typeof x === 'string' && !!x.trim()) || h.id || h.slug
}

export function hiddenSpaceReason(t: Translate, pluginId: string, h: HiddenSpace): string {
  if (h.code === 'min-app-version') return t('plugins.spaceHidden.minApp', { need: h.need ?? '', have: h.have ?? '?' })
  if (h.code !== 'missing-views') return t('plugins.spaceHidden.invalid')
  const own = ownMissing(pluginId, h)
  return own.length
    ? t('plugins.spaceHidden.ownViews', { views: own.map(short).join(t('common.listSep')) })
    : t('plugins.spaceHidden.otherViews', { views: (h.views ?? []).join(t('common.listSep')) })
}

/** 记录是上一遍配方装载时留的;插件之后可能被热重载修好了(开发副本保存即重载,不重扫配方)。
 *  缺的全是它自己的视图、而且现在都注册上了的那几条不再算数 —— 否则会一边列着这个视图、一边说它没注册。
 *  ponytail: 这时 Space 本身要到下一遍配方装载才回到功能条上(重载路径不重扫是原有行为,这里不改)。 */
function stillHidden(pluginId: string, hidden: HiddenSpace[], registered: readonly string[]): HiddenSpace[] {
  if (follower) return hidden // 别的窗口注册的视图和主窗不是一回事,照主窗的记录原样给
  const out = hidden.filter((h) => {
    const own = ownMissing(pluginId, h)
    return h.code !== 'missing-views' || own.length !== (h.views ?? []).length || own.some((v) => !registered.includes(short(v)))
  })
  return out.length === hidden.length ? hidden : out
}
const viewsOf = (pluginId: string): string[] => usePluginStore.getState().views.filter((v) => v.pluginId === pluginId).map((v) => v.item.id)

/** 这个插件此刻有没有「开着却没出现」的 Space。没在跑的插件不算:那是另一种状态,徽标已经在说了。 */
export function useHiddenSpacesOf(pluginId: string | null | undefined): HiddenSpace[] {
  const hidden = useHiddenPluginSpaces((s) => (pluginId ? s.byPlugin[pluginId] : undefined))
  const active = usePluginStore((s) => (pluginId ? s.activeIds.includes(pluginId) : false))
  const registered = useRegisteredViews(pluginId)
  return useMemo(() => (pluginId && active && hidden ? stillHidden(pluginId, hidden, registered) : NONE), [pluginId, active, hidden, registered])
}
const NONE: HiddenSpace[] = []
/** 非 React 读(agent 命令)。 */
function hiddenSpacesOf(pluginId: string): HiddenSpace[] {
  const hidden = useHiddenPluginSpaces.getState().byPlugin[pluginId]
  return hidden && usePluginStore.getState().activeIds.includes(pluginId) ? stillHidden(pluginId, hidden, viewsOf(pluginId)) : NONE
}

/** 这个插件此刻注册着的视图 id。「加载没报错、视图一个没有」是开头那类故障最直接的信号,Sandbox 面板把它摆出来。 */
export function useRegisteredViews(pluginId: string | null | undefined): string[] {
  // 选择器返回字符串:返回新数组的话 zustand 每次都判「变了」。
  const joined = usePluginStore((s) => (pluginId ? s.views.filter((v) => v.pluginId === pluginId).map((v) => v.item.id).join('\n') : ''))
  return useMemo(() => (joined ? joined.split('\n') : []), [joined])
}

// ── agent 面(英文)。引擎把 run_ui_command 的回执截在 200 字符、目录里的 state 截在 300:只摆事实,最要紧的放前面。

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export function hiddenSpaceForAgent(pluginId: string, h: HiddenSpace): string {
  const own = ownMissing(pluginId, h)
  const why = h.code === 'min-app-version' ? `needs app >= ${h.need}`
    : h.code !== 'missing-views' ? 'its space.json is invalid'
      : own.length ? `needs view ${own.map(short).join(', ')}, which this plugin did not register`
        : `needs view ${(h.views ?? []).join(', ')}, not registered here (its plugin missing or off, newer app needed, or a typo)`
  return `hidden Space ${h.id ?? h.slug}: ${why}`
}

/** 运行态一句话;problem = 值得在目录的 state 里点名(用户自己关掉的不算问题)。 */
function runState(p: AmadeusPlugin, hidden: HiddenSpace[]): { text: string; problem: boolean } {
  const s = usePluginStore.getState()
  if (p.blocked) return { text: `blocked by the host (${p.blocked}${p.blockedReason ? `: ${clip(p.blockedReason, 60)}` : ''})`, problem: true }
  if (!pluginWanted(p, s.disabledIds)) return { text: 'turned off by the user', problem: false }
  if (s.activeIds.includes(p.id)) return { text: 'running, no load error', problem: hidden.length > 0 }
  const unmet = unmetPluginDeps(p, s)
  if (unmet.length) return { text: `waiting for required plugins: ${unmet.map((u) => u.dep.id).join(', ')}`, problem: true }
  const error = s.lastSetupError[p.id]
  return { text: error ? `failed to load: ${clip(error, 110)}` : 'not running', problem: true }
}

const loose = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '')

/** `plugin-status` 带 id 的回执:一个插件在**这个窗口的宿主**里的实况。
 *  模型手里常常只有安装目录名(真模型三次里三次先拿目录名来问,目录名可以和 manifest id 不同,渲染端又不知道目录名):
 *  对不上 id 时按 id / 名字去掉标点大小写再对一次。回执以真 id 开头,它自己看得出对上的是谁。 */
export function pluginStatusForAgent(query: string): string {
  const s = usePluginStore.getState()
  const key = loose(query)
  const p = s.plugins.find((x) => x.id === query) ?? (key ? s.plugins.find((x) => loose(x.id) === key || loose(x.name) === key) : undefined)
  if (!p) return clip(`no plugin "${query}" in this window (ask by the id in manifest.json); ids: ${s.plugins.filter((x) => !x.builtin).map((x) => x.id).join(', ') || '(none)'}`, 200)
  const id = p.id
  const hidden = hiddenSpacesOf(id)
  const views = viewsOf(id)
  return clip([
    `${p.id} ${p.version}: ${runState(p, hidden).text}`,
    ...hidden.map((h) => hiddenSpaceForAgent(id, h)),
    `views registered: ${views.join(', ') || 'none'}`,
  ].join('; '), 200)
}

function problems(): Array<{ id: string; what: string }> {
  return usePluginStore.getState().plugins.flatMap((p) => {
    const mine = hiddenSpacesOf(p.id)
    const state = runState(p, mine)
    return state.problem ? [{ id: p.id, what: mine.length ? `${mine.length} Space hidden` : state.text.split(/[:(]/)[0].trim() }] : []
  })
}

/** 有问题的插件一览(命令目录里的 state)。一切正常返回空串 —— 目录里就不带这一项,不给每次 run 添噪音。 */
export function pluginProblemsForAgent(): string {
  const bad = problems()
  return bad.length ? clip(`${bad.length} plugin(s) with problems: ${bad.map((b) => `${b.id} (${b.what})`).join(', ')}`, 200) : ''
}

/** `plugin-status` 的回执。不带 id:只有一个插件出问题就直接给它的详情(一览里放不下错误原文,
 *  真模型拿到「failed to load」四个字就停下来问用户要报错了),多个才给一览。 */
export function pluginReportForAgent(query: string): string {
  if (query) return pluginStatusForAgent(query)
  const bad = problems()
  return bad.length === 1 ? pluginStatusForAgent(bad[0].id) : pluginProblemsForAgent() || 'no plugin problems recorded by this window'
}
