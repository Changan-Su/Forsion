import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ posts: [] as any[], saved: [] as any[], fail: false }))
vi.mock('./engine/targets', () => ({ homeTarget: () => ({ key: 'home' }) }))
vi.mock('./backendService', () => ({
  saveAgentDef: async (_t: unknown, def: any) => { h.saved.push(def); return { slug: def.slug || 'deepseek' } },
  importSessions: async (_t: unknown, body: any) => {
    if (h.fail) throw new Error('HTTP 500')
    h.posts.push(body)
    return body.conversations.map((c: any) => ({ external_id: c.external_id, status: 'created', session_id: `s-${c.external_id}` }))
  },
}))

import { batchConversations, createAgentForPlugin, importSessionsForPlugin } from './pluginAgentImport'

const deps = () => ({ waitBackend: async () => ({}), activeModelId: () => 'model-a', refreshAgents: vi.fn(), refreshSessions: vi.fn() })
const conv = (id: string, chars = 10) => ({ id, title: id, messages: [{ role: 'user' as const, content: 'x'.repeat(chars) }] })

beforeEach(() => { h.posts = []; h.saved = []; h.fail = false })

describe('importSessionsForPlugin', () => {
  it('sends chat-shaped sessions under the agent, with the active model, and refreshes the list once', async () => {
    const d = deps()
    const progress: number[][] = []
    const r = await importSessionsForPlugin({ agent: 'deepseek', source: 'deepseek', conversations: [{ ...conv('a'), createdAt: 1_760_000_000_000, messages: [{ role: 'assistant', content: 'hi', reasoning: 'r', model: 'deepseek-chat', timestamp: 1_760_000_000_000 }] }], onProgress: (a, b) => progress.push([a, b]) }, () => true, d)
    expect(r).toEqual({ ok: true, results: [{ id: 'a', status: 'created', sessionId: 's-a' }] })
    expect(h.posts[0]).toEqual({
      source: 'deepseek',
      agent_config: { preset: 'chat', execMode: 'sandbox', agentSlug: 'deepseek' },
      model_id: 'model-a',
      conversations: [{ external_id: 'a', title: 'a', created_at: 1_760_000_000_000, messages: [{ role: 'assistant', content: 'hi', reasoning: 'r', timestamp: 1_760_000_000_000, model_id: 'deepseek-chat' }] }],
    })
    expect(progress).toEqual([[1, 1]])
    expect(d.refreshSessions).toHaveBeenCalledTimes(1)
  })

  it('stops between batches once the plugin is disabled', async () => {
    let alive = true
    const list = Array.from({ length: 90 }, (_, i) => conv(`c${i}`))
    const r = await importSessionsForPlugin({ agent: 'deepseek', source: 'deepseek', conversations: list, onProgress: () => { alive = false } }, () => alive, deps())
    expect(r.ok).toBe(false)
    expect(h.posts).toHaveLength(1)
    expect(r.results).toHaveLength(40)
  })

  it('refuses bad agent ids and sources before touching the engine', async () => {
    expect((await importSessionsForPlugin({ agent: 'Deep Seek', source: 'deepseek', conversations: [] }, () => true, deps())).ok).toBe(false)
    expect((await importSessionsForPlugin({ agent: 'deepseek', source: 'DeepSeek', conversations: [] }, () => true, deps())).ok).toBe(false)
    expect(h.posts).toHaveLength(0)
  })

  it('keeps results of earlier batches when a later one fails', async () => {
    const d = deps()
    const list = Array.from({ length: 41 }, (_, i) => conv(`c${i}`))
    let n = 0
    const r = await importSessionsForPlugin({ agent: 'deepseek', source: 'deepseek', conversations: list, onProgress: () => { if (++n === 1) h.fail = true } }, () => true, d)
    expect(r).toMatchObject({ ok: false, error: 'HTTP 500' })
    expect(r.results).toHaveLength(40)
    expect(d.refreshSessions).toHaveBeenCalledTimes(1)
  })
})

describe('batchConversations', () => {
  it('splits by count and by characters; one oversized chat goes alone', () => {
    expect(batchConversations(Array.from({ length: 81 }, (_, i) => conv(`c${i}`))).map((b) => b.length)).toEqual([40, 40, 1])
    expect(batchConversations([conv('a', 1_000_000), conv('b', 1_000_000), conv('c', 2_000_000)]).map((b) => b.map((c) => c.id))).toEqual([['a'], ['b'], ['c']])
  })
})

describe('createAgentForPlugin', () => {
  it('creates the agent and refreshes the roster', async () => {
    const d = deps()
    const r = await createAgentForPlugin({ name: 'DeepSeek', systemPrompt: 'You continue chats.', soul: 'Calm.' }, () => true, d)
    expect(r).toEqual({ ok: true, slug: 'deepseek' })
    expect(h.saved[0]).toEqual({ name: 'DeepSeek', systemPrompt: 'You continue chats.', soul: 'Calm.' })
    expect(d.refreshAgents).toHaveBeenCalled()
  })
  it('needs a name and a system prompt', async () => {
    expect((await createAgentForPlugin({ name: '', systemPrompt: 'x' }, () => true, deps())).ok).toBe(false)
    expect((await createAgentForPlugin({ name: 'x', systemPrompt: ' ' }, () => true, deps())).ok).toBe(false)
  })
})
