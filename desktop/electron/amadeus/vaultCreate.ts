import path from 'node:path'
import { promises as fs, constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { VAULT_CREATE_IPC as ch, vaultDirName } from '../../shared/amadeus/vaultCreate'
import { defaultWorkspaceDir } from '../forsionHome'
import { isManagedCloudVault } from './cloudPaths'
import { moveSyncVaultPin, withVaultRegistry } from './settings'
import { samePath, normalizeLocal, syncVaultRoot } from './vaultList'

const defaultParent = (): string => path.join(defaultWorkspaceDir(), 'Vaults')
const absolute = (v: unknown): v is string => typeof v === 'string' && path.isAbsolute(v) && !v.includes('\0')
const contains = (root: string, file: string): boolean => {
  const rel = path.relative(root, file)
  return !!rel && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)
}
const sameFile = (a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean => a.dev === b.dev && a.ino === b.ino

export function createVaultRegistryHost() {
  const createdHere = new Map<string, { dev: number; ino: number }>()

  const create = async (raw: unknown) => {
    const args = raw as Record<string, unknown> | null
    const name = vaultDirName(args?.name)
    if (!name || (args?.existing !== 'reuse' && args?.existing !== 'refuse')) throw new Error('invalid-name')
    const parent = args.parent === undefined ? defaultParent() : args.parent
    if (!absolute(parent)) throw new Error('parent-missing')
    return withVaultRegistry(async (cfg, save) => {
      if (args.parent === undefined) await fs.mkdir(parent, { recursive: true })
      const base = await fs.realpath(parent)
      if (!(await fs.stat(base)).isDirectory()) throw new Error('parent-missing')
      const root = path.join(base, name)
      if (!contains(base, root) || isManagedCloudVault(root)) throw new Error('invalid-name')

      let created = false
      try { await fs.mkdir(root); created = true } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || args.existing !== 'reuse') throw e
      }
      const stat = await fs.lstat(root)
      if (!stat.isDirectory() || await fs.realpath(root) !== root) throw new Error('vault-folder-unavailable')
      try {
        if (!cfg.vaults?.some((v) => samePath(v.root, root))) await save([...(cfg.vaults ?? []), { root }])
      } catch (e) {
        if (created && await fs.lstat(root).then((now) => sameFile(stat, now), () => false)) await fs.rmdir(root).catch(() => {})
        throw e
      }
      if (created) createdHere.set(root, { dev: stat.dev, ino: stat.ino })
      return { root, created }
    })
  }

  const empty = async (root: unknown): Promise<boolean | null> => {
    if (!absolute(root) || !createdHere.has(root)) return null
    try {
      const s = await fs.lstat(root)
      if (!s.isDirectory() || !sameFile(s, createdHere.get(root)!) || await fs.realpath(root) !== root) return null
      return (await fs.readdir(root)).length === 0
    } catch { return null }
  }

  const remove = async (root: unknown): Promise<void> => {
    if (!absolute(root)) throw new Error('vault-folder-unavailable')
    await withVaultRegistry(async (cfg) => {
      const local = normalizeLocal(cfg, isManagedCloudVault)
      if (samePath(root, local.localVault) || samePath(root, syncVaultRoot(local))
        || !cfg.vaults?.some((v) => samePath(root, v.root)) || await empty(root) !== true) throw new Error('vault-folder-unavailable')
      await fs.rmdir(root)
      createdHere.delete(root)
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

  return { create, empty, remove, hashes }
}

const liveTop = (e: IpcMainInvokeEvent, win: BrowserWindow | null): boolean =>
  !!win && !win.isDestroyed() && e.sender === win.webContents && !e.sender.isDestroyed() && !!e.senderFrame && e.senderFrame === e.sender.mainFrame

export function registerVaultCreateIpc(ipc: IpcMain, main: () => BrowserWindow | null, settings: () => BrowserWindow | null): void {
  const host = createVaultRegistryHost()
  const ops = {
    [ch.parent]: () => defaultParent(),
    [ch.create]: host.create,
    [ch.empty]: host.empty,
    [ch.remove]: host.remove,
  }
  for (const [channel, run] of Object.entries(ops)) {
    ipc.handle(channel, (e, arg) => { if (!liveTop(e, main())) throw new Error('forbidden'); return run(arg) })
  }
  ipc.handle(ch.hashes, (e, root, paths) => {
    if (!liveTop(e, main())) throw new Error('forbidden')
    return host.hashes(root, paths)
  })
  ipc.handle(ch.movePin, (e, root) => {
    if (!liveTop(e, main()) || !absolute(root)) throw new Error('forbidden')
    return moveSyncVaultPin(root)
  })

  // The settings dialog can use the same folder operation, mediated by the live main-window preload.
  // Hashing and moving the pin have no settings relay.
  const pending = new Map<string, { win: BrowserWindow; resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  ipc.handle(ch.settingsRequest, async (e, op: string, arg: unknown) => {
    const win = main()
    if (!liveTop(e, settings()) || !win || win.isDestroyed() || !Object.hasOwn(ops, op)) throw new Error('forbidden')
    const id = randomUUID()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { win, resolve, reject })
        timer = setTimeout(() => reject(new Error('vault-host-unavailable')), 15_000)
        win.webContents.send(ch.settingsRelay, id, op, arg)
      })
    } finally { clearTimeout(timer); pending.delete(id) }
  })
  ipc.handle(ch.settingsResult, (e, id: string, ok: boolean, result: unknown) => {
    const request = pending.get(id)
    if (!request || !liveTop(e, request.win) || request.win !== main()) return
    if (ok === true) request.resolve(result)
    else request.reject(new Error(typeof result === 'string' ? result : 'vault-host-unavailable'))
  })
}
