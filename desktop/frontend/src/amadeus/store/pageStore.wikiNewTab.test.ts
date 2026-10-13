/** L-11:openWikiLink 的 newTab(⌘/Ctrl+点击、中键)—— 命中的笔记与 `笔记#锚点` 走 openNote 门面的新标签页,
 *  不再就地 loadPage;不带 newTab 照旧就地装。编辑器那半(按键分流、把 opts 传到这里)在 check:linkcard 的 NT 组。 */
import { describe, it, expect, vi, afterEach } from 'vitest'

const openNote = vi.fn(async (_path: string, _opts?: { newTab?: boolean }) => {})
const openMedia = vi.fn((_path: string, _loc?: unknown, _opts?: { newTab?: boolean }) => {})
const dispatched: Array<{ type: string; detail: Record<string, unknown> }> = []
let hostAcks = false
const revealHeadingWhenReady = vi.fn(async (_path: string, _h: string) => {})
const revealBlockWhenReady = vi.fn(async (_path: string, _b: string) => {})
vi.mock('../../amadeusNav', () => ({ openNote, openMedia, revealHeadingWhenReady, revealBlockWhenReady }))

const loadPage = vi.fn(async (path: string) => ({
  manifest: {
    schema: 'amadeus.page/3', id: 'pg_t', title: path, createdAt: '', updatedAt: '',
    compiler: { version: 't' }, root: { type: 'stack', children: [] }, blocks: {},
  },
  blocks: {},
}))

