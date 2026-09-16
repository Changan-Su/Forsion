import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installUnitAccount } from '../../../../web/src/unitAccount'
import { installUnitCloudTransport, type UnitCloudCapabilities } from '../../../../web/src/unitCloudTransport'
import { installUnitShim } from '../../../../web/src/unitShim'
import { contentStorageKey } from '@lcl/engine/contentStorageScope'
import { seedCalendarDb, serializeDb } from '@amadeus-shared/db/schema'

const base = new URL('https://unit.test/web/')
const account = { apiBase: '/api', loginPath: '/auth' }
const capabilities: UnitCloudCapabilities = {
  amadeus: { adapter: 'forsion-cloud-v1', apiBase: '/api', collaboration: true },
  tangu: { adapter: 'forsion-cloud-v1', apiBase: '/api', execution: 'fleet' },
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const storage = () => {
  const data = new Map<string, string>()
  return { data, getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
}
let nativeFetch: ReturnType<typeof vi.fn<typeof fetch>>
let browser: Record<string, any>
let stops: Array<() => void>
let sse: Array<{ url: string; close: ReturnType<typeof vi.fn>; listeners: Map<string, (event: any) => void> }>
let files: Map<string, string>

beforeEach(() => {
  vi.useFakeTimers()
  stops = []; sse = []; files = new Map()
  for (const user of ['a', 'b']) {
    files.set(`${user}:private.md`, `# ${user} private note`)
    const calendar = seedCalendarDb(new Date('2026-09-09T12:00:00Z'))
    calendar.rows.push({ id: `${user}-event`, cells: { title: `${user} event` } })
    files.set(`${user}:Calendar.db`, serializeDb(calendar))
  }
  vi.stubGlobal('localStorage', storage())
  vi.stubGlobal('sessionStorage', storage())
  localStorage.setItem('forsion_token', 'unrelated-web-token')
  vi.stubGlobal('location', { origin: base.origin, href: base.href, assign: vi.fn(), reload: vi.fn() })
  vi.stubGlobal('history', { replaceState: vi.fn() })
  vi.stubGlobal('document', { baseURI: base.href, title: '', addEventListener: vi.fn() })
  nativeFetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    const user = new Headers(init?.headers).get('Authorization')?.replace('Bearer token-', '')
    if (url.pathname === '/web/unit/account') return ['a', 'b'].includes(user || '')
      ? json({ userId: user, username: user, role: 'user', tenantId: `personal:${user}`, workspaceId: `personal:${user}` }) : json({}, 401)
    if (url.pathname === '/web/unit/config') return json({ config: { modelId: 'visitor-model' } })
    if (url.pathname.endsWith('/vaults')) return json({ vaults: [{ id: `${user}-vault` }] })
    if (url.pathname.endsWith('/tree')) return json({ pages: ['private.md'], files: [{ path: 'Calendar.db', size: 100 }], folders: [], seq: 1 })
    if (url.pathname.endsWith('/asset-token')) return json({ token: `${user}-asset`, ttlSec: 600 })
    if (url.pathname.endsWith('/file')) {
      const body = init?.body ? JSON.parse(String(init.body)) : null
      const path = body?.path ?? url.searchParams.get('path')
      if (body) files.set(`${user}:${path}`, body.content)
      return json({ path, content: files.get(`${user}:${path}`), seq: body ? 2 : 1, hash: 'fixture' })
    }
    if (url.pathname === '/api/agent/sessions') return json({ sessions: [{ id: `${user}-session` }] })
    return json({ ok: true })
  })
  vi.stubGlobal('fetch', nativeFetch)
  browser = { addEventListener: vi.fn(), removeEventListener: vi.fn() }
  // Browser window.fetch and the global binding are the same property.
  Object.defineProperty(browser, 'fetch', { get: () => globalThis.fetch, set: (value) => { globalThis.fetch = value }, configurable: true })
  vi.stubGlobal('window', browser)
  vi.stubGlobal('EventSource', class {
    close = vi.fn()
    listeners = new Map<string, (event: any) => void>()
    constructor(public url: string) { sse.push(this) }
    addEventListener(type: string, cb: (event: any) => void) { this.listeners.set(type, cb) }
  })
})
afterEach(() => {
  for (const stop of stops) stop()
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals()
})

