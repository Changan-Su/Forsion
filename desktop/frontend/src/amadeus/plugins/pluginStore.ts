// The plugin host. Holds the plugin registry, the persisted "disabled" preference, the
// runtime active set, and the live contribution registries (slash items / commands /
// themes) that the UI subscribes to. Built-in plugins are registered on init(); external
// (Forsion) plugins are discovered from ~/.forsion/plugins/ and evaluated here.
//
// Trust model: external plugins run with the curated `ctx.app` API (and, like Obsidian,
// full renderer scope). Only install plugins you trust.

import { create } from 'zustand'
import { usePageStore } from '../store/pageStore'
import { useUiStore } from '../store/uiStore'
import { setTheme as applyAccent, toggleMode } from '../theme/ThemeManager'
import { amadeus } from '../api'
import { BUILTIN_PLUGINS } from './builtins'
import { registerPropertyType as registerPropType, unregisterPropertyType as unregisterPropType } from '../blocks/database/propertyTypes'
import { isBuiltinFileType } from '@amadeus-shared/builtinTypes'
import { createBlockSurface } from './blockSurface'
import { registerPluginSeries, track, unregisterPluginAchievements } from '../../achievements/store'
import { act } from '../../activity/log'
import { notifyApp } from '../../stores/notificationStore'
import type {
  AmadeusPlugin,
  CommandContribution,
  EmbedRendererContribution,
  FileCreatorContribution,
  FileTypeContribution,
  PanelContribution,
  PluginAppApi,
  PluginContext,
  PropertyTypeContribution,
  SettingContribution,
  SlashContribution,
  StatusItemContribution,
  ThemeContribution,
  ViewContribution,
} from './types'
import type { ExternalPluginSource } from '@amadeus-shared/ipc'

const DISABLED_KEY = 'amadeus.plugins.disabled'

interface Owned<T> {
  pluginId: string
  item: T
  /** 状态条项专用:本次注册的实例牌(handle 只认牌不认 id)。disable→enable 后旧 handle
   *  持的是旧牌,更新/摘除都打不中新实例(插件在飞的异步任务不会污染重启后的注册)。 */
  token?: object
}

interface PluginState {
  plugins: AmadeusPlugin[]
  /** Persisted preference: ids the user has explicitly turned off (default = enabled). */
  disabledIds: string[]
  /** Runtime: plugins whose setup() has run. */
  activeIds: string[]
  slashItems: Owned<SlashContribution>[]
  commands: Owned<CommandContribution>[]
  themes: Owned<ThemeContribution>[]
  panels: Owned<PanelContribution>[]
  statusItems: Owned<StatusItemContribution>[]
  propertyTypes: Owned<PropertyTypeContribution>[]
  settings: Owned<SettingContribution>[]
  views: Owned<ViewContribution>[]
  fileTypes: Owned<FileTypeContribution>[]
  embedRenderers: Owned<EmbedRendererContribution>[]
  fileCreators: Owned<FileCreatorContribution>[]
  /** 宿主注入的视图打开器(桌面壳=workspace.openView);无工作台的宿主保持 null,ctx.openView 即 no-op。 */
  viewOpener: ((type: string) => void) | null
  setViewOpener(fn: ((type: string) => void) | null): void
  disposers: Record<string, (() => void) | undefined>
  initialized: boolean
  /** 注册并按偏好启用一组插件;缺省 = 全部 builtins(独立版);桌面壳传自己的选择性子集。 */
  init(plugins?: AmadeusPlugin[]): void
  enable(id: string): void
  disable(id: string): void
  toggle(id: string): void
  isActive(id: string): boolean
  loadExternal(): Promise<void>
  reloadExternal(): Promise<void>
  openPluginsFolder(): void
  scaffoldSample(): Promise<void>
}

/** 每个插件一份 app API。块表面是**可吊销**的(见 blockSurface.tsx 的信任边界说明):
 *  teardown 时调 revoke,插件开的订阅/挂的 React root 一并收掉,之后它在飞的异步任务也改不动用户文件。 */
