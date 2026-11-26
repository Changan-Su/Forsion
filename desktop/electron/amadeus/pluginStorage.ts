/**
 * 插件数据文件夹的主进程半(ctx.storage,2026-11-26)。落点 `<tanguDataDir>/plugin-data/<生效插件 ID>/`:
 * 与同 ID 引擎插件的 paths.dataDir 是同一个目录;捆绑包的引擎那半经 paths.bundleDataDir 指到这里。
 * 两层:跟应用走(根)、跟库走(`vaults/<库标识>/`,请求带 vault 时宿主核对它仍是当前库)。`cache/` 可清。
 *
 * 纪律(用户 10-28「读写用户数据」):不存在 → null / [];其余读错误照实抛,不当空。写一律临时文件(独占新建)+ 换名。
 * 一个插件的所有改动(写 / 追加 / 删 / 挪 / 清缓存 / 复制进来)排**一条**队,在调用当下入队:先后不乱,大小写不同
 * 的同一个文件、两次挪到同一个目标、两次同一个迁移都不会互相盖掉。读不排队。
 * 路径先过 normalizeStoragePath(拒 `..`、绝对路径),再按真实路径核一遍(防插件引擎半身放进去的软链指到外面)。
 * 方案:仓根 docs/ToBeImproved/插件数据目录方案_2026-11-26。仪器:pluginStorage.test.ts。
 */
import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants, createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import {
  STORAGE_CACHE_DIR, STORAGE_IMPORTS_DIR, STORAGE_MIGRATION_ID, STORAGE_VAULTS_DIR,
  normalizeStoragePath, storageVaultKey,
  type PluginStorageEntry, type PluginStorageImportResult, type PluginStorageRequest, type PluginStorageStat, type PluginStorageUsage,
} from '@amadeus-shared/pluginStorage'

const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
/** 写到一半的临时文件(list 不露、usage 照算)。 */
const TEMP_NAME = /\.tmp-[0-9a-z]+-\d+$/

export interface PluginStorageHostDeps {
  /** `<tanguDataDir>/plugin-data`(测试给临时目录)。 */
  base(): string
  /** 当前打开的库根;没有 → null。 */
  vaultRoot(): string | null
  /** 打开文件夹(桌面:shell.openPath)。 */
  openFolder?(abs: string): Promise<unknown> | unknown
}

const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code
const isMissing = (e: unknown): boolean => codeOf(e) === 'ENOENT' || codeOf(e) === 'ENOTDIR'

/** child 在 parent 里(含相等)。`..name` 这种合法文件名不算出界。 */
export const insidePluginData = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}
const inside = insidePluginData

async function hashFile(abs: string): Promise<string> {
  const h = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    createReadStream(abs).on('data', (c) => h.update(c)).on('end', () => resolve()).on('error', reject)
  })
  return h.digest('hex')
}

/** 是真文件夹(不是软链、不是普通文件)。不存在 → false;别的错照抛。 */
async function isRealDir(abs: string): Promise<boolean> {
  try { return (await fs.lstat(abs)).isDirectory() } catch (e) { if (isMissing(e)) return false; throw e }
}

