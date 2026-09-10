import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LoadedPage } from '@amadeus-shared/compiler/types'

const page = (content: string): LoadedPage => ({
  manifest: { root: { type: 'stack', children: [] }, blocks: {} },
  blocks: { b1: { type: 'markdown', content } },
} as unknown as LoadedPage)

async function setup() {
  vi.resetModules()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  const loadPage = vi.fn(async (_path: string) => page('current'))
  const movePage = vi.fn(async (_path: string, _folder: string) => 'folder/A.md')
  vi.stubGlobal('window', {
    amadeus: { loadPage, movePage, savePage: vi.fn(async () => {}), listPages: async () => [], listFolders: async () => [], listFiles: async () => [], pageIcons: async () => ({}), backlinks: async () => [] },
    addEventListener: () => {}, removeEventListener: () => {},
  })
  return { ...(await import('./pageStore')), ...(await import('../unified/lifecycle')), loadPage, movePage }
}

afterEach(() => vi.unstubAllGlobals())

describe('path changes while editors are loading', () => {
  it('completing a move cannot steal navigation to another note during the IPC wait', async () => {
    const m = await setup()
    const store = m.pageStoreFor('moving-tab')
    await store.getState().loadPage('A.md')
    let resolve!: (path: string) => void
    m.movePage.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    const moving = store.getState().movePage('A.md', 'folder')
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    await store.getState().loadPage('B.md')
    resolve('folder/A.md')
    await moving
    expect(store.getState().activePage).toBe('B.md')
  })

  it('a delayed old-path load cannot navigate a moved note back to its original filename', async () => {
    const m = await setup()
    const store = m.pageStoreFor('moving-tab')
    await store.getState().loadPage('A.md')
    let resolve!: (p: LoadedPage) => void
    m.loadPage.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    const pending = store.getState().loadPage('A.md')
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    m.remapScopePaths('A.md', 'folder/A.md', 'file')
    resolve(page('stale response from original path'))
    await pending
    expect(store.getState().activePage).toBe('folder/A.md')
    expect(store.getState().pendingPage).toBeNull()
    expect(store.getState().blocks.b1.content).toBe('current')
  })

  it('a folder move also cancels pending loads in background panels without affecting other navigation', async () => {
    const m = await setup()
    const moved = m.pageStoreFor('moving-tab')
    const other = m.pageStoreFor('other-tab')
    let resolveMoved!: (p: LoadedPage) => void
    let resolveOther!: (p: LoadedPage) => void
    m.loadPage.mockImplementation((path) => new Promise((r) => {
      if (path === 'dir/A.md') resolveMoved = r
      else resolveOther = r
    }))
    const loads = [moved.getState().loadPage('dir/A.md'), other.getState().loadPage('directory/B.md')]
    m.remapScopePaths('dir', 'destination/dir', 'prefix')
    resolveMoved(page('stale'))
    resolveOther(page('other'))
    await Promise.all(loads)
    expect(moved.getState().activePage).toBeNull()
    expect(moved.getState().pendingPage).toBeNull()
    expect(other.getState().activePage).toBe('directory/B.md')
  })

  it('every path-remap entry point retires the old unified writer, including note-view rename', async () => {
    const m = await setup()
    const retire = vi.fn()
    const other = vi.fn()
    const off = m.registerUnifiedPipe({ path: 'A.md', flush: async () => {}, retire })
    const offOther = m.registerUnifiedPipe({ path: 'B.md', flush: async () => {}, retire: other })
    m.remapScopePaths('A.md', 'folder/A.md', 'file')
    expect(retire).toHaveBeenCalledOnce()
    expect(other).not.toHaveBeenCalled()
    off(); offOther()
  })

  it('a no-op remap leaves a live writer usable', async () => {
    const m = await setup()
    const retire = vi.fn()
    const off = m.registerUnifiedPipe({ path: 'A.md', flush: async () => {}, retire })
    m.remapScopePaths('A.md', 'A.md', 'file')
    expect(retire).not.toHaveBeenCalled()
    off()
  })
})
