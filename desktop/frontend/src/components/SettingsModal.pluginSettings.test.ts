// @vitest-environment happy-dom
/**
 * 「设置 › 扩展 › 插件设置」左栏(方案 P4,2026-11-18)跑真 SettingsModal(无关子页桩掉,同 SettingsModal.connection.test):
 *  - 插件不再各占一级项:引擎插件与 Forsion 插件(开着的、关着但见过设置的)都收在「插件设置」父项下,缺省展开,按名字排,关着的灰;
 *  - 超过 8 个:列 5 个 + 「另外 N 个…」(进列表页);
 *  - 子项 / 深链落到各自的设置页;没有设置的 Forsion 插件深链照旧落详情面;
 *  - 左栏搜索按插件名 / 别名找到子项;手机一级列表同一份子项。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../i18n.generated'
import { LocaleProvider, setLocaleGlobal } from '../i18n'

const fx = vi.hoisted(() => ({
  engine: [] as unknown[],
  store: { plugins: [], activeIds: [], disabledIds: [], settings: [], settingsViews: [], settingsPages: [] } as Record<string, unknown>,
}))

vi.mock('../product', () => ({ PRODUCT: { agentBackend: true }, PRODUCT_DISPLAY_NAME: 'Forsion' }))
// 桌面端打开设置会顺带拉插件 / MCP / 同步状态等:本文件不关心,一律给空结果(listModels 给空目录)。
vi.mock('../services/backendService', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(actual)) out[k] = typeof v === 'function' ? vi.fn().mockRejectedValue(new Error('not in this fixture')) : v
  out.listModels = vi.fn().mockResolvedValue({ models: [], directProviders: [] })
  out.listPlugins = vi.fn(async () => fx.engine)
  out.listAgents = vi.fn().mockResolvedValue([])
  return out
})
vi.mock('../services/agentRunService', () => ({}))
vi.mock('../services/sessionLog', () => ({}))
vi.mock('../services/ttsService', () => ({}))
vi.mock('../achievements/store', () => ({ track: vi.fn() }))
vi.mock('../stores/themeStore', () => ({ useTheme: (pick: any) => pick({ bg: 'cream', bgSeed: '', setBg: vi.fn(), setBgSeedValue: vi.fn() }) }))
vi.mock('../stores/appStore', () => ({ useApp: Object.assign(vi.fn(), { getState: () => ({ cfg: {} }) }) }))
vi.mock('../theme/registry', () => ({ listLanguages: () => [], listSkins: () => [], forcedSchemeForLanguage: () => null }))
vi.mock('../fontPresets', () => ({ listFonts: () => [] }))
vi.mock('../uiFont', () => ({ readFont: () => '', applyUiFonts: vi.fn(), writeFont: vi.fn() }))
vi.mock('../uiZoom', () => ({ getUiZoom: () => 1, setUiZoom: vi.fn() }))
vi.mock('../smoothCaret', () => ({ isSmoothCaretOn: () => false }))
vi.mock('../mobileUiCommand', () => ({}))
vi.mock('../activityViewCommand', () => ({}))
vi.mock('../activeWindowCommand', () => ({}))
vi.mock('../changelog', () => ({ APP_VERSION: '2.10.1', CHANGELOG: [] }))
vi.mock('../views/ChangelogView', () => ({ ChangelogEntries: () => null, releaseNotesFor: () => undefined }))
vi.mock('@lcl/engine', () => ({ UI_MODE: 'desktop', UI_ZOOM_EVENT: 'zoom', useWorkspace: vi.fn(), useNativeChromeClaim: () => {}, useNativeChromeInstalled: () => false }))
vi.mock('@amadeus/plugins/pluginStore', () => ({
  usePluginStore: (pick: any) => pick(fx.store),
  pluginWanted: (p: { id: string }, disabled: readonly string[]) => !disabled.includes(p.id),
}))
vi.mock('@amadeus/lib/wikiFiles', () => ({}))
vi.mock('@amadeus/lib/upgradeV4', () => ({}))
vi.mock('@amadeus/components/askDeleteAssets', () => ({ deleteAssetsPref: () => 'ask' }))
vi.mock('@amadeus/unified/canvasPrefs', () => ({ canvasDoubleClickFocusEnabled: () => true, canvasOverviewZoom: () => 1 }))
vi.mock('./ThemeCard', () => ({ ThemeCard: () => null }))
vi.mock('./ThemePreview', () => ({ ThemePreview: () => null }))
vi.mock('./ThemeSettingsPanel', () => ({ ThemeSettingsPanel: () => null }))
vi.mock('./BrandLogo', () => ({ BrandLogo: () => null }))
vi.mock('./LocaleToggle', () => ({ LocaleToggle: () => null }))
vi.mock('./Markdown', () => ({ Markdown: () => null }))
vi.mock('./AsrModelChoice', () => ({ AsrModelChoice: () => React.createElement('div', { 'data-speech-step': true }) }))
vi.mock('./EnvProbeSection', () => ({ EnvProbeSection: () => null }))
vi.mock('./AccountSwitcher', () => ({ AccountSwitcher: () => null }))
vi.mock('./ChannelsTab', () => ({ ChannelsTab: () => null }))
vi.mock('./RemoteSyncSection', () => ({ RemoteSyncSection: () => null, openPenzorSync: () => {}, penzorSyncReady: () => false }))
vi.mock('./UpdateActions', () => ({ UpdateActions: () => null }))
vi.mock('./ModelGroupList', () => ({ ModelGroupList: () => null }))
vi.mock('./ModelSelect', () => ({ ModelSelect: () => null }))
vi.mock('./AgentsTab', () => ({ AgentsTab: () => null }))
vi.mock('./SpecialAgentsTab', () => ({ SpecialAgentsTab: () => null }))
vi.mock('./TtsVoiceStudio', () => ({ TtsVoiceStudio: () => null }))
vi.mock('./ShortcutsTab', () => ({ ShortcutsTab: () => null }))
vi.mock('./PluginsTab', () => ({ PluginsTab: () => null }))
vi.mock('./AmadeusPluginsTab', () => ({ AmadeusPluginsTab: (p: any) => React.createElement('div', { 'data-detail': p.controlledDetail?.id ?? '' }) }))
vi.mock('./SpacesTab', () => ({ SpacesTab: () => null }))
vi.mock('./NotificationsTab', () => ({ NotificationsTab: () => null, StatusBarTab: () => null }))
vi.mock('./HooksTab', () => ({ HooksTab: () => null }))
vi.mock('./PluginSettingsPage', () => ({ PluginSettingsPage: () => null }))
vi.mock('./PluginSettingsHost', () => ({
  EnginePluginSettingsHostPage: (p: any) => React.createElement('div', { 'data-engine-page': p.plugin.id }),
  ForsionPluginSettingsPage: (p: any) => React.createElement('div', { 'data-forsion-page': p.plugin.id }),
  PluginSettingsDirectory: (p: any) => React.createElement('div', { 'data-directory': p.entries.map((e: any) => e.tab).join(',') }),
  enginePluginSource: () => 'local', forsionPluginSource: () => 'local', pluginMetaLine: () => '',
}))
vi.mock('./AgentClisTab', () => ({ AgentClisTab: () => null }))

const { SettingsModal } = await import('./SettingsModal')
let host: HTMLDivElement
let root: Root
const props = { themeLang: 'lovable', themeSkin: 'cream', themeMode: 'light' as const, themeModePref: 'light' as const, themeSeed: '', onThemeChange: vi.fn(), onSeedChange: vi.fn() }
const engine = (id: string, name: string, enabled = true) => ({ id, name, description: '', scopes: ['global'], settings: { fields: [{ key: 'k', type: 'toggle', label: 'K' }] }, source: 'folder', enabled })
const fp = (id: string, name: string) => ({ id, name, version: '1.0.0' })
const row = (pluginId: string) => ({ pluginId, item: { key: 'x', type: 'boolean', label: 'X', default: false } })

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  setLocaleGlobal('zh')
  window.tangu = { getConfig: vi.fn().mockResolvedValue({ mode: 'managed' }), backendStatus: vi.fn().mockResolvedValue({ state: 'ready' }) } as unknown as Window['tangu']
  ;(window as any).amadeus = {}
  fx.engine = [engine('weather', '天气'), engine('git-panel', 'Git 面板', false), { ...engine('nosettings', '无设置'), settings: null }]
  // pomodoro 开着有设置;clipper 关着但以前见过设置;quiet 开着却只有自动那行工作文件夹(不算)
  localStorage.setItem('forsion.pluginSettings.known', JSON.stringify(['clipper']))
  fx.store = {
    plugins: [fp('pomodoro', '番茄钟'), fp('clipper', 'Clipper'), fp('quiet', '安静')],
    activeIds: ['pomodoro', 'quiet'], disabledIds: ['clipper'],
    settings: [row('pomodoro'), { pluginId: 'quiet', item: { key: 'workFolder', type: 'text', label: 'W', default: '' } }],
    settingsViews: [], settingsPages: [{ pluginId: 'pomodoro', item: { id: 'main', title: '番茄钟', keywords: 'timer focus' } }],
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  delete window.tangu
  delete (window as any).amadeus
})
const render = (initialTab?: string) => act(async () => root.render(React.createElement(LocaleProvider, {
  children: React.createElement(SettingsModal, { ...props, open: true, initialTab, cfg: { backendUrl: 'http://x', token: 't', modelId: '' }, flatOn: false, onFlatChange: vi.fn(), glassOn: true, onClose: vi.fn(), onConfigChange: vi.fn(), onGlassChange: vi.fn(), onReconnect: vi.fn() } as any),
})))
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const navParent = (label: string) => [...host.querySelectorAll<HTMLElement>('.settings-nav .settings-nav-parent')].find((p) => p.querySelector(':scope > button span')?.textContent === label)
const children = () => [...(navParent('插件设置')?.querySelectorAll<HTMLElement>('.settings-nav-subitem') ?? [])]

it('插件收进「插件设置」父项:缺省展开、按名字排、关着的灰;没有设置的不列,插件不再是一级项', async () => {
  await render()
  await settle()
  const parent = navParent('插件设置')
  expect(parent, '扩展组里有「插件设置」').toBeTruthy()
  expect(parent!.querySelector(':scope > button')!.getAttribute('aria-expanded')).toBe('true')
  // 中文界面按拼音排(ICU 的 zh 排序:汉字在前、拉丁字母在后)
  expect(children().map((c) => c.dataset.settingsNavChild)).toEqual(['fplugin:pomodoro', 'plugin:weather', 'fplugin:clipper', 'plugin:git-panel'])
  expect(children().filter((c) => c.classList.contains('settings-nav-subitem--off')).map((c) => c.dataset.settingsNavChild)).toEqual(['fplugin:clipper', 'plugin:git-panel'])
  const firstLevel = [...host.querySelectorAll('.settings-nav .settings-nav-parent > button span')].map((n) => n.textContent)
  for (const name of ['番茄钟', '天气', 'Clipper', '安静', '无设置']) expect(firstLevel).not.toContain(name)
  // 手机一级列表:同一份子项
  expect([...host.querySelectorAll<HTMLElement>('.settings-mobile-subrow')].map((b) => b.dataset.settingsSub)).toEqual(expect.arrayContaining(['fplugin:clipper', 'plugin:weather', 'fplugin:pomodoro']))
})

it('点子项落到各自的设置页;父项保持「在这一支上」', async () => {
  await render()
  await settle()
  await act(async () => children().find((c) => c.dataset.settingsNavChild === 'fplugin:pomodoro')!.click())
  expect(host.querySelector('[data-forsion-page="pomodoro"]')).not.toBeNull()
  expect(host.querySelector('.settings-main-title')?.textContent).toBe('番茄钟')
  expect(navParent('插件设置')!.querySelector(':scope > button')!.className).toBe('has-active')
  await act(async () => children().find((c) => c.dataset.settingsNavChild === 'plugin:git-panel')!.click())
  expect(host.querySelector('[data-engine-page="git-panel"]')).not.toBeNull()
})

it('深链:fplugin 有设置 → 设置页;没有设置 → 照旧详情面', async () => {
  await render('fplugin:pomodoro')
  await settle()
  expect(host.querySelector('[data-forsion-page="pomodoro"]')).not.toBeNull()
  await act(async () => root.unmount())
  root = createRoot(host)
  await render('fplugin:quiet')
  await settle()
  expect(host.querySelector('[data-forsion-page]')).toBeNull()
  expect(host.querySelector('[data-detail="quiet"]')).not.toBeNull()
})

it('超过 8 个:列 5 个 + 「另外 N 个…」,点它进列表页', async () => {
  fx.engine = 'ABCDEFGHIJ'.split('').map((n) => engine(n.toLowerCase(), `插件${n}`))
  await render()
  await settle()
  const list = children()
  expect(list).toHaveLength(6)
  const more = list[5]
  expect(more.textContent).toBe('另外 7 个…')
  await act(async () => more.click())
  expect(host.querySelector('[data-directory]')?.getAttribute('data-directory')?.split(',')).toHaveLength(12)
  expect(host.querySelector('.settings-main-title')?.textContent).toBe('插件设置')
})

it('左栏搜索按插件名 / 别名找到子项', async () => {
  await render()
  await settle()
  const input = host.querySelector<HTMLInputElement>('.settings-nav-search input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'timer')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(children().map((c) => c.dataset.settingsNavChild)).toEqual(['fplugin:pomodoro'])
})
