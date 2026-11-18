import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadNotesPhoneTab, saveNotesPhoneTab } from './notesPhoneTab'

const KEY = 'forsion_notes_phone_tab'
function storage(init: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(init))
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } })
  return store
}
afterEach(() => vi.unstubAllGlobals())

describe('the notes list tab kept on the phone', () => {
  it('reads back each of the four tabs', () => {
    for (const tab of ['recent', 'tree', 'boards', 'tags'] as const) {
      storage({ [KEY]: tab })
      expect(loadNotesPhoneTab()).toBe(tab)
    }
  })
  it('never chosen, or a value this version does not know: null, and what is stored stays', () => {
    storage()
    expect(loadNotesPhoneTab()).toBeNull()
    const store = storage({ [KEY]: 'search' })
    expect(loadNotesPhoneTab()).toBeNull()
    expect(store.get(KEY)).toBe('search')
  })
  it('storage that throws does not take the list down', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    expect(loadNotesPhoneTab()).toBeNull()
    expect(() => saveNotesPhoneTab('tags')).not.toThrow()
  })
  it('saves the tab that was picked', () => {
    const store = storage()
    saveNotesPhoneTab('tags')
    expect(store.get(KEY)).toBe('tags')
    expect(loadNotesPhoneTab()).toBe('tags')
  })
})
