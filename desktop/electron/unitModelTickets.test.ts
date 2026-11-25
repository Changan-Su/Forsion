/**
 * Hosted public Unit: per-visitor model tickets (unit/modelTickets.ts + host.ts + unitWeb.ts proxyVisitorEngine).
 *
 *   - after the visitor's identity is verified, the Unit asks the account server for that visitor's ticket with its device
 *     credential and forwards it to the engine as X-Forsion-Model-Ticket; a ticket the browser sends never passes
 *   - reused while more than 30 minutes are left, renewed below that; one ticket per visitor
 *   - the ticket never comes back to the browser; a failed request forwards without a ticket and backs off
 *   - no credential = no tickets and no script isolation; an unreadable one = no tickets, isolation still on
 *   - the engine gets the server origin and the isolation switch, never the device secret or a token
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBasicUnit } from '../../unit/host'
import { createLocalEngine } from '../../unit/localEngine'
import { createModelTickets, ticketExpiry } from '../../unit/modelTickets'

const ALICE = 'a1b2c3d4-0000-4000-8000-000000000001'
const BOB = 'b1b2c3d4-0000-4000-8000-000000000002'
const CAROL = 'c1b2c3d4-0000-4000-8000-000000000003'
const identities: Record<string, { status: number; body?: unknown }> = {
  'tok-alice': { status: 200, body: { userId: ALICE, username: 'alice', role: 'USER' } },
  'tok-alice-2': { status: 200, body: { userId: ALICE, username: 'alice', role: 'USER' } },
  'tok-bob': { status: 200, body: { userId: BOB, username: 'bob', role: 'USER' } },
  'tok-carol': { status: 200, body: { userId: CAROL, username: 'carol', role: 'USER' } },
  'tok-scoped': { status: 200, body: { userId: 'admin-1', username: 'admin', role: 'ADMIN_SCOPED' } },
  'tok-down': { status: 502 },
}
const UNIT_ID = 'unit-hosted-1'
const DEVICE_SECRET = 'DEVICE-SECRET-must-never-leave-the-unit-process-0123456789'

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.${Buffer.from('sig-' + Math.random()).toString('base64url')}`

/** Mint behaviour per visitor: ttl seconds, or a failing status. */
const mintPlan: Record<string, { ttlSec?: number; status?: number }> = {}
const mintCalls: Array<{ user: string; unitId: string; secretOk: boolean }> = []
const minted: string[] = []
let accountServer: http.Server, accountOrigin = ''
let engineServer: http.Server, engineUrl = ''
const engineCalls: Array<{ url: string; headers: http.IncomingHttpHeaders }> = []
const listen = (server: http.Server) => new Promise<string>((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))

beforeAll(async () => {
  accountServer = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x')
    const token = /^Bearer (\S+)$/.exec(String(req.headers.authorization || ''))?.[1] || ''
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (url.pathname === '/api/auth/unit-identity') { const r = identities[token] || { status: 401, body: {} }; send(r.status, r.body ?? {}); return }
    if (url.pathname === '/api/units/model-ticket' && req.method === 'POST') {
      const who = identities[token]?.status === 200 ? (identities[token].body as any).userId as string : ''
      const secretOk = req.headers['x-unit-id'] === UNIT_ID && req.headers['x-unit-secret'] === DEVICE_SECRET
      mintCalls.push({ user: who, unitId: String(req.headers['x-unit-id'] || ''), secretOk })
      if (!secretOk || !who) { send(401, { detail: 'invalid' }); return }
      const plan = mintPlan[who] || {}
      if (plan.status) { send(plan.status, { detail: 'nope' }); return }
      const exp = Math.floor(Date.now() / 1000) + (plan.ttlSec ?? 3600)
      const ticket = jwt({ scope: 'model-ticket', aud: 'forsion:model-ticket', userId: who, unit: UNIT_ID, jti: Math.random().toString(36).slice(2), exp })
      minted.push(ticket)
      send(200, { ticket, expiresAt: new Date(exp * 1000).toISOString() })
      return
    }
    send(404, {})
  })
  accountOrigin = await listen(accountServer)
  engineServer = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      engineCalls.push({ url: req.url || '', headers: req.headers })
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
beforeEach(() => { engineCalls.length = 0; mintCalls.length = 0; minted.length = 0; for (const k of Object.keys(mintPlan)) delete mintPlan[k] })

