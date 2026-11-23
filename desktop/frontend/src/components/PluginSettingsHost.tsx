/**
 * 「设置 › 插件设置」的正文(方案 P4,2026-11-18 用户定):每个插件一页 = 宿主画的身份卡 + 只用宿主设置零件画的设置。
 *
 *  - 身份卡:图标、名字、`版本 · 来源(内置 / 商店 / 本地)`,有 Space 可去时给「打开插件」,右端是启用开关。
 *    卸载、自动更新留在「插件」管理页。
 *  - 插件关着:子项照列(灰),这一页只有一张「已停用 · 启用」状态卡;存过的设置不动。
 *  - Forsion 插件的设置来源(旧接口作者一行不改):ctx.registerSettingsPage(数据描述,宿主经 mountPluginSettingsPage 画,
 *    关页 / 停用 / 重载时收尾)→ registerSetting 的行(「通用」组)→ registerSettingsView(每个一组自定义块)。
 *  - 引擎插件:作用域 + manifest 字段,见 PluginSettingsPage.tsx。
 *  - 列表页(左栏「另外 N 个…」):全部有设置的插件 + 筛选。
 * 插件不许仿 `.settings-*` 宿主样式(作者手册写明);这里的零件都是宿主自己的。
 */
import React, { useEffect, useReducer, useRef, useState } from 'react'
import { ArrowRight, ChevronRight, Search, SlidersHorizontal, X } from 'lucide-react'
import { setActiveSpace, useSpaceStore } from '@lcl/engine'
import { pluginWanted, usePluginStore, type HostSettingsPage } from '@amadeus/plugins/pluginStore'
import { AUTO_WORK_FOLDER_KEY, isPlacedSettingsView, pluginDisplayName } from '../amadeus/plugins/display'
import { mountPluginSettingsPage } from '../amadeus/plugins/settingsPageSurface'
import type { AmadeusPlugin, SettingContribution, SettingsViewContribution } from '../amadeus/plugins/types'
import { dependentsOf, unmetDependencies } from '../amadeus/plugins/pluginDeps'
import { usePluginOnboarding } from '../stores/pluginOnboardingStore'
import { pluginOfSpace } from '../userSpaces'
import { windowKind } from '../windowKind'
import { registerMessages, useI18n } from '../i18n'
import { setPluginEnabled, type PluginInfo } from '../services/backendService'
import { homeTarget } from '../services/engine/targets'
import type { NormalAgentDef, TanguDesktopConfig } from '../types'
import { MARKET_ITEM_ID } from '../../../shared/products'
import type { PluginSettingsPageSchema, PluginSettingsState } from '../../../shared/settingsPage'
import { PluginEnableSwitch, canTurnOnPlugin, turnOnPlugin } from './AmadeusPluginsTab'
import { PluginLogo } from './PluginLogo'
import { PluginSettingsPage } from './PluginSettingsPage'
import { SettingsPage } from './SettingsPage'
import { SettingsPanel, SettingsRow } from './SettingsPrimitives'
import { ReasonSwitch, reportEnginePluginToggle, type LifecycleReason } from './PluginReasons'
import { panelToast } from './PanelNotice'
import { forsionSettingsGroup, settingsViewGroups } from './pluginSettingsSchema'
import { matchPluginSettingsEntry, type PluginSettingsEntry } from './pluginSettingsNav'
import './pluginSettings.css'

