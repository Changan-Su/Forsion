// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../i18n.generated'
import { LocaleProvider, setLocaleGlobal, translate } from '../i18n'
import type { DesktopPermissionsSnapshot } from '../types'

// Exercise the real wizard, settings navigation and permissions component; unrelated pages stay out of this fixture.
vi.mock('../product', () => ({ PRODUCT: { agentBackend: true }, PRODUCT_DISPLAY_NAME: 'Forsion' }))
vi.mock('../services/backendService', () => ({ listModels: vi.fn().mockResolvedValue({ models: [], directProviders: [] }), getSpecialConfig: vi.fn(), saveSpecialConfig: vi.fn() }))
vi.mock('../services/agentRunService', () => ({}))
vi.mock('../services/sessionLog', () => ({}))
vi.mock('../services/ttsService', () => ({}))
vi.mock('../achievements/store', () => ({ track: vi.fn() }))
vi.mock('../stores/themeStore', () => ({ useTheme: (pick: any) => pick({ bg: 'cream', bgSeed: '', setBg: vi.fn(), setBgSeedValue: vi.fn() }) }))
const store = vi.hoisted(() => ({ onboardingUpdate: false }))
vi.mock('../stores/appStore', () => ({ useApp: Object.assign(vi.fn(), { getState: () => ({ cfg: {}, refreshSpecialEnabled: vi.fn(), onboardingUpdate: store.onboardingUpdate }) }) }))
vi.mock('../theme/registry', () => ({ listLanguages: () => [], listSkins: () => [], forcedSchemeForLanguage: () => null }))
vi.mock('../fontPresets', () => ({ listFonts: () => [] }))
vi.mock('../uiFont', () => ({ readFont: () => '', applyUiFonts: vi.fn(), writeFont: vi.fn() }))
vi.mock('../uiZoom', () => ({ getUiZoom: () => 1, setUiZoom: vi.fn() }))
vi.mock('../smoothCaret', () => ({ isSmoothCaretOn: () => false }))
vi.mock('../mobileUiCommand', () => ({}))
vi.mock('../activityViewCommand', () => ({}))
vi.mock('../activeWindowCommand', () => ({}))
vi.mock('../changelog', () => ({ APP_VERSION: '2.10.1', CHANGELOG: [] }))
vi.mock('../views/ChangelogView', () => ({ ChangelogEntries: () => null }))
vi.mock('@lcl/engine', () => ({ UI_MODE: 'desktop', UI_ZOOM_EVENT: 'zoom', useWorkspace: vi.fn(), useNativeChromeClaim: () => {}, useNativeChromeInstalled: () => false, useSpaceStore: (pick: any) => pick({ spaces: [] }), setActiveSpace: vi.fn() }))
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
const { listModels, getSpecialConfig, saveSpecialConfig } = await import('../services/backendService')
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
  store.onboardingUpdate = false
  localStorage.clear()
  vi.mocked(getSpecialConfig).mockResolvedValue({ config: { historian: { enabled: true }, muse: { enabled: true } } } as any)
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
  ...props, open, initialTab, cfg, flatOn: false, onFlatChange: vi.fn(), glassOn: true, onClose: vi.fn(), onConfigChange: vi.fn(), onGlassChange: vi.fn(),
})