/** good / garbage = the file is there (valid / not); missing = declared but not written yet; none = not declared. */
async function fixture(credential: 'good' | 'garbage' | 'missing' | 'none') {
  const root = await mkdtemp(join(tmpdir(), 'unit-model-tickets-'))
  await mkdir(join(root, 'web'), { recursive: true })
  await writeFile(join(root, 'web/index.html'), '<html><head></head><body></body></html>')
  const engine = join(root, 'engine')
  await mkdir(engine)
  await writeFile(join(engine, 'manifest.json'), JSON.stringify({ id: 'visitor-engine', version: '1.0.0', apiVersion: 1, runtime: { apiVersion: 1, main: 'runtime.mjs' } }))
  // Records everything the Unit hands the engine runtime (the only way anything reaches the engine process).
  await writeFile(join(engine, 'runtime.mjs'), `import { writeFileSync } from 'node:fs'
    export function createRuntime(context) {
      writeFileSync(context.dataDir + '/context.json', JSON.stringify(context))
      return { engine: { endpoint: () => ({ url: ${JSON.stringify(engineUrl)}, token: 'engine-secret', multiAccount: true }), status: () => ({}) }, close: async () => {} }
    }`)
  const data = join(root, 'data')
  const credentialFile = join(data, 'cloud', 'device.json')
  await mkdir(join(data, 'cloud'), { recursive: true })
  if (credential === 'good' || credential === 'garbage') {
    await writeFile(credentialFile, credential === 'good' ? JSON.stringify({ unitId: UNIT_ID, unitSecret: DEVICE_SECRET, gen: 1 }) : '{"unitId": "unit-hosted-1", "unitSecret": ')
  }
  const handle = await startBasicUnit({ instanceId: 'hosted-public', name: 'Public', version: '3.0.0', dataDir: data, port: 0,
    basePath: '/web/', plugins: [engine], webDist: join(root, 'web'),
    remoteAccount: { origin: accountOrigin }, visitorEngine: { plugin: 'visitor-engine', ...(credential === 'none' ? {} : { deviceCredential: 'cloud/device.json' }) } })
  const context = JSON.parse(await readFile(join(data, 'plugins', 'visitor-engine', 'context.json'), 'utf8'))
  return { root, handle, context, credentialFile, base: `http://127.0.0.1:${handle.port}/web` }
}

const get = (base: string, path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers })
const lastEngineTicket = () => engineCalls.at(-1)?.headers['x-forsion-model-ticket']
const claimsOf = (t: unknown) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8'))

