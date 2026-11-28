import path from 'node:path'
import { promises as fs, constants } from 'node:fs'
import { createHash } from 'node:crypto'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { VAULT_CREATE_IPC as ch, vaultDirName, type VaultCreated, type VaultDefaultLocation, type VaultFolderRequest, type VaultFolderStatus, type VaultRollbackResult } from '../../shared/amadeus/vaultCreate'
import { defaultWorkspaceDir } from '../forsionHome'
import { isManagedCloudVault } from './cloudPaths'
import { moveSyncVaultPin, withVaultRegistry } from './settings'
import { samePath, normalizeLocal, syncVaultRoot, vaultList } from './vaultList'

const absolute = (v: unknown): v is string => typeof v === 'string' && path.isAbsolute(v) && !v.includes('\0')
const contains = (root: string, file: string): boolean => {
  const rel = path.relative(root, file)
  return !!rel && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)
}
const sameFile = (a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean => a.dev === b.dev && a.ino === b.ino

async function defaultLocation(): Promise<VaultDefaultLocation> {
  const configured = path.resolve(defaultWorkspaceDir())
  const workspace = await fs.realpath(configured).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return configured
    throw e
  })
  const parent = path.join(workspace, 'Vaults')
  const stat = await fs.lstat(parent).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  if (stat && !stat.isDirectory()) throw new Error('parent-missing')
  const freeBytes = await fs.statfs(stat ? parent : workspace).then((v) => v.bavail * v.bsize, () => null)
  return { path: parent, exists: !!stat, freeBytes }
}

async function ensureDefaultParent(): Promise<string> {
  const { path: parent, exists } = await defaultLocation()
  if (!exists) {
    try { await fs.mkdir(parent) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
  }
  if (!(await fs.lstat(parent)).isDirectory() || await fs.realpath(parent) !== parent) throw new Error('parent-missing')
  return parent
}

export function createVaultRegistryHost() {
  type Claim = VaultCreated & { identity: { dev: number; ino: number } }
  const claims = new Map<string, Claim>()
  const owners = new Map<string, string>()
  const rootQueue = new Map<string, Promise<unknown>>()

  const forRoot = async <T>(root: string, work: () => Promise<T>): Promise<T> => {
    const operation = (rootQueue.get(root) ?? Promise.resolve()).then(work)
    const tail = operation.catch(() => {})
    rootQueue.set(root, tail)
    try { return await operation }
    finally { if (rootQueue.get(root) === tail) rootQueue.delete(root) }
  }

  const adopt = (root: string) => {
    const previous = owners.get(root)
    if (previous) claims.delete(previous)
    owners.delete(root)
  }

  const create = async (raw: unknown, operationId: string): Promise<VaultCreated> => {
    const args = raw as Record<string, unknown> | null
    const name = vaultDirName(args?.name)
    if (!name || (args?.existing !== 'reuse' && args?.existing !== 'refuse')) throw new Error('invalid-name')
    if (args.parent !== undefined && !absolute(args.parent)) throw new Error('parent-missing')
    // Check the registry before touching disk, then read it again for the actual registration.
    await withVaultRegistry(async () => {})
    if (args.parent === undefined) await fs.mkdir(defaultWorkspaceDir(), { recursive: true })
    const base = args.parent === undefined ? await ensureDefaultParent() : await fs.realpath(args.parent as string)
    if (!(await fs.stat(base)).isDirectory()) throw new Error('parent-missing')
    const root = path.join(base, name)
    if (!contains(base, root) || isManagedCloudVault(root)) throw new Error('invalid-name')

    return forRoot(root, async () => {
      let created = false
      try { await fs.mkdir(root); created = true } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || args.existing !== 'reuse') throw e
      }
      const identity = await fs.lstat(root)
      if (!identity.isDirectory() || await fs.realpath(root) !== root) throw new Error('vault-folder-unavailable')
      return withVaultRegistry(async (cfg, save) => {
        const vaults = vaultList(normalizeLocal(cfg, isManagedCloudVault))
        const registered = !vaults.some((v) => samePath(v.root, root))
        if (registered) await save([...vaults, { root }])
        const result = { root, created, registered, operationId }
        // A successful second request, including a reuse, adopts this path.
        adopt(root)
        if (created || registered) {
          owners.set(root, operationId)
          claims.set(operationId, { ...result, identity })
        }
        return result
      })
    })
  }

  const rollback = async (operationId: string): Promise<VaultRollbackResult> => {
    const claim = claims.get(operationId)
    if (!claim) return 'kept_adopted'
    const { root, identity, created, registered } = claim
    return forRoot(root, async () => {
      if (owners.get(root) !== operationId) return 'kept_adopted'
      let empty = false
      try {
        const stat = await fs.lstat(root)
        if (!stat.isDirectory() || !sameFile(stat, identity) || await fs.realpath(root) !== root) return 'kept_adopted'
        if (created) empty = (await fs.readdir(root)).length === 0
      } catch { return 'kept_unreadable' }
      if (created && !empty) return 'kept_not_empty'

      return withVaultRegistry(async (cfg, save) => {
        if (owners.get(root) !== operationId) return 'kept_adopted'
        const local = normalizeLocal(cfg, isManagedCloudVault)
        if (samePath(root, local.localVault) || samePath(root, syncVaultRoot(local))) return 'kept_in_use'
        const entry = cfg.vaults?.find((v) => samePath(v.root, root))
        if (registered && (!entry || Object.keys(entry).some((key) => key !== 'root'))) return 'kept_adopted'
        if (created) {
          try {
            if (!sameFile(await fs.lstat(root), identity)) return 'kept_adopted'
            await fs.rmdir(root)
          } catch { return 'kept_remove_failed' }
        }
        owners.delete(root)
        claims.delete(operationId)
        if (!registered) return 'removed_still_listed'
        try { await save(cfg.vaults!.filter((v) => !samePath(v.root, root))) }
        catch { return created ? 'removed_still_listed' : 'kept_remove_failed' }
        return created ? 'removed' : 'unregistered'
      })
    })
  }

  const hashes = async (root: unknown, paths: unknown): Promise<string[]> => {
    if (!absolute(root) || !Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && p && !path.isAbsolute(p) && !/[\\:\0]/.test(p))) throw new Error('vault-file-unavailable')
    const registered = await withVaultRegistry(async (cfg) => cfg.vaults?.find((v) => samePath(v.root, root))?.root)
    if (!registered || isManagedCloudVault(registered)) throw new Error('vault-not-listed')
    const base = await fs.realpath(registered)
    const digests: string[] = []
    for (const rel of paths) {
      const requested = path.resolve(base, rel)
      if (!contains(base, requested)) throw new Error('vault-file-unavailable')
      const file = await fs.realpath(requested)
      if (!contains(base, file)) throw new Error('vault-file-unavailable')
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || await fs.realpath(file) !== file || !sameFile(stat, await fs.stat(file))) throw new Error('vault-file-unavailable')
        const hash = createHash('sha256')
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
        digests.push(hash.digest('hex'))
      } finally { await handle.close() }
    }
    return digests
  }

  return { create, rollback, hashes, adopt }
}

