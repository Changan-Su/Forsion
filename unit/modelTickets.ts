/** Model tickets for the visitors of a hosted public Unit.
 *
 * The host of such a Unit writes a device credential into its data directory (`{ "unitId": "...", "unitSecret": "...",
 * "gen": 0 }`) and names it in unit.json (`visitorEngine.deviceCredential`). With it and a visitor's own sign-in, the Unit
 * asks the account server (`POST <remoteAccount.origin>/api/units/model-ticket`) for a short-lived model ticket bound to
 * this Unit and that visitor, and hands it to the multi-account engine with the visitor's requests (X-Forsion-Model-Ticket).
 * The engine uses it for that visitor's model calls. It never sees the device credential.
 *
 * - The credential is read by the Unit process only, by path, before every request to the server: the host replaces the
 *   file when it rotates the credential (also while the Unit runs), and it can be missing for a while after a restore.
 *   It never goes into the engine's environment or a log line.
 * - Missing = not configured for this request; the next request reads again. Unreadable or malformed = unknown, reported
 *   without values: the last good credential stays in use, it is never treated as an empty one. A 401 after a rotation
 *   re-reads the file and, when it changed, tries once more.
 * - One ticket per (visitor, sign-in), renewed when missing or within 30 minutes of expiry. A still-valid ticket keeps
 *   being sent while the renewal runs and when it fails. A failed request waits before the next try, so visitors whose
 *   pages poll do not hammer the server.
 * - Tickets go to the engine only: never back to the browser, never into a log line.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

export const MODEL_TICKET_PATH = '/api/units/model-ticket'

/** unit.json's visitorEngine.deviceCredential → absolute path. Relative to the data directory and inside it. */
export function deviceCredentialPath(dataDir: string, value: unknown): string {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\') || value.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    throw new Error('visitorEngine.deviceCredential must be a plain path relative to the data directory')
  }
  const file = resolve(dataDir, value)
  const rel = relative(resolve(dataDir), file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('visitorEngine.deviceCredential must stay inside the data directory')
  return file
}

export interface DeviceCredential { unitId: string; unitSecret: string; gen?: number }
export type DeviceCredentialRead =
  | { state: 'absent' }
  | { state: 'unreadable'; reason: string }
  | { state: 'ok'; credential: DeviceCredential }

/** Header-safe printable ASCII, bounded. */
const isHeaderText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value)

export async function readDeviceCredential(file: string): Promise<DeviceCredentialRead> {
  let text: string
  try { text = await readFile(file, 'utf8') } catch (error: any) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? { state: 'absent' } : { state: 'unreadable', reason: String(error?.code || 'read failed') }
  }
  let body: any
  try { body = JSON.parse(text) } catch { return { state: 'unreadable', reason: 'not JSON' } }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { state: 'unreadable', reason: 'not an object' }
  if (!isHeaderText(body.unitId, 128) || !isHeaderText(body.unitSecret, 1024)) return { state: 'unreadable', reason: 'unitId or unitSecret missing or invalid' }
  if (body.gen !== undefined && !(Number.isInteger(body.gen) && body.gen >= 0)) return { state: 'unreadable', reason: 'invalid gen' }
  return { state: 'ok', credential: { unitId: body.unitId, unitSecret: body.unitSecret, ...(body.gen !== undefined ? { gen: body.gen } : {}) } }
}

const TICKET_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

/** Expiry (ms) of a ticket issued for `account`, from its own exp claim (the payload is read, not verified: the server
 *  verifies it). Falls back to the reply's expiresAt only when the token carries no exp. null = not usable. */
export function ticketExpiry(ticket: unknown, account: string, expiresAt?: unknown): number | null {
  if (typeof ticket !== 'string' || ticket.length > 8192 || !TICKET_SHAPE.test(ticket)) return null
  let claims: any
  try { claims = JSON.parse(Buffer.from(ticket.split('.')[1], 'base64url').toString('utf8')) } catch { return null }
  if (!claims || typeof claims !== 'object' || String(claims.userId ?? '') !== account) return null
  if (typeof claims.exp === 'number' && Number.isFinite(claims.exp)) return claims.exp * 1000
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) return expiresAt > 1e12 ? expiresAt : expiresAt * 1000
  if (typeof expiresAt === 'string') { const ms = Date.parse(expiresAt); return Number.isFinite(ms) ? ms : null }
  return null
}

export interface ModelTicketsOptions {
  /** Account server origin (remoteAccount.origin). */
  origin: string
  credentialFile: string
  /** What the Unit read at start (it logged that itself). */
  initial?: DeviceCredentialRead
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
  log?: (message: string) => void
  maxEntries?: number
}

export interface ModelTickets {
  /** A ticket for this visitor's sign-in, or null (no credential, the server refused, still backing off). Never throws. */
  ticketFor(account: string, bearer: string, signal?: AbortSignal): Promise<string | null>
}

const RENEW_BEFORE_MS = 30 * 60_000
/** Not sent when this close to expiry: the engine would refuse it, and a model call could outlive it. */
const EXPIRY_MARGIN_MS = 60_000
const RETRY_AFTER_MS = 30_000
const LOG_EVERY_MS = 60_000
/** How often a cached ticket is checked against the file: a rotation voids every ticket of the previous credential. */
const RECHECK_MS = 30_000

const credentialKey = (c: DeviceCredential): string => createHash('sha256').update(`${c.unitId}\0${c.unitSecret}\0${c.gen ?? 0}`).digest('hex')

