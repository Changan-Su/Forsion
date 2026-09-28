// P1-K7a · appStore 的三处(规格 K7 §3.4 / §3.6 / §4.1;安全不变式 S5 / S6):
//   ① workspaces() 只看本端会话 —— 已注入的「我的电脑」会话带着 Mac 的路径,并进来就是手机上的「幽灵本地项目」(负对照 6);
//   ② 在那台电脑上建会话:agent_config 不带手机本地的 Amadeus 根 / 云端项目名 / 外部引擎 / 验证命令 / 轨道身份(负对照 3);
//   ③ 那台上的会话发消息:run 不带手机的 Amadeus 根与生图 / 视觉模型设置;
//   ④ 建会话被拒 → 粘滞拒绝(设备状态)+ 本地化的拒绝原因。
// 手机形态(window.tangu.mobile + 云端 home),authFetch 桩按 URL 路由(同 appStore.target.test.ts)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Reply = { status: number; body?: unknown }
type Call = { url: string; method: string; body: string | undefined }
const calls: Call[] = []
let router: (url: string, method: string) => Reply | Promise<Reply> = () => ({ status: 200, body: {} })
vi.mock('../services/http', () => ({
  authFetch: async (url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase()
    calls.push({ url: String(url), method, body: typeof init?.body === 'string' ? init.body : undefined })
    const r = await router(String(url), method)
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}), { status: r.status })
  },
  setUnauthorizedHandler: () => {},
}))

const { useApp } = await import('./appStore')
const T = await import('../services/engine/targets')
const H = await import('../services/engine/health')
const C = await import('../services/engine/catalog')
const { usePageStore } = await import('../amadeus/store/pageStore')
const { useDeviceMarks, resetDeviceMarks } = await import('../services/deviceMarks')
const { describeDevice } = await import('../services/deviceStatus')
const initial = useApp.getState()

const U = '7f0e8a52-0000-4000-8000-00000000000a'
const API = 'https://api.forsion.test/api'
const UNIT = `${API}/units/${U}/proxy/engine`
const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '')
const TOKEN = `${b64({ alg: 'none' })}.${b64({ userId: 'u-42' })}.sig`
const store = new Map<string, string>()
const toast = vi.fn()

