/**
 * 云端桥(cloudBridge)的「库视图」:打开的是哪个库、以哪个前缀为根、哪些前缀不显示,以及分库(vault-moved)/
 * 删库(vault-deleted / 410)以后交给上层的状态(智库同步第 3 步,契约 step34 §3.3「原位置库以 X/ 为根」、§3.9、P-8 二-3)。
 *
 * 前缀有三种写法,一律经 httpPrefix 归一成 HTTP 子树前缀 `X/`(默认库 / 整库 = ''):
 *   - `/libraries` 的 `prefix` 是 content 前缀 `Amadeus/X/`;
 *   - 写回 409 / SSE `vault-moved` / 树的 `moved[]` 是 HTTP 前缀 `X/`;
 *   - 搜索的 `?prefix=` 收 `X` 或 `X/`。
 * 桥里的记账(seq、见过的路径、别名、写队列的键)一律是视图里的相对路径,只在发请求 / 收回包那一层换算(toWire / fromWire)。
 */
import { contentStorageKey } from '@lcl/engine/contentStorageScope'

/** 能力头(请求头 X-Content-Caps;SSE 设不了头,走 `?caps=`)。声明了 vault-moves,写到分走的前缀上服务端回 409 VAULT_MOVED 而不是 423。 */
export const CLOUD_CONTENT_CAPS = 'vaults,vault-moves'

/** 切库新键:存 libraryId(契约 §3.9)。读不到再退回老键 ACTIVE_VAULT_KEY(存 vault id)。 */
export const ACTIVE_LIBRARY_KEY = 'amadeus.cloudLibrary'
/** 老键:存 vault id。新版写库时两个都写(老键写所属 vault id),老版本的标签页 / 回退的网页照旧认得。 */
export const ACTIVE_VAULT_KEY = 'amadeus.cloudVaultId'

/** `/libraries` 的一项(server microserver/amadeus/services/libraries.ts 的 Library,只取桥用得着的)。 */
export interface LibraryDto {
  id: string
  kind: 'default' | 'own' | 'legacy'
  vaultId: string
  /** content 前缀:'Amadeus/' 或 'Amadeus/<X>/'。 */
  prefix: string
  name: string
  deleted?: { at: string; purgeAt: string }
  /** 分出来的独立库:原来在默认库的哪个前缀(content 前缀)。 */
  splitFrom?: { splitId?: string; vaultId: string; prefix: string; at?: string }
}

/** 一个桥实例当前打开的库视图。 */
export interface CloudLibraryIdentity {
  vaultId: string
  libraryId: string
  /** '' = 整库;'X/' = 原位置库,桥内路径 rel ↔ 服务端 `X/rel`。 */
  rootPrefix: string
}

export interface CloudLibraryScope extends CloudLibraryIdentity {
  /** 整库视图里不显示的前缀(原位置库、已经分走的):树、搜索、事件都滤掉。 */
  exclude: string[]
  /** 这个视图会不会碰上分库:默认库 / 原位置库会;独立库 / 别人共享的不会;老服务端(没有 /libraries)不会。 */
  movesPossible: boolean
}

export const sameLibrary = (a: CloudLibraryIdentity, b: CloudLibraryIdentity): boolean =>
  a.vaultId === b.vaultId && a.libraryId === b.libraryId && a.rootPrefix === b.rootPrefix

/** 三种写法 → HTTP 前缀 `X/`;整库 → ''。认不出的(带 `..`、空段)→ null。 */
export function httpPrefix(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  let p = raw.replace(/\\/g, '/').replace(/^\/+/, '')
  if (p === 'Amadeus' || p === 'Amadeus/') return ''
  if (p.startsWith('Amadeus/')) p = p.slice('Amadeus/'.length)
  p = p.replace(/\/+$/, '')
  if (!p) return ''
  if (p.split('/').some((seg) => !seg || seg === '.' || seg === '..')) return null
  return `${p}/`
}

/** path 落在前缀 P(`X/`)里:就是 `X` 本身,或在 `X/` 下面。 */
export const underPrefix = (path: string, prefix: string): boolean =>
  !!prefix && (path === prefix.slice(0, -1) || path.startsWith(prefix))

/** libraryId 属于哪个 vault:原位置库 `<vaultId>:Amadeus/X/`,其余就是 vaultId 本身。 */
export const vaultIdOfLibrary = (libraryId: string): string => {
  const i = libraryId.indexOf(':')
  return i > 0 ? libraryId.slice(0, i) : libraryId
}

