import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBasicUnit } from '../../unit/host'
import { createRemoteAccount, validateRemoteAccount, RemoteAccountUnavailable } from '../../unit/remoteAccount'

type Reply = { status: number; body?: unknown; delayMs?: number }
const identities: Record<string, Reply> = {
  'tok-alice': { status: 200, body: { userId: 'a1b2c3d4-0000-4000-8000-000000000001', username: 'alice', role: 'USER', tenantId: 'personal:a', workspaceId: 'personal:a', secret: 'DROP_ME' } },
  'tok-bob': { status: 200, body: { userId: 'b1b2c3d4-0000-4000-8000-000000000002', username: 'bob', role: 'USER' } },
  'tok-upper': { status: 200, body: { userId: 'Alice', username: 'Alice', role: 'USER' } },
  'tok-scoped': { status: 200, body: { userId: 'admin-1', username: 'admin', role: 'ADMIN_SCOPED' } },
  'tok-down': { status: 502 },
  'tok-garbled': { status: 200, body: { username: 'no-id' } },
  'tok-slow': { status: 200, delayMs: 400, body: { userId: 'slow-1', username: 'slow', role: 'USER' } },
}

let accountServer: http.Server, accountOrigin = ''
const accountCalls: Array<{ token: string; purpose: string | null }> = []
let engineServer: http.Server, engineUrl = ''
const engineCalls: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = []

const listen = (server: http.Server) => new Promise<string>((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))

beforeAll(async () => {
  accountServer = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x')
    const token = /^Bearer (\S+)$/.exec(String(req.headers.authorization || ''))?.[1] || ''
    accountCalls.push({ token, purpose: url.searchParams.get('purpose') })
    const reply = url.pathname === '/api/auth/unit-identity' ? identities[token] || { status: 401, body: { detail: 'invalid' } } : { status: 404 }
    setTimeout(() => {
      res.writeHead(reply.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(reply.body ?? {}))
    }, reply.delayMs ?? 0)
  })
  accountOrigin = await listen(accountServer)
  engineServer = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      engineCalls.push({ method: req.method || '', url: req.url || '', headers: req.headers, body })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ user: req.headers['x-forsion-user'] ?? null }))
    })
  })
  engineUrl = await listen(engineServer)
})
afterAll(async () => {
  await new Promise((done) => accountServer.close(done))
  await new Promise((done) => engineServer.close(done))
})

describe('remote account authority', () => {
  it('accepts only an origin it can reach safely', () => {
    expect(validateRemoteAccount({ origin: 'https://api.example.com' })).toEqual({ origin: 'https://api.example.com' })
    expect(validateRemoteAccount({ origin: 'http://127.0.0.1:3001', loginVia: 'https://www.example.com/web/' }).loginVia).toBe('https://www.example.com/web/')
    for (const origin of ['http://api.example.com', 'https://api.example.com/api', 'https://u:p@api.example.com', 'https://api.example.com/?x=1', 'ftp://api.example.com', 42]) {
      expect(() => validateRemoteAccount({ origin })).toThrow()
    }
    expect(() => validateRemoteAccount({ origin: 'https://api.example.com', loginVia: 'http://www.example.com/web/' })).toThrow()
  })

  it('maps explicit refusals to signed out, every other failure to unavailable, and caches only verified identities', async () => {
    let clock = 1_000
    const account = createRemoteAccount({ origin: accountOrigin, cacheMs: 30_000, timeoutMs: 200, now: () => clock })
    accountCalls.length = 0
    const alice = await account.resolve('tok-alice')
    expect(alice).toEqual({ userId: 'a1b2c3d4-0000-4000-8000-000000000001', username: 'alice', role: 'USER', tenantId: 'personal:a', workspaceId: 'personal:a' })
    await account.resolve('tok-alice')
    expect(accountCalls).toHaveLength(1)
    // The purpose is part of the question, so it is part of the cache key.
    await account.resolve('tok-alice', { purpose: 'administration' })
    expect(accountCalls.at(-1)).toEqual({ token: 'tok-alice', purpose: 'administration' })
    clock += 30_001
    await account.resolve('tok-alice')
    expect(accountCalls.filter((c) => c.token === 'tok-alice')).toHaveLength(3)

    expect(await account.resolve('tok-nobody')).toBeNull()
    expect(await account.resolve('tok-nobody')).toBeNull()
    expect(accountCalls.filter((c) => c.token === 'tok-nobody')).toHaveLength(2)
    await expect(account.resolve('tok-down')).rejects.toBeInstanceOf(RemoteAccountUnavailable)
    await expect(account.resolve('tok-garbled')).rejects.toBeInstanceOf(RemoteAccountUnavailable)
    await expect(account.resolve('tok-slow')).rejects.toBeInstanceOf(RemoteAccountUnavailable)
    // Not a bearer value at all: refused without asking the server.
    const before = accountCalls.length
    expect(await account.resolve('two words')).toBeNull()
    expect(accountCalls).toHaveLength(before)
    // A caller that goes away stops waiting; the identity returned is a copy.
    const gone = new AbortController()
    const waiting = createRemoteAccount({ origin: accountOrigin, timeoutMs: 2000 }).resolve('tok-slow', { signal: gone.signal })
    gone.abort(new Error('closed'))
    await expect(waiting).rejects.toThrow('closed')
    const copy = (await account.resolve('tok-alice'))!
    copy.userId = 'changed'
    expect((await account.resolve('tok-alice'))!.userId).toBe('a1b2c3d4-0000-4000-8000-000000000001')
  })
})

