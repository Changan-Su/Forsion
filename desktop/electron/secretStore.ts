/**
 * 设备凭据的静态加密存储(P1-K5 S1–S3)。不依赖 electron:加密后端(safeStorage)、文件读写都由调用方注入,vitest 直测。
 *
 * 文件 `<userData>/device-secrets.json`(在 userData 里,自动继承引擎 C4 凭据读拒绝):
 *   { "v": 1, "entries": { "<slot>": { "enc": "os", "backend": "keychain", "data": "<base64 密文>", "at": 1759… }
 *                          "<slot>": { "enc": "plain", "data": "<utf8>", "at": … } } }
 *
 * 判据只有一条:静态存放的秘密是否绑定到 OS 登录会话(decideLevel)。永不调用 setUsePlainTextEncryption(true) ——
 * Linux 的 basic_text 用的是内置固定口令,任何一份 userData 拷贝都能解开,等同明文。
 *   - unitPairing / externalToken:plaintext 时兼容回落(enc:'plain',0600,状态标降级)—— 这就是今天的行为,无钥匙串的 Linux 设备页不能因此回退。
 *   - unitCallerSecret(P2):fail-closed,plaintext 时 set 抛 secret-store-insecure,不落盘。
 *
 * 懒加载:init() 只读文件;只有某个槽真被要求取值 / 写入时才判定 level、调 decrypt。所有槽都空时整个进程不碰加密后端
 * (台架零改动、不弹钥匙串)。
 *
 * 状态机(每槽):absent ─set─▶ stored;stored ─get─▶ ok | locked(解密抛错 / level 降为 plaintext 而 enc=os);
 * locked ─retry 成功─▶ ok;locked ─set(null, {force})─▶ absent。**locked ≠ absent**:locked 时不删文件、不覆盖。
 * stored(enc=plain) 在 level=os 时 init 自动重新加密写回(升级)。
 */
import type { SecretLevel, SecretSlot, SecretStorageStatus } from '../shared/secretStorage'

export type { SecretLevel, SecretSlot, SecretStorageStatus } from '../shared/secretStorage'

export interface CryptoProvider {
  available(): boolean
  backend(): string
  encrypt(s: string): Buffer
  decrypt(b: Buffer): string
}
export interface SlotPolicy { allowPlaintext: boolean }
export const SLOT_POLICY: Record<SecretSlot, SlotPolicy> = {
  unitPairing: { allowPlaintext: true },
  externalToken: { allowPlaintext: true },
  unitCallerSecret: { allowPlaintext: false },
}
export const ALL_SLOTS: readonly SecretSlot[] = ['unitPairing', 'externalToken', 'unitCallerSecret']

export type SlotRead = { state: 'ok'; value: string | null } | { state: 'locked' } | { state: 'insecure' }

/** level ≠ os 而该槽不许明文(unitCallerSecret)。 */
export class SecretStoreInsecureError extends Error {
  readonly code = 'secret-store-insecure'
  constructor() { super('secret-store-insecure') }
}
/** 文件存在但解析不了:任何槽的写入都会丢掉别的槽(可能连带让配对「消失」→ 自动重新登记),只允许显式 force(重新登记本机)。 */
export class SecretStoreUnreadableError extends Error {
  readonly code = 'secret-store-unreadable'
  constructor() { super('secret-store-unreadable') }
}
/** level=os 但加密后端这一刻加密失败:不落盘(旧值原样保留)。 */
export class SecretStoreEncryptError extends Error {
  readonly code = 'secret-store-encrypt-failed'
  constructor() { super('secret-store-encrypt-failed') }
}

interface Entry { enc: 'os' | 'plain'; backend?: string; data: string; at: number }
type Entries = Partial<Record<SecretSlot, Entry>>

const OS_BACKEND: Partial<Record<NodeJS.Platform, string>> = { darwin: 'keychain', win32: 'dpapi' }