function makeAppApi(pluginId: string): { api: PluginAppApi; revokeSurface: () => void } {
  const surface = createBlockSurface(pluginId)
  const api: PluginAppApi = {
    getActivePage: () => usePageStore.getState().activePage,
    getActivePageText: () =>
      Object.values(usePageStore.getState().blocks)
        .map((b) => b.content)
        .join('\n\n'),
    loadPage: (p) => void usePageStore.getState().loadPage(p),
    createPage: () => void usePageStore.getState().createPage(),
    toggleMode: () => void toggleMode(),
    setTheme: (t) => applyAccent(t),
    openSearch: () => useUiStore.getState().setPalette('search'),
    openSwitcher: () => useUiStore.getState().setPalette('switch'),
    ...surface.api, // 真块表面(mountBlocks/getPage/…):内置与外置插件同一份能力,见 blockSurface.tsx
    notify: (m) => useUiStore.getState().notify(m),
    readFile: (p) => amadeus.readTextFile(p),
    writeFile: (p, text) => amadeus.writeTextFile(p, text),
    // 打开文件类型视图在 amadeusNav(它引 pluginStore 的 matchFileType)→ 动态 import 破静态环。
    openFile: (p) => { void import('../../amadeusNav').then((m) => m.openFile(p)) },
  }
  return { api, revokeSurface: surface.revoke }
}

function injectThemeStyle(id: string, css: string): void {
  const elId = `amadeus-plugin-theme-${id}`
  let el = document.getElementById(elId) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = elId
    document.head.appendChild(el)
  }
  el.textContent = css
}
function removeThemeStyle(id: string): void {
  document.getElementById(`amadeus-plugin-theme-${id}`)?.remove()
}
function readDisabled(): string[] {
  try {
    const v = localStorage.getItem(DISABLED_KEY)
    return v ? (JSON.parse(v) as string[]) : []
  } catch {
    return []
  }
}
function writeDisabled(ids: string[]): void {
  try {
    localStorage.setItem(DISABLED_KEY, JSON.stringify(ids))
  } catch {
    /* ignore */
  }
}

/** 读持久化的禁用插件 id(直读 localStorage,不依赖 store 是否已 init)。
 *  供 userSpaces 在启动装载时过滤「被禁用插件的内嵌 Space」——那一刻插件宿主可能还没装配。 */
export function readDisabledPluginIds(): string[] {
  return readDisabled()
}

/** Wrap an external source as a plugin whose setup() evaluates its code with `ctx`. */
function toPlugin(src: ExternalPluginSource): AmadeusPlugin {
  return {
    id: src.id,
    name: src.name,
    version: src.version,
    description: src.description,
    builtin: false,
    apiVersion: src.apiVersion,
    minAppVersion: src.minAppVersion,
    requiresApp: src.requiresApp,
    readme: src.readme,
    changelog: src.changelog,
    onboarding: src.onboarding,
    blocked: src.blocked,
    bundle: src.bundle,
    events: src.events,
    setup: (ctx) => {
      const fn = new Function('ctx', src.code) as (c: PluginContext) => unknown
      const d = fn(ctx)
      return typeof d === 'function' ? (d as () => void) : undefined
    },
  }
}

