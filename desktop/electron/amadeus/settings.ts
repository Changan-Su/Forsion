// Local vault preferences belong to this device. Cloud bindings belong to one
// stable Forsion account at one cloud origin, independent of token renewal.
import { promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { app } from 'electron'
import { isDevMode } from '../forsionHome'
import { loadTanguCreds } from '../forsionAuth'
import { forsionAccountId } from '../../shared/forsionAccount'
import type { OnlineVaultRef } from '@amadeus-shared/ipc'
import { samePath } from './vaultList'

export type { OnlineVaultRef }

export interface AmadeusCloudSyncConfig {
  enabled?: boolean
  vaultId?: string
  deviceId?: string
  /** false = 只停镜像(H3 定稿第 1 节,认领里 mirrorRetired 时由遮罩加上)。只出现在递给旧引擎的遮罩读数里:
   *  宿主从不把它写进盘上的 cloudSync(persistConfig 剔掉),readConfig 也不从盘上带出来。 */
  mirror?: boolean
}

/** 按条目云同步的注册表项(与 Extend 的 entryRegistry.EntrySyncVault 同形;引擎住在 Extend,宿主只负责落盘)。 */
export interface EntrySyncVault {
  vaultRoot: string
  cloudName: string
  entries: import('@amadeus-shared/entrySync').EntrySyncEntry[]
  exclude?: string[]
}
interface CloudAccountConfig {
  cloudSync?: AmadeusCloudSyncConfig
  entrySync?: EntrySyncVault[]
  /** 智库同步第 2 步(契约 §3.7):按库根的认领。只经 readSyncOwnershipV2 / writeSyncOwnershipV2 读写,readConfig 不带它。 */
  syncOwnershipV2?: SyncOwnershipV2
}

/** 谁管哪几个本机库根的落盘同步(契约 §3.7)。entryRoots 存规整过的根(contentSyncHost.canonRoot)。 */
export interface SyncOwnershipV2 {
  entryRoots: string[]
  mirror: 'keep' | 'off'
  human: 'engine' | 'content'
  /** 第 3 步(H3 定稿第 1 节,宿主声明 contentSync.mirrorRetire 才认):true = 只停镜像(mirror 仍是 'keep')。盘上只存 true;
   *  set 不给 = 沿用盘上的值,false = 撤销(删键)。 */
  mirrorRetired?: boolean
}

export interface AmadeusConfig extends CloudAccountConfig {
  /** Local paths stay device scoped, even when signed out. */
  lastVault?: string
  localVault?: string
  lastPage?: string
  /** Local vaults this device has opened; syncVault = the one content sync stays bound to (see vaultList.ts). */
  vaults?: import('./vaultList').VaultEntry[]
  syncVault?: string
  /** Read snapshot owner; pass it back on asynchronous cloud config writes. */
  cloudAccountId?: string | null
}

interface StoredConfig extends Omit<AmadeusConfig, 'cloudAccountId'> {
  cloudAccounts?: Record<string, CloudAccountConfig>
  /** 智库同步第 3 步(H3):当前打开的在线库,设备级(和 lastVault 同级);没有 = 本机库。只经 readActiveVault / writeActiveVault 读写,readConfig 不带它。 */
  activeVault?: unknown
  /** Pre-account-scoping state has no reliable owner. Keep it for recovery,
   * never silently enroll these notes into whichever account signs in next. */
  legacyCloudState?: CloudAccountConfig
  legacyCloudStateExtra?: CloudAccountConfig[]
}

let cache: StoredConfig | null = null
let loading: Promise<StoredConfig> | null = null
let writes: Promise<void> = Promise.resolve()
/** 宽松读的缓存来自一次读失败(不是 ENOENT,缓存成了 {})。标着的时候每次读都重读一次盘,读得出就换上、清掉;
 *  普通写拿不到读得出的底稿就抛、不写(writeBase)。给旧引擎的遮罩用(contentSyncHost.readMaskedAmadeusConfig):读失败 ≠ 什么都没配。 */
let looseLoadFailed = false
export function looseConfigReadFailed(): boolean { return looseLoadFailed }
/** 缓存的提交代次:每次写把缓存换掉 +1。宽松读开始时记下,读完代次变了 = 途中有写提交了,丢掉自己读到的(可能是写之前的旧文件),
 *  不覆盖缓存、也不改 looseLoadFailed(Codex 12b 一轮第 2 条:迟到的旧读数会让已退役的镜像、已接手的根在下一次普通写后复活)。 */
let cacheGen = 0
/** 写把缓存换成刚落盘的那份。每个提交点都以读得出的底稿为底(严格读,或没标读失败的缓存),所以换上的是真值。 */
function commitCache(next: StoredConfig): void {
  cache = next
  cacheGen++
  looseLoadFailed = false
}

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

/** Quarantine unknown-owner legacy bindings. Their files and old shadow files
 * are deliberately left intact; no automatic upload/delete is authorized. */
function normalizeStored(stored: StoredConfig): StoredConfig {
  if ('cloudSync' in stored || 'entrySync' in stored) {
    const extras = legacyExtras(stored)
    if (!extras) return stored // 读不懂隔离区:顶层原样留着,不能覆盖或删掉任何一份
    const top: CloudAccountConfig = {
      ...('cloudSync' in stored ? { cloudSync: stored.cloudSync } : {}),
      ...('entrySync' in stored ? { entrySync: stored.entrySync } : {}),
    }
    if (!isDeepStrictEqual(stored.legacyCloudState, top) && !extras.some((extra) => isDeepStrictEqual(extra, top))) {
      if (stored.legacyCloudState == null) stored.legacyCloudState = top
      else stored.legacyCloudStateExtra = [...extras, top]
    }
    delete stored.cloudSync
    delete stored.entrySync
  }
  return stored
}

function legacyExtras(stored: StoredConfig): CloudAccountConfig[] | null {
  const extras = stored.legacyCloudStateExtra
  if (extras === undefined) return []
  return Array.isArray(extras) && extras.every((extra) => extra && typeof extra === 'object' && !Array.isArray(extra)) ? extras : null
}

/** 宽松读:读不了 / 解析不了 / 不是 JSON 对象 = 缓存成 {} 并标上 looseLoadFailed(只有 ENOENT 是真的空)。
 *  标着的时候下一次读再读一次盘(读得出就换上、清掉):文件恢复以后读和写都拿真值,不拿那份空缓存往下走。 */
async function storedConfig(): Promise<StoredConfig> {
  if (cache && !looseLoadFailed) return cache
  if (!loading) {
    const gen = cacheGen
    loading = (async () => {
      let stored: StoredConfig | null = null
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(configFile(), 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = normalizeStored(parsed as StoredConfig)
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') stored = {}
      }
      if (gen !== cacheGen) return cache! // 途中有写提交了:那一写已经换上了缓存
      if (stored) { cache = stored; looseLoadFailed = false }
      else { cache ??= {}; looseLoadFailed = true }
      return cache
    })().finally(() => { loading = null })
  }
  return loading
}

/** 普通写(writeConfig / updateConfig / 首启缺省值 / 收养)的底稿,在写队列里取(Codex 12b 一轮第 1 条):
 *  缓存可信就用缓存;宽松读失败过就重读一次盘,只有 ENOENT 当空,读不了 / 解析不了就抛、不写 ——
 *  不拿空缓存盖掉整份配置(库清单、账号配置、认领)。重读成功就换上缓存、清掉标记。 */
async function writeBase(): Promise<StoredConfig> {
  const stored = await storedConfig()
  if (looseLoadFailed) throw new Error('amadeus-config-unreadable')
  return stored
}

/** 严格读盘:没有文件 = {};读不了 / 不是 JSON 对象就抛。认领(syncOwnershipV2)只走这条:读失败 ≠ 没认领。
 *  抛固定错误码(会经 ownership 接缝到 Extend 的日志):JSON.parse 的原始报错带一截文件原文(库路径、库名),不往外带。 */
async function storedConfigStrict(): Promise<StoredConfig> {
  let raw: string
  try { raw = await fs.readFile(configFile(), 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return {}
    throw new Error('amadeus-config-unreadable')
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('amadeus-config-unparseable') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('amadeus-config-malformed')
  return normalizeStored(parsed as StoredConfig)
}

const isOwnership = (v: unknown): v is SyncOwnershipV2 => {
  const o = v as SyncOwnershipV2
  return !!o && typeof o === 'object' && Array.isArray(o.entryRoots) && o.entryRoots.every((r) => typeof r === 'string' && path.isAbsolute(r))
    && (o.mirror === 'keep' || o.mirror === 'off') && (o.human === 'engine' || o.human === 'content')
    && (o.mirrorRetired === undefined || typeof o.mirrorRetired === 'boolean') // 不是 boolean = 读不出,不当成没退役
}

/** 这个账号的按根认领:null = 没有(走老的 .owned 全局遮罩);配置读不了、或这一项形状不对 → 抛(调用方按「不知道」处理,不当成没认领)。 */
export async function readSyncOwnershipV2(accountId: string | null): Promise<SyncOwnershipV2 | null> {
  if (!accountId) return null
  await writes // 排在已提交的写后面:刚写完马上读,读到的是新值
  const own = (await storedConfigStrict()).cloudAccounts?.[cloudAccountNamespace(accountId)]
  if (!own || own.syncOwnershipV2 === undefined) return null
  if (!isOwnership(own.syncOwnershipV2)) throw new Error('syncOwnershipV2 is malformed')
  return structuredClone(own.syncOwnershipV2)
}

/** 写 / 删这个账号的按根认领。和其他写同一条队列;**以盘上的为底**(严格读,读不了就抛、不写),
 *  免得启动时读坏了缓存成 {},这一写把整份配置(含别的账号、条目同步注册表)盖掉。 */
export function writeSyncOwnershipV2(accountId: string, next: SyncOwnershipV2 | null): Promise<void> {
  if (next !== null && !isOwnership(next)) return Promise.reject(new Error('invalid syncOwnershipV2'))
  const snapshot = next === null ? null : structuredClone(next)
  const work = writes.then(async () => {
    const disk = await storedConfigStrict()
    const key = cloudAccountNamespace(accountId)
    const account: CloudAccountConfig = { ...disk.cloudAccounts?.[key] }
    if (snapshot) account.syncOwnershipV2 = snapshot
    else delete account.syncOwnershipV2
    const out: StoredConfig = { ...disk, cloudAccounts: { ...disk.cloudAccounts, [key]: account } }
    const file = configFile()
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    await fs.writeFile(tmp, JSON.stringify(out, null, 2), 'utf8')
    await fs.rename(tmp, file)
    commitCache(out) // 以严格读为底
  })
  writes = work.catch(() => {})
  return work
}

export async function readConfig(accountId = currentCloudAccountId()): Promise<AmadeusConfig> {
  return configFrom(await storedConfig(), accountId)
}

/** cloudSync.mirror 只属于遮罩读数(见 AmadeusCloudSyncConfig):读盘不带、写盘剔掉。 */
function withoutMirror(cs: AmadeusCloudSyncConfig | undefined): AmadeusCloudSyncConfig | undefined {
  if (!cs || typeof cs !== 'object' || !('mirror' in cs)) return cs // 盘上坏了的(不是对象)原样给,形状由读的一方判
  const { mirror: _mirror, ...rest } = cs
  return rest
}

function configFrom(stored: StoredConfig, accountId: string | null): AmadeusConfig {
  const own = accountId ? stored.cloudAccounts?.[cloudAccountNamespace(accountId)] : undefined
  // Callers mutate entries while preparing changes. A snapshot prevents old
  // asynchronous work from modifying the persisted owner map behind our back.
  return structuredClone({
    lastVault: stored.lastVault, localVault: stored.localVault, lastPage: stored.lastPage,
    vaults: stored.vaults, syncVault: stored.syncVault,
    cloudSync: withoutMirror(own?.cloudSync), entrySync: own?.entrySync ?? [], cloudAccountId: accountId,
  })
}

/** 一份条目同步名单里认得的形状:不是数组 / 项不是对象 / 库根不是字符串 / entries 不是数组 / 条目路径不是字符串 → 抛
 *  (读不懂 ≠ 没有)。缺省的 entries 当空。 */
function entrySyncListStrict(v: unknown): EntrySyncVault[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new Error('amadeus-config-malformed')
  return v.map((x) => {
    const o = x as Partial<EntrySyncVault> | null
    if (!o || typeof o !== 'object' || typeof o.vaultRoot !== 'string' || !o.vaultRoot) throw new Error('amadeus-config-malformed')
    const entries = o.entries === undefined ? [] : o.entries
    if (!Array.isArray(entries) || !entries.every((e) => !!e && typeof e === 'object' && typeof e.path === 'string' && typeof e.kind === 'string')) throw new Error('amadeus-config-malformed')
    return { vaultRoot: o.vaultRoot, cloudName: typeof o.cloudName === 'string' ? o.cloudName : '', entries: structuredClone(entries) }
  })
}

/** 一次严格读的快照(旧 remotesync 用,H3):当前账号那份配置(同 readConfig 的形状),加上盘上**所有**条目同步登记 ——
 *  每个账号的、待认领的每一份老字段,都从这同一次读来。
 *  没有文件 = 空配置;读不了 / 不是 JSON 对象 / 名单形状读不懂 → 抛固定码(读失败 ≠ 没有条目同步)。不走缓存。 */
export async function readEntrySyncSnapshotStrict(accountId: string | null = currentCloudAccountId()): Promise<{ config: AmadeusConfig; allEntrySync: EntrySyncVault[] }> {
  await writes.catch(() => {}) // 排着的写先落盘(刚加的条目同步不会被这一轮漏掉);同 syncTargetsStore.read 先等它的队列
  const st = await storedConfigStrict()
  const accounts = st.cloudAccounts ?? {}
  const extras = legacyExtras(st)
  if (!extras || typeof accounts !== 'object' || Array.isArray(accounts)) throw new Error('amadeus-config-malformed')
  const allEntrySync = [st.legacyCloudState, ...extras, ...Object.values(accounts)].flatMap((own) => entrySyncListStrict(own?.entrySync))
  return { config: configFrom(st, accountId), allEntrySync }
}

/** 同一个 lastVault:都没有算同一个;都有按 path.resolve 比。 */
const sameLastVault = (a: unknown, b: unknown): boolean => {
  const has = (v: unknown): v is string => typeof v === 'string' && v !== ''
  return has(a) ? has(b) && path.resolve(a) === path.resolve(b) : !has(b)
}
/** activeVault 怎么跟着这次写走:auto = 这次改了 lastVault 就一并清掉(本机侧换了库 = 不再恢复在线库;
 *  在线时 lastVault 不动,所以不会误清);drop = 一定清;keep = 宿主自己的启动回落(restoreVault / 首启建默认库),照契约「回落不清」。 */
type ActiveVaultMode = 'auto' | 'drop' | 'keep'

/** 回这一次是否清掉了一个在线库。 */
async function persistConfig(snapshot: Partial<AmadeusConfig>, accountId: string | null, mode: ActiveVaultMode = 'auto', base?: StoredConfig): Promise<boolean> {
  const stored = base ?? await writeBase()
  const { cloudSync, entrySync, cloudAccountId: _owner, ...local } = snapshot
  const next: StoredConfig = { ...stored, ...local }
  const had = next.activeVault !== undefined && next.activeVault !== null
  const drop = had && (mode === 'drop' || (mode === 'auto' && 'lastVault' in local && !sameLastVault(local.lastVault, stored.lastVault)))
  if (drop) delete next.activeVault
  if (accountId && ('cloudSync' in snapshot || 'entrySync' in snapshot)) {
    const key = cloudAccountNamespace(accountId)
    next.cloudAccounts = { ...stored.cloudAccounts, [key]: {
      ...stored.cloudAccounts?.[key],
      // 旧引擎拿遮罩读数 {...cfg.cloudSync, deviceId / vaultId / enabled} 写回:遮罩加的 mirror 不落盘
      ...('cloudSync' in snapshot ? { cloudSync: withoutMirror({ ...stored.cloudAccounts?.[key]?.cloudSync, ...cloudSync }) } : {}),
      ...('entrySync' in snapshot ? { entrySync } : {}),
    } }
  }
  const file = configFile()
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
  await fs.rename(tmp, file)
  commitCache(next)
  return drop
}

/** 普通写顺带清掉了 activeVault 时通知(宿主据此广播 amadeus:active-vault:changed { ref:null })。Extend 的胶囊切本机经 writeConfig / updateConfig 写,宿主只能在这里认出来。 */
const activeVaultCleared = new Set<() => void>()
export function onActiveVaultCleared(cb: () => void): () => void {
  activeVaultCleared.add(cb)
  return () => { activeVaultCleared.delete(cb) }
}
const emitActiveVaultCleared = (dropped: boolean): void => {
  if (dropped) for (const cb of [...activeVaultCleared]) { try { cb() } catch { /* 订阅者自理 */ } }
}

export function writeConfig(patch: Partial<AmadeusConfig>, accountId = currentCloudAccountId(), opts: { keepActiveVault?: boolean } = {}): Promise<void> {
  const snapshot = structuredClone(patch)
  const work = writes.then(() => persistConfig(snapshot, accountId, opts.keepActiveVault ? 'keep' : 'auto')).then(emitActiveVaultCleared)
  writes = work.catch(() => {})
  return work
}

/** Adopt pre-account-scoping bindings once the signed-in account has resolved its own
 * cloud vault and it is the vault those bindings were made against. Vault ownership is
 * per user, so equality proves the owner. Legacy entry shadows move into the account
 * namespace so sync resumes from its baseline instead of re-pairing every file.
 * ponytail: called from refreshEntryBindings; an account whose vault id is still unknown
 * at that moment adopts on the next refresh or launch, no change listener.
 * renameShadow:shadow 文件住在 Extend(sync/shadow.ts 随引擎搬走),由调用方递进来;缺省 = 不动 shadow(只有测试会这样调)。 */
export function adoptLegacyCloudState(
  accountId = currentCloudAccountId(),
  renameShadow: (from: string, to: string) => Promise<unknown> = async () => {},
): Promise<boolean> {
  const work = writes.then(async () => {
    if (!accountId) return false
    let stored: StoredConfig
    try { stored = await writeBase() } catch { return false } // 读不出:这次不收养(reject 会让 refreshEntryBindings 在读配置前中断),下次再来
    const key = cloudAccountNamespace(accountId)
    const own = stored.cloudAccounts?.[key]
    const vaultId = own?.cloudSync?.vaultId
    const extras = legacyExtras(stored)
    if (!own || typeof vaultId !== 'string' || !vaultId || !extras) return false
    const states = [stored.legacyCloudState, ...extras]
    const matches = states.filter((state) => state?.cloudSync?.vaultId === vaultId)
    const [legacy] = matches
    if (matches.length !== 1 || !legacy) return false // 多份同 vaultId 还没有取舍规则,暂留隔离区
    // 校验后仍用原样的名单,保留读给旧 remotesync 时无需使用的字段(如 exclude)。
    try { entrySyncListStrict(own.entrySync); entrySyncListStrict(legacy.entrySync) } catch { return false }
    const known = new Set((own.entrySync ?? []).map((v) => v.vaultRoot))
    const adopted = (legacy.entrySync ?? []).filter((v) => !known.has(v.vaultRoot))
    const hash8 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8)
    try {
      if (adopted.length > 0) {
        // 旧 shadow 文件名只认根的哈希。另一个快照也用这个名字时，回调无法确认文件属于哪个账号。
        const otherShadows = new Set(states.filter((state) => state !== legacy)
          .flatMap((state) => entrySyncListStrict(state?.entrySync).map((v) => hash8(v.vaultRoot))))
        if (adopted.some((v) => otherShadows.has(hash8(v.vaultRoot)))) return false
      }
      for (const v of adopted) {
        await renameShadow(`amadeus-sync-entry-${hash8(v.vaultRoot)}`, `amadeus-sync-${key}-entry-${hash8(v.vaultRoot)}`)
      }
    } catch {
      return false // shadow move failed (EPERM, EBUSY…): keep the legacy state, never adopt onto an empty baseline
    }
    const out: StoredConfig = {
      ...stored,
      cloudAccounts: { ...stored.cloudAccounts, [key]: { ...own, entrySync: [...(own.entrySync ?? []), ...adopted] } },
    }
    if (legacy === stored.legacyCloudState) delete out.legacyCloudState
    else {
      const remaining = extras.filter((extra) => extra !== legacy)
      if (remaining.length) out.legacyCloudStateExtra = remaining
      else delete out.legacyCloudStateExtra
    }
    // 写失败时保留缓存里的隔离区,下次重试(shadow 的目标已存在时不会再挪)。
    try { await writeStored(out) } catch { return false }
    return true
  })
  writes = work.then(() => {}, () => {})
  return work
}

/** Read-modify-write in the same queue as ordinary writes. Parallel moves and
 * sync toggles must transform the latest registry, never replace a stale copy. */
export function updateConfig(
  update: (config: AmadeusConfig) => boolean | void | Promise<boolean | void>,
  accountId = currentCloudAccountId(),
): Promise<AmadeusConfig> {
  const work = writes.then(async () => {
    const config = configFrom(await writeBase(), accountId) // 读不出就抛、不调回调:回调不拿空缓存改清单
    if (await update(config) !== false) emitActiveVaultCleared(await persistConfig(config, accountId))
    return config
  })
  writes = work.then(() => {}, () => {})
  return work
}

/** 同一个目录:realpath 认软链 / 大小写,目录不在就按字面 resolve。 */
const sameDir = (a: string, b: string): boolean => {
  const canon = (p: string): string => { try { return realpathSync.native(p) } catch { return path.resolve(p) } }
  return canon(a) === canon(b)
}
// 长度上限只防垃圾:旧位置库的 libraryId = `${vaultId}:${prefix}`(§3.1),所以它的上限要盖得住 prefix
const goodId = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v)
const goodSeg = (seg: string): boolean => seg !== '' && seg !== '.' && seg !== '..' && !/[\\\u0000-\u001f]/.test(seg)

/** 在线库引用的形状(H3 定稿第 2 节):六个字段逐个核,只留这六个;不对 = null。prefix 按 §3.1:'Amadeus/' 或 'Amadeus/<…>/'。 */
export function parseOnlineVaultRef(v: unknown): OnlineVaultRef | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  if (r.kind !== 'online' || typeof r.account !== 'string' || !/^[0-9a-f]{64}$/.test(r.account)) return null
  if (!goodId(r.libraryId, 4096) || !goodId(r.vaultId, 1024) || !goodId(r.name, 1024) || !r.name.trim()) return null
  const p = r.prefix
  if (typeof p !== 'string' || p.length > 1024 || !p.startsWith('Amadeus/') || !p.endsWith('/') || !p.slice(0, -1).split('/').every(goodSeg)) return null
  return { kind: 'online', account: r.account, libraryId: r.libraryId, vaultId: r.vaultId, prefix: p, name: r.name }
}

