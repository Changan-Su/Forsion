/** Per-account backups of a hosted public Unit's visitor engine.
 *
 * The Unit holds the device credential, so it is the one that talks to the account server's backup service: it asks for a
 * one-time upload address, streams the engine's snapshot of one account there, and registers the restore point; when a
 * visitor whose local copy was removed comes back, it asks for that visitor's restore point (with the visitor's own
 * sign-in) and streams it back into the engine. The engine does the parts that need its database and request queue,
 * behind its host control credential (tangu-agent standalone/accountBackup.ts). The two never share a directory.
 *
 * - A visitor's request marks the account as touched. A touched account is backed up once it has been quiet for
 *   idleMinutes, or every intervalMinutes while it keeps being used. Unchanged folders are not uploaded again. A failed
 *   backup keeps the previous restore point and is retried with backoff.
 * - An account nobody used for coldAfterDays, whose folder is unchanged since its last backup and whose latest restore point
 *   the server confirms, has its local copy removed; the server then keeps that last copy for its cold retention period.
 * - Before a visitor's request reaches the engine, an account that is not on the engine is restored (one restore at a time
 *   for the whole Unit). It is admitted as a new account only when the server says it has never had a backup here. When
 *   the server cannot answer, the visitor is told to try again: an empty account never replaces one that may exist.
 * - When each account was last used is kept in a state file in the data directory (written atomically). If that file cannot
 *   be read, nobody's local copy is removed until it can.
 */
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { dirname } from 'node:path'
import type { Readable } from 'node:stream'
import { readDeviceCredential, type DeviceCredential } from './modelTickets'

export interface VisitorBackupSettings { intervalMinutes: number; idleMinutes: number; coldAfterDays: number }
export const BACKUP_DEFAULTS: VisitorBackupSettings = { intervalMinutes: 15, idleMinutes: 2, coldAfterDays: 90 }

/** unit.json's visitorEngine.backup → settings. Unknown keys and bad values are configuration errors. */
export function backupSettings(value: unknown): VisitorBackupSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('visitorEngine.backup must be an object')
  const v = value as Record<string, unknown>
  for (const key of Object.keys(v)) if (!(key in BACKUP_DEFAULTS)) throw new Error(`visitorEngine.backup.${key} is not a setting`)
  const num = (key: keyof VisitorBackupSettings, min: number, max: number): number => {
    if (v[key] === undefined) return BACKUP_DEFAULTS[key]
    const n = v[key]
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new Error(`visitorEngine.backup.${key} must be a number between ${min} and ${max}`)
    return n
  }
  return { intervalMinutes: num('intervalMinutes', 1, 24 * 60), idleMinutes: num('idleMinutes', 0.1, 24 * 60), coldAfterDays: num('coldAfterDays', 1, 3650) }
}

export interface EngineControl { url: string | null; token: string }
export type PrepareError = { status: number; code: string; detail: string }

export interface VisitorBackupsOptions {
  origin: string
  credentialFile: string
  stateFile: string
  engine: () => EngineControl | null
  settings: VisitorBackupSettings
  now?: () => number
  log?: (message: string) => void
  /** How often due backups and cold accounts are looked at (default one minute). */
  tickMs?: number
  timeoutMs?: number
}

export interface VisitorBackups {
  /** Before a visitor's request goes to the engine: null = go on; otherwise the reply to send instead. Never throws. */
  prepare(account: string, bearer: string, signal?: AbortSignal): Promise<PrepareError | null>
  /** Runs due backups and cold-account removals now (the timer calls it too). */
  tick(): Promise<void>
  close(): Promise<void>
}

interface AccountState {
  lastSeen: number
  /** Touched since the last backup that covered it. */
  dirty?: boolean
  dirtySince?: number
  lastBackup?: { backupId: string; fingerprint: string | null; sha256: string; at: number }
  cold?: { backupId: string; at: number; serverMarked: boolean }
  nextTryAt?: number
  failures?: number
}
interface StateFile { version: 1; accounts: Record<string, AccountState> }

class Refused extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

async function writeDurable(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  const fh = await open(tmp, 'w', 0o600)
  try { await fh.writeFile(data); await fh.sync() } finally { await fh.close() }
  await rename(tmp, path)
  try { const d = await open(dirname(path), 'r'); try { await d.sync() } finally { await d.close() } } catch { /* not everywhere */ }
}

