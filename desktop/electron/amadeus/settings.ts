// Local vault preferences belong to this device. Cloud bindings belong to one
// stable Forsion account at one cloud origin, independent of token renewal.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { app } from 'electron'
import { isDevMode } from '../forsionHome'
import { loadTanguCreds } from '../forsionAuth'
import { forsionAccountId } from '../../shared/forsionAccount'

export interface AmadeusCloudSyncConfig {
  enabled?: boolean
  vaultId?: string
  deviceId?: string
}

interface CloudAccountConfig {
  cloudSync?: AmadeusCloudSyncConfig
  entrySync?: import('./sync/entryRegistry').EntrySyncVault[]
}

export interface AmadeusConfig extends CloudAccountConfig {
  /** Local paths stay device scoped, even when signed out. */
  lastVault?: string
  localVault?: string
  lastPage?: string
  /** Read snapshot owner; pass it back on asynchronous cloud config writes. */
  cloudAccountId?: string | null
}

interface StoredConfig extends Omit<AmadeusConfig, 'cloudAccountId'> {
  cloudAccounts?: Record<string, CloudAccountConfig>
  /** Pre-account-scoping state has no reliable owner. Keep it for recovery,
   * never silently enroll these notes into whichever account signs in next. */
  legacyCloudState?: CloudAccountConfig
}

let cache: StoredConfig | null = null
let loading: Promise<StoredConfig> | null = null
let writes: Promise<void> = Promise.resolve()

export function currentCloudAccountId(): string | null {
  const creds = loadTanguCreds()
  return forsionAccountId(creds.cloudUrl ?? '', creds.token ?? '')
}

/** Safe, non-identifying directory/file suffix (no username, origin or token). */
export function cloudAccountNamespace(accountId: string | null = currentCloudAccountId()): string {
  return accountId ? createHash('sha256').update(accountId).digest('hex') : 'signed-out'
}

function configFile(): string {
  return path.join(app.getPath('userData'), isDevMode() ? 'amadeus-config.dev.json' : 'amadeus-config.json')
}

export function amadeusConfigPath(): string { return configFile() }

async function storedConfig(): Promise<StoredConfig> {
  if (cache) return cache
  if (!loading) loading = (async () => {
    let stored: StoredConfig
    try { stored = JSON.parse(await fs.readFile(configFile(), 'utf8')) as StoredConfig } catch { stored = {} }
    // Quarantine unknown-owner legacy bindings. Their files and old shadow files
    // are deliberately left intact; no automatic upload/delete is authorized.
    if (stored.cloudSync || stored.entrySync) {
      stored.legacyCloudState ??= { cloudSync: stored.cloudSync, entrySync: stored.entrySync }
      delete stored.cloudSync
      delete stored.entrySync
    }
    cache = stored
    return stored
  })()
  return loading
}

export async function readConfig(accountId = currentCloudAccountId()): Promise<AmadeusConfig> {
  const stored = await storedConfig()
  const own = accountId ? stored.cloudAccounts?.[cloudAccountNamespace(accountId)] : undefined
  // Callers mutate entries while preparing changes. A snapshot prevents old
  // asynchronous work from modifying the persisted owner map behind our back.
  return structuredClone({
    lastVault: stored.lastVault, localVault: stored.localVault, lastPage: stored.lastPage,
    cloudSync: own?.cloudSync, entrySync: own?.entrySync ?? [], cloudAccountId: accountId,
  })
}

async function persistConfig(snapshot: Partial<AmadeusConfig>, accountId: string | null): Promise<void> {
  const stored = await storedConfig()
  const { cloudSync, entrySync, cloudAccountId: _owner, ...local } = snapshot
  const next = { ...stored, ...local }
  if (accountId && ('cloudSync' in snapshot || 'entrySync' in snapshot)) {
    const key = cloudAccountNamespace(accountId)
    next.cloudAccounts = { ...stored.cloudAccounts, [key]: {
      ...stored.cloudAccounts?.[key],
      ...('cloudSync' in snapshot ? { cloudSync: { ...stored.cloudAccounts?.[key]?.cloudSync, ...cloudSync } } : {}),
      ...('entrySync' in snapshot ? { entrySync } : {}),
    } }
  }
  const file = configFile()
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
  await fs.rename(tmp, file)
  cache = next
}

export function writeConfig(patch: Partial<AmadeusConfig>, accountId = currentCloudAccountId()): Promise<void> {
  const snapshot = structuredClone(patch)
  const work = writes.then(() => persistConfig(snapshot, accountId))
  writes = work.catch(() => {})
  return work
}

/** Read-modify-write in the same queue as ordinary writes. Parallel moves and
 * sync toggles must transform the latest registry, never replace a stale copy. */
export function updateConfig(
  update: (config: AmadeusConfig) => boolean | void | Promise<boolean | void>,
  accountId = currentCloudAccountId(),
): Promise<AmadeusConfig> {
  const work = writes.then(async () => {
    const config = await readConfig(accountId)
    if (await update(config) !== false) await persistConfig(config, accountId)
    return config
  })
  writes = work.then(() => {}, () => {})
  return work
}