/** 新写路径(在线库 set / 清除 / 迁移 / 切本机库)只认严格读的底稿:不走宽松读,读失败就抛,共享缓存不会因此变成 {}。
 *  别人起的宽松读还在途时先等它落定(不自己起一个),免得它晚到、把这一写的缓存盖回去。 */
async function settleLoading(): Promise<void> {
  if (loading) await loading
}

async function writeStored(out: StoredConfig): Promise<void> {
  const file = configFile()
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(out, null, 2), 'utf8')
  await fs.rename(tmp, file)
  commitCache(out)
}

/** 停止落盘前释放指定的旧钉子。先拿旧远程同步的封口锁,再进配置队列:在途同步也会读配置。 */
export async function moveSyncVaultPin(expectedRoot: string): Promise<'moved' | 'unchanged' | 'local-vault-unavailable' | 'legacy-remotesync-not-paused'> {
  const { withSealedLegacyRemoteSync } = await import('../remotesyncIpc')
  return withSealedLegacyRemoteSync(() => {
    const work = writes.then(async () => {
      const disk = await storedConfigStrict()
      const pinned = disk.syncVault
      if (pinned === undefined) return 'unchanged' as const
      const local = disk.localVault
      if (typeof pinned !== 'string' || !path.isAbsolute(pinned)) throw new Error('amadeus-config-malformed')
      if (!samePath(pinned, expectedRoot)) return 'unchanged' as const
      if (typeof local !== 'string' || !path.isAbsolute(local)) return 'local-vault-unavailable' as const
      const out = { ...disk }
      if (samePath(pinned, local)) delete out.syncVault
      else out.syncVault = local
      await writeStored(out)
      return 'moved' as const
    })
    writes = work.then(() => {}, () => {})
    return work
  })
}

