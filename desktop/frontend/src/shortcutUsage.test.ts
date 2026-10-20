import { describe, expect, it } from 'vitest'
import { conflictGroups, editorUseOf, normalizeHotkey, systemReservedOf } from './shortcutUsage'

describe('shortcutUsage', () => {
  it('normalizes modifier order and case, keeps modifier pairs', () => {
    expect(normalizeHotkey('Shift+Mod+K')).toBe('mod+shift+k')
    expect(normalizeHotkey('alt+mod+shift+[')).toBe('mod+shift+alt+[')
    expect(normalizeHotkey('mod+mod')).toBe('mod+mod')
    expect(normalizeHotkey('shift+shift')).toBe('shift+shift')
  })

  it('knows editor-layer keys (hint only)', () => {
    expect(editorUseOf('mod+b')).toBe('settings.shortcuts.editor.bold')
    expect(editorUseOf('alt+mod+3')).toBe('settings.shortcuts.editor.heading')
    expect(editorUseOf('mod+n')).toBeNull()
  })

  it('reserves system keys per platform', () => {
    expect(systemReservedOf('mod+q', true)).toBe('settings.shortcuts.system.quit')
    expect(systemReservedOf('mod+q', false)).toBeNull()
    expect(systemReservedOf('alt+f4', false)).toBe('settings.shortcuts.system.closeWindow')
    expect(systemReservedOf('mod+c', true)).toBe('settings.shortcuts.system.copy')
    expect(systemReservedOf('mod+c', false)).toBe('settings.shortcuts.system.copy')
    expect(systemReservedOf('mod+n', true)).toBeNull()
    expect(systemReservedOf('mod+shift+m', false)).toBe('settings.shortcuts.system.miniWindow')
  })

  it('groups rows that share an effective hotkey', () => {
    const rows = [{ id: 'a', hk: 'mod+n' }, { id: 'b', hk: 'Mod+N' }, { id: 'c', hk: 'mod+k' }, { id: 'd', hk: '' }]
    const g = conflictGroups(rows, (r) => r.hk)
    expect([...g.keys()]).toEqual(['mod+n'])
    expect(g.get('mod+n')!.map((r) => r.id)).toEqual(['a', 'b'])
  })
})