const liveTop = (e: IpcMainInvokeEvent, win: BrowserWindow | null): boolean =>
  !!win && !win.isDestroyed() && e.sender === win.webContents && !e.sender.isDestroyed() && !!e.senderFrame && e.senderFrame === e.sender.mainFrame

export function registerVaultCreateIpc(ipc: IpcMain, main: () => BrowserWindow | null, settings: () => BrowserWindow | null) {
  const host = createVaultRegistryHost()
  type Entry = {
    origin: IpcMainInvokeEvent['senderFrame']
    request: VaultFolderRequest
    status: VaultFolderStatus
    queuedUntil: number | null
  }
  const journal = new Map<string, Entry>()
  const requestId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id)

  const run = async (request: VaultFolderRequest, id: string): Promise<unknown> => {
    switch (request.kind) {
      case 'parent': return defaultLocation()
      case 'ensureParent': return ensureDefaultParent()
      case 'create': return host.create(request.args, id)
      case 'rollback':
        if (!requestId(request.operationId)) throw new Error('forbidden')
        return host.rollback(request.operationId)
      case 'movePin': {
        const { root, check } = request
        if (!absolute(root) || (check !== undefined && (check?.checkOnly !== true || (check.nextRoot !== undefined && !absolute(check.nextRoot))))) throw new Error('forbidden')
        return moveSyncVaultPin(root, check)
      }
      default: throw new Error('forbidden')
    }
  }
  const start = (entry: Entry, id: string) => {
    entry.queuedUntil = null
    void run(entry.request, id).then(
      (value) => { entry.status = { state: 'ok', value } },
      (e: Error) => { entry.status = { state: 'failed', error: e.message } },
    )
  }
  const status = (entry: Entry): VaultFolderStatus => {
    if (entry.queuedUntil !== null && Date.now() >= entry.queuedUntil) {
      entry.queuedUntil = null
      entry.status = { state: 'failed', error: 'vault-host-unavailable' }
    }
    return entry.status
  }

  ipc.handle(ch.hashes, (e, root, paths) => {
    if (!liveTop(e, main())) throw new Error('forbidden')
    return host.hashes(root, paths)
  })
  ipc.handle(ch.request, (e, id: unknown, request: VaultFolderRequest) => {
    const win = main()
    const direct = liveTop(e, win)
    if (!requestId(id) || !win || win.isDestroyed() || (!direct && !liveTop(e, settings()))
      || !request || !['parent', 'ensureParent', 'create', 'rollback', 'movePin'].includes(request.kind)
      || (!direct && request.kind === 'movePin')) throw new Error('forbidden')
    const previous = journal.get(id)
    if (previous) {
      if (previous.origin !== e.senderFrame) throw new Error('forbidden')
      return status(previous)
    }
    if (request.kind === 'rollback' && journal.get(request.operationId)?.origin !== e.senderFrame) throw new Error('forbidden')
    const entry: Entry = { origin: e.senderFrame, request, status: { state: 'pending' }, queuedUntil: direct ? null : Date.now() + 15_000 }
    journal.set(id, entry)
    if (direct) start(entry, id)
    else win.webContents.send(ch.relay, id)
    return entry.status
  })
  ipc.handle(ch.accept, (e, id: unknown) => {
    if (!requestId(id) || !liveTop(e, main())) throw new Error('forbidden')
    const entry = journal.get(id)
    if (!entry || status(entry).state !== 'pending' || entry.queuedUntil === null) return
    if (settings()?.webContents.mainFrame !== entry.origin) {
      entry.queuedUntil = null
      entry.status = { state: 'failed', error: 'vault-host-unavailable' }
      return
    }
    start(entry, id)
  })
  ipc.handle(ch.status, (e, id: unknown) => {
    if (!requestId(id) || (!liveTop(e, main()) && !liveTop(e, settings()))) throw new Error('forbidden')
    const entry = journal.get(id)
    if (!entry || entry.origin !== e.senderFrame) throw new Error('forbidden')
    return status(entry)
  })
  return host.adopt
}