/** 当前打开的在线库(只认形状,不核账号:账号由调用方比)。没有 = null;配置读不了、或这一项形状不对 → 抛(读失败 ≠ 本机库)。 */
export async function readActiveVault(): Promise<OnlineVaultRef | null> {
  await writes // 排在已提交的写后面
  const raw = (await storedConfigStrict()).activeVault
  if (raw === undefined || raw === null) return null
  const ref = parseOnlineVaultRef(raw)
  if (!ref) throw new Error('active-vault-malformed')
  return ref
}

/** 写 / 清当前在线库。和其他写同一条队列、以盘上的为底(严格读,读不了就抛、不写)。
 *  assert 在队列里、落盘之前调(账号核对:排队期间换了账号也拦得住),抛了就不写。 */
export function writeActiveVault(next: OnlineVaultRef | null, assert?: () => void): Promise<void> {
  const ref = next === null ? null : parseOnlineVaultRef(next)
  if (next !== null && !ref) return Promise.reject(new Error('invalid_ref'))
  const work = writes.then(async () => {
    await settleLoading()
    const out: StoredConfig = { ...(await storedConfigStrict()) }
    assert?.()
    if (ref) out.activeVault = ref
    else delete out.activeVault
    await writeStored(out)
  })
  writes = work.catch(() => {})
  return work
}