async function install(user = 'a', instanceId = 'shared-unit', declared = capabilities) {
  sessionStorage.setItem(`unit:${instanceId}:account`, `token-${user}`)
  const visitor = await installUnitAccount({ instanceId, account }, base)
  const key = contentStorageKey('amadeus_tree_snap')
  const cloud = installUnitCloudTransport({ visitor, capabilities: declared, accountApiBase: '/api', projectionBase: base.href,
    pluginData: { read: vi.fn(async () => null), write: vi.fn(async () => {}) } })
  stops.push(cloud.stop)
  return { visitor, cloud, key }
}

describe('Unit cloud services share the verified visitor transport', () => {
  it('opens notes, edits the Calendar database and lists chat through one tab account, preserving the complete Unit scope', async () => {
    const { cloud, key } = await install()
    expect(contentStorageKey('amadeus_tree_snap')).toBe(key)
    expect(key).toContain('shared-unit')
    await expect(cloud.amadeus!.restoreVault()).resolves.toMatchObject({ root: 'cloud://a-vault', pages: ['private.md'] })
    const note = await cloud.amadeus!.loadPage('private.md')
    expect(JSON.stringify(note)).toContain('a private note')
    const calendar = await cloud.amadeus!.readDatabase('', 'Calendar.db')
    expect(calendar.status).toBe('ok')
    if (calendar.status !== 'ok') throw new Error('Expected Calendar database')
    expect(calendar.data.rows.some((row) => row.id === 'a-event')).toBe(true)
    calendar.data.rows.push({ id: 'new-a-event', cells: { title: 'Only A' } })
    await cloud.amadeus!.writeDatabase('Calendar.db', calendar.data)
    expect(files.get('a:Calendar.db')).toContain('new-a-event')
    expect(files.get('b:Calendar.db')).not.toContain('new-a-event')
    await expect((await fetch(base.origin + '/api/agent/sessions')).json()).resolves.toEqual({ sessions: [{ id: 'a-session' }] })
    expect(nativeFetch.mock.calls.filter(([input]) => String(input).includes('/api/')).every(([, init]) =>
      new Headers(init?.headers).get('Authorization') === 'Bearer token-a')).toBe(true)
    expect(localStorage.getItem('forsion_token')).toBe('unrelated-web-token')
    expect(cloud.config).toMatchObject({ token: 'token-a', mode: 'external', backendUrl: 'https://unit.test/api' })
    expect(sse[0].url).toContain('token=token-a')
    expect(window.amadeusCollab!.publishUrl('published')).toBe(base.href + 'share/published')
    expect(window.amadeusCollab!.inviteUrl('invited')).toBe(base.href + 'invite/invited')
  })

  it('stops streams, presence, asset renewal and rejects cached old-account calls after logout; another user gets a separate cache', async () => {
    const first = await install('a')
    await first.cloud.amadeus!.restoreVault()
    await first.cloud.amadeus!.loadPage('private.md')
    const oldCollab = window.amadeusCollab!
    sse[0].listeners.get('presence')?.({ data: JSON.stringify({ userId: 'a-peer', username: 'A collaborator', page: 'private.md', at: Date.now() }) })
    oldCollab.heartbeat('private.md')
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await first.visitor.account.logout()
    expect(first.cloud.signal.aborted).toBe(true)
    expect(sse[0].close).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    first.cloud.stop()
    const second = await install('b')
    expect(second.key).not.toBe(first.key)
    expect(localStorage.getItem(second.key)).toBeNull()
    await second.cloud.amadeus!.restoreVault()
    const roster = vi.fn()
    const offRoster = window.amadeusCollab!.onPresence(roster)
    expect(roster).toHaveBeenLastCalledWith([])
    offRoster()
    const calls = nativeFetch.mock.calls.length
    expect(() => first.cloud.amadeus!.loadPage('private.md')).toThrow(/account changed/)
    expect(() => oldCollab.heartbeat('private.md')).toThrow(/account changed/)
    await expect(fetch(base.origin + '/api/agent/sessions', { headers: { Authorization: 'Bearer token-a' } })).rejects.toMatchObject({ name: 'AccountChangedError' })
    expect(nativeFetch.mock.calls.length).toBe(calls)
    expect(localStorage.getItem(first.key)).toContain('a-vault')
    expect(localStorage.getItem(second.key)).toContain('b-vault')
  })

  it('clears rejected sessions without flushing old credentials and cancels outstanding streamed response bodies', async () => {
    const { visitor, cloud } = await install()
    const flush = vi.fn(async () => { throw new Error('Do not flush revoked credentials') })
    visitor.onAuthWillChange(flush)
    let controller!: ReadableStreamDefaultController<Uint8Array>
    nativeFetch.mockResolvedValueOnce(new Response(new ReadableStream({ start(value) { controller = value } })))
    const response = await fetch(base.origin + '/api/agent/runs/id/events')
    const pending = expect(response.body!.getReader().read()).rejects.toMatchObject({ name: 'AccountChangedError' })
    nativeFetch.mockResolvedValueOnce(json({}, 401))
    await expect(fetch(base.origin + '/api/agent/sessions')).rejects.toMatchObject({ name: 'AccountChangedError' })
    await pending
    expect(cloud.signal.aborted).toBe(true)
    expect(flush).not.toHaveBeenCalled()
    expect(visitor.account.getToken()).toBe('')
    expect(() => controller.enqueue(new TextEncoder().encode('old secret'))).toThrow()
  })

  it('only exposes configured cloud capabilities and rejects foreign service descriptors before replacing fetch', async () => {
    const { cloud } = await install('a', 'notes-unit', { amadeus: capabilities.amadeus })
    expect(cloud.config.token).toBe('')
    cloud.stop()
    const visitor = await installUnitAccount({ instanceId: 'notes-unit', account }, base)
    const before = window.fetch
    expect(() => installUnitCloudTransport({ visitor, capabilities: { tangu: { adapter: 'forsion-cloud-v1', apiBase: 'https://attacker.test/api', execution: 'fleet' } },
      accountApiBase: '/api', projectionBase: base.href, pluginData: { read: vi.fn(), write: vi.fn() } })).toThrow('Unsupported cloud service endpoint')
    expect(window.fetch).toBe(before)
    const prior = nativeFetch.mock.calls.length
    await fetch('https://cdn.test/public.png')
    expect(nativeFetch.mock.calls[prior][0]).toBe('https://cdn.test/public.png')
    expect(nativeFetch.mock.calls[prior][1]).toBeUndefined()
  })

  it('publishes initialConfig from this visitor and keeps host filesystem and managed backend actions absent', async () => {
    sessionStorage.setItem('unit:full-web:account', 'token-a')
    browser.__FORSION_UNIT_PAGE__ = { instanceId: 'full-web', name: 'Genesis', version: '1', projection: 'public', account, capabilities }
    await expect(installUnitShim()).resolves.toBe(true)
    expect(window.tangu).toMatchObject({ unitPage: true, cloudWeb: true, hostFiles: false,
      initialConfig: { token: 'token-a', modelId: 'visitor-model', mode: 'external', backendUrl: 'https://unit.test/api' } })
    expect(window.tangu!.readHostFile).toBeUndefined()
    expect(window.tangu!.listProviders).toBeUndefined()
    expect(window.tangu!.backendStatus).toBeUndefined()
    expect(window.tangu!.backendRestart).toBeUndefined()
    await window.tangu!.account!.logout()
  })

  it('keeps the same user on separate Unit instances in separate local content scopes', async () => {
    const first = await install('a', 'first-unit')
    await first.cloud.amadeus!.restoreVault()
    first.cloud.stop()
    const second = await install('a', 'second-unit')
    expect(second.key).not.toBe(first.key)
    expect(localStorage.getItem(second.key)).toBeNull()
    expect(localStorage.getItem(first.key)).toContain('a-vault')
  })

  it('sends a cloud guest to the existing tab login before mounting or reading private APIs', async () => {
    browser.__FORSION_UNIT_PAGE__ = { instanceId: 'guest-web', name: 'Genesis', version: '1', projection: 'public', account, capabilities }
    await expect(installUnitShim()).resolves.toBe(false)
    expect(location.assign).toHaveBeenCalledOnce()
    const url = new URL(vi.mocked(location.assign).mock.calls[0][0].toString())
    expect(url.pathname).toBe('/auth')
    expect(url.searchParams.get('session')).toBe('tab')
    expect(window.tangu).toBeUndefined()
    expect(nativeFetch).not.toHaveBeenCalled()
  })
})
