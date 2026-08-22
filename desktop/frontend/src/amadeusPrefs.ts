/** 收藏 / 最近(每 vault 一份,localStorage):渲染时对 pages 过滤 → 已删除的自然消失。
 *  ponytail: 重命名/移动不做路径重映射(条目失效即自动隐藏),需要时再补 remap。 */
import { create } from 'zustand'
import { noteOf, usePageStore } from '@amadeus/store/pageStore'
import { setRecentsProvider } from '@amadeus/lib/recents'

export interface Collection { name: string; query: string }
interface Prefs { starred: string[]; recents: string[]; collections: Collection[]; pins: string[] }
interface PrefsState extends Prefs {
  toggleStar(path: string): void
  /** 置顶(每 vault 一份,不进 frontmatter:fm 会随云同步跟文件走,导致本地/云端两侧共享置顶)。 */
  togglePin(path: string): void
  pushRecent(path: string): void
  /** 集合 = 保存的全文搜索(同名覆盖)。 */
  saveCollection(name: string, query: string): void
  removeCollection(name: string): void
}

const RECENT_CAP = 20

const storageKey = (): string | null => {
  const r = usePageStore.getState().vaultRoot
  return r ? `amadeus_prefs:${r}` : null
}
const load = (): Prefs => {
  try {
    const k = storageKey()
    const v = k && localStorage.getItem(k)
    if (v) {
      const p = JSON.parse(v) as Partial<Prefs>
      return {
        starred: Array.isArray(p.starred) ? p.starred : [],
        recents: Array.isArray(p.recents) ? p.recents : [],
        collections: Array.isArray(p.collections) ? p.collections : [],
        pins: Array.isArray(p.pins) ? p.pins : [],
      }
    }
  } catch { /* ignore */ }
  return { starred: [], recents: [], collections: [], pins: [] }
}
const persist = (p: Prefs): void => {
  try {
    const k = storageKey()
    if (k) localStorage.setItem(k, JSON.stringify(p))
  } catch { /* ignore */ }
}

const snapshot = (s: PrefsState): Prefs => ({ starred: s.starred, recents: s.recents, collections: s.collections, pins: s.pins })

export const useAmadeusPrefs = create<PrefsState>((set, get) => ({
  starred: [],
  recents: [],
  collections: [],
  pins: [],
  toggleStar: (path) => {
    const starred = get().starred.includes(path) ? get().starred.filter((p) => p !== path) : [...get().starred, path]
    set({ starred })
    persist({ ...snapshot(get()), starred })
  },
  togglePin: (path) => {
    const pins = get().pins.includes(path) ? get().pins.filter((p) => p !== path) : [...get().pins, path]
    set({ pins })
    persist({ ...snapshot(get()), pins })
  },
  pushRecent: (path) => {
    const recents = [path, ...get().recents.filter((p) => p !== path)].slice(0, RECENT_CAP)
    set({ recents })
    persist({ ...snapshot(get()), recents })
  },
  saveCollection: (name, query) => {
    const collections = [...get().collections.filter((c) => c.name !== name), { name, query }]
    set({ collections })
    persist({ ...snapshot(get()), collections })
  },
  removeCollection: (name) => {
    const collections = get().collections.filter((c) => c.name !== name)
    set({ collections })
    persist({ ...snapshot(get()), collections })
  },
}))

// vault 切换 → 载入该 vault 的偏好;笔记切换 → 记最近。
usePageStore.subscribe((s, p) => {
  if (s.vaultRoot !== p.vaultRoot) useAmadeusPrefs.setState(load())
  // v4 笔记不设 activePage → 经 noteOf 取,否则 v4 笔记永远进不了「最近打开」
  // (@ 提及的候选排序也取这份)。pushRecent 自带去重,v3 双路径同值不会记两条。
  const cur = noteOf(s)
  if (cur && cur !== noteOf(p)) useAmadeusPrefs.getState().pushRecent(cur)
})

// 供 vendored 层(@ 提及的候选排序)取「最近打开」,不倒转依赖方向。
setRecentsProvider(() => useAmadeusPrefs.getState().recents)
