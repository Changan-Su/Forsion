// P1-K7a「在哪运行」草稿位置(规格 K7 §3.6;缺省 K7 U3:记住上次亲手选的,且只在那台 ready 时生效;S9 亲手选的永远赢)。
// 真 K6 targets(焦点 / setFocusTarget)+ 真设备 store;appStore / sessionNav / lcl 引擎换成替身。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { UnitInfo } from '../types'

const fakeApp = create(() => ({ activeId: null as string | null, sessions: [], archivedSessions: [], configBySession: {}, cfg: { backendUrl: '', token: '' }, setActiveId: () => {}, toast: () => {}, tr: (k: string) => k }))
vi.mock('./appStore', () => ({ useApp: fakeApp }))
vi.mock('../sessionNav', () => ({ openSession: () => {} }))
vi.mock('@lcl/engine', () => ({ setActiveSpace: () => {}, useSpaceStore: { getState: () => ({ activeSpaceId: 'tangu' }) } }))

const T = await import('../services/engine/targets')
const D = await import('./deviceSessionsStore')
const M = await import('../services/deviceMarks')
const R = await import('./runLocationStore')

const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url')
const JWT = `h.${b64({ userId: 'u-7' })}.s`
const API = 'https://api.test/api'
const MAC = '11111111-2222-4333-8444-555555555555'
const MAC_REF = { kind: 'unit' as const, unitId: MAC }
const unit = (o: Partial<UnitInfo> = {}): UnitInfo => ({ id: MAC, name: 'MacBook', platform: 'darwin', icon: null, online: true, kind: 'desktop', caps: { engine: 'ready' }, capsLive: true, ...o })
const store = new Map<string, string>()
const refocused: string[] = []
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** 某个会话开着 → 回到空白新对话(= 新的一份草稿)。 */
async function newDraft(): Promise<void> {
  fakeApp.setState({ activeId: 's-open' })
  fakeApp.setState({ activeId: null })
  await flush()
}
/** 一轮设备刷新完成(名册 + 探针已知)。 */
async function refreshed(u: UnitInfo | null, probeOk = true): Promise<void> {
  if (u && probeOk) M.noteDeviceProbe(u.id, { ok: true })
  D.useDeviceSessions.setState({ units: u ? [u] : [], refreshedAt: Date.now() + Math.random() / 1000 })
  await flush()
}

beforeEach(() => {
  store.clear()
  refocused.length = 0
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
  vi.stubGlobal('window', { tangu: { mobile: true, cloudWeb: true, unitsList: async () => ({ status: 200, json: { units: [] } }) } })
  fakeApp.setState({ activeId: null, cfg: { backendUrl: API, token: JWT } })
  T.installEngineHost({
    cfg: () => fakeApp.getState().cfg as never,
    desktopConfig: () => ({ cloudApiBase: API } as never),
    // 宿主半身:换焦点 = 回到空白新对话(同 appStore.refocusEngine)
    refocus: async (next) => { refocused.push(next.kind === 'unit' ? next.unitId : 'home'); fakeApp.setState({ activeId: null }) },
  })
  T.resetFocusForTests()
  // 刷新由测试手动驱动(refreshed());草稿边界触发的真刷新在这里是空操作
  D.useDeviceSessions.setState({ units: null, byUnit: {}, refreshedAt: 0, refresh: async () => {} })
  M.resetDeviceMarks()
  R.useRunLocation.setState({ draftSeq: 0, explicitSeq: null, reconciledSeq: null, explicitPending: false })
  R.resetRunLocationForTests()
})
afterEach(() => { vi.unstubAllGlobals() })

describe('draftLocation / setDraftLocation', () => {
  it('draft = focus; an explicit pick is remembered per account', async () => {
    await R.setDraftLocation(MAC_REF, { explicit: true, name: 'MacBook' })
    expect(R.draftLocation()).toEqual(MAC_REF)
    expect(R.rememberedRunLocation()).toEqual(MAC_REF)
    expect([...store.keys()].some((k) => k.startsWith('forsion_run_location:'))).toBe(true)
  })
})

