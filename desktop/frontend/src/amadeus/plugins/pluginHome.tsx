/**
 * `ctx.home`(2026-11-09,主页插件化 B 的 H1 / H2 / H4 / H5):只给接管宿主主页视图的那个核心插件(HOST_VIEW_CLAIMS 的 homepage,
 * 注入条件在 pluginStore)。插件管主页长什么样、东西怎么摆;卡里的内容、摆放的存储、首启再问那张卡留在宿主,经这里交给插件。
 * - 卡头 / 卡芯 / 图标由宿主画进插件的元素(views/homeWidgetMount,动态 import);
 * - 摆放存储与格式校验在 views/homeWidgets(聊天里「放到主页」也写同一份),插件写整份、宿主 sanitize;
 * - 「编辑主页」命令复用 setHomeEditHandler(主页没挂上时先记着,登记那一刻补发);
 * - 官方计数只收白名单里的名字(和内置主页记的是同一个,上手提示据此算「会了」)。
 */
import { pluginDisplayName } from './display'
import type { AmadeusPlugin, PluginHomeApi, PluginHomeLayout, PluginHomeMountOptions, PluginHomeWidgetInfo } from './types'
import { listWidgets } from '../../services/widgetClient'
import { currentLocale, subscribeLocale, translate } from '../../i18n'
import { track } from '../../achievements/store'
import {
  BUILTIN_WIDGETS, isBuiltinWidget, parsePluginWidgetId, pluginWidgetId, readStoredHomeLayout, saveHomeLayout, sanitizeHomeLayout,
  setHomeEditHandler, subscribeHomeLayout,
} from '../../views/homeWidgets'

/** `ctx.home.track` 收的官方事件名。只许加:插件按名字记。 */
export const HOME_TRACK_EVENTS: readonly string[] = ['home.edit']
/** 有「打开所在 Space」的内置卡(和 homeWidgetKinds 的 BUILTIN_SPACE 同一份口径)。 */
const BUILTIN_OPENS = new Set(['builtin:inbox', 'builtin:notes', 'builtin:sessions'])

type MountMod = typeof import('../../views/homeWidgetMount')
let mod: MountMod | null = null
let modLoad: Promise<MountMod> | null = null
const loadMod = (): Promise<MountMod> => (modLoad ??= import('../../views/homeWidgetMount').then((m) => (mod = m)))

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 一张卡的头信息(非 React 读法)。内置卡标题的词条登记在 homeWidgetKinds 里,它还没载入时先回 id,载入后经 subscribe 通知。 */
export function homeWidgetInfo(id: string, plugins: readonly AmadeusPlugin[]): PluginHomeWidgetInfo {
  if (isBuiltinWidget(id)) {
    const key = `home.w.${id.slice('builtin:'.length)}`
    const title = translate(key)
    return { id, kind: 'builtin', show: true, title: title === key ? '' : title, owner: '', canOpen: BUILTIN_OPENS.has(id) }
  }
  const plug = parsePluginWidgetId(id)
  if (plug) {
    const p = plugins.find((x) => x.id === plug.pluginId)
    const spec = p?.widgets?.find((w) => w.id === plug.widgetId)
    const locale = currentLocale()
    if (!p || !spec || p.blocked) return { id, kind: 'plugin', show: false, title: '', owner: p ? pluginDisplayName(p, locale) : plug.pluginId, canOpen: false }
    return { id, kind: 'plugin', show: true, title: locale === 'en' && spec.titleEn ? spec.titleEn : spec.title, owner: pluginDisplayName(p, locale), canOpen: !!spec.space }
  }
  // Agent 做的卡(w_…):标题要问引擎,画卡头请用 mount(…, { part: 'head' })
  return { id, kind: 'agent', show: /^w_[A-Za-z0-9_-]{1,64}$/.test(id), title: '', owner: '', canOpen: false }
}

/** 依赖由 pluginStore 注入(插件列表与它的订阅),本模块不反引 pluginStore。 */
export interface HomeApiDeps {
  alive: () => boolean
  own: (off: () => void) => () => void
  plugins: () => readonly AmadeusPlugin[]
  subscribePlugins: (cb: () => void) => () => void
}