describe('hosted public Unit: model tickets', () => {
  it('mints after identity, forwards only to the engine, reuses one ticket per visitor, and drops what the browser sends', async () => {
    const { root, handle, context, base } = await fixture('good')
    try {
      // the engine runtime gets the server origin and script isolation, never the credential
      expect(context.cloudUrl).toBe(accountOrigin)
      expect(context.scriptIsolation).toBe('required')
      expect(JSON.stringify(context)).not.toContain(DEVICE_SECRET)

      const forged = jwt({ scope: 'model-ticket', userId: ALICE, exp: Math.floor(Date.now() / 1000) + 7200 })
      const r1 = await get(base, '/engine/agent/sessions', { Authorization: 'Bearer tok-alice', 'X-Forsion-Model-Ticket': forged })
      expect(r1.status).toBe(200)
      const body1 = await r1.text()
      expect(mintCalls).toEqual([{ user: ALICE, unitId: UNIT_ID, secretOk: true }])
      const aliceTicket = lastEngineTicket()
      expect(aliceTicket).toBe(minted[0])
      expect(aliceTicket).not.toBe(forged)
      expect(claimsOf(aliceTicket).userId).toBe(ALICE)
      expect(engineCalls.at(-1)!.headers['x-forsion-user']).toBe(ALICE)
      // never back to the browser, never the device secret toward the engine
      expect(body1 + JSON.stringify([...r1.headers])).not.toContain(aliceTicket as string)
      expect(JSON.stringify(engineCalls)).not.toContain(DEVICE_SECRET)

      // reused while plenty of time is left
      await get(base, '/engine/agent/sessions', { Authorization: 'Bearer tok-alice' })
      expect(mintCalls).toHaveLength(1)
      expect(lastEngineTicket()).toBe(aliceTicket)

      // another visitor gets their own
      await get(base, '/engine/agent/sessions', { Authorization: 'Bearer tok-bob' })
      expect(mintCalls.map((c) => c.user)).toEqual([ALICE, BOB])
      expect(claimsOf(lastEngineTicket()).userId).toBe(BOB)

      // a new sign-in of the same visitor gets a fresh ticket (a sign-out elsewhere may have voided the old one)
      await get(base, '/engine/agent/sessions', { Authorization: 'Bearer tok-alice-2' })
      expect(mintCalls.map((c) => c.user)).toEqual([ALICE, BOB, ALICE])
      expect(lastEngineTicket()).not.toBe(aliceTicket)

      // no identity → no ticket request at all
      const calls = engineCalls.length
      expect((await get(base, '/engine/agent/sessions')).status).toBe(401)
      expect((await get(base, '/engine/agent/sessions', { Authorization: 'Bearer tok-nobody', 'X-Forsion-Model-Ticket': forged })).status).toBe(401)
      expect((await get(base, '/engine/agent/sessions', { Authorization: 'Bearer tok-scoped' })).status).toBe(403)
      expect((await get(base, '/engine/agent/sessions', { Authorization: 'Bearer tok-down' })).status).toBe(503)
      expect(engineCalls.length).toBe(calls)
      expect(mintCalls).toHaveLength(3)
    } finally { await handle.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('renews a ticket with under 30 minutes left, sending the current one meanwhile', async () => {
    const { root, handle, base } = await fixture('good')
    try {
      mintPlan[ALICE] = { ttlSec: 20 * 60 }
      await get(base, '/engine/agent/sessions', { Authorization: 'Bearer tok-alice' })
      const first = lastEngineTicket()
      expect(mintCalls).toHaveLength(1)
      mintPlan[ALICE] = { ttlSec: 3600 }
      await get(base, '/engine/agent/sessions', { Authorization: 'Bearer tok-alice' })
      expect(lastEngineTicket()).toBe(first) // still valid: sent while the renewal runs
      await expect.poll(() => mintCalls.length).toBe(2)
      await expect.poll(async () => { await get(base, '/engine/agent/sessions', { Authorization: 'Bearer tok-alice' }); return lastEngineTicket() }).not.toBe(first)
      expect(claimsOf(lastEngineTicket()).exp).toBeGreaterThan(claimsOf(first).exp)
      expect(mintCalls).toHaveLength(2) // the renewed one has plenty of time: no third request
    } finally { await handle.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('a refused ticket request forwards without a ticket, keeps identity behaviour, and backs off', async () => {
    const { root, handle, base } = await fixture('good')
    try {
      mintPlan[CAROL] = { status: 503 }
      const r = await get(base, '/engine/agent/sessions', { Authorization: 'Bearer tok-carol', 'X-Forsion-Model-Ticket': jwt({ scope: 'model-ticket', userId: CAROL, exp: 9e9 }) })
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ user: CAROL })
      expect(lastEngineTicket()).toBeUndefined()
      await get(base, '/engine/agent/sessions', { Authorization: 'Bearer tok-carol' })
      expect(lastEngineTicket()).toBeUndefined()
      expect(mintCalls).toHaveLength(1) // backing off: the second request did not ask again
    } finally { await handle.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('a declared credential written after start is picked up by the next request; isolation was on from the start', async () => {
    const { root, handle, context, credentialFile, base } = await fixture('missing')
    try {
      expect(context.scriptIsolation).toBe('required')
      await get(base, '/engine/agent/sessions', { Authorization: 'Bearer tok-alice' })
      expect(lastEngineTicket()).toBeUndefined()
      expect(mintCalls).toHaveLength(0)
      await writeFile(credentialFile, JSON.stringify({ unitId: UNIT_ID, unitSecret: DEVICE_SECRET, gen: 0 }))
      await get(base, '/engine/agent/sessions', { Authorization: 'Bearer tok-bob' })
      expect(claimsOf(lastEngineTicket()).userId).toBe(BOB)
      expect(mintCalls).toEqual([{ user: BOB, unitId: UNIT_ID, secretOk: true }])
    } finally { await handle.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('refuses a credential path outside the data directory, or one without an account server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unit-model-tickets-bad-'))
    try {
      await mkdir(join(root, 'web'), { recursive: true })
      await writeFile(join(root, 'web/index.html'), '<html><head></head><body></body></html>')
      const base = { instanceId: 'bad', name: 'Bad', version: '3.0.0', dataDir: join(root, 'data'), port: 0, basePath: '/web/', plugins: [], webDist: join(root, 'web') }
      for (const deviceCredential of ['../outside.json', '/etc/passwd', 'cloud/../../x.json', 'cloud//x.json'])
        await expect(startBasicUnit({ ...base, remoteAccount: { origin: accountOrigin }, visitorEngine: { plugin: 'missing', deviceCredential } })).rejects.toThrow('deviceCredential')
      await expect(startBasicUnit({ ...base, visitorEngine: { plugin: 'missing', deviceCredential: 'cloud/device.json' } })).rejects.toThrow('requires remoteAccount')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('no credential declared: no tickets and no script isolation; an unreadable one: no tickets, isolation still on', async () => {
    for (const kind of ['none', 'garbage'] as const) {
      const { root, handle, context, base } = await fixture(kind)
      try {
        expect(context.cloudUrl).toBe(accountOrigin)
        expect(context.scriptIsolation).toBe(kind === 'none' ? undefined : 'required')
        const r = await get(base, '/engine/agent/sessions', { Authorization: 'Bearer tok-alice', 'X-Forsion-Model-Ticket': jwt({ scope: 'model-ticket', userId: ALICE, exp: 9e9 }) })
        expect(r.status).toBe(200)
        expect(lastEngineTicket()).toBeUndefined()
        expect(mintCalls).toHaveLength(0)
      } finally { await handle.close(); await rm(root, { recursive: true, force: true }) }
    }
  })
})

describe('model ticket client', () => {
  it('reads expiry from the ticket itself and refuses a ticket issued for someone else', () => {
    const exp = Math.floor(Date.now() / 1000) + 600
    expect(ticketExpiry(jwt({ userId: ALICE, exp }), ALICE)).toBe(exp * 1000)
    expect(ticketExpiry(jwt({ userId: BOB, exp }), ALICE)).toBeNull()
    expect(ticketExpiry('not a ticket', ALICE)).toBeNull()
    expect(ticketExpiry(jwt({ userId: ALICE }), ALICE, '2030-01-01T00:00:00Z')).toBe(Date.parse('2030-01-01T00:00:00Z'))
  })

  it('a credential that turns unreadable keeps the last good one; a rotated one is used without a restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unit-model-tickets-file-'))
    try {
      const file = join(root, 'hosted-device.json')
      const seen: string[] = []
      const fake: typeof fetch = async (_url, init) => {
        seen.push(String((init?.headers as Record<string, string>)['X-Unit-Secret']))
        return new Response(JSON.stringify({ ticket: jwt({ scope: 'model-ticket', userId: ALICE, exp: Math.floor(Date.now() / 1000) + 600 }) }), { status: 200 })
      }
      await writeFile(file, JSON.stringify({ unitId: UNIT_ID, unitSecret: 'secret-gen-1', gen: 1 }))
      const logs: string[] = []
      const tickets = createModelTickets({ origin: accountOrigin, credentialFile: file, initial: { state: 'ok', credential: { unitId: UNIT_ID, unitSecret: 'secret-gen-1' } }, fetch: fake, log: (m) => logs.push(m) })
      // 10-minute tickets: every request renews (under 30 minutes left), so each one re-reads the file
      expect(await tickets.ticketFor(ALICE, 'tok-a')).toBeTruthy()
      await writeFile(file, '{ broken')
      expect(await tickets.ticketFor(ALICE, 'tok-b')).toBeTruthy()
      await writeFile(file, JSON.stringify({ unitId: UNIT_ID, unitSecret: 'secret-gen-2', gen: 2 }))
      expect(await tickets.ticketFor(ALICE, 'tok-c')).toBeTruthy()
      expect(seen).toEqual(['secret-gen-1', 'secret-gen-1', 'secret-gen-2'])
      expect(logs.join('\n')).toContain('unreadable')
      expect(logs.join('\n')).not.toMatch(/secret-gen/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('a 401 right after a rotation re-reads the file and tries once more; an unchanged file does not retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unit-model-tickets-rotate-'))
    try {
      const file = join(root, 'device.json')
      const seen: string[] = []
      let rotateOnFirst = true
      const fake: typeof fetch = async (_url, init) => {
        const secret = String((init?.headers as Record<string, string>)['X-Unit-Secret'])
        seen.push(secret)
        if (secret !== 'secret-gen-2') {
          // the host replaces the file while this request is on its way
          if (rotateOnFirst) await writeFile(file, JSON.stringify({ unitId: UNIT_ID, unitSecret: 'secret-gen-2', gen: 2 }))
          return new Response('{"detail":"invalid"}', { status: 401 })
        }
        return new Response(JSON.stringify({ ticket: jwt({ scope: 'model-ticket', userId: ALICE, exp: Math.floor(Date.now() / 1000) + 3600 }) }), { status: 200 })
      }
      await writeFile(file, JSON.stringify({ unitId: UNIT_ID, unitSecret: 'secret-gen-1', gen: 1 }))
      const tickets = createModelTickets({ origin: accountOrigin, credentialFile: file, fetch: fake, log: () => {} })
      expect(claimsOf(await tickets.ticketFor(ALICE, 'tok-a')).userId).toBe(ALICE)
      expect(seen).toEqual(['secret-gen-1', 'secret-gen-2'])

      seen.length = 0
      rotateOnFirst = false
      await writeFile(file, JSON.stringify({ unitId: UNIT_ID, unitSecret: 'secret-revoked', gen: 3 }))
      expect(await tickets.ticketFor(BOB, 'tok-b')).toBeNull()
      expect(seen).toEqual(['secret-revoked'])

      // missing for a while (e.g. right after a restore): not configured for that request, not a lasting state
      seen.length = 0
      await rm(file)
      expect(await tickets.ticketFor(CAROL, 'tok-c')).toBeNull()
      expect(seen).toEqual([])
      await writeFile(file, JSON.stringify({ unitId: UNIT_ID, unitSecret: 'secret-gen-2', gen: 2 }))
      expect(await tickets.ticketFor(ALICE, 'tok-a2')).toBeTruthy()
      expect(seen).toEqual(['secret-gen-2'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

describe('visitor engine environment', () => {
  it('passes the server origin and script isolation, never an inherited token or the device secret', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unit-engine-env-'))
    const saved = { token: process.env.TANGU_TOKEN }
    process.env.TANGU_TOKEN = 'inherited-token-must-not-reach-the-engine'
    try {
      const entry = join(root, 'engine-stub.mjs')
      await writeFile(entry, `import { writeFileSync } from 'node:fs'
        writeFileSync(${JSON.stringify(join(root, 'env.json'))}, JSON.stringify(process.env))
        process.send({ type: 'tangu:ready', host: '127.0.0.1', port: 1, mode: 'multi-account' })
        setInterval(() => {}, 1000)`)
      const engine = createLocalEngine({ dataDir: join(root, 'data'), entryFile: entry, multiAccount: true, cloudUrl: 'https://api.example.com', scriptIsolation: 'required' })
      await engine.start([])
      try {
        const env = JSON.parse(await readFile(join(root, 'env.json'), 'utf8'))
        expect(env.TANGU_CLOUD_URL).toBe('https://api.example.com')
        expect(env.TANGU_SCRIPT_ISOLATION).toBe('required')
        expect(env.TANGU_MULTI_ACCOUNT).toBe('1')
        expect(env.TANGU_TOKEN).toBeUndefined()
        expect(Object.keys(env).filter((k) => k.startsWith('TANGU_')).sort()).toEqual(['TANGU_BUNDLE_DIRS', 'TANGU_CLOUD_URL', 'TANGU_HOME', 'TANGU_HOST', 'TANGU_LOCAL_TOKEN', 'TANGU_MULTI_ACCOUNT', 'TANGU_PORT', 'TANGU_SCRIPT_ISOLATION'])
        expect(JSON.stringify(env)).not.toContain(DEVICE_SECRET)
      } finally { await engine.stop() }

      // without the options: neither variable
      const plain = createLocalEngine({ dataDir: join(root, 'data2'), entryFile: entry, multiAccount: true })
      await plain.start([])
      try {
        const env = JSON.parse(await readFile(join(root, 'env.json'), 'utf8'))
        expect(env.TANGU_CLOUD_URL).toBeUndefined()
        expect(env.TANGU_SCRIPT_ISOLATION).toBeUndefined()
      } finally { await plain.stop() }
    } finally {
      if (saved.token === undefined) delete process.env.TANGU_TOKEN; else process.env.TANGU_TOKEN = saved.token
      await rm(root, { recursive: true, force: true })
    }
  })
})
