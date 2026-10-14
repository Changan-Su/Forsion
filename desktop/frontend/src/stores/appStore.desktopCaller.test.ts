// 桌面作为调用方(2026-10-14):桌面主窗口把新会话建到「我的另一台电脑」上 —— store 层的三件桌面独有的事。
//   ① 那台的家目录 / 默认工作区另放 focusDirs,这台电脑自己的 homeDir / defaultWsDir 不动(侧栏 / 文件面板 / 设置在读);
//   ② 新对话建在那台:请求打主进程的中转口、带本次启动的口令,不带这台电脑的额外文件夹 / 笔记库;
//   ③ 侧栏分组的「+」/ 添加本地项目(here)= 这台电脑的文件夹:运行位置停在别的电脑上时先切回这台电脑再建。
// 手机形态的同一套见 appStore.target.test.ts。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Call = { url: string; method: string; body: string | undefined; headers: Record<string, string> }
const calls: Call[] = []
/** 扣住匹配的请求,直到测试放行(造「等项目默认项的空当里换了运行位置」那个竞态)。 */
let gate: { match: RegExp; wait: Promise<void>; hit: () => void } | null = null
vi.mock('../services/http', () => ({
  authFetch: async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (gate?.match.test(u)) { gate.hit(); await gate.wait }
    calls.push({ url: u, method: (init?.method || 'GET').toUpperCase(), body: typeof init?.body === 'string' ? init.body : undefined, headers: (init?.headers || {}) as Record<string, string> })
    const body = u.endsWith('/health') ? { ok: true, sandbox: 'none' }
      : u.includes('/unit/config') ? { config: { homeDir: '/Users/mini', defaultWorkspaceDir: '/Users/mini/Forsion' } }
      : u.includes('/agent/models') ? { models: [{ id: 'mini-model', name: 'Mini' }], defaultModelId: 'mini-model' }
      : u.includes('/agent/sessions') && (init?.method || 'GET').toUpperCase() === 'POST' ? { session: { id: `s-${calls.length}`, title: '', created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z' } }
      : u.includes('/agent/sessions?') ? { sessions: [] }
      : u.includes('/agent/runs?') ? { runs: [] }
      : /\/agent\/sessions\/[^/]+\/messages/.test(u) ? { messages: [] }
      : {}
    return new Response(JSON.stringify(body), { status: 200 })
  },
  setUnauthorizedHandler: () => {},
}))

const { useApp, newSessionDirs, resolveNewSessionWorkspace } = await import('./appStore')
const T = await import('../services/engine/targets')
const H = await import('../services/engine/health')
const C = await import('../services/engine/catalog')
const initial = useApp.getState()

const U = '7f0e8a52-0000-4000-8000-00000000000a'
const LOCAL = 'http://127.0.0.1:4100'
const RELAY = { base: 'http://127.0.0.1:41234', token: 'boot-secret', accountId: 'https://api.forsion.test/api::u-42' }
const UNIT = `${RELAY.base}/units/${U}/proxy`

beforeEach(async () => {
  calls.length = 0
  gate = null
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)) }, removeItem: (k: string) => { store.delete(k) } })
  ;(globalThis as any).window = {
    tangu: { unitRelay: async () => RELAY, authStatus: async () => ({ loggedIn: true, tokenValid: true }) },
    addEventListener: () => {}, removeEventListener: () => {},
  }
  T.resetFocusForTests()
  T.clearSessionBindings()
  H.resetHealth()
  C.forgetCatalog()
  useApp.setState({
    ...initial,
    tr: (k: string) => k,
    toast: vi.fn(),
    cfg: { backendUrl: LOCAL, token: 'engine-token', modelId: 'local-model' },
    desktopConfig: { mode: 'managed', backendUrl: LOCAL, token: 'engine-token', cloudUrl: 'https://api.forsion.test' } as any,
    desktopMode: 'managed',
    sessionMode: 'work',
    connState: 'ok',
    homeDir: '/Users/me',
    defaultWsDir: '/Users/me/Forsion',
  }, true)
  await T.refreshDesktopRelay()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (globalThis as any).window
})

const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)) }
const creates = (): Call[] => calls.filter((c) => c.method === 'POST' && /\/agent\/sessions$/.test(c.url))