export function createHomeApi({ alive, own, plugins, subscribePlugins }: HomeApiDeps): PluginHomeApi {
  const info = (id: string): PluginHomeWidgetInfo => homeWidgetInfo(id, plugins())
  // 订了才拉卡头模块:内置卡标题的词条在里面
  const subscribe = (cb: () => void): (() => void) => {
    if (!alive() || typeof cb !== 'function') return () => {}
    const fire = (): void => { if (alive()) cb() }
    const a = subscribePlugins(fire)
    const b = subscribeLocale(fire)
    let live = true
    if (!mod) void loadMod().then(() => { if (live) fire() }, () => {})
    return own(() => { live = false; a(); b() })
  }
  return {
    widget: (id) => info(str(id)),
    library: async () => {
      await loadMod().catch(() => null)
      const fromPlugins = plugins().filter((p) => !p.blocked).flatMap((p) => (p.widgets ?? []).map((w) => pluginWidgetId(p.id, w.id)))
      // 引擎没连上就只少 Agent 做的那几张,不整页失败
      const agent = await listWidgets().then((w) => w.filter((x) => x.entry === 'widget.json'), () => [])
      return [
        ...BUILTIN_WIDGETS.map(info),
        ...fromPlugins.map(info),
        ...agent.map((w): PluginHomeWidgetInfo => ({ id: w.id, kind: 'agent', show: true, title: w.title || w.name, owner: '', canOpen: false })),
      ]
    },
    subscribe,
    mount: (el, id, opts) => {
      if (!(el instanceof HTMLElement)) throw new TypeError('home.mount needs an HTMLElement')
      if (!alive()) return () => {}
      const wid = str(id)
      const pick = (o: PluginHomeMountOptions | undefined): import('../../views/homeWidgetMount').HomeWidgetMountOpts => ({
        part: o?.part === 'head' || o?.part === 'icon' ? o.part : 'body',
        wide: !!o?.wide,
        size: typeof o?.size === 'number' && o.size > 0 ? Math.min(o.size, 64) : 18,
        editing: !!o?.editing,
        onRemove: () => { if (alive()) try { o?.onRemove?.() } catch (e) { console.error('[home] onRemove threw', e) } },
        onComposer: () => { if (alive()) try { o?.onComposer?.() } catch (e) { console.error('[home] onComposer threw', e) } },
      })
      let cur = pick(opts)
      let m: ReturnType<MountMod['mountHomeWidget']> | null = null
      let gone = false
      void loadMod().then((x) => { if (!gone) m = x.mountHomeWidget(el, wid, cur) }, (e) => console.error('[home] widget mount failed', e))
      const off = own(() => { gone = true; m?.dispose(); m = null })
      // 换选项(编辑态进出、宽窄)不重挂:卡里的状态留着
      return Object.assign(() => off(), { update: (next?: PluginHomeMountOptions) => { if (gone) return; cur = pick(next); m?.update(cur) } })
    },
    mountPart: (el, name) => {
      if (!(el instanceof HTMLElement)) throw new TypeError('home.mountPart needs an HTMLElement')
      if (!alive()) return () => {}
      let m: { dispose(): void } | null = null
      let gone = false
      void loadMod().then((x) => { if (!gone) m = x.mountHomePart(el, str(name)) }, (e) => console.error('[home] part mount failed', e))
      return own(() => { gone = true; m?.dispose(); m = null })
    },
    layout: {
      read: () => readStoredHomeLayout() as PluginHomeLayout | null,
      write: (next) => {
        if (!alive()) return sanitizeHomeLayout(readStoredHomeLayout()) as PluginHomeLayout
        saveHomeLayout(sanitizeHomeLayout(next))
        return (readStoredHomeLayout() ?? sanitizeHomeLayout(next)) as PluginHomeLayout
      },
      subscribe: (cb) => {
        if (!alive() || typeof cb !== 'function') return () => {}
        return own(subscribeHomeLayout(() => { if (alive()) cb() }))
      },
    },
    onEditRequest: (cb) => {
      if (!alive() || typeof cb !== 'function') return () => {}
      return own(setHomeEditHandler(() => { if (alive()) try { cb() } catch (e) { console.error('[home] onEditRequest threw', e) } }))
    },
    track: (event) => {
      const e = str(event)
      if (alive() && HOME_TRACK_EVENTS.includes(e)) track(e)
    },
  }
}
