/**
 * Android 宿主的插件数据文件夹(ctx.storage,2026-11-26):`<Data>/plugin-data/<生效插件 ID>/`。
 * 与 ctx.saveData 的 `plugins-data/<id>.json` 分开放(那份是单个 JSON,这里是插件自己的一整个文件夹);库外、不同步。
 *
 * 契约 = 桌面主进程 desktop/electron/amadeus/pluginStorage.ts 的 createPluginStorageHost().handle,逐条对齐:
 *   · 两层:跟应用走(根)、跟库走(`vaults/<storageVaultKey(库根)>/`)。请求带 vault 时核对它仍是渲染层眼里的当前库
 *     (手机上 = pageStore.vaultRoot:本地库 `/vault`,云端库 `cloud://<v>`),对不上 → 'Vault changed…'。
 *   · 不存在 → null / [] / stat null;**其余读错误照实抛,不当空**(用户 10-28「读写用户数据」)。
 *   · 每个插件一条改动队列(write / append / remove / move / clearCache / import),在 handle 入口**同步**排进去
 *     (入参也在入口当场取成原始值 / 字节副本):前后两次调用不会因为中间有 await 而颠倒。读不排队。
 *   · 写 = 临时文件 + 换名,旧文件先挪开、换名失败就挪回去(绝不出现新旧都没了),父目录自动建;append 不存在就建。
 *   · list 在跟应用那一层的根上藏 `vaults`、在库那一层的根上藏 `.forsion-imports`、藏写到一半的临时文件,按名排序。
 *   · remove 递归、不存在算删过;move 目标已存在 → 拒;usage 算整个插件文件夹,cache = 根上的 `cache/` + 每个
 *     `vaults/<key>/cache/`(只认真是文件夹的;叫 cache 的普通文件不算、不清)。
 *   · reveal → false(手机上没有文件管理器可打开)。
 *   · import(复制进来):只认本地库(库文件就在同一个 Data 目录里,按原始目录树走、点开头的也算);云端库给不出
 *     逐字节、含隐藏文件的整棵树 → 明确拒绝 'importFromVault is not available on this host',不记完成。
 * 与桌面的差异只有手机做不到的:没有软链核验(Capacitor 没有软链概念);拷贝校验按字节比对(整份本来就读进内存)。
 *
 * 本模块不 import Capacitor(经 PluginStorageFs 接缝),真机实现在 capacitorPluginFs.ts,单测 mobile/scripts/plugin-storage.test.cjs。
 * 卸载插件不碰这里(与 plugins-data 同一取向:重装后数据还在)。
 */
import {
  STORAGE_CACHE_DIR, STORAGE_IMPORTS_DIR, STORAGE_MIGRATION_ID, STORAGE_VAULTS_DIR,
  normalizeStoragePath, storageVaultKey,
  type PluginStorageEntry, type PluginStorageImportResult, type PluginStorageRequest, type PluginStorageStat, type PluginStorageUsage,
} from '../../../desktop/shared/amadeus/pluginStorage'
import { isSafeSlug } from '../../../desktop/shared/marketPackage'
import { utf8Decode, utf8Encode } from './pluginFs'

/** Data 目录下插件数据文件夹的根(每个插件一个子文件夹)。≠ ctx.saveData 的 `plugins-data`。 */
export const PLUGIN_STORAGE_DIR = 'plugin-data'

export interface StorageFsStat { type: 'file' | 'directory'; size: number; mtime: number }
export interface StorageFsEntry extends StorageFsStat { name: string }

/**
 * ctx.storage 用的文件接缝(路径都是 Data 目录下的相对路径,`/` 分隔)。比 PluginFs 严:「不存在」与「读失败」必须分开 ——
 * 只有确实不存在才回 null,别的错一律抛(PluginFs.stat 把一切错误都报成 null,这里不能用它)。
 */
