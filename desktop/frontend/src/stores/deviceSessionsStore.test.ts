// P1-K7a 跨设备会话聚合(规格 K7 §3.3–§3.4 / §5 S2 S4 S10;INTEGRATION R-16 / R-17)。
// 真 K6 targets(绑定表 / engineFetch / 401 分流)+ 真 deviceStatus;appStore / sessionNav / lcl 引擎换成替身。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { SessionRecord, UnitInfo } from '../types'

// ── appStore 替身(只留本模块读写的那几项)──
interface FakeApp {
  sessions: SessionRecord[]
  archivedSessions: SessionRecord[]
  configBySession: Record<string, unknown>
  activeId: string | null
  cfg: { backendUrl: string; token: string }
  toast: (t: string, e?: boolean) => void
  tr: (k: string) => string
  setActiveId: (id: string | null) => void
}
const opened: string[] = []
const fakeApp = create<FakeApp>((set) => ({
  sessions: [],
  archivedSessions: [],
  configBySession: {},
  activeId: null,
  cfg: { backendUrl: 'https://api.test/api', token: '' },
  toast: () => {},
  tr: (k) => k,
  setActiveId: (id) => set({ activeId: id }),
}))
vi.mock('./appStore', () => ({ useApp: fakeApp }))
vi.mock('../sessionNav', () => ({
  openSession: (id: string) => {
    // inject-on-open:打开的那一刻记录必须已经在列表里、且已绑好(setActiveId → loadSessionHistory 按绑定路由)
    const st = fakeApp.getState()
    opened.push(`${id}|listed=${st.sessions.some((x) => x.id === id)}`)
    st.setActiveId(id)
  },
}))
vi.mock('@lcl/engine', () => ({ setActiveSpace: () => {}, useSpaceStore: { getState: () => ({ activeSpaceId: 'tangu' }) } }))

const T = await import('../services/engine/targets')
const { setUnauthorizedHandler } = await import('../services/http')
const S = await import('./deviceSessionsStore')
const { useDeviceMarks } = await import('../services/deviceMarks')

const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url')
const JWT = `h.${b64({ userId: 'u-42' })}.s`
const API = 'https://api.test/api'
const MAC = '11111111-2222-4333-8444-555555555555'
const PC = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const PHONE = '99999999-8888-4777-8666-555555555555'

const unit = (id: string, o: Partial<UnitInfo> = {}): UnitInfo => ({ id, name: `dev-${id.slice(0, 4)}`, platform: 'darwin', icon: null, online: true, kind: 'desktop', caps: { engine: 'ready', tools: [] }, capsLive: true, ...o })
const sess = (id: string, o: Partial<SessionRecord> = {}): SessionRecord => ({ id, title: `t-${id}`, model_id: 'm', created_at: '', updated_at: '2026-09-28 10:00:00', ...o } as SessionRecord)

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>
let roster: UnitInfo[] = []
let handler: Handler = () => new Response('{"sessions":[]}', { status: 200 })
const calls: Array<{ method: string; url: string }> = []
const store = new Map<string, string>()
const setItem = vi.fn((k: string, v: string) => { store.set(k, v) })

beforeEach(() => {
  opened.length = 0
  calls.length = 0
  store.clear()
  setItem.mockClear()
  roster = []
  handler = () => new Response('{"sessions":[]}', { status: 200 })
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem, removeItem: (k: string) => store.delete(k) })
  vi.stubGlobal('window', {
    tangu: {
      mobile: true,
      cloudWeb: true,
      unitsList: async () => ({ status: 200, json: { units: roster } }),
      unitSelf: async () => ({ registered: true, unitId: PHONE, name: 'Pixel' }),
    },
  })
  vi.stubGlobal('fetch', vi.fn(async (u: string, init: RequestInit = {}) => {
    calls.push({ method: init.method || 'GET', url: String(u) })
    return handler(String(u), init)
  }))
  fakeApp.setState({ sessions: [], archivedSessions: [], configBySession: {}, activeId: null, cfg: { backendUrl: API, token: JWT } })
  T.installEngineHost({
    cfg: () => fakeApp.getState().cfg as never,
    desktopConfig: () => ({ cloudApiBase: API } as never),
    isHomeSession: (sid) => fakeApp.getState().sessions.some((x) => x.id === sid && !x.location) || fakeApp.getState().archivedSessions.some((x) => x.id === sid && !x.location),
  })
  T.clearSessionBindings()
  T.resetFocusForTests()
  S.useDeviceSessions.getState().reset()
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

