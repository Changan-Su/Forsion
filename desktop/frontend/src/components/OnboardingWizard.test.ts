// @vitest-environment happy-dom
/** 首启引导四屏(11-05 定稿,11-06 第四轮 A4)的流程:真组件 + 假宿主 / 假接口。真应用里走一遍的是 scripts/onboarding.check.cjs(check:first-run)。 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../i18n.generated'
import { LocaleProvider, setLocaleGlobal, translate } from '../i18n'
import { publishAccountQuota } from '../services/accountQuota'

vi.mock('../product', () => ({ PRODUCT: { agentBackend: true }, PRODUCT_DISPLAY_NAME: 'Forsion' }))
vi.mock('../services/backendService', () => ({
  listModels: vi.fn(), listAgents: vi.fn(), getAgentsMeta: vi.fn(), getSpecialConfig: vi.fn(), saveSpecialConfig: vi.fn(),
  saveMuseIntro: vi.fn(), saveAgentDef: vi.fn(), testProviderConnection: vi.fn(),
}))
vi.mock('../services/humanCollaboration', () => ({ getHumanDocument: vi.fn(), saveHumanDocument: vi.fn() }))
const sync = vi.hoisted(() => ({ snap: null as null | Record<string, any> }))
vi.mock('../services/syncSetup', () => ({
  applyOnboardingSync: vi.fn(), getSync: () => sync.snap, refreshSync: vi.fn(async () => {}), subscribeSync: () => () => {},
}))
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
vi.mock('./ExternalImport', () => ({ ExternalImportEntry: ({ layout }: { layout?: string }) => React.createElement('div', { 'data-import-stub': layout || 'inline' }) }))

const { OnboardingWizard, ONBOARDING_DISMISS_KEY, ONBOARDING_VERSION_KEY } = await import('./OnboardingWizard')
const api = await import('../services/backendService')
const human = await import('../services/humanCollaboration')
const { PRODUCT } = await import('../product')
const { openAgentsSpace } = await import('../views/agentProfileNav')
const { CH_ASK_KEY } = await import('./computerHistoryAskMark')
const { applyOnboardingSync } = await import('../services/syncSetup')
const phoneGuideMod = await import('./onboarding/phoneGuide')

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
  sync.snap = null
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
const youName = () => host.querySelector<HTMLInputElement>('[data-ob-you-name]')!
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
/** 模型行是设置页那个 ModelSelect:按钮 + portal 到 body 的分组菜单。 */
const modelBtn = () => host.querySelector<HTMLButtonElement>('[data-ob-muse-model] .model-select-btn')!
async function pickModel(name: string) {
  await act(async () => modelBtn().click())
  const item = [...document.querySelectorAll<HTMLButtonElement>('.composer-menu .menu-item')].find((b) => b.querySelector('.grow')?.textContent === name)
  expect(item, `Missing model: ${name}`).toBeTruthy()
  await act(async () => item!.click())
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
  // 三问卡:名字没汉字 → 整节英文(界面是中文也一样);胶囊按那一节的语言写
  await type(youName(), 'Q')
  await act(async () => host.querySelector<HTMLButtonElement>('[data-ob-you-work="code"]')!.click())
  await next()
  expect(human.saveHumanDocument).toHaveBeenCalledExactlyOnceWith(expect.anything(), { kind: 'human', file: 'MEMORY.md' }, '## About me\n- Call me: Q\n- Working on: coding\n', 'v1', 'Onboarding: About me')
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
  await pickModel('Model one')
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
  expect(row.classList.contains('need')).toBe(false)
  expect(modelBtn().textContent).toBe(translate('ob3.muse.modelDefaultOption', { model: 'Model one' }))
  expect(row.textContent).toContain(translate('ob3.muse.modelDefault'))
  await next()
  expect(api.saveSpecialConfig).not.toHaveBeenCalled()
})

it('the Background tasks model set in Settings comes first, signed in or not, and is described by who pays', async () => {
  vi.mocked(window.tangu!.authStatus!).mockResolvedValue({ loggedIn: true } as any)
  vi.mocked(window.tangu!.getConfig!).mockResolvedValue({ backendUrl: '', token: '', modelId: '', backgroundModelId: 'd1' } as any)
  vi.mocked(api.listModels).mockResolvedValue({ models: [{ id: 'c1', name: 'Cloud', modelType: 'llm', source: 'forsion' }, { id: 'd1', name: 'Direct', modelType: 'llm', source: 'direct' }], backgroundModelId: 'c1', directProviders: [] } as any)
  await toTeam()
  const row = host.querySelector('[data-ob-muse-model]')!
  expect(modelBtn().textContent).toBe(translate('ob3.muse.modelLocalOption', { model: 'Direct' }))
  // 登录了也不说「跟随云端 / 独立额度」:引擎先用本机这一格
  expect(row.textContent).toContain(translate('ob3.muse.modelLocal'))
  expect(row.textContent).not.toContain(translate('ob3.muse.modelCloud'))
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
  expect(modelBtn().textContent).toBe(translate('ob3.muse.modelCloudOption'))
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
  await type(youName(), 'draft')
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
  expect(youName().disabled).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('[data-ob-you-work="code"]')?.disabled).toBe(true)
  await next()
  expect(stepNow()).toBe('team')
  expect(human.saveHumanDocument).not.toHaveBeenCalled()
})

