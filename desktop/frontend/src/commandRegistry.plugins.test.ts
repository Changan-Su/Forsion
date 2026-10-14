// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from 'vitest'
import { addCommand, installHotkeys, removeCommand, useCommandStore } from '@lcl/engine/commandRegistry'
import { effectiveHotkeys, hotkeysConflict, formatHotkey, useShortcuts } from '@lcl/engine/shortcutStore'

let dispose: () => void
beforeEach(() => { useCommandStore.setState({ commands: [], paletteOpen: false }); useShortcuts.getState().resetAll(); dispose = installHotkeys() })
afterEach(() => { dispose(); document.body.replaceChildren(); useShortcuts.getState().setRecording(false) })
function press(key: string, init: KeyboardEventInit = {}, target: HTMLElement = document.body) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event.defaultPrevented
}
it('dispatches all defaults, replaces them on override, unbinds and restores them', () => {
  let count = 0
  const cmd = { id: 'plugin', title: 'Plugin', hotkeys: ['meta+shift+n', 'ctrl+space'], run: () => { count++ } }
  addCommand(cmd)
  expect(press('N', { metaKey: true, shiftKey: true })).toBe(true)
  expect(press(' ', { ctrlKey: true })).toBe(true)
  expect(count).toBe(2)
  expect(press('n', { ctrlKey: true, shiftKey: true })).toBe(false)
  expect(press('n', { ctrlKey: true, metaKey: true, shiftKey: true })).toBe(false)
  useShortcuts.getState().setOverride(cmd.id, 'mod+j')
  expect(effectiveHotkeys(cmd)).toEqual(['mod+j'])
  expect(press('N', { metaKey: true, shiftKey: true })).toBe(false)
  expect(press('j', { metaKey: true })).toBe(true)
  useShortcuts.getState().setOverride(cmd.id, '')
  expect(press('j', { metaKey: true })).toBe(false)
  useShortcuts.getState().clearOverride(cmd.id)
  expect(press(' ', { ctrlKey: true })).toBe(true)
  removeCommand(cmd.id)
  expect(press(' ', { ctrlKey: true })).toBe(false)
  expect(count).toBe(4)
})
it('does not consume guarded, composing, recorded or already handled events', () => {
  let count = 0
  const editor = document.createElement('div'), input = document.createElement('input')
  document.body.append(editor, input)
  addCommand({ id: 'guarded', title: 'Guarded', hotkey: 'mod+j', hotkeyWhen: e => e.target === editor && !e.repeat, run: () => { count++ } })
  expect(press('j', { metaKey: true }, input)).toBe(false)
  expect(press('j', { metaKey: true, repeat: true }, editor)).toBe(false)
  expect(press('j', { metaKey: true, isComposing: true }, editor)).toBe(false)
  useShortcuts.getState().setRecording(true)
  expect(press('j', { metaKey: true }, editor)).toBe(false)
  useShortcuts.getState().setRecording(false)
  editor.addEventListener('keydown', e => e.preventDefault(), { once: true })
  press('j', { metaKey: true }, editor)
  expect(count).toBe(0)
  expect(press('j', { metaKey: true }, editor)).toBe(true)
  expect(count).toBe(1)
})
it('keeps existing command priority and lets a rejected guard fall through', () => {
  const calls: string[] = []
  addCommand({ id: 'native', title: 'Native', hotkey: 'mod+j', run: () => { calls.push('native') } })
  addCommand({ id: 'plugin', title: 'Plugin', hotkey: 'meta+j', run: () => { calls.push('plugin') } })
  press('j', { metaKey: true })
  expect(calls).toEqual(['native'])
  removeCommand('native')
  addCommand({ id: 'other', title: 'Other', hotkey: 'meta+j', run: () => { calls.push('other') } })
  addCommand({ id: 'plugin', title: 'Plugin', hotkey: 'meta+j', hotkeyWhen: () => false, run: () => { calls.push('plugin') } })
  press('j', { metaKey: true })
  expect(calls).toEqual(['native', 'other'])
  expect(formatHotkey('ctrl+meta+space', true)).toBe('⌃⌘Space')
})

it('applies settings-window storage changes without writing them back', () => {
  let count = 0
  addCommand({ id: 'remote', title: 'Remote', hotkey: 'meta+n', run: () => { count++ } })
  localStorage.setItem('forsion_shortcuts', JSON.stringify({ remote: 'meta+j' }))
  window.dispatchEvent(new StorageEvent('storage', { key: 'forsion_shortcuts' }))
  expect(press('n', { metaKey: true })).toBe(false)
  expect(press('j', { metaKey: true })).toBe(true)
  expect(count).toBe(1)
  expect(hotkeysConflict('mod+shift+n', 'meta+shift+n')).toBe(true)
  expect(hotkeysConflict('shift+ctrl+n', 'ctrl+shift+n')).toBe(true)
  expect(hotkeysConflict('ctrl+n', 'meta+n')).toBe(false)
})
