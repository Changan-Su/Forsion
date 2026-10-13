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

describe('openWikiLink 遇到应用 / 窗口引用(属性值、数据库格子、关系图里的幽灵节点都会走到这里)', () => {
  it('切到那个应用,不找笔记、不问「要不要新建」;别名被调用方剥掉了也认', async () => {
    const store = await freshStore()
    const open = vi.fn(async (_ref: unknown) => ({ ok: true }))
    const confirm = vi.fn(() => true)
    ;(window as unknown as { tangu: unknown }).tangu = { appRefs: { open } }
    vi.stubGlobal('confirm', confirm)
    store.getState().openWikiLink('window://com.apple.Safari|季度计划', 'b/Src.md')
    store.getState().openWikiLink('app://com.apple.Notes') // linkTarget() 剥掉别名后的样子
    await settle()
    expect(open.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'window', id: 'com.apple.Safari', name: '季度计划' },
      { kind: 'app', id: 'com.apple.Notes', name: 'com.apple.Notes' },
    ])
    expect(openNote).not.toHaveBeenCalled()
    expect(loadPage).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })
  it('没有这个接口的宿主(网页版 / 手机):什么都不做,也不去新建一篇叫 app://… 的笔记', async () => {
    const store = await freshStore()
    store.getState().openWikiLink('app://com.apple.Notes|Notes')
    await settle()
    expect(openNote).not.toHaveBeenCalled()
    expect(loadPage).not.toHaveBeenCalled()
  })
})