registerMessages({
  'plugsettings.all': { zh: '全部插件 · {n}', en: 'All plugins · {n}' },
  'plugsettings.allDesc': { zh: '点一个插件打开它的设置。', en: 'Pick a plugin to open its settings.' },
  'plugsettings.filter': { zh: '筛选插件', en: 'Filter plugins' },
  'plugsettings.noMatch': { zh: '没有匹配的插件', en: 'No matching plugins' },
  'plugsettings.source.builtin': { zh: '内置', en: 'Built-in' },
  'plugsettings.source.store': { zh: '商店', en: 'Store' },
  'plugsettings.source.local': { zh: '本地', en: 'Local' },
  'plugsettings.open': { zh: '打开插件', en: 'Open plugin' },
  'plugsettings.disabled.title': { zh: '已停用', en: 'Disabled' },
  'plugsettings.disabled.desc': { zh: '启用后才能修改它的设置，存过的设置会保留。', en: 'Turn it on to change its settings. Saved settings are kept.' },
  'plugsettings.disabled.bundle': { zh: '它随所在的插件包一起启停，去「插件」页打开那个包。', en: 'It turns on and off with its plugin bundle. Turn the bundle on in Plugins.' },
  'plugsettings.enable': { zh: '启用', en: 'Enable' },
  'plugsettings.notRunning.title': { zh: '插件没有在运行', en: "This plugin isn't running" },
  'plugsettings.notRunning.desc': {
    zh: '它开着，但还没运行起来：可能在等前置插件，或者加载失败了。原因在「插件」页它的详情里。',
    en: "It's on but not running yet. It may be waiting for a required plugin, or it failed to load. Its details in Plugins say why.",
  },
  'plugsettings.viewFallback': { zh: '更多设置', en: 'More settings' },
})

type Source = 'builtin' | 'store' | 'local'
export function forsionPluginSource(p: Pick<AmadeusPlugin, 'id' | 'dir' | 'builtin' | 'preinstalled' | 'locked'>): Source {
  if (p.builtin || p.preinstalled || p.locked) return 'builtin'
  return [p.dir, p.id].some((x) => !!x && MARKET_ITEM_ID.test(x)) ? 'store' : 'local'
}
export function enginePluginSource(pl: Pick<PluginInfo, 'id' | 'source'>): Source {
  if (pl.source === 'builtin') return 'builtin'
  return MARKET_ITEM_ID.test(pl.id) ? 'store' : 'local'
}
/** 身份卡第二行:`v1.4.2 · 商店`。 */
export function pluginMetaLine(t: (k: string) => string, version: string | undefined, source: Source): string {
  return [version ? `v${version}` : '', t(`plugsettings.source.${source}`)].filter(Boolean).join(' · ')
}

/** 去插件的 Space:设置在独立浮窗里时交给主窗切(Root 的 open-space),同窗时直接切;然后关掉设置。 */
function openPluginSpace(spaceId: string, close?: () => void): void {
  if (windowKind() !== 'main' && window.tangu?.requestMainAction) window.tangu.requestMainAction('open-space', spaceId)
  else setActiveSpace(spaceId)
  close?.()
}

/** 身份卡:宿主的分组面板只用卡头那一行(没有正文)。 */
export function PluginIdentityCard({ logo, name, meta, onOpen, toggle, pluginId }: {
  logo: React.ReactNode
  name: string
  meta: string
  onOpen?: () => void
  toggle?: React.ReactNode
  pluginId: string
}) {
  const { t } = useI18n()
  const actions = onOpen || toggle ? (
    <>
      {onOpen && <button type="button" className="btn ghost sm" data-plugin-open onClick={onOpen}>{t('plugsettings.open')}<ArrowRight size={12} /></button>}
      {toggle}
    </>
  ) : undefined
  return (
    <div data-plugin-identity={pluginId}>
      <SettingsPanel className="plugin-settings-identity" icon={logo} title={name} description={meta} actions={actions} />
    </div>
  )
}

/** 整页状态卡(已停用 / 没在运行):宿主的状态零件,外面一层卡片底。 */
function StateCard({ state, kind }: { state: PluginSettingsState; kind: string }) {
  return <div className="plugin-settings-statecard" data-plugin-settings-state={kind}><SettingsPage schema={{ state }} /></div>
}

/** 每份注册(对象身份)一个代号:插件重注册同 id = 新对象 = 重新挂。 */
const generations = new WeakMap<object, number>()
let nextGeneration = 0
const generationOf = (o: object): number => {
  let g = generations.get(o)
  if (g === undefined) { g = ++nextGeneration; generations.set(o, g) }
  return g
}

