/** 待办清单视图偏好(按 vault 存 localStorage,不进 vault/git):时间窗 / 隐藏已完成 / 排序。 */
import { create } from 'zustand'
import type { TodoWindow } from '../../views/calendar/todoWindow'

export type TodoSort = 'date' | 'name' | 'done-first' | 'undone-first'
export interface TodoPrefs { win: TodoWindow; customDays: number; hideDone: boolean; sort: TodoSort }

const KEY = 'amadeus.todo.prefs'
const DEF: TodoPrefs = { win: 'week', customDays: 5, hideDone: false, sort: 'date' }

interface State {
  byVault: Record<string, Partial<TodoPrefs>>
  set(vault: string, patch: Partial<TodoPrefs>): void
}
const load = (): Record<string, Partial<TodoPrefs>> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, Partial<TodoPrefs>>
  } catch {
    return {}
  }
}
export const useTodoPrefs = create<State>((set) => ({
  byVault: load(),
  set: (vault, patch) =>
    set((s) => {
      const next = { ...s.byVault, [vault]: { ...s.byVault[vault], ...patch } }
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return { byVault: next }
    }),
}))
export const prefsOf = (vault: string, byVault: Record<string, Partial<TodoPrefs>>): TodoPrefs => ({ ...DEF, ...byVault[vault] })
