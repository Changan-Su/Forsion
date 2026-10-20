import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ root: 'C:\\Vault', changed: null as null | ((s: any, p: any) => void) }))
vi.mock('@amadeus/store/pageStore', () => ({
  noteOf: () => null,
  usePageStore: { getState: () => ({ vaultRoot: state.root }), subscribe: (fn: typeof state.changed) => { state.changed = fn } },
}))
vi.mock('@amadeus/lib/recents', () => ({ setRecentsProvider: vi.fn() }))
beforeEach(() => {
  vi.resetModules()
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) })
})
afterEach(() => vi.unstubAllGlobals())
it('deduplicates old Windows and canonical keys before toggles persist them', async () => {
  state.root = 'C:\\Vault'
  localStorage.setItem(`amadeus_prefs:${state.root}`, JSON.stringify({ starred: ['夹\\笔记.md', '夹/笔记.md'], pins: ['夹\\笔记.md', '夹/笔记.md'], recents: ['夹\\笔记.md', '夹/笔记.md'], collections: [] }))
  const { useAmadeusPrefs } = await import('./amadeusPrefs')
  state.changed!({ vaultRoot: state.root }, { vaultRoot: null })
  for (const kind of ['starred', 'pins', 'recents'] as const) expect(useAmadeusPrefs.getState()[kind]).toEqual(['夹/笔记.md'])
  useAmadeusPrefs.getState().toggleStar('夹/笔记.md')
  useAmadeusPrefs.getState().togglePin('夹/笔记.md')
  expect(JSON.parse(localStorage.getItem(`amadeus_prefs:${state.root}`)!)).toMatchObject({ starred: [], pins: [] })
})
it('preserves distinct literal backslash filenames in POSIX vaults', async () => {
  state.root = '/Users/test/Vault'
  localStorage.setItem(`amadeus_prefs:${state.root}`, JSON.stringify({ starred: ['夹\\笔记.md', '夹/笔记.md'] }))
  const { useAmadeusPrefs } = await import('./amadeusPrefs')
  state.changed!({ vaultRoot: state.root }, { vaultRoot: null })
  expect(useAmadeusPrefs.getState().starred).toEqual(['夹\\笔记.md', '夹/笔记.md'])
})