describe('public Unit with a remote account and a visitor engine', () => {
  async function fixture(options: { visitorEngine?: boolean } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'unit-visitor-engine-'))
    await mkdir(join(root, 'web'), { recursive: true })
    await writeFile(join(root, 'web/index.html'), '<html><head></head><body></body></html>')
    const engine = join(root, 'engine')
    await mkdir(engine)
    await writeFile(join(engine, 'manifest.json'), JSON.stringify({ id: 'visitor-engine', version: '1.0.0', apiVersion: 1, runtime: { apiVersion: 1, main: 'runtime.mjs' } }))
    await writeFile(join(engine, 'runtime.mjs'), `export function createRuntime(context) {
      if (context.multiAccount !== true) throw new Error('expected a multi-account runtime')
      return { engine: { endpoint: () => ({ url: ${JSON.stringify(engineUrl)}, token: 'engine-secret' }), status: () => ({}) }, close: async () => {} }
    }`)
    const handle = await startBasicUnit({ instanceId: 'public-visitors', name: 'Public', version: '3.0.0', dataDir: join(root, 'data'), port: 0,
      basePath: '/web/', plugins: [engine], webDist: join(root, 'web'),
      remoteAccount: { origin: accountOrigin, loginVia: 'https://www.example.com/web/' },
      ...(options.visitorEngine === false ? {} : { visitorEngine: { plugin: 'visitor-engine' } }) })
    return { root, handle, base: `http://127.0.0.1:${handle.port}/web` }
  }

  it('turns each visitor login into the engine account and never forwards what the visitor claims', async () => {
    const { root, handle, base } = await fixture()
    try {
      engineCalls.length = 0
      const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers })
      const alice = await get('/engine/agent/sessions?limit=5', { Authorization: 'Bearer tok-alice', 'X-Forsion-User': 'b1b2c3d4-0000-4000-8000-000000000002', 'X-Forsion-Remote': 'lan' })
      expect(alice.status).toBe(200)
      expect(await alice.json()).toEqual({ user: 'a1b2c3d4-0000-4000-8000-000000000001' })
      const seen = engineCalls.at(-1)!
      expect(seen.url).toBe('/agent/sessions?limit=5')
      expect(seen.headers.authorization).toBe('Bearer engine-secret')
      expect(seen.headers['x-forsion-remote']).toBeUndefined()
      expect(seen.headers['x-forsion-remote-mark']).toBeUndefined()
      expect(JSON.stringify(seen.headers)).not.toContain('tok-alice')

      const bob = await fetch(base + '/engine/agent/sessions', { method: 'POST', headers: { Authorization: 'Bearer tok-bob', 'Content-Type': 'application/json' }, body: '{"title":"x"}' })
      expect(await bob.json()).toEqual({ user: 'b1b2c3d4-0000-4000-8000-000000000002' })
      expect(engineCalls.at(-1)).toMatchObject({ method: 'POST', body: '{"title":"x"}' })

      const calls = engineCalls.length
      expect((await get('/engine/agent/sessions')).status).toBe(401)
      expect((await get('/engine/agent/sessions', { 'X-Forsion-User': 'a1b2c3d4-0000-4000-8000-000000000001' })).status).toBe(401)
      expect((await get('/engine/agent/sessions', { Authorization: 'Bearer tok-nobody' })).status).toBe(401)
      expect((await get('/engine/agent/sessions', { Authorization: 'Bearer tok-upper' })).status).toBe(403)
      expect((await get('/engine/agent/sessions', { Authorization: 'Bearer tok-scoped' })).status).toBe(403)
      expect((await get('/engine/agent/sessions', { Authorization: 'Bearer tok-down' })).status).toBe(503)
      expect((await get('/engine/agent%2fsessions', { Authorization: 'Bearer tok-alice' })).status).toBe(400)
      expect(engineCalls.length).toBe(calls)

      const meta = await get('/unit/meta').then((r) => r.json())
      expect(meta).toMatchObject({ projection: 'public', visitorEngine: true, account: { apiBase: '/api', loginPath: '/auth', loginVia: 'https://www.example.com/web/' } })
      expect(await get('/unit/account', { Authorization: 'Bearer tok-alice' }).then((r) => r.json())).toMatchObject({ userId: 'a1b2c3d4-0000-4000-8000-000000000001' })
      expect((await get('/unit/account', { Authorization: 'Bearer tok-down' })).status).toBe(503)
      // Visitor storage is per identity: one visitor never reads another's preferences.
      await fetch(base + '/unit/config', { method: 'PUT', headers: { Authorization: 'Bearer tok-alice' }, body: JSON.stringify({ theme: 'dark' }) })
      const bobConfig = await get('/unit/config', { Authorization: 'Bearer tok-bob' }).then((r) => r.json())
      expect(JSON.stringify(bobConfig)).not.toContain('dark')
      // The rest of the host surface stays unpublished.
      for (const path of ['/vault/rpc', '/unit/hostfile?path=/etc/passwd', '/unit/pair/poll']) expect((await get(path, { Authorization: 'Bearer tok-alice' })).status).toBe(403)
    } finally { await handle.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('keeps /engine closed on a public Unit without a visitor engine, and refuses the combination on a local Unit', async () => {
    const { root, handle, base } = await fixture({ visitorEngine: false })
    try {
      engineCalls.length = 0
      expect((await fetch(base + '/engine/agent/sessions', { headers: { Authorization: 'Bearer tok-alice' } })).status).toBe(403)
      expect(engineCalls).toHaveLength(0)
      expect((await fetch(base + '/unit/meta').then((r) => r.json())).visitorEngine).toBeUndefined()
    } finally { await handle.close(); await rm(root, { recursive: true, force: true }) }
    const local = await mkdtemp(join(tmpdir(), 'unit-visitor-local-'))
    try {
      await mkdir(join(local, 'web'))
      await writeFile(join(local, 'web/index.html'), '<html></html>')
      await expect(startBasicUnit({ instanceId: 'local-visitors', name: 'Local', version: '3.0.0', dataDir: join(local, 'data'), port: 0, basePath: '/',
        plugins: [], webDist: join(local, 'web'), workspace: { mode: 'local' }, remoteAccount: { origin: accountOrigin } })).rejects.toThrow('require a public Unit')
      await expect(startBasicUnit({ instanceId: 'no-engine', name: 'Public', version: '3.0.0', dataDir: join(local, 'data2'), port: 0, basePath: '/web/',
        plugins: [], webDist: join(local, 'web'), remoteAccount: { origin: accountOrigin }, visitorEngine: { plugin: 'missing' } })).rejects.toThrow('visitorEngine.plugin')
    } finally { await rm(local, { recursive: true, force: true }) }
  })
})