export const usePluginStore = create<PluginState>((set, get) => {
  // 每个插件一份 app API(块表面可吊销);teardown 时按 id 吊销。同 id 重新 enable 会覆盖成新的一份,
  // 旧 facade 已在 teardown 里吊销 → 旧代码持有的引用是哑的。
  const revokers: Record<string, (() => void) | undefined> = {}
  const makeContext = (pluginId: string): PluginContext => {
    revokers[pluginId]?.() // 防守:没经 teardown 就重建 context(setup 抛错后重试)也不留旧订阅
    const { api: appApi, revokeSurface } = makeAppApi(pluginId)
    revokers[pluginId] = revokeSurface
    return {
    app: appApi,
    registerSlashItem: (item) => set((s) => ({ slashItems: [...s.slashItems, { pluginId, item }] })),
    registerCommand: (command) =>
      set((s) => ({ commands: [...s.commands, { pluginId, item: command }] })),
    registerTheme: (theme) => {
      injectThemeStyle(theme.id, theme.css)
      set((s) => ({ themes: [...s.themes, { pluginId, item: theme }] }))
    },
    registerPanel: (panel) => set((s) => ({ panels: [...s.panels, { pluginId, item: panel }] })),
    // 全局状态栏项(2026-07-23 复活):同 id 重复注册即覆盖;返回 handle 供原位更新(外置插件轮询改 text)。
    // 渲染在 pluginStatusBridge(id 命名空间 plugin:<pluginId>:<id>);teardown 随其余切片整体清理。
    registerStatusItem: (item) => {
      const token = {}
      set((s) => ({
        statusItems: [
          ...s.statusItems.filter((o) => !(o.pluginId === pluginId && o.item.id === item.id)),
          { pluginId, item, token },
        ],
      }))
      return {
        update: (patch: { text?: string; title?: string }) =>
          set((s) => ({
            statusItems: s.statusItems.map((o) => (o.token === token ? { ...o, item: { ...o.item, ...patch } } : o)),
          })),
        dispose: () => set((s) => ({ statusItems: s.statusItems.filter((o) => o.token !== token) })),
      }
    },
    // 右上角通知(2026-07-23 起):来源自动标插件名;事件 plugin:<id>,用户可在设置里按插件静音。
    notify: (message, opts) =>
      notifyApp({
        text: String(message ?? ''),
        level: opts?.level,
        title: opts?.title ? String(opts.title) : undefined,
        sticky: typeof opts?.sticky === 'boolean' ? opts.sticky : undefined,
        event: `plugin:${pluginId}`,
        sourceLabel: get().plugins.find((p) => p.id === pluginId)?.name || pluginId,
      }),
    registerView: (view) => set((s) => ({ views: [...s.views, { pluginId, item: view }] })),
    // 内置后缀不给注册(内置优先是硬规则,见 isBuiltinFileType)。返回 false 让插件知道自己被内置取代了,
    // 可以整体退让 —— 光靠 find* 那道闸拦不住插件继续贡献重复的「新建 X」右键项和斜杠项。
    // 旧宿主返回 undefined(≠ false),插件的 `if (ok === false) return` 判定天然兼容。
    registerFileType: (def) => {
      const exts = Array.isArray(def?.extensions) ? def.extensions : []
      if (exts.length && exts.every((e) => isBuiltinFileType(String(e)))) {
        console.warn(`[plugin:${pluginId}] registerFileType(${exts.join(',')}) 被拒:该后缀已由 Forsion 内置文件类型认领`)
        return false
      }
      set((s) => ({ fileTypes: [...s.fileTypes, { pluginId, item: def }] }))
      return true
    },
    registerEmbedRenderer: (def) =>
      set((s) => ({ embedRenderers: [...s.embedRenderers, { pluginId, item: def }] })),
    registerFileCreator: (def) =>
      set((s) => ({ fileCreators: [...s.fileCreators, { pluginId, item: def }] })),
    // 打开自己的视图:类型名由宿主统一命名空间(plugin:<id>:<viewId>),防跨插件顶替。
    openView: (viewId) => get().viewOpener?.(`plugin:${pluginId}:${viewId}`),
    registerSetting: (def) => set((s) => ({ settings: [...s.settings, { pluginId, item: def }] })),
    registerPropertyType: (def) => {
      registerPropType(def)
      set((s) => ({ propertyTypes: [...s.propertyTypes, { pluginId, item: def }] }))
    },
    // 成就:注册/计数都在 achievements/store 内强制 plugin:<id>: 前缀(防撞官方 id/伪造官方计数)。
    achievements: {
      registerSeries: (def) => registerPluginSeries(pluginId, def),
      track: (event, n) => track(`plugin:${pluginId}:${event}`, n),
    },
    // 活动日志:同款前缀纪律(插件伪造不了官方事件);拼行/消毒在 main 侧 activityLog.ts。
    activity: {
      log: (event, detail) => act(`plugin:${pluginId}:${event}`, detail),
    },
    }
  }

  /** Run disposer + drop contributions + mark inactive, WITHOUT touching the preference. */
  const teardown = (id: string): void => {
    try {
      get().disposers[id]?.()
    } catch (e) {
      console.error(`[amadeus] plugin "${id}" dispose failed`, e)
    }
    // 块表面的订阅与 React root 不在插件自己的 disposer 里(插件可能压根没写),宿主统一收 ——
    // 收完该插件的 API 整体变哑,它在飞的异步任务改不动用户文件了(codex)。
    try {
      revokers[id]?.()
    } catch (e) {
      console.error(`[amadeus] plugin "${id}" block-surface revoke failed`, e)
    }
    revokers[id] = undefined
    for (const o of get().themes) if (o.pluginId === id) removeThemeStyle(o.item.id)
    for (const o of get().propertyTypes) if (o.pluginId === id) unregisterPropType(o.item.type)
    unregisterPluginAchievements(id)
    set((s) => ({
      activeIds: s.activeIds.filter((x) => x !== id),
      slashItems: s.slashItems.filter((o) => o.pluginId !== id),
      commands: s.commands.filter((o) => o.pluginId !== id),
      themes: s.themes.filter((o) => o.pluginId !== id),
      panels: s.panels.filter((o) => o.pluginId !== id),
      statusItems: s.statusItems.filter((o) => o.pluginId !== id),
      propertyTypes: s.propertyTypes.filter((o) => o.pluginId !== id),
      settings: s.settings.filter((o) => o.pluginId !== id),
      views: s.views.filter((o) => o.pluginId !== id),
      fileTypes: s.fileTypes.filter((o) => o.pluginId !== id),
      embedRenderers: s.embedRenderers.filter((o) => o.pluginId !== id),
      fileCreators: s.fileCreators.filter((o) => o.pluginId !== id),
      disposers: { ...s.disposers, [id]: undefined },
    }))
  }

  const applyPref = (id: string): void => {
    if (!get().disabledIds.includes(id)) get().enable(id)
  }

  return {
    plugins: [],
    disabledIds: [],
    activeIds: [],
    slashItems: [],
    commands: [],
    themes: [],
    panels: [],
    statusItems: [],
    propertyTypes: [],
    settings: [],
    views: [],
    fileTypes: [],
    embedRenderers: [],
    fileCreators: [],
    viewOpener: null,
    setViewOpener: (fn) => set({ viewOpener: fn }),
    disposers: {},
    initialized: false,

    isActive: (id) => get().activeIds.includes(id),

    init(plugins = BUILTIN_PLUGINS) {
      if (get().initialized) return
      set({ plugins: [...plugins], disabledIds: readDisabled(), initialized: true })
      for (const p of plugins) applyPref(p.id)
    },

    enable(id) {
      if (get().activeIds.includes(id)) return
      const plugin = get().plugins.find((p) => p.id === id)
      if (!plugin) return
      if (plugin.blocked) return // 门禁挡下的插件(apiVersion/minAppVersion 不符)任何路径都不得激活
      // 注:DISABLED_KEY 是按 id 的单一全局列表;listPlugins 已按 vault 优先去重,每 id 只有一实例,一位开关即正确。
      let dispose: (() => void) | undefined
      try {
        const r = plugin.setup(makeContext(id))
        if (typeof r === 'function') dispose = r
      } catch (e) {
        console.error(`[amadeus] plugin "${id}" setup failed`, e)
        useUiStore.getState().notify(`插件「${plugin.name}」加载失败`)
        // setup 抛错前可能已注册了主题/成就/属性类型 —— 三者都有 store 外的副作用(注入的 <style>、成就注册表),
        // 只 filter zustand 状态会留下孤儿(禁用的插件主题仍挂在 head 上)。与 teardown 同口径全清。
        for (const o of get().propertyTypes) if (o.pluginId === id) unregisterPropType(o.item.type)
        for (const o of get().themes) if (o.pluginId === id) removeThemeStyle(o.item.id)
        unregisterPluginAchievements(id)
        set((s) => ({
          slashItems: s.slashItems.filter((o) => o.pluginId !== id),
          commands: s.commands.filter((o) => o.pluginId !== id),
          themes: s.themes.filter((o) => o.pluginId !== id),
          panels: s.panels.filter((o) => o.pluginId !== id),
          statusItems: s.statusItems.filter((o) => o.pluginId !== id),
          propertyTypes: s.propertyTypes.filter((o) => o.pluginId !== id),
          settings: s.settings.filter((o) => o.pluginId !== id),
          views: s.views.filter((o) => o.pluginId !== id),
          fileTypes: s.fileTypes.filter((o) => o.pluginId !== id),
          embedRenderers: s.embedRenderers.filter((o) => o.pluginId !== id),
          fileCreators: s.fileCreators.filter((o) => o.pluginId !== id),
        }))
        return
      }
      set((s) => ({
        activeIds: [...s.activeIds, id],
        disabledIds: s.disabledIds.filter((x) => x !== id),
        disposers: { ...s.disposers, [id]: dispose },
      }))
      writeDisabled(get().disabledIds)
    },

    disable(id) {
      if (!get().activeIds.includes(id)) return
      teardown(id)
      set((s) => ({ disabledIds: s.disabledIds.includes(id) ? s.disabledIds : [...s.disabledIds, id] }))
      writeDisabled(get().disabledIds)
    },

    toggle(id) {
      if (get().activeIds.includes(id)) get().disable(id)
      else get().enable(id)
    },

    async loadExternal() {
      let sources: ExternalPluginSource[] = []
      try {
        sources = await amadeus.listPlugins()
      } catch {
        return
      }
      const externals = sources.map(toPlugin)
      set((s) => ({ plugins: [...s.plugins.filter((p) => p.builtin), ...externals] }))
      for (const p of externals) applyPref(p.id)
    },

    async reloadExternal() {
      for (const p of get().plugins) if (!p.builtin && get().activeIds.includes(p.id)) teardown(p.id)
      set((s) => ({ plugins: s.plugins.filter((p) => p.builtin) }))
      await get().loadExternal()
    },

    openPluginsFolder() {
      void amadeus.openPluginsFolder()
    },

    async scaffoldSample() {
      try {
        await amadeus.scaffoldSamplePlugin()
      } catch (e) {
        useUiStore.getState().notify(String(e))
        return
      }
      await get().reloadExternal()
      useUiStore.getState().notify('已创建示例插件 hello-amadeus')
    },
  }
})

