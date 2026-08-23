/** 新建笔记出生格式契约(2026-08-13 v4):createPageInFolder 写**素文件**(空纯 md),
 *  绝不再经 newPage 造 v3(amadeus_page frontmatter + 块标记)——用户实测「新建笔记还是老样子」
 *  的根因就是出生格式仍是 v3。releasePage:统一编辑器接管后本 scope 快照必须清空
 *  (陈旧快照×reconcileExternal 回写=延时毁档链)。 */
import { describe, it, expect, vi, afterEach } from 'vitest'

const writes: Array<{ path: string; text: string }> = []
const writeTextFile = vi.fn(async (path: string, text: string) => {
  writes.push({ path, text })
})
const newPage = vi.fn(async () => {
  throw new Error('createPageInFolder 不许再走 newPage(v3 出生)')
})
const loadPage = vi.fn(async (path: string) => ({
  manifest: {
    schema: 'amadeus.page/3',
    id: 'pg_t',
    title: path,
    createdAt: '',
    updatedAt: '',
    compiler: { version: 't' },
    root: { type: 'stack', children: [] },
    blocks: {},
  },
  blocks: {},
}))

async function freshStore() {
  vi.resetModules()
  writes.length = 0
  writeTextFile.mockClear()
  newPage.mockClear()
  loadPage.mockClear()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('window', {
    amadeus: {
      writeTextFile,
      newPage,
      loadPage,
      listPages: async () => [],
      listFolders: async () => [],
      backlinks: async () => [],
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  return await import('./pageStore')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createPageInFolder 素文件出生', () => {
  it('写空纯 md(writeTextFile),绝不调 newPage', async () => {
    const { usePageStore: store } = await freshStore()
    store.setState({ vaultRoot: '/v', pages: [], status: 'ready' })
    await store.getState().createPageInFolder('')
    expect(newPage).not.toHaveBeenCalled()
    expect(writes).toEqual([{ path: 'untitled.md', text: '' }])
  })

  it('撞名顺延 untitled-2.md', async () => {
    const { usePageStore: store } = await freshStore()
    store.setState({ vaultRoot: '/v', pages: ['untitled.md'], status: 'ready' })
    await store.getState().createPageInFolder('')
    expect(writes[0]?.path).toBe('untitled-2.md')
  })

  it('在页面开始加载前就发布标题聚焦请求（UnifiedPage 首次挂载即可消费）', async () => {
    const { usePageStore: store } = await freshStore()
    store.setState({ vaultRoot: '/v', pages: [], status: 'ready' })
    let finish!: (value: Awaited<ReturnType<typeof loadPage>>) => void
    loadPage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const creating = store.getState().createPageInFolder('')
    await vi.waitFor(() => expect(loadPage).toHaveBeenCalledWith('untitled.md'))
    expect(store.getState().focusTitleFor).toBe('untitled.md')
    finish({
      manifest: {
        schema: 'amadeus.page/3', id: 'pg_t', title: 'untitled.md', createdAt: '', updatedAt: '',
        compiler: { version: 't' }, root: { type: 'stack', children: [] }, blocks: {},
      },
      blocks: {},
    })
    await creating
  })
})

describe('releasePage', () => {
  it('接管的文件:清空本 scope 快照;别的文件:不动', async () => {
    const { usePageStore: store } = await freshStore()
    store.setState({
      vaultRoot: '/v',
      activePage: 'a.md',
      manifest: { schema: 'amadeus.page/3', id: 'x', title: 'a', createdAt: '', updatedAt: '', compiler: { version: 't' }, root: { type: 'stack', children: [] }, blocks: {} } as never,
      blocks: {},
      status: 'ready',
    })
    await store.getState().releasePage('b.md') // 非本页:不动
    expect(store.getState().activePage).toBe('a.md')
    await store.getState().releasePage('a.md')
    expect(store.getState().activePage).toBeNull()
    expect(store.getState().manifest).toBeNull()
  })
})
