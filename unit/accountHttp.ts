/** Account authority comes from a backend provider; the Unit owns visitor storage. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BackendAccount } from './backendTypes'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
class AccountChanged extends Error {}
const preferences = new Set(['modelId', 'asrModelId', 'visionModelId', 'visionMode', 'backgroundModelId',
  'agentDeskEnabled', 'summaryOpenIn', 'ttsModelId', 'ttsVoice', 'ttsSpeed', 'ttsAutoSpeak', 'asrBackend',
  'lastApprovalMode', 'lastThinkingLevel', 'lastChatThinkingLevel', 'notesAttachmentMode', 'notesAttachmentFolder',
  'notesImportPreview', 'notesDailyFolder', 'notesWikiIncludeFiles', 'notesUpgradeV4'])

export function createAccountHttp(options: {
  dataDir: string
  provider: () => { id: string; account: BackendAccount } | undefined
  pluginActive: (id: string) => boolean
}) {
  const writes = new Map<string, Promise<unknown>>()
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  async function read(path: string): Promise<any> {
    try { return JSON.parse(await readFile(path, 'utf8')) }
    catch (error: any) { if (error.code === 'ENOENT') return null; throw error }
  }
  async function write(path: string, update: (previous: any) => unknown, guard: () => Promise<void>) {
    const job = (writes.get(path) || Promise.resolve()).catch(() => {}).then(async () => {
      await guard()
      const value = update(await read(path)), temporary = path + '.' + randomUUID()
      try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await guard(); await rename(temporary, path) }
      finally { await rm(temporary, { force: true }) }
      return value
    })
    writes.set(path, job)
    try { return await job } finally { if (writes.get(path) === job) writes.delete(path) }
  }
  return async (path: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (path !== '/unit/account' && path !== '/unit/config' && !path.startsWith('/unit/plugin-data/')) return false
    const provider = options.provider()
    if (!provider) return false
    const controller = new AbortController()
    const onClose = () => { if (!res.writableEnded) controller.abort() }
    res.once('close', onClose)
    try {
      const bearer = /^Bearer (\S+)$/i.exec(String(req.headers.authorization || ''))?.[1]
      const identity = bearer ? await provider.account.resolve(bearer, { signal: controller.signal }) : null
      if (!identity) { json(res, 401, { error: 'Authentication required' }); return true }
      if (options.provider()?.account !== provider.account) { json(res, 503, { error: 'Account provider changed' }); return true }
      if (path === '/unit/account') {
        json(res, req.method === 'GET' ? 200 : 405, req.method === 'GET' ? identity : { error: 'Method not allowed' })
        return true
      }
      const plugin = path.startsWith('/unit/plugin-data/') ? path.slice('/unit/plugin-data/'.length) : null
      if (plugin !== null && (!/^[a-zA-Z0-9_-]+$/.test(plugin) || !options.pluginActive(plugin))) {
        json(res, 404, { error: 'Plugin is not active' }); return true
      }
      if (req.method !== 'GET' && req.method !== 'PUT') { json(res, 405, { error: 'Method not allowed' }); return true }
      // User-supplied headers, query parameters and bodies never choose the owner or path.
      const dir = join(options.dataDir, 'accounts', digest([provider.id, identity.userId, identity.tenantId, identity.workspaceId]))
      const file = join(dir, plugin === null ? 'preferences.json' : digest(plugin) + '.json')
      if (req.method === 'GET') {
        const value = await read(file)
        json(res, 200, plugin === null ? { config: value || {} } : { data: value })
        return true
      }
      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk)
        if (size > 1024 * 1024) { json(res, 413, { error: 'Data exceeds 1 MB' }); return true }
        chunks.push(Buffer.from(chunk))
      }
      let input: any
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { json(res, 400, { error: 'Invalid JSON' }); return true }
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
        (plugin !== null && typeof input.data !== 'string')) { json(res, 400, { error: 'Invalid data' }); return true }
      // Revalidate after uploads: revocation while reading a request cannot commit data.
      const guard = async () => {
        controller.signal.throwIfAborted()
        const current = await provider.account.resolve(bearer!, { signal: controller.signal })
        if (!current || digest(current) !== digest(identity) || options.provider()?.account !== provider.account) {
          throw new AccountChanged('Account changed')
        }
      }
      await guard()
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const value = await write(file, (previous) => plugin === null
        ? { ...previous, ...Object.fromEntries(Object.entries(input).filter(([key]) => preferences.has(key))) }
        : input.data, guard)
      json(res, 200, plugin === null ? { config: value } : { ok: true })
      return true
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, error instanceof AccountChanged ? 401 : 503,
        { error: error instanceof AccountChanged ? 'Account changed' : 'Account service unavailable' })
      return true
    } finally { res.off('close', onClose) }
  }
}