export function createModelTickets(options: ModelTicketsOptions): ModelTickets {
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? 8000
  const maxEntries = options.maxEntries ?? 5000
  const log = options.log ?? ((message: string) => console.log(message))
  const url = new URL(MODEL_TICKET_PATH, options.origin)
  let credential: DeviceCredential | null = options.initial?.state === 'ok' ? options.initial.credential : null
  // The last good credential's key. Changes only when a different valid credential is read (not when the file is missing):
  // tickets minted with another key are never sent again.
  let activeKey: string | null = credential ? credentialKey(credential) : null
  let unreadableReported = options.initial?.state === 'unreadable'
  let lastFailureLog = { reason: '', at: -Infinity }
  let failing = false
  let checkedAt = now()
  let checking: Promise<unknown> | null = null

  type Entry = { ticket?: string; credKey?: string; expMs: number; retryAt: number; job?: Promise<void> }
  const entries = new Map<string, Entry>()

  async function loadCredential(): Promise<DeviceCredential | null> {
    checkedAt = now()
    const read = await readDeviceCredential(options.credentialFile)
    if (read.state === 'ok') {
      if (!credential || unreadableReported) log('[unit] Hosted unit device credential loaded')
      credential = read.credential
      activeKey = credentialKey(read.credential)
      unreadableReported = false
    } else if (read.state === 'absent') {
      if (credential) log('[unit] Hosted unit device credential is missing; visitors get no new model tickets until it is back')
      credential = null
    } else if (!unreadableReported) {
      // Unknown, not empty: the last good credential stays in use until the file reads again.
      unreadableReported = true
      log(`[unit] Hosted unit device credential is unreadable (${read.reason}); ${credential ? 'keeping the last good one' : 'visitors get no model tickets'} until it is repaired`)
    }
    return credential
  }

  function failed(entry: Entry, reason: string): void {
    entry.retryAt = now() + RETRY_AFTER_MS
    failing = true
    if (reason !== lastFailureLog.reason || now() - lastFailureLog.at >= LOG_EVERY_MS) {
      lastFailureLog = { reason, at: now() }
      log(`[unit] Model ticket request failed (${reason}); visitors without a valid ticket cannot call models until it succeeds`)
    }
  }

  const ask = (current: DeviceCredential, bearer: string): Promise<Response> => doFetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'X-Unit-Id': current.unitId, 'X-Unit-Secret': current.unitSecret, Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
  })

  async function renew(entry: Entry, account: string, bearer: string): Promise<void> {
    try {
      let current = await loadCredential()
      if (!current) { entry.retryAt = now() + RETRY_AFTER_MS; return }
      let response: Response
      try {
        response = await ask(current, bearer)
        if (response.status === 401) {
          // Rotated between our read and the server's check: the host has replaced the file by now. Once, and only with a changed one.
          const again = await loadCredential()
          if (again && credentialKey(again) !== credentialKey(current)) {
            await response.body?.cancel().catch(() => {})
            current = again
            response = await ask(current, bearer)
          }
        }
      } catch (error: any) { failed(entry, error?.name === 'TimeoutError' ? 'timed out' : 'server unreachable'); return }
      if (response.status !== 200) { await response.body?.cancel().catch(() => {}); failed(entry, `HTTP ${response.status}`); return }
      const body: any = await response.json().catch(() => null)
      const expMs = ticketExpiry(body?.ticket, account, body?.expiresAt)
      if (expMs === null || expMs - now() <= EXPIRY_MARGIN_MS) { failed(entry, 'unusable ticket in reply'); return }
      entry.ticket = body.ticket
      entry.credKey = credentialKey(current)
      entry.expMs = expMs
      entry.retryAt = 0
      if (failing) { failing = false; log('[unit] Model ticket requests succeed again') }
    } catch {
      failed(entry, 'unexpected error')
    }
  }

  const wait = (job: Promise<void>, signal?: AbortSignal): Promise<void> => {
    if (!signal) return job
    if (signal.aborted) return Promise.resolve()
    return new Promise<void>((done) => {
      const onAbort = () => done()
      signal.addEventListener('abort', onAbort, { once: true })
      void job.finally(() => { signal.removeEventListener('abort', onAbort); done() })
    })
  }

  return {
    async ticketFor(account, bearer, signal) {
      try {
        if (now() - checkedAt >= RECHECK_MS) {
          checking ??= loadCredential().finally(() => { checking = null })
          await checking
        }
        const key = createHash('sha256').update(`${account}\0${bearer}`).digest('hex')
        let entry = entries.get(key)
        // Minted with the current credential and not about to expire. A ticket of a rotated credential is dead on the server.
        const usable = (): string | null => (entry?.ticket && entry.credKey === activeKey && entry.expMs - now() > EXPIRY_MARGIN_MS ? entry.ticket : null)
        const current = usable()
        if (current && entry!.expMs - now() > RENEW_BEFORE_MS) return current
        if (!entry) {
          if (entries.size >= maxEntries) {
            for (const [k, e] of entries) if (!e.job && e.expMs <= now()) entries.delete(k)
            if (entries.size >= maxEntries) entries.delete(entries.keys().next().value!)
          }
          entry = { expMs: 0, retryAt: 0 }
          entries.set(key, entry)
        }
        const target = entry
        if (!target.job && target.retryAt <= now()) target.job = renew(target, account, bearer).finally(() => { target.job = undefined })
        // A ticket that is still valid goes now; the renewal finishes in the background.
        if (current) return current
        if (target.job) await wait(target.job, signal)
        return usable()
      } catch {
        return null
      }
    },
  }
}
