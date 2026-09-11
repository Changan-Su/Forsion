import { useSyncExternalStore } from 'react'
import type { ModelInfo } from './types'

export interface ModelPickerPreferences {
  groups: Array<{ id: string; name: string }>
  assignments: Record<string, string>
  hidden: string[]
}
export const MODEL_PICKER_STORAGE_KEY = 'forsion_model_picker_v1'
const EMPTY: ModelPickerPreferences = { groups: [], assignments: {}, hidden: [] }

export function normalizePickerPreferences(value: unknown): ModelPickerPreferences {
  if (!value || typeof value !== 'object') return EMPTY
  const v = value as Partial<ModelPickerPreferences>
  const groups = Array.isArray(v.groups) ? v.groups.filter((g) => g && typeof g.id === 'string' && typeof g.name === 'string' && g.name.trim()).map((g) => ({ id: g.id, name: g.name.trim().slice(0, 100) })) : []
  const ids = new Set(groups.map((g) => g.id))
  const assignments = Object.fromEntries(Object.entries(v.assignments || {}).filter(([, id]) => typeof id === 'string' && (id === '' || ids.has(id))))
  return { groups: [...new Map(groups.map((g) => [g.id, g])).values()], assignments, hidden: Array.isArray(v.hidden) ? [...new Set(v.hidden.filter((x) => typeof x === 'string'))] : [] }
}
function read(): ModelPickerPreferences {
  try { return normalizePickerPreferences(JSON.parse(localStorage.getItem(MODEL_PICKER_STORAGE_KEY) || 'null')) } catch { return EMPTY }
}
let snapshot = read()
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (event.key === MODEL_PICKER_STORAGE_KEY || event.key === null) { snapshot = read(); listeners.forEach((fn) => fn()) }
})
export function useModelPickerPreferences(): ModelPickerPreferences {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY)
}
export function saveModelPickerPreferences(value: ModelPickerPreferences): void {
  const next = normalizePickerPreferences(value)
  // Persist before publishing, so a storage failure is visible to the editor.
  localStorage.setItem(MODEL_PICKER_STORAGE_KEY, JSON.stringify(next))
  snapshot = next
  listeners.forEach((fn) => fn())
}
export function isPickerModelVisible(model: ModelInfo, prefs: ModelPickerPreferences): boolean {
  return model.source === 'forsion' || !prefs.hidden.includes(model.id)
}

export interface PickerGroup {
  key: string; provider: string; source: 'forsion' | 'direct'; models: ModelInfo[]; order: number
}
/** The source is always the first level; groups never combine cloud and local models. */
export function groupPickerModels(models: ModelInfo[], prefs: ModelPickerPreferences = EMPTY): PickerGroup[] {
  const map = new Map<string, PickerGroup>()
  for (const model of models) {
    if (!isPickerModelVisible(model, prefs)) continue
    const cloud = model.source === 'forsion'
    const assignment = prefs.assignments[model.id]
    const localGroup = prefs.groups.find((g) => g.id === assignment)
    const id = cloud ? model.groupId || '' : localGroup?.id ?? (assignment === '' ? '' : `provider:${model.provider}`)
    const name = cloud ? model.groupName || '' : localGroup?.name ?? (assignment === '' ? '' : model.provider)
    const key = `${model.source}:${id}`
    let group = map.get(key)
    if (!group) {
      group = { key, provider: name, source: model.source, models: [], order: cloud ? model.groupSortOrder ?? 2147483647 : localGroup ? prefs.groups.indexOf(localGroup) : 2147483647 }
      map.set(key, group)
    }
    group.models.push(model)
  }
  return [...map.values()].sort((a, b) => (a.source === b.source ? 0 : a.source === 'forsion' ? -1 : 1) || a.order - b.order || a.provider.localeCompare(b.provider)).map((g) => ({ ...g, models: [...g.models].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)) }))
}
