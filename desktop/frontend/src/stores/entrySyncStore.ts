/** 按条目云同步的渲染端状态:注册表镜像 + 每绑定最新引擎状态(status 事件按 binding 键分存)。
 *  数据源 = window.amadeusSync.entrySync*(仅桌面;web/mobile 缺位时一切 UI 优雅隐藏)。 */
import { create } from 'zustand'
import { coversPath, nfcRel } from '@amadeus-shared/entrySync'
import type { AmadeusEntrySyncVault, AmadeusSyncStatus } from '../types'

interface EntrySyncStore {
  vaults: AmadeusEntrySyncVault[]
  activeRoot: string | null
  /** binding(vault 根绝对路径)→ 该条目绑定引擎的最新状态。 */
  status: Record<string, AmadeusSyncStatus>
  refresh(): Promise<void>
}

export const useEntrySync = create<EntrySyncStore>((set) => ({
  vaults: [],
  activeRoot: null,
  status: {},
  async refresh() {
    const api = window.amadeusSync
    if (!api?.entrySyncGet) return
    try {
      const st = await api.entrySyncGet()
      set({ vaults: st.vaults, activeRoot: st.activeRoot })
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