export function createPluginStorageHost(deps: PluginStorageHostDeps) {
  const queues = new Map<string, Promise<unknown>>()
  const nonce = randomBytes(4).toString('hex')
  let seq = 0
  /** 一个插件一条改动队列。必须在调用当下(第一个 await 之前)进队,先后才和插件调用的先后一致。 */
  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = queues.get(key) ?? Promise.resolve()
    const run = prev.catch(() => {}).then(fn)
    const tail = run.catch(() => {})
    queues.set(key, tail)
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
    return run
  }
  const tempOf = (abs: string): string => `${abs}.tmp-${nonce}-${++seq}`

  const pluginRoot = (id: unknown): string => {
    if (typeof id !== 'string' || !SAFE_PLUGIN_ID.test(id)) throw new TypeError('Invalid plugin id')
    return path.join(deps.base(), id)
  }

  /** 一层的根:跟应用 = 插件根;跟库 = `vaults/<key>`,且 vault 必须仍是当前库。 */
  const layerRoot = (id: string, vault?: string): string => {
    const root = pluginRoot(id)
    if (vault === undefined) return root
    const current = deps.vaultRoot()
    if (typeof vault !== 'string' || !vault || current !== vault) throw new Error('Vault changed before plugin storage access')
    return path.join(root, STORAGE_VAULTS_DIR, storageVaultKey(vault))
  }

  /** 按真实路径核:最深的已存在祖先必须在插件根里(插件根本身还不存在时它的上层不算越界)。 */
  const assertReal = async (abs: string, root: string): Promise<void> => {
    let realRoot: string
    try { realRoot = await fs.realpath(root) } catch (e) { if (isMissing(e)) return; throw e }
    let probe = abs
    for (;;) {
      try {
        const real = await fs.realpath(probe)
        if (!inside(real, realRoot)) throw new Error('Plugin storage path leaves its folder')
        return
      } catch (e) {
        if (!isMissing(e)) throw e
        const up = path.dirname(probe)
        if (up === probe || !inside(up, root)) return
        probe = up
      }
    }
  }

  /** 同步那半:规整路径、定层、拼绝对路径(改动要在调用当下就排进队,不能等真实路径核完再排)。 */
  const locate = (id: string, vault: string | undefined, raw: unknown, opts: { allowRoot?: boolean } = {}): { abs: string; rel: string; layer: string; root: string } => {
    const rel = normalizeStoragePath(raw, { allowRoot: opts.allowRoot, appLayer: vault === undefined })
    const layer = layerRoot(id, vault)
    const abs = rel ? path.join(layer, ...rel.split('/')) : layer
    return { abs, rel, layer, root: pluginRoot(id) }
  }

  const resolve = async (id: string, vault: string | undefined, raw: unknown, opts: { allowRoot?: boolean } = {}): Promise<{ abs: string; rel: string; layer: string }> => {
    const loc = locate(id, vault, raw, opts)
    await assertReal(loc.abs, loc.root)
    return loc
  }

  const toBytes = (data: unknown): Uint8Array => {
    if (typeof data === 'string') return new TextEncoder().encode(data)
    if (data instanceof Uint8Array) return data
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    throw new TypeError('Plugin storage data must be a string, Uint8Array or ArrayBuffer')
  }

  /** 临时文件独占新建(`wx`:同名已有 → 失败,不盖别人的、不跟软链)再换名;只清自己建出来的那个临时文件。 */
  const atomicWrite = async (abs: string, bytes: Uint8Array): Promise<void> => {
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const tmp = tempOf(abs)
    let created = false
    try {
      await fs.writeFile(tmp, bytes, { flag: 'wx' })
      created = true
      await fs.rename(tmp, abs)
    } catch (e) {
      if (created) await fs.rm(tmp, { force: true }).catch(() => {})
      throw e
    }
  }

  const walkSizes = async (dir: string, onFile: (abs: string, size: number) => void): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch (e) { if (isMissing(e)) return; throw e }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) await walkSizes(abs, onFile)
      else if (e.isFile()) onFile(abs, (await fs.stat(abs)).size)
    }
  }

  /** 两层的 cache/:根上一个,每个库分区一个。只认真文件夹(叫 cache 的普通文件、软链都不算,清缓存不碰它们)。 */
  const cacheDirs = async (root: string): Promise<string[]> => {
    const out: string[] = []
    if (await isRealDir(path.join(root, STORAGE_CACHE_DIR))) out.push(path.join(root, STORAGE_CACHE_DIR))
    const vaults = path.join(root, STORAGE_VAULTS_DIR)
    if (await isRealDir(vaults)) {
      for (const e of await fs.readdir(vaults, { withFileTypes: true })) {
        const c = path.join(vaults, e.name, STORAGE_CACHE_DIR)
        if (e.isDirectory() && await isRealDir(c)) out.push(c)
      }
    }
    return out
  }

  async function usage(id: string): Promise<PluginStorageUsage> {
    const root = pluginRoot(id)
    const caches = await cacheDirs(root)
    let bytes = 0, cacheBytes = 0
    await walkSizes(root, (abs, size) => {
      bytes += size
      if (caches.some((c) => inside(abs, c))) cacheBytes += size
    })
    return { bytes, cacheBytes }
  }

  /** 把核过的临时文件**独占**发布到目标(硬链接:目标已有就 EEXIST,不会盖掉引擎半身同时写进来的文件)。
   *  文件系统不支持硬链接时退回「再看一眼目标不在就换名」。返回 true = 发布了;false = 目标已有(由调用方比内容)。 */
  const publishExclusive = async (tmp: string, dest: string): Promise<boolean> => {
    try {
      await fs.link(tmp, dest)
      return true
    } catch (e) {
      if (codeOf(e) === 'EEXIST') return false
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK', 'ENOSYS'].includes(codeOf(e) ?? '')) throw e
    }
    try { await fs.lstat(dest); return false } catch (e) { if (!isMissing(e)) throw e }
    await fs.rename(tmp, dest)
    return true
  }

  async function importFromVault(raw: Extract<PluginStorageRequest, { op: 'import' }>): Promise<PluginStorageImportResult> {
    const migration = String(raw.migration ?? '')
    if (!STORAGE_MIGRATION_ID.test(migration)) throw new TypeError('Invalid migration id')
    const into: 'app' | 'vault' = raw.into === 'vault' ? 'vault' : 'app'
    const vaultRoot = deps.vaultRoot()
    if (!vaultRoot || vaultRoot !== raw.vault) throw new Error('Vault changed before importing into plugin storage')
    // 来源:库内相对路径,必须在宿主给的本插件文件夹(工作文件夹 / Plugins/<id> / Plugins/<旧显示名>)之内
    const from = normalizeStoragePath(raw.from)
    const allowed = (Array.isArray(raw.allowed) ? raw.allowed : []).flatMap((a) => { try { return [normalizeStoragePath(a)] } catch { return [] } })
    if (!allowed.some((a) => from === a || from.startsWith(`${a}/`))) throw new Error("Import source must be inside this plugin's working folder")
    const root = pluginRoot(raw.id)
    const vaultLayer = layerRoot(raw.id, vaultRoot)
    const target = await resolve(raw.id, into === 'vault' ? vaultRoot : undefined, raw.to ?? '', { allowRoot: true })
    const logFile = path.join(vaultLayer, STORAGE_IMPORTS_DIR, `${migration}.json`)
    // 完成记录:只有「确实没有」(ENOENT)才算没做过。读不出来、不是合法 JSON、内容认不得 → 抛(读失败 ≠ 没做过,不能据此再盖一遍)
    let logText: string | null = null
    try { logText = await fs.readFile(logFile, 'utf8') } catch (e) { if (codeOf(e) !== 'ENOENT') throw e }
    if (logText !== null) {
      const log = JSON.parse(logText) as { status?: string; copied?: number; skipped?: string[] } | null
      if (log?.status !== 'complete') throw new Error(`Unrecognised import record for "${migration}"`)
      return { status: 'already-done', copied: Number(log.copied) || 0, skipped: Array.isArray(log.skipped) ? log.skipped : [] }
    }
    const srcRoot = path.resolve(vaultRoot, ...from.split('/'))
    const [realSrc, realVault] = await Promise.all([fs.realpath(srcRoot).catch((e) => { if (isMissing(e)) return null; throw e }), fs.realpath(vaultRoot)])
    if (realSrc === null) return { status: 'missing', copied: 0, skipped: [] }
    if (!inside(realSrc, realVault)) throw new Error('Import source leaves the vault')
    const files: Array<{ src: string; rel: string }> = []
    const st = await fs.stat(srcRoot)
    if (st.isFile()) {
      if (!target.rel) throw new TypeError('Importing a single file needs a target file path')
      files.push({ src: srcRoot, rel: '' })
    } else {
      const walk = async (dir: string, prefix: string): Promise<void> => {
        for (const e of await fs.readdir(dir, { withFileTypes: true })) {
          const abs = path.join(dir, e.name), rel = prefix ? `${prefix}/${e.name}` : e.name
          if (e.isDirectory()) await walk(abs, rel)
          else if (e.isFile()) files.push({ src: abs, rel }) // 软链不跟:可能指到库外
        }
      }
      await walk(srcRoot, '')
    }
    let copied = 0
    const skipped: string[] = []
    for (const f of files) {
      const dest = f.rel ? path.join(target.abs, ...f.rel.split('/')) : target.abs
      const destRel = [target.rel, f.rel].filter(Boolean).join('/')
      // 落点第一段撞上宿主保留的文件夹(跟应用那层的 vaults/、库那层的完成记录;不分大小写)→ 不写,当跳过报回去
      const head = destRel.split('/')[0].toLowerCase()
      if ((into === 'app' && head === STORAGE_VAULTS_DIR) || (into === 'vault' && head === STORAGE_IMPORTS_DIR)) { skipped.push(destRel); continue }
      await assertReal(dest, root)
      const srcHash = await hashFile(f.src)
      let destHash: string | null = null
      try { destHash = await hashFile(dest) } catch (e) { if (codeOf(e) !== 'ENOENT') throw e }
      if (destHash === null) {
        await fs.mkdir(path.dirname(dest), { recursive: true })
        const tmp = tempOf(dest)
        let created = false
        let published = false
        try {
          await fs.copyFile(f.src, tmp, fsConstants.COPYFILE_EXCL)
          created = true
          if (await hashFile(tmp) !== srcHash) throw new Error(`Copy of ${f.rel || path.basename(f.src)} does not match its source`)
          published = await publishExclusive(tmp, dest)
        } finally {
          if (created) await fs.rm(tmp, { force: true }).catch(() => {})
        }
        if (published) { copied++; continue }
        destHash = await hashFile(dest) // 复制途中别人(引擎半身)先写进来了:按「已经有」比
      }
      if (destHash === srcHash) copied++
      else skipped.push(destRel)
    }
    await atomicWrite(logFile, new TextEncoder().encode(`${JSON.stringify({ status: 'complete', migration, from, to: target.rel, into, copied, skipped, at: new Date().toISOString() }, null, 2)}\n`))
    return { status: 'complete', copied, skipped }
  }

  async function handle(req: PluginStorageRequest): Promise<unknown> {
    if (!req || typeof req !== 'object') throw new TypeError('Bad plugin storage request')
    const { id, vault } = req
    switch (req.op) {
      case 'readText':
      case 'readBytes': {
        const { abs } = await resolve(id, vault, req.path)
        try {
          const buf = await fs.readFile(abs)
          return req.op === 'readText' ? buf.toString('utf8') : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        } catch (e) {
          if (codeOf(e) === 'ENOENT') return null
          throw e
        }
      }
      case 'write': {
        const { abs, root } = locate(id, vault, req.path)
        const bytes = toBytes(req.data)
        return serial(root, async () => { await assertReal(abs, root); await atomicWrite(abs, bytes) })
      }
      case 'append': {
        const { abs, root } = locate(id, vault, req.path)
        const bytes = toBytes(req.data)
        return serial(root, async () => { await assertReal(abs, root); await fs.mkdir(path.dirname(abs), { recursive: true }); await fs.appendFile(abs, bytes) })
      }
      case 'list': {
        const { abs, rel } = await resolve(id, vault, req.path ?? '', { allowRoot: true })
        let entries: import('node:fs').Dirent[]
        try { entries = await fs.readdir(abs, { withFileTypes: true }) } catch (e) {
          if (codeOf(e) === 'ENOENT') return []
          throw e
        }
        const out: PluginStorageEntry[] = []
        for (const e of entries) {
          const lower = e.name.toLowerCase()
          if (!rel && vault === undefined && lower === STORAGE_VAULTS_DIR) continue // 库分区不在跟应用那一层露面
          if (!rel && vault !== undefined && lower === STORAGE_IMPORTS_DIR) continue
          if (TEMP_NAME.test(e.name)) continue // 写到一半的临时文件
          if (!e.isFile() && !e.isDirectory()) continue // 软链等不列
          let s: import('node:fs').Stats
          try { s = await fs.stat(path.join(abs, e.name)) } catch (err) {
            if (codeOf(err) === 'ENOENT') continue // 列的当中刚被删掉
            throw err // 别的读错误不当「没有这个文件」
          }
          out.push({ name: e.name, path: rel ? `${rel}/${e.name}` : e.name, kind: e.isDirectory() ? 'folder' : 'file', size: e.isDirectory() ? 0 : s.size, mtime: s.mtimeMs })
        }
        return out.sort((a, b) => a.name.localeCompare(b.name))
      }
      case 'stat': {
        const { abs } = await resolve(id, vault, req.path)
        try {
          const s = await fs.stat(abs)
          return { kind: s.isDirectory() ? 'folder' : 'file', size: s.isDirectory() ? 0 : s.size, mtime: s.mtimeMs } satisfies PluginStorageStat
        } catch (e) {
          if (codeOf(e) === 'ENOENT') return null
          throw e
        }
      }
      case 'remove': {
        const { abs, root } = locate(id, vault, req.path)
        return serial(root, async () => { await assertReal(abs, root); await fs.rm(abs, { recursive: true, force: true }) })
      }
      case 'move': {
        const from = locate(id, vault, req.path)
        const to = locate(id, vault, req.to)
        return serial(from.root, async () => {
          await assertReal(from.abs, from.root)
          await assertReal(to.abs, to.root)
          if (from.abs === to.abs) return
          if (inside(to.abs, from.abs)) throw new Error('Cannot move a folder into itself')
          try { await fs.lstat(to.abs); throw Object.assign(new Error(`Target already exists: ${to.rel}`), { code: 'EEXIST' }) } catch (e) {
            if (codeOf(e) === 'EEXIST') throw e
            if (!isMissing(e)) throw e
          }
          await fs.mkdir(path.dirname(to.abs), { recursive: true })
          await fs.rename(from.abs, to.abs)
        })
      }
      case 'usage':
        return usage(id)
      case 'clearCache': {
        const root = pluginRoot(id)
        return serial(root, async () => {
          for (const dir of await cacheDirs(root)) await fs.rm(dir, { recursive: true, force: true })
          return usage(id)
        })
      }
      case 'reveal': {
        const root = pluginRoot(id)
        try { await fs.access(root) } catch { return false }
        await deps.openFolder?.(root)
        return true
      }
      case 'import': {
        const root = pluginRoot(id)
        return serial(root, () => importFromVault(req))
      }
      default:
        throw new TypeError(`Unknown plugin storage op: ${String((req as { op?: unknown }).op)}`)
    }
  }

  return { handle, pluginRoot, usage }
}

/** 资源协议里的插件数据地址:`amadeus-asset://plugin-data/<id>/<相对插件数据根的路径>`。路径已解码。越界 / 坏 id → null。 */
export function resolvePluginDataAsset(base: string, pathname: string): string | null {
  const parts = pathname.replace(/^\/+/, '').split('/')
  const id = parts.shift() ?? ''
  if (!SAFE_PLUGIN_ID.test(id) || !parts.length) return null
  let rel: string
  try { rel = normalizeStoragePath(parts.join('/')) } catch { return null }
  const root = path.join(base, id)
  const abs = path.join(root, ...rel.split('/'))
  return inside(abs, root) ? abs : null
}