it('About you: the engine\'s seeded template reads as empty, and filling in replaces it whole', async () => {
  const { USER_MD_TEMPLATE } = await import('../../../../tangu-agent/src/contracts/userMdTemplate')
  vi.mocked(human.getHumanDocument).mockResolvedValue({ content: USER_MD_TEMPLATE, version: 'v1', maxLength: 2000 } as any)
  await render()
  await next(); await next()
  expect(youName().value).toBe('')
  expect(youName().placeholder).toBe(translate('ob3.you.namePh'))
  expect(host.querySelector('[data-ob-you] textarea')).toBeNull() // 自由框折叠着
  expect(host.querySelector('[data-ob-you-more]')?.getAttribute('aria-expanded')).toBe('false')
  // 没填就继续:不写(模板留着)
  await next()
  expect(stepNow()).toBe('team')
  expect(human.saveHumanDocument).not.toHaveBeenCalled()
  await act(async () => host.querySelectorAll<HTMLButtonElement>('.ob3-dots button')[2].click())
  await flush()
  await type(youName(), '小鹿')
  await act(async () => host.querySelector<HTMLButtonElement>('[data-ob-you-style="short"]')!.click())
  await next()
  expect(human.saveHumanDocument).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.anything(), '## 关于我\n- 称呼：小鹿\n- 回答：简短直接\n', 'v1', 'Onboarding: About me')
})

it('About you: an existing profile fills the questions in place, keeps the rest word for word, and is not rewritten untouched', async () => {
  vi.mocked(human.getHumanDocument).mockResolvedValue({ content: 'Call me: 小鹿\r\n住在杭州\r\n\r\n\r\n', version: 'v1', maxLength: 2000 } as any)
  await render()
  await next(); await next()
  expect(youName().value).toBe('小鹿')
  // 认不得的行放进自由框,并且展开
  expect(host.querySelector('[data-ob-you-more]')?.getAttribute('aria-expanded')).toBe('true')
  expect(host.querySelector<HTMLTextAreaElement>('[data-ob-you] textarea')?.value).toBe('住在杭州')
  // 原文的换行风格 / 末尾空行不同,不算改过
  await next()
  expect(human.saveHumanDocument).not.toHaveBeenCalled()
  await act(async () => host.querySelectorAll<HTMLButtonElement>('.ob3-dots button')[2].click())
  await flush()
  // 单选再点一次取消;回答语言再点一次回到「跟着我说的话」
  const style = () => host.querySelector<HTMLButtonElement>('[data-ob-you-style="why"]')!
  await act(async () => style().click())
  expect(style().getAttribute('aria-pressed')).toBe('true')
  await act(async () => style().click())
  expect(style().getAttribute('aria-pressed')).toBe('false')
  const zh = () => host.querySelector<HTMLButtonElement>('[data-ob-you-lang="zh"]')!
  await act(async () => zh().click())
  await act(async () => zh().click())
  expect(host.querySelector('[data-ob-you-lang="auto"]')?.getAttribute('aria-pressed')).toBe('true')
  await act(async () => zh().click())
  await next()
  expect(human.saveHumanDocument).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.anything(), '## 关于我\n- 称呼：小鹿\n- 回答用中文\n\n住在杭州\n', 'v1', 'Onboarding: About me')
})

it('About you: a profile over the size limit is not saved; the screen stays with the error', async () => {
  vi.mocked(human.getHumanDocument).mockResolvedValue({ content: '', version: 'v1', maxLength: 20 } as any)
  await render()
  await next(); await next()
  await type(youName(), 'A long enough name')
  await next()
  expect(human.saveHumanDocument).not.toHaveBeenCalled()
  expect(stepNow()).toBe('you')
  expect(host.querySelector('.ob3-foot [role="alert"]')?.textContent).toContain(translate('ob3.you.tooLong', { max: 20 }))
})