const statusOf = (id: string): string => S.statusOfUnit(S.unitById(id)!).status

describe('roster', () => {
  it('keeps desktops (and kind-less old rows), drops phones and this device', async () => {
    roster = [unit(MAC), unit(PHONE), unit(PC, { kind: undefined }), unit('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', { kind: 'phone' })]
    await S.useDeviceSessions.getState().refresh()
    expect(S.useDeviceSessions.getState().units!.map((u) => u.id)).toEqual([MAC, PC])
  })
})

describe('per-device lists and status (D6)', () => {
  it('lists a ready computer through the proxy, newest first, with limit and app_id', async () => {
    roster = [unit(MAC)]
    handler = () => Response.json({ sessions: [sess('r1'), sess('r2')] })
    await S.useDeviceSessions.getState().refresh()
    const e = S.useDeviceSessions.getState().byUnit[MAC]
    expect(e.sessions.map((x) => x.id)).toEqual(['r1', 'r2'])
    expect(calls[0].url).toBe(`${API}/units/${MAC}/proxy/engine/agent/sessions?archived=false&limit=50&app_id=tangu`)
    expect(statusOf(MAC)).toBe('ready')
  })

  it('offline computer: no request, no rows; engine stopped / starting / external: no request, distinct statuses', async () => {
    roster = [unit(MAC, { online: false }), unit(PC, { caps: { engine: 'stopped' } })]
    await S.useDeviceSessions.getState().refresh()
    expect(calls).toHaveLength(0)
    expect(statusOf(MAC)).toBe('offline')
    expect(statusOf(PC)).toBe('engineStopped')
    roster = [unit(PC, { caps: { engine: 'starting' } })]
    await S.useDeviceSessions.getState().refresh({ force: true })
    expect(statusOf(PC)).toBe('starting')
    roster = [unit(PC, { caps: { engine: 'external' } })]
    await S.useDeviceSessions.getState().refresh({ force: true })
    expect(statusOf(PC)).toBe('noEngine')
    expect(calls).toHaveLength(0)
  })

  it('probe codes: ENGINE_NOT_READY → starting (a ready caps is not trusted over the 503), UNIT_OFFLINE → offline, network → unreachable', async () => {
    roster = [unit(MAC)]
    handler = () => Response.json({ code: 'ENGINE_NOT_READY', detail: '引擎未就绪' }, { status: 503 })
    await S.useDeviceSessions.getState().refresh()
    expect(statusOf(MAC)).toBe('starting')
    expect(S.useDeviceSessions.getState().byUnit[MAC].sessions).toEqual([])
    handler = () => Response.json({ code: 'UNIT_OFFLINE' }, { status: 503 })
    await S.useDeviceSessions.getState().refresh({ force: true })
    expect(statusOf(MAC)).toBe('offline')
    handler = () => { throw new TypeError('Failed to fetch') }
    await S.useDeviceSessions.getState().refresh({ force: true })
    expect(statusOf(MAC)).toBe('unreachable')
  })

  it('a transient failure keeps the last rows (still openable); offline clears them (D6)', async () => {
    roster = [unit(MAC)]
    handler = () => Response.json({ sessions: [sess('r1')] })
    await S.useDeviceSessions.getState().refresh()
    handler = () => { throw new TypeError('Failed to fetch') }
    await S.useDeviceSessions.getState().refresh({ force: true })
    expect(statusOf(MAC)).toBe('unreachable')
    expect(S.useDeviceSessions.getState().byUnit[MAC].sessions.map((x) => x.id)).toEqual(['r1'])
    handler = () => Response.json({ code: 'UNIT_OFFLINE' }, { status: 503 })
    await S.useDeviceSessions.getState().refresh({ force: true })
    expect(S.useDeviceSessions.getState().byUnit[MAC].sessions).toEqual([])
  })

  it('8s timeout → unreachable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    roster = [unit(MAC)]
    handler = (_u, init) => new Promise<Response>((_r, rej) => { init.signal?.addEventListener('abort', () => rej(new DOMException('timeout', 'TimeoutError'))) })
    const p = S.useDeviceSessions.getState().refresh()
    await vi.advanceTimersByTimeAsync(S.DEVICE_LIST_TIMEOUT_MS + 10)
    await p
    expect(statusOf(MAC)).toBe('unreachable')
  })

  it('refused create is sticky (remote sessions off shows even though listing is 200)', async () => {
    roster = [unit(MAC)]
    handler = () => Response.json({ sessions: [] })
    const { noteDeviceRefusal } = await import('../services/deviceMarks')
    noteDeviceRefusal(MAC, Object.assign(new Error('off'), { status: 403, code: 'REMOTE_SESSIONS_OFF' }))
    await S.useDeviceSessions.getState().refresh()
    expect(statusOf(MAC)).toBe('remoteOff')
  })

  it('account change (gen) drops in-flight results', async () => {
    roster = [unit(MAC)]
    let release!: () => void
    handler = () => new Promise<Response>((r) => { release = () => r(Response.json({ sessions: [sess('late')] })) })
    const p = S.useDeviceSessions.getState().refresh()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    S.useDeviceSessions.getState().reset()
    release()
    await p
    expect(S.useDeviceSessions.getState().byUnit[MAC]).toBeUndefined()
    expect(useDeviceMarks.getState().probes[MAC]).toBeUndefined()
  })

  it('S10: a 401 from the computer is routed to that target, never to home (no logout)', async () => {
    const seen: string[] = []
    setUnauthorizedHandler((t) => seen.push(t))
    roster = [unit(MAC)]
    handler = () => new Response('{}', { status: 401 })
    await S.useDeviceSessions.getState().refresh()
    expect(seen).toEqual([`unit:${MAC}`])
  })
})

