// @vitest-environment happy-dom
/** 首启引导四屏(11-05 定稿,11-06 第四轮 A4)的流程:真组件 + 假宿主 / 假接口。真应用里走一遍的是 scripts/onboarding.check.cjs(check:first-run)。 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../i18n.generated'
import { LocaleProvider, setLocaleGlobal, translate } from '../i18n'

vi.mock('../product', () => ({ PRODUCT: { agentBackend: true }, PRODUCT_DISPLAY_NAME: 'Forsion' }))
vi.mock('../services/backendService', () => ({
  listModels: vi.fn(), listAgents: vi.fn(), getAgentsMeta: vi.fn(), getSpecialConfig: vi.fn(), saveSpecialConfig: vi.fn(),
  saveMuseIntro: vi.fn(), saveAgentDef: vi.fn(), testProviderConnection: vi.fn(),
}))
vi.mock('../services/humanCollaboration', () => ({ getHumanDocument: vi.fn(), saveHumanDocument: vi.fn() }))
vi.mock('../services/syncSetup', () => ({ applySyncChoices: vi.fn() }))
vi.mock('../views/agentProfileNav', () => ({ openAgentsSpace: vi.fn() }))
vi.mock('../achievements/store', () => ({ track: vi.fn() }))
vi.mock('../stores/themeStore', () => ({ useTheme: (pick: any) => pick({ bg: 'cream', bgSeed: '', setBg: vi.fn(), setBgSeedValue: vi.fn() }) }))
const store = vi.hoisted(() => ({ onboardingUpdate: false, refreshAgents: () => {} }))
vi.mock('../stores/appStore', () => ({
  useApp: Object.assign((pick: any) => pick({ agentAvatars: {} }), { getState: () => ({ onboardingUpdate: store.onboardingUpdate, refreshAgents: store.refreshAgents }) }),
}))
vi.mock('../theme/registry', () => ({ listLanguages: () => [], listSkins: () => [], forcedSchemeForLanguage: () => null, skinSwatch: () => '', backgroundSwatch: () => '' }))
vi.mock('../changelog', () => ({ APP_VERSION: '2.14.0', CHANGELOG: [] }))
vi.mock('../views/ChangelogView', () => ({ ChangelogEntries: () => React.createElement('div', { 'data-changelog': '' }) }))
vi.mock('../views/homepageWallpaperArt', () => ({ HomeWallpaperArt: () => null }))
vi.mock('./ThemePreview', () => ({ ThemePreview: () => null }))
vi.mock('./LocaleToggle', () => ({ LocaleToggle: () => null }))
vi.mock('./ComputerHistoryAbout', () => ({ ComputerHistoryAbout: () => null }))

const { OnboardingWizard, ONBOARDING_DISMISS_KEY, ONBOARDING_VERSION_KEY } = await import('./OnboardingWizard')
const api = await import('../services/backendService')
const human = await import('../services/humanCollaboration')
const { PRODUCT } = await import('../product')
const { openAgentsSpace } = await import('../views/agentProfileNav')
const { CH_ASK_KEY } = await import('./computerHistoryAskMark')

let host: HTMLDivElement
let root: Root
const props = {
  themeLang: 'lovable', themeSkin: 'cream', themeMode: 'light' as const, themeModePref: 'light' as const, themeSeed: '',
  onThemeChange: vi.fn(), onSeedChange: vi.fn(), onReconnect: vi.fn(), onFinish: vi.fn(),
}
const museConfig = { enabled: true, modelId: '', heartbeatMinutes: 120, activeHours: null }
const agents = [
  { slug: 'xyra', name: 'Xyra', description: '', createdBy: 'builtin' },
  { slug: 'muse', name: 'Muse', nameZh: '卜算子', nameEn: 'Muse', description: '', createdBy: 'builtin' },
  { slug: 'coder', name: 'Coder', description: 'Writes code', createdBy: 'user' },
]
const historyView = (state: Record<string, unknown> = {}, rev = 1) => ({
  state: { v: 1, enabled: false, pausedUntil: null, status: 'off', since: 0, updatedAt: 0, platform: 'darwin', dataGen: 0, ...state },
  exclude: { apps: [], domains: [] }, root: '/Users/me/.forsion/computer-history', keepDays: 7, rev,
})

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  store.onboardingUpdate = false
  localStorage.clear()
  setLocaleGlobal('zh')
  PRODUCT.agentBackend = true
  vi.mocked(human.getHumanDocument).mockResolvedValue({ content: '', version: 'v1', maxLength: 2000 } as any)
  vi.mocked(human.saveHumanDocument).mockImplementation(async (_t, _target, content) => ({ document: { content, version: 'v2', maxLength: 2000 } }) as any)
  vi.mocked(api.getSpecialConfig).mockResolvedValue({ config: { historian: { enabled: true }, muse: museConfig } } as any)
  vi.mocked(api.listAgents).mockResolvedValue(agents as any)
  vi.mocked(api.getAgentsMeta).mockResolvedValue({ defaultSlug: 'xyra' } as any)
  vi.mocked(api.listModels).mockResolvedValue({ models: [{ id: 'm1', name: 'Model one', modelType: 'llm' }], directProviders: [] } as any)
  vi.mocked(api.saveSpecialConfig).mockResolvedValue({} as any)
  vi.mocked(api.saveMuseIntro).mockResolvedValue({} as any)
  vi.mocked(api.saveAgentDef).mockResolvedValue({} as any)
  window.tangu = {
    getConfig: vi.fn().mockResolvedValue({ backendUrl: '', token: '', modelId: '' }), setConfig: vi.fn(),
    authStatus: vi.fn().mockResolvedValue({ loggedIn: false }), authProviders: vi.fn().mockResolvedValue([]), listProviders: vi.fn().mockResolvedValue([]),
    forsionLogin: vi.fn(), platform: 'darwin', envCheck: vi.fn(),
  } as unknown as Window['tangu']
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute('open') }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  delete window.tangu
})

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)) })
async function render() {
  await act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(OnboardingWizard, props) })))
  await flush()
}
const stepNow = () => host.querySelector('.ob-flow')?.getAttribute('data-step')
const primary = () => host.querySelector<HTMLButtonElement>('[data-ob-primary]')!
async function next() {
  expect(primary().disabled).toBe(false)
  await act(async () => primary().click())
  await flush()
}
async function clickText(text: string, container: ParentNode = host) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)
  expect(button, `Missing button: ${text}`).toBeTruthy()
  await act(async () => button!.click())
  await flush()
}
const sw = (label: string) => host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!
async function type(el: HTMLTextAreaElement | HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
function withHistory(state: Record<string, unknown> = {}) {
  const ch = {
    get: vi.fn().mockResolvedValue(historyView(state)),
    setEnabled: vi.fn().mockImplementation(async (on: boolean) => historyView({ ...state, enabled: on, status: on ? 'no_permission' : 'off' }, 2)),
    onChanged: vi.fn().mockReturnValue(() => {}),
  }
  Object.assign(window.tangu!, { computerHistory: ch, desktopPermissionsStatus: vi.fn(), desktopPermissionRequest: vi.fn().mockResolvedValue({}) })
  return ch
}
async function toTeam() {
  await render()
  await next(); await next(); await next()
  expect(stepNow()).toBe('team')
}

it('desktop: four screens in order; Continue saves About you, Get started writes the team in one go', async () => {
  await render()
  expect(stepNow()).toBe('start')
  expect(host.querySelector('.ob-flow')?.getAttribute('data-mode')).toBe('full')
  expect(host.querySelector('[data-ob-title]')?.textContent).toBe(translate('ob3.start.title'))
  // 账号卡和渠道卡并排(不是二选一);什么都没接时主按钮是「先不接，继续」
  expect(host.querySelector('[data-ob-account]')).not.toBeNull()
  expect(host.querySelector('[data-ob-channels]')).not.toBeNull()
  expect(primary().textContent).toBe(translate('ob3.skipConnect'))
  expect(host.querySelectorAll('.ob3-dots button')).toHaveLength(4)
  await next()
  expect(stepNow()).toBe('theme')
  await next()
  expect(stepNow()).toBe('you')
  await type(host.querySelector('textarea')!, 'I am Q')
  await next()
  expect(human.saveHumanDocument).toHaveBeenCalledExactlyOnceWith(expect.anything(), { kind: 'human', file: 'MEMORY.md' }, 'I am Q', 'v1', 'Onboarding: About me')
  expect(stepNow()).toBe('team')
  // 名字只按界面语言显示一个;卜算子没登录时模型必须自己选
  expect(host.querySelector('[data-ob-muse]')?.textContent).toContain('卜算子')
  expect(host.querySelector('[data-ob-muse]')?.textContent).not.toContain('Muse')
  expect(host.querySelector('[data-ob-muse-model]')?.classList.contains('need')).toBe(true)
  // 名单一行只介绍:没有开关(停用在 Agents 页);史官在名单里,卜算子不在
  expect(host.querySelectorAll('[data-ob-roster] [role="switch"]')).toHaveLength(0)
  expect(host.querySelector('[data-agent="historian"]')).not.toBeNull()
  expect(host.querySelector('[data-agent="coder"]')).not.toBeNull()
  expect(host.querySelector('[data-agent="muse"]')).toBeNull()
  // 两问:主动程度不问
  expect(host.querySelectorAll('[data-ob-muse] .ob3-q')).toHaveLength(2)
  expect(host.querySelector('[data-ob-muse]')?.textContent).toContain(translate('ob3.muse.proNote'))
  await type(host.querySelector<HTMLSelectElement>('[data-ob-muse-model] select')!, 'm1')
  await clickText(translate('ob3.focus.study'))
  await type(host.querySelector<HTMLInputElement>('.ob3-own input')!, ' my thesis ')
  expect(primary().textContent).toBe(translate('ob3.getStarted'))
  expect(api.saveMuseIntro).not.toHaveBeenCalled()
  await next()
  expect(api.saveSpecialConfig).toHaveBeenCalledExactlyOnceWith(expect.anything(), { muse: { modelId: 'm1' } })
  // 只带改过的:「什么时候能找你」没动 → 不带;不发 proactivity
  expect(api.saveMuseIntro).toHaveBeenCalledExactlyOnceWith(expect.anything(), { focus: ['study'], focusText: 'my thesis' })
  expect(api.saveAgentDef).not.toHaveBeenCalled()
  expect(props.onFinish).toHaveBeenCalledTimes(1)
  expect(localStorage.getItem(ONBOARDING_DISMISS_KEY)).toBe('1')
  expect(localStorage.getItem(ONBOARDING_VERSION_KEY)).toBe('2.14.0')
  // 走完了:电脑历史已经在团队屏问过,主页不再问
  expect(localStorage.getItem(CH_ASK_KEY)).toBeNull()
})

it('signed out: the model row shows the default model the engine will use, without writing it', async () => {
  vi.mocked(api.listModels).mockResolvedValue({ models: [{ id: 'm1', name: 'Model one', modelType: 'llm', source: 'direct' }], defaultModelId: 'm1', directProviders: [] } as any)
  await toTeam()
  const row = host.querySelector('[data-ob-muse-model]')!
  const select = row.querySelector('select')!
  expect(row.classList.contains('need')).toBe(false)
  expect(select.value).toBe('')
  expect(select.options[0].textContent).toBe(translate('ob3.muse.modelDefaultOption', { model: 'Model one' }))
  expect(row.textContent).toContain(translate('ob3.muse.modelDefault'))
  await next()
  expect(api.saveSpecialConfig).not.toHaveBeenCalled()
})

it('signed out: a default model that is not usable here still asks for a pick', async () => {
  vi.mocked(api.listModels).mockResolvedValue({ models: [{ id: 'm1', name: 'Model one', modelType: 'llm' }], defaultModelId: 'cloud-only', backgroundModelId: 'cloud-bg', directProviders: [] } as any)
  await toTeam()
  const row = host.querySelector('[data-ob-muse-model]')!
  expect(row.classList.contains('need')).toBe(true)
  expect(row.textContent).toContain(translate('ob3.muse.modelNeed'))
})

it('signed in: Muse follows the cloud model by default and nothing is written for untouched choices', async () => {
  vi.mocked(window.tangu!.authStatus!).mockResolvedValue({ loggedIn: true } as any)
  await toTeam()
  const select = host.querySelector<HTMLSelectElement>('[data-ob-muse-model] select')!
  expect(select.value).toBe('')
  expect(select.options[0].textContent).toBe(translate('ob3.muse.modelCloudOption'))
  expect(host.querySelector('[data-ob-muse-model]')?.classList.contains('need')).toBe(false)
  expect(host.querySelector('[data-ob-muse-model]')?.textContent).toContain(translate('ob3.muse.modelCloud'))
  await next()
  expect(api.saveSpecialConfig).not.toHaveBeenCalled()
  expect(api.saveAgentDef).not.toHaveBeenCalled()
  // 一问都没动:发一个空的(只记下第一次见面答过,私聊里不再弹那张卡),不带任何值
  expect(api.saveMuseIntro).toHaveBeenCalledExactlyOnceWith(expect.anything(), {})
  expect(props.onFinish).toHaveBeenCalledTimes(1)
})

it('About you: a conflicting edit reloads and stays on the screen; skipping the guide writes nothing more', async () => {
  vi.mocked(human.saveHumanDocument).mockRejectedValueOnce(Object.assign(new Error('changed elsewhere'), { status: 409 }))
  await render()
  await next(); await next()
  await type(host.querySelector('textarea')!, 'draft')
  await next()
  expect(stepNow()).toBe('you')
  expect(host.textContent).toContain(translate('ob3.you.conflict'))
  expect(host.querySelector('.ob3-foot [role="alert"]')?.textContent).toContain('changed elsewhere')
  expect(human.getHumanDocument).toHaveBeenCalledTimes(2)
  await clickText(translate('onboarding.nav.skip'))
  expect(props.onFinish).toHaveBeenCalledTimes(1)
  expect(human.saveHumanDocument).toHaveBeenCalledTimes(1)
  expect(api.saveMuseIntro).not.toHaveBeenCalled()
})

it('About you: a failed read never saves over the profile', async () => {
  vi.mocked(human.getHumanDocument).mockRejectedValue(new Error('offline'))
  await render()
  await next(); await next()
  expect(host.querySelector('textarea')?.disabled).toBe(true)
  await next()
  expect(stepNow()).toBe('team')
  expect(human.saveHumanDocument).not.toHaveBeenCalled()
})

it('team: a failed write keeps the screen with the error and does not finish', async () => {
  vi.mocked(api.saveMuseIntro).mockRejectedValueOnce(new Error('engine down'))
  await toTeam()
  await next()
  expect(stepNow()).toBe('team')
  expect(props.onFinish).not.toHaveBeenCalled()
  expect(host.querySelector('.ob3-foot [role="alert"]')?.textContent).toContain('engine down')
  await next()
  expect(props.onFinish).toHaveBeenCalledTimes(1)
})

it('signed in: another Forsion model counts against the main quota; a direct one is billed by its provider', async () => {
  vi.mocked(window.tangu!.authStatus!).mockResolvedValue({ loggedIn: true } as any)
  vi.mocked(api.listModels).mockResolvedValue({ models: [{ id: 'c1', name: 'Cloud', modelType: 'llm', source: 'forsion' }, { id: 'd1', name: 'Direct', modelType: 'llm', source: 'direct' }], directProviders: [] } as any)
  await toTeam()
  const row = host.querySelector('[data-ob-muse-model]')!
  await type(row.querySelector('select')!, 'c1')
  expect(row.textContent).toContain(translate('ob3.muse.modelMain'))
  await type(row.querySelector('select')!, 'd1')
  expect(row.textContent).toContain(translate('ob3.muse.modelBilled'))
})

it('team: "Manage in Agents" opens the Agents space after the guide closes', async () => {
  await toTeam()
  const manage = host.querySelector<HTMLButtonElement>('[data-ob-manage]')!
  expect(manage.textContent).toBe(translate('ob3.roster.manage'))
  await act(async () => manage.click())
  expect(manage.getAttribute('aria-pressed')).toBe('true')
  expect(manage.textContent).toBe(translate('ob3.roster.manageQueued'))
  expect(openAgentsSpace).not.toHaveBeenCalled()
  await next()
  expect(props.onFinish).toHaveBeenCalledTimes(1)
  await flush()
  expect(openAgentsSpace).toHaveBeenCalledTimes(1)
})

it('team: an agent turned off earlier is still listed, marked off, with no switch', async () => {
  vi.mocked(api.listAgents).mockResolvedValue([...agents.slice(0, 2), { ...agents[2], disabled: true }] as any)
  await toTeam()
  const coder = host.querySelector('[data-agent="coder"]')!
  expect(coder.textContent).toContain(translate('ob3.roster.off'))
  expect(coder.querySelector('[role="switch"]')).toBeNull()
  await next()
  expect(api.saveAgentDef).not.toHaveBeenCalled()
})

it('computer history: pre-switched on for a fresh install and applied only on Get started, then asks for Accessibility', async () => {
  const ch = withHistory()
  await toTeam()
  expect(host.querySelector('[data-ob-history]')?.getAttribute('data-ch-draft')).toBe('on')
  expect(sw(translate('ob3.ch.title')).getAttribute('aria-checked')).toBe('true')
  expect(host.querySelector('[data-ob-history]')?.textContent).toContain(translate('ob3.ch.lead', { muse: '卜算子' }))
  // 「开了之后,比如」:固定的示意文案
  expect(host.querySelector('[data-ob-ch-example]')?.textContent).toContain(translate('ob3.ch.eg3', { muse: '卜算子' }))
  // 卡片两行 = 同意摘要,「隐私加密」那行与设置页同一个词条
  expect(host.querySelector('[data-ob-history]')?.textContent).toContain(translate('computerHistory.about.neverLabel'))
  expect(ch.setEnabled).not.toHaveBeenCalled()
  await next()
  expect(ch.setEnabled).toHaveBeenCalledExactlyOnceWith(true)
  expect(window.tangu!.desktopPermissionRequest).toHaveBeenCalledWith('computerAccessibility', expect.objectContaining({ locale: 'zh' }))
})

it('computer history: skipping the guide leaves it off and asks again on Home later', async () => {
  const ch = withHistory()
  await toTeam()
  await clickText(translate('onboarding.nav.skip'))
  expect(props.onFinish).toHaveBeenCalledTimes(1)
  expect(ch.setEnabled).not.toHaveBeenCalled()
  expect(localStorage.getItem(CH_ASK_KEY)).toBe('pending')
})

it('computer history: "don\'t remind me" on Home survives skipping the guide again', async () => {
  localStorage.setItem(CH_ASK_KEY, 'dismissed')
  await render()
  await clickText(translate('onboarding.nav.skip'))
  expect(localStorage.getItem(CH_ASK_KEY)).toBe('dismissed')
})

it('computer history: finishing the guide clears a pending ask from an earlier skip', async () => {
  localStorage.setItem(CH_ASK_KEY, 'pending')
  await toTeam()
  await next()
  expect(localStorage.getItem(CH_ASK_KEY)).toBeNull()
})

it('web / phone: skipping or finishing the appearance-only guide never sets the Home ask', async () => {
  delete (window.tangu as any).envCheck
  await render()
  await next()
  expect(localStorage.getItem(CH_ASK_KEY)).toBeNull()
})

it('computer history: someone who turned it off before is not switched back on', async () => {
  const ch = withHistory({ userTurnedOff: true })
  await toTeam()
  expect(sw(translate('ob3.ch.title')).getAttribute('aria-checked')).toBe('false')
  await next()
  expect(ch.setEnabled).not.toHaveBeenCalled()
})

it('computer history: an install whose recorder was ever turned off or cleared (dataGen > 0) is not pre-switched on', async () => {
  const ch = withHistory({ dataGen: 2 })
  await toTeam()
  expect(sw(translate('ob3.ch.title')).getAttribute('aria-checked')).toBe('false')
  // 没替他预开,卡上就不说「默认开启」
  expect(host.querySelector('[data-ob-history]')?.textContent).toContain(translate('ob3.ch.leadOff', { muse: '卜算子' }))
  await next()
  expect(ch.setEnabled).not.toHaveBeenCalled()
})

it('team: after a partial failure, a choice changed back is still written on retry', async () => {
  vi.mocked(window.tangu!.authStatus!).mockResolvedValue({ loggedIn: true } as any)
  vi.mocked(api.saveMuseIntro).mockRejectedValueOnce(new Error('intro write failed'))
  await toTeam()
  await type(host.querySelector<HTMLSelectElement>('[data-ob-muse-model] select')!, 'm1')
  await next()
  expect(api.saveSpecialConfig).toHaveBeenLastCalledWith(expect.anything(), { muse: { modelId: 'm1' } })
  expect(stepNow()).toBe('team')
  // 用户改回「跟随云端」:盘上已经是 m1,重试时要把空的写回去
  await type(host.querySelector<HTMLSelectElement>('[data-ob-muse-model] select')!, '')
  await next()
  expect(api.saveSpecialConfig).toHaveBeenLastCalledWith(expect.anything(), { muse: { modelId: '' } })
  expect(api.saveMuseIntro).toHaveBeenLastCalledWith(expect.anything(), {})
  expect(props.onFinish).toHaveBeenCalledTimes(1)
})

it('team: the focus memory is not written twice when a retry follows a partial failure', async () => {
  vi.mocked(api.saveSpecialConfig).mockRejectedValueOnce(new Error('config write failed'))
  await toTeam()
  await type(host.querySelector<HTMLSelectElement>('[data-ob-muse-model] select')!, 'm1')
  await clickText(translate('ob3.focus.study'))
  await next()
  expect(stepNow()).toBe('team')
  await next()
  expect(vi.mocked(api.saveMuseIntro).mock.calls.map((c) => c[1])).toEqual([{ focus: ['study'] }])
  expect(api.saveSpecialConfig).toHaveBeenCalledTimes(2)
  expect(props.onFinish).toHaveBeenCalledTimes(1)
})

it('start: the key form picks a provider first and asks only for its key; a taken connection name is not overwritten', async () => {
  const saveProvider = vi.fn().mockResolvedValue({})
  Object.assign(window.tangu!, { saveProvider, listProviders: vi.fn().mockResolvedValue([{ providerId: 'openai' }]), openExternal: vi.fn() })
  await render()
  expect(host.querySelector('[data-channel="more"]')).toBeNull()
  await act(async () => host.querySelector<HTMLButtonElement>('[data-channel="key"]')!.click())
  await flush()
  const form = () => host.querySelector('[data-ob-keyform]')!
  expect(form().getAttribute('data-preset')).toBe('openai')
  expect(form().querySelectorAll('input')).toHaveLength(1)
  const save = () => [...form().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === translate('onboarding.connect.saveAndStart'))!
  expect(save().disabled).toBe(true)
  await clickText(translate('ob3.key.getKey', { name: 'OpenAI' }), form())
  expect(window.tangu!.openExternal).toHaveBeenCalledWith('https://platform.openai.com/api-keys')
  await type(form().querySelector('input')!, 'sk-test')
  await act(async () => save().click())
  await flush()
  expect(saveProvider).toHaveBeenCalledExactlyOnceWith({ providerId: 'openai-2', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', modelIds: undefined })
})

it('start: "Custom…" in the key form opens every field', async () => {
  await render()
  await act(async () => host.querySelector<HTMLButtonElement>('[data-channel="key"]')!.click())
  await flush()
  await clickText(translate('ob3.key.custom'))
  const form = host.querySelector('[data-ob-keyform]')!
  expect(form.getAttribute('data-preset')).toBe('custom')
  expect(form.querySelectorAll('input')).toHaveLength(4)
})

it('start: signed in, the sync choices no longer offer an Agents box and point to Penzor Cloud › Sync instead', async () => {
  vi.mocked(window.tangu!.authStatus!).mockResolvedValue({ loggedIn: true, nickname: 'Q' } as any)
  await render()
  const account = host.querySelector('[data-ob-account]')!
  expect(account.textContent).not.toContain(translate('onboarding.connect.sync.agents'))
  expect(account.querySelector('[data-ob-sync-agents]')?.textContent).toBe(translate('ob3.sync.agentsWhere'))
})

it('team: failing to reach the engine on Get started reports it and leaves the buttons usable', async () => {
  await toTeam()
  vi.mocked(window.tangu!.getConfig!).mockRejectedValueOnce(new Error('host gone'))
  await next()
  expect(stepNow()).toBe('team')
  expect(host.querySelector('.ob3-foot [role="alert"]')?.textContent).toContain('host gone')
  expect(host.querySelector<HTMLButtonElement>('.ob-skip')!.disabled).toBe(false)
  await next()
  expect(props.onFinish).toHaveBeenCalledTimes(1)
})

it('upgrading from before 2.13.8 walks the whole new guide as "Welcome back", showing current values', async () => {
  const ch = withHistory()
  store.onboardingUpdate = true
  localStorage.setItem(ONBOARDING_DISMISS_KEY, '1')
  localStorage.setItem(ONBOARDING_VERSION_KEY, '2.13.4')
  await render()
  expect(stepNow()).toBe('start')
  expect(host.querySelector('.ob-flow')?.getAttribute('data-mode')).toBe('full')
  expect(host.querySelector('[data-ob-title]')?.textContent).toBe(translate('ob3.start.titleBack'))
  await next(); await next(); await next()
  expect(sw(translate('ob3.ch.title')).getAttribute('aria-checked')).toBe('false')
  await next()
  expect(ch.setEnabled).not.toHaveBeenCalled()
})

it('upgrading from 2.13.8 or later shows only what changed (the four screens were already walked)', async () => {
  store.onboardingUpdate = true
  localStorage.setItem(ONBOARDING_DISMISS_KEY, '1')
  for (const seen of ['2.13.8', '2.13.9']) {
    localStorage.setItem(ONBOARDING_VERSION_KEY, seen)
    await render()
    expect(stepNow()).toBe('welcome')
    expect(host.querySelector('.ob-flow')?.getAttribute('data-mode')).toBe('update')
    expect(host.querySelector('[data-changelog]')).not.toBeNull()
    expect(host.querySelectorAll('.ob3-dots button')).toHaveLength(0)
    expect(host.querySelector('.ob-skip')).toBeNull()
    expect(primary().textContent).toBe(translate('onboarding.update.continue'))
    await act(async () => root.unmount())
    root = createRoot(host)
  }
  await render()
  await next()
  expect(props.onFinish).toHaveBeenCalledTimes(1)
})

it('team: settings that match none of the options stay unselected and are not written over', async () => {
  vi.mocked(api.getSpecialConfig).mockResolvedValue({ config: { historian: { enabled: true }, muse: { ...museConfig, heartbeatMinutes: 90, activeHours: { start: 8, end: 22 } } } } as any)
  await toTeam()
  const pressed = [...host.querySelectorAll('[data-ob-muse] .ob3-pill[aria-pressed="true"]')].map((b) => b.textContent)
  expect(pressed).toEqual([])
  await next()
  expect(api.saveSpecialConfig).not.toHaveBeenCalled()
  expect(api.saveMuseIntro).toHaveBeenCalledExactlyOnceWith(expect.anything(), {})
})

it('help improve: the update screen shows the notice once to a signed-in user who has not seen it', async () => {
  store.onboardingUpdate = true
  localStorage.setItem(ONBOARDING_DISMISS_KEY, '1')
  localStorage.setItem(ONBOARDING_VERSION_KEY, '2.14.0')
  vi.mocked(window.tangu!.authStatus!).mockResolvedValue({ loggedIn: true } as any)
  let view = { available: true, enabled: true, noticeSeen: false, signedIn: true }
  const invoke = vi.fn(async (channel: string, patch?: { enabled?: boolean; noticeSeen?: true }) => {
    if (channel === 'telemetry:set') view = { ...view, ...patch }
    return view
  })
  Object.assign(window.tangu!, { telemetryReport: vi.fn(), cloudInvoke: invoke, openExternal: vi.fn() })
  await render()
  expect(host.querySelector('[data-ob-improve]')).not.toBeNull()
  expect(invoke).toHaveBeenCalledWith('telemetry:set', { noticeSeen: true })
  await act(async () => root.unmount())
  root = createRoot(host)
  await render()
  expect(host.querySelector('[data-ob-improve]')).toBeNull()
})

it('help improve: greyed out until signed in', async () => {
  const invoke = vi.fn(async () => ({ available: true, enabled: false, noticeSeen: false, signedIn: false }))
  Object.assign(window.tangu!, { telemetryReport: vi.fn(), cloudInvoke: invoke })
  await render()
  const toggle = sw(translate('onboarding.improve.title'))
  expect(toggle.disabled).toBe(true)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(host.querySelector('[data-ob-improve]')?.textContent).toContain(translate('ob3.improve.signedOut'))
  expect(invoke).not.toHaveBeenCalledWith('telemetry:set', expect.anything())
})

it.each(['no engine', 'web / phone shim'] as const)('%s: only the appearance screen', async (kind) => {
  // 网页 / 手机的垫片也有 getConfig,只是没有本机环境探测
  if (kind === 'no engine') PRODUCT.agentBackend = false
  else delete (window.tangu as any).envCheck
  await render()
  expect(stepNow()).toBe('theme')
  expect(host.querySelector('.ob-skip')).toBeNull()
  expect(host.querySelectorAll('.ob3-dots button')).toHaveLength(0)
  expect(primary().textContent).toBe(translate('ob3.getStarted'))
  await next()
  expect(props.onFinish).toHaveBeenCalledTimes(1)
})

it('Enter runs the primary action; the dots reopen a screen already visited', async () => {
  await render()
  await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await flush()
  expect(stepNow()).toBe('theme')
  const dots = host.querySelectorAll<HTMLButtonElement>('.ob3-dots button')
  expect(dots[2].disabled).toBe(true)
  await act(async () => dots[0].click())
  await flush()
  expect(stepNow()).toBe('start')
  await act(async () => host.querySelectorAll<HTMLButtonElement>('.ob3-dots button')[1].click())
  await flush()
  expect(stepNow()).toBe('theme')
})

it('closing only once: Enter while the guide is closing does not save a skipped screen', async () => {
  await render()
  await next(); await next()
  await type(host.querySelector('textarea')!, 'not saved')
  await clickText(translate('onboarding.nav.skip'))
  await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await flush()
  expect(props.onFinish).toHaveBeenCalledTimes(1)
  expect(human.saveHumanDocument).not.toHaveBeenCalled()
})
