// 整段对话翻页:接口单页硬限 500 且只回最近一页,反馈附件与 /export 都靠 listAllMessages 往前翻。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Row = { id: string; timestamp: number; content: string }
let rows: Row[] = []
let fail: (page: number) => 'error' | 'hang' | null = () => null
const befores: number[] = []
vi.mock('./http', () => ({
  authFetch: async (url: string) => {
    const before = Number(new URL(url).searchParams.get('before')) || 0
    befores.push(before)
    const mode = fail(befores.length - 1)
    if (mode === 'hang') return new Promise<Response>(() => {})
    if (mode === 'error') return new Response('{}', { status: 502 })
    const messages = rows.filter((r) => !before || r.timestamp < before).slice(-500) // 与引擎一致:最近一页,时间正序
    return new Response(JSON.stringify({ messages }), { status: 200 })
  },
}))

const api = await import('./backendService')
const T = await import('./engine/targets')
const make = (n: number, size = 1): Row[] => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, timestamp: 1000 + i, content: 'x'.repeat(size) }))

beforeEach(() => {
  rows = []; fail = () => null; befores.length = 0
  vi.stubGlobal('window', { tangu: {} })
  T.installEngineHost({ cfg: () => ({ backendUrl: 'https://api.forsion.test/api', token: 't', modelId: '' }), desktopConfig: () => ({}) })
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('listAllMessages', () => {
  it('pages backward past the 500-message page and returns the whole conversation in order', async () => {
    rows = make(1203)
    const r = await api.listAllMessages(T.homeTarget(), 's1')
    expect(r.complete).toBe(true)
    expect(r.messages.map((m) => m.id)).toEqual(rows.map((m) => m.id))
    expect(befores).toEqual([0, 1703, 1203])
  })
  it('a conversation of exactly one full page is complete', async () => {
    rows = make(500)
    expect(await api.listAllMessages(T.homeTarget(), 's1')).toMatchObject({ complete: true, messages: { length: 500 } })
  })
  it('keeps the pages it has when a later page fails; a first-page failure still throws', async () => {
    rows = make(1203)
    fail = (page) => (page === 1 ? 'error' : null)
    const r = await api.listAllMessages(T.homeTarget(), 's1')
    expect(r).toMatchObject({ complete: false, messages: { length: 500 } })
    expect(r.messages.at(-1)!.id).toBe('m1202')
    fail = () => 'error'
    await expect(api.listAllMessages(T.homeTarget(), 's1')).rejects.toThrow()
  })
  it('stops paging once the size budget is spent', async () => {
    rows = make(1203, 100)
    const r = await api.listAllMessages(T.homeTarget(), 's1', { maxChars: 100_000 }) // 一页约 72k 字符:第二页翻完才超
    expect(r).toMatchObject({ complete: false, messages: { length: 1000 } })
    expect(befores).toHaveLength(2)
  })
  it('a stalled later page ends at the time budget with the newest page kept', async () => {
    vi.useFakeTimers()
    rows = make(1203)
    fail = (page) => (page === 1 ? 'hang' : null)
    const pending = api.listAllMessages(T.homeTarget(), 's1', { timeoutMs: 7000 })
    await vi.advanceTimersByTimeAsync(7100)
    expect(await pending).toMatchObject({ complete: false, messages: { length: 500 } })
  })
})