describe('collision (S2 / R-16): the home row wins, listing never binds', () => {
  it('drops a listed id that is a home session or bound to another computer; listing writes nothing to storage', async () => {
    fakeApp.setState({ sessions: [sess('home-1')] })
    T.bindSession('bound-pc', { kind: 'unit', unitId: PC })
    setItem.mockClear()
    roster = [unit(MAC)]
    handler = () => Response.json({ sessions: [sess('home-1', { title: 'HIJACK' }), sess('bound-pc'), sess('mine')] })
    await S.useDeviceSessions.getState().refresh()
    expect(S.useDeviceSessions.getState().byUnit[MAC].sessions.map((x) => x.id)).toEqual(['mine'])
    expect(T.locationOf('mine')).toEqual({ kind: 'home' }) // 列出来不等于绑定
    expect(setItem).not.toHaveBeenCalled()
    // 硬要打开撞 id 的那条:拒绝,不改绑
    expect(S.adoptRemoteSession(sess('home-1'), { kind: 'unit', unitId: MAC })).toBe(false)
    expect(S.adoptRemoteSession(sess('bound-pc'), { kind: 'unit', unitId: MAC })).toBe(false)
    expect(T.locationOf('bound-pc')).toEqual({ kind: 'unit', unitId: PC })
    expect(opened).toEqual([])
  })
})

