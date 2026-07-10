// The plugin host. Holds the plugin registry, the persisted "disabled" preference, the
// runtime active set, and the live contribution registries (slash items / commands /
// themes) that the UI subscribes to. Built-in plugins are registered on init(); external
// (user) plugins are discovered per-vault from .amadeus/plugins/ and evaluated here.
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
import { registerPluginSeries, track, unregisterPluginAchievements } from '../../achievements/store'
import type {
  AmadeusPlugin,
  CommandContribution,
  PanelContribution,
  PluginAppApi,
  PluginContext,
  PropertyTypeContribution,
  SlashContribution,
  StatusItemContribution,
  ThemeContribution,
} from './types'
import type { ExternalPluginSource } from '@amadeus-shared/ipc'

const DISABLED_KEY = 'amadeus.plugins.disabled'

interface Owned<T> {
  pluginId: string
  item: T
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

function makeAppApi(): PluginAppApi {
  return {
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
    notify: (m) => useUiStore.getState().notify(m),
  }
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

/** Wrap an external source as a plugin whose setup() evaluates its code with `ctx`. */
function toPlugin(src: ExternalPluginSource): AmadeusPlugin {
  return {
    id: src.id,
    name: src.name,
    version: src.version,
    description: src.description,
    builtin: false,
    source: src.source,
    apiVersion: src.apiVersion,
    minAppVersion: src.minAppVersion,
    blocked: src.blocked,
    setup: (ctx) => {
      const fn = new Function('ctx', src.code) as (c: PluginContext) => unknown
      const d = fn(ctx)
      return typeof d === 'function' ? (d as () => void) : undefined
    },
  }
}

export const usePluginStore = create<PluginState>((set, get) => {
  const appApi = makeAppApi()
  const makeContext = (pluginId: string): PluginContext => ({
    app: appApi,
    registerSlashItem: (item) => set((s) => ({ slashItems: [...s.slashItems, { pluginId, item }] })),
    registerCommand: (command) =>
      set((s) => ({ commands: [...s.commands, { pluginId, item: command }] })),
    registerTheme: (theme) => {
      injectThemeStyle(theme.id, theme.css)
      set((s) => ({ themes: [...s.themes, { pluginId, item: theme }] }))
    },
    registerPanel: (panel) => set((s) => ({ panels: [...s.panels, { pluginId, item: panel }] })),
    registerStatusItem: (item) =>
      set((s) => ({ statusItems: [...s.statusItems, { pluginId, item }] })),
    registerPropertyType: (def) => {
      registerPropType(def)
      set((s) => ({ propertyTypes: [...s.propertyTypes, { pluginId, item: def }] }))
    },
    // 成就:注册/计数都在 achievements/store 内强制 plugin:<id>: 前缀(防撞官方 id/伪造官方计数)。
    achievements: {
      registerSeries: (def) => registerPluginSeries(pluginId, def),
      track: (event, n) => track(`plugin:${pluginId}:${event}`, n),
    },
  })

  /** Run disposer + drop contributions + mark inactive, WITHOUT touching the preference. */
  const teardown = (id: string): void => {
    try {
      get().disposers[id]?.()
    } catch (e) {
      console.error(`[amadeus] plugin "${id}" dispose failed`, e)
    }
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
        for (const o of get().propertyTypes) if (o.pluginId === id) unregisterPropType(o.item.type)
        set((s) => ({
          slashItems: s.slashItems.filter((o) => o.pluginId !== id),
          commands: s.commands.filter((o) => o.pluginId !== id),
          themes: s.themes.filter((o) => o.pluginId !== id),
          panels: s.panels.filter((o) => o.pluginId !== id),
          statusItems: s.statusItems.filter((o) => o.pluginId !== id),
          propertyTypes: s.propertyTypes.filter((o) => o.pluginId !== id),
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