/** 判定等级。darwin / win32:加密可用即 os;linux:还要求后端不是 basic_text / unknown;其余平台一律 plaintext。 */
export function decideLevel(platform: NodeJS.Platform, c: CryptoProvider): { level: SecretLevel; backend: string } {
  let available = false
  try { available = c.available() } catch { available = false }
  if (platform === 'darwin' || platform === 'win32') {
    return available ? { level: 'os', backend: OS_BACKEND[platform]! } : { level: 'plaintext', backend: 'none' }
  }
  if (platform === 'linux') {
    let backend = 'unknown'
    try { backend = c.backend() || 'unknown' } catch { backend = 'unknown' }
    return available && backend !== 'basic_text' && backend !== 'unknown' ? { level: 'os', backend } : { level: 'plaintext', backend }
  }
  return { level: 'plaintext', backend: 'none' }
}

function validEntry(e: unknown): e is Entry {
  if (!e || typeof e !== 'object') return false
  const x = e as Record<string, unknown>
  return (x.enc === 'os' || x.enc === 'plain') && typeof x.data === 'string'
}

export interface SecretStoreDeps {
  file: string
  crypto: CryptoProvider
  platform: NodeJS.Platform
  /** 文件内容;不存在回 null;读不了(权限等)抛错。 */
  read(f: string): Promise<string | null>
  /** 原子落盘(tmp + rename,0600)。失败必须保证旧文件完好。 */
  write(f: string, data: unknown): Promise<void>
  rm(f: string): Promise<void>
  now?: () => number
}

export interface SecretStore {
  /** 读文件(不解密、所有槽为空时不碰加密后端);有旧的明文条目且 level=os 时重新加密写回。 */
  init(): Promise<void>
  get(s: SecretSlot): Promise<SlotRead>
  /** v=null 删槽。force 只给「重新登记本机 / 清空」这种显式操作:文件解析不了时也允许重写。 */
  set(s: SecretSlot, v: string | null, opts?: { force?: boolean }): Promise<void>
  /** 迁移专用:写入后从**磁盘字节**重新读出、重新解密核对;对不上就把整份文件恢复成写入前的内容并回 false。 */
  setVerified(s: SecretSlot, v: string): Promise<boolean>
  /** 当前状态;会判定 level(可能碰加密后端)。 */
  status(): SecretStorageStatus
  /** 某槽在盘上的形态(不解密):remoteSessionsPermitted 要求配对不是明文条目。 */
  describe(s: SecretSlot): 'absent' | 'os' | 'plain' | 'unreadable'
  /** 重新读文件、重新判定 level、清掉缓存与锁,并立即对 enc=os 的条目各解密一次(用户点「重试」那一刻才弹系统钥匙串)。 */
  retry(): Promise<SecretStorageStatus>
  wipe(): Promise<void>
  onChange(cb: (s: SecretStorageStatus) => void): () => void
}