/** ctx.registerSettingsPage 的一页:与 ctx.ui.mountSettingsPage 同一套挂载(mountHostReact + 宿主语言 + rev 语义)。
 *  关页 / 插件停用(页从切片里摘掉 → 本组件卸载)/ 重载:先调插件的收尾,再卸宿主那棵树;之后插件留下的回调一律不再调。 */
export function RegisteredSettingsPage({ pluginId, page }: { pluginId: string; page: HostSettingsPage }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let live = true
    const alive = (): boolean => live && page.alive()
    const handle = mountPluginSettingsPage(el, { groups: [] }, alive)
    let off: unknown
    try {
      off = page.mount({
        update(schema: PluginSettingsPageSchema) {
          if (!alive()) return
          const ok = !!schema && typeof schema === 'object' && (Array.isArray(schema.groups) || (!!schema.state && typeof schema.state === 'object'))
          if (!ok) { console.error(`[amadeus] plugin "${pluginId}" settings page update needs { groups: [...] } or { state }`); return }
          handle.update(schema)
        },
      })
    } catch (e) {
      console.error(`[amadeus] plugin "${pluginId}" settings page mount failed`, e)
    }
    return () => {
      live = false
      if (typeof off === 'function') {
        try { (off as () => void)() } catch (e) { console.error(`[amadeus] plugin "${pluginId}" settings page cleanup threw`, e) }
      }
      handle.dispose()
    }
  }, [pluginId, page])
  return <div ref={ref} className="plugin-settings-registered" data-plugin-settings-page={`${pluginId}:${page.id}`} />
}

const settingKey = (pluginId: string, key: string): string => `plugin.${pluginId}.${key}`
/** registerSetting 的值:全存字符串(同 AmadeusPluginsTab.SettingRow);没存过 = 缺省值。 */
function readSetting(pluginId: string, def: SettingContribution): string {
  try {
    const raw = localStorage.getItem(settingKey(pluginId, def.key))
    return raw === null ? String(def.default) : raw
  } catch { return String(def.default) }
}
function writeSetting(pluginId: string, def: SettingContribution, next: string): void {
  try {
    if (next === String(def.default)) localStorage.removeItem(settingKey(pluginId, def.key)) // 回到默认 = 清键,插件端 || default 兜底
    else localStorage.setItem(settingKey(pluginId, def.key), next)
  } catch { /* 配额满等,忽略 */ }
  // 前置条件里可能有这一项(setting 类):徽标 / 检查卡的对勾要跟着这一笔走
  void usePluginOnboarding.getState().evaluate(pluginId)
}

/** registerSettingsView 的面板挂进自定义块:mount 抛错就清空;收尾抛错只记一行,块里不留残渣。 */
const mountView = (pluginId: string, def: SettingsViewContribution) => (el: HTMLElement): (() => void) => {
  let off: unknown
  try { off = def.mount(el) } catch (e) {
    console.error(`[amadeus] 插件 ${pluginId} 的设置面板 mount 抛错`, e)
    el.textContent = ''
    return () => {}
  }
  return () => {
    try { if (typeof off === 'function') (off as () => void)() } catch (e) { console.error(`[amadeus] 插件 ${pluginId} 的设置面板 dispose 抛错`, e) }
    el.textContent = ''
  }
}

