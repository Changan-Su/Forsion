import { describe, it, expect } from 'vitest'
import { eventToHotkey, formatHotkey, effectiveHotkey, useShortcuts, trackPair, isPairHotkey, MOD_PAIR } from './shortcutStore'

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

describe('左右修饰键同按(mod+mod / shift+shift / alt+alt)', () => {
  const key = (type: string, code: string, extra: Partial<KeyboardEvent> = {}) => ({ type, code, repeat: false, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...extra })
  const meta = { metaKey: true }
  it('mac:左右 ⌘ 都按下的那一下算数;松开重按才算下一次', () => {
    const down = new Set<string>()
    expect(trackPair(down, key('keydown', 'MetaLeft', meta), true)).toBe(null)
    expect(trackPair(down, key('keydown', 'MetaRight', meta), true)).toBe(MOD_PAIR)
    expect(trackPair(down, key('keydown', 'MetaRight', { ...meta, repeat: true }), true)).toBe(null)
    trackPair(down, key('keyup', 'MetaLeft'), true); trackPair(down, key('keyup', 'MetaRight'), true)
    expect(trackPair(down, key('keydown', 'MetaRight', meta), true)).toBe(null)
    expect(trackPair(down, key('keydown', 'MetaLeft', meta), true)).toBe(MOD_PAIR)
  })
  it('中间按过别的键、带了别的修饰键、只按一边都不算', () => {
    const down = new Set<string>()
    trackPair(down, key('keydown', 'MetaLeft', meta), true)
    trackPair(down, key('keydown', 'KeyC', meta), true) // ⌘C:这一轮作废
    expect(trackPair(down, key('keydown', 'MetaRight', meta), true)).toBe(null)
    down.clear()
    trackPair(down, key('keydown', 'MetaLeft', meta), true)
    expect(trackPair(down, key('keydown', 'MetaRight', { ...meta, shiftKey: true }), true)).toBe(null)
    down.clear()
    trackPair(down, key('keydown', 'MetaLeft', meta), true)
    trackPair(down, key('keyup', 'MetaLeft'), true)
    expect(trackPair(down, key('keydown', 'MetaLeft', meta), true)).toBe(null) // 同一边按两次不算
  })
  it('非 mac 认两个 Ctrl,不认 ⌘', () => {
    const down = new Set<string>()
    trackPair(down, key('keydown', 'ControlLeft', { ctrlKey: true }), false)
    expect(trackPair(down, key('keydown', 'ControlRight', { ctrlKey: true }), false)).toBe(MOD_PAIR)
    trackPair(down, key('keydown', 'MetaLeft', meta), false)
    expect(trackPair(down, key('keydown', 'MetaRight', meta), false)).toBe(null)
  })
  it('两个 Shift / 两个 Alt 各是一对;按着别的修饰键不算,换一族从头数', () => {
    const down = new Set<string>()
    trackPair(down, key('keydown', 'ShiftLeft', { shiftKey: true }), true)
    expect(trackPair(down, key('keydown', 'ShiftRight', { shiftKey: true }), true)).toBe('shift+shift')
    down.clear()
    trackPair(down, key('keydown', 'AltRight', { altKey: true }), false)
    expect(trackPair(down, key('keydown', 'AltLeft', { altKey: true }), false)).toBe('alt+alt')
    down.clear()
    trackPair(down, key('keydown', 'ShiftLeft', { shiftKey: true }), true)
    expect(trackPair(down, key('keydown', 'ShiftRight', { shiftKey: true, metaKey: true }), true)).toBe(null) // 按着 ⌘
    down.clear()
    trackPair(down, key('keydown', 'MetaLeft', meta), true)
    expect(trackPair(down, key('keydown', 'ShiftRight', { shiftKey: true, metaKey: true }), true)).toBe(null) // ⌘ + 另一族的一个键:不是一对
    down.clear()
    trackPair(down, key('keydown', 'ShiftLeft', { shiftKey: true }), true)
    trackPair(down, key('keydown', 'KeyA', { shiftKey: true }), true) // 打了个大写 A
    expect(trackPair(down, key('keydown', 'ShiftRight', { shiftKey: true }), true)).toBe(null)
  })
  it('哪些算成对热键;显示成两个修饰键', () => {
    expect([MOD_PAIR, 'shift+shift', 'alt+alt', 'mod+shift', 'shift+k'].map(isPairHotkey)).toEqual([true, true, true, false, false])
    expect(formatHotkey(MOD_PAIR, true)).toBe('⌘ + ⌘')
    expect(formatHotkey(MOD_PAIR, false)).toBe('Ctrl + Ctrl')
    expect(formatHotkey('shift+shift', true)).toBe('⇧ + ⇧')
    expect(formatHotkey('shift+shift', false)).toBe('Shift + Shift')
    expect(formatHotkey('alt+alt', true)).toBe('⌥ + ⌥')
  })
})
