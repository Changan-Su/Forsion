/** Standalone host for the signed Forsion account bundle: the same `registerCloud` entry the desktop loads, without Electron.
 * Lives in the Unit main process, one bundle per process (the bundle keeps its sync environment in module state).
 * Credentials stay in <dataDir>/cloud with owner-only files and never reach the Web UI or the local engine. */
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import bundles from '../desktop/electron/builtinBundles.json'
import { createAccountCore, type ExternalCredsChange } from '../desktop/electron/accountCore'
import { loadBuiltinDesktopEntries, type CloudHost } from '../desktop/electron/cloudHost'
import type { TanguCreds } from '../desktop/electron/forsionAuth'
import { forsionAccountId } from '../desktop/shared/forsionAccount'
import { makeCallerHeaders } from '../desktop/electron/unitCaller'
import { engineCapsState, pairingWriters, type UnitHubFactory, type UnitHubInstance, type UnitPairing } from '../desktop/electron/unitHubSeam'
import type { AmadeusConfig, AmadeusSyncFactory, AmadeusSyncHostDeps, AmadeusSyncInstance } from '../desktop/electron/amadeus/cloudSeam'
import type { LocalRuntime, RuntimeVault } from './runtimeTypes'

const DEFAULT_CLOUD_URL = 'https://api.forsion.net'
const WATCH_MS = 5000

/** Pinned by the desktop's bundle list, so the signature check below is the same one the desktop runs. */
export const cloudBundle = (id: string) => bundles.find((b) => b.id === id && b.desktop)

export type JsonRead = { state: 'ok'; value: Record<string, any> | null } | { state: 'unknown' }
/** A file that exists but cannot be read is unknown, not empty: callers must not write over it. */
export function readJson(file: string): JsonRead {
  let text: string
  try { text = readFileSync(file, 'utf8') }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'ok', value: null } : { state: 'unknown' } }
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? { state: 'ok', value } : { state: 'unknown' }
  } catch { return { state: 'unknown' } }
}
export function writePrivateJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, file)
}
const namespace = (account: string) => createHash('sha256').update(account).digest('hex')

/** auth.json keeps the shared `tangu login` format. A read failure keeps the last good credentials and blocks every write. */
export function createCredentialStore(home: string, log: (message: string) => void) {
  const file = join(home, 'auth.json')
  let lastGood: TanguCreds = {}, blocked = false
  const load = (): TanguCreds => {
    const read = readJson(file)
    if (read.state === 'unknown' || (read.value && [read.value.cloudUrl, read.value.token].some((v) => v !== undefined && typeof v !== 'string'))) {
      if (!blocked) log('[unit-cloud] auth.json is unreadable; keeping it untouched until the owner repairs or removes it')
      blocked = true
      return { ...lastGood }
    }
    blocked = false
    lastGood = read.value ?? {}
    return { ...lastGood }
  }
  load()
  return {
    load,
    assertWritable: () => { load(); if (blocked) throw new Error('auth.json is unreadable. Repair or remove it, then sign in again.') },
    save: (creds: TanguCreds) => {
      load()
      if (blocked) throw new Error('auth.json is unreadable. Repair or remove it, then sign in again.')
      writePrivateJson(file, creds)
      lastGood = { ...creds }
    },
    readable: () => { load(); return !blocked },
  }
}

/** Same stored shape as the desktop: cloud bindings belong to one account, keyed by its namespace. */
export function createConfigStore(home: string, currentAccount: () => string | null) {
  const file = join(home, 'amadeus-config.json')
  let writes: Promise<unknown> = Promise.resolve()
  const stored = () => {
    const read = readJson(file)
    if (read.state === 'unknown') throw new Error('amadeus-config.json is unreadable; it was left untouched')
    return read.value ?? {}
  }
  const persist = (patch: Partial<AmadeusConfig>, account: string | null) => {
    const current = stored()
    if (!account || !('cloudSync' in patch || 'entrySync' in patch)) return
    const key = namespace(account), own = current.cloudAccounts?.[key]
    writePrivateJson(file, { ...current, cloudAccounts: { ...current.cloudAccounts, [key]: { ...own,
      ...('cloudSync' in patch ? { cloudSync: { ...own?.cloudSync, ...patch.cloudSync } } : {}),
      ...('entrySync' in patch ? { entrySync: patch.entrySync } : {}) } } })
  }
  const read = async (account = currentAccount()): Promise<AmadeusConfig> => {
    const own = account ? stored().cloudAccounts?.[namespace(account)] : undefined
    return structuredClone({ cloudSync: own?.cloudSync, entrySync: own?.entrySync ?? [], cloudAccountId: account })
  }
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const job = writes.then(work, work)
    writes = job.catch(() => {})
    return job
  }
  return {
    read,
    write: (patch: Partial<AmadeusConfig>, account = currentAccount()) => { const copy = structuredClone(patch); return enqueue(async () => persist(copy, account)) },
    update: (change: (config: AmadeusConfig) => boolean | void | Promise<boolean | void>, account = currentAccount()) => enqueue(async () => {
      const config = await read(account)
      if (await change(config) !== false) persist(config, account)
      return config
    }),
  }
}