export interface PluginStorageFs {
  /** 整个文件;不存在 → null;是文件夹 / 读不出来 → 抛。 */
  readBytes(path: string): Promise<Uint8Array | null>
  /** 覆盖写(父目录自动建)。 */
  writeBytes(path: string, bytes: Uint8Array): Promise<void>
  /** 追加;文件不存在就建(父目录由调用方先建)。 */
  appendBytes(path: string, bytes: Uint8Array): Promise<void>
  /** 不存在 → null;别的错抛。 */
  stat(path: string): Promise<StorageFsStat | null>
  /** 直接子项(不递归);不存在 → null;是文件 / 读不出来 → 抛。 */
  list(dir: string): Promise<StorageFsEntry[] | null>
  /** 递归建目录;已存在不算错。 */
  mkdir(path: string): Promise<void>
  /** 文件或文件夹改名。目标已存在时各实现不一(Android 文件会先删目标,文件夹会拒):调用方自己先判。 */
  rename(from: string, to: string): Promise<void>
  /** 递归删文件或文件夹;不存在 = 已删。 */
  remove(path: string): Promise<void>
}

export interface MobilePluginStorageDeps {
  fs: PluginStorageFs
  /** 渲染层眼里的当前库根(pageStore.vaultRoot);没开库 → null。 */
  vaultRoot(): string | null | Promise<string | null>
  /** 这个库的文件在 fs 上的目录(本地库 `/vault` → `vault`);这个宿主读不到它(云端库)→ null。缺省 = 一律读不到。 */
  vaultDir?(root: string): string | null
  /** `plugin-data/` 在 WebView 里可加载的地址(无尾斜杠);还没拿到 / 不是真机 → null。必须同步。 */
  baseUrl?(): string | null
}

export interface MobilePluginStorage {
  handle(req: PluginStorageRequest): Promise<unknown>
  /** Pause initialization on a cached target until its migration can be verified. */
  pauseVaultMigration(to: string): void
  /** Copy the vault layer of every plugin after a confirmed cloud library move. */
  migrateVaultRoot(from: string, to: string): Promise<void>
  /** ctx.storage.url 的地址(同步);rootRel 相对插件数据根(库那一层已带 `vaults/<key>/`)。给不出 → null。 */
  url(pluginId: string, rootRel: string): string | null
}

/** 写到一半的临时文件名(与桌面同一个形状:`<名>.tmp-<数字>-<数字>`,list 按它藏)。 */
const TEMP_FILE = /\.tmp-\d+-\d+$/

const parentOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const insideOrSame = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}/`)
/** 入参取成原始字符串:不是字符串 → undefined(交给 normalizeStoragePath 当场拒)。 */
const str = (v: unknown, dflt?: string): string | undefined => (typeof v === 'string' ? v : v == null ? dflt : undefined)

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

/** 写入的字节:在入口当场拷一份(桌面过 IPC 本来就是结构化克隆;这里不拷的话,排队期间插件改了 buffer 就写进去改过的)。 */
const snapshotBytes = (data: unknown): Uint8Array => {
  if (typeof data === 'string') return utf8Encode(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0))
  throw new TypeError('Plugin storage data must be a string, Uint8Array or ArrayBuffer')
}

/** import 的入参快照(入口同步取,桥把调用方的对象原样递过来)。 */
interface ImportArgs { id: string; vault: string; from: string | undefined; to: string | undefined; migration: string; allowed: string[]; into: 'app' | 'vault' }

export function createMobilePluginStorage(deps: MobilePluginStorageDeps): MobilePluginStorage {
  const { fs } = deps
  const queues = new Map<string, Promise<unknown>>()
  const movingSources = new Set<string>()
  interface Migration { blocked: Set<string> | null; running?: Promise<void> }
  const migrations = new Map<string, Migration>()
  // 临时文件名的前一段:桌面是进程号,手机只有一个进程,用启动时刻区分「上一次没换完名」留下的
  const nonce = Date.now()
  let seq = 0
  /** 每个插件一条改动队列(键 = 插件根)。⚠️ 不可重入:队列里的活别再调 serial(同一个键会互等,永远不动)。 */
  const serial = <T>(key: string, job: () => Promise<T>): Promise<T> => {
    const prev = queues.get(key) ?? Promise.resolve()
    const run = prev.catch(() => {}).then(job)
    const tail = run.catch(() => {})
    queues.set(key, tail)
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
    return run
  }

  const pluginRoot = (id: unknown): string => {
    if (!isSafeSlug(id)) throw new TypeError('Invalid plugin id') // id 直接拼进路径:`../` 就是任意读写
    return `${PLUGIN_STORAGE_DIR}/${id}`
  }

  /** 一层的根:跟应用 = 插件根;跟库 = `vaults/<key>`,且 vault 必须仍是当前库。 */
  const layerRoot = async (id: string, vault?: string): Promise<string> => {
    const root = pluginRoot(id)
    if (vault === undefined) return root
    const current = await deps.vaultRoot()
    const migration = migrations.get(vault)
    if (typeof vault !== 'string' || !vault || current !== vault ||
        (migration && (migration.blocked === null || migration.blocked.has(id)))) {
      throw new Error('Vault changed before plugin storage access')
    }
    return `${root}/${STORAGE_VAULTS_DIR}/${storageVaultKey(vault)}`
  }

  const resolve = async (id: string, vault: string | undefined, raw: unknown, opts: { allowRoot?: boolean } = {}): Promise<{ abs: string; rel: string; layer: string }> => {
    const rel = normalizeStoragePath(raw, { allowRoot: opts.allowRoot, appLayer: vault === undefined })
    const layer = await layerRoot(id, vault)
    return { abs: rel ? `${layer}/${rel}` : layer, rel, layer }
  }

  const tempOf = (abs: string): string => `${abs}.tmp-${nonce}-${++seq}`

  const pauseVaultMigration = (to: string): void => {
    if (!migrations.has(to)) migrations.set(to, { blocked: null })
  }

  async function migrateVaultRoot(from: string, to: string): Promise<void> {
    const oldKey = storageVaultKey(from)
    const newKey = storageVaultKey(to)
    if (!from.startsWith('cloud://') || !to.startsWith('cloud://') || oldKey === newKey) return
    const active = migrations.get(to)?.running
    if (active) return active
    const state: Migration = { blocked: null }
    migrations.set(to, state)
    movingSources.add(from)
    // Include plugins whose first queued write has not created their directory yet.
    const prior = [...queues.values()]
    state.running = (async () => {
      await Promise.all(prior)
      const plugins = (await fs.list(PLUGIN_STORAGE_DIR) ?? []).filter((entry) => entry.type === 'directory' && isSafeSlug(entry.name))
      const blocked = new Set(plugins.map((entry) => entry.name))
      state.blocked = blocked
      const results = await Promise.allSettled(plugins.map(({ name }) => serial(pluginRoot(name), async () => {
        const vaults = `${pluginRoot(name)}/${STORAGE_VAULTS_DIR}`
        await migrateVaultLayer(vaults, oldKey, newKey)
        blocked.delete(name)
      })))
      const failure = results.find((result) => result.status === 'rejected')
      if (failure) throw failure.reason
      migrations.delete(to)
    })().finally(() => {
      movingSources.delete(from)
      state.running = undefined
    })
    return state.running
  }

  async function migrateVaultLayer(vaults: string, oldKey: string, newKey: string): Promise<void> {
    const source = `${vaults}/${oldKey}`
    const destination = `${vaults}/${newKey}`
    const entries = await fs.list(source)
    if (entries === null) return
    const journal = `${vaults}/.root-migration-${newKey}.json`
    const raw = await fs.readBytes(journal)
    const saved: unknown = raw === null ? [] : JSON.parse(utf8Decode(raw))
    if (!Array.isArray(saved) || !saved.every((entry) => typeof entry === 'string')) {
      throw new Error('Vault changed before plugin storage access')
    }
    const handled = new Set<string>(saved)
    const checkpoint = async (relative: string): Promise<void> => {
      handled.add(`${oldKey}/${relative}`)
      await atomicWrite(journal, utf8Encode(JSON.stringify([...handled])))
    }
    const walk = async (dir: string, children: StorageFsEntry[]): Promise<void> => {
      if (handled.has(`${oldKey}/${dir}`)) return
      const destDir = destination + (dir ? `/${dir.slice(0, -1)}` : '')
      if ((await fs.stat(destDir))?.type === 'file') {
        await checkpoint(dir)
        return
      }
      await fs.mkdir(destDir)
      for (const entry of children) {
        if (TEMP_FILE.test(entry.name)) continue
        const relative = dir + entry.name
        if (entry.type === 'directory') {
          const nested = await fs.list(`${source}/${relative}`)
          if (nested === null) throw new Error('Vault changed before plugin storage access')
          await walk(`${relative}/`, nested)
        } else if (!handled.has(`${oldKey}/${relative}`)) {
          const dest = `${destination}/${relative}`
          if ((await fs.stat(dest)) === null) {
            const bytes = await fs.readBytes(`${source}/${relative}`)
            if (bytes === null) throw new Error('Vault changed before plugin storage access')
            if (await copyNewFile(dest, bytes, entry.name)) {
              const copied = await fs.readBytes(dest)
              if (copied === null || !sameBytes(copied, bytes)) throw new Error('Vault changed before plugin storage access')
            }
          }
          await checkpoint(relative)
        }
      }
    }
    await walk('', entries)
  }

  async function copyNewFile(dest: string, bytes: Uint8Array, sourceName: string): Promise<boolean> {
    const tmp = tempOf(dest)
    try {
      await fs.writeBytes(tmp, bytes)
      const back = await fs.readBytes(tmp)
      if (!back || !sameBytes(back, bytes)) throw new Error(`Copy of ${sourceName} does not match its source`)
      if ((await fs.stat(dest)) !== null) return false
      await fs.rename(tmp, dest)
      return true
    } finally {
      await fs.remove(tmp).catch(() => {})
    }
  }

  /**
   * 临时文件 + 换名,旧文件「先挪开、换不过去就挪回来」:
   *   ① 新内容写进临时文件;② 目标是文件 → 先改名成另一个临时名(bak,list 一样藏它;bak 不存在,安卓先删目标那一步删不到东西);
   *   ③ 临时文件改名成目标;失败 → bak 改回目标、删临时文件、抛;连改回都失败 → bak 和临时文件都留在盘上(旧 / 新各一份)、抛;
   *   ④ 成功才删 bak。挪开那一步失败 → 删临时文件、抛(旧文件原地没动)。目标是文件夹 → 拒。
   * 不再「换名失败就直接写到目标上」:安卓换名会先删目标,直接写再失败 = 新旧两份都没了(Codex 评审 P1)。
   */
  const atomicWrite = async (abs: string, bytes: Uint8Array): Promise<void> => {
    await fs.mkdir(parentOf(abs))
    const tmp = tempOf(abs)
    const dropTmp = (): Promise<void> => fs.remove(tmp).catch(() => {})
    try {
      await fs.writeBytes(tmp, bytes)
    } catch (e) {
      await dropTmp()
      throw e
    }
    let bak: string | null = null
    try {
      const cur = await fs.stat(abs)
      if (cur?.type === 'directory') throw new Error('Plugin storage path is a folder, not a file')
      if (cur) {
        bak = tempOf(abs)
        await fs.rename(abs, bak)
      }
    } catch (e) {
      await dropTmp()
      throw e
    }
    try {
      await fs.rename(tmp, abs)
    } catch (e) {
      if (bak) {
        try { await fs.rename(bak, abs) } catch { throw e } // 改不回去:bak(旧)和 tmp(新)都留着,不删
      }
      await dropTmp()
      throw e
    }
    if (bak) await fs.remove(bak).catch(() => {})
  }

  const walkSizes = async (dir: string, onFile: (abs: string, size: number) => void): Promise<void> => {
    const entries = await fs.list(dir)
    if (!entries) return
    for (const e of entries) {
      const abs = `${dir}/${e.name}`
      if (e.type === 'directory') await walkSizes(abs, onFile)
      else onFile(abs, e.size)
    }
  }

  /** 两层的 cache/:根上一个,每个库分区一个 —— 只认真是文件夹的;`vaults` 也只在是文件夹时才往下看。 */
  const cacheDirs = async (root: string): Promise<string[]> => {
    const hasDir = (entries: StorageFsEntry[] | null, name: string): boolean => !!entries?.some((e) => e.name === name && e.type === 'directory')
    const top = await fs.list(root)
    const out = hasDir(top, STORAGE_CACHE_DIR) ? [`${root}/${STORAGE_CACHE_DIR}`] : []
    if (!hasDir(top, STORAGE_VAULTS_DIR)) return out
    for (const v of (await fs.list(`${root}/${STORAGE_VAULTS_DIR}`)) ?? []) {
      if (v.type !== 'directory') continue
      const layer = `${root}/${STORAGE_VAULTS_DIR}/${v.name}`
      if (hasDir(await fs.list(layer), STORAGE_CACHE_DIR)) out.push(`${layer}/${STORAGE_CACHE_DIR}`)
    }
    return out
  }

  async function usage(id: string): Promise<PluginStorageUsage> {
    const root = pluginRoot(id)
    const caches = await cacheDirs(root)
    let bytes = 0, cacheBytes = 0
    await walkSizes(root, (abs, size) => {
      bytes += size
      if (caches.some((c) => abs.startsWith(`${c}/`))) cacheBytes += size
    })
    return { bytes, cacheBytes }
  }

  /** 在本插件的改动队列里跑(不再自己排队)。 */
  async function importFromVault(a: ImportArgs): Promise<PluginStorageImportResult> {
    if (!STORAGE_MIGRATION_ID.test(a.migration)) throw new TypeError('Invalid migration id')
    const vaultRoot = await deps.vaultRoot()
    if (!vaultRoot || vaultRoot !== a.vault) throw new Error('Vault changed before importing into plugin storage')
    // 来源:库内相对路径,必须在宿主给的本插件文件夹(工作文件夹 / Plugins/<id> / Plugins/<旧显示名>)之内
    const from = normalizeStoragePath(a.from)
    const allowed = a.allowed.flatMap((x) => { try { return [normalizeStoragePath(x)] } catch { return [] } })
    if (!allowed.some((x) => from === x || from.startsWith(`${x}/`))) throw new Error('Import source must be inside this plugin\'s working folder')
    // 云端库:手里只有按扩展名分类的接口、看不到点开头的文件 —— 照那个复制会把「复制了一部分」记成完成,下次再也不补
    const vaultDir = deps.vaultDir?.(vaultRoot) ?? null
    if (!vaultDir) throw new Error('importFromVault is not available on this host')
    const vaultLayer = await layerRoot(a.id, vaultRoot)
    const target = await resolve(a.id, a.into === 'vault' ? vaultRoot : undefined, a.to, { allowRoot: true })
    const logFile = `${vaultLayer}/${STORAGE_IMPORTS_DIR}/${a.migration}.json`
    // 完成记录:只有「确实没有」才从头做;有记录却读不出来 / 不是合法 JSON / 不是 complete → 拒(不据此再盖一遍)
    const logBytes = await fs.readBytes(logFile)
    if (logBytes !== null) {
      let log: unknown
      try { log = JSON.parse(utf8Decode(logBytes)) } catch { log = null }
      const l = (log && typeof log === 'object' ? log : {}) as { status?: unknown; copied?: unknown; skipped?: unknown }
      if (l.status !== 'complete') throw new Error(`Import record ${a.migration} exists but is not complete; not importing again`)
      return { status: 'already-done', copied: Number(l.copied) || 0, skipped: Array.isArray(l.skipped) ? l.skipped.map(String) : [] }
    }
    const srcRoot = `${vaultDir}/${from}`
    const st = await fs.stat(srcRoot)
    if (!st) return { status: 'missing', copied: 0, skipped: [] }
    const files: Array<{ src: string; rel: string }> = []
    if (st.type === 'file') {
      if (!target.rel) throw new TypeError('Importing a single file needs a target file path')
      files.push({ src: srcRoot, rel: '' })
    } else {
      const walk = async (dir: string, prefix: string): Promise<void> => {
        const entries = await fs.list(dir)
        if (!entries) throw new Error(`Import source changed while copying: ${prefix || from}`)
        for (const e of entries) {
          const abs = `${dir}/${e.name}`, rel = prefix ? `${prefix}/${e.name}` : e.name
          if (e.type === 'directory') await walk(abs, rel)
          else files.push({ src: abs, rel })
        }
      }
      await walk(srcRoot, '')
    }
    // 落点第一段撞上宿主保留的文件夹(跟应用那层的 vaults/、库那层的完成记录)→ 不写,当跳过报回去
    const reserved = a.into === 'vault' ? STORAGE_IMPORTS_DIR : STORAGE_VAULTS_DIR
    let copied = 0
    const skipped: string[] = []
    for (const f of files) {
      const dest = f.rel ? `${target.abs}/${f.rel}` : target.abs
      const destRel = [target.rel, f.rel].filter(Boolean).join('/')
      if (destRel.split('/')[0].toLowerCase() === reserved) { skipped.push(destRel); continue }
      const src = await fs.readBytes(f.src)
      if (src === null) throw new Error(`Import source changed while copying: ${f.rel || from}`)
      const existing = await fs.readBytes(dest)
      if (existing !== null) {
        if (sameBytes(existing, src)) copied++ // 上次复制到一半:这份已经在了
        else skipped.push(destRel) // 插件自己已经写过:不覆盖
        continue
      }
      await fs.mkdir(parentOf(dest))
      if (await copyNewFile(dest, src, f.rel || from)) copied++
      else skipped.push(destRel)
    }
    const log = { status: 'complete', migration: a.migration, from, to: target.rel, into: a.into, copied, skipped, at: new Date().toISOString() }
    await atomicWrite(logFile, utf8Encode(`${JSON.stringify(log, null, 2)}\n`))
    return { status: 'complete', copied, skipped }
  }

  async function handle(req: PluginStorageRequest): Promise<unknown> {
    if (!req || typeof req !== 'object') throw new TypeError('Bad plugin storage request')
    // ⚠️ 这里到排进队列之前不许有 await:入参当场取成原始值,改动类当场排队(前后两次调用的先后 = 落盘的先后)
    const id = req.id
    const vault = req.vault === undefined ? undefined : (str(req.vault) ?? '')
    if (vault !== undefined && movingSources.has(vault)) throw new Error('Vault changed before plugin storage access')
    const mutate = <T>(job: () => Promise<T>): Promise<T> => serial(pluginRoot(id), job)
    switch (req.op) {
      case 'readText':
      case 'readBytes': {
        const op = req.op
        const { abs } = await resolve(id, vault, str(req.path))
        const bytes = await fs.readBytes(abs)
        if (bytes === null) return null
        return op === 'readText' ? utf8Decode(bytes) : bytes
      }
      case 'write': {
        const path = str(req.path), bytes = snapshotBytes(req.data)
        return mutate(async () => {
          const { abs } = await resolve(id, vault, path)
          await atomicWrite(abs, bytes)
        })
      }
      case 'append': {
        const path = str(req.path), bytes = snapshotBytes(req.data)
        return mutate(async () => {
          const { abs } = await resolve(id, vault, path)
          await fs.mkdir(parentOf(abs))
          await fs.appendBytes(abs, bytes)
        })
      }
      case 'list': {
        const { abs, rel } = await resolve(id, vault, str(req.path, ''), { allowRoot: true })
        const entries = await fs.list(abs)
        if (!entries) return []
        const out: PluginStorageEntry[] = []
        for (const e of entries) {
          if (!rel && vault === undefined && e.name === STORAGE_VAULTS_DIR) continue // 库分区不在跟应用那一层露面
          if (!rel && vault !== undefined && e.name === STORAGE_IMPORTS_DIR) continue
          if (TEMP_FILE.test(e.name)) continue // 写到一半的临时文件
          const folder = e.type === 'directory'
          out.push({ name: e.name, path: rel ? `${rel}/${e.name}` : e.name, kind: folder ? 'folder' : 'file', size: folder ? 0 : e.size, mtime: e.mtime })
        }
        return out.sort((a, b) => a.name.localeCompare(b.name))
      }
      case 'stat': {
        const { abs } = await resolve(id, vault, str(req.path))
        const s = await fs.stat(abs)
        if (!s) return null
        const folder = s.type === 'directory'
        return { kind: folder ? 'folder' : 'file', size: folder ? 0 : s.size, mtime: s.mtime } satisfies PluginStorageStat
      }
      case 'remove': {
        const path = str(req.path)
        return mutate(async () => {
          const { abs } = await resolve(id, vault, path)
          await fs.remove(abs)
        })
      }
      case 'move': {
        const path = str(req.path), toPath = str(req.to)
        return mutate(async () => {
          const from = await resolve(id, vault, path)
          const to = await resolve(id, vault, toPath)
          if (from.abs === to.abs) return
          if (insideOrSame(to.abs, from.abs)) throw new Error('Cannot move a folder into itself')
          // 自己先判:Android 的文件换名会先删掉已存在的目标
          if (await fs.stat(to.abs)) throw Object.assign(new Error(`Target already exists: ${to.rel}`), { code: 'EEXIST' })
          await fs.mkdir(parentOf(to.abs))
          await fs.rename(from.abs, to.abs)
        })
      }
      case 'usage':
        return usage(id)
      case 'clearCache':
        return mutate(async () => {
          for (const dir of await cacheDirs(pluginRoot(id))) await fs.remove(dir)
          return usage(id)
        })
      case 'reveal':
        pluginRoot(id)
        return false // 手机上没有可打开的文件管理器
      case 'hostPath':
        pluginRoot(id)
        normalizeStoragePath(req.path === undefined ? '' : req.path, { allowRoot: true, appLayer: vault === undefined }) // 不合法照样拒,和桌面一致
        return null // 手机上没有本机托管引擎,给 Agent 的绝对路径没意义
      case 'import': {
        const args: ImportArgs = {
          id,
          vault: str(req.vault) ?? '',
          from: str(req.from),
          to: str(req.to, ''),
          migration: str(req.migration) ?? '',
          allowed: Array.isArray(req.allowed) ? Array.from(req.allowed as unknown[], (x) => str(x) ?? '') : [],
          into: req.into === 'vault' ? 'vault' : 'app',
        }
        return mutate(() => importFromVault(args))
      }
      default:
        throw new TypeError(`Unknown plugin storage op: ${String((req as { op?: unknown }).op)}`)
    }
  }

  function url(pluginId: string, rootRel: string): string | null {
    const base = deps.baseUrl?.() ?? null
    if (!base || !isSafeSlug(pluginId)) return null
    let rel: string
    try { rel = normalizeStoragePath(rootRel) } catch { return null }
    return `${base}/${pluginId}/${rel.split('/').map(encodeURIComponent).join('/')}`
  }

  return { handle, pauseVaultMigration, migrateVaultRoot, url }
}
