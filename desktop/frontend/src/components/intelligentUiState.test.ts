import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { validateUIDocument, type UIBlock } from '../../../../tangu-agent/src/shared/intelligentUi'
import { deriveChecklist, emptyUIState, inputValues, readUIState, uiExpansionKey, uiStateKey, writeUIState } from './intelligentUiState'
const fixture = JSON.parse(readFileSync(new URL('../../../scripts/fixtures/intelligent-ui.json', import.meta.url), 'utf8')).dinner
const doc = validateUIDocument(fixture)
const list = doc.blocks.find(b => b.kind === 'checklist') as Extract<UIBlock, { kind: 'checklist' }>
describe('Intelligent UI user state stays separate from model defaults', () => {
  it('merges ingredients, scales quantities and retains actual purchased amounts', () => {
    const state = emptyUIState(), values = inputValues(doc, state)
    const garlic = deriveChecklist(list, values, state).find(r => r.label === '大蒜')!
    expect(garlic.amount).toBe(35)
    state.purchased[garlic.key] = 35
    expect(deriveChecklist(list, values, state).find(r => r.key === garlic.key)?.checked).toBe(true)
    state.values.people = 6
    const grown = deriveChecklist(list, inputValues(doc, state), state).find(r => r.key === garlic.key)!
    expect(grown.amount).toBe(52.5); expect(grown.shortfall).toBe(17.5); expect(grown.checked).toBe(false)
    state.values.people = 4; state.values.main = 'tofu'
    const changed = deriveChecklist(list, inputValues(doc, state), state)
    expect(changed.find(r => r.key === garlic.key)?.checked).toBe(true)
    expect(changed.find(r => r.label === '去骨鸡腿肉')).toBeUndefined()
    expect(changed.find(r => r.label === '豆腐')?.checked).toBe(false)
  })
  it('late defaults never override edits; removed choices and changed bounds reconcile', () => {
    const state = emptyUIState(); state.values.people = 6; state.values.main = 'beef'
    expect(inputValues(doc, state).people).toBe(6)
    const next = structuredClone(doc)
    next.inputs[0] = { ...next.inputs[0], max: 5 } as any
    next.inputs[1] = { ...next.inputs[1], options: [{ id: 'chicken', label: 'Chicken' }] } as any
    expect(inputValues(next, state)).toEqual({ people: 5, main: 'chicken' })
  })
  it('restores per-thread/per-message/per-call state and tolerates corrupt storage', () => {
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) || null, setItem: (k: string, v: string) => data.set(k, v) } as unknown as Storage
    const key = uiStateKey('session:message', 'call', 'dinner'), state = emptyUIState()
    state.values.people = 6; state.expanded.steps = true
    writeUIState(key, state, storage)
    expect(readUIState(key, storage)).toEqual(state)
    // Hydration must not silently trim otherwise valid state to an arbitrary entry count.
    for (let i = 0; i < 300; i++) state.purchased[`item-${i}`] = i
    writeUIState(key, state, storage)
    expect(Object.keys(readUIState(key, storage).purchased)).toHaveLength(300)
    expect(readUIState(uiStateKey('other:message', 'call', 'dinner'), storage)).toEqual(emptyUIState())
    storage.setItem('forsion_intelligent_ui_v1', '{broken')
    expect(readUIState(key, storage)).toEqual(emptyUIState())
    writeUIState(key, state, storage)
    expect(readUIState(key, storage)).toEqual(state)
  })
  it('tolerates storage access throwing before a method is called', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError') } })
    try {
      expect(readUIState('test')).toEqual(emptyUIState())
      expect(() => writeUIState('test', emptyUIState())).not.toThrow()
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })
  it('encodes expansion identities without source/disclosure collisions', () => {
    expect(uiExpansionKey('source', 'a', 'b.c')).not.toBe(uiExpansionKey('source', 'a.b', 'c'))
    expect(uiExpansionKey('source', 'a', 'b.c')).not.toBe(uiExpansionKey('disclosure', 'a.b.c'))
  })
})