function armMobile(): void {
  ;(globalThis as any).window = {
    tangu: {
      mobile: true,
      authStatus: async () => ({ cloudUrl: API, username: 'u', tokenSource: 'config', loggedIn: true, tokenValid: true }),
      getConfig: async () => ({ mode: 'external', backendUrl: API, token: TOKEN, cloudUrl: API, cloudApiBase: API }),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  useApp.setState({
    ...initial,
    tr: (k: string) => k,
    toast,
    cfg: { backendUrl: API, token: TOKEN, modelId: 'phone-model', imageModelId: 'phone-image', visionModelId: 'phone-vision', visionMode: 'always' } as any,
    desktopConfig: { mode: 'external', backendUrl: API, token: TOKEN, cloudUrl: API, cloudApiBase: API } as any,
    desktopMode: 'external',
    connState: 'ok',
    authInfo: { loggedIn: true, cloudUrl: API, username: 'u', tokenSource: 'tangu-login' },
  }, true)
}

const rec = (id: string, extra: object = {}) => ({ id, title: id, created_at: '2026-09-28T00:00:00Z', updated_at: '2026-09-28T00:00:00Z', ...extra })

beforeEach(() => {
  calls.length = 0
  store.clear()
  toast.mockClear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
  })
  T.resetFocusForTests()
  T.clearSessionBindings()
  H.resetHealth()
  C.forgetCatalog()
  resetDeviceMarks()
  armMobile()
  // 手机上的 Amadeus 库根(真实场景:云端库挂在手机上)。本机会话会把它并进 extraRoots;远端会话绝不能带
  usePageStore.setState({ vaultRoot: '/phone/vault' })
  router = (url, method) => {
    if (url.endsWith('/health')) return { status: 200, body: { ok: true, sandbox: 'none' } }
    if (url.includes('/agent/sessions?archived')) return { status: 200, body: { sessions: [] } }
    if (url.includes('/unit/config')) return { status: 200, body: { config: { homeDir: '/Users/mac', defaultWorkspaceDir: '/Users/mac/Forsion' } } }
    if (method === 'POST' && url === `${UNIT}/agent/sessions`) return { status: 200, body: { session: rec('s-mac', { agent_config: { execMode: 'host' } }) } }
    if (method === 'POST' && url.endsWith('/agent/runs')) return { status: 200, body: { runId: 'r-1' } }
    return { status: 200, body: {} }
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  usePageStore.setState({ vaultRoot: null })
  delete (globalThis as any).window
})

const FORBIDDEN = ['extraRoots', 'workspaceProject', 'engineId', 'engineModelId', 'verifyCommand', 'soloAgentSlug', 'teamSlug']

describe('① workspaces() ignores injected remote sessions (no phantom local project)', () => {
  it('a Mac session with a Mac path adds no local group on the phone; the same path on a home session still does', () => {
    useApp.setState({
      sessions: [
        { ...rec('s-mac', { project_path: '/Users/mac/secret-proj', project_name: 'secret-proj' }), location: { kind: 'unit', unitId: U } } as any,
        rec('home-1', { project_path: '/home/me/proj', project_name: 'proj' }) as any,
      ],
      archivedSessions: [{ ...rec('s-mac-a', { project_path: '/Users/mac/old', project_name: 'old', archived: true }), location: { kind: 'unit', unitId: U } } as any],
    })
    const keys = useApp.getState().workspaces().map((w) => w.key)
    expect(keys).toContain('/home/me/proj')
    expect(keys).not.toContain('/Users/mac/secret-proj')
    expect(keys).not.toContain('/Users/mac/old')
  })
})

describe('② creating on a computer: the draft never carries phone-local keys (S6)', () => {
  it('send() with the draft on the Mac: POST goes to the Mac, agent_config has no phone Amadeus root / cloud project / engine / verify / orbit identity', async () => {
    await T.setFocusTarget({ kind: 'unit', unitId: U }, { name: 'Mac mini' })
    useApp.setState({
      newChatWs: { key: '/Users/mac/proj', name: 'proj', kind: 'local', path: '/Users/mac/proj' },
      newChatCfg: { engineId: 'claude-code', engineModelId: 'x', verifyCommand: 'npm test', extraRoots: ['/phone/docs'], soloAgentSlug: 'a', teamSlug: 't', workspaceProject: 'Tangu' } as any,
    })
    await useApp.getState().send('hi', [])
    const post = calls.find((c) => c.method === 'POST' && c.url === `${UNIT}/agent/sessions`)
    expect(post).toBeTruthy()
    const init = JSON.parse(post!.body!).agent_config
    expect(init.execMode).toBe('host')
    expect(init.cwd).toBe('/Users/mac/proj')
    for (const k of FORBIDDEN) expect(init, k).not.toHaveProperty(k)
    expect(calls.some((c) => c.method === 'POST' && c.url === `${API}/agent/sessions`)).toBe(false)
  })

  it('createInWorkspace on the Mac: same rule', async () => {
    await T.setFocusTarget({ kind: 'unit', unitId: U }, { name: 'Mac mini' })
    await useApp.getState().createInWorkspace({ key: '/Users/mac/proj', name: 'proj', kind: 'local', path: '/Users/mac/proj' })
    const init = JSON.parse(calls.find((c) => c.method === 'POST' && c.url === `${UNIT}/agent/sessions`)!.body!).agent_config
    for (const k of FORBIDDEN) expect(init, k).not.toHaveProperty(k)
  })

  it('positive control: a home (cloud) session on the phone still gets the Amadeus root when host-capable', async () => {
    // 本端会话照旧并 Amadeus 根(证明上面的断言看得见 extraRoots)
    router = (url, method) => {
      if (method === 'POST' && url === `${API}/agent/sessions`) return { status: 200, body: { session: rec('s-home') } }
      if (method === 'POST' && url.endsWith('/agent/runs')) return { status: 200, body: { runId: 'r-1' } }
      return { status: 200, body: { sessions: [] } }
    }
    await useApp.getState().createInWorkspace({ key: '/home/me/p', name: 'p', kind: 'local', path: '/home/me/p' })
    const init = JSON.parse(calls.find((c) => c.method === 'POST' && c.url === `${API}/agent/sessions`)!.body!).agent_config
    expect(init.extraRoots).toEqual(['/phone/vault'])
  })
})

describe('③ sending in a Mac session: the run carries no phone Amadeus root / image / vision settings', () => {
  it('run agent_config for a bound unit session', async () => {
    T.bindSession('s-mac', { kind: 'unit', unitId: U })
    useApp.setState({
      sessions: [{ ...rec('s-mac'), location: { kind: 'unit', unitId: U } } as any],
      configBySession: { 's-mac': { execMode: 'host', cwd: '/Users/mac/proj' } },
      activeId: 's-mac',
    })
    await useApp.getState().send('hello', [], undefined, undefined, undefined, 's-mac')
    const run = calls.find((c) => c.method === 'POST' && c.url === `${UNIT}/agent/runs`)
    expect(run).toBeTruthy()
    const cfg = JSON.parse(run!.body!).agent_config
    expect(cfg.extraRoots).toBeUndefined()
    expect(cfg.imageModelId).toBeUndefined()
    expect(cfg.visionModelId).toBeUndefined()
    expect(cfg.visionMode).toBeUndefined()
    expect(calls.some((c) => c.method !== 'GET' && (c.body || '').includes('/phone/vault'))).toBe(false) // 也不回写 extraRoots(Agent 固化的 PATCH 照常)
  })
})

describe('④ refused create on a computer', () => {
  it('REMOTE_SESSIONS_OFF → sticky refusal (remoteOff) + the localized reason, not the generic toast', async () => {
    await T.setFocusTarget({ kind: 'unit', unitId: U }, { name: 'Mac mini' })
    router = (url, method) => {
      if (method === 'POST' && url === `${UNIT}/agent/sessions`) return { status: 403, body: { code: 'REMOTE_SESSIONS_OFF', detail: '远程会话已关闭' } }
      if (url.endsWith('/health')) return { status: 200, body: { ok: true } }
      return { status: 200, body: {} }
    }
    useApp.setState({ newChatWs: { key: '/Users/mac/proj', name: 'proj', kind: 'local', path: '/Users/mac/proj' } })
    expect(await useApp.getState().send('hi', [])).toBe(false)
    const sticky = useDeviceMarks.getState().sticky[U]
    expect(sticky?.code).toBe('REMOTE_SESSIONS_OFF')
    expect(describeDevice({ online: true, caps: { engine: 'ready' }, capsLive: true }, { ok: true }, sticky).status).toBe('remoteOff')
    const msg = String(toast.mock.calls.at(-1)?.[0] ?? '')
    expect(msg).not.toBe('app.cannotCreateSession')
    expect(msg).toMatch(/远程会话|Remote sessions/)
  })
})
