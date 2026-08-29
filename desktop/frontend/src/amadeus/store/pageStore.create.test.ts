/** 新建笔记出生格式契约(2026-08-13 v4):createPageInFolder 写**素文件**(空纯 md),
 *  绝不再经 newPage 造 v3(amadeus_page frontmatter + 块标记)——用户实测「新建笔记还是老样子」
 *  的根因就是出生格式仍是 v3。releasePage:统一编辑器接管后本 scope 快照必须清空
 *  (陈旧快照×reconcileExternal 回写=延时毁档链)。 */
import { describe, it, expect, vi, afterEach } from 'vitest'

const writes: Array<{ path: string; text: string }> = []
const dispatched: string[] = []
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
  dispatched.length = 0
  vi.stubGlobal('CustomEvent', class { type: string; detail: unknown; defaultPrevented = false
    constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail }
    preventDefault() { this.defaultPrevented = true }
  })
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
    // 宿主未接管(台架/单测):dispatchEvent 返 true → createPageInFolder 退回就地 loadPage。
    dispatchEvent: (e: { type: string; defaultPrevented: boolean }) => { dispatched.push(e.type); return !e.defaultPrevented },
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

  it('在页面开始加载前就发布标题聚焦请求（编辑器首次挂载即可认领）', async () => {
    const { usePageStore: store, claimTitleFocus } = await freshStore()
    store.setState({ vaultRoot: '/v', pages: [], status: 'ready' })
    let finish!: (value: Awaited<ReturnType<typeof loadPage>>) => void
    loadPage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const creating = store.getState().createPageInFolder('')
    await vi.waitFor(() => expect(loadPage).toHaveBeenCalledWith('untitled.md'))
    // 信号住模块级、按 path 认领:落点面板由宿主 openNote 现算(可能是新开的 leaf),
    // 存进创建时那个 scope 的话,跨面板导航后永远没人消费得到。
    expect(claimTitleFocus('untitled.md')).toBe(true)
    expect(claimTitleFocus('untitled.md')).toBe(false) // 一次性
    finish({
      manifest: {
        schema: 'amadeus.page/3', id: 'pg_t', title: 'untitled.md', createdAt: '', updatedAt: '',
        compiler: { version: 't' }, root: { type: 'stack', children: [] }, blocks: {},
      },
      blocks: {},
    })
    await creating
  })

  // 用户实报(2026-08-29):站在主页/聊天上点「新建笔记」,工作区列表里出现了新笔记,当前 view 却没跳过去。
  // 根因 = 这里直调 loadPage,装的是**活动 scope**(只跟着编辑器面板走)= 一个看不见的后台 tab。
  it('导航交给宿主 openNote 门面(发 amadeus:navigate-note),宿主接管时不再就地 loadPage', async () => {
    const { usePageStore: store } = await freshStore()
    store.setState({ vaultRoot: '/v', pages: [], status: 'ready' })
    await store.getState().createPageInFolder('')
    expect(dispatched).toContain('amadeus:navigate-note')
    expect(loadPage).toHaveBeenCalledWith('untitled.md') // 无监听 → 退回就地装载

    // 宿主接管(preventDefault)→ 一律由 openNote 决定落点,绝不再自己 loadPage
    const { usePageStore: s2 } = await freshStore()
    ;(globalThis as unknown as { window: { dispatchEvent: (e: { type: string }) => boolean } }).window.dispatchEvent =
      (e) => { dispatched.push(e.type); return false }
    s2.setState({ vaultRoot: '/v', pages: [], status: 'ready' })
    await s2.getState().createPageInFolder('')
    expect(dispatched).toContain('amadeus:navigate-note')
    expect(loadPage).not.toHaveBeenCalled()
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
