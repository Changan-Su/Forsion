/** Unit-owned jobs survive Server worker replacement. No arbitrary paths or commands over HTTP. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, createPublicKey } from 'node:crypto'
import type { BackendAccount } from './backendTypes'
import { validId } from './packages'
import { OperationError } from './errors'
import { listReleases, resolveRelease, validReleaseId, releaseSignature, UNTRUSTED_RELEASE, type ReleaseSignature } from './releases'

export const MANAGEMENT_PATH = '/api/admin/unit'
const actions = ['enable', 'disable', 'restart', 'update', 'migrate', 'install', 'uninstall'] as const
/** Remote install / update apply a staged release; both name it by releaseId. */
const releaseActions: readonly string[] = ['update', 'install']
interface PluginStatus { id: string; state: string; requires: string[]; protected?: boolean }
export type ManagementCommand = { action: typeof actions[number]; id: string; path?: string; releaseDigest?: string }
interface Job {
  id: string; action: ManagementCommand['action']; pluginId: string; releaseId?: string
  actor: { userId: string; username: string }; createdAt: string; finishedAt?: string
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'
  phase?: 'verifying-release' | 'applying'
  error?: string
}
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message) } }
const json = (res: ServerResponse, status: number, value: unknown) => {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(value))
}
export async function createManagement(options: {
  enabled: boolean; dataDir: string; version: string
  provider: () => { id: string; account: BackendAccount } | undefined
  status: () => { plugins: PluginStatus[] } & Record<string, unknown>
  /** Private unit.json management.trustedKeys: ed25519 public keys (PEM) accepted besides the pinned official ones. */
  trustedKeys?: unknown
  execute?: (command: ManagementCommand, authorize: () => Promise<void>) => Promise<unknown>
}) {
  const file = join(options.dataDir, 'management-jobs.json')
  let jobs: Job[] = [], saving = Promise.resolve(), busy = false, closing = false, pending: Promise<void> | undefined
  const requests = new Set<Promise<void>>()
  const trustedKeys: string[] = []
  if (options.enabled && options.trustedKeys !== undefined) {
    const keys = options.trustedKeys
    if (!Array.isArray(keys) || keys.length > 32 || !keys.every((key) => {
      try { return typeof key === 'string' && createPublicKey(key).asymmetricKeyType === 'ed25519' } catch { return false }
    })) throw new Error('management.trustedKeys must list ed25519 public keys in PEM')
    trustedKeys.push(...keys)
  }
  // Keys only change with unit.json, which is read at startup; staged release directories are
  // append-only and every installation re-verifies, so a verdict per release digest stays valid.
  const verdicts = new Map<string, Promise<ReleaseSignature>>()
  const signatureOf = (releaseId: string, sha256: string, path: string) => {
    const key = `${releaseId}:${sha256}`
    let verdict = verdicts.get(key)
    if (!verdict) { verdict = releaseSignature(path, trustedKeys).catch(() => 'untrusted' as const); verdicts.set(key, verdict) }
    return verdict
  }
  if (options.enabled) {
    try { jobs = JSON.parse(await readFile(file, 'utf8')) } catch (e: any) { if (e.code !== 'ENOENT') throw e }
    if (!Array.isArray(jobs) || jobs.length > 100) throw new Error('Invalid Unit job journal')
    for (const job of jobs) if (job.state === 'queued' || job.state === 'running') {
      job.state = 'interrupted'; job.error = 'Unit stopped before completion; inspect current plugin state before retrying'
      job.finishedAt = new Date().toISOString()
    }
  }
  const save = () => {
    const payload = JSON.stringify(jobs)
    const next = saving.then(async () => {
      await mkdir(options.dataDir, { recursive: true, mode: 0o700 })
      const temporary = file + '.' + randomUUID()
      await writeFile(temporary, payload, { mode: 0o600 }); await rename(temporary, file)
    })
    saving = next.catch(() => {})
    return next
  }
  if (options.enabled && jobs.length) await save()
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const controller = new AbortController()
    const cancel = () => { if (!res.writableEnded) controller.abort() }
    res.once('close', cancel)
    try {
      if (!options.enabled || !options.execute) throw new HttpError(503, 'Unit management is disabled; enable management.enabled in private unit.json')
      if (closing) throw new HttpError(503, 'Unit is stopping')
      const provider = options.provider()
      if (!provider) throw new HttpError(503, 'Account authority is unavailable')
      const token = /^Bearer (\S+)$/i.exec(String(req.headers.authorization || ''))?.[1]
      if (!token || token.length > 16_384) throw new HttpError(401, 'Authentication required')
      let permission = 'unit.read'
      const authorize = async () => {
        if (closing) throw new HttpError(503, 'Unit is stopping')
        const identity = await provider.account.resolve(token, { signal: controller.signal, purpose: 'administration' })
        if (!identity) throw new HttpError(401, 'Invalid or expired account')
        if (identity.role !== 'ADMIN' && !(identity.role === 'ADMIN_SCOPED' && (identity.adminPermissions?.includes('*') || identity.adminPermissions?.includes(permission)))) throw new HttpError(403, 'Administrator access required')
        if (options.provider()?.account !== provider.account) throw new HttpError(503, 'Account authority changed')
        return identity
      }
      const actor = await authorize()
      const path = new URL(req.url!, 'http://unit.invalid').pathname
      if (req.method === 'GET') {
        if (path === MANAGEMENT_PATH + '/status') json(res, 200, { ...options.status(), management: { enabled: true, actions, busy } })
        else if (path === MANAGEMENT_PATH + '/releases') {
          const releases = await listReleases(options.dataDir), installed = new Set(options.status().plugins.map((plugin) => plugin.id))
          const listed = new Set(releases.map((release) => `${release.releaseId}:${release.sha256}`))
          for (const key of verdicts.keys()) if (!listed.has(key)) verdicts.delete(key)
          const result = []
          // Sequential: a bundled Server plugin can hold many files; verdicts are cached per digest.
          for (const release of releases) result.push({ ...release, installed: installed.has(release.pluginId),
            signature: await signatureOf(release.releaseId, release.sha256, join(options.dataDir, 'releases', release.releaseId, 'package')) })
          json(res, 200, { releases: result })
        }
        else if (path === MANAGEMENT_PATH + '/operations') json(res, 200, { operations: [...jobs].reverse() })
        else if (path.startsWith(MANAGEMENT_PATH + '/operations/')) {
          const job = jobs.find((entry) => entry.id === path.slice((MANAGEMENT_PATH + '/operations/').length))
          if (!job) throw new HttpError(404, 'Operation not found')
          json(res, 200, job)
        } else throw new HttpError(404, 'Unknown Unit management route')
        return
      }
      if (req.method !== 'POST' || path !== MANAGEMENT_PATH + '/operations') throw new HttpError(405, 'Method not allowed')
      if (!/^application\/json(?:;|$)/i.test(String(req.headers['content-type'] || ''))) throw new HttpError(415, 'JSON body required')
      let size = 0
      const chunks: Buffer[] = []
      req.setTimeout(5_000, () => req.destroy())
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk)
        if (size > 8192) throw new HttpError(413, 'Operation body exceeds 8 KB')
        chunks.push(Buffer.from(chunk))
      }
      req.setTimeout(0)
      let input: any
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(400, 'Invalid JSON') }
      if (!input || Array.isArray(input) || typeof input !== 'object'
        || Object.keys(input).some((key) => !['action', 'pluginId', 'releaseId', 'requestId', 'confirm'].includes(key))
        || !actions.includes(input.action) || !validId(input.pluginId) || !validReleaseId(input.requestId)
        || (releaseActions.includes(input.action) ? !validReleaseId(input.releaseId) : input.releaseId !== undefined)) throw new HttpError(400, 'Invalid operation arguments')
      if (input.confirm !== true) throw new HttpError(400, 'confirm:true is required for Unit operations')
      // Installing a staged, signed release is the same grant as updating to one; uninstalling keeps
      // data and versions on disk, like disabling. Existing MCP role ceilings therefore apply unchanged.
      permission = releaseActions.includes(input.action) ? 'unit.update' : input.action === 'migrate' ? 'unit.migrate' : 'unit.lifecycle'
      await authorize() // Bodies may arrive slowly; resolve current authority again before accepting work.
      const previous = jobs.find((job) => job.id === input.requestId)
      if (previous) {
        if (previous.actor.userId !== actor.userId || previous.action !== input.action || previous.pluginId !== input.pluginId
          || previous.releaseId !== input.releaseId) throw new HttpError(409, 'Request ID is already used for a different operation')
        json(res, 200, previous); return
      }
      if (busy) throw new HttpError(409, 'Another Unit operation is running')
      // Stopping the sole authority would prevent the same administrator from recovering over MCP.
      if (provider.id === input.pluginId && ['disable', 'migrate', 'uninstall'].includes(input.action)) throw new HttpError(409, 'Use local CLI for maintenance that stops the account authority')
      busy = true
      try {
        const plugins = options.status().plugins
        const installed = plugins.some((plugin) => plugin.id === input.pluginId)
        if (input.action === 'install' ? installed : !installed) {
          throw input.action === 'install' ? new HttpError(409, 'Plugin is already installed; use update') : new HttpError(404, 'Plugin is not installed')
        }
        if (input.action === 'uninstall') {
          // Disabled dependents still name it in requires and would fail the next Unit start.
          const dependents = plugins.filter((plugin) => plugin.requires.includes(input.pluginId)).map((plugin) => plugin.id)
          if (dependents.length) throw new HttpError(409, `Uninstall the plugins that require it first: ${dependents.join(', ')}`)
        }
        let release: Awaited<ReturnType<typeof resolveRelease>> | undefined
        if (releaseActions.includes(input.action)) {
          try { release = await resolveRelease(options.dataDir, input.releaseId, input.pluginId, options.version, false) }
          catch { throw new HttpError(400, 'Release is missing, incompatible, or its identity/content changed') }
          if (await signatureOf(input.releaseId, release.item.sha256, release.path) !== 'trusted') throw new HttpError(400, UNTRUSTED_RELEASE)
          if (input.action === 'install') {
            const inactive = (release.manifest.requires || []).filter((id) => plugins.find((plugin) => plugin.id === id)?.state !== 'active')
            if (inactive.length) throw new HttpError(409, `Required plugins are not active: ${inactive.join(', ')}`)
          }
        }
        await authorize()
        const job: Job = { id: input.requestId, action: input.action, pluginId: input.pluginId,
          ...(release ? { releaseId: input.releaseId } : {}), actor: { userId: actor.userId, username: actor.username },
          createdAt: new Date().toISOString(), state: 'queued' }
        const priorJobs = jobs
        jobs = [...jobs.slice(-99), job]
        try { await save() } catch (error) { jobs = priorJobs; throw error }
        const run = async () => {
          try {
            await authorize()
            job.state = 'running'; await save()
            if (release) {
              job.phase = 'verifying-release'; await save()
              const verified = await resolveRelease(options.dataDir, input.releaseId, input.pluginId, options.version)
              if (verified.item.sha256 !== release.item.sha256) throw new Error('Staged release changed during installation')
              await authorize()
            }
            job.phase = 'applying'; await save()
            console.log(`[unit-management] ${job.id} ${job.action} ${job.pluginId} actor=${job.actor.userId}`)
            await options.execute!({ action: job.action, id: job.pluginId, ...(release ? { path: release.path, releaseDigest: release.item.sha256 } : {}) }, async () => { await authorize() })
            job.state = 'succeeded'
          } catch (error) {
            job.state = 'failed'
            const reason = error instanceof Error ? error.message : ''
            job.error = error instanceof HttpError || error instanceof OperationError || ['Disable dependent plugins first', 'Disable the plugin before migrating',
              'Unit is stopping', 'Staged release changed during installation'].includes(reason)
              ? reason : 'Operation failed; inspect plugin status. Updates attempt to restore the previous package.'
          } finally {
            job.finishedAt = new Date().toISOString()
            // Execution is finished. A client observing a terminal state may submit the next job;
            // journal writes remain serialized even if that request arrives during this save.
            busy = false
            try { await save() } catch { console.error(`[unit-management] Could not persist result for ${job.id}`) }
            console.log(`[unit-management] ${job.id} ${job.state}`)
          }
        }
        // Persist and flush the accepted response before replacing a worker hosting its MCP caller.
        let launched = false
        let done!: () => void
        pending = new Promise<void>((resolve) => { done = resolve })
        const launch = () => { if (launched) return; launched = true; setTimeout(() => { void run().finally(done) }, 100) }
        res.once('finish', launch); res.once('close', launch)
        if (res.destroyed || res.writableEnded) launch()
        else json(res, 202, job)
      } catch (error) { busy = false; throw error }
    } catch (error) {
      const message = error instanceof HttpError ? error.message : 'Unit management is temporarily unavailable'
      // detail is what the admin plugin's fetch reads; error stays for MCP and older callers.
      json(res, error instanceof HttpError ? error.status : 503, { error: message, detail: message })
    } finally { res.off('close', cancel) }
  }
  return {
    route(req: IncomingMessage, res: ServerResponse): boolean {
      const path = (req.url || '/').split('?')[0]
      if (path !== MANAGEMENT_PATH && !path.startsWith(MANAGEMENT_PATH + '/')) return false
      const task = handle(req, res)
      requests.add(task)
      void task.then(() => requests.delete(task), () => requests.delete(task))
      return true
    },
    async close() { closing = true; await Promise.allSettled([...requests]); await pending; await saving },
  }
}