async function freshStore() {
  vi.resetModules()
  for (const f of [openNote, openMedia, revealHeadingWhenReady, revealBlockWhenReady, loadPage]) f.mockClear()
  dispatched.length = 0
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('CustomEvent', class { type: string; detail: unknown; defaultPrevented = false
    constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail }
    preventDefault() { this.defaultPrevented = true }
  })
  vi.stubGlobal('window', {
    amadeus: { loadPage, listPages: async () => [], listFolders: async () => [], backlinks: async () => [] },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: (e: { type: string; detail: Record<string, unknown> }) => {
      if (hostAcks && e.type === 'amadeus:open-file') e.detail.handled = true // 宿主(amadeusOverlays)接了的回执
      dispatched.push({ type: e.type, detail: e.detail })
      return true
    },
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

  // 2026-10-13 用户实报:⌘ 点指向**文件**的双链(PDF 等)不开新标签,直接把眼前这篇笔记的标签换掉了。
  // 这些目标经事件交给宿主打开(amadeusOverlays 读 detail.newTab 传给 openFile / openDb / openDrawing),newTab 要带在事件里。
  it('指向应用内打开的文件(PDF / 多维表 / 白板 / 插件文件类型)+ newTab → 事件带 newTab', async () => {
    const store = await freshStore()
    store.setState({ files: ['docs/paper.pdf', 'data/tasks.db', 'boards/flow.excalidraw.md', 'maps/idea.mindmap.md'] })
    const open = (name: string, opts?: { newTab?: boolean }): { type: string; detail: Record<string, unknown> } | undefined => {
      dispatched.length = 0
      store.getState().openWikiLink(name, 'b/Src.md', opts)
      return dispatched.find((e) => e.type.startsWith('amadeus:open-'))
    }
    expect(open('paper.pdf#page=3', { newTab: true })).toEqual({ type: 'amadeus:open-pdf', detail: { path: 'docs/paper.pdf', page: 3, q: undefined, newTab: true } })
    expect(open('tasks.db', { newTab: true })).toEqual({ type: 'amadeus:open-db', detail: { path: 'data/tasks.db', newTab: true } })
    expect(open('flow.excalidraw', { newTab: true })).toMatchObject({ type: 'amadeus:open-drawing', detail: { newTab: true } })
    expect(open('idea.mindmap', { newTab: true })).toEqual({ type: 'amadeus:open-file', detail: { path: 'maps/idea.mindmap.md', newTab: true } })
    // 不带修饰键:照旧,不带 newTab(就地开 / 聚焦已开着的那个)
    expect(open('paper.pdf')?.detail.newTab).toBeUndefined()
    expect(open('tasks.db')?.detail.newTab).toBeUndefined()
  })

  it('带时刻的媒体双链 + newTab → 不找本页的播放器,另开一个标签', async () => {
    const store = await freshStore()
    store.setState({ files: ['media/lecture.mp4'] })
    store.getState().openWikiLink('lecture.mp4#t=95', 'b/Src.md', { newTab: true })
    await settle()
    expect(dispatched.some((e) => e.type === 'amadeus:media-goto')).toBe(false)
    expect(openMedia).toHaveBeenCalledWith('media/lecture.mp4', expect.objectContaining({ at: 95 }), { newTab: true })
  })

  // 2026-10-13 用户定「文件类型的双链点击后默认分屏打开(图片不算)」:编辑器的点击带 split,文件目标把它带进事件,
  // 笔记目标不认(照旧就地装)。普通文件(图片 / 插件声明的文件类型 / 没人认领的)一律交宿主的 openFile 去分派 ——
  // 「图片不分屏」「开不了的回落系统程序」都在那边;没挂监听的宿主(本测试)直接回落系统程序。
  // 落点本身(旁边那半屏 / 向右分屏)在 check:openbeside,整条链在 e2e:filelink。
  it('split:文件目标带进事件;笔记照旧就地;普通文件交宿主分派,没人接才回落系统程序', async () => {
    const store = await freshStore()
    const openVaultFile = vi.fn(async (_p: string) => {})
    ;(window as unknown as { amadeus: Record<string, unknown> }).amadeus.openVaultFile = openVaultFile
    store.setState({ files: ['docs/paper.pdf', 'data/tasks.db', 'boards/flow.excalidraw.md', 'maps/idea.mindmap.md', 'img/photo.png', 'media/lecture.mp4'] })
    const open = (name: string): { type: string; detail: Record<string, unknown> } | undefined => {
      dispatched.length = 0
      store.getState().openWikiLink(name, 'b/Src.md', { split: true })
      return dispatched.find((e) => e.type.startsWith('amadeus:open-'))
    }
    expect(open('paper.pdf')?.detail).toMatchObject({ path: 'docs/paper.pdf', split: true })
    expect(open('tasks.db')?.detail).toMatchObject({ path: 'data/tasks.db', split: true })
    expect(open('flow.excalidraw')?.detail).toMatchObject({ split: true })
    expect(open('idea.mindmap')?.detail).toMatchObject({ path: 'maps/idea.mindmap.md', split: true })
    expect(open('photo.png')?.detail).toMatchObject({ path: 'img/photo.png', split: true })
    expect(openVaultFile).toHaveBeenCalledWith('img/photo.png') // 没有监听 → 回落
    openVaultFile.mockClear()
    hostAcks = true
    expect(open('photo.png')?.detail).toMatchObject({ path: 'img/photo.png', handled: true })
    hostAcks = false
    expect(openVaultFile).not.toHaveBeenCalled() // 宿主接了 → 不再另开系统程序(否则一次点击开两处)
    store.getState().openWikiLink('lecture.mp4#t=95', 'b/Src.md', { split: true })
    await settle()
    expect(openMedia).toHaveBeenCalledWith('media/lecture.mp4', expect.objectContaining({ at: 95 }), { split: true })
    // 裸媒体链接(没有时刻锚)也开应用内播放器,不再交系统播放器。
    openMedia.mockClear()
    store.getState().openWikiLink('lecture.mp4', 'b/Src.md', { split: true })
    await settle()
    expect(openMedia).toHaveBeenCalledWith('media/lecture.mp4', undefined, { split: true })
    expect(openVaultFile).not.toHaveBeenCalled()
    openNote.mockClear()
    store.getState().openWikiLink('Note', 'b/Src.md', { split: true })
    await settle()
    expect(loadPage).toHaveBeenCalledWith('b/Note.md')
    expect(openNote).not.toHaveBeenCalled()
  })
})
