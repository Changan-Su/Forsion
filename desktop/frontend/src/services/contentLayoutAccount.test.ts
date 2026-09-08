import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.useFakeTimers()
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
  })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules() })

/** Independent module instances model two tabs whose frozen keys share one localStorage. */
async function openAccount(account: string) {
  vi.resetModules()
  const { setContentStorageScope } = await import('@lcl/engine/contentStorageScope')
  setContentStorageScope(account)
  const layout = await import('@lcl/engine/layoutPersist')
  const single = await import('@lcl/engine/singleColumnStore')
  const { registerView } = await import('@lcl/engine/viewRegistry')
  registerView({ type: 'note', displayName: () => 'Note', factory: () => null })
  return { layout, single }
}

const snapshot = (title: string) => ({
  version: 4 as const, dockview: { panels: { note: { title, params: { notePath: `${title}.md` } } } },
  sidebars: { left: { visible: true, stash: [] }, right: { visible: false, stash: [] } },
})

describe('account-scoped content layouts', () => {
  it('isolates both layout engines, rejects old-tab late writes, and restores A when returning to A', async () => {
    const a = await openAccount('cloud.test::account-a')
    a.layout.saveLayout(snapshot('Private A'))
    a.layout.saveNamedLayout('space:amadeus', snapshot('Private A'))
    a.single.useWorkspace.getState().openView('note', { path: 'Private A.md' })
    a.single.useWorkspace.getState().saveCurrent()
    a.single.useWorkspace.getState().saveNamed('space:amadeus')

    const b = await openAccount('cloud.test::account-b')
    expect(b.layout.loadLayout()).toBeNull()
    expect(b.layout.loadNamedLayout('space:amadeus')).toBeNull()
    expect(b.single.restoreSingleColumnLayout()).toBe(false)
    expect(b.single.useWorkspace.getState().namedLayouts()).toEqual([])
    b.layout.saveLayout(snapshot('Private B'))

    // A's beforeunload/autosave runs after B has become active in another tab.
    a.layout.saveLayout(snapshot('Late A'))
    a.single.useWorkspace.getState().saveCurrent()
    expect(b.layout.loadLayout()).toEqual(snapshot('Private B'))
    expect(b.single.restoreSingleColumnLayout()).toBe(false)

    const returningA = await openAccount('cloud.test::account-a')
    expect(returningA.layout.loadLayout()).toEqual(snapshot('Late A'))
    expect(returningA.layout.loadNamedLayout('space:amadeus')).toEqual(snapshot('Private A'))
    expect(returningA.single.restoreSingleColumnLayout()).toBe(true)
    expect(returningA.single.useWorkspace.getState().mainLeaves[0].params.path).toBe('Private A.md')
    expect(returningA.single.useWorkspace.getState().namedLayouts()).toEqual(['space:amadeus'])
  })

  it('keeps desk drafts and unread sessions in their original window account after a late save', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const open = async (account: string) => {
      await openAccount(account)
      const { useApp } = await import('../stores/appStore')
      useApp.setState({ desktopConfig: { agentDeskEnabled: true } as any, connState: 'ok', toast: () => {} })
      return useApp
    }
    const save = async (app: Awaited<ReturnType<typeof open>>, account: string) => {
      app.getState().deskPresent(`${account}-session`, { views: [{ type: 'file', path: `${account}-private.md` }], note: `${account} private draft` })
      app.setState({ unread: new Set([`${account}-session`, `${account}-read`]) })
      await app.getState().loadSessionHistory(`${account}-read`)
      await vi.advanceTimersByTimeAsync(501)
    }
    const a = await open('account-a')
    await save(a, 'a')
    const b = await open('account-b')
    expect(b.getState().deskBySession).toEqual({})
    expect([...b.getState().unread]).toEqual([])
    await save(b, 'b')
    await save(a, 'late-a')
    const returningB = await open('account-b')
    expect(Object.keys(returningB.getState().deskBySession)).toEqual(['b-session'])
    expect([...returningB.getState().unread]).toEqual(['b-session'])
    const returningA = await open('account-a')
    expect(returningA.getState().deskBySession['late-a-session'].note).toBe('late-a private draft')
    expect([...returningA.getState().unread]).toEqual(['late-a-session'])
  })
})