/** The Unit's one vault is the cloud mirror of exactly one account, or of none.
 * It binds on the first sign-in only when that cannot publish existing notes, or when the owner opted in.
 * Any other account syncs into its own private mirror, so one account's notes never reach another's cloud. */
export function boundVaultRoot(file: string, root: string, account: string, syncVault: boolean): boolean {
  const saved = readJson(file)
  if (saved.state === 'unknown') return false
  if (saved.value) return saved.value.account === account
  if (!syncVault && readdirSync(root).some((name) => !name.startsWith('.'))) return false
  writePrivateJson(file, { account })
  return true
}

const addressPrint = () => JSON.stringify(Object.values(networkInterfaces()).flat().filter((a) => a && !a.internal).map((a) => a!.address).sort())
/** Timers stop while a process is frozen or the machine sleeps, so a late tick means the process was resumed. */
export function watchResume(wake: (reason: string) => void, intervalMs = WATCH_MS, addresses = addressPrint): () => void {
  let last = Date.now(), print = addresses()
  const timer = setInterval(() => {
    const now = Date.now(), late = now - last > intervalMs * 3, next = addresses(), changed = next !== print
    last = now; print = next
    if (late || changed) wake(late ? 'resume' : 'network')
  }, intervalMs)
  timer.unref()
  const onContinue = () => { last = Date.now(); wake('resume') }
  process.on('SIGCONT', onContinue)
  return () => { clearInterval(timer); process.off('SIGCONT', onContinue) }
}

export interface CloudRuntimeOptions {
  packageDir: string
  dataDir: string
  workspaceDir: string
  version: string
  relay: boolean
  syncVault: boolean
  vault: () => RuntimeVault | null
  engine: () => { status(): unknown } | undefined
  web: () => { url: string; internalSecret: string; proxyCallerKey: string } | null
  log: (message: string) => void
}
export interface AccountControl {
  login(cloudUrl?: string): Promise<unknown>
  logout(): Promise<unknown>
  status(): Promise<unknown>
}

