import { describe, expect, it } from 'vitest'
import { conflictGroups, editorUseOf, normalizeHotkey, pluginDefaultHotkey, resolvePluginHotkeys, systemReservedOf } from './shortcutUsage'

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

describe('plugin default hotkeys (2026-11-16)', () => {
  it('accepts Mod + one key, normalized; rejects the rest', () => {
    expect(pluginDefaultHotkey('Mod+Shift+T')).toBe('mod+shift+t')
    expect(pluginDefaultHotkey('alt+mod+1')).toBe('mod+alt+1')
    expect(pluginDefaultHotkey('Mod+Shift+[')).toBe('mod+shift+[')
    for (const bad of ['t', 'Shift+T', 'Alt+E', 'Mod+Shift', 'mod+mod', 'Mod+A+B', '', 42, null, 'Mod+' + 'x'.repeat(30)]) {
      expect(pluginDefaultHotkey(bad), String(bad)).toBe('')
    }
  })

  const P = (id: string, hotkey: string) => ({ id: `amadeus:p:${id}`, hotkey })
  const builtins = [{ id: 'command-palette', hotkey: 'mod+k' }, { id: 'new-chat', hotkey: 'mod+n' }, { id: 'unbound', hotkey: '' }]

  it('a free default is active; one that hits a built-in, system or editor key is not', () => {
    const r = resolvePluginHotkeys([P('free', 'mod+shift+t'), P('chat', 'mod+n'), P('quit', 'mod+q'), P('bold', 'mod+b'), P('none', '')], builtins, {}, true)
    expect(r.get('amadeus:p:free')).toEqual({ hotkey: 'mod+shift+t', active: true })
    expect(r.get('amadeus:p:chat')).toEqual({ hotkey: 'mod+n', active: false, conflict: { kind: 'command', id: 'new-chat' } })
    expect(r.get('amadeus:p:quit')).toEqual({ hotkey: 'mod+q', active: false, conflict: { kind: 'layer', key: 'settings.shortcuts.system.quit' } })
    expect(r.get('amadeus:p:bold')).toMatchObject({ active: false, conflict: { kind: 'layer', key: 'settings.shortcuts.editor.bold' } })
    expect(r.has('amadeus:p:none')).toBe(false)
    // ⌘Q 只在 mac 上是系统保留:Windows 上同一个默认键可以生效
    expect(resolvePluginHotkeys([P('quit', 'mod+q')], builtins, {}, false).get('amadeus:p:quit')).toMatchObject({ active: true })
  })

  it('user bindings win: on another command they block the default, and freeing the key re-activates it', () => {
    // others 里已含用户覆盖后的生效键(调用方用 effectiveHotkey 算)
    const userTook = [...builtins, { id: 'open-terminal', hotkey: 'mod+shift+t' }]
    expect(resolvePluginHotkeys([P('free', 'mod+shift+t')], userTook, { 'open-terminal': 'mod+shift+t' }, true).get('amadeus:p:free'))
      .toEqual({ hotkey: 'mod+shift+t', active: false, conflict: { kind: 'command', id: 'open-terminal' } })
    // 用户把「新会话」解绑 → ⌘N 空出来,插件默认键生效
    const freed = builtins.map((b) => (b.id === 'new-chat' ? { ...b, hotkey: '' } : b))
    expect(resolvePluginHotkeys([P('chat', 'mod+n')], freed, { 'new-chat': '' }, true).get('amadeus:p:chat')).toMatchObject({ active: true })
    // 用户给另一条插件命令设了这个键 → 默认键让位
    expect(resolvePluginHotkeys([P('a', 'mod+shift+y'), P('b', '')], builtins, { 'amadeus:p:b': 'Mod+Shift+Y' }, true).get('amadeus:p:a'))
      .toMatchObject({ active: false, conflict: { kind: 'command', id: 'amadeus:p:b' } })
  })

  it('two plugins with the same default: neither gets it, whatever the load order', () => {
    for (const order of [[P('a', 'mod+shift+y'), P('b', 'mod+shift+y')], [P('b', 'mod+shift+y'), P('a', 'mod+shift+y')]]) {
      const r = resolvePluginHotkeys(order, builtins, {}, true)
      expect(r.get('amadeus:p:a')).toMatchObject({ active: false, conflict: { kind: 'command', id: 'amadeus:p:b' } })
      expect(r.get('amadeus:p:b')).toMatchObject({ active: false, conflict: { kind: 'command', id: 'amadeus:p:a' } })
    }
    // 其中一个被用户改到别的键 → 另一个的默认键生效
    expect(resolvePluginHotkeys([P('a', 'mod+shift+y'), P('b', 'mod+shift+y')], builtins, { 'amadeus:p:b': 'mod+alt+y' }, true).get('amadeus:p:a'))
      .toMatchObject({ active: true })
  })
})
