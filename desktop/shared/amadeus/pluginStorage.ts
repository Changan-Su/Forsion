/**
 * 插件数据文件夹(ctx.storage,2026-11-26)三端共用的纯函数与请求形状。
 * 落点:桌面 `<tanguDataDir>/plugin-data/<生效插件 ID>/`(= 同 ID 引擎插件的 paths.dataDir;捆绑包里引擎那半用
 * paths.bundleDataDir 指过来),手机 `Data/plugin-data/<id>/`。智库外、不同步;`vaults/<库标识>/` 是跟库走的那一层,
 * `cache/` 是可清的缓存。方案:docs/ToBeImproved/插件数据目录方案_2026-11-26(仓根)。
 */

/** 宿主给 vault() 那一层用的顶层目录名:跟应用走的那一层写不进去。 */
export const STORAGE_VAULTS_DIR = 'vaults'
/** 约定的缓存文件夹(每一层各一个):「清空缓存」只清它。 */
export const STORAGE_CACHE_DIR = 'cache'
/** 「复制进来」的完成记录放在库那一层的这个文件夹里(每次迁移一份 JSON)。 */
export const STORAGE_IMPORTS_DIR = '.forsion-imports'

/** 在线库开着时「从库里复制进来」的固定错误:来源是库里的文件夹,在线库在这台没有本机文件夹可读。
 *  不回 missing —— 插件可能把 missing 当成「没有旧数据」、记成迁移做完了(读失败 ≠ 空)。 */
export const STORAGE_IMPORT_NEEDS_LOCAL = 'Plugin storage import needs a local vault'

/** 迁移 id:只许 ASCII 小写短名,直接拼进文件名。 */
export const STORAGE_MIGRATION_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

/**
 * 规整插件给的相对路径:`\` 按 `/` 看,去掉末尾斜杠;`/` 开头(绝对路径 / UNC)、盘符、空段、`.`、`..`、NUL 一律拒
 * (插件把系统绝对路径误传进来时当场报错,不悄悄落进一个怪子目录)。
 * `''` 只在 allowRoot 时收(list / usage 看整层)。appLayer === true(跟应用那层)第一段不许叫 `vaults`(库分区);
 * appLayer === false(库那层)第一段不许叫 `.forsion-imports`(复制进来的完成记录)。都不分大小写;不传 appLayer 不查保留名。
 * 返回规整后的 `a/b/c`(根 = '')。拒绝时抛 TypeError,消息里不回显整条路径以外的东西。
 */
export function normalizeStoragePath(raw: unknown, opts: { allowRoot?: boolean; appLayer?: boolean } = {}): string {
  if (typeof raw !== 'string') throw new TypeError('Plugin storage path must be a string')
  if (raw.includes('\0')) throw new TypeError('Plugin storage path contains NUL')
  const s = raw.replace(/\\/g, '/')
  if (/^[a-zA-Z]:/.test(s) || s.startsWith('/')) throw new TypeError(`Plugin storage paths are relative: ${raw}`)
  const trimmed = s.replace(/\/+$/g, '')
  if (!trimmed) {
    if (opts.allowRoot) return ''
    throw new TypeError('Plugin storage path is empty')
  }
  const parts = trimmed.split('/')
  for (const p of parts) {
    if (!p || p === '.' || p === '..') throw new TypeError(`Plugin storage path leaves its folder: ${raw}`)
  }
  // 保留名按不分大小写比:mac / Windows 的缺省卷不分大小写,`Vaults/` 就是 `vaults/`
  const head = parts[0].toLowerCase()
  if (opts.appLayer === true && head === STORAGE_VAULTS_DIR) {
    throw new TypeError(`"${STORAGE_VAULTS_DIR}/" is reserved for ctx.storage.vault(); use another folder name`)
  }
  if (opts.appLayer === false && head === STORAGE_IMPORTS_DIR) {
    throw new TypeError(`"${STORAGE_IMPORTS_DIR}/" is reserved for importFromVault records`)
  }
  return parts.join('/')
}

/**
 * 库分区标识:库根路径(主进程 / 渲染层看到的同一个字符串)的两路 32 位 FNV-1a(不同起始值)拼成 16 位十六进制。
 * 同步可算(url() 要同步返回),桌面 / 手机 / 渲染层同一份;不用 BigInt(手机旧 WebView)。不是安全边界,只是给每个库
 * 分一个稳定的文件夹名:在 Forsion 外挪了库的位置 = 新标识,旧那份留着。
 */
export function storageVaultKey(root: string): string {
  const bytes = new TextEncoder().encode(String(root))
  let a = 0x811c9dc5, b = 0x050c5d1f
  for (const x of bytes) {
    a = Math.imul(a ^ x, 0x01000193) >>> 0
    b = Math.imul(b ^ x, 0x01000193) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

/** 一层(跟应用 / 跟某个库)里相对插件数据文件夹根的前缀:跟应用 = '',库 = `vaults/<key>`。 */
export const storageLayerPrefix = (vaultRoot?: string | null): string =>
  vaultRoot ? `${STORAGE_VAULTS_DIR}/${storageVaultKey(vaultRoot)}` : ''

export interface PluginStorageEntry {
  name: string
  /** 相对这一层的路径(`/` 分隔)。 */
  path: string
  kind: 'file' | 'folder'
  /** 文件字节数;文件夹为 0。 */
  size: number
  /** 修改时间(毫秒)。 */
  mtime: number
}

export interface PluginStorageStat { kind: 'file' | 'folder'; size: number; mtime: number }

export interface PluginStorageImportResult {
  /** complete = 这次复制完了;already-done = 这个库之前做过(同一个迁移 id);missing = 库里没有这个来源,什么都没记。 */
  status: 'complete' | 'already-done' | 'missing'
  /** 复制了几个文件(already-done 时是当初那次的数)。 */
  copied: number
  /** 目标已经有、内容又不一样而没覆盖的(相对这一层的路径)。 */
  skipped: string[]
}

/**
 * 渲染层 → 宿主桥的一次请求(桌面走一条 IPC,手机走 pluginHost)。`vault` 有值 = 库那一层,宿主核对它仍是当前库。
 * 写类的 data:字符串按 UTF-8 存。路径都是**相对这一层**、未加前缀的;宿主自己规整、加前缀、钳在文件夹里。
 */
export type PluginStorageRequest = { id: string; vault?: string } & (
  | { op: 'readText' | 'readBytes' | 'stat' | 'remove'; path: string }
  | { op: 'list'; path?: string }
  | { op: 'write' | 'append'; path: string; data: string | Uint8Array }
  | { op: 'move'; path: string; to: string }
  | { op: 'usage' }
  | { op: 'import'; vault: string; from: string; to: string; migration: string; allowed: string[]; into: 'app' | 'vault' }
  // 本机绝对路径(交给本机托管引擎上的 Agent / 脚本用);渲染层先过「本机执行」那道门,宿主只算路径、不建文件夹
  | { op: 'hostPath'; path?: string }
  // 宿主界面自己用的(插件详情页),不挂到 ctx 上
  | { op: 'clearCache' }
  | { op: 'reveal' }
)

export interface PluginStorageUsage {
  /** 整个插件数据文件夹(两层都算)的字节数;文件夹不存在 = 0。 */
  bytes: number
  /** 其中各层 cache/ 的字节数。 */
  cacheBytes: number
}