/** One HTTP(S) request with an exact Content-Length (presigned PUTs refuse chunked bodies). Resolves with the response. */
function send(url: string, method: string, headers: Record<string, string>, body: Readable | null, timeoutMs: number): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers, timeout: timeoutMs }, resolve)
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    if (body) { body.on('error', (e) => req.destroy(e)); body.pipe(req) } else req.end()
  })
}
async function drain(res: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of res) { if (size < 64 * 1024) { chunks.push(c as Buffer); size += (c as Buffer).length } }
  return Buffer.concat(chunks).toString('utf8')
}

export async function createVisitorBackups(options: VisitorBackupsOptions): Promise<VisitorBackups> {
  const now = options.now ?? Date.now
  const log = options.log ?? ((m: string) => console.log(m))
  const timeoutMs = options.timeoutMs ?? 30_000
  const { settings } = options
  let state: StateFile = { version: 1, accounts: {} }
  /** The state file could not be read: when people were last here is unknown, so nobody is archived. */
  let stateUnknown = false
  try {
    const body = JSON.parse(await readFile(options.stateFile, 'utf8'))
    if (!body || body.version !== 1 || typeof body.accounts !== 'object' || Array.isArray(body.accounts)) throw new Error('unexpected shape')
    state = body
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      stateUnknown = true
      log(`[unit] Hosted unit account backups: the state file is unreadable (${error?.code || error?.message || 'bad'}); no local copies are removed until it is repaired`)
    }
  }

  let saving: Promise<void> | null = null
  let saveAgain = false
  const save = (): Promise<void> => {
    if (stateUnknown) return Promise.resolve() // never overwrite a file we could not read
    if (saving) { saveAgain = true; return saving }
    saving = (async () => {
      do { saveAgain = false; await writeDurable(options.stateFile, JSON.stringify(state)) } while (saveAgain)
    })().catch((e) => log(`[unit] Hosted unit account backups: saving the state file failed (${e?.message || e})`)).finally(() => { saving = null })
    return saving
  }
  let saveTimer: NodeJS.Timeout | null = null
  const saveSoon = (): void => { if (!saveTimer) { saveTimer = setTimeout(() => { saveTimer = null; void save() }, 5_000); saveTimer.unref?.() } }

  const acct = (id: string): AccountState => (state.accounts[id] ??= { lastSeen: now() })

  // ── server ─────────────────────────────────────────────────────────────────────────
  let credential: DeviceCredential | null = null
  async function device(): Promise<DeviceCredential> {
    const read = await readDeviceCredential(options.credentialFile)
    if (read.state === 'ok') credential = read.credential
    else if (read.state === 'absent') credential = null
    // unreadable: keep the last good one
    if (!credential) throw new Refused(503, 'BACKUP_UNAVAILABLE', 'the device credential is not there')
    return credential
  }
  async function server(method: string, path: string, opts: { body?: unknown; bearer?: string } = {}): Promise<{ status: number; json: any }> {
    const c = await device()
    const res = await fetch(new URL(path, options.origin), {
      method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'X-Unit-Id': c.unitId, 'X-Unit-Secret': c.unitSecret, Accept: 'application/json',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { json = null }
    return { status: res.status, json }
  }

  // ── engine ─────────────────────────────────────────────────────────────────────────
  function control(): EngineControl & { url: string } {
    const c = options.engine()
    if (!c?.url || !c.token) throw new Refused(503, 'ENGINE_UNAVAILABLE', 'the engine is not running')
    return c as EngineControl & { url: string }
  }
  async function engine(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const c = control()
    const res = await fetch(`${c.url}/_host${path}`, {
      method, signal: AbortSignal.timeout(Math.max(timeoutMs, 180_000)),
      headers: { Authorization: `Bearer ${c.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { json = null }
    return { status: res.status, json }
  }

  // ── restore / admit before a visitor's request ─────────────────────────────────────
  const known = new Set<string>() // confirmed on the engine in this process
  const restoring = new Map<string, Promise<void>>()
  let restoreQueue: Promise<unknown> = Promise.resolve()

  async function bringBack(id: string, bearer: string): Promise<void> {
    const info = await engine('GET', `/accounts/${id}`)
    if (info.status !== 200) throw new Refused(503, 'ENGINE_UNAVAILABLE', `engine answered ${info.status}`)
    if (info.json?.state === 'active') {
      // the engine has it (e.g. a restore finished just before this process stopped, before the state file said so):
      // the file must not keep calling it archived, or no backup would ever run for it again
      const a = acct(id)
      if (a.cold) { a.cold = undefined; a.dirty = true; a.dirtySince ??= now(); void save() }
      return
    }
    const engineState: 'cold' | 'absent' = info.json?.state === 'cold' ? 'cold' : 'absent'
    const expected: string | null = info.json?.cold?.backupId ?? null
    const r = await server('POST', '/api/units/backups/restore', { bearer, body: expected ? { backupId: expected } : {} })
    if (r.status === 401 && r.json?.code === 'VISITOR_AUTH_INVALID') throw new Refused(401, 'AUTH_REQUIRED', 'Sign in again')
    if (r.status === 404 && r.json?.code === 'BACKUP_NONE' && engineState === 'absent') {
      const admit = await engine('POST', `/accounts/${id}/admit`)
      if (admit.status !== 200) throw new Refused(admit.status === 503 ? 503 : 502, admit.json?.code || 'ACCOUNT_UNAVAILABLE', admit.json?.detail || 'the account could not be opened')
      log(`[unit] Hosted unit account backups: ${id} is new here`)
      return
    }
    if (r.status === 410 && r.json?.code === 'BACKUP_EXPIRED') {
      // the server removed this person's backups after the retention period: start over, deliberately
      if (engineState === 'cold') await engine('POST', `/accounts/${id}/forget`)
      const admit = await engine('POST', `/accounts/${id}/admit`)
      if (admit.status !== 200) throw new Refused(503, admit.json?.code || 'ACCOUNT_UNAVAILABLE', 'the account could not be opened')
      log(`[unit] Hosted unit account backups: ${id} came back after the retention period; starting a new account`)
      return
    }
    if (r.status !== 200 || typeof r.json?.download?.url !== 'string') {
      // includes "cold here but the server has nothing": never an empty account in its place
      log(`[unit] Hosted unit account backups: restoring ${id} is not possible now (${r.status} ${r.json?.code || ''})`)
      throw new Refused(503, 'ACCOUNT_RESTORE_UNAVAILABLE', 'Your data could not be brought back right now; try again in a minute.')
    }
    const { backupId, size, sha256 } = r.json
    if (expected && backupId !== expected) throw new Refused(503, 'ACCOUNT_RESTORE_UNAVAILABLE', 'the server offered another backup')
    const download = await send(r.json.download.url, 'GET', {}, null, timeoutMs)
    if (download.statusCode !== 200) { await drain(download); throw new Refused(503, 'ACCOUNT_RESTORE_UNAVAILABLE', `download answered ${download.statusCode}`) }
    const c = control()
    const q = new URLSearchParams({ size: String(size), sha256, ...(backupId ? { backupId } : {}) })
    const res = await send(`${c.url}/_host/accounts/${id}/restore?${q}`, 'POST',
      { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) }, download, Math.max(timeoutMs, 300_000))
    const text = await drain(res)
    let out: any = null
    try { out = JSON.parse(text) } catch { out = null }
    if (res.statusCode !== 200) {
      log(`[unit] Hosted unit account backups: the engine refused the restore of ${id} (${res.statusCode} ${out?.code || ''})`)
      throw new Refused(503, 'ACCOUNT_RESTORE_UNAVAILABLE', 'Your data could not be brought back right now; try again in a minute.')
    }
    const a = acct(id)
    a.cold = undefined
    a.lastBackup = { backupId, fingerprint: typeof out?.fingerprint === 'string' ? out.fingerprint : null, sha256, at: now() }
    // dirty stays as the request that brought it back set it: that request (and what it starts) writes after this point,
    // and the next pass checks it against the restored fingerprint ("unchanged" costs no upload)
    void save()
    log(`[unit] Hosted unit account backups: ${id} restored`)
  }

  async function prepare(id: string, bearer: string, signal?: AbortSignal): Promise<PrepareError | null> {
    if (!ACCOUNT_ID.test(id)) return { status: 400, code: 'BAD_ACCOUNT', detail: 'Invalid account' }
    const a = acct(id)
    a.lastSeen = now()
    if (!a.dirty) { a.dirty = true; a.dirtySince = now() }
    saveSoon()
    if (known.has(id)) return null
    try {
      let job = restoring.get(id)
      if (!job) {
        // one restore at a time for the whole Unit; the same account's requests share one
        job = restoreQueue.then(() => bringBack(id, bearer))
        restoreQueue = job.catch(() => {})
        restoring.set(id, job)
        void job.finally(() => restoring.delete(id)).catch(() => {})
      }
      if (signal) await Promise.race([job, new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Refused(499, 'ABORTED', 'aborted')), { once: true }))])
      else await job
      known.add(id)
      return null
    } catch (error: any) {
      if (error instanceof Refused) return { status: error.status, code: error.code, detail: error.message }
      log(`[unit] Hosted unit account backups: preparing ${id} failed (${error?.name === 'TimeoutError' ? 'timed out' : 'unreachable'})`)
      return { status: 503, code: 'ACCOUNT_RESTORE_UNAVAILABLE', detail: 'Your data could not be brought back right now; try again in a minute.' }
    }
  }

  // ── backups ────────────────────────────────────────────────────────────────────────
  const backoff = (a: AccountState): void => {
    a.failures = (a.failures ?? 0) + 1
    a.nextTryAt = now() + Math.min(30 * MINUTE, MINUTE * 2 ** Math.min(a.failures - 1, 5))
  }

  /** Backs up one account. Returns false when it could not (the previous restore point stays). */
  async function backup(id: string): Promise<boolean> {
    const a = acct(id)
    const started = now()
    const snap = await engine('POST', `/accounts/${id}/snapshot`, { since: a.lastBackup?.fingerprint ?? undefined })
    if (snap.status === 200 && snap.json?.unchanged) {
      if (a.lastSeen <= started) a.dirty = false
      a.failures = 0; a.nextTryAt = undefined
      return true
    }
    if (snap.status !== 200 || !snap.json?.snapshotId) {
      if (snap.json?.code === 'ACCOUNT_COLD' || snap.json?.code === 'ACCOUNT_ABSENT') { a.dirty = false; known.delete(id); return false }
      if (snap.json?.code !== 'ACCOUNT_BUSY') log(`[unit] Hosted unit account backups: snapshot of ${id} failed (${snap.status} ${snap.json?.code || ''})`)
      backoff(a)
      return false
    }
    const s = snap.json as { snapshotId: string; size: number; md5: string; sha256: string; fingerprint: string }
    try {
      const signed = await server('POST', '/api/units/backups', { body: { userId: id, size: s.size, md5: s.md5, sha256: s.sha256 } })
      if (signed.status !== 200 || typeof signed.json?.upload?.url !== 'string') {
        log(`[unit] Hosted unit account backups: the server would not take a backup of ${id} (${signed.status} ${signed.json?.code || ''})`)
        backoff(a)
        return false
      }
      const c = control()
      const content = await send(`${c.url}/_host/snapshots/${s.snapshotId}`, 'GET', { Authorization: `Bearer ${c.token}` }, null, timeoutMs)
      if (content.statusCode !== 200) { await drain(content); throw new Error(`engine answered ${content.statusCode}`) }
      const headers: Record<string, string> = { ...signed.json.upload.headers, 'Content-Length': String(s.size) }
      const put = await send(signed.json.upload.url, 'PUT', headers, content, Math.max(timeoutMs, 600_000))
      const putText = await drain(put)
      if (put.statusCode !== 200) throw new Error(`storage answered ${put.statusCode} ${putText.slice(0, 120)}`)
      const committed = await server('POST', `/api/units/backups/${signed.json.backupId}/commit`, { body: { userId: id } })
      if (committed.status !== 200) throw new Error(`commit answered ${committed.status} ${committed.json?.code || ''}`)
      a.lastBackup = { backupId: signed.json.backupId, fingerprint: s.fingerprint, sha256: s.sha256, at: now() }
      if (a.lastSeen <= started) a.dirty = false
      a.failures = 0; a.nextTryAt = undefined
      void save()
      return true
    } catch (error: any) {
      log(`[unit] Hosted unit account backups: backing up ${id} failed (${error?.message || error}); the previous restore point stays`)
      backoff(a)
      return false
    } finally {
      await engine('DELETE', `/snapshots/${s.snapshotId}`).catch(() => {})
    }
  }

  const notArchivable = new Set<string>()
  /** Removes the local copy of an account nobody used for coldAfterDays, once its latest restore point is confirmed. */
  async function archive(id: string): Promise<void> {
    const a = acct(id)
    if (!a.lastBackup) return
    const snap = await engine('POST', `/accounts/${id}/snapshot`, { since: a.lastBackup.fingerprint ?? undefined })
    if (snap.status === 200 && !snap.json?.unchanged && snap.json?.snapshotId) {
      // changed since the last backup: back it up first (the regular pass does), archive another time
      await engine('DELETE', `/snapshots/${snap.json.snapshotId}`).catch(() => {})
      a.dirty = true; a.dirtySince ??= now()
      return
    }
    if (snap.status !== 200 || !snap.json?.unchanged) return
    const latest = await server('GET', `/api/units/backups/latest?userId=${encodeURIComponent(id)}`)
    if (latest.status !== 200 || latest.json?.backupId !== a.lastBackup.backupId || latest.json?.sha256 !== a.lastBackup.sha256) {
      log(`[unit] Hosted unit account backups: not archiving ${id}: the server does not confirm its latest restore point (${latest.status} ${latest.json?.code || ''})`)
      return
    }
    const purged = await engine('POST', `/accounts/${id}/purge`, { fingerprint: snap.json.fingerprint, backupId: a.lastBackup.backupId, sha256: a.lastBackup.sha256 })
    if (purged.status !== 200) {
      const code = purged.json?.code
      if (code === 'ACCOUNT_CHANGED') { a.dirty = true; a.dirtySince ??= now() } // back it up again first
      // keeps something a backup cannot carry (e.g. a hard-linked file): stays here; said once per process, not every hour
      if (code !== 'ACCOUNT_BUSY' && !(code === 'ACCOUNT_NOT_ARCHIVABLE' && notArchivable.has(id))) log(`[unit] Hosted unit account backups: archiving ${id} refused (${purged.status} ${code || ''})`)
      if (code === 'ACCOUNT_NOT_ARCHIVABLE') notArchivable.add(id)
      return
    }
    known.delete(id)
    a.cold = { backupId: a.lastBackup.backupId, at: now(), serverMarked: false }
    await save()
    log(`[unit] Hosted unit account backups: ${id} archived; its local copy was removed`)
    await markColdOnServer(id)
  }
  async function markColdOnServer(id: string): Promise<void> {
    const a = acct(id)
    if (!a.cold || a.cold.serverMarked) return
    const r = await server('POST', '/api/units/backups/cold', { body: { userId: id, backupId: a.cold.backupId } }).catch(() => ({ status: 0, json: null }))
    if (r.status === 200) { a.cold.serverMarked = true; void save() }
  }

  let ticking: Promise<void> | null = null
  let lastArchivePass = 0
  async function tickOnce(): Promise<void> {
    const t = now()
    // accounts the engine has that this file does not know: last seen = now (never archived on a guess)
    if (!Object.keys(state.accounts).length || t - lastArchivePass >= 60 * MINUTE) {
      const list = await engine('GET', '/accounts').catch(() => null)
      if (list?.status === 200 && Array.isArray(list.json?.accounts)) {
        for (const e of list.json.accounts) {
          if (!ACCOUNT_ID.test(e?.id)) continue
          const had = state.accounts[e.id]
          if (!had) state.accounts[e.id] = { lastSeen: t, ...(e.state === 'cold' ? { cold: { backupId: '', at: t, serverMarked: true } } : {}) }
          // archived in the file but here on the engine (restored before the file was saved): back on the schedule
          else if (had.cold && e.state === 'active') { had.cold = undefined; had.dirty = true; had.dirtySince ??= t }
        }
      }
    }
    for (const [id, a] of Object.entries(state.accounts)) {
      if (a.cold || !a.dirty || (a.nextTryAt ?? 0) > t) continue
      const quiet = t - a.lastSeen >= settings.idleMinutes * MINUTE
      const overdue = t - (a.lastBackup?.at ?? a.dirtySince ?? t) >= settings.intervalMinutes * MINUTE
      if (quiet || overdue) await backup(id).catch((e) => { log(`[unit] Hosted unit account backups: ${id}: ${e?.message || e}`); backoff(a) })
    }
    if (t - lastArchivePass >= 60 * MINUTE) {
      lastArchivePass = t
      for (const [id, a] of Object.entries(state.accounts)) {
        if (a.cold) { await markColdOnServer(id); continue }
        if (stateUnknown || a.dirty || t - a.lastSeen < settings.coldAfterDays * DAY) continue
        await archive(id).catch((e) => log(`[unit] Hosted unit account backups: archiving ${id} failed (${e?.message || e})`))
      }
    }
    saveSoon()
  }
  const tick = (): Promise<void> => (ticking ??= tickOnce().catch((e) => log(`[unit] Hosted unit account backups: pass failed (${e?.message || e})`)).finally(() => { ticking = null }))
  const timer = setInterval(() => { void tick() }, options.tickMs ?? MINUTE)
  timer.unref?.()
  log('[unit] Hosted unit account backups are on')

  return {
    prepare,
    tick,
    close: async () => {
      clearInterval(timer)
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
      await ticking
      await save()
    },
  }
}
