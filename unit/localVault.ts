/** Local Amadeus capability shipped by its plugin. This module has no Electron,
 * Forsion Account or Server dependency; Unit authenticates the owner at transport level.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { IPC } from '@amadeus-shared/ipc'
import { seedCalendarDb, serializeDb } from '@amadeus-shared/db/schema'
import { isSafePluginExt } from '@amadeus-shared/pluginFiles'
import { VaultManager } from '../desktop/electron/amadeus/fs/vaultManager'
import { VaultIndex } from '../desktop/electron/amadeus/fs/vaultIndex'
import { VaultWatcher } from '../desktop/electron/amadeus/fs/watcher'
import { registerVaultHandlers, VAULT_WRITE_EVENTS, type VaultFace } from '../desktop/electron/amadeus/fs/vaultHandlers'
import { fetchLinkMeta, searchImages } from '../desktop/electron/amadeus/linkMeta'

export interface LocalVaultOptions {
  root: string
  /** Private plugin state, outside the files exposed through the vault API. */
  stateDir: string
  pluginFileExtensions?: string[]
  locale?: 'zh' | 'en'
  log?: (message: string) => void
}

export interface LocalVault extends VaultFace {
  setPluginFileExtensions(extensions: string[]): Promise<void>
  close(): Promise<void>
}

