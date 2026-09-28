/**
 * 移动端本地收件箱(P1 · K3 §3.7):pull 保留 thread(原文串)与 expires_at;到期惰性归档(list 与 unreadCount 都过,
 * 否则未读角标一直数着过期的审批提醒)。localStorage 用内存桩;基址 / 凭据接缝换成桩(不打网络)。
 * 负对照(实跑见红,记在 K3 交付报告):pull 不存 thread → 「thread / expires_at 保留」红;unreadCount 不过归档 → 「过期不计未读」红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./engine/targets', () => ({
  cloudApiBase: () => 'https://api.forsion.test/api',
  asTarget: () => ({ headers: async () => ({ Authorization: 'Bearer phone-token' }) }),
}))

import { localInbox } from './localInbox'

const store = new Map<string, string>()
const THREAD = JSON.stringify({ kind: 'approval', unitId: '6c1d7a4e-2b3f-4a5c-8d9e-0f1a2b3c4d5e', sessionId: '9f40ad71-5e6c-4d8f-9021-3c4d5e6f7081', event: 'pending' })
const utc = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function serve(broadcasts: unknown[]): ReturnType<typeof vi.fn> {
  const f = vi.fn(async () => new Response(JSON.stringify({ broadcasts }), { status: 200 }))
  vi.stubGlobal('fetch', f)
  return f
}

describe('localInbox.pull × thread / expires_at', () => {
  it('thread / expires_at 保留;脏 expires_at / 超长 thread 丢掉(只丢字段,不丢信)', async () => {
    const f = serve([
      { id: 'b1', title: '有 Agent 在等你处理', body: 'x', created_at: '2026-09-28 10:00:00.000001', thread: THREAD, expires_at: utc(Date.now() + 24 * 3600_000) },
      { id: 'b2', title: 'plain', body: 'y', created_at: '2026-09-28 10:00:00.000002', expires_at: 'tomorrow', thread: 'x'.repeat(5000) },
    ])
    expect(await localInbox.pull({} as any)).toEqual({ pulled: true, added: 2 })
    expect(f.mock.calls[0][0]).toBe('https://api.forsion.test/api/brain/inbox/broadcasts')
    const rows = await localInbox.list('all')
    const b1 = rows.find((r) => r.origin_broadcast_id === 'b1')!
    expect(b1.thread).toBe(THREAD)
    expect(b1.expires_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    const b2 = rows.find((r) => r.origin_broadcast_id === 'b2')!
    expect(b2.thread).toBeUndefined()
    expect(b2.expires_at).toBeUndefined()
  })

  it('到期惰性归档:list 不再列在「全部」里、进「已归档」;unreadCount 不计它', async () => {
    serve([
      { id: 'old', title: 'expired reminder', body: '', created_at: '2026-09-27 10:00:00.000001', thread: THREAD, expires_at: utc(Date.now() - 60_000) },
      { id: 'new', title: 'fresh', body: '', created_at: '2026-09-28 10:00:00.000001', expires_at: utc(Date.now() + 3600_000) },
    ])
    await localInbox.pull({} as any)
    expect(await localInbox.unreadCount()).toMatchObject({ count: 1 })
    expect((await localInbox.list('all')).map((m) => m.origin_broadcast_id)).toEqual(['new'])
    expect((await localInbox.list('archived')).map((m) => m.origin_broadcast_id)).toEqual(['old'])
    expect((await localInbox.list('unread')).map((m) => m.origin_broadcast_id)).toEqual(['new'])
  })
})