describe('桌面把运行位置放到别的电脑上', () => {
  it('① 那台的目录进 focusDirs;这台电脑自己的 homeDir / defaultWsDir 不动,回来时 focusDirs 清掉', async () => {
    await T.setFocusTarget({ kind: 'unit', unitId: U }, { name: 'Mac mini' })
    await settle()
    const s = useApp.getState()
    expect([s.homeDir, s.defaultWsDir]).toEqual(['/Users/me', '/Users/me/Forsion'])
    expect(s.focusDirs).toEqual({ homeDir: '/Users/mini', defaultWsDir: '/Users/mini/Forsion' })
    expect(newSessionDirs(s).defaultWsDir).toBe('/Users/mini/Forsion')
    expect(resolveNewSessionWorkspace(s, 'desktop').path).toBe('/Users/mini/Forsion')
    // 本机的项目列表不被那台的目录带偏(默认工作区仍是这台电脑的)
    expect(s.workspaces().find((w) => w.isDefault)?.path).toBe('/Users/me/Forsion')
    await T.setFocusTarget({ kind: 'home' })
    expect(useApp.getState().focusDirs).toBeNull()
    expect(resolveNewSessionWorkspace(useApp.getState(), 'desktop').path).toBe('/Users/me/Forsion')
  })

  it('② 新对话建在那台:打中转口、带本次启动的口令;落点是那台的默认工作区,不带这台电脑的额外文件夹', async () => {
    await T.setFocusTarget({ kind: 'unit', unitId: U }, { name: 'Mac mini' })
    await settle()
    useApp.setState({ newChatCfg: { extraRoots: ['/Users/me/Notes'] } })
    calls.length = 0
    await useApp.getState().newSession()
    const [c] = creates()
    expect(c.url).toBe(`${UNIT}/engine/agent/sessions`)
    expect(c.headers.Authorization).toBe('Bearer boot-secret')
    const body = JSON.parse(c.body!)
    expect(body.project_path).toBe('/Users/mini/Forsion')
    expect(body.agent_config.cwd).toBe('/Users/mini/Forsion')
    expect(JSON.stringify(body)).not.toMatch(/\/Users\/me/)
    const sid = useApp.getState().activeId!
    expect(T.locationOf(sid)).toEqual({ kind: 'unit', unitId: U })
    expect(useApp.getState().sessions.find((x) => x.id === sid)?.location).toEqual({ kind: 'unit', unitId: U })
  })

  it('③ 侧栏分组的「+」(here)指的是这台电脑的文件夹:先切回这台电脑,会话建在本机引擎上', async () => {
    await T.setFocusTarget({ kind: 'unit', unitId: U }, { name: 'Mac mini' })
    await settle()
    calls.length = 0
    await useApp.getState().createInWorkspace({ key: '/Users/me/code', name: 'code', kind: 'local', path: '/Users/me/code' }, { here: true })
    expect(T.focusRef()).toEqual({ kind: 'home' })
    const [c] = creates()
    expect(c.url).toBe(`${LOCAL}/agent/sessions`)
    expect(c.headers.Authorization).toBe('Bearer engine-token')
    expect(JSON.parse(c.body!).project_path).toBe('/Users/me/code')
    expect(T.locationOf(useApp.getState().activeId!)).toEqual({ kind: 'home' })
  })

  it('③ 别处塞进来的这台电脑的文件夹(Coding Studio / 项目详情 / 创作卡片 …)→ 运行位置回这台电脑;那台的项目(带 unitId)留在那台', async () => {
    await T.setFocusTarget({ kind: 'unit', unitId: U }, { name: 'Mac mini' })
    await settle()
    useApp.getState().setNewChatWs({ key: '/Users/mini/code/webapp', name: 'webapp', kind: 'local', path: '/Users/mini/code/webapp', unitId: U })
    expect(T.focusRef()).toEqual({ kind: 'unit', unitId: U })
    expect(useApp.getState().newChatWs?.path).toBe('/Users/mini/code/webapp')
    useApp.getState().setNewChatWs({ key: '/Users/me/code', name: 'code', kind: 'local', path: '/Users/me/code' })
    await settle()
    expect(T.focusRef()).toEqual({ kind: 'home' })
    expect(useApp.getState().newChatWs?.path).toBe('/Users/me/code')
    expect(useApp.getState().focusDirs).toBeNull()
  })

  // Codex 评审 10-14 P1:位置与项目目录必须同一时刻定下
  it('③ 点了本机分组的「+」、还在等项目默认项时又把运行位置换到别的电脑:这一个会话仍建在本机,这台电脑的路径不出门', async () => {
    let release = (): void => {}
    let reached = (): void => {}
    const hit = new Promise<void>((r) => { reached = r })
    gate = { match: /\/agent\/project-context\/settings/, wait: new Promise<void>((r) => { release = r }), hit: reached }
    const creating = useApp.getState().createInWorkspace({ key: '/Users/me/code', name: 'code', kind: 'local', path: '/Users/me/code' }, { here: true })
    await hit
    await T.setFocusTarget({ kind: 'unit', unitId: U }, { name: 'Mac mini' })
    release()
    await creating
    const [c] = creates()
    expect(c.url).toBe(`${LOCAL}/agent/sessions`)
    expect(JSON.parse(c.body!).project_path).toBe('/Users/me/code')
    expect(calls.filter((x) => x.url.startsWith(RELAY.base) && (x.body || '').includes('/Users/me'))).toEqual([])
    expect(T.locationOf(useApp.getState().sessions[0].id)).toEqual({ kind: 'home' })
  })

  it('③ 新对话草稿同理:发第一条消息、等项目默认项时把位置换到别的电脑,会话仍建在发的那一刻的位置上', async () => {
    useApp.setState({ newChatWs: { key: '/Users/me/code', name: 'code', kind: 'local', path: '/Users/me/code' } })
    let release = (): void => {}
    let reached = (): void => {}
    const hit = new Promise<void>((r) => { reached = r })
    gate = { match: /\/agent\/project-context\/settings/, wait: new Promise<void>((r) => { release = r }), hit: reached }
    const sending = useApp.getState().send('hi', [])
    await hit
    await T.setFocusTarget({ kind: 'unit', unitId: U }, { name: 'Mac mini' })
    release()
    await sending
    await settle()
    const made = creates()
    expect(made.map((c) => c.url)).toEqual([`${LOCAL}/agent/sessions`])
    expect(calls.filter((x) => x.url.startsWith(RELAY.base) && (x.body || '').includes('/Users/me'))).toEqual([])
  })

  it('③ 负对照:不带 here(新对话草稿 / 「新建会话」)就建在运行位置上', async () => {
    await T.setFocusTarget({ kind: 'unit', unitId: U }, { name: 'Mac mini' })
    await settle()
    calls.length = 0
    await useApp.getState().createInWorkspace({ key: '/Users/mini/x', name: 'x', kind: 'local', path: '/Users/mini/x' })
    expect(T.focusRef()).toEqual({ kind: 'unit', unitId: U })
    expect(creates()[0].url).toBe(`${UNIT}/engine/agent/sessions`)
  })

  it('④ 打开别的电脑上的会话:这台电脑的笔记库根不并进它的配置;本机会话照并(真 Electron 截图里查出来的)', async () => {
    const { usePageStore } = await import('../amadeus/store/pageStore')
    usePageStore.setState({ vaultRoot: '/Users/me/Forsion/Amadeus' })
    const at = '2026-10-14T00:00:00Z'
    T.bindSession('remote-1', { kind: 'unit', unitId: U })
    useApp.setState({ sessions: [
      { id: 'remote-1', title: 'r', project_path: '/Users/mini/code/webapp', created_at: at, updated_at: at },
      { id: 'local-1', title: 'l', project_path: '/Users/me/code/app', created_at: at, updated_at: at },
    ] as any })
    await useApp.getState().loadSessionHistory('remote-1')
    await useApp.getState().loadSessionHistory('local-1')
    await settle()
    const { configBySession } = useApp.getState()
    expect(configBySession['remote-1']).toMatchObject({ execMode: 'host', cwd: '/Users/mini/code/webapp' })
    expect(configBySession['remote-1'].extraRoots ?? []).toEqual([])
    expect(configBySession['local-1'].extraRoots).toEqual(['/Users/me/Forsion/Amadeus'])
    usePageStore.setState({ vaultRoot: null })
  })
})
