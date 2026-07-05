/** Ribbon 注册表(≈ Obsidian addRibbonIcon)。zustand store,Ribbon 组件订阅。
 *  另承载 ribbon 自身的展开态 + 顶部图标用户自定义顺序(均持久化 localStorage)。 */
import { create } from 'zustand'
import type { RibbonItem } from './types'

const EXPANDED_KEY = 'forsion_tangu_ribbon_expanded'
const ORDER_KEY = 'forsion_tangu_ribbon_order'

function loadExpanded(): boolean {
  try { return localStorage.getItem(EXPANDED_KEY) === '1' } catch { return false }
}
function loadOrder(): string[] {
  try { const v = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] } catch { return [] }
}

interface RibbonState {
  items: RibbonItem[]
  /** 展开 = 图标 + 名称(宽条);折叠 = 纯图标(默认)。 */
  expanded: boolean
  /** 顶部图标的用户自定义顺序(item id);未列出的新图标按注册序追加在后。 */
  order: string[]
  addRibbonIcon(item: RibbonItem): void
  removeRibbonIcon(id: string): void
  toggleExpanded(): void
  setOrder(ids: string[]): void
}

export const useRibbonStore = create<RibbonState>((set) => ({
  items: [],
  expanded: loadExpanded(),
  order: loadOrder(),
  addRibbonIcon: (item) =>
    set((s) => ({ items: [...s.items.filter((i) => i.id !== item.id), item] })),
  removeRibbonIcon: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  toggleExpanded: () => set((s) => {
    const expanded = !s.expanded
    try { localStorage.setItem(EXPANDED_KEY, expanded ? '1' : '0') } catch { /* ignore */ }
    return { expanded }
  }),
  setOrder: (ids) => {
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(ids)) } catch { /* ignore */ }
    set({ order: ids })
  },
}))

export const addRibbonIcon = (item: RibbonItem): void => useRibbonStore.getState().addRibbonIcon(item)
export const removeRibbonIcon = (id: string): void => useRibbonStore.getState().removeRibbonIcon(id)

/** 顶部图标按用户保存的顺序排列;未在 order 里的新图标按注册序追加在末尾。 */
export function orderTopItems(items: RibbonItem[], order: string[]): RibbonItem[] {
  const top = items.filter((i) => (i.side ?? 'top') === 'top')
  const rank = new Map(order.map((id, i) => [id, i] as const))
  return top
    .map((it, i) => ({ it, k: rank.has(it.id) ? rank.get(it.id)! : order.length + i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.it)
}
