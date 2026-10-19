import { afterEach, describe, expect, it } from 'vitest'
import { nextViewMode } from './viewModes'
import { hotkeyMatches } from './commandRegistry'
import { eventToHotkey, formatHotkey } from './shortcutStore'

const modes = (...v: string[]) => v.map((value) => ({ value, label: value }))
const key = (o: Partial<KeyboardEvent>) => ({ key: '', code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o }) as KeyboardEvent
const setPlatform = (p: string) => { (globalThis as { document?: unknown }).document = { documentElement: { dataset: { platform: p }, lang: 'zh' } } }

describe('nextViewMode', () => {
  it('切到下一种,到头回第一种', () => {
    expect(nextViewMode({ modes: modes('chat', 'canvas'), value: 'chat' })).toBe('canvas')
    expect(nextViewMode({ modes: modes('chat', 'canvas'), value: 'canvas' })).toBe('chat')
    expect(nextViewMode({ modes: modes('day', 'week', '3day', 'month'), value: '3day' })).toBe('month')
  })
  it('当前值不在里面 → 第一种;不到两种 → null', () => {
    expect(nextViewMode({ modes: modes('a', 'b', 'c'), value: 'zzz' })).toBe('a')
    expect(nextViewMode({ modes: modes('a'), value: 'a' })).toBeNull()
  })
})

describe('⌥⌘V(mac 上 ⌥ 让 e.key 变成变体字符)', () => {
  afterEach(() => { delete (globalThis as { document?: unknown }).document })
  it('mac:按物理键位认,录键也录成 mod+alt+v', () => {
    setPlatform('mac')
    const e = key({ key: '√', code: 'KeyV', metaKey: true, altKey: true })
    expect(hotkeyMatches('mod+alt+v', e)).toBe(true)
    expect(eventToHotkey(e)).toBe('mod+alt+v')
    expect(hotkeyMatches('mod+alt+√', e)).toBe(true) // 旧版录下的自定义键照旧能用
  })
  it('Windows:Ctrl+Alt+V 照旧按 e.key;AltGr 打出的字不当快捷键', () => {
    setPlatform('win')
    expect(hotkeyMatches('mod+alt+v', key({ key: 'v', code: 'KeyV', ctrlKey: true, altKey: true }))).toBe(true)
    expect(hotkeyMatches('mod+alt+z', key({ key: 'ż', code: 'KeyZ', ctrlKey: true, altKey: true }))).toBe(false)
  })
  it('不带 ⌥ 的不受影响', () => {
    setPlatform('mac')
    expect(hotkeyMatches('mod+k', key({ key: 'k', code: 'KeyK', metaKey: true }))).toBe(true)
    expect(hotkeyMatches('mod+shift+[', key({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true }))).toBe(true)
  })
})

describe('formatHotkey 的修饰键顺序', () => {
  it('mac 按系统菜单顺序(⌥⇧⌘),别的平台照存的顺序', () => {
    expect(formatHotkey('mod+alt+v', true)).toBe('⌥⌘V')
    expect(formatHotkey('mod+shift+k', true)).toBe('⇧⌘K')
    expect(formatHotkey('mod+alt+v', false)).toBe('Ctrl+Alt+V')
  })
})