describe('inject-on-open (R-17)', () => {
  it('adopt binds, tags via withLocation, inserts before opening; refreshSessions-style keep works off the tag', async () => {
    roster = [unit(MAC)]
    handler = () => Response.json({ sessions: [sess('r1', { agent_config: { preset: 'chat' } as never, location: { kind: 'home' } as never })] })
    await S.useDeviceSessions.getState().refresh()
    const row = S.useDeviceSessions.getState().byUnit[MAC].sessions[0]
    expect((row as { location?: unknown }).location).toBeUndefined() // 设备自报的 location 一律扔掉
    expect(S.adoptRemoteSession(row, { kind: 'unit', unitId: MAC })).toBe(true)
    expect(opened).toEqual(['r1|listed=true'])
    expect(T.locationOf('r1')).toEqual({ kind: 'unit', unitId: MAC })
    const rec = fakeApp.getState().sessions.find((x) => x.id === 'r1')!
    expect(rec.location).toEqual({ kind: 'unit', unitId: MAC })
    expect(fakeApp.getState().configBySession.r1).toEqual({ preset: 'chat' })
    expect([...store.keys()].some((k) => k.startsWith('forsion_session_targets:'))).toBe(true) // 打开才落盘
  })

  it('openRemoteSession (K3 inbox): not listed → fetches /detail from that computer, then adopts; unknown / home ids → false', async () => {
    roster = [unit(MAC)]
    handler = (u) => (u.endsWith('/agent/sessions/s-9/detail') ? Response.json({ session: sess('s-9') }) : Response.json({ sessions: [] }))
    await S.useDeviceSessions.getState().refresh()
    expect(await S.openRemoteSession(MAC, 's-9')).toBe(true)
    expect(calls.some((c) => c.url === `${API}/units/${MAC}/proxy/engine/agent/sessions/s-9/detail`)).toBe(true)
    expect(T.locationOf('s-9')).toEqual({ kind: 'unit', unitId: MAC })
    // 已注入:再开不再拉
    const n = calls.length
    expect(await S.openRemoteSession(MAC, 's-9')).toBe(true)
    expect(calls.length).toBe(n)
    fakeApp.setState({ sessions: [...fakeApp.getState().sessions, sess('home-x')] })
    expect(await S.openRemoteSession(MAC, 'home-x')).toBe(false)
    expect(await S.openRemoteSession('not-a-uuid', 's-1')).toBe(false)
  })

  it('refresh re-syncs title / updated_at into an injected record', async () => {
    roster = [unit(MAC)]
    handler = () => Response.json({ sessions: [sess('r1')] })
    await S.useDeviceSessions.getState().refresh()
    S.adoptRemoteSession(S.useDeviceSessions.getState().byUnit[MAC].sessions[0], { kind: 'unit', unitId: MAC })
    handler = () => Response.json({ sessions: [sess('r1', { title: 'renamed on the Mac', updated_at: '2026-09-28 11:00:00' })] })
    await S.useDeviceSessions.getState().refresh({ force: true })
    const rec = fakeApp.getState().sessions.find((x) => x.id === 'r1')!
    expect(rec.title).toBe('renamed on the Mac')
    expect(rec.updated_at).toBe('2026-09-28 11:00:00')
  })
})

describe('S4: remote rows only ever get PATCH', () => {
  it('rename and archive use PATCH on that computer; no DELETE is ever sent', async () => {
    roster = [unit(MAC)]
    handler = (u, init) => (init.method === 'PATCH' ? Response.json({ session: sess('r1') }) : Response.json({ sessions: [sess('r1')] }))
    await S.useDeviceSessions.getState().refresh()
    await S.renameRemote(MAC, 'r1', 'New name')
    await S.archiveRemote(MAC, 'r1')
    const writes = calls.filter((c) => c.method !== 'GET')
    expect(writes.map((c) => `${c.method} ${c.url}`)).toEqual([
      `PATCH ${API}/units/${MAC}/proxy/engine/agent/sessions/r1`,
      `PATCH ${API}/units/${MAC}/proxy/engine/agent/sessions/r1`,
    ])
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    expect(S.useDeviceSessions.getState().byUnit[MAC].sessions).toEqual([])
  })
})

describe('gates', () => {
  it('device page: no roster read, no per-device fetch', async () => {
    vi.stubGlobal('window', { tangu: { unitPage: true, mobile: true, cloudWeb: true, unitsList: async () => ({ status: 200, json: { units: [unit(MAC)] } }) } })
    await S.useDeviceSessions.getState().refresh()
    expect(S.useDeviceSessions.getState().units).toBeNull()
    expect(calls).toHaveLength(0)
  })
})