/** 内容确定坏了:零字节 / 只有空白、解析不了、顶层不是对象。 */
const brokenContent = (raw: string): boolean => {
  try { const v: unknown = JSON.parse(raw); return !v || typeof v !== 'object' || Array.isArray(v) } catch { return true }
}

/** 启动那一下(restoreVault 第一次读)用:配置文件**内容确定坏了**,就原样改名到同目录的 `<原文件名>.corrupt-<时间戳>`
 *  (不删、不改内容),缓存按 ENOENT 换成空配置,调用方照首启建默认库(断电后零字节的用户不至于一直打不开库)。
 *  I/O 读不了(EACCES / EIO / EISDIR…,文件可能是好的)、内容其实是好的、改名失败 → 什么都不动,回 null,调用方照旧拒绝。
 *  回挪到的文件名(只有文件名)。和其他写同一条队列。 */
export function quarantineCorruptConfig(): Promise<string | null> {
  const work = writes.then(async () => {
    await settleLoading()
    const file = configFile()
    let raw: string
    try { raw = await fs.readFile(file, 'utf8') } catch { return null } // 读不了 / 没有:不是「内容坏了」
    if (!brokenContent(raw)) return null
    const to = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try { await fs.rename(file, to) } catch { return null }
    commitCache({})
    return path.basename(to)
  })
  writes = work.then(() => {}, () => {})
  return work
}

