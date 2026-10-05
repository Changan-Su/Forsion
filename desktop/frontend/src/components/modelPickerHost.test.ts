import { describe, expect, it } from 'vitest'
import { installModelPickerPresenter, modelPickerPresenter, pickerChanges, type ModelPickerRequest } from './modelPickerHost'
const request: ModelPickerRequest = {
  title: 'Models', labels: { done: 'Done', search: 'Search', empty: 'Empty', back: 'Back', advanced: 'Advanced' },
  theme: { dark: false, accent: '#4d8794' },
  fields: [
    { id: 'model', label: 'Model', value: 'a', groups: [{ label: 'Provider', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }] },
    { id: 'thinking', label: 'Thinking', value: 'medium', groups: [{ label: '', options: [{ value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] }] },
  ],
}
describe('native model picker boundary', () => {
  it('returns both changed values atomically without a mutation for cancellation', () => {
    expect(pickerChanges(request, { model: 'b', thinking: 'high' })).toEqual({ model: 'b', thinking: 'high' })
    expect(pickerChanges(request, { model: 'a', thinking: 'medium' })).toEqual({})
    expect(pickerChanges(request, null)).toBeNull()
  })
  it('rejects unknown models, malformed responses and injected fields as a whole', () => {
    for (const response of [[], {}, { model: 'injected', thinking: 'high' }, { model: 'b', thinking: 'high', token: 'bad' }, { model: 'b', thinking: 1 }]) {
      expect(pickerChanges(request, response)).toBeNull()
    }
  })
  it('can preserve an unavailable current value while changing another field', () => {
    const stale = { ...request, fields: request.fields.map(f => f.id === 'model' ? { ...f, value: 'retired' } : f) }
    expect(pickerChanges(stale, { model: 'retired', thinking: 'high' })).toEqual({ thinking: 'high' })
  })
  it('old presenter cleanup cannot unregister a replacement host', () => {
    const first = installModelPickerPresenter(async () => null)
    const next = async () => ({ model: 'b' })
    const second = installModelPickerPresenter(next)
    first(); expect(modelPickerPresenter()).toBe(next)
    second(); expect(modelPickerPresenter()).toBeUndefined()
  })
})
