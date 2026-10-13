import { describe, it, expect } from 'vitest'
import { eventToHotkey, formatHotkey, effectiveHotkey, useShortcuts, trackModPair, MOD_PAIR } from './shortcutStore'

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

describe('左右修饰键同按(mod+mod)', () => {
  const key = (type: string, code: string, extra: Partial<KeyboardEvent> = {}) => ({ type, code, repeat: false, shiftKey: false, altKey: false, ...extra })
  it('mac:左右 ⌘ 都按下的那一下算数;松开重按才算下一次', () => {
    const down = new Set<string>()
    expect(trackModPair(down, key('keydown', 'MetaLeft'), true)).toBe(false)
    expect(trackModPair(down, key('keydown', 'MetaRight'), true)).toBe(true)
    expect(trackModPair(down, key('keydown', 'MetaRight', { repeat: true }), true)).toBe(false)
    trackModPair(down, key('keyup', 'MetaLeft'), true); trackModPair(down, key('keyup', 'MetaRight'), true)
    expect(trackModPair(down, key('keydown', 'MetaRight'), true)).toBe(false)
    expect(trackModPair(down, key('keydown', 'MetaLeft'), true)).toBe(true)
  })
  it('中间按过别的键、带了 Shift / Alt、只按一边都不算', () => {
    const down = new Set<string>()
    trackModPair(down, key('keydown', 'MetaLeft'), true)
    trackModPair(down, key('keydown', 'KeyC'), true) // ⌘C:这一轮作废
    expect(trackModPair(down, key('keydown', 'MetaRight'), true)).toBe(false)
    down.clear()
    trackModPair(down, key('keydown', 'MetaLeft'), true)
    expect(trackModPair(down, key('keydown', 'MetaRight', { shiftKey: true }), true)).toBe(false)
    down.clear()
    trackModPair(down, key('keydown', 'MetaLeft'), true)
    trackModPair(down, key('keyup', 'MetaLeft'), true)
    expect(trackModPair(down, key('keydown', 'MetaLeft'), true)).toBe(false) // 同一边按两次不算
  })
  it('非 mac 认两个 Ctrl,不认 ⌘', () => {
    const down = new Set<string>()
    trackModPair(down, key('keydown', 'ControlLeft'), false)
    expect(trackModPair(down, key('keydown', 'ControlRight'), false)).toBe(true)
    trackModPair(down, key('keydown', 'MetaLeft'), false)
    expect(trackModPair(down, key('keydown', 'MetaRight'), false)).toBe(false)
  })
  it('显示成两个修饰键', () => {
    expect(formatHotkey(MOD_PAIR, true)).toBe('⌘ + ⌘')
    expect(formatHotkey(MOD_PAIR, false)).toBe('Ctrl + Ctrl')
  })
})
