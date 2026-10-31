// 与我共享的页面 + 当前活动库:左栏分区、编辑器参与者标记、范围外双链提示共用这一份。
import { create } from 'zustand'
import type { AmadeusSharedItem } from '../types'

interface SharedVaultState {
  items: AmadeusSharedItem[]
  activeVault: string
  ownVaults: string[]
  refresh(): Promise<void>
}

export const useSharedVault = create<SharedVaultState>((set) => ({
  items: [],
  activeVault: '',
  ownVaults: [],
  async refresh() {
    const collab = window.amadeusCollab
    if (!collab) return
    const [items, activeVault, vaults] = await Promise.all([
      collab.sharedWithMe().catch(() => null),
      collab.activeVaultId().catch(() => ''),
      collab.listVaults().catch(() => null),
    ])
    set((s) => ({ items: items ?? s.items, activeVault, ownVaults: vaults ? vaults.map((v) => v.id) : s.ownVaults }))
  },
}))

/** 活动库是别人的(Web 切到对方的库之后);桌面的共享在镜像里,永远是 false。 */
export function foreignVaultOwner(s: Pick<SharedVaultState, 'items' | 'activeVault' | 'ownVaults'>): AmadeusSharedItem | null {
  if (!s.activeVault || !s.ownVaults.length || s.ownVaults.includes(s.activeVault)) return null
  return s.items.find((it) => it.vaultId === s.activeVault) ?? null
}

const stemPrefix = (path: string): string => `${path.replace(/\.md$/i, '')}.fd/`
const covers = (root: string, path: string): boolean => path === root || path.startsWith(stemPrefix(root))

/** 这一页属于哪条共享;所有者自己的页面没有。path 是编辑器里的路径(桌面 = 镜像内路径)。 */
export function sharedEntryFor(s: Pick<SharedVaultState, 'items' | 'activeVault'>, path: string): AmadeusSharedItem | null {
  for (const it of s.items) {
    if (it.localPath) {
      if (path.startsWith(it.localPath.slice(0, it.localPath.lastIndexOf('/') + 1))) return it
    } else if (it.vaultId === s.activeVault && (covers(it.path, path) || it.items?.some((x) => covers(x, path)))) return it
  }
  return null
}