export async function createLocalVault(options: LocalVaultOptions): Promise<LocalVault> {
  await fs.mkdir(options.root, { recursive: true, mode: 0o700 })
  await fs.mkdir(options.stateDir, { recursive: true, mode: 0o700 })
  const root = await fs.realpath(options.root)
  const stateDir = await fs.realpath(options.stateDir)
  if (stateDir === root || stateDir.startsWith(root + path.sep)) throw new Error('Local vault state must be outside its exposed workspace')
  const vault = new VaultManager({ strictPaths: true })
  vault.setRoot(root)
  const state = new VaultManager({ strictPaths: true })
  state.setRoot(stateDir)
  const index = new VaultIndex(vault)
  const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>()
  const subscribers = new Set<(channel: string, payload: unknown, origin: string | null) => void>()
  let closed = false
  let queue: Promise<unknown> = Promise.resolve()
  let lastPage: string | undefined
  let structureTimer: ReturnType<typeof setTimeout> | null = null
  let extensions: string[] = []

  const emit = (channel: string, payload?: unknown, origin: string | null = null): void => {
    if (closed) return
    for (const subscriber of [...subscribers]) {
      try { subscriber(channel, payload, origin) } catch { /* Consumers own their failures. */ }
    }
  }
  // Serialize the complete operation including its index refresh and notifications.
  // Database CAS additionally retains the desktop/engine cross-process file lock.
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error('Local vault is closed'))
    const result = queue.then(operation)
    queue = result.catch(() => {})
    return result
  }
  const report = (error: unknown): void => options.log?.(`[amadeus] ${error instanceof Error ? error.message : String(error)}`)
  const readState = async (file: string): Promise<string | null> => {
    try { return await fs.readFile(state.absPath(file), 'utf8') } catch (error: any) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }
  const writeState = async (file: string, text: string): Promise<void> => {
    // Same atomic writer and strict path boundary as user documents.
    await state.writeTextFile(file, text)
    await fs.chmod(state.absPath(file), 0o600)
  }
  const setExtensions = async (requested: string[]): Promise<void> => {
    const safe = requested.filter(isSafePluginExt).map((ext) => ext.trim().toLowerCase())
    // Preserve prior declarations after an uninstall: treating a custom .md file
    // as a note would let the compiler rewrite another plugin's format.
    extensions = [...new Set([...extensions.filter(isSafePluginExt).map((ext) => ext.trim().toLowerCase()), ...safe])].sort()
    vault.setPluginFileExtensions(extensions)
    await writeState('file-extensions.json', JSON.stringify(extensions))
  }
  try {
    const saved = JSON.parse(await readState('last-page.json') ?? 'null')
    if (typeof saved === 'string' && await vault.pathExists(saved)) lastPage = saved
  } catch { /* Missing or invalid resume state never prevents opening local files. */ }
  try {
    const saved = JSON.parse(await readState('file-extensions.json') ?? '[]')
    if (Array.isArray(saved)) extensions = saved.filter((item): item is string => typeof item === 'string')
  } catch { /* Rebuild from current packages. */ }
  await setExtensions(options.pluginFileExtensions ?? [])

  if (!await vault.pathExists('Calendar.db')) {
    const calendar = seedCalendarDb()
    const labels = options.locale === 'zh' ? ['我的日历', '名称', '日期', '完成'] : ['Calendar', 'Name', 'Date', 'Done']
    calendar.name = labels[0]
    calendar.columns.forEach((column, i) => { column.name = labels[i + 1] })
    calendar.rows = []
    // Exclusive create leaves an existing calendar intact even during simultaneous starts.
    await fs.writeFile(vault.absPath('Calendar.db'), serializeDb(calendar), { flag: 'wx' }).catch((error: any) => {
      if (error?.code !== 'EEXIST') throw error
    })
  }
  await index.build()
  const handle = (channel: string, handler: (event: unknown, ...args: any[]) => unknown): void => { handlers.set(channel, handler) }
  registerVaultHandlers({
    vault, index, handle,
    rememberPage: async (page) => { await writeState('last-page.json', JSON.stringify(page)); lastPage = page },
    notifyAll: emit,
  })
  handle(IPC.restoreVault, async () => ({ root, pages: await vault.listPages(), folders: await vault.listFolders(), lastPage }))
  // Choosing another directory is an owner configuration operation, never a remote dialog.
  handle(IPC.openVault, async () => null)
  const pluginFile = (id: string): string => {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id)) throw new Error('Invalid plugin id')
    return `plugin-data/${id}.json`
  }
  handle(IPC.pluginDataRead, (_event, id: string) => readState(pluginFile(id)))
  handle(IPC.pluginDataWrite, async (_event, id: string, text: string) => {
    if (typeof text !== 'string') throw new Error('Plugin data must be text')
    await writeState(pluginFile(id), text)
  })
  handle(IPC.fetchLinkMeta, (_event, url: string) => fetchLinkMeta(url))
  handle(IPC.searchImages, (_event, query: string) => searchImages(query))

  const watcher = new VaultWatcher(vault,
    (page) => { void run(async () => { if (vault.isPagePath(page)) await index.update(page); emit(IPC.externalChange, page) }).catch(report) },
    () => {
      if (closed || structureTimer) return
      structureTimer = setTimeout(() => {
        structureTimer = null
        void run(async () => { await index.build(); emit(IPC.structureChange) }).catch(report)
      }, 80)
    },
    (db) => emit(IPC.dbChange, db),
    (file) => emit(IPC.fileChange, file),
    report,
  )
  watcher.start(root)
  try { await watcher.ready() } catch (error) { await watcher.close(); throw error }

  return {
    call: (channel, args, origin) => run(async () => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`Unknown local vault channel: ${channel}`)
      const result = await handler(null, ...args)
      const event = VAULT_WRITE_EVENTS[channel]?.(args)
      // A failed CAS did not write; it must not prompt another editor to reload.
      if (event && !(channel === IPC.dbWriteCas && (result as { ok?: boolean })?.ok === false)) emit(event[0], event[1], origin ?? null)
      return result
    }),
    root: () => closed ? null : root,
    absPath: (rel) => { if (closed) throw new Error('Local vault is closed'); return vault.absPath(rel) },
    assetAbs: async (page, ref) => closed ? null : vault.resolveAttachment(page ?? '', ref),
    onEvent: (subscriber) => { if (!closed) subscribers.add(subscriber); return () => { subscribers.delete(subscriber) } },
    setPluginFileExtensions: (requested) => run(async () => { await setExtensions(requested); await index.build(); emit(IPC.structureChange) }),
    close: async () => {
      if (closed) return
      closed = true
      if (structureTimer) clearTimeout(structureTimer)
      structureTimer = null
      await watcher.close()
      await queue
      subscribers.clear()
    },
  }
}