export async function createCloudRuntime(o: CloudRuntimeOptions, bundle = cloudBundle('forsion-extend')): Promise<LocalRuntime> {
  if (!bundle) throw new Error('This Unit has no pinned cloud account bundle')
  const home = resolve(o.dataDir, 'cloud')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const log = o.log
  const creds = createCredentialStore(home, log)
  const accountId = () => { const c = creds.load(); return forsionAccountId(c.cloudUrl || '', c.token || '') }
  const config = createConfigStore(home, accountId)
  const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>()
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`Cloud channel is unavailable: ${channel}`)
    return handler({ sender: { id: 0 } }, ...args)
  }

  let amadeus: AmadeusSyncInstance | null = null, syncFactory: AmadeusSyncFactory | null = null
  let hub: UnitHubInstance | null = null, hubFactory: UnitHubFactory | null = null
  let pairing: UnitPairing | null = null, closed = false
  let activeVault: RuntimeVault | null = null, syncStatus: unknown = null
  let hooks: Parameters<AmadeusSyncHostDeps['setMutationHooks']> | null = null
  let device: { url: string; userCode: string } | null = null, onDevice: (() => void) | null = null
  let refresher: ReturnType<typeof setInterval> | null = null

  const pairingFile = join(home, 'unit-pairing.json')
  const refreshHub = () => {
    hub?.stop(); hub = null
    const account = accountId()
    if (!o.relay || !hubFactory || !account || closed) return
    const key = namespace(account), read = readJson(pairingFile)
    // A new registration would drop the trust other devices hold for this Unit, so unreadable never means "register again".
    if (read.state === 'unknown') { log('[unit-cloud] unit-pairing.json is unreadable; the relay stays off until the owner repairs it'); return }
    pairing = read.value?.[key] ?? null
    const created: UnitHubInstance = hubFactory({
      getCreds: () => { const c = creds.load(); return { cloudUrl: c.cloudUrl || '', token: c.token || '' } },
      getUnitWeb: () => { const web = o.web(); return { url: web?.url ?? null, internalSecret: web?.internalSecret ?? '' } },
      callerHeaders: makeCallerHeaders(() => o.web()?.proxyCallerKey ?? '', log),
      // ponytail: no LAN address on the roster; a Unit reached over the LAN is already addressed by its owner.
      getLanUrl: () => null,
      getPairing: () => pairing,
      ...pairingWriters(() => hub === created, async (next) => {
        const latest = readJson(pairingFile)
        if (latest.state === 'unknown') throw new Error('unit-pairing.json is unreadable; it was left untouched')
        const { [key]: _old, ...rest } = latest.value ?? {}
        writePrivateJson(pairingFile, next ? { ...rest, [key]: next } : rest)
        pairing = next
      }),
      engineCaps: () => engineCapsState({ agentBackend: !!o.engine(), backend: ((o.engine()?.status() as { state?: 'stopped' | 'starting' | 'ready' | 'crashed' })?.state) ?? 'stopped', seeded: true }),
      log,
    })
    hub = created
    created.start()
  }

  const stopSync = () => amadeus?.stopAllSync()
  const restartSync = () => (o.vault() ? amadeus?.restartAllSync() : undefined)
  const accounts = createAccountCore({
    loadCreds: creds.load, saveCreds: creds.save, saveConfig: async () => undefined, loadConfig: async () => ({}), ensureBackend: async () => {},
    refreshUnitHost: refreshHub, renderers: () => [], events: { on() {}, removeListener() {} },
    broadcast: () => {}, stopSync, restartSync, log,
  })

  const vaultMarker = join(home, 'vault-account.json')
  // One answer per account for the life of the process: a running engine's root must not change under it.
  const bindings = new Map<string, boolean>()
  const cloudVaultDir = (account: string | null = accountId()) => {
    const vault = o.vault()?.root()
    if (vault && account && !bindings.has(account)) bindings.set(account, boundVaultRoot(vaultMarker, vault, account, o.syncVault))
    return vault && account && bindings.get(account) ? vault : join(home, 'Amadeus Accounts', account ? namespace(account) : 'signed-out', 'Cloud')
  }
  const syncDeps: AmadeusSyncHostDeps = {
    readCreds: () => { const c = creds.load(); return { cloudUrl: c.cloudUrl || '', token: c.token || '' } },
    accountId, homeDir: () => home, workspaceDir: () => o.workspaceDir, userDataDir: () => home, isDevMode: () => false,
    readConfig: config.read, writeConfig: config.write, updateConfig: config.update,
    adoptLegacyCloudState: async () => false,
    cloudVaultDir, isManagedCloudVault: () => false,
    vaultRoot: () => o.vault()?.root() ?? null,
    setMutationHooks: (...next) => { hooks = next; activeVault?.setMutationHooks(...next) },
    // Switching between sides is a desktop gesture; a Unit has one vault.
    activateRoot: async (root) => ({ root, pages: [], folders: [] }),
    ensureDefaultVault: async () => ({ root: cloudVaultDir(), pages: [], folders: [] }),
    bindRenderer() {}, relatedClosure: async () => null,
    awaitPendingVaultWrites: async () => { await o.vault()?.settled() },
    notifyAll: (channel, payload) => { if (channel === 'amadeus:sync:status') syncStatus = payload },
    onBeforeQuit: () => () => {},
    log,
  }

  const lockedVault = () => {
    const vault = o.vault()
    if (!vault) throw new Error('The vault is not available')
    return vault
  }
  const host = {
    log, handle: (channel: string, fn: (event: unknown, ...args: any[]) => unknown) => { handlers.set(channel, fn) },
    // Handlers are reachable only through the owner's control socket, never from a page.
    isTrustedSender: () => true,
    openExternal: async () => {},
    getCloud: async () => { const c = creds.load(); return { base: (c.cloudUrl || DEFAULT_CLOUD_URL).replace(/\/+$/, ''), token: closed ? '' : c.token || '' } },
    readCreds: () => { const c = creds.load(); return closed ? { cloudUrl: '', token: '' } : { cloudUrl: c.cloudUrl || '', token: c.token || '' } },
    accountId: () => (closed ? null : accountId()),
    homeDir: () => home, appVersion: () => o.version,
    broadcast: (channel: string, payload: unknown) => {
      if (channel !== 'auth:device') return
      device = payload as { url: string; userCode: string }
      onDevice?.()
    },
    accountBackendState: async () => null,
    accountTransition: accounts.transition,
    accountCommit: async (next: { cloudUrl: string; token: string }, assertCurrent?: () => void, onCommitPoint?: () => void) => { creds.assertWritable(); await accounts.commit(next, assertCurrent, onCommitPoint) },
    accountClear: async (assertCurrent?: () => void, onCommitPoint?: () => void) => { creds.assertWritable(); await accounts.clear(assertCurrent, onCommitPoint) },
    writeCreds: accounts.writeCreds,
    onExternalCredsChange: (cb: (change: ExternalCredsChange) => void) => accounts.onExternalChange(cb),
    setTokenRefresher: accounts.setRefresher,
    setAmadeusSyncFactory: (factory: AmadeusSyncFactory) => { syncFactory = factory },
    setUnitHubFactory: (factory: UnitHubFactory) => { hubFactory = factory },
    diagnosticLogs: () => ({ engine: { state: null, lastError: null, lines: [] } }),
    contentSync: {
      // ponytail: the shared lock is what cloud downloads need. Folder-level content sync stays desktop-only until a Unit has a page to configure it.
      roots: async () => [], claim: async () => { throw new Error('Content sync is not available on this host') },
      changed: async () => {}, merge: () => null, trash: async () => {},
      withWriteLock: (path: string | string[], commit: () => void) => lockedVault().withWriteLock(path, commit),
    },
  } as unknown as CloudHost

  const loaded = await loadBuiltinDesktopEntries({ pluginsRoot: join(home, 'plugins'), sources: [{ ...bundle, dir: o.packageDir }] as never,
    appVersion: o.version, host, tempRoot: home, log })
  if (!loaded.includes(bundle.id)) throw new Error('The cloud account bundle failed to load')

  // Later ticks only slide the token; the desktop's order applies: refresh before anything opens a connection.
  await accounts.refresh(4000).catch(() => {})
  refresher = setInterval(() => { void accounts.refresh().catch(() => {}) }, 24 * 3600_000)
  refresher.unref()
  refreshHub()
  const stopWatching = watchResume((reason) => {
    hub?.reconnect(reason)
    // The note event stream has no read watchdog, so a half-open connection would stay silent. A restart reopens it and reconciles.
    void accounts.transition(async () => { await restartSync() }).catch((error) => log(`[unit-cloud] sync restart failed: ${error instanceof Error ? error.message : error}`))
  })

  return {
    account: {
      login: async (cloudUrl) => {
        creds.assertWritable()
        device = null
        let failure: string | null = null, finished = false
        const started = new Promise<void>((done) => { onDevice = done })
        const flow = invoke('auth:forsionLogin', cloudUrl).catch((error) => { failure = error instanceof Error ? error.message : 'Sign-in failed' }).finally(() => { finished = true; onDevice?.() })
        void flow
        await started
        if (failure) throw new Error(failure)
        if (!device && finished) return { signedIn: true }
        return device
      },
      logout: () => invoke('auth:logout'),
      status: async () => {
        const status = await invoke('auth:status') as Record<string, unknown>
        return { ...status, credentials: creds.readable() ? 'ok' : 'unreadable', sync: syncStatus, relay: hub?.status() ?? null, vaultBound: !!accountId() && cloudVaultDir() === o.vault()?.root() }
      },
    } satisfies AccountControl,
    setPackages: async () => {
      hub?.engineChanged()
      const vault = o.vault()
      if (vault === activeVault || closed) return
      activeVault = vault
      if (!vault) { await stopSync(); return }
      if (hooks) vault.setMutationHooks(...hooks)
      if (amadeus) await restartSync()
      else if (syncFactory) { amadeus = syncFactory(syncDeps); amadeus.start() }
    },
    close: async () => {
      closed = true
      stopWatching()
      if (refresher) clearInterval(refresher)
      hub?.stop(); hub = null
      await stopSync()
    },
  }
}