export function createSecretStore(d: SecretStoreDeps): SecretStore {
  const now = d.now ?? Date.now
  /** 盘上 entries 的原样对象(含校验不过的条目、以及更新版本加的未知槽):写回时一律带上,只动目标槽 ——
   *  否则写 externalToken 会顺手丢掉一条读不懂的 unitPairing,等于让配对「消失」→ 自动重新登记(铸新 unit id)。 */
  let rawEntries: Record<string, unknown> = {}
  /** rawEntries 里校验通过的已知槽。 */
  let entries: Entries = {}
  let unreadable = false
  let levelCache: { level: SecretLevel; backend: string } | null = null
  const values = new Map<SecretSlot, string>()
  const locked = new Set<SecretSlot>()
  let lastError: string | null = null
  const listeners = new Set<(s: SecretStorageStatus) => void>()

  // 串行链:init / get / set / retry / wipe 排一条队(get 也排:读到一半的 set 不许被看见)。失败只抛给自己的调用方。
  let tail: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(() => withChange(task))
    tail = run.then(() => {}, () => {})
    return run
  }

  const ensureLevel = (): { level: SecretLevel; backend: string } => (levelCache ??= decideLevel(d.platform, d.crypto))
  const lockedList = (): SecretSlot[] => (unreadable ? [...ALL_SLOTS] : ALL_SLOTS.filter((s) => locked.has(s)))
  const statusNow = (): SecretStorageStatus => {
    const lv = ensureLevel()
    return { level: lv.level, backend: lv.backend, locked: lockedList(), lastError }
  }
  /** 变化检测用的指纹:level 没判定过就不带(不为了发事件去碰加密后端)。 */
  const fingerprint = (): string => JSON.stringify([levelCache, lockedList(), lastError])
  async function withChange<T>(task: () => Promise<T>): Promise<T> {
    const before = fingerprint()
    try { return await task() } finally {
      if (fingerprint() !== before && levelCache) {
        const st = statusNow()
        for (const cb of [...listeners]) { try { cb(st) } catch { /* 订阅方的错不影响存储 */ } }
      }
    }
  }

  async function readFileEntries(): Promise<{ ok: true; entries: Entries } | { ok: false }> {
    let raw: string | null
    try { raw = await d.read(d.file) } catch { return { ok: false } }
    if (raw === null) return { ok: true, entries: {} }
    try {
      const j = JSON.parse(raw) as { v?: unknown; entries?: unknown }
      if (!j || typeof j !== 'object' || j.v !== 1 || !j.entries || typeof j.entries !== 'object' || Array.isArray(j.entries)) return { ok: false }
      return { ok: true, entries: j.entries as Entries }
    } catch { return { ok: false } }
  }
  const writeEntries = (next: Record<string, unknown>): Promise<void> => d.write(d.file, { v: 1, entries: next })

  function encryptEntry(v: string, slot: SecretSlot): Entry {
    const lv = ensureLevel()
    if (lv.level === 'os') {
      let data: string
      try { data = d.crypto.encrypt(v).toString('base64') } catch {
        lastError = 'encrypt-failed'
        throw new SecretStoreEncryptError()
      }
      return { enc: 'os', backend: lv.backend, data, at: now() }
    }
    if (!SLOT_POLICY[slot].allowPlaintext) throw new SecretStoreInsecureError()
    return { enc: 'plain', data: v, at: now() }
  }

  /** 读文件 + 规整 + 必要时升级;不解密 enc=os 条目。 */
  async function load(): Promise<void> {
    values.clear()
    locked.clear()
    const r = await readFileEntries()
    if (!r.ok) {
      rawEntries = {}
      entries = {}
      unreadable = true
      lastError = 'store-unreadable'
      return
    }
    unreadable = false
    rawEntries = { ...(r.entries as Record<string, unknown>) }
    entries = {}
    for (const s of ALL_SLOTS) {
      const e = r.entries[s]
      if (e === undefined) continue
      if (!validEntry(e)) { locked.add(s); lastError = 'store-unreadable'; continue } // 条目坏了:按锁定处理,不当成空
      entries[s] = e
    }
    if (!Object.keys(entries).length) return // 全空:不判定 level、不碰加密后端
    const lv = ensureLevel()
    let upgraded = false
    const next: Record<string, unknown> = { ...rawEntries }
    for (const s of ALL_SLOTS) {
      const e = entries[s]
      if (!e) continue
      if (e.enc === 'os' && lv.level !== 'os') { locked.add(s); lastError = 'os-crypto-unavailable'; continue }
      if (e.enc === 'plain' && lv.level === 'os') {
        try { next[s] = { ...encryptEntry(e.data, s), at: e.at }; upgraded = true } catch { /* 升级失败:留着明文条目,下次再试 */ }
      }
    }
    if (upgraded) {
      try {
        await writeEntries(next)
        rawEntries = next
        for (const s of ALL_SLOTS) if (validEntry(next[s])) entries[s] = next[s] as Entry
      } catch { lastError = 'upgrade-failed' }
    }
  }

  function readSlot(s: SecretSlot): SlotRead {
    // 锁定的槽直到 retry / 重新写入前都不再尝试解密:macOS 上每次解密失败都可能再弹一次钥匙串框,
    // 而 loadConfig 之类的高频读者会反复来取 —— 那会变成弹框风暴。
    if (unreadable || locked.has(s)) return { state: 'locked' }
    const cached = values.get(s)
    if (cached !== undefined) return { state: 'ok', value: cached }
    const e = entries[s]
    if (!e) return { state: 'ok', value: null } // 空槽:不碰加密后端
    if (e.enc === 'plain') {
      if (!SLOT_POLICY[s].allowPlaintext) return { state: 'insecure' }
      values.set(s, e.data)
      return { state: 'ok', value: e.data }
    }
    if (ensureLevel().level !== 'os') { locked.add(s); lastError = 'os-crypto-unavailable'; return { state: 'locked' } }
    try {
      const v = d.crypto.decrypt(Buffer.from(e.data, 'base64'))
      values.set(s, v)
      locked.delete(s)
      return { state: 'ok', value: v }
    } catch {
      locked.add(s)
      lastError = 'decrypt-failed'
      return { state: 'locked' }
    }
  }

  async function setInner(s: SecretSlot, v: string | null, force: boolean): Promise<void> {
    if (unreadable && !force) throw new SecretStoreUnreadableError()
    const base: Record<string, unknown> = unreadable ? {} : { ...rawEntries }
    if (v === null) {
      if (!unreadable && !(s in base)) { values.delete(s); locked.delete(s); return } // 本来就空:不写盘
      delete base[s]
    } else {
      base[s] = encryptEntry(v, s)
    }
    await writeEntries(base) // 失败 → 抛给调用方,内存状态不动(旧文件由原子写保证完好)
    rawEntries = base
    entries = {}
    for (const k of ALL_SLOTS) if (validEntry(base[k])) entries[k] = base[k] as Entry
    unreadable = false
    locked.delete(s)
    if (v === null) values.delete(s)
    else values.set(s, v)
    if (lastError === 'store-unreadable' && !locked.size) lastError = null
  }

  const store: SecretStore = {
    init: () => serial(load),
    get: (s) => serial(async () => readSlot(s)),
    set: (s, v, opts) => serial(() => setInner(s, v, opts?.force === true)),
    setVerified: (s, v) => serial(async () => {
      const prevEntries = entries
      const prevRaw = rawEntries
      const prevUnreadable = unreadable
      const prevLocked = new Set(locked)
      let prevFile: string | null = null
      try { prevFile = await d.read(d.file) } catch { prevFile = null }
      try {
        await setInner(s, v, true)
      } catch {
        lastError = 'migrate-verify-failed'
        return false
      }
      // 从磁盘字节重新读、重新解密(不看内存缓存):迁移后要删掉 shell 里的原件,必须确认新家真的读得回来。
      let ok = false
      const r = await readFileEntries()
      const e = r.ok ? r.entries[s] : undefined
      if (e && validEntry(e)) {
        try { ok = (e.enc === 'os' ? d.crypto.decrypt(Buffer.from(e.data, 'base64')) : e.data) === v } catch { ok = false }
      }
      if (ok) return true
      // 撤回:整份恢复成写入前(原文件内容 / 原本没有文件就删掉)。
      try {
        if (prevFile === null) await d.rm(d.file)
        else await d.write(d.file, JSON.parse(prevFile))
      } catch { /* 恢复失败:下面照样把内存状态退回去,下次启动按 shell 为准重来 */ }
      entries = prevEntries
      rawEntries = prevRaw
      unreadable = prevUnreadable
      locked.clear()
      for (const x of prevLocked) locked.add(x)
      values.delete(s)
      lastError = 'migrate-verify-failed'
      return false
    }),
    status: statusNow,
    describe: (s) => (unreadable ? 'unreadable' : entries[s]?.enc ?? (locked.has(s) ? 'unreadable' : 'absent')),
    retry: () => serial(async () => {
      levelCache = null
      lastError = null
      await load()
      for (const s of ALL_SLOTS) if (entries[s]?.enc === 'os' && !locked.has(s)) readSlot(s)
      return statusNow()
    }),
    wipe: () => serial(async () => {
      await d.rm(d.file)
      rawEntries = {}
      entries = {}
      unreadable = false
      values.clear()
      locked.clear()
      lastError = null
    }),
    onChange: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
  }
  return store
}
