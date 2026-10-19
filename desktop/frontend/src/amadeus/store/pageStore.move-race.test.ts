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

// v3 块编辑器的挪动竞态(2026-10-19):IPC 在途时防抖保存按旧路径写,主进程 savePage 缺文件即建 = 原文件夹复活一篇。
// 整条链(真主进程 + 慢挪动)在 desktop 的 npm run e2e:notemove 第 7–10 条;这里钉 store 那半:按住期间不写旧路径、
// 放手时并进主进程改写过引用的那版、本面板按合并结果装到新路径。
describe('v3 note moved while typing', () => {
  const V3 = ['---', 'amadeus_page: pg_t', 'amadeus_schema: amadeus.page/3',
    'amadeus_layout: {"type":"stack","children":[{"type":"row","id":"r1","columns":[{"id":"c1","width":1,"children":[{"ref":"1"},{"ref":"2"}]}]}]}',
    '---', '', '<!-- a 1 -->', '', '正文', '', '<!-- a 2 -->', '', '![](p.png)', ''].join('\n')

  async function setupDisk() {
    vi.resetModules()
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
    const { compile, parsePageSource } = await import('@amadeus-shared/compiler')
    const disk = new Map<string, string>([['A.md', V3], ['B.md', V3.replace('pg_t', 'pg_b')]])
    const io = { beforeRead: null as null | ((p: string) => void) } // 交接读新路径时插一脚(模拟交接 I/O 途中打字)
    let finishMove: (() => void) | null = null
    let failMove: (() => void) | null = null
    const savePage = vi.fn(async (p: string, mf: never, contents: Record<string, string>) => { disk.set(p, compile(mf, contents)) })
    vi.stubGlobal('window', {
      amadeus: {
        loadPage: async (p: string) => parsePageSource(p, disk.get(p)!, 'now'),
        movePage: (p: string) => new Promise((r, reject) => {
          failMove = () => reject(new Error('目标位置已存在同名文件'))
          finishMove = () => { // 主进程:挪文件 + 按新位置改写引用
            disk.set(`folder/${p}`, disk.get(p)!.replace('](p.png)', '](../p.png)'))
            disk.delete(p)
            r(`folder/${p}`)
          }
        }),
        savePage,
        readTextFile: async (p: string) => { io.beforeRead?.(p); return disk.get(p) ?? null },
        writeTextFile: async (p: string, text: string) => { disk.set(p, text); return { ok: true } },
        listPages: async () => [], listFolders: async () => [], listFiles: async () => [], pageIcons: async () => ({}), backlinks: async () => [],
      },
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
    })
    return { ...(await import('./pageStore')), disk, io, savePage, moving: () => !!finishMove, finish: () => finishMove!(), fail: () => failMove!() }
  }

  it('typing during the move IPC lands in the moved note, not a resurrected old file', async () => {
    const m = await setupDisk()
    const store = m.pageStoreFor('v3-tab')
    await store.getState().loadPage('A.md')
    const moving = store.getState().movePage('A.md', 'folder')
    await vi.waitFor(() => expect(m.moving()).toBe(true)) // IPC 已发出 = 按住已就位
    store.getState().setBlockContent('1', '正文续写')
    await store.getState().save() // 防抖到点:按住期间不许写旧路径
    expect(m.savePage).not.toHaveBeenCalled()
    m.finish()
    await moving
    expect(m.disk.has('A.md')).toBe(false)
    expect(m.disk.get('folder/A.md')).toContain('正文续写')
    expect(m.disk.get('folder/A.md')).toContain('](../p.png)')
    expect(store.getState().activePage).toBe('folder/A.md')
    expect(store.getState().blocks['2'].content).toBe('![](../p.png)') // 手里换成改写后的引用,下次存盘不盖回去
  })

  it('debounce cleared by the hold, then the pane navigates away: the typed text still reaches the moved note', async () => {
    const m = await setupDisk()
    const store = m.pageStoreFor('v3-tab')
    await store.getState().loadPage('A.md')
    const moving = store.getState().movePage('A.md', 'folder')
    store.getState().setBlockContent('1', '正文续写') // 挪动的全面板冲洗已经过去、按住还没立起来时打的字:计时器留给按住去清
    await vi.waitFor(() => expect(m.moving()).toBe(true))
    await store.getState().loadPage('B.md') // 挪动途中切去别篇:flushSave 见不到计时器
    m.finish()
    await moving
    expect(m.disk.has('A.md')).toBe(false)
    expect(m.disk.get('folder/A.md')).toContain('正文续写')
    expect(store.getState().activePage).toBe('B.md')
  })

  it('typing during the hand-over I/O is merged in, not dropped by the reload', async () => {
    const m = await setupDisk()
    const store = m.pageStoreFor('v3-tab')
    await store.getState().loadPage('A.md')
    const moving = store.getState().movePage('A.md', 'folder')
    await vi.waitFor(() => expect(m.moving()).toBe(true))
    store.getState().setBlockContent('1', '正文续写')
    m.io.beforeRead = (p) => { if (p === 'folder/A.md') { m.io.beforeRead = null; store.getState().setBlockContent('1', '正文续写又写') } }
    m.finish()
    await moving
    expect(store.getState().blocks['1'].content).toBe('正文续写又写')
    expect(store.getState().blocks['2'].content).toBe('![](../p.png)')
    await store.getState().flushSave()
    expect(m.disk.get('folder/A.md')).toContain('正文续写又写')
    expect(m.disk.get('folder/A.md')).toContain('](../p.png)')
    expect(m.disk.has('A.md')).toBe(false)
  })

  it('a failed move after navigating away writes the held text back to the original note; vault switch is refused meanwhile', async () => {
    const m = await setupDisk()
    const store = m.pageStoreFor('v3-tab')
    await store.getState().loadPage('A.md')
    const moving = store.getState().movePage('A.md', 'folder')
    await vi.waitFor(() => expect(m.moving()).toBe(true))
    store.getState().setBlockContent('1', '正文续写')
    await expect(m.flushAllScopes(true)).rejects.toThrow() // 换库 / 切号屏障:按住着的字还只在内存里
    await store.getState().loadPage('B.md')
    m.fail()
    await moving
    expect(m.disk.get('A.md')).toContain('正文续写')
    await expect(m.flushAllScopes(true)).resolves.toBeUndefined()
  })
})
