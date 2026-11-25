/**
 * Hosted public Unit: per-account backups of the visitor engine (unit/visitorBackups.ts + host.ts + unitWeb.ts).
 *
 *   - a visitor whose account is not on the engine is restored before the request goes on; admitted as new only when the
 *     backup service says there never was a backup; when the service cannot answer, or the engine archived the account and
 *     the service has nothing, the visitor gets 503 and no empty account is created
 *   - one restore per account even when several requests arrive together
 *   - touched accounts are backed up when quiet: snapshot → signed upload (exact bytes, Content-MD5, Content-Length) → commit;
 *     an unchanged account is not uploaded again; a failed upload is not committed and keeps the previous restore point
 *   - accounts nobody used for coldAfterDays are archived only after the service confirms the latest restore point; not
 *     when the state file cannot be read
 *   - the engine's host-only routes are never reachable through the visitors' door; the device secret never reaches the engine
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBasicUnit } from '../../unit/host'
import { createVisitorBackups, backupSettings } from '../../unit/visitorBackups'

const ALICE = 'a1b2c3d4-0000-4000-8000-000000000001'
const BOB = 'b1b2c3d4-0000-4000-8000-000000000002'
const identities: Record<string, string> = { 'tok-alice': ALICE, 'tok-bob': BOB }
const UNIT_ID = 'unit-hosted-backups'
const DEVICE_SECRET = 'DEVICE-SECRET-backups-never-leave-the-unit-0123456789'
const CONTROL = 'engine-control-token-0123456789'
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const md5 = (b: Buffer) => createHash('md5').update(b).digest('base64')
const listen = (server: http.Server) => new Promise<string>((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))
const readBody = (req: http.IncomingMessage) => new Promise<Buffer>((done) => { const c: Buffer[] = []; req.on('data', (d) => c.push(d)); req.on('end', () => done(Buffer.concat(c))) })

// ── fake backup service + object storage ─────────────────────────────────────────────
const svc = {
  down: false,
  restorePoints: new Map<string, { backupId: string; body: Buffer }>(), // user → latest
  pending: new Map<string, { user: string; size: number; md5: string; sha256: string; key: string }>(),
  objects: new Map<string, Buffer>(),
  calls: [] as string[],
  putFails: false,
  cold: [] as Array<{ user: string; backupId: string }>,
  latestOverride: null as null | string,
}
let accountServer: http.Server, origin = ''
// ── fake engine (visitor side + host control) ───────────────────────────────────────
const eng = {
  accounts: new Map<string, 'active' | 'cold'>(), // absent = not in the map
  coldBackup: new Map<string, string>(),
  data: new Map<string, Buffer>(), // what a snapshot of the account is
  fingerprint: new Map<string, string>(),
  snapshots: new Map<string, Buffer>(),
  restoreDelayMs: 0,
  calls: [] as string[],
  visitorCalls: [] as Array<{ url: string; user: string | undefined; auth: string | undefined }>,
  restored: new Map<string, Buffer>(),
}
let engineServer: http.Server, engineUrl = ''

beforeAll(async () => {
  accountServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x')
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    const body = await readBody(req)
    const json = body.length && !url.pathname.startsWith('/storage/') ? JSON.parse(body.toString('utf8')) : {}
    const token = /^Bearer (\S+)$/.exec(String(req.headers.authorization || ''))?.[1] || ''
    if (url.pathname === '/api/auth/unit-identity') return identities[token] ? send(200, { userId: identities[token], username: 'v', role: 'USER' }) : send(401, {})
    if (url.pathname.startsWith('/storage/')) {
      const key = url.pathname.slice('/storage/'.length)
      if (req.method === 'PUT') {
        const p = [...svc.pending.values()].find((x) => x.key === key)
        if (svc.putFails || !p) return send(500, {})
        if (req.headers['content-md5'] !== md5(body) || Number(req.headers['content-length']) !== body.length || req.headers['transfer-encoding']) return send(400, { detail: 'BadDigest' })
        svc.objects.set(key, body)
        res.writeHead(200); res.end(); return
      }
      const o = svc.objects.get(key)
      if (!o) return send(404, {})
      res.writeHead(200, { 'Content-Length': String(o.length) }); res.end(o); return
    }
    svc.calls.push(`${req.method} ${url.pathname}`)
    if (svc.down) return send(502, {})
    if (req.headers['x-unit-id'] !== UNIT_ID || req.headers['x-unit-secret'] !== DEVICE_SECRET) return send(401, { code: 'UNIT_CREDENTIAL_INVALID' })
    if (url.pathname === '/api/units/backups' && req.method === 'POST') {
      const id = `bk-${svc.pending.size + svc.restorePoints.size + Math.random().toString(36).slice(2, 8)}`
      const key = `${UNIT_ID}/${json.userId}/${id}.tgz`
      svc.pending.set(id, { user: json.userId, size: json.size, md5: json.md5, sha256: json.sha256, key })
      return send(200, { backupId: id, upload: { method: 'PUT', url: `${origin}/storage/${key}`, headers: { 'Content-Type': 'application/octet-stream', 'Content-MD5': json.md5 } }, expiresAt: 0 })
    }
    const commit = /^\/api\/units\/backups\/([^/]+)\/commit$/.exec(url.pathname)
    if (commit) {
      const p = svc.pending.get(commit[1])
      const o = p && svc.objects.get(p.key)
      if (!p || p.user !== json.userId || !o || o.length !== p.size) return send(404, { code: 'BACKUP_NOT_FOUND' })
      svc.pending.delete(commit[1])
      svc.restorePoints.set(p.user, { backupId: commit[1], body: o })
      return send(200, { backupId: commit[1], readyAt: new Date().toISOString() })
    }
    if (url.pathname === '/api/units/backups/restore') {
      const who = identities[token]
      if (!who) return send(401, { code: 'VISITOR_AUTH_INVALID' })
      const rp = svc.restorePoints.get(who)
      if (!rp) return send(404, { code: 'BACKUP_NONE' })
      const key = `${UNIT_ID}/${who}/${rp.backupId}.tgz`
      svc.objects.set(key, rp.body)
      return send(200, { backupId: rp.backupId, size: rp.body.length, md5: md5(rp.body), sha256: sha(rp.body), download: { url: `${origin}/storage/${key}` } })
    }
    if (url.pathname === '/api/units/backups/latest') {
      const rp = svc.restorePoints.get(String(url.searchParams.get('userId')))
      if (!rp) return send(404, { code: 'BACKUP_NONE' })
      return send(200, { backupId: svc.latestOverride ?? rp.backupId, size: rp.body.length, sha256: sha(rp.body) })
    }
    if (url.pathname === '/api/units/backups/cold') { svc.cold.push({ user: json.userId, backupId: json.backupId }); return send(200, { coldSince: '', retainUntil: '' }) }
    send(404, {})
  })
  origin = await listen(accountServer)

  engineServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x')
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (!url.pathname.startsWith('/_host/')) {
      await readBody(req)
      eng.visitorCalls.push({ url: url.pathname, user: req.headers['x-forsion-user'] as string | undefined, auth: req.headers.authorization })
      return send(200, { ok: true })
    }
    if (req.headers.authorization !== `Bearer ${CONTROL}`) return send(401, {})
    const p = url.pathname.slice('/_host'.length)
    eng.calls.push(`${req.method} ${p.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, (m) => (m === ALICE ? 'ALICE' : m === BOB ? 'BOB' : m)).replace(/snap-\w+/, 'SNAP')}`)
    let m: RegExpExecArray | null
    if ((m = /^\/accounts\/([^/]+)$/.exec(p))) {
      const st = eng.accounts.get(m[1])
      return send(200, st === 'cold' ? { state: 'cold', cold: { backupId: eng.coldBackup.get(m[1]) ?? null } } : { state: st ?? 'absent' })
    }
    if ((m = /^\/accounts\/([^/]+)\/admit$/.exec(p))) {
      if (eng.accounts.get(m[1]) === 'cold') return send(409, { code: 'ACCOUNT_COLD' })
      eng.accounts.set(m[1], 'active'); return send(200, { state: 'active', created: true })
    }
    if ((m = /^\/accounts\/([^/]+)\/restore$/.exec(p))) {
      const body = await readBody(req)
      if (eng.restoreDelayMs) await new Promise((r) => setTimeout(r, eng.restoreDelayMs))
      if (sha(body) !== url.searchParams.get('sha256') || body.length !== Number(url.searchParams.get('size'))) return send(422, { code: 'BACKUP_INVALID' })
      eng.restored.set(m[1], body); eng.accounts.set(m[1], 'active'); eng.data.set(m[1], body); eng.fingerprint.set(m[1], sha(body))
      return send(200, { state: 'active', sessions: 0, fingerprint: sha(body) })
    }
    if ((m = /^\/accounts\/([^/]+)\/snapshot$/.exec(p))) {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      const data = eng.data.get(m[1]) ?? Buffer.from(`account ${m[1]}`)
      const fp = eng.fingerprint.get(m[1]) ?? sha(data)
      if (eng.accounts.get(m[1]) !== 'active') return send(404, { code: 'ACCOUNT_ABSENT' })
      if (body.since === fp) return send(200, { unchanged: true, fingerprint: fp })
      const sid = `snap-${Math.random().toString(36).slice(2, 8)}`
      eng.snapshots.set(sid, data)
      return send(200, { snapshotId: sid, size: data.length, md5: md5(data), sha256: sha(data), fingerprint: fp, sessions: 0 })
    }
    if ((m = /^\/snapshots\/([^/]+)$/.exec(p))) {
      const s = eng.snapshots.get(m[1])
      if (req.method === 'DELETE') { eng.snapshots.delete(m[1]); return send(200, { ok: true }) }
      if (!s) return send(404, {})
      res.writeHead(200, { 'Content-Length': String(s.length) }); res.end(s); return
    }
    if ((m = /^\/accounts\/([^/]+)\/purge$/.exec(p))) {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      if (body.fingerprint !== (eng.fingerprint.get(m[1]) ?? sha(eng.data.get(m[1]) ?? Buffer.from(`account ${m[1]}`)))) return send(409, { code: 'ACCOUNT_CHANGED' })
      eng.accounts.set(m[1], 'cold'); eng.coldBackup.set(m[1], body.backupId); return send(200, { state: 'cold' })
    }
    if (p === '/accounts') return send(200, { accounts: [...eng.accounts].map(([id, state]) => ({ id, state })) })
    send(404, {})
  })
  engineUrl = await listen(engineServer)
})
afterAll(async () => {
  await new Promise((done) => accountServer.close(done))
  await new Promise((done) => engineServer.close(done))
})
beforeEach(() => {
  svc.down = false; svc.restorePoints.clear(); svc.pending.clear(); svc.objects.clear(); svc.calls.length = 0; svc.putFails = false; svc.cold.length = 0; svc.latestOverride = null
  eng.accounts.clear(); eng.coldBackup.clear(); eng.data.clear(); eng.fingerprint.clear(); eng.snapshots.clear(); eng.calls.length = 0; eng.visitorCalls.length = 0; eng.restored.clear(); eng.restoreDelayMs = 0
})

async function unitFixture(opts: { control?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'unit-visitor-backups-'))
  await mkdir(join(root, 'web'), { recursive: true })
  await writeFile(join(root, 'web/index.html'), '<html><head></head><body></body></html>')
  const engine = join(root, 'engine')
  await mkdir(engine)
  await writeFile(join(engine, 'manifest.json'), JSON.stringify({ id: 'visitor-engine', version: '1.0.0', apiVersion: 1, runtime: { apiVersion: 1, main: 'runtime.mjs' } }))
  await writeFile(join(engine, 'runtime.mjs'), `import { writeFileSync } from 'node:fs'
    export function createRuntime(context) {
      writeFileSync(context.dataDir + '/context.json', JSON.stringify(context))
      return { engine: { endpoint: () => ({ url: ${JSON.stringify(engineUrl)}, token: 'engine-visitor-token', multiAccount: true }),
        ${opts.control === false ? '' : `control: () => ({ url: ${JSON.stringify(engineUrl)}, token: ${JSON.stringify(CONTROL)} }),`} status: () => ({}) }, close: async () => {} }
    }`)
  const data = join(root, 'data')
  await mkdir(join(data, 'cloud'), { recursive: true })
  await writeFile(join(data, 'cloud', 'device.json'), JSON.stringify({ unitId: UNIT_ID, unitSecret: DEVICE_SECRET, gen: 0 }))
  const logs: string[] = []
  const log = console.log
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); }
  const errLog = console.error
  console.error = (...a: unknown[]) => { logs.push(a.join(' ')); }
  try {
    const handle = await startBasicUnit({ instanceId: 'hosted-public-b', name: 'Public', version: '3.0.0', dataDir: data, port: 0,
      basePath: '/web/', plugins: [engine], webDist: join(root, 'web'),
      remoteAccount: { origin }, visitorEngine: { plugin: 'visitor-engine', deviceCredential: 'cloud/device.json', backup: {} } })
    return { handle, data, logs, base: `http://127.0.0.1:${handle.port}/web` }
  } finally { console.log = log; console.error = errLog }
}
const visit = (base: string, path: string, token = 'tok-alice') => fetch(base + path, { headers: { Authorization: `Bearer ${token}` } })

describe('hosted public Unit: account backups through the visitor door', () => {
  it('admits a visitor who never had a backup, restores one who has, and never reaches the host-only routes', async () => {
    const { handle, data, logs } = await unitFixture()
    const base = `http://127.0.0.1:${handle.port}/web`
    try {
      expect(logs.join('\n')).toContain('Hosted unit account backups are on')
      const context = JSON.parse(await readFile(join(data, 'plugins', 'visitor-engine', 'context.json'), 'utf8'))
      expect(context.hostControl).toBe(true)
      expect(JSON.stringify(context)).not.toContain(DEVICE_SECRET)
      // new visitor: the service has nothing → admitted, then the request goes through
      const r1 = await visit(base, '/engine/agent/sessions')
      expect(r1.status).toBe(200)
      expect(eng.calls).toEqual([`GET /accounts/ALICE`, `POST /accounts/ALICE/admit`])
      expect(eng.visitorCalls.at(-1)!.user).toBe(ALICE)
      // once known, no more host calls per request
      await visit(base, '/engine/agent/sessions')
      expect(eng.calls.length).toBe(2)
      // a returning visitor whose copy was archived: restored with the exact bytes before the request goes on
      const archived = Buffer.from('bob archived account bytes')
      svc.restorePoints.set(BOB, { backupId: 'bk-bob-1', body: archived })
      eng.accounts.set(BOB, 'cold'); eng.coldBackup.set(BOB, 'bk-bob-1')
      const r2 = await visit(base, '/engine/agent/sessions', 'tok-bob')
      expect(r2.status).toBe(200)
      expect(eng.restored.get(BOB)?.equals(archived)).toBe(true)
      expect(eng.calls).not.toContain('POST /accounts/BOB/admit')
      // the visitors' door never opens /_host (any case), and the engine never sees the host credential on it
      for (const path of ['/engine/_host/accounts', '/engine/_HOST/accounts/x/purge', '/engine/_host']) {
        expect((await visit(base, path)).status, path).toBe(404)
      }
      expect(eng.visitorCalls.some((c) => c.url.toLowerCase().startsWith('/_host'))).toBe(false)
      expect(JSON.stringify(eng.visitorCalls)).not.toContain(CONTROL)
    } finally { await handle.close() }
  })

  it('never creates an empty account when the service cannot answer or has nothing for an archived account', async () => {
    const { handle } = await unitFixture()
    const base = `http://127.0.0.1:${handle.port}/web`
    try {
      svc.down = true
      const down = await visit(base, '/engine/agent/sessions')
      expect(down.status).toBe(503)
      expect((await down.json()).code).toBe('ACCOUNT_RESTORE_UNAVAILABLE')
      expect(eng.calls).not.toContain('POST /accounts/ALICE/admit')
      expect(eng.visitorCalls).toEqual([])
      // archived here but the service has nothing: still 503, still no admit
      svc.down = false
      eng.accounts.set(BOB, 'cold'); eng.coldBackup.set(BOB, 'bk-gone')
      const lost = await visit(base, '/engine/agent/sessions', 'tok-bob')
      expect(lost.status).toBe(503)
      expect(eng.calls).not.toContain('POST /accounts/BOB/admit')
      expect(eng.accounts.get(BOB)).toBe('cold')
      // the service is back: the next request admits the new visitor
      expect((await visit(base, '/engine/agent/sessions')).status).toBe(200)
      expect(eng.calls).toContain('POST /accounts/ALICE/admit')
    } finally { await handle.close() }
  })

  it('restores once when several requests of one account arrive together', async () => {
    const { handle } = await unitFixture()
    const base = `http://127.0.0.1:${handle.port}/web`
    try {
      svc.restorePoints.set(ALICE, { backupId: 'bk-a', body: Buffer.from('alice bytes') })
      eng.accounts.set(ALICE, 'cold'); eng.coldBackup.set(ALICE, 'bk-a')
      eng.restoreDelayMs = 150
      const all = await Promise.all([1, 2, 3, 4].map(() => visit(base, '/engine/agent/sessions')))
      expect(all.map((r) => r.status)).toEqual([200, 200, 200, 200])
      expect(eng.calls.filter((c) => c === 'POST /accounts/ALICE/restore').length).toBe(1)
    } finally { await handle.close() }
  })

  it('refuses to start backups with an engine runtime that has no host-only side', async () => {
    const { handle, logs } = await unitFixture({ control: false })
    try {
      expect(logs.join('\n')).toMatch(/failed to activate/)
      const r = await visit(`http://127.0.0.1:${handle.port}/web`, '/engine/agent/sessions')
      expect(r.status).not.toBe(200)
      expect(eng.visitorCalls).toEqual([])
    } finally { await handle.close() }
  })

  it('validates its settings', () => {
    expect(backupSettings({})).toEqual({ intervalMinutes: 15, idleMinutes: 2, coldAfterDays: 90 })
    expect(() => backupSettings({ coldAfterDays: 0 })).toThrow()
    expect(() => backupSettings({ everyHour: true })).toThrow()
    expect(() => backupSettings([])).toThrow()
  })
})

describe('hosted public Unit: backup schedule and archiving', () => {
  async function orchestrator(opts: { state?: string } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'unit-backup-schedule-'))
    await mkdir(join(root, 'cloud'), { recursive: true })
    await writeFile(join(root, 'cloud', 'device.json'), JSON.stringify({ unitId: UNIT_ID, unitSecret: DEVICE_SECRET }))
    const stateFile = join(root, 'visitor-backups.json')
    if (opts.state !== undefined) await writeFile(stateFile, opts.state)
    let clock = Date.parse('2026-11-25T00:00:00Z')
    const logs: string[] = []
    const b = await createVisitorBackups({
      origin, credentialFile: join(root, 'cloud', 'device.json'), stateFile, settings: { intervalMinutes: 15, idleMinutes: 2, coldAfterDays: 90 },
      engine: () => ({ url: engineUrl, token: CONTROL }), now: () => clock, log: (m) => logs.push(m), tickMs: 3_600_000,
    })
    return { b, stateFile, logs, advance: (ms: number) => { clock += ms }, state: async () => JSON.parse(await readFile(stateFile, 'utf8')) }
  }

  it('backs a quiet account up with the exact bytes, skips it while unchanged, and keeps the last restore point when an upload fails', async () => {
    eng.accounts.set(ALICE, 'active')
    eng.data.set(ALICE, Buffer.from('alice v1'))
    const o = await orchestrator()
    try {
      expect(await o.b.prepare(ALICE, 'tok-alice')).toBeNull()
      await o.b.tick()
      expect(svc.restorePoints.size).toBe(0) // not quiet yet
      o.advance(3 * 60_000)
      await o.b.tick()
      expect(svc.restorePoints.get(ALICE)?.body.toString()).toBe('alice v1')
      expect(eng.snapshots.size).toBe(0) // the engine's copy is dropped after the upload
      const first = svc.restorePoints.get(ALICE)!.backupId
      // used again, nothing changed on the engine → no new upload
      await o.b.prepare(ALICE, 'tok-alice')
      o.advance(3 * 60_000)
      await o.b.tick()
      expect(svc.restorePoints.get(ALICE)!.backupId).toBe(first)
      expect(svc.calls.filter((c) => c === 'POST /api/units/backups').length).toBe(1)
      // changed, but the upload fails: nothing committed, the previous restore point stays, retried later
      eng.data.set(ALICE, Buffer.from('alice v2'))
      svc.putFails = true
      await o.b.prepare(ALICE, 'tok-alice')
      o.advance(3 * 60_000)
      await o.b.tick()
      expect(svc.restorePoints.get(ALICE)!.backupId).toBe(first)
      expect(eng.snapshots.size).toBe(0)
      svc.putFails = false
      o.advance(3 * 60_000)
      await o.b.tick()
      expect(svc.restorePoints.get(ALICE)!.body.toString()).toBe('alice v2')
    } finally { await o.b.close() }
  })

  it('archives an account nobody used for 90 days only after the service confirms its latest restore point', async () => {
    eng.accounts.set(ALICE, 'active')
    eng.data.set(ALICE, Buffer.from('alice before going quiet'))
    const o = await orchestrator()
    try {
      await o.b.prepare(ALICE, 'tok-alice')
      o.advance(3 * 60_000)
      await o.b.tick()
      const latest = svc.restorePoints.get(ALICE)!.backupId
      // 91 days later, but the service reports another latest: not archived
      svc.latestOverride = 'bk-someone-else'
      o.advance(91 * 24 * 3600_000)
      await o.b.tick()
      expect(eng.accounts.get(ALICE)).toBe('active')
      // confirmed → archived, and the service is told
      svc.latestOverride = null
      o.advance(61 * 60_000)
      await o.b.tick()
      expect(eng.accounts.get(ALICE)).toBe('cold')
      expect(eng.coldBackup.get(ALICE)).toBe(latest)
      expect(svc.cold).toEqual([{ user: ALICE, backupId: latest }])
      expect((await o.state()).accounts[ALICE].cold.backupId).toBe(latest)
      // coming back restores that very backup
      expect(await o.b.prepare(ALICE, 'tok-alice')).toBeNull()
      expect(eng.accounts.get(ALICE)).toBe('active')
      expect(eng.restored.get(ALICE)?.toString()).toBe('alice before going quiet')
    } finally { await o.b.close() }
  })

  it('archives nobody while the state file cannot be read, and does not overwrite it', async () => {
    eng.accounts.set(ALICE, 'active')
    const o = await orchestrator({ state: '{"version": 1, "accounts": ' })
    try {
      expect(o.logs.join('\n')).toMatch(/state file is unreadable/)
      o.advance(400 * 24 * 3600_000)
      await o.b.tick()
      o.advance(61 * 60_000)
      await o.b.tick()
      expect(eng.calls.some((c) => c.endsWith('/purge'))).toBe(false)
      expect(await readFile(o.stateFile, 'utf8')).toBe('{"version": 1, "accounts": ')
    } finally { await o.b.close() }
  })
})
