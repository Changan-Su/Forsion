import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initFirstRun, noteRunEnded, noteSessionsListed } from './firstRun'

const g = globalThis as Record<string, unknown>
const prevWindow = g.window
const prevStorage = g.localStorage
let store: Map<string, string>
let sent: unknown[]
let active = true
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  store = new Map()
  sent = []
  active = true
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } }
  g.window = { tangu: {
    telemetryReport: (kind: string, props: unknown) => sent.push([kind, props]),
    cloudInvoke: async (ch: string) => (ch === 'telemetry:get' ? { active } : null),
  } }
})
afterEach(() => { g.window = prevWindow; g.localStorage = prevStorage })

const T0 = Date.UTC(2026, 10, 20, 9)
const rec = () => JSON.parse(store.get('forsion_first_run') || 'null')

describe('first_run:只给新装的,第一次 run 结束就用掉', () => {
  it('新装:会话列表真读回来是空的才确认;第一次 run 结束、遥测可发才交出,报错原文交给主进程归类', async () => {
    initFirstRun(T0)
    expect(rec()).toMatchObject({ state: 'pending', at: T0 })
    noteSessionsListed([])
    noteRunEnded({ outcome: 'error', error: 'token_quota_exceeded', durationMs: 1234.4 }, T0 + 90_000)
    expect(rec().state).toBe('done')
    await flush()
    expect(sent).toEqual([['firstRun', { outcome: 'error', error: 'token_quota_exceeded', sinceFirstLaunchS: 90, durationMs: 1234 }]])
    noteRunEnded({ outcome: 'done' }, T0 + 100_000) // 第二次 run 不算
    await flush()
    expect(sent).toHaveLength(1)
  })
  it('遥测不可发:不发、也不补(记录照样用掉)', async () => {
    initFirstRun(T0)
    noteSessionsListed([])
    active = false
    noteRunEnded({ outcome: 'done' }, T0 + 1000)
    await flush()
    expect(sent).toEqual([])
    expect(rec().state).toBe('done')
    active = true
    noteRunEnded({ outcome: 'done' }, T0 + 2000)
    await flush()
    expect(sent).toEqual([])
  })
  it('升级上来:成就里发过消息 → skip;首启前就有会话 → skip;首启后才建的会话不算', async () => {
    store.set('forsion_tangu_achievements', JSON.stringify({ v: 1, counters: { 'chat.send': 3 }, claimed: [] }))
    initFirstRun(T0)
    expect(rec().state).toBe('skip')
    store.clear()
    initFirstRun(T0)
    noteSessionsListed([{ created_at: new Date(T0 + 5_000).toISOString() }]) // 首启后建的:还是新装
    expect(rec()).toMatchObject({ state: 'pending', decided: true })
    store.clear()
    initFirstRun(T0)
    noteSessionsListed([{ created_at: '2026-10-01 08:00:00' }])
    expect(rec().state).toBe('skip')
    noteRunEnded({ outcome: 'done' }, T0 + 1000)
    await flush()
    expect(sent).toEqual([])
  })
  it('会话列表一直没读回来:拿不准,第一次 run 结束时标 skip、不发;记录读不出来(坏 JSON)也不重建', async () => {
    initFirstRun(T0)
    noteRunEnded({ outcome: 'aborted' }, T0 + 1000)
    await flush()
    expect(sent).toEqual([])
    expect(rec().state).toBe('skip')
    store.set('forsion_first_run', '{broken')
    initFirstRun(T0)
    expect(store.get('forsion_first_run')).toBe('{broken')
  })
})