// ── 文件类型 / 嵌入渲染的匹配助手（供 amadeusNav、文件树、BlockHost、通用文件视图共用）。
// 组件要响应「插件加载后才注册」须自行订阅 usePluginStore((s) => s.fileTypes / s.embedRenderers) 再调 find*;
// 非响应式调用(nav 路由、视图挂载那一刻)用下面读快照的 match*。

/** 在给定 fileTypes 列表里按路径后缀找命中的文件类型贡献(纯函数,便于组件订阅列表后调用)。
 *  内置文件类型的后缀一律不放行(生态硬规则,见 isBuiltinFileType):遮蔽内置 = 用户打不开内置视图。 */
export function findFileType(
  list: { item: FileTypeContribution }[],
  path: string,
): FileTypeContribution | undefined {
  if (isBuiltinFileType(path)) return undefined
  const n = path.toLowerCase()
  return list.find((o) => o.item.extensions.some((ext) => n.endsWith(ext.toLowerCase())))?.item
}

/** 当前已注册文件类型里匹配 path 的那个(读快照,非响应式)。 */
export function matchFileType(path: string): FileTypeContribution | undefined {
  return findFileType(usePluginStore.getState().fileTypes, path)
}

/** 文件名去掉命中的文件类型后缀(如 `思维导图.mindmap.md` + ['.mindmap.md'] → `思维导图`);兜底剥最后一段扩展名。 */
export function fileTypeBaseName(path: string, extensions: string[]): string {
  const name = path.split(/[\\/]/).pop() || path
  const lower = name.toLowerCase()
  const ext = extensions.find((e) => lower.endsWith(e.toLowerCase()))
  return ext ? name.slice(0, name.length - ext.length) : name.replace(/\.[^.]+$/, '')
}

