// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../i18n.generated'
import { LocaleProvider, setLocaleGlobal, translate } from '../i18n'
import type { DesktopPermissionsSnapshot } from '../types'

// Exercise the real wizard, settings navigation and permissions component; unrelated pages stay out of this fixture.
vi.mock('../product', () => ({ PRODUCT: { agentBackend: true }, PRODUCT_DISPLAY_NAME: 'Forsion' }))
vi.mock('../services/backendService', () => ({ listModels: vi.fn().mockResolvedValue({ models: [], directProviders: [] }) }))
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
vi.mock('../changelog', () => ({ CHANGELOG: [] }))
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

const { OnboardingWizard } = await import('./OnboardingWizard')
const { SettingsModal } = await import('./SettingsModal')
const { PRODUCT } = await import('../product')
let host: HTMLDivElement
let root: Root
const cfg = { backendUrl: '', token: '', modelId: '' }
const props = {
  themeLang: 'lovable', themeSkin: 'cream', themeMode: 'light' as const, themeModePref: 'light' as const, themeSeed: '',
  onThemeChange: vi.fn(), onSeedChange: vi.fn(), onReconnect: vi.fn(), onFinish: vi.fn(),
}
const permissions: DesktopPermissionsSnapshot = {
  platform: 'darwin', appName: 'Forsion', computerUseAvailable: true, helperInstalled: false, helperRunning: false,
  permissions: { computerAccessibility: 'unknown', computerScreen: 'unknown', microphone: 'not-determined', camera: 'denied', screen: 'denied' },
}
const status = vi.fn().mockResolvedValue(permissions)
const request = vi.fn().mockResolvedValue(permissions)
const closeGuide = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  setLocaleGlobal('zh')
  PRODUCT.agentBackend = true
  window.tangu = { getConfig: vi.fn().mockResolvedValue(cfg), setConfig: vi.fn(), desktopPermissionsStatus: status,
    desktopPermissionRequest: request, desktopPermissionsCloseGuide: closeGuide } as unknown as Window['tangu']
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  delete window.tangu
})
async function render(element: React.ReactElement) {
  await act(async () => root.render(React.createElement(LocaleProvider, { children: element })))
}
async function click(key: string, container: ParentNode = host) {
  const label = translate(key)
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label)
  expect(button, `Missing button: ${label}`).toBeTruthy()
  expect(button!.disabled).toBe(false)
  await act(async () => button!.click())
}
const wizard = () => React.createElement(OnboardingWizard, props)
const settings = (initialTab?: 'permissions', open = true) => React.createElement(SettingsModal, {
  ...props, open, initialTab, cfg, glassOn: true, flatOn: false, onClose: vi.fn(), onConfigChange: vi.fn(), onGlassChange: vi.fn(), onFlatChange: vi.fn(),
})

it('inserts permissions immediately before speech in the full desktop capability phase and allows skipping during a request', async () => {
  window.tangu!.envCheck = vi.fn()
  await render(wizard())
  await click('onboarding.welcome.continue')
  await click('onboarding.connect.skipForNow')
  await click('onboarding.nav.next')
  await click('onboarding.nav.next')
  expect(host.querySelector('.ob-step-head h1')?.textContent).toBe(translate('desktopPermissions.title'))
  expect(host.querySelector('.ob-step-kicker')?.textContent).toBe(translate('onboarding.phase.capabilities'))
  let resolve!: (value: DesktopPermissionsSnapshot) => void
  request.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
  await click('desktopPermissions.install', host.querySelector('[data-permission="computerAccessibility"]')!)
  await click('desktopPermissions.later')
  expect(host.querySelector('[data-speech-step]')).not.toBeNull()
  expect(closeGuide).toHaveBeenCalledTimes(1)
  expect(props.onFinish).not.toHaveBeenCalled()
  await act(async () => resolve(permissions))
  expect(host.querySelector('.desktop-permissions')).toBeNull()
})

it('offers permissions to non-Agent desktop products and continues with no permissions granted', async () => {
  PRODUCT.agentBackend = false
  await render(wizard())
  await click('onboarding.welcome.continue')
  await click('onboarding.nav.next')
  expect(host.querySelector('[data-permission="microphone"]')).not.toBeNull()
  await click('onboarding.nav.next')
  expect(host.querySelector('.ob-step-head h1')?.textContent).toBe(translate('onboarding.step.done.title'))
  expect(request).not.toHaveBeenCalled()
})

it.each(['missing', 'cloudWeb', 'mobile'] as const)('keeps the original web/mobile onboarding sequence for %s', async (kind) => {
  if (kind === 'missing') delete window.tangu!.desktopPermissionsStatus
  else window.tangu![kind] = true
  await render(wizard())
  await click('onboarding.welcome.continue')
  expect(host.querySelector('.ob-step-head h1')?.textContent).toBe(translate('onboarding.step.theme.title'))
  await click('onboarding.nav.next')
  expect(host.querySelector('.ob-step-head h1')?.textContent).toBe(translate('onboarding.step.done.title'))
  expect(status).not.toHaveBeenCalled()
})

it('keeps a permanent permissions entry in Settings → System for a desktop without an Agent backend', async () => {
  PRODUCT.agentBackend = false
  await render(settings())
  const nav = host.querySelector('.settings-nav-list')!
  const entry = [...nav.querySelectorAll('button')].find((button) => button.textContent?.trim() === translate('desktopPermissions.title'))!
  expect(entry).toBeTruthy()
  expect(entry.closest('.settings-nav-group')?.textContent).toContain(translate('settings.group.system'))
  expect(status).not.toHaveBeenCalled()
  await click('desktopPermissions.title', nav)
  expect(host.querySelector('[data-permission="microphone"]')).not.toBeNull()
  await click('settings.tab.notifications', nav)
  expect(closeGuide).toHaveBeenCalledTimes(1)
  await click('desktopPermissions.title', nav)
  expect(status).toHaveBeenCalledTimes(2)
  await render(settings(undefined, false))
  expect(closeGuide).toHaveBeenCalledTimes(2)
})

it.each(['missing', 'cloudWeb', 'mobile', 'unitPage'] as const)('hides the settings permission entry and avoids an empty permission deep link for %s', async (kind) => {
  if (kind === 'missing') delete window.tangu!.desktopPermissionsStatus
  else window.tangu![kind] = true
  await render(settings('permissions'))
  expect(host.querySelector('.desktop-permissions')).toBeNull()
  expect(host.querySelector('.settings-nav-list')?.textContent).not.toContain(translate('desktopPermissions.title'))
  expect(host.querySelector('.settings-sub--permissions')).toBeNull()
  expect(status).not.toHaveBeenCalled()
})

it('opens the supported settings permission deep link directly', async () => {
  await render(settings('permissions'))
  expect(host.querySelector('.settings-sub--permissions .desktop-permissions')).not.toBeNull()
  expect(status).toHaveBeenCalledTimes(1)
})
