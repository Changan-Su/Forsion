import { describe, it, expect } from 'vitest'
import { eventToHotkey, formatHotkey, effectiveHotkey, useShortcuts } from './shortcutStore'

const ev = (o: Partial<KeyboardEvent>): KeyboardEvent => o as KeyboardEvent

describe('eventToHotkey', () => {
  it('encodes mod/shift/alt + key, lowercased', () => {
    expect(eventToHotkey(ev({ key: 'k', metaKey: true }))).toBe('mod+k')
    expect(eventToHotkey(ev({ key: 'k', ctrlKey: true }))).toBe('mod+k')
    expect(eventToHotkey(ev({ key: 'N', metaKey: true, shiftKey: true }))).toBe('mod+shift+n')
    expect(eventToHotkey(ev({ key: ' ', ctrlKey: true }))).toBe('mod+space')
  })
  it('returns null for lone modifiers', () => {
    expect(eventToHotkey(ev({ key: 'Shift', shiftKey: true }))).toBeNull()
    expect(eventToHotkey(ev({ key: 'Meta', metaKey: true }))).toBeNull()
  })
  it('normalizes braces to brackets (shift+[ yields "{")', () => {
    expect(eventToHotkey(ev({ key: '{', metaKey: true, shiftKey: true }))).toBe('mod+shift+[')
    expect(eventToHotkey(ev({ key: '}', ctrlKey: true, shiftKey: true }))).toBe('mod+shift+]')
  })
})

describe('formatHotkey', () => {
  it('mac uses symbols, others use words', () => {
    expect(formatHotkey('mod+k', true)).toBe('⌘K')
    expect(formatHotkey('mod+shift+k', false)).toBe('Ctrl+Shift+K')
    expect(formatHotkey('mod+space', true)).toBe('⌘Space')
    expect(formatHotkey('', true)).toBe('')
  })
})

describe('effectiveHotkey + overrides', () => {
  it('override wins; empty string = unbound; clear falls back to default', () => {
    const cmd = { id: 'test-cmd', hotkey: 'mod+n' }
    useShortcuts.getState().clearOverride('test-cmd')
    expect(effectiveHotkey(cmd)).toBe('mod+n')
    useShortcuts.getState().setOverride('test-cmd', 'mod+j')
    expect(effectiveHotkey(cmd)).toBe('mod+j')
    useShortcuts.getState().setOverride('test-cmd', '') // explicit unbind
    expect(effectiveHotkey(cmd)).toBe('')
    useShortcuts.getState().clearOverride('test-cmd')
    expect(effectiveHotkey(cmd)).toBe('mod+n')
  })
})
