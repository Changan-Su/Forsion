/** 哪些库的日历设置进随账号走的共享文件:只有「账号的同步库」,库键固定为 `sync`(服务端每个账号只有一个自有云端库,
 *  桌面新同步、网页、手机云端模式、绑了账号的 Unit 都对到这一份,库内相对路径一致)。
 *  · `cloud://<id>` 且是自己的库 → sync;别人共享给你的库 → 留本机。sharedVaultStore 的 ownVaults 没刷完(空)= 不知道,
 *    **不能当成自有库**(foreignVaultOwner 在 ownVaults 为空时也返回 null,那是另一回事)。
 *  · 桌面本地库:listVaults() 里 current 那一行的 sync === true → sync(别用 pinned:没开新同步时它也是 true);否则留本机。
 *    ⚠️ sync 只说明新同步开着、绑在这个库上,不检查笔记类是不是真的同步到所有设备共用(整类设成只备份这台时会误判);
 *    顶层文件夹单独设成只在某台设备的,里面的表在别的端不存在,键留着不生效。这一期不解决。
 *  · 手机本地 /vault、单独运行的 Unit(设备页)、没有 listVaults 的老主进程 → 留本机。
 *  · 账号:桌面取主进程随中转口给的账号 id,网页 / 手机从令牌解(accountStorageId)。拿不到 = 不知道(中转口还没到 / 没登录),
 *    不写共享那份;没登录时桌面本机引擎那份文件虽然也能读写,但它不同步,这一期不碰它 —— 留本机最保守。 */
import { useSharedVault } from '../../stores/sharedVaultStore'
import { accountStorageId } from '../../services/engine/targets'
import type { LocalVaultRow } from '@amadeus-shared/ipc'
import type { SettingsKey } from './calendarSettingsSync'

export interface KeyEnv {
  ownVaults(): string[]
  refreshOwnVaults(): void
  listVaults: (() => Promise<LocalVaultRow[]>) | null
  account(): string | null
  unitPage: boolean
}

const UNKNOWN: SettingsKey = { kind: 'unknown' }
const LOCAL: SettingsKey = { kind: 'local' }
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
const samePath = (a: string, b: string): boolean => {
  const x = norm(a), y = norm(b)
  return x === y || (/^[a-z]:\//i.test(x) && x.toLowerCase() === y.toLowerCase())
}

export async function resolveCalendarSettingsKey(root: string, env: KeyEnv = defaultKeyEnv()): Promise<SettingsKey> {
  if (!root) return UNKNOWN
  if (env.unitPage) return LOCAL
  const sync = (): SettingsKey => { const acct = env.account(); return acct ? { kind: 'sync', acct } : UNKNOWN }
  if (root.startsWith('cloud://')) {
    const own = env.ownVaults()
    if (!own.length) { env.refreshOwnVaults(); return UNKNOWN }
    return own.includes(root.slice('cloud://'.length)) ? sync() : LOCAL
  }
  if (!env.listVaults) return LOCAL
  let rows: unknown
  try { rows = await env.listVaults() } catch { return UNKNOWN }
  if (!Array.isArray(rows)) return UNKNOWN
  const cur = (rows as LocalVaultRow[]).find((r) => r && r.current === true)
  if (!cur) return LOCAL // 当前库不在本地清单里(托管的云端库等):不是同步库
  if (typeof cur.root !== 'string' || !samePath(cur.root, root)) return UNKNOWN // 刚换库那一拍,两边说的不是同一个库
  return cur.sync === true ? sync() : LOCAL
}

let refreshing = false
export function defaultKeyEnv(): KeyEnv {
  const w = typeof window !== 'undefined' ? window : undefined
  const list = w?.amadeus?.listVaults
  return {
    ownVaults: () => useSharedVault.getState().ownVaults,
    refreshOwnVaults: () => {
      if (refreshing) return
      refreshing = true
      void useSharedVault.getState().refresh().finally(() => { refreshing = false })
    },
    listVaults: typeof list === 'function' ? () => list.call(w!.amadeus) : null,
    account: () => accountStorageId(),
    unitPage: !!w?.tangu?.unitPage,
  }
}