it('offers optional permissions after the essential desktop choices and allows skipping during a request', async () => {
  window.tangu!.envCheck = vi.fn()
  await render(wizard())
  await click('onboarding.welcome.continue')
  await click('onboarding.connect.skipForNow')
  await click('onboarding.nav.next')
  expect(host.querySelector('.ob-flow')?.getAttribute('data-step')).toBe('theme')
  await click('onboarding.nav.next')
  await click('onboarding.nav.next')
  expect(host.querySelector('.ob-step-head h1')?.textContent).toBe(translate('onboarding.step.env.title'))
  await click('onboarding.nav.next')
  // 后台 Agent 排在权限前一步;这台宿主没有电脑历史接口,Muse 的说明里不出现指向它的那句
  expect(host.querySelector('.ob-flow')?.getAttribute('data-step')).toBe('background')
  expect(host.textContent).not.toContain(translate('onboarding.background.museHistory'))
  await click('onboarding.nav.next')
  // 没有电脑历史那一页时,这一步仍叫「设备权限」
  expect(host.querySelector('.ob-step-head h1')?.textContent).toBe(translate('desktopPermissions.title'))
  expect(host.querySelector('[aria-current="step"]')?.textContent).toBe(translate('onboarding.guide.permissions'))
  expect([...host.querySelectorAll('.ob-sections button')].map((b) => b.textContent)).toEqual([translate('onboarding.guide.computer'), translate('onboarding.guide.media')])
  let resolve!: (value: DesktopPermissionsSnapshot) => void
  request.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
  await click('desktopPermissions.install', host.querySelector('[data-permission="computerAccessibility"]')!)
  // 右下角只有一个主按钮(原来并排的「稍后设置」和它是同一个动作)
  expect(host.querySelectorAll('.ob-footer-row button').length).toBe(2)
  await click('onboarding.nav.next')
  expect(host.querySelector('.ob-step-head h1')?.textContent).toBe(translate('onboarding.guide.doneTitle'))
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
  await click('onboarding.guide.media')
  expect(host.querySelector('[data-permission="microphone"]')).not.toBeNull()
  await click('onboarding.nav.next')
  expect(host.querySelector('.ob-step-head h1')?.textContent).toBe(translate('onboarding.guide.doneTitle'))
  expect(request).not.toHaveBeenCalled()
})

