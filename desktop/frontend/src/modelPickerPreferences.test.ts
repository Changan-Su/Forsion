import { describe, it, expect } from 'vitest'
import { groupPickerModels, normalizePickerPreferences, isPickerModelVisible } from './modelPickerPreferences'
import type { ModelInfo } from './types'

const models: ModelInfo[] = [
  { id: 'cloud-a', name: 'A', provider: 'same', source: 'forsion', groupId: 'cloud', groupName: 'Cloud group', groupSortOrder: 2, tags: [{ text: 'Sale', color: 'red' }], multiplier: 0.13 },
  { id: 'local/a', name: 'A', provider: 'same', source: 'direct' },
  { id: 'local/b', name: 'B', provider: 'other', source: 'direct' },
  { id: 'cloud-b', name: 'B', provider: 'other', source: 'forsion', groupId: 'early', groupName: 'Early', groupSortOrder: 0 },
]
describe('model picker source boundary and persistence', () => {
  it('sorts cloud groups by admin order before any local groups', () => {
    const groups = groupPickerModels(models)
    expect(groups.map((g) => g.key)).toEqual(['forsion:early', 'forsion:cloud', 'direct:provider:other', 'direct:provider:same'])
    expect(groups[1].models[0].multiplier).toBe(0.13)
  })
  it('cannot hide or regroup cloud models even with tampered preferences', () => {
    const prefs = normalizePickerPreferences({ groups: [{ id: 'g', name: 'Local' }], assignments: { 'cloud-a': 'g' }, hidden: ['cloud-a', 'local/a'] })
    expect(isPickerModelVisible(models[0], prefs)).toBe(true)
    expect(groupPickerModels(models, prefs).find((g) => g.models.some((m) => m.id === 'cloud-a'))?.key).toBe('forsion:cloud')
    expect(groupPickerModels(models, prefs).flatMap((g) => g.models).some((m) => m.id === 'local/a')).toBe(false)
  })
  it('supports one level of groups across local providers in user order', () => {
    const prefs = normalizePickerPreferences({ groups: [{ id: 'second', name: 'Second' }, { id: 'first', name: 'First' }], assignments: { 'local/a': 'first', 'local/b': 'second' } })
    expect(groupPickerModels(models, prefs).filter((g) => g.source === 'direct').map((g) => g.provider)).toEqual(['Second', 'First'])
  })
  it('deleting a group returns its models to provider grouping without deleting visibility settings', () => {
    const prefs = normalizePickerPreferences({ groups: [], assignments: { 'local/a': 'removed', 'local/b': '' }, hidden: ['local/a'] })
    expect(prefs.assignments).toEqual({ 'local/b': '' })
    expect(prefs.hidden).toEqual(['local/a'])
    expect(groupPickerModels(models, prefs).find((g) => g.source === 'direct')?.provider).toBe('')
  })
  it('round trips the stored preferences and ignores malformed data', () => {
    const prefs = normalizePickerPreferences({ groups: [{ id: 'a', name: ' A ' }], assignments: { 'local/a': 'a' }, hidden: ['local/b', 'local/b'] })
    expect(normalizePickerPreferences(JSON.parse(JSON.stringify(prefs)))).toEqual(prefs)
    expect(normalizePickerPreferences(null)).toEqual({ groups: [], assignments: {}, hidden: [] })
  })
})
