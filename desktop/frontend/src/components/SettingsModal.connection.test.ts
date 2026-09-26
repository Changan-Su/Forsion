// @vitest-environment happy-dom
/**
 * 设置 → 连接 / 工作目录的时序回归(Codex 第三轮 H1-1、H1-2),跑真 SettingsModal(无关子页桩掉,同 DesktopPermissions.wiring.test)。
 *  H1-1 桌面端持久配置(getConfig)读回之前:mode 会被当成 external、外部连接表单回退到 p.cfg —— 托管时那是内置后端的
 *       临时地址 / 令牌。此时表单与「测试 / 保存」必须只读,点了也不许写外部配置;读回后才可用;读失败说明原因、保持只读。
 *  H1-2 「选择目录」写盘失败后改填了路径:那条绑着旧目录的「重试」提示当场收回(不然点重试会把旧目录写回盘)。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../i18n.generated'
import { LocaleProvider, setLocaleGlobal, translate } from '../i18n'

vi.mock('../product', () => ({ PRODUCT: { agentBackend: true }, PRODUCT_DISPLAY_NAME: 'Forsion' }))
// 桌面端打开设置会顺带拉插件 / MCP / 同步状态等:本文件不关心,一律给空结果(listModels 给空目录)。
vi.mock('../services/backendService', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(actual)) out[k] = typeof v === 'function' ? vi.fn().mockRejectedValue(new Error('not in this fixture')) : v
  out.listModels = vi.fn().mockResolvedValue({ models: [], directProviders: [] })
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
vi.mock('../views/ChangelogView', () => ({}))
vi.mock('@lcl/engine', () => ({ UI_MODE: 'desktop', UI_ZOOM_EVENT: 'zoom', useWorkspace: vi.fn() }))
vi.mock('@amadeus/plugins/pluginStore', () => ({ usePluginStore: (pick: any) => pick({ plugins: [], activeIds: [], settings: {}, settingsViews: {} }) }))
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
vi.mock('./AuxModelChoice', () => ({ AuxModelChoice: () => null }))
vi.mock('./EnvProbeSection', () => ({ EnvProbeSection: () => null }))
vi.mock('./AccountSwitcher', () => ({ AccountSwitcher: () => null }))
vi.mock('./ChannelsTab', () => ({ ChannelsTab: () => null }))
vi.mock('./RemoteSyncSection', () => ({ RemoteSyncSection: () => null }))
vi.mock('./UpdateActions', () => ({ UpdateActions: () => null }))
vi.mock('./ModelGroupList', () => ({ ModelGroupList: () => null }))
vi.mock('./ModelSelect', () => ({ ModelSelect: () => null }))
vi.mock('./AgentsTab', () => ({ AgentsTab: () => null }))
vi.mock('./SpecialAgentsTab', () => ({ SpecialAgentsTab: () => null }))
vi.mock('./TtsVoiceStudio', () => ({ TtsVoiceStudio: () => null }))
vi.mock('./ShortcutsTab', () => ({ ShortcutsTab: () => null }))
vi.mock('./PluginsTab', () => ({ PluginsTab: () => null }))
vi.mock('./AmadeusPluginsTab', () => ({ AmadeusPluginsTab: () => null }))
vi.mock('./SpacesTab', () => ({ SpacesTab: () => null }))
vi.mock('./NotificationsTab', () => ({ NotificationsTab: () => null, StatusBarTab: () => null }))
vi.mock('./HooksTab', () => ({ HooksTab: () => null }))
vi.mock('./PluginSettingsPage', () => ({ PluginSettingsPage: () => null }))
vi.mock('./AgentClisTab', () => ({ AgentClisTab: () => null }))
vi.mock('./QrImage', () => ({ QrImage: () => null }))

const { SettingsModal } = await import('./SettingsModal')
let host: HTMLDivElement
let root: Root
/** 托管后端的临时连接(p.cfg):绝不能被当成外部连接写回。 */
const managedCfg = { backendUrl: 'http://127.0.0.1:53999', token: 'managed-ephemeral', modelId: '' }
const saved = { mode: 'managed', backendUrl: 'http://127.0.0.1:53999', token: 'managed-ephemeral', externalConnection: { backendUrl: 'https://ext.example', token: 'ext-token' } }
const props = { themeLang: 'lovable', themeSkin: 'cream', themeMode: 'light' as const, themeModePref: 'light' as const, themeSeed: '', onThemeChange: vi.fn(), onSeedChange: vi.fn() }
const onConfigChange = vi.fn()
const onReconnect = vi.fn()
let getConfig: ReturnType<typeof vi.fn>
let setConfig: ReturnType<typeof vi.fn>

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  setLocaleGlobal('zh')
  getConfig = vi.fn()
  setConfig = vi.fn()
  window.tangu = { getConfig, setConfig, backendStatus: vi.fn().mockResolvedValue({ state: 'ready' }) } as unknown as Window['tangu']
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  delete window.tangu
})
const render = (initialTab?: 'connection') => act(async () => root.render(React.createElement(LocaleProvider, {
  children: React.createElement(SettingsModal, { ...props, open: true, initialTab, cfg: managedCfg, flatOn: false, onFlatChange: vi.fn(), glassOn: true, onClose: vi.fn(), onConfigChange, onGlassChange: vi.fn(), onReconnect } as any),
})))
const externalPanel = () => host.querySelector('.settings-external-panel')
const saveBtn = () => host.querySelector<HTMLButtonElement>('[data-conn-save]')
const urlInput = () => externalPanel()?.querySelector<HTMLInputElement>('input[type="text"]') ?? null