/** Forsion 插件的设置页(`fplugin:<id>`)。 */
export function ForsionPluginSettingsPage({ plugin: p, onEngineReload, onClose }: { plugin: AmadeusPlugin; onEngineReload?: () => void; onClose?: () => void }) {
  const { t, locale } = useI18n()
  const activeIds = usePluginStore((s) => s.activeIds)
  const disabledIds = usePluginStore((s) => s.disabledIds)
  const allSettings = usePluginStore((s) => s.settings)
  const allViews = usePluginStore((s) => s.settingsViews)
  const allPages = usePluginStore((s) => s.settingsPages)
  const spaces = useSpaceStore((s) => s.spaces)
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const active = activeIds.includes(p.id)
  const wanted = pluginWanted(p, disabledIds)
  const name = isPluginExtend(p) ? 'Forsion Extend' : pluginDisplayName(p, locale)
  const space = active ? spaces.find((s) => pluginOfSpace(s.id) === p.id) : undefined

  const identity = (
    <PluginIdentityCard pluginId={p.id} logo={<PluginLogo url={p.iconUrl} size={40} />} name={name}
      meta={pluginMetaLine(t, p.version, forsionPluginSource(p))}
      onOpen={space ? () => openPluginSpace(space.id, onClose) : undefined}
      toggle={<PluginEnableSwitch p={p} onEngineReload={onEngineReload} />} />
  )
  if (!wanted) {
    return (
      <div className="plugin-settings-host" data-plugin-settings={p.id}>
        {identity}
        <StateCard kind="disabled" state={{
          kind: 'empty', icon: 'lock', title: t('plugsettings.disabled.title'), desc: t('plugsettings.disabled.desc'),
          ...(canTurnOnPlugin(p) ? { action: { label: t('plugsettings.enable'), kind: 'primary' as const, onClick: () => turnOnPlugin(p, t, locale, onEngineReload) } } : {}),
        }} />
      </div>
    )
  }
  if (!active) {
    return (
      <div className="plugin-settings-host" data-plugin-settings={p.id}>
        {identity}
        <StateCard kind="not-running" state={{ kind: 'empty', icon: 'warning', title: t('plugsettings.notRunning.title'), desc: t('plugsettings.notRunning.desc') }} />
      </div>
    )
  }
  const pages = allPages.filter((o) => o.pluginId === p.id).map((o) => o.item)
  const rows = allSettings.filter((o) => o.pluginId === p.id).map((o) => o.item)
  const views = allViews.filter((o) => o.pluginId === p.id && !isPlacedSettingsView(p, o.item)).map((o) => o.item)
  const general = forsionSettingsGroup(rows, {
    generalTitle: t('plugsettings.general'),
    read: (def) => readSetting(p.id, def),
    write: (def, next) => { writeSetting(p.id, def, next); bump() },
  }, AUTO_WORK_FOLDER_KEY)
  const viewGroups = settingsViewGroups(views, {
    fallbackTitle: t('plugsettings.viewFallback'),
    idOf: (def) => `${def.id}#${generationOf(def)}`,
    mount: (def) => mountView(p.id, def),
  })
  return (
    <div className="plugin-settings-host" data-plugin-settings={p.id}>
      {identity}
      {pages.map((pg) => <RegisteredSettingsPage key={`${pg.id}#${generationOf(pg)}`} pluginId={p.id} page={pg} />)}
      {general && <SettingsPage schema={{ groups: [general] }} />}
      {viewGroups.length > 0 && <div className="plugin-settings-views"><SettingsPage schema={{ groups: viewGroups }} /></div>}
    </div>
  )
}

const isPluginExtend = (p: AmadeusPlugin): boolean => p.id === 'forsion-extend' && !!p.locked

