// ctx.tangu.connectChannel: a plugin's UI connects a channel from its own bundle. Whose channel it is comes from the
// engine's plugin discovery and is checked here in the host; nothing the plugin passes can widen it.
// Negative control (run, went red): dropping the owner comparison in ownedChannelPatch fails 5 tests, every "refuses" case that depends on ownership.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TanguDesktopConfig } from '../../types'

const calls: Array<{ route: string; method: string; body?: unknown }> = []
const channels = { list: [] as unknown[] }
vi.mock('../../services/backendService', () => ({
  request: vi.fn(async (_target: unknown, route: string, init?: RequestInit) => {
    calls.push({ route, method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    if (route === '/agent/channels') return { available: true, channels: channels.list }
    if (route.endsWith('/connect')) return { ok: true, accountId: 'acc', label: 'Org', sessionId: 's1' }
    return { ok: true }
  }),
  listPlugins: vi.fn(async () => []),
}))

const { usePluginStore } = await import('./pluginStore')
const { setTanguProbe } = await import('./tanguSeam')
const { ownedChannelPatch } = await import('./engineRequest')
type Ctx = import('./types').PluginContext

const CFG: TanguDesktopConfig = { backendUrl: 'http://t', token: 'tok', modelId: '' }
const channel = (kind: string, owner: { engine: string; bundle: string | null } | null, keys = ['appId', 'appSecret']) => ({
  kind, plugin: { fields: keys.map((key) => ({ key })), owner },
})

function ctxOf(id: string, bundle: { dir?: string; enginePlugins: string[] }): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c: Ctx) => { ref = c }, bundle: { agents: [], skills: [], spaces: [], ...bundle } } as never])
  return ref!
}

beforeEach(() => {
  calls.length = 0
  channels.list = [channel('org', { engine: 'org-engine', bundle: 'acme-chat' }), channel('wecom', { engine: 'wecom', bundle: 'wecom-plugin' }), { kind: 'telegram' }]
  setTanguProbe({
    activeModel: () => null, models: () => [], activeSpace: () => null, subscribe: () => () => {},
    waitBackend: async () => CFG, hostExecution: () => true,
  } as never)
})
afterEach(() => { setTanguProbe(null); delete (globalThis as { window?: unknown }).window })

describe('ctx.tangu.connectChannel', () => {
  const own = { dir: 'acme-chat', enginePlugins: ['org-engine'] }

  it('saves the credentials, then connects, for a channel in its own bundle', async () => {
    const result = await ctxOf('acme', own).tangu!.connectChannel!('org', { appId: 'unit-1', appSecret: 'secret' })
    expect(result).toEqual({ ok: true, accountId: 'acc', label: 'Org', sessionId: 's1' })
    expect(calls.map((c) => [c.method, c.route])).toEqual([
      ['GET', '/agent/channels'], ['PUT', '/agent/channels/org/config'], ['POST', '/agent/channels/org/connect'],
    ])
    expect(calls[1].body).toEqual({ appId: 'unit-1', appSecret: 'secret' })
  })

  it('matches the install folder name case-insensitively, as engine routes do', async () => {
    const result = await ctxOf('acme', { dir: 'Acme-Chat', enginePlugins: ['org-engine'] }).tangu!.connectChannel!('org', { appId: 'x' })
    expect(result.ok).toBe(true)
  })

  it("refuses another plugin's channel and writes nothing", async () => {
    const result = await ctxOf('acme', own).tangu!.connectChannel!('wecom', { appId: 'x' })
    expect(result).toEqual({ ok: false, error: 'This channel does not belong to this plugin' })
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('refuses built-in channels', async () => {
    expect((await ctxOf('acme', own).tangu!.connectChannel!('telegram', { appId: 'x' })).ok).toBe(false)
  })

  it('refuses when only the engine id matches: a bundle cannot claim a same-named engine plugin elsewhere', async () => {
    const claimed = await ctxOf('acme', { dir: 'acme-chat', enginePlugins: ['wecom'] }).tangu!.connectChannel!('wecom', { appId: 'x' })
    expect(claimed.ok).toBe(false)
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('refuses when only the folder matches', async () => {
    const result = await ctxOf('acme', { dir: 'acme-chat', enginePlugins: [] }).tangu!.connectChannel!('org', { appId: 'x' })
    expect(result.ok).toBe(false)
  })

  it('refuses a channel with no recorded owner, as an older engine reports', async () => {
    channels.list = [channel('org', null)]
    expect((await ctxOf('acme', own).tangu!.connectChannel!('org', { appId: 'x' })).ok).toBe(false)
  })

  it('refuses keys the channel did not declare, so it cannot reach other settings', async () => {
    const result = await ctxOf('acme', own).tangu!.connectChannel!('org', { approvalMode: 'full-auto' } as never)
    expect(result).toEqual({ ok: false, error: 'Invalid channel field: approvalMode' })
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('refuses a kind that would not be a route segment', async () => {
    const result = await ctxOf('acme', own).tangu!.connectChannel!('../plugins', { appId: 'x' })
    expect(result).toEqual({ ok: false, error: 'Invalid channel kind' })
    expect(calls).toEqual([])
  })

  it('needs a local engine', async () => {
    setTanguProbe({ activeModel: () => null, models: () => [], activeSpace: () => null, subscribe: () => () => {}, waitBackend: async () => CFG, hostExecution: () => false } as never)
    const result = await ctxOf('acme', own).tangu!.connectChannel!('org', { appId: 'x' })
    expect(result).toEqual({ ok: false, error: 'A local engine is required' })
  })

  it('is absent on phones and on hosts without a local engine', () => {
    ;(globalThis as { window?: unknown }).window = { tangu: { mobile: true } }
    expect(ctxOf('acme', own).tangu!.connectChannel).toBeUndefined()
    ;(globalThis as { window?: unknown }).window = { tangu: { executionCapabilities: { host: false } } }
    expect(ctxOf('acme', own).tangu!.connectChannel).toBeUndefined()
  })
})

describe('ownedChannelPatch', () => {
  it('rejects non-string values and non-object fields', () => {
    const ch = channel('org', { engine: 'e', bundle: 'b' })
    expect(() => ownedChannelPatch(ch as never, { appId: 1 }, 'b', ['e'])).toThrow(/Invalid channel field/)
    expect(() => ownedChannelPatch(ch as never, null, 'b', ['e'])).toThrow(/Invalid channel fields/)
    expect(() => ownedChannelPatch(ch as never, [], 'b', ['e'])).toThrow(/Invalid channel fields/)
  })

  it('refuses a standalone engine plugin, which has no bundle', () => {
    expect(() => ownedChannelPatch(channel('org', { engine: 'e', bundle: null }) as never, {}, 'b', ['e'])).toThrow(/does not belong/)
  })
})