it('H1-1 持久配置读回前:外部连接表单与保存只读,点保存不写外部配置;读回后填的是落盘的外部连接', async () => {
  let resolve!: (v: unknown) => void
  getConfig.mockImplementation(() => new Promise((r) => { resolve = r }))
  await render('connection')
  expect(externalPanel(), '未读回时 mode 缺省按 external,外部连接面板会出现(这正是风险窗口)').not.toBeNull()
  expect(host.querySelector('[data-conn-cfg-pending]')?.textContent).toBe(translate('settingsmodal.external.cfgLoading'))
  expect(saveBtn()!.disabled).toBe(true)
  expect(urlInput()!.disabled).toBe(true)
  await act(async () => saveBtn()!.click())
  expect(onConfigChange).not.toHaveBeenCalled()
  expect(onReconnect).not.toHaveBeenCalled()
  expect(setConfig).not.toHaveBeenCalled()
  // 读回:落盘是托管 → 外部连接面板收起(运行方式草稿才会打开它);切到外部草稿后表单是落盘的外部连接
  await act(async () => resolve(saved))
  expect(host.querySelector('[data-conn-cfg-pending]')).toBeNull()
  await act(async () => host.querySelector<HTMLButtonElement>('[data-action="mode-change"]')!.click())
  const externalCard = [...host.querySelectorAll<HTMLElement>('[role="radio"]')].find((el) => el.textContent?.includes(translate('settings.backend.modeExternal')))
  expect(externalCard, '找不到「外部连接」运行方式卡').toBeTruthy()
  await act(async () => externalCard!.click())
  expect(saveBtn()!.disabled).toBe(false)
  expect(urlInput()!.value).toBe('https://ext.example')
})

it('H1-1 读持久配置失败:说明原因并保持只读', async () => {
  getConfig.mockRejectedValue(new Error('disk unavailable'))
  await render('connection')
  const hint = host.querySelector('[data-conn-cfg-pending]')
  expect(hint?.getAttribute('role')).toBe('alert')
  expect(hint?.textContent).toContain('disk unavailable')
  expect(saveBtn()!.disabled).toBe(true)
})

it('H1-2 选目录写盘失败后改填路径:绑着旧目录的「重试」当场收回', async () => {
  getConfig.mockResolvedValue({ ...saved, defaultWorkspaceDir: '/ws/before' })
  setConfig.mockRejectedValueOnce(new Error('read-only'))
  ;(window.tangu as any).pickDirectory = vi.fn().mockResolvedValue('/ws/picked-old')
  await render()
  const panel = host.querySelector('.settings-workspace-panel')!
  const pick = [...panel.querySelectorAll<HTMLButtonElement>('button')].find((b) => !b.closest('[data-commit-error]'))!
  await act(async () => pick.click())
  expect(setConfig).toHaveBeenCalledWith({ defaultWorkspaceDir: '/ws/picked-old' })
  expect(panel.querySelector('[data-commit-error="defaultWorkspaceDir"]'), '前置:选目录失败的提示出现').not.toBeNull()
  const input = panel.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, '/ws/typed-new')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(input.value).toBe('/ws/typed-new')
  expect(panel.querySelector('[data-commit-error="defaultWorkspaceDir"]'), '改了路径后旧目录的「重试」仍挂着:点它会把 /ws/picked-old 写回').toBeNull()
})