/** 本机侧换库:update(switchPatch)和清 activeVault 同一次落盘(用户切回本机库 = 下次不再恢复在线库)。回是否清掉了一个在线库。 */
export function updateLocalVaultConfig(update: (config: AmadeusConfig) => void, accountId = currentCloudAccountId()): Promise<boolean> {
  const work = writes.then(async () => {
    await settleLoading()
    const disk = await storedConfigStrict() // 读不了就抛、不换库:不拿空底稿盖掉清单和账号配置
    const config = configFrom(disk, accountId)
    update(config)
    return persistConfig(config, accountId, 'drop', disk) // 广播由调用方在换完根以后发
  })
  writes = work.then(() => {}, () => {})
  return work
}

/** 老配置迁移(H3 定稿第 2 节):lastVault 停在**这个账号**的云镜像、这个账号配置里有 cloudSync.vaultId →
 *  activeVault = 默认库,lastVault 换回本机库(本机库也不是真目录就去掉 lastVault,restoreVault 走首启那条建默认库)。
 *  未满足迁移条件回 false;配置读不了就抛;本机库 stat 遇到无法判断的错误时回 null,本次不写。
 *  mirrorDir / isManaged 由调用方递(cloudPaths 依赖本文件)。 */
export function migrateMirrorActiveVault(
  accountId: string | null,
  mirrorDir: (accountId: string) => string,
  isManaged: (root: string) => boolean,
): Promise<boolean | null> {
  const work = writes.then(async () => {
    if (!accountId) return false
    await settleLoading()
    const disk = await storedConfigStrict()
    if (disk.activeVault !== undefined && disk.activeVault !== null) return false
    const last = disk.lastVault
    if (typeof last !== 'string' || !last || !sameDir(last, mirrorDir(accountId))) return false
    const key = cloudAccountNamespace(accountId)
    const vaultId = disk.cloudAccounts?.[key]?.cloudSync?.vaultId
    const ref = parseOnlineVaultRef({ kind: 'online', account: key, libraryId: vaultId, vaultId, prefix: 'Amadeus/', name: 'My Vault' })
    if (!ref) return false // 缺 vaultId(或不是合法 id)
    const out: StoredConfig = { ...disk, activeVault: ref }
    const local = disk.localVault
    // 本机库那一格得是还在的真目录:删掉了、或同路径上是个普通文件,都去掉 lastVault,让启动回落建默认库
    let isDir = false
    if (typeof local === 'string' && local && !isManaged(local)) {
      try { isDir = (await fs.stat(local)).isDirectory() } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
      }
    }
    if (isDir) out.lastVault = local
    else delete out.lastVault
    await writeStored(out)
    return true
  })
  writes = work.then(() => {}, () => {})
  return work
}
