/** L-11:openWikiLink 的 newTab(⌘/Ctrl+点击、中键)—— 命中的笔记与 `笔记#锚点` 走 openNote 门面的新标签页,
 *  不再就地 loadPage;不带 newTab 照旧就地装。编辑器那半(按键分流、把 opts 传到这里)在 check:linkcard 的 NT 组。 */
import { describe, it, expect, vi, afterEach } from 'vitest'

const openNote = vi.fn(async (_path: string, _opts?: { newTab?: boolean }) => {})
const revealHeadingWhenReady = vi.fn(async (_path: string, _h: string) => {})
const revealBlockWhenReady = vi.fn(async (_path: string, _b: string) => {})
vi.mock('../../amadeusNav', () => ({ openNote, revealHeadingWhenReady, revealBlockWhenReady }))

const loadPage = vi.fn(async (path: string) => ({
  manifest: {
    schema: 'amadeus.page/3', id: 'pg_t', title: path, createdAt: '', updatedAt: '',
    compiler: { version: 't' }, root: { type: 'stack', children: [] }, blocks: {},
  },
  blocks: {},
}))

async function freshStore() {
  vi.resetModules()
  for (const f of [openNote, revealHeadingWhenReady, revealBlockWhenReady, loadPage]) f.mockClear()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('CustomEvent', class { type: string; detail: unknown; defaultPrevented = false
    constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail }
    preventDefault() { this.defaultPrevented = true }
  })
  vi.stubGlobal('window', {
    amadeus: { loadPage, listPages: async () => [], listFolders: async () => [], backlinks: async () => [] },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  })
  const m = await import('./pageStore')
  m.usePageStore.setState({ vaultRoot: '/v', pages: ['a/Note.md', 'b/Note.md', 'b/Src.md'], files: [], status: 'ready' })
  return m.usePageStore
}
const settle = () => new Promise((r) => setTimeout(r, 20))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openWikiLink newTab(L-11)', () => {
  it('命中笔记 + newTab → openNote(同目录那篇, newTab),不就地 loadPage', async () => {
    const store = await freshStore()
    store.getState().openWikiLink('Note', 'b/Src.md', { newTab: true })
    await settle()
    expect(openNote).toHaveBeenCalledWith('b/Note.md', { newTab: true })
    expect(loadPage).not.toHaveBeenCalled()
  })

  it('不带 newTab 照旧就地装,不开新标签', async () => {
    const store = await freshStore()
    store.getState().openWikiLink('Note', 'b/Src.md')
    await settle()
    expect(openNote).not.toHaveBeenCalled()
    expect(loadPage).toHaveBeenCalledWith('b/Note.md')
  })

  it('`笔记#标题` + newTab → 新标签页打开后再定位标题', async () => {
    const store = await freshStore()
    store.getState().openWikiLink('Note#Sec', 'b/Src.md', { newTab: true })
    await settle()
    expect(openNote).toHaveBeenCalledWith('b/Note.md', { newTab: true })
    expect(revealHeadingWhenReady).toHaveBeenCalledWith('b/Note.md', 'Sec')
    expect(loadPage).not.toHaveBeenCalled()
  })
})
