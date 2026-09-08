/** 按条目云同步的渲染端状态:注册表镜像 + 每绑定最新引擎状态(status 事件按 binding 键分存)。
 *  数据源 = window.amadeusSync.entrySync*(仅桌面;web/mobile 缺位时一切 UI 优雅隐藏)。 */
import { create } from 'zustand'
import { coversPath, nfcRel } from '@amadeus-shared/entrySync'
import type { AmadeusEntrySyncVault, AmadeusSyncStatus } from '../types'

interface EntrySyncStore {
  vaults: AmadeusEntrySyncVault[]
  activeRoot: string | null
  /** 云镜像里已成型的「同步 Vault 文件夹」名。注册表是每机本地的,换设备后只剩这一个来源。 */
  mirrorVaults: string[]
  /** binding(vault 根绝对路径)→ 该条目绑定引擎的最新状态。 */
  status: Record<string, AmadeusSyncStatus>
  refresh(): Promise<void>
}

export const useEntrySync = create<EntrySyncStore>((set) => ({
  vaults: [],
  activeRoot: null,
  mirrorVaults: [],
  status: {},
  async refresh() {
    const api = window.amadeusSync
    if (!api?.entrySyncGet) return
    try {
      const st = await api.entrySyncGet()
      set({ vaults: st.vaults, activeRoot: st.activeRoot, mirrorVaults: st.mirrorVaults ?? [] })
    } catch {
      /* 旧主进程构建无此接口:保持空 */
    }
  },
}))

let subscribed = false
/** 幂等订阅注册表变更 + 绑定状态事件(首个消费组件挂载时调一次)。 */
export function ensureEntrySyncSubscribed(): void {
  if (subscribed) return
  subscribed = true
  const api = window.amadeusSync
  void useEntrySync.getState().refresh()
  api?.onEntrySyncChange?.(() => void useEntrySync.getState().refresh())
  api?.onStatus?.((s) => {
    const b = (s as AmadeusSyncStatus).binding
    if (b) useEntrySync.setState((st) => ({ status: { ...st.status, [b]: s as AmadeusSyncStatus } }))
  })
}

/** path 是否在当前 vault 的同步范围内 —— 显式条目**或**被覆盖(文件夹子树 / 页面 .fd 子页面),
 *  减去 exclude。判据与主进程引擎 scope 同源(@amadeus-shared/entrySync),否则子页面明明在同步、
 *  UI 却显示「未同步」。 */
export function isSyncedEntry(vaultRoot: string | null, path: string): boolean {
  if (!vaultRoot) return false
  const rec = useEntrySync.getState().vaults.find((v) => v.vaultRoot === vaultRoot)
  return !!rec && coversPath(rec.entries, rec.exclude, path)
}

/** 本地侧路径 → 云端 vault 里的真实路径(`<云名>/<path>`);未开启按条目同步 → null。
 *  共享/发布的对象是**云端文件**:本地侧直接拿 `path` 去建 share,服务端不校验存在性,链接生成了
 *  却 404(2026-09-06 用户实报「本地文件能点发布,链接没权限」)。云侧(桌面 Cloud / web / mobile)
 *  路径本来就是云端路径,原样返回。纯函数,vaults 由调用方从 store 取(便于单测)。 */
export function cloudPathFor(
  vaults: AmadeusEntrySyncVault[],
  vaultRoot: string | null,
  vaultSide: 'local' | 'cloud',
  path: string,
): string | null {
  if (!window.amadeusSync || vaultSide === 'cloud') return nfcRel(path) // 云侧路径已是云端路径,但仍钉 NFC/去前导 ./
  if (!vaultRoot) return null
  const rec = vaults.find((v) => v.vaultRoot === vaultRoot)
  if (!rec || !coversPath(rec.entries, rec.exclude, path)) return null
  return `${rec.cloudName}/${nfcRel(path)}`
}

/** path 是否落在某条排除项的子树里(开启弹窗据此把上次剔除的子页面显示成未勾选,而不是一律全勾)。 */
export function isExcludedPath(vaultRoot: string | null, path: string): boolean {
  const rec = vaultRoot ? useEntrySync.getState().vaults.find((v) => v.vaultRoot === vaultRoot) : null
  if (!rec?.exclude?.length) return false
  const p = nfcRel(path)
  return rec.exclude.some((exRaw) => {
    const x = nfcRel(exRaw)
    return !!x && (p === x || p.startsWith(`${x}/`) || p.startsWith(`${x.replace(/\.md$/i, '')}.fd/`))
  })
}