/** 引擎插件的设置页(`plugin:<id>`)。开关与「插件 › 引擎插件」列表同一个动作(关之前说清会跟着停的依赖方,前置没齐开不了)。 */
export function EnginePluginSettingsHostPage({ plugin: pl, plugins, agents, cfg, onReload }: {
  plugin: PluginInfo
  plugins: PluginInfo[]
  agents: NormalAgentDef[]
  cfg?: TanguDesktopConfig
  onReload: () => void
}) {
  const { t, locale } = useI18n()
  const amPlugins = usePluginStore((s) => s.plugins)
  const [busy, setBusy] = useState(false)
  const nm = (x: PluginInfo): string => (locale === 'en' && x.nameEn ? x.nameEn : x.name)
  // Forsion 捆绑包里带的引擎插件随父插件启停(插件页那一行也不给开关),这里同样只说明、不给开关
  const bundleOwned = pl.source === 'folder' && amPlugins.some((x) => x.bundle?.enginePlugins?.includes(pl.id))
  const nodes = plugins.map((x) => ({ id: x.id, version: x.version ?? '', requiresPlugins: x.requiresPlugins }))
  const byId = (id: string): PluginInfo | undefined => plugins.find((x) => x.id === id)
  const running = (x: PluginInfo): boolean => x.active ?? x.enabled
  const self = nodes.find((n) => n.id === pl.id)
  const missing = !pl.enabled && self ? unmetDependencies(self, nodes, (id) => { const q = byId(id); return !!q && running(q) }, (id) => !!byId(id)?.enabled) : []
  const flip = async (reason?: LifecycleReason): Promise<void> => {
    const deps = pl.enabled ? dependentsOf(pl.id, nodes).map((n) => byId(n.id)).filter((x): x is PluginInfo => !!x && running(x)) : []
    if (deps.length && !window.confirm(t('settings.plugins.disableDependents', { name: nm(pl), list: deps.map(nm).join(t('common.listSep')) }))) return
    setBusy(true)
    try {
      await setPluginEnabled(homeTarget(), pl.id, !pl.enabled)
      reportEnginePluginToggle(pl, !pl.enabled, reason) // 匿名遥测 plugin_lifecycle(v3 补漏)
      onReload()
    } catch (e) { panelToast(e instanceof Error ? e.message : String(e), true) } finally { setBusy(false) }
  }
  const canFlip = !bundleOwned && !(missing.length > 0)
  const identity = (
    <PluginIdentityCard pluginId={pl.id} logo={<PluginLogo url={pl.iconUrl} size={40} />} name={nm(pl)}
      meta={pluginMetaLine(t, pl.version, enginePluginSource(pl))}
      toggle={bundleOwned ? undefined : <ReasonSwitch data-plugin-switch="" checked={pl.enabled} disabled={busy || !canFlip && !pl.enabled} label={nm(pl)} onChange={(_on, reason) => void flip(reason)} />} />
  )
  return (
    <div className="plugin-settings-host" data-plugin-settings={`engine:${pl.id}`}>
      {identity}
      {pl.enabled
        ? <PluginSettingsPage cfg={cfg} plugin={pl} agents={agents} />
        : <StateCard kind="disabled" state={{
          kind: 'empty', icon: 'lock', title: t('plugsettings.disabled.title'),
          desc: bundleOwned ? t('plugsettings.disabled.bundle') : t('plugsettings.disabled.desc'),
          ...(canFlip ? { action: { label: t('plugsettings.enable'), kind: 'primary' as const, onClick: () => void flip() } } : {}),
        }} />}
    </div>
  )
}

/** 列表页(左栏「另外 N 个…」进来):全部有设置的插件 + 筛选。 */
export function PluginSettingsDirectory({ entries, onOpen }: { entries: readonly PluginSettingsEntry[]; onOpen(tab: PluginSettingsEntry['tab']): void }) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const list = entries.filter((e) => matchPluginSettingsEntry(e, query))
  return (
    <SettingsPanel className="plugin-settings-directory" icon={<SlidersHorizontal size={16} />} title={t('plugsettings.all', { n: entries.length })} description={t('plugsettings.allDesc')}>
      <div className="settings-panel-toolbar">
        <label className="settings-filter-input">
          <Search size={13} />
          <input type="search" value={query} placeholder={t('plugsettings.filter')} aria-label={t('plugsettings.filter')} onChange={(e) => setQuery(e.target.value)} />
          {query && <button type="button" aria-label={t('common.cancel')} onClick={() => setQuery('')}><X size={12} /></button>}
        </label>
      </div>
      {list.length === 0
        ? <div className="settings-empty-row" role="status">{t('plugsettings.noMatch')}</div>
        : (
          <div className="settings-control-list">
            {list.map((e) => (
              <SettingsRow key={e.tab} anchor={`plugin-settings-entry-${e.tab}`} fit="inline" className={e.enabled ? undefined : 'plugin-settings-off'}
                label={e.name} description={[e.meta, e.enabled ? '' : t('plugsettings.disabled.title')].filter(Boolean).join(' · ') || undefined}
                control={<button type="button" className="btn ghost sm" data-plugin-settings-open={e.tab} onClick={() => onOpen(e.tab)}>{t('plugsettings.openLink')}<ChevronRight size={12} /></button>} />
            ))}
          </div>
        )}
    </SettingsPanel>
  )
}
