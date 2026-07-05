/** 状态栏注册表(≈ Obsidian addStatusBarItem)。zustand store,StatusBar 组件订阅。 */
import { create } from 'zustand'
import type { StatusItem } from './types'

interface StatusState {
  items: StatusItem[]
  addStatusItem(item: StatusItem): void
  removeStatusItem(id: string): void
}

export const useStatusStore = create<StatusState>((set) => ({
  items: [],
  addStatusItem: (item) =>
    set((s) => ({ items: [...s.items.filter((i) => i.id !== item.id), item] })),
  removeStatusItem: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}))

export const addStatusItem = (item: StatusItem): void => useStatusStore.getState().addStatusItem(item)
export const removeStatusItem = (id: string): void => useStatusStore.getState().removeStatusItem(id)
