import { afterEach, describe, expect, it, vi } from 'vitest'
import { provideInboxChannel, type InboxChannel } from './inboxChannel'
import { listInbox, getInboxUnreadCount, patchInboxMessage, claimInboxAttachment } from './backendService'

const h = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('./http', () => ({ authFetch: h.fetch }))
const target = { key: 'home', base: 'http://engine.test', headers: async () => ({ Authorization: 'Bearer fixture' }) } as any
const message = (id: string, cloud = false): any => ({ id, title: id, body: '', sender_kind: cloud ? 'server' : 'agent', sender_id: 'test',
  origin_broadcast_id: cloud ? id : null, created_at: '2026-11-12 10:00:00', read_at: null, archived_at: null })
const channel = (): InboxChannel => ({ list: vi.fn(async () => [message('cloud:official', true)]),
  unreadCount: vi.fn(async () => ({ count: 1, latestId: 'cloud:official', revision: 'r1', latestCreatedAt: '2026-11-11 10:00:00' })),
  patch: vi.fn(async () => ({})), readAll: vi.fn(async () => ({})), remove: vi.fn(async () => ({})),
  claim: vi.fn(async () => ({ ok: true, alreadyClaimed: false })), importLegacy: vi.fn(async () => ({})) })
afterEach(() => { provideInboxChannel('test', null); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('official/native inbox transport', () => {
  it('Web uses the Extend channel without requesting engine inbox endpoints', async () => {
    vi.stubGlobal('window', { tangu: { cloudWeb: true, unitPage: true, unitPublicEntry: true } })
    const cloud = channel(); provideInboxChannel('test', cloud)
    expect((await listInbox(target)).map((m) => m.id)).toEqual(['cloud:official'])
    await patchInboxMessage(target, 'cloud:official', { read: true })
    await claimInboxAttachment(target, 'cloud:official', 'web/test')
    expect(cloud.patch).toHaveBeenCalledWith('cloud:official', { read: true })
    expect(cloud.claim).toHaveBeenCalledWith('cloud:official', 'web/test')
    expect(h.fetch).not.toHaveBeenCalled()
  })
  it('desktop merges native letters, removes duplicate broadcasts and counts beyond the first engine page', async () => {
    vi.stubGlobal('window', { tangu: { backendStatus: async () => ({}) } })
    const cloud = channel(); provideInboxChannel('test', cloud)
    const legacy = Array.from({ length: 200 }, (_, i) => ({ ...message(`old-${i}`, true), read_at: '2026-11-01 00:00:00' }))
    h.fetch.mockImplementation(async (url: string) => new Response(JSON.stringify({ messages: url.includes('offset=200') ? [message('native')] : legacy })))
    expect((await listInbox(target)).map((m) => m.id)).toEqual(['native', 'cloud:official'])
    expect(cloud.importLegacy).toHaveBeenCalledTimes(1)
    const unread = await getInboxUnreadCount(target)
    expect(unread).toMatchObject({ count: 2, latestId: 'native' })
    expect(cloud.importLegacy).toHaveBeenCalledTimes(1)
    h.fetch.mockRejectedValue(new Error('engine offline'))
    expect((await listInbox(target)).map((m) => m.id)).toEqual(['native', 'cloud:official'])
  })
})