/** 原位置库 id 的 content 前缀;不是原位置库 → null。 */
export const legacyPrefixOfLibrary = (libraryId: string): string | null => {
  const m = /^[^:]+:(Amadeus\/.+\/)$/.exec(libraryId)
  return m ? m[1] : null
}

/** Library ids identify both the owning vault and the exact view prefix. */
export function libraryRootPrefix(vaultId: string, libraryId: string): string | null {
  if (!vaultId || !libraryId) return null
  if (vaultId === libraryId && !legacyPrefixOfLibrary(libraryId)) return ''
  const prefix = httpPrefix(legacyPrefixOfLibrary(libraryId))
  return prefix && libraryId === `${vaultId}:Amadeus/${prefix}` ? prefix : null
}

/** 两个键按**当时的账号**作用域求出来。桥 / collab 装的时候各取一次留着:换号以后旧账号的回调只能写回旧账号自己的键。 */
export interface CloudLibraryKeys { library: string; vault: string }
export const cloudLibraryKeys = (): CloudLibraryKeys => ({ library: contentStorageKey(ACTIVE_LIBRARY_KEY), vault: contentStorageKey(ACTIVE_VAULT_KEY) })

/** 用户选的库(切库 / 深链 / 分库后跟过去都走这一个)。写新键 + 老键(老键写所属 vault id)。 */
export function rememberCloudLibrary(libraryId: string, keys: CloudLibraryKeys = cloudLibraryKeys()): void {
  if (!libraryId) return
  try {
    localStorage.setItem(keys.library, libraryId)
    localStorage.setItem(keys.vault, vaultIdOfLibrary(libraryId))
  } catch { /* 私有模式:本次照常,下次回落默认库 */ }
}

/** 读用户选的库:新键在、且老键没被别人改过(老键 = 新键所属的 vault)→ 新键;老键被老版本的标签页 / 只认老键的写法改过 → 老键
 *  (当 vault id 用,= 那个库的整库视图);都没有 → null。读失败当「没选过」(回落默认库,不写回)。 */
export function readCloudLibrary(keys: CloudLibraryKeys = cloudLibraryKeys()): string | null {
  try {
    const lib = localStorage.getItem(keys.library) || null
    const old = localStorage.getItem(keys.vault) || null
    if (lib && (!old || vaultIdOfLibrary(lib) === old)) return lib
    return old ?? lib
  } catch {
    return null
  }
}

export function followCloudLibraryMove(from: string, to: string, keys: CloudLibraryKeys): void {
  if (readCloudLibrary(keys) === from) rememberCloudLibrary(to, keys)
}

/** 网页深链(`?vault=&note=`,openTarget.ts)要打开的那一篇:地址里的 note 是服务端路径。桥选库时据此认出它落在某个原位置库里
 *  (云端笔记的视图把原位置库排除了,不换到那个库就打不开),openTargetWhenReady 再把它换算成视图路径。 */
let pendingOpen: { vault: string; note: string } | null = null
export function setPendingOpenNote(vault: string, note: string): void { pendingOpen = { vault, note } }
export const pendingOpenNote = (): { vault: string; note: string } | null => pendingOpen

// ---------------------------------------------------------------------------
// 交给上层的状态(B12 / E4):分库换了库、库被删进回收站。提示画法等用户定(方案图第 ⑫ 样),这里只出状态。
// ---------------------------------------------------------------------------

export type CloudLibraryState =
  | { kind: 'open'; vaultId: string; libraryId: string }
  /** 打开的这个库(或整库视图里的某个前缀)分成了独立的库。to = 现在写到哪里;整个视图搬走了时 reopen = true(上层该按新库重开)。 */
  | { kind: 'moved'; from: { vaultId: string; libraryId: string }; to: { vaultId: string; libraryId: string }; prefix: string; reopen: boolean }
  /** 库被删进回收站(410 VAULT_DELETED / SSE vault-deleted):桥已停写、停事件流,本机什么都没删。 */
  | { kind: 'deleted'; vaultId: string; libraryId: string; purgeAt: string | null }

let current: CloudLibraryState | null = null
const listeners = new Set<(s: CloudLibraryState) => void>()

/** 当前活动桥的库状态(没装桥 = null)。 */
export const cloudLibraryState = (): CloudLibraryState | null => current

/** 订阅库状态变化;回退订函数。只收活动桥的(旧账号 / 退役的桥不再发)。 */
export function onCloudLibraryState(cb: (s: CloudLibraryState) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** 桥内部用:发一条状态。 */
export function emitCloudLibraryState(s: CloudLibraryState | null): void {
  current = s
  if (!s) return
  for (const cb of [...listeners]) { try { cb(s) } catch { /* 单个订阅者抛错不影响别的 */ } }
}