it('About you: "Bring it over from another AI" reuses the shared import entry; Enter behind its sheet does not continue', async () => {
  await render()
  await next(); await next()
  expect(host.querySelector('.ob3-imp [data-import-stub="row"]')).not.toBeNull()
  const sheet = document.createElement('div')
  sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true')
  document.body.appendChild(sheet)
  try {
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await flush()
    expect(stepNow()).toBe('you')
  } finally { sheet.remove() }
  await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await flush()
  expect(stepNow()).toBe('team')
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

it('signed in, quota unknown: another Forsion model just says account quota (no main / background claim); a direct one is billed by its provider', async () => {
  vi.mocked(window.tangu!.authStatus!).mockResolvedValue({ loggedIn: true } as any)
  vi.mocked(api.listModels).mockResolvedValue({ models: [{ id: 'c1', name: 'Cloud', modelType: 'llm', source: 'forsion' }, { id: 'd1', name: 'Direct', modelType: 'llm', source: 'direct' }], directProviders: [] } as any)
  await toTeam()
  const row = host.querySelector('[data-ob-muse-model]')!
  await pickModel('Cloud')
  expect(row.textContent).toContain(translate('ob3.muse.modelMain'))
  await pickModel('Direct')
  expect(row.textContent).toContain(translate('ob3.muse.modelBilled'))
})

/** 后台额度(11-09 方案 A):只计账号额度接口给的 background.modelId 那一个模型;菜单里它和「跟随云端 · 它」贴标签,收起时标签进提示行。 */
function signedInWithQuota(quota: unknown = { background: { modelId: 'c1', sharePercent: 15 } }) {
  vi.mocked(window.tangu!.authStatus!).mockResolvedValue({ loggedIn: true } as any)
  Object.assign(window.tangu!, { accountQuota: vi.fn().mockResolvedValue({ status: 200, json: quota }) })
  vi.mocked(api.listModels).mockResolvedValue({ models: [
    { id: 'c1', name: 'Luna', modelType: 'llm', source: 'forsion' }, { id: 'c2', name: 'Opus', modelType: 'llm', source: 'forsion' },
    { id: 'd1', name: 'Direct', modelType: 'llm', source: 'direct' },
  ], backgroundModelId: 'c1', directProviders: [] } as any)
}
const menuItem = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('.composer-menu .menu-item')].find((b) => b.querySelector('.grow')?.textContent === name)

it('background quota: following the cloud tags the counted model in the menu and in the hint', async () => {
  signedInWithQuota()
  await toTeam()
  const row = host.querySelector('[data-ob-muse-model]')!
  expect(row.querySelector('[data-ob-bgq="counts"] [data-bgq-tag]')).toBeTruthy()
  expect(row.textContent).toContain(translate('ob3.muse.modelBgQuota', { model: 'Luna' }))
  expect(modelBtn().querySelector('[data-bgq-tag]')).toBeNull() // 按钮里不放标签
  await act(async () => modelBtn().click())
  expect(document.querySelector('.composer-menu .menu-item')?.querySelector('[data-bgq-tag]')).toBeTruthy() // 「跟随云端 · Luna」
  expect(menuItem('Luna')?.querySelector('[data-bgq-tag]')).toBeTruthy()
  expect(menuItem('Opus')?.querySelector('[data-bgq-tag]')).toBeNull()
  expect(menuItem('Direct')?.querySelector('[data-bgq-tag]')).toBeNull()
  // 登出 / 切账号:宿主广播 null → 标签收掉,不留上一个账号的
  await act(async () => { publishAccountQuota(null) })
  expect(document.querySelector('[data-bgq-tag]')).toBeNull()
  expect(row.querySelector('[data-ob-bgq]')).toBeNull()
})

it('background quota: picking the counted model explicitly still counts (was misreported as the main quota)', async () => {
  signedInWithQuota()
  await toTeam()
  await pickModel('Luna')
  const row = host.querySelector('[data-ob-muse-model]')!
  expect(row.querySelector('[data-ob-bgq="counts"]')).toBeTruthy()
  expect(row.textContent).not.toContain(translate('ob3.muse.modelMain'))
})

it('background quota: another Forsion model turns the hint into a warning whose icon explains the quota', async () => {
  signedInWithQuota({ background: { modelId: 'c1', sharePercent: 20 } })
  await toTeam()
  await pickModel('Opus')
  const row = host.querySelector('[data-ob-muse-model]')!
  expect(row.querySelector('[data-ob-bgq="other"]')?.textContent).toContain(translate('ob3.muse.modelNotBg', { model: 'Opus' }))
  expect(host.querySelector('[data-ob-quota-pop]')).toBeNull()
  const info = row.querySelector<HTMLButtonElement>('[data-ob-quota-info]')!
  await act(async () => info.click())
  const pop = host.querySelector('[data-ob-quota-pop]')!
  expect(info.getAttribute('aria-expanded')).toBe('true')
  expect(pop.textContent).toContain(translate('ob3.quota.bg', { share: 20, model: 'Luna', muse: '卜算子' }))
  expect(pop.textContent).toContain(translate('ob3.quota.more'))
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(host.querySelector('[data-ob-quota-pop]')).toBeNull()
  // 自己接的 Key:不提后台额度,照旧「费用算在你接的那家」
  await pickModel('Direct')
  expect(row.querySelector('[data-ob-bgq]')).toBeNull()
  expect(row.textContent).toContain(translate('ob3.muse.modelBilled'))
})

it('background quota: unknown quota (read failed / server not configured) tags nothing', async () => {
  signedInWithQuota()
  vi.mocked(window.tangu!.accountQuota!).mockResolvedValue({ status: 500, json: null } as any)
  await toTeam()
  const row = host.querySelector('[data-ob-muse-model]')!
  expect(row.querySelector('[data-ob-bgq]')).toBeNull()
  expect(row.textContent).toContain(translate('ob3.muse.modelCloud'))
  await pickModel('Opus')
  expect(row.querySelector('[data-ob-bgq]')).toBeNull()
  // 不知道计入哪个:不说「主额度」,也不说「后台额度」
  expect(row.textContent).toContain(translate('ob3.muse.modelMain'))
  expect(translate('ob3.muse.modelMain')).not.toMatch(/主额度|后台额度/)
  await act(async () => modelBtn().click())
  expect(document.querySelector('.composer-menu [data-bgq-tag]')).toBeNull()
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
  await pickModel('Model one')
  await next()
  expect(api.saveSpecialConfig).toHaveBeenLastCalledWith(expect.anything(), { muse: { modelId: 'm1' } })
  expect(stepNow()).toBe('team')
  // 用户改回「跟随云端」:盘上已经是 m1,重试时要把空的写回去
  await pickModel(translate('ob3.muse.modelCloudOption'))
  await next()
  expect(api.saveSpecialConfig).toHaveBeenLastCalledWith(expect.anything(), { muse: { modelId: '' } })
  expect(api.saveMuseIntro).toHaveBeenLastCalledWith(expect.anything(), {})
  expect(props.onFinish).toHaveBeenCalledTimes(1)
})

it('team: the focus memory is not written twice when a retry follows a partial failure', async () => {
  vi.mocked(api.saveSpecialConfig).mockRejectedValueOnce(new Error('config write failed'))
  await toTeam()
  await pickModel('Model one')
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

it('start: the key form will not save by preset until it has read the existing connections (still loading, or the read failed)', async () => {
  const saveProvider = vi.fn().mockResolvedValue({})
  Object.assign(window.tangu!, { saveProvider, listProviders: vi.fn().mockReturnValue(new Promise(() => {})) })
  await render()
  await act(async () => host.querySelector<HTMLButtonElement>('[data-channel="key"]')!.click())
  await flush()
  let form = host.querySelector('[data-ob-keyform]')!
  await type(form.querySelector('input')!, 'sk-test')
  const save = () => [...host.querySelector('[data-ob-keyform]')!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === translate('onboarding.connect.saveAndStart'))!
  expect(save().disabled).toBe(true)
  // 读失败 ≠ 没有:照样不许按预设存,说一句;「自己填…」(连接名自己写)还能存
  await act(async () => root.unmount())
  root = createRoot(host)
  vi.mocked(window.tangu!.listProviders!).mockRejectedValue(new Error('read failed'))
  await render()
  await act(async () => host.querySelector<HTMLButtonElement>('[data-channel="key"]')!.click())
  await flush()
  form = host.querySelector('[data-ob-keyform]')!
  await type(form.querySelector('input')!, 'sk-test')
  expect(save().disabled).toBe(true)
  expect(form.textContent).toContain(translate('ob3.key.listFailed'))
  await clickText(translate('ob3.key.custom'))
  const inputs = host.querySelectorAll<HTMLInputElement>('[data-ob-keyform] input')
  await type(inputs[0], 'my-openai'); await type(inputs[2], 'https://api.example.com/v1')
  expect(save().disabled).toBe(false)
  expect(saveProvider).not.toHaveBeenCalled()
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

const snapshot = (over: Record<string, any> = {}) => ({
  signedIn: true, decided: false, notes: { on: false, available: true }, agents: { on: false }, plugins: { on: true }, ...over,
})
async function walkToEnd() {
  await next(); await next(); await next()
  expect(stepNow()).toBe('team')
  await next()
  expect(props.onFinish).toHaveBeenCalledTimes(1)
}

it('start: signed in, sync is marked Beta and off by default; an untouched choice is finished as all off', async () => {
  vi.mocked(window.tangu!.authStatus!).mockResolvedValue({ loggedIn: true, nickname: 'Q' } as any)
  ;(window as any).remoteSync = {}
  sync.snap = snapshot() // 插件同步没人定过(没有关掉的记号 = 算开着):按新缺省显示关
  try {
    await render()
    const box = host.querySelector('[data-ob-sync]')!
    expect(box.querySelector('.ob3-beta')?.textContent).toBe(translate('ob3.sync.beta'))
    expect(box.textContent).toContain(translate('ob3.sync.betaHint'))
    const boxes = [...box.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(boxes).toHaveLength(2)
    expect(boxes.every((b) => !b.checked)).toBe(true)
    await walkToEnd()
    // 只交出和现状不一样的那一项:插件同步原来算开着,这次按缺省关
    expect(applyOnboardingSync).toHaveBeenCalledExactlyOnceWith({ notes: false, agents: false, plugins: false }, ['plugins'])
  } finally { delete (window as any).remoteSync }
})

it('start: sync that is already on stays ticked, so finishing does not switch it off', async () => {
  vi.mocked(window.tangu!.authStatus!).mockResolvedValue({ loggedIn: true, nickname: 'Q' } as any)
  ;(window as any).remoteSync = {}
  sync.snap = snapshot({ decided: true, notes: { on: true, available: true }, agents: { on: true }, plugins: { on: true } })
  try {
    await render()
    const boxes = [...host.querySelectorAll<HTMLInputElement>('[data-ob-sync] input[type="checkbox"]')]
    expect(boxes.map((b) => b.checked)).toEqual([true, true])
    await walkToEnd()
    expect(applyOnboardingSync).toHaveBeenCalledExactlyOnceWith({ notes: true, agents: true, plugins: true }, [])
  } finally { delete (window as any).remoteSync }
})

it('start: when the notes sync state could not be read, its box is hidden and finishing never touches it', async () => {
  vi.mocked(window.tangu!.authStatus!).mockResolvedValue({ loggedIn: true, nickname: 'Q' } as any)
  ;(window as any).remoteSync = {}
  // 快照读不到 remoteSync 时 notes 是假的「关」(available 也是假):不能拿来当底,否则状态恢复后会把开着的智库同步关掉
  sync.snap = snapshot({ decided: true, notes: { on: false, available: false }, plugins: { on: true } })
  try {
    await render()
    const labels = [...host.querySelectorAll('[data-ob-sync] label')].map((l) => l.textContent)
    expect(labels).toEqual([translate('onboarding.connect.sync.plugins')])
    await walkToEnd()
    expect(applyOnboardingSync).toHaveBeenCalledExactlyOnceWith(expect.anything(), [])
  } finally { delete (window as any).remoteSync }
})

it('start: when the sync state cannot be read, no boxes are shown and finishing leaves sync alone', async () => {
  vi.mocked(window.tangu!.authStatus!).mockResolvedValue({ loggedIn: true, nickname: 'Q' } as any)
  ;(window as any).remoteSync = {}
  sync.snap = null
  try {
    await render()
    expect(host.querySelectorAll('[data-ob-sync] input[type="checkbox"]')).toHaveLength(0)
    await walkToEnd()
    expect(applyOnboardingSync).not.toHaveBeenCalled()
  } finally { delete (window as any).remoteSync }
})

it('start: connected cards get no accent frame; the state shows in the badge and the tile check', async () => {
  vi.mocked(window.tangu!.authStatus!).mockResolvedValue({ loggedIn: true, nickname: 'Q' } as any)
  vi.mocked(window.tangu!.listProviders!).mockResolvedValue([{ providerId: 'openai' }] as any)
  await render()
  expect(host.querySelector('[data-ob-account]')!.classList.contains('pick')).toBe(false)
  expect(host.querySelector('[data-ob-channels]')!.classList.contains('pick')).toBe(false)
  expect(host.querySelector('[data-ob-account] .ob3-chip')?.textContent).toBe(translate('ob3.account.signedIn'))
  expect(host.querySelector('[data-channel="key"] .ob3-mark')).not.toBeNull()
})

it('screens slide in the direction you go: Continue forwards, Back backwards', async () => {
  await render()
  const shell = () => host.querySelector('.ob-flow')!
  expect(shell().getAttribute('data-nav')).toBeNull()
  await next()
  expect(shell().getAttribute('data-nav')).toBe('fwd')
  await act(async () => host.querySelector<HTMLButtonElement>('.ob3-back')!.click())
  await flush()
  expect(stepNow()).toBe('start')
  expect(shell().getAttribute('data-nav')).toBe('back')
  // 开着时把菜单层抬到引导上面(模型选择器的下拉 portal 到 body)
  expect(document.documentElement.hasAttribute('data-ob-open')).toBe(true)
})

it('theme: light / dark / system is the shared view-mode capsule', async () => {
  await render()
  await next()
  const tabs = [...host.querySelectorAll<HTMLButtonElement>('[data-ob-mode] [role="tab"]')]
  expect(tabs.map((b) => b.getAttribute('aria-label'))).toEqual([translate('onboarding.theme.light'), translate('onboarding.theme.dark'), translate('settings.theme.system')])
  expect(tabs[0].getAttribute('aria-selected')).toBe('true')
  await act(async () => tabs[1].click())
  expect(props.onThemeChange).toHaveBeenCalledWith('lovable', 'cream', 'dark')
})

it('team: closing the model menu gives focus back to the picker, so Enter does not finish the guide', async () => {
  await toTeam()
  await act(async () => modelBtn().click())
  expect(document.querySelector('.composer-menu')).not.toBeNull()
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(document.querySelector('.composer-menu')).toBeNull()
  expect(document.activeElement).toBe(modelBtn())
  await pickModel('Model one')
  expect(document.activeElement).toBe(modelBtn())
  expect(props.onFinish).not.toHaveBeenCalled()
})

it('team: Muse shows its own avatar (the uploaded picture, or its initial), not a star', async () => {
  await toTeam()
  const ava = host.querySelector('[data-ob-muse-avatar]')!
  expect(ava.querySelector('svg')).toBeNull()
  expect(ava.textContent).toBe('卜')
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

/** 这一行「进了可视区」才记 noticeSeen;happy-dom 的 IntersectionObserver 从不回调,这里换成一挂上就报看得见的。 */
function rowsVisible(): void {
  vi.stubGlobal('IntersectionObserver', vi.fn(function (this: any, cb: IntersectionObserverCallback) {
    this.observe = (el: Element) => { queueMicrotask(() => cb([{ isIntersecting: true, target: el } as any], this)) }
    this.disconnect = () => {}
  }))
}
afterEach(() => { vi.unstubAllGlobals() })

it('help improve: the update screen shows the notice once to a signed-in user who has not seen it', async () => {
  rowsVisible()
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

it('help improve: signed in, the row marks the notice seen without opening the details', async () => {
  rowsVisible()
  vi.mocked(window.tangu!.authStatus!).mockResolvedValue({ loggedIn: true } as any)
  let view = { available: true, enabled: true, noticeSeen: false, signedIn: true }
  const invoke = vi.fn(async (channel: string, patch?: { enabled?: boolean; noticeSeen?: true }) => {
    if (channel === 'telemetry:set') view = { ...view, ...patch }
    return view
  })
  Object.assign(window.tangu!, { telemetryReport: vi.fn(), cloudInvoke: invoke, openExternal: vi.fn() })
  await render()
  expect(host.querySelector('[data-ob-improve]')).not.toBeNull()
  expect(invoke.mock.calls.filter(([c]) => c === 'telemetry:set')).toEqual([['telemetry:set', { noticeSeen: true }]])
  expect(host.querySelector('.ob3-pop')).toBeNull()
  // ⓘ 还能手动展开
  await act(async () => { (host.querySelector('[data-ob-improve] .ob3-info') as HTMLButtonElement).click() })
  expect(host.querySelector('.ob3-pop')).not.toBeNull()
})

it('help improve: not marked seen while the row is scrolled out of view', async () => {
  const observers: Array<{ cb: IntersectionObserverCallback; el?: Element }> = []
  const IO = vi.fn(function (this: any, cb: IntersectionObserverCallback) {
    const rec: { cb: IntersectionObserverCallback; el?: Element } = { cb }
    observers.push(rec)
    this.observe = (el: Element) => { rec.el = el }
    this.disconnect = () => {}
  })
  vi.stubGlobal('IntersectionObserver', IO)
  try {
    vi.mocked(window.tangu!.authStatus!).mockResolvedValue({ loggedIn: true } as any)
    let view = { available: true, enabled: true, noticeSeen: false, signedIn: true }
    const invoke = vi.fn(async (channel: string, patch?: { enabled?: boolean; noticeSeen?: true }) => {
      if (channel === 'telemetry:set') view = { ...view, ...patch }
      return view
    })
    Object.assign(window.tangu!, { telemetryReport: vi.fn(), cloudInvoke: invoke, openExternal: vi.fn() })
    await render()
    const rec = observers.find((o) => o.el?.hasAttribute('data-ob-improve'))
    expect(rec).toBeDefined()
    expect(invoke).not.toHaveBeenCalledWith('telemetry:set', expect.anything())
    await act(async () => { rec!.cb([{ isIntersecting: true, target: rec!.el! } as any], {} as any) })
    expect(invoke.mock.calls.filter(([c]) => c === 'telemetry:set')).toEqual([['telemetry:set', { noticeSeen: true }]])
  } finally {
    vi.unstubAllGlobals()
  }
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
  await type(youName(), 'not saved')
  await clickText(translate('onboarding.nav.skip'))
  await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await flush()
  expect(props.onFinish).toHaveBeenCalledTimes(1)
  expect(human.saveHumanDocument).not.toHaveBeenCalled()
})

// ── 手机引导(11-13,做法 A):手机入口登记了 phoneGuide 才走;下面用一个假的登记 ──────────────────────────────
type PhoneScreenProps = import('./onboarding/phoneGuide').PhoneScreenProps
function phoneHost(o: {
  where?: boolean; perms?: boolean; prepare?: () => Promise<void>
  permsLabel?: string; permsCommit?: () => Promise<void | boolean>
} = {}) {
  const screen = (step: 'where' | 'perms') => function FakeScreen({ commitRef, setPrimaryLabel }: PhoneScreenProps) {
    React.useEffect(() => {
      if (step === 'perms') {
        if (o.permsLabel) setPrimaryLabel(o.permsLabel)
        commitRef.current = o.permsCommit ?? null
      }
      return () => { commitRef.current = null }
    }, [])
    return React.createElement('div', { 'data-fake-screen': step }, React.createElement('h1', { tabIndex: -1, 'data-ob-title': '' }, step))
  }
  const fake = {
    prepare: vi.fn(o.prepare ?? (async () => {})),
    available: (s: 'where' | 'perms') => (s === 'where' ? o.where ?? true : o.perms ?? true),
    screens: { where: screen('where'), perms: screen('perms') },
    minimize: vi.fn(),
  }
  delete (window.tangu as any).envCheck
  ;(window.tangu as any).mobile = true
  phoneGuideMod.installPhoneGuide(fake)
  return fake
}
afterEach(() => phoneGuideMod.installPhoneGuide(null))
const backEvent = (probe: boolean) => {
  const e = new CustomEvent('forsion:mobile-back', { cancelable: true, detail: probe ? { probe: true } : null })
  window.dispatchEvent(e)
  return e.defaultPrevented
}

it('phone: waits for prepare behind the bare shell, then where → theme → perms', async () => {
  let release!: () => void
  const fake = phoneHost({ prepare: () => new Promise<void>((r) => { release = r }) })
  await render()
  expect(fake.prepare).toHaveBeenCalledTimes(1)
  expect(stepNow()).toBe('pending')
  expect(host.querySelector('.ob3-paper')).not.toBeNull()
  expect(host.querySelector('[data-ob-primary]')).toBeNull()
  expect(host.querySelector('.ob3-top')).toBeNull()
  await act(async () => release())
  await flush()
  expect(stepNow()).toBe('where')
  expect(host.querySelector('.ob-flow')?.getAttribute('data-phone')).toBe('full')
  expect(host.querySelector('[data-fake-screen="where"]')).not.toBeNull()
  expect(host.querySelectorAll('.ob3-dots button')).toHaveLength(3)
  expect(host.querySelector('.ob-skip')).not.toBeNull()
  expect(localStorage.getItem(phoneGuideMod.PHONE_GUIDE_STEP_KEY)).toBe('where')
  await next()
  expect(stepNow()).toBe('theme')
  expect(localStorage.getItem(phoneGuideMod.PHONE_GUIDE_STEP_KEY)).toBe('theme')
  await next()
  expect(stepNow()).toBe('perms')
  expect(primary().textContent).toBe(translate('ob3.getStarted'))
})

it('phone: prepare that never settles is capped, the guide still appears', async () => {
  phoneHost({ prepare: () => new Promise<void>(() => {}) })
  await render()
  expect(stepNow()).toBe('pending')
  await act(async () => { await new Promise((r) => setTimeout(r, 2600)) })
  await flush()
  expect(stepNow()).toBe('where')
}, 10_000)

it('phone: local marks unreadable = unknown → no phone guide is assumed, nothing phone-specific is written', async () => {
  phoneHost()
  // 本机记号读不出来(隐私模式之类):不当成新人走完整的手机引导,落回没登记时的步骤序
  const get = vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied') })
  try {
    await render()
    expect(stepNow()).toBe('theme')
    expect(host.querySelector('.ob-flow')?.hasAttribute('data-phone')).toBe(false)
    expect(host.querySelectorAll('.ob3-dots button')).toHaveLength(0)
  } finally { get.mockRestore() }
  await next()
  expect(localStorage.getItem(phoneGuideMod.PHONE_GUIDE_REV_KEY)).toBeNull()
  expect(localStorage.getItem(phoneGuideMod.PHONE_GUIDE_SUGGEST_KEY)).toBeNull()
})

it('phone: only one place to run → no "where"; the theme screen is the phone variant', async () => {
  phoneHost({ where: false })
  await render()
  expect(stepNow()).toBe('theme')
  expect(host.querySelectorAll('.ob3-dots button')).toHaveLength(2)
  expect(host.querySelector('.ob3-styles')).toBeNull()
  expect(host.querySelector('.ob3-preview')).toBeNull()
  expect(host.querySelector('.ob3-theme.phone')).not.toBeNull()
  expect(host.querySelector('.ob3-col.narrow .ob3-head p')?.textContent).toBe(translate('ob3.theme.descPhone'))
  expect(host.querySelector('.ob3-foot-in')?.classList.contains('narrow')).toBe(true)
  expect(host.querySelector('[data-ob-mode]')).not.toBeNull()
})

it('desktop / web theme screen keeps style and preview', async () => {
  delete (window.tangu as any).envCheck
  await render()
  expect(stepNow()).toBe('theme')
  expect(host.querySelector('.ob3-styles')).not.toBeNull()
  expect(host.querySelector('.ob3-preview')).not.toBeNull()
  expect(host.querySelector('.ob3-theme.phone')).toBeNull()
  expect(host.querySelector('.ob-flow')?.hasAttribute('data-phone')).toBe(false)
})

it('phone: a screen label wins, is reset on leaving; commit false stays without an error', async () => {
  const commit = vi.fn<() => Promise<void | boolean>>().mockResolvedValueOnce(false).mockResolvedValue(undefined)
  phoneHost({ where: false, permsLabel: 'Turn on 2', permsCommit: commit })
  await render()
  await next()
  expect(stepNow()).toBe('perms')
  expect(primary().textContent).toBe('Turn on 2')
  await next()
  expect(commit).toHaveBeenCalledTimes(1)
  expect(stepNow()).toBe('perms')
  expect(host.querySelector('.ob3-error')).toBeNull()
  expect(props.onFinish).not.toHaveBeenCalled()
  await act(async () => host.querySelector<HTMLButtonElement>('.ob3-back')!.click())
  await flush()
  expect(stepNow()).toBe('theme')
  expect(primary().textContent).toBe(translate('ob3.next'))
  await next()
  await next()
  expect(commit).toHaveBeenCalledTimes(2)
  expect(props.onFinish).toHaveBeenCalledTimes(1)
})

it('phone: resumes at the screen it was killed on; finishing writes both keys, the rev and the suggestion mark', async () => {
  localStorage.setItem(phoneGuideMod.PHONE_GUIDE_STEP_KEY, 'perms')
  phoneHost()
  await render()
  expect(stepNow()).toBe('perms')
  const dots = host.querySelectorAll<HTMLButtonElement>('.ob3-dots button')
  expect(dots[0].disabled).toBe(false)
  await next()
  expect(props.onFinish).toHaveBeenCalledTimes(1)
  expect(localStorage.getItem(ONBOARDING_DISMISS_KEY)).toBe('1')
  expect(localStorage.getItem(ONBOARDING_VERSION_KEY)).toBe('2.14.0')
  expect(localStorage.getItem(phoneGuideMod.PHONE_GUIDE_REV_KEY)).toBe(String(phoneGuideMod.PHONE_GUIDE_REV))
  expect(localStorage.getItem(phoneGuideMod.PHONE_GUIDE_SUGGEST_KEY)).toBe('1')
  expect(localStorage.getItem(phoneGuideMod.PHONE_GUIDE_STEP_KEY)).toBeNull()
})

it('phone update: an existing user sees only the new screen, no dots / skip, and no home suggestions', async () => {
  localStorage.setItem(ONBOARDING_DISMISS_KEY, '1')
  localStorage.setItem(ONBOARDING_VERSION_KEY, '2.13.7')
  phoneHost()
  await render()
  expect(stepNow()).toBe('perms')
  expect(host.querySelector('.ob-flow')?.getAttribute('data-phone')).toBe('update')
  expect(host.querySelector('.ob-flow')?.getAttribute('data-mode')).toBe('full')
  expect(host.querySelectorAll('.ob3-dots button')).toHaveLength(0)
  expect(host.querySelector('.ob-skip')).toBeNull()
  expect(primary().textContent).toBe(translate('ob3.getStarted'))
  await next()
  expect(props.onFinish).toHaveBeenCalledTimes(1)
  expect(localStorage.getItem(phoneGuideMod.PHONE_GUIDE_REV_KEY)).toBe(String(phoneGuideMod.PHONE_GUIDE_REV))
  expect(localStorage.getItem(phoneGuideMod.PHONE_GUIDE_SUGGEST_KEY)).toBeNull()
})

it('phone: skipping a full guide still records the rev', async () => {
  phoneHost()
  await render()
  await clickText(translate('onboarding.nav.skip'))
  expect(props.onFinish).toHaveBeenCalledTimes(1)
  expect(localStorage.getItem(phoneGuideMod.PHONE_GUIDE_REV_KEY)).toBe(String(phoneGuideMod.PHONE_GUIDE_REV))
})

it('phone: system back goes to the previous screen and never closes; first screen is left to MobileRoot', async () => {
  phoneHost()
  await render()
  expect(stepNow()).toBe('where')
  expect(backEvent(true)).toBe(false)
  await next()
  expect(stepNow()).toBe('theme')
  expect(backEvent(true)).toBe(true)
  await flush()
  expect(stepNow()).toBe('theme') // probe 只答「我接」,不动手
  await act(async () => { backEvent(false) })
  await flush()
  expect(stepNow()).toBe('where')
  expect(props.onFinish).not.toHaveBeenCalled()
  expect(backEvent(true)).toBe(false)
})

it('without a phone host the back event is never claimed', async () => {
  delete (window.tangu as any).envCheck
  ;(window.tangu as any).mobile = true
  await render()
  expect(backEvent(true)).toBe(false)
})
