import { afterEach, expect, it, vi } from 'vitest'
import type { AmadeusEntrySyncVault } from '../types'

afterEach(() => vi.unstubAllGlobals())

it('an old refresh response cannot erase the sync registrations and publish path after a move', async () => {
  vi.resetModules()
  const replies: Array<(value: { vaults: AmadeusEntrySyncVault[]; activeRoot: string }) => void> = []
  vi.stubGlobal('window', { amadeusSync: { entrySyncGet: () => new Promise((resolve) => replies.push(resolve)) } })
  const { useEntrySync, isSyncedEntry, cloudPathFor } = await import('./entrySyncStore')
  const snapshot = (p: string) => ({ activeRoot: '/notes', vaults: [{
    vaultRoot: '/notes', cloudName: 'My notes', entries: [{ path: p, kind: 'page' as const }],
  }] })
  const old = useEntrySync.getState().refresh()
  const moved = useEntrySync.getState().refresh()
  replies[1](snapshot('Dest/A.md'))
  await moved
  replies[0](snapshot('A.md'))
  await old
  expect(isSyncedEntry('/notes', 'Dest/A.md')).toBe(true)
  expect(isSyncedEntry('/notes', 'A.md')).toBe(false)
  expect(cloudPathFor(useEntrySync.getState().vaults, '/notes', 'local', 'Dest/A.md')).toBe('My notes/Dest/A.md')
})