describe('U3: the remembered pick applies to a new draft only when that computer is ready', () => {
  it('ready → the new draft starts on it', async () => {
    await R.setDraftLocation(MAC_REF, { explicit: true })
    await T.setFocusTarget({ kind: 'home' })
    await newDraft()
    await refreshed(unit())
    expect(T.focusRef()).toEqual(MAC_REF)
  })

  it('offline (or engine stopped) → the new draft starts on home; the memory stays', async () => {
    await R.setDraftLocation(MAC_REF, { explicit: true })
    await newDraft()
    await refreshed(unit({ online: false }))
    expect(T.focusRef()).toEqual({ kind: 'home' })
    expect(R.rememberedRunLocation()).toEqual(MAC_REF)
    // 过了一阵(状态已不新鲜),下一份草稿时先刷新 —— 它回来了 → 回到它
    D.useDeviceSessions.setState({ refreshedAt: Date.now() - 60_000 })
    await newDraft()
    expect(T.focusRef()).toEqual({ kind: 'home' }) // 旧状态不拿来对账,等这一轮刷新
    await refreshed(unit())
    expect(T.focusRef()).toEqual(MAC_REF)
  })

  it('status still checking → waits for the next refresh instead of guessing', async () => {
    await R.setDraftLocation(MAC_REF, { explicit: true })
    await T.setFocusTarget({ kind: 'home' })
    await newDraft()
    await refreshed(unit(), false) // 名册到了、探针还没回来
    expect(T.focusRef()).toEqual({ kind: 'home' })
    await refreshed(unit())
    expect(T.focusRef()).toEqual(MAC_REF)
  })

  it('at most one automatic switch per draft (refocus resets the draft\'s project / model picks)', async () => {
    await R.setDraftLocation(MAC_REF, { explicit: true })
    await newDraft()
    await refreshed(unit({ online: false }))
    expect(T.focusRef()).toEqual({ kind: 'home' })
    const n = refocused.length
    await refreshed(unit()) // 同一份草稿里它上线了:不再自动切
    expect(T.focusRef()).toEqual({ kind: 'home' })
    expect(refocused.length).toBe(n)
  })

  it('migrates the K8-era persisted focus as the remembered pick', async () => {
    T.useEngineFocus.setState({ ref: MAC_REF, name: 'MacBook' })
    expect(R.rememberedRunLocation()).toBeNull()
    await newDraft()
    await refreshed(unit())
    expect(R.rememberedRunLocation()).toEqual(MAC_REF)
    expect(T.focusRef()).toEqual(MAC_REF)
  })
})

describe('does not fight focus changes it did not make', () => {
  it('a direct setFocusTarget (e.g. device removed → home, or another caller) counts as chosen for that draft', async () => {
    await R.setDraftLocation(MAC_REF, { explicit: true })
    await refreshed(unit())
    fakeApp.setState({ activeId: 's-open' })
    await T.setFocusTarget({ kind: 'home' }) // 有会话开着:refocus 回到空白 = 新一代草稿,且这一代是「别人切的」
    await refreshed(unit())
    expect(T.focusRef()).toEqual({ kind: 'home' })
  })
})

describe('S9: an explicit pick always wins for its draft', () => {
  it('picking home in this draft is not undone by a later refresh', async () => {
    await R.setDraftLocation(MAC_REF, { explicit: true })
    await newDraft()
    await R.setDraftLocation({ kind: 'home' }, { explicit: true })
    await refreshed(unit())
    expect(T.focusRef()).toEqual({ kind: 'home' })
  })

  it('picking a computer while a session is open: the draft boundary during the switch does not bounce it back (stale not-ready status)', async () => {
    M.noteDeviceProbe(MAC, { ok: false, status: 0 }) // 旧探针:暂时连不上
    D.useDeviceSessions.setState({ units: [unit()], refreshedAt: Date.now() }) // 状态「新鲜」:草稿边界会立刻对账
    fakeApp.setState({ activeId: 's-open' })
    await R.setDraftLocation(MAC_REF, { explicit: true }) // refocus 把 activeId 清空 = 新草稿,正在切换中
    await flush()
    expect(T.focusRef()).toEqual(MAC_REF)
    expect(refocused).toEqual([MAC])
  })
})
