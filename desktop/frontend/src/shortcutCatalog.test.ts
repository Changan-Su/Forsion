// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'

it('publishes descriptions and follows removal without registering executable commands', async () => {
  const commands = await import('@lcl/engine')
  const publisher = await import('./shortcutCatalog')
  publisher.installShortcutCatalog()
  commands.addCommand({ id: 'bridge-command', title: () => 'Original plugin', hotkeys: ['meta+shift+n'], run: () => { throw Error('must not run') } })
  await Promise.resolve()
  const snapshot = JSON.parse(localStorage.getItem('forsion_shortcut_catalog')!)
  expect(snapshot.find((c: { id: string }) => c.id === 'bridge-command')).toEqual({ id: 'bridge-command', title: 'Original plugin', hotkeys: ['meta+shift+n'] })
  vi.resetModules()
  vi.doMock('./windowKind', () => ({ windowKind: () => 'floating' }))
  const follower = await import('./shortcutCatalog')
  const receiver = await import('@lcl/engine')
  follower.installShortcutCatalog()
  expect(follower.useShortcutCatalog.getState().commands.some(c => c.id === 'bridge-command')).toBe(true)
  expect(receiver.useCommandStore.getState().commands.some(c => c.id === 'bridge-command')).toBe(false)
  commands.removeCommand('bridge-command')
  await Promise.resolve()
  window.dispatchEvent(new StorageEvent('storage', { key: 'forsion_shortcut_catalog' }))
  expect(follower.useShortcutCatalog.getState().commands.some(c => c.id === 'bridge-command')).toBe(false)
})