/** 在给定 embedRenderers 列表里找声称能渲染该 `![[target]]` 的渲染器(match 抛错视为不匹配)。 */
export function findEmbedRenderer(
  list: { item: EmbedRendererContribution }[],
  target: string,
): EmbedRendererContribution | undefined {
  // 内置类型的嵌入由内置渲染,插件 match() 说了不算(同 findFileType)。**别名/宽度也要剥**:
  // BlockHost 会先拿完整 target 问一次 matcher(`|`/`#` 可能是真文件名的一部分),
  // `![[图.mindmap.md|300]]` 原样比后缀是不命中的 —— 不剥这一下插件就从别名语法绕过了这道闸(Codex)。
  if (isBuiltinFileType(target) || isBuiltinFileType(target.split('|')[0].trim())) return undefined
  return list.find((o) => {
    try {
      return o.item.match(target)
    } catch {
      return false
    }
  })?.item
}

/** 当前已注册嵌入渲染器里匹配 target 的那个(读快照,非响应式)。 */
export function matchEmbedRenderer(target: string): EmbedRendererContribution | undefined {
  return findEmbedRenderer(usePluginStore.getState().embedRenderers, target)
}

/** 已启用插件声明的自动化事件(manifest `events`),完整名带 `plugin:<id>:` 前缀——自动化构建器事件目录用(读快照)。 */
export function listPluginAutomationEvents(): { name: string; label?: string }[] {
  const s = usePluginStore.getState()
  const disabled = new Set(s.disabledIds)
  const out: { name: string; label?: string }[] = []
  for (const p of s.plugins) {
    if (disabled.has(p.id) || p.blocked || !p.events?.length) continue
    for (const ev of p.events) out.push({ name: `plugin:${p.id}:${ev.name}`, label: ev.label })
  }
  return out
}