it.each(['missing', 'cloudWeb', 'mobile'] as const)('offers background agents but omits device permissions for %s', async (kind) => {
  if (kind === 'missing') delete window.tangu!.desktopPermissionsStatus
  else {
    window.tangu![kind] = true
    vi.mocked(getSpecialConfig).mockResolvedValue({ config: { historian: { enabled: true }, muse: { enabled: false } }, cloud: true } as any)
  }
  await render(wizard())
  await click('onboarding.welcome.continue')
  expect(host.querySelector('.ob-flow')?.getAttribute('data-step')).toBe('background')
  if (kind !== 'missing') expect(host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="卜算子"]')?.disabled).toBe(true)
  await click('onboarding.nav.next')
  expect(host.querySelector('.ob-step-head h1')?.textContent).toBe(translate('onboarding.step.theme.title'))
  await click('onboarding.nav.next')
  expect(host.querySelector('.ob-step-head h1')?.textContent).toBe(translate('onboarding.guide.doneTitle'))
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

it('preserves an existing model override, waits for saving, and allows clearing it to follow the service default', async () => {
  window.tangu!.envCheck = vi.fn()
  window.tangu!.getConfig = vi.fn().mockResolvedValue({ ...cfg, modelId: 'saved' })
  vi.mocked(listModels).mockResolvedValueOnce({ models: [{ id: 'saved', name: 'Saved model', provider: 'Local', source: 'direct' }], defaultModelId: 'saved', directProviders: [] })
  let resolve!: () => void
  const save = vi.fn().mockImplementationOnce(() => new Promise<void>((r) => { resolve = r }))
  window.tangu!.setConfig = save
  await render(wizard()); await click('onboarding.welcome.continue'); await click('onboarding.connect.skipForNow')
  expect(host.querySelector('.ob-model-option[aria-pressed="true"]')?.textContent).toContain('Saved model')
  await act(async () => host.querySelector<HTMLButtonElement>('.ob-model-default')!.click())
  await click('onboarding.nav.next')
  expect(save).toHaveBeenLastCalledWith({ modelId: '' })
  expect(host.querySelector('.ob-flow')?.getAttribute('data-step')).toBe('model')
  expect(host.querySelector<HTMLButtonElement>('.ob-footer .primary')?.disabled).toBe(true)
  await act(async () => resolve())
  expect(host.querySelector('.ob-flow')?.getAttribute('data-step')).toBe('theme')
  expect(props.onReconnect).toHaveBeenCalledTimes(1)
})

it('keeps the model draft and current step after a save failure, then retries', async () => {
  window.tangu!.envCheck = vi.fn()
  vi.mocked(listModels).mockResolvedValueOnce({ models: [{ id: 'm', name: 'My model', provider: 'Local', source: 'direct' }], defaultModelId: 'm', directProviders: [] })
  window.tangu!.setConfig = vi.fn().mockRejectedValueOnce(new Error('disk unavailable')).mockResolvedValue(cfg)
  await render(wizard()); await click('onboarding.welcome.continue'); await click('onboarding.connect.skipForNow')
  await act(async () => host.querySelector<HTMLButtonElement>('.ob-model-option')!.click())
  await click('onboarding.nav.next')
  expect(host.querySelector('.ob-flow')?.getAttribute('data-step')).toBe('model')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('disk unavailable')
  expect(host.querySelector('.ob-model-option[aria-pressed="true"]')?.textContent).toContain('My model')
  await click('onboarding.nav.next')
  expect(host.querySelector('.ob-flow')?.getAttribute('data-step')).toBe('theme')
})

it('saves the download source before re-checking local tools, and keeps the step on failure', async () => {
  window.tangu!.envCheck = vi.fn()
  window.tangu!.getConfig = vi.fn().mockResolvedValue({ ...cfg, mirror: 'default' })
  let resolve!: () => void
  const save = vi.fn().mockImplementation(() => new Promise<void>((r) => { resolve = r }))
  window.tangu!.setConfig = save
  await render(wizard())
  await click('onboarding.welcome.continue'); await click('onboarding.connect.skipForNow')
  await act(async () => resolve?.())
  for (let i = 0; i < 3; i++) { await click('onboarding.nav.next'); await act(async () => resolve?.()) }
  expect(host.querySelector('.ob-flow')?.getAttribute('data-step')).toBe('env')
  const china = () => [...host.querySelectorAll<HTMLButtonElement>('.ob-env-option')].find((b) => b.textContent?.includes(translate('onboarding.guide.sourceChina')))!
  expect(china().getAttribute('aria-checked')).toBe('false')
  await act(async () => china().click())
  expect(save).toHaveBeenLastCalledWith({ mirror: 'china' })
  // 存盘完成前不切选中态、不放行下一步 —— 否则安装命令会按旧源生成
  expect(china().getAttribute('aria-checked')).toBe('false')
  expect(host.querySelector<HTMLButtonElement>('.ob-footer .primary')?.disabled).toBe(true)
  await act(async () => resolve())
  expect(china().getAttribute('aria-checked')).toBe('true')
  expect(host.querySelector<HTMLButtonElement>('.ob-footer .primary')?.disabled).toBe(false)
  save.mockRejectedValueOnce(new Error('disk unavailable'))
  const official = [...host.querySelectorAll<HTMLButtonElement>('.ob-env-option')].find((b) => b !== china())!
  await act(async () => official.click())
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('disk unavailable')
  expect(china().getAttribute('aria-checked')).toBe('true')
})

it('waits for the background opt-out to save before allowing navigation or skipping onboarding', async () => {
  let resolve!: (config: any) => void
  vi.mocked(saveSpecialConfig).mockImplementationOnce(() => new Promise((r) => { resolve = r }))
  await render(wizard()); await click('onboarding.welcome.continue')
  await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="卜算子"]')!.click())
  expect(saveSpecialConfig).toHaveBeenLastCalledWith(expect.anything(), { muse: { enabled: false } })
  expect([...host.querySelectorAll<HTMLButtonElement>('.ob-footer button')].every((b) => b.disabled)).toBe(true)
  await act(async () => resolve({ historian: { enabled: true }, muse: { enabled: false } }))
  expect(host.querySelector('[role="switch"][aria-label="卜算子"]')?.getAttribute('aria-checked')).toBe('false')
  await click('onboarding.nav.skip')
  expect(props.onFinish).toHaveBeenCalledOnce()
})

// ── 电脑历史进引导(2026-10-13):默认关、只是摆出来;同意说明与设置页同一份;不支持的系统整项不出现 ──
const historyView = (state: Record<string, unknown> = {}, rev = 1) => ({
  state: { v: 1, enabled: false, pausedUntil: null, status: 'off', since: 0, updatedAt: 0, platform: 'darwin', dataGen: 0, ...state },
  exclude: { apps: [], domains: [] }, root: '/Users/me/.forsion/computer-history', keepDays: 7, rev,
})
function withHistory(platform = 'darwin') {
  const api = {
    get: vi.fn().mockResolvedValue(historyView({ platform })),
    setEnabled: vi.fn().mockResolvedValue(historyView({ platform, enabled: true, status: 'no_permission' }, 2)),
    onChanged: vi.fn().mockReturnValue(() => {}),
  }
  Object.assign(window.tangu!, { envCheck: vi.fn(), platform, computerHistory: api })
  // happy-dom 的 <dialog> 没有 showModal / close:补成只翻 open 属性
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute('open') }
  return api
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
async function toPermissions() {
  await render(wizard())
  await click('onboarding.welcome.continue'); await click('onboarding.connect.skipForNow')
  for (let i = 0; i < 4; i++) await click('onboarding.nav.next')
  expect(host.querySelector('.ob-flow')?.getAttribute('data-step')).toBe('background')
}

it('puts computer history in the permissions step: off by default, consent copy shared with Settings, nothing written until confirmed', async () => {
  const api = withHistory()
  await toPermissions()
  // Muse 的开关说明里指向下一步的电脑历史
  expect(host.querySelector('[data-agent="muse"]')?.textContent).toContain(translate('onboarding.background.museHistory'))
  await click('onboarding.nav.next'); await flush()
  expect(host.querySelector('.ob-step-head h1')?.textContent).toBe(translate('onboarding.step.permissions.title'))
  expect([...host.querySelectorAll('.ob-sections button')].map((b) => b.textContent)).toEqual(
    [translate('onboarding.guide.computer'), translate('onboarding.guide.history'), translate('onboarding.guide.media')])
  await click('onboarding.guide.history'); await flush()
  const toggle = () => host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${translate('computerHistory.enable')}"]`)!
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  // macOS:授权状态与入口一直在(不必先开开关)
  expect(host.querySelector('.ob-history [data-permission="computerAccessibility"]')).not.toBeNull()
  const dialog = host.querySelector<HTMLDialogElement>('.ob-history-dialog')!
  expect(dialog.hasAttribute('open')).toBe(false)
  await act(async () => toggle().click())
  // 拨开关 ≠ 开启:先弹同意说明 —— 同意那一段 + 完整五条 + 末尾建议,词条与设置页逐字相同
  expect(api.setEnabled).not.toHaveBeenCalled()
  expect(dialog.hasAttribute('open')).toBe(true)
  expect(dialog.textContent).toContain(translate('computerHistory.enableConfirm.body', { days: 7 }))
  for (const key of ['computerHistory.about.recorded', 'computerHistory.about.never', 'computerHistory.about.access', 'computerHistory.about.permission', 'computerHistory.about.tip']) {
    expect(dialog.textContent, key).toContain(translate(key))
  }
  expect(dialog.textContent).toContain(translate('computerHistory.about.storage', { path: '/Users/me/.forsion/computer-history', days: 7 }))
  await click('computerHistory.cancel', dialog)
  expect(dialog.hasAttribute('open')).toBe(false)
  expect(api.setEnabled).not.toHaveBeenCalled()
  await act(async () => toggle().click())
  await click('computerHistory.enableConfirm.confirm', dialog)
  expect(api.setEnabled).toHaveBeenCalledExactlyOnceWith(true)
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  // 开了但没授权:如实显示状态,不装作在录
  expect(host.querySelector('.ob-history')?.getAttribute('data-ch-status')).toBe('no_permission')
  expect(host.querySelector('.ob-history .ch-status')?.textContent).toBe(translate('computerHistory.status.noPermission'))
})

it('never touches the computer history switch when the guide is walked or skipped without toggling it', async () => {
  const api = withHistory()
  await toPermissions()
  await click('onboarding.nav.next'); await flush()
  await click('onboarding.guide.history'); await flush()
  await click('onboarding.nav.next'); await flush()
  expect(host.querySelector('.ob-step-head h1')?.textContent).toBe(translate('onboarding.guide.doneTitle'))
  // 完成页如实列出它现在的状态(已关闭),点一下回到那一页
  const row = [...host.querySelectorAll<HTMLButtonElement>('.ob-summary button')].find((b) => b.textContent?.includes(translate('onboarding.guide.history')))!
  expect(row.textContent).toContain(translate('computerHistory.status.off'))
  await act(async () => row.click()); await flush()
  expect(host.querySelector('.ob-flow')?.getAttribute('data-step')).toBe('permissions')
  expect(host.querySelector('.ob-sections button.active')?.textContent).toBe(translate('onboarding.guide.history'))
  await click('onboarding.nav.skip')
  expect(props.onFinish).toHaveBeenCalledOnce()
  expect(api.setEnabled).not.toHaveBeenCalled()
})

/** Forsion Extend 的 telemetry:get / set 桩(真通道在 Extend 里);preload 只在 Extend 注册了 telemetry:get 时留 telemetryReport 键。 */
function withImprove(initial: { enabled: boolean; noticeSeen: boolean } = { enabled: true, noticeSeen: false }) {
  let view = { available: true, installId: 'x', queued: 0, ...initial }
  const invoke = vi.fn(async (channel: string, patch?: { enabled?: boolean; noticeSeen?: true }) => {
    if (channel === 'telemetry:set') view = { ...view, ...(typeof patch?.enabled === 'boolean' ? { enabled: patch.enabled } : {}), ...(patch?.noticeSeen ? { noticeSeen: true } : {}) }
    return view
  })
  Object.assign(window.tangu!, { telemetryReport: vi.fn(), cloudInvoke: invoke, openExternal: vi.fn() })
  return invoke
}

it('help improve: last tab, selected on entering the step, notice recorded when shown, switch writes enabled, done page row', async () => {
  withHistory()
  const invoke = withImprove()
  await toPermissions()
  await click('onboarding.nav.next'); await flush()
  expect(host.querySelector('.ob-step-head p')?.textContent).toBe(translate('onboarding.step.permissions.descriptionImprove'))
  expect([...host.querySelectorAll('.ob-sections button')].map((b) => b.textContent)).toEqual(
    [translate('onboarding.guide.computer'), translate('onboarding.guide.history'), translate('onboarding.guide.media'), translate('onboarding.guide.improve')])
  expect(host.querySelector('.ob-sections button.active')?.textContent).toBe(translate('onboarding.guide.improve'))
  // 面板露出来 = 看过告知;开关缺省开,四类数据各一行
  expect(invoke).toHaveBeenCalledWith('telemetry:set', { noticeSeen: true })
  const toggle = () => host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${translate('onboarding.improve.title')}"]`)!
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  expect(host.querySelectorAll('[data-ob-improve] .ob-history-row')).toHaveLength(4)
  await act(async () => toggle().click()); await flush()
  expect(invoke).toHaveBeenLastCalledWith('telemetry:set', { enabled: false })
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  await click('onboarding.improve.privacy')
  expect(window.tangu!.openExternal).toHaveBeenCalledWith('https://forsion.net/legal/privacy')
  await click('onboarding.nav.next'); await flush()
  const row = [...host.querySelectorAll<HTMLButtonElement>('.ob-summary button')].find((b) => b.textContent?.includes(translate('onboarding.guide.improve')))!
  expect(row.textContent).toContain(translate('onboarding.improve.off'))
  await act(async () => row.click()); await flush()
  expect(host.querySelector('.ob-sections button.active')?.textContent).toBe(translate('onboarding.guide.improve'))
})

it('help improve: no tab when Extend has no telemetry channel or telemetry:get rejects; skipping never records the notice', async () => {
  withHistory()
  const invoke = withImprove()
  invoke.mockRejectedValue(new Error('No handler registered'))
  await toPermissions()
  await click('onboarding.nav.next'); await flush()
  expect([...host.querySelectorAll('.ob-sections button')].map((b) => b.textContent)).not.toContain(translate('onboarding.guide.improve'))
  expect(host.querySelector('.ob-step-head p')?.textContent).toBe(translate('onboarding.step.permissions.description'))
  await click('onboarding.nav.skip')
  expect(invoke).not.toHaveBeenCalledWith('telemetry:set', expect.anything())
})

it('help improve: an update from 2.13.4 (computer history already seen) shows the step again and lands on help improve', async () => {
  withHistory()
  withImprove()
  store.onboardingUpdate = true
  localStorage.setItem('forsion_tangu_onboarding_done', '1')
  localStorage.setItem('forsion_tangu_onboarding_version', '2.13.4')
  await render(wizard()); await flush()
  expect(host.querySelectorAll('.ob-progress-item').length).toBe(2)
  await click('onboarding.nav.next'); await flush()
  expect(host.querySelector('.ob-flow')?.getAttribute('data-step')).toBe('permissions')
  expect(host.querySelector('.ob-sections button.active')?.textContent).toBe(translate('onboarding.guide.improve'))
})

it('leaves computer history out entirely on a platform without a collector', async () => {
  const api = withHistory('linux')
  status.mockResolvedValue({ ...permissions, platform: 'linux', computerUseAvailable: false })
  await toPermissions()
  expect(host.textContent).not.toContain(translate('onboarding.background.museHistory'))
  await click('onboarding.nav.next'); await flush()
  expect(host.querySelector('.ob-step-head h1')?.textContent).toBe(translate('desktopPermissions.title'))
  expect([...host.querySelectorAll('.ob-sections button')].map((b) => b.textContent)).toEqual([translate('onboarding.guide.media')])
  expect(host.querySelector('.ob-history')).toBeNull()
  expect(api.get).not.toHaveBeenCalled()
  status.mockResolvedValue(permissions)
})

it('hides both computer control and computer history when Computer Use is unavailable in this build', async () => {
  withHistory()
  status.mockResolvedValue({ ...permissions, computerUseAvailable: false })
  await toPermissions()
  await click('onboarding.nav.next'); await flush()
  expect([...host.querySelectorAll('.ob-sections button')].map((b) => b.textContent)).toEqual([translate('onboarding.guide.media')])
  status.mockResolvedValue(permissions)
})

it('Windows: no Accessibility step, just the note that nothing needs granting', async () => {
  withHistory('win32')
  status.mockResolvedValue({ ...permissions, platform: 'win32' })
  await toPermissions()
  await click('onboarding.nav.next'); await flush()
  await click('onboarding.guide.history'); await flush()
  expect(host.querySelector('.ob-history [data-permission="computerAccessibility"]')).toBeNull()
  expect(host.querySelector('.ob-history-note')?.textContent).toBe(translate('computerHistory.win.permission'))
  status.mockResolvedValue(permissions)
})

it('after a version update shows only what changed plus the step that is new since the last run', async () => {
  withHistory()
  store.onboardingUpdate = true
  localStorage.setItem('forsion_tangu_onboarding_done', '1')
  localStorage.setItem('forsion_tangu_onboarding_version', '2.13.3')
  await render(wizard())
  expect(host.querySelector('.ob-flow')?.getAttribute('data-mode')).toBe('update')
  expect(host.querySelector('.ob-step-head h1')?.textContent).toBe(translate('onboarding.update.title', { version: '2.10.1' }))
  expect([...host.querySelectorAll('.ob-progress-item')].map((b) => b.getAttribute('aria-label'))).toEqual(
    [translate('onboarding.update.rail'), translate('onboarding.guide.permissionsData')])
  await click('onboarding.nav.next'); await flush()
  // 直接落在新增的那一页;这是最后一步,主按钮结束引导,没有完成页
  expect(host.querySelector('.ob-flow')?.getAttribute('data-step')).toBe('permissions')
  expect(host.querySelector('.ob-sections button.active')?.textContent).toBe(translate('onboarding.guide.history'))
  await click('onboarding.update.finish')
  expect(props.onFinish).toHaveBeenCalledOnce()
})

it('after a version update with nothing new shows a single what-changed screen', async () => {
  withHistory()
  store.onboardingUpdate = true
  localStorage.setItem('forsion_tangu_onboarding_done', '1')
  localStorage.setItem('forsion_tangu_onboarding_version', '2.13.8')
  await render(wizard())
  expect(host.querySelectorAll('.ob-progress-item').length).toBe(1)
  // 「跳过引导」仍在:一百多支台架靠这个按钮进主界面
  expect([...host.querySelectorAll('button')].some((b) => b.textContent === translate('onboarding.nav.skip'))).toBe(true)
  await click('onboarding.update.continue')
  expect(props.onFinish).toHaveBeenCalledOnce()
  expect(localStorage.getItem('forsion_tangu_onboarding_version')).toBe('2.10.1')
})

it('lets a visited step be reopened from the rail and Enter trigger the primary action', async () => {
  window.tangu!.envCheck = vi.fn()
  await render(wizard())
  await click('onboarding.welcome.continue'); await click('onboarding.connect.skipForNow')
  expect(host.querySelector('.ob-flow')?.getAttribute('data-step')).toBe('model')
  // 没走到的步骤不是按钮;走过的是
  expect(host.querySelector(`.ob-progress-item[aria-label="${translate('onboarding.guide.theme')}"]`)?.tagName).toBe('DIV')
  const visited = () => host.querySelector<HTMLButtonElement>(`button.ob-progress-item[aria-label="${translate('onboarding.guide.connect')}"]`)!
  await act(async () => visited().click())
  expect(host.querySelector('.ob-flow')?.getAttribute('data-step')).toBe('connect')
  expect(host.querySelector('.ob-flow')?.getAttribute('data-dir')).toBe('back')
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  expect(host.querySelector('.ob-flow')?.getAttribute('data-step')).toBe('model')
  // 焦点在输入框里的回车归输入框
  await act(async () => visited().click())
  const input = host.querySelector<HTMLInputElement>('#ob-provider')!
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  expect(host.querySelector('.ob-flow')?.getAttribute('data-step')).toBe('connect')
})

// 10-14 体验走查:从最后一页回头改一项之后,左栏点不回已经到过的后面那一步,只能把「下一步」重点一遍。
it('lets the rail jump ahead to a step already reached and saves the choices of the steps it passes', async () => {
  window.tangu!.envCheck = vi.fn()
  // 模型清单每次进那一步都重读:来回两次各给一份
  const models = { models: [{ id: 'm', name: 'My model', provider: 'Local', source: 'direct' as const }], defaultModelId: 'other', directProviders: [] }
  vi.mocked(listModels).mockResolvedValueOnce(models).mockResolvedValueOnce(models)
  const save = vi.fn().mockResolvedValue(cfg)
  window.tangu!.setConfig = save
  const rail = (key: string) => host.querySelector<HTMLButtonElement>(`button.ob-progress-item[aria-label="${translate(key)}"]`)
  const at = () => host.querySelector('.ob-flow')?.getAttribute('data-step')
  await render(wizard()); await click('onboarding.welcome.continue'); await click('onboarding.connect.skipForNow')
  await click('onboarding.nav.next'); await click('onboarding.nav.next')
  expect(at()).toBe('workspace')
  save.mockClear(); vi.mocked(props.onReconnect).mockClear()
  // 回到默认模型改一项(只是草稿),再从左栏直接回工作目录:途经的模型那一步照「下一步」的规矩存下
  await act(async () => rail('onboarding.guide.model')!.click())
  expect(at()).toBe('model')
  await act(async () => host.querySelector<HTMLButtonElement>('.ob-model-option')!.click())
  expect(save).not.toHaveBeenCalled()
  await act(async () => rail('onboarding.guide.workspace')!.click()); await flush()
  expect(at()).toBe('workspace')
  expect(host.querySelector('.ob-flow')?.getAttribute('data-dir')).toBe('forward')
  expect(save).toHaveBeenCalledWith({ modelId: 'm' })
  expect(props.onReconnect).toHaveBeenCalled()
  // 没到过的步骤仍然不能跳
  expect(rail('onboarding.guide.env')).toBeNull()
})

// ── Codex 评审(2026-10-13)点出的四处,各钉一条 ──
it('drops computer history everywhere when the recorder itself reports unsupported, before its tab is ever opened', async () => {
  const api = withHistory()
  api.get.mockResolvedValue(historyView({ status: 'unsupported' }))
  await toPermissions()
  expect(host.textContent).not.toContain(translate('onboarding.background.museHistory'))
  await click('onboarding.nav.next'); await flush()
  expect([...host.querySelectorAll('.ob-sections button')].map((b) => b.textContent)).toEqual([translate('onboarding.guide.computer'), translate('onboarding.guide.media')])
  await click('onboarding.nav.next'); await flush()
  expect(host.querySelector('.ob-summary')?.textContent).not.toContain(translate('onboarding.guide.history'))
})

it('keeps one permission card across computer ↔ media so an in-flight setup is not cancelled, and recovers the tabs after a failed first read', async () => {
  withHistory()
  status.mockRejectedValueOnce(new Error('ipc down'))
  await toPermissions()
  await click('onboarding.nav.next'); await flush()
  // 进这一步时那次读失败:先只有媒体;卡片自己的读取成功后,另外两页回来
  await flush()
  expect([...host.querySelectorAll('.ob-sections button')].map((b) => b.textContent)).toEqual(
    [translate('onboarding.guide.computer'), translate('onboarding.guide.history'), translate('onboarding.guide.media')])
  await click('onboarding.guide.computer'); await flush()
  closeGuide.mockClear()
  await click('onboarding.guide.media'); await flush()
  await click('onboarding.guide.computer'); await flush()
  expect(closeGuide).not.toHaveBeenCalled()
})

it('does not save a skipped draft when Enter is pressed while the guide is closing', async () => {
  window.tangu!.envCheck = vi.fn()
  vi.mocked(listModels).mockResolvedValueOnce({ models: [{ id: 'm', name: 'My model', provider: 'Local', source: 'direct' }], defaultModelId: 'm', directProviders: [] })
  const save = vi.fn().mockResolvedValue(cfg)
  window.tangu!.setConfig = save
  await render(wizard()); await click('onboarding.welcome.continue'); await click('onboarding.connect.skipForNow')
  await act(async () => host.querySelector<HTMLButtonElement>('.ob-model-option')!.click())
  await click('onboarding.nav.skip')
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  expect(props.onFinish).toHaveBeenCalledOnce()
  expect(save).not.toHaveBeenCalled()
  expect(host.querySelector('.ob-flow')?.getAttribute('data-step')).toBe('model')
})

it('keeps the update guide on its step if the new page turns out to be unavailable mid-way', async () => {
  const api = withHistory()
  let resolveGet!: (view: unknown) => void
  api.get.mockImplementation(() => new Promise((r) => { resolveGet = r }))
  store.onboardingUpdate = true
  localStorage.setItem('forsion_tangu_onboarding_done', '1')
  localStorage.setItem('forsion_tangu_onboarding_version', '2.13.3')
  await render(wizard())
  await click('onboarding.nav.next'); await flush()
  expect(host.querySelector('.ob-flow')?.getAttribute('data-step')).toBe('permissions')
  await act(async () => resolveGet(historyView({ status: 'unsupported' })))
  await flush()
  // 那一页撤掉了,但这一步还在序列里:主按钮仍然是「完成」,不会把人送回第一屏
  expect(host.querySelector('.ob-flow')?.getAttribute('data-step')).toBe('permissions')
  await click('onboarding.update.finish')
  expect(props.onFinish).toHaveBeenCalledOnce()
})
