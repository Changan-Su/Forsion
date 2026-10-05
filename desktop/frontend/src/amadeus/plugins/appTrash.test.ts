// ctx.app.trash(2026-10-05):插件把库内的文件 / 文件夹移进回收站。
// 钉四件事:①没有回收站的宿主**整条方法不挂**(插件按「有没有这个方法」决定画不画删除按钮);
// ②走的是文件树删除的同一条路(deletePage / deleteFolder),不是自己再造一份;
// ③那两条把失败吞进 store.error,这层必须把「没删掉」报给插件;④停用后的插件删不了东西。
// api.ts 在模块加载时就把 window.amadeus 抓成常量,所以这里 mock 模块而不是塞 window(同 vaultQuery.test.ts)。
import { describe, expect, it, beforeEach, vi } from 'vitest'

const bridge: { current: Record<string, unknown> | undefined } = { current: undefined }
vi.mock('../api', () => ({
  get amadeus() {
    return bridge.current
  },
}))

const { usePluginStore } = await import('./pluginStore')
const { usePageStore } = await import('../store/pageStore')
type Ctx = import('./types').PluginContext

function ctxOf(id: string): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c) => { ref = c } }])
  return ref!
}

/** 一份假的库清单 + 文件树删除动作:删成功就把那一项(文件夹连同子树)从清单里拿掉。 */
function vault(lists: { pages?: string[]; folders?: string[]; files?: string[] }, opts: { fail?: boolean } = {}) {
  const drop = (path: string, prefix: boolean): void => {
    if (opts.fail) { usePageStore.setState({ error: 'EPERM: operation not permitted' }); return }
    const keep = (x: string): boolean => x !== path && !(prefix && x.startsWith(`${path}/`)) && !(prefix && x.startsWith(`${path}\\`))
    const s = usePageStore.getState()
    usePageStore.setState({ pages: s.pages.filter(keep), folders: s.folders.filter(keep), files: s.files.filter(keep) })
  }
  const deletePage = vi.fn(async (p: string) => drop(p, false))
  const deleteFolder = vi.fn(async (p: string) => drop(p, true))
  const refreshStructure = vi.fn(async () => {})
  usePageStore.setState({ pages: lists.pages ?? [], folders: lists.folders ?? [], files: lists.files ?? [], error: null, deletePage, deleteFolder, refreshStructure } as never)
  return { deletePage, deleteFolder, refreshStructure }
}

describe('ctx.app.trash', () => {
  beforeEach(() => {
    bridge.current = undefined
    // (停用插件会清它的外观设置,那条路要 localStorage;node 环境没有)
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  })

  it('没有回收站的宿主:方法整个不存在', () => {
    expect(ctxOf('p-none').app.trash).toBeUndefined()
    bridge.current = { revealInFileManager: vi.fn() } // 桥在、但没有 trashEntry(web / 移动端)
    expect(ctxOf('p-web').app.trash).toBeUndefined()
  })

  it('文件夹走 deleteFolder,文件走 deletePage(文件树删除的同一条路),先刷新清单', async () => {
    bridge.current = { trashEntry: vi.fn() }
    const ctx = ctxOf('p-ok')
    const v = vault({ folders: ['Videos', 'Videos/片头', 'Videos/片头/media'], files: ['Videos/片头/片头.fvs.md', 'Videos/片头/media/a.png', 'Videos/其他.fvs.md'], pages: ['Videos/笔记.md'] })
    await expect(ctx.app.trash!('/Videos/片头/')).resolves.toBeUndefined()
    expect(v.refreshStructure).toHaveBeenCalled()
    expect(v.deleteFolder).toHaveBeenCalledWith('Videos/片头')
    expect(v.deletePage).not.toHaveBeenCalled()
    await ctx.app.trash!('Videos/其他.fvs.md')
    expect(v.deletePage).toHaveBeenCalledWith('Videos/其他.fvs.md')
    await ctx.app.trash!('Videos/笔记.md') // 笔记也是文件树上的一项
    expect(v.deletePage).toHaveBeenLastCalledWith('Videos/笔记.md')
    expect(usePageStore.getState().files).toEqual([])
  })

  it('⚠️Windows:清单里是反斜杠,交给仓库动作的必须是清单里的原样字符串', async () => {
    bridge.current = { trashEntry: vi.fn() }
    const ctx = ctxOf('p-win')
    const v = vault({ folders: ['Videos\\片头'], files: ['Videos\\片头\\片头.fvs.md'] })
    await ctx.app.trash!('Videos/片头')
    expect(v.deleteFolder).toHaveBeenCalledWith('Videos\\片头')
  })

  it('清单里没有的路径(不存在 / 点目录里的 / 库根)→ reject,什么都不删', async () => {
    bridge.current = { trashEntry: vi.fn() }
    const ctx = ctxOf('p-miss')
    const v = vault({ folders: ['Videos'], files: ['Videos/a.fvs.md'] })
    await expect(ctx.app.trash!('Videos/nope.fvs.md')).rejects.toThrow(/No such file or folder/)
    await expect(ctx.app.trash!('Videos/.fvs-jobs/x.json')).rejects.toThrow(/No such file or folder/)
    await expect(ctx.app.trash!('')).rejects.toThrow(/No such file or folder/)
    await expect(ctx.app.trash!('/')).rejects.toThrow(/No such file or folder/)
    expect(v.deletePage).not.toHaveBeenCalled()
    expect(v.deleteFolder).not.toHaveBeenCalled()
  })

  it('名字首尾的空格是名字的一部分:`Foo ` 不许落到 `Foo` 头上;首尾斜杠照旧不算', async () => {
    bridge.current = { trashEntry: vi.fn() }
    const ctx = ctxOf('p-space')
    const v = vault({ folders: ['Foo', 'Bar '], files: ['Foo/a.fvs.md'] })
    await expect(ctx.app.trash!('Foo ')).rejects.toThrow(/No such file or folder/)
    await expect(ctx.app.trash!(' Foo')).rejects.toThrow(/No such file or folder/)
    expect(v.deleteFolder).not.toHaveBeenCalled()
    await ctx.app.trash!('/Bar /')
    expect(v.deleteFolder).toHaveBeenCalledWith('Bar ')
  })

  it('等清单的那一下换了库 → reject,不到另一个库里去删同名路径', async () => {
    bridge.current = { trashEntry: vi.fn() }
    const ctx = ctxOf('p-vault')
    const v = vault({ folders: ['Videos'], files: ['Videos/a.fvs.md'] })
    usePageStore.setState({ vaultRoot: '/vault/local' } as never)
    v.refreshStructure.mockImplementationOnce(async () => { usePageStore.setState({ vaultRoot: '/vault/cloud' } as never) })
    await expect(ctx.app.trash!('Videos/a.fvs.md')).rejects.toThrow(/active vault changed/)
    expect(v.deletePage).not.toHaveBeenCalled()
    await ctx.app.trash!('Videos/a.fvs.md') // 库没再变:照常删
    expect(v.deletePage).toHaveBeenCalledWith('Videos/a.fvs.md')
    usePageStore.setState({ vaultRoot: null } as never)
  })

  it('文件树那条把失败吞进 store.error:删完还在清单里 → reject,把原因带出来', async () => {
    bridge.current = { trashEntry: vi.fn() }
    const ctx = ctxOf('p-fail')
    vault({ folders: ['Videos'], files: ['Videos/a.fvs.md'] }, { fail: true })
    await expect(ctx.app.trash!('Videos/a.fvs.md')).rejects.toThrow(/EPERM/)
    await expect(ctx.app.trash!('Videos')).rejects.toThrow(/EPERM/)
  })

  it('删完立刻重列:listFiles / listPages 不再给删之前的那份缓存(真机台架抓到:删掉的工程又回到列表里)', async () => {
    const listFiles = vi.fn(async () => usePageStore.getState().files.slice())
    const listPages = vi.fn(async () => usePageStore.getState().pages.slice())
    bridge.current = { trashEntry: vi.fn(), listFiles, listPages }
    const ctx = ctxOf('p-cache')
    vault({ folders: ['Videos'], files: ['Videos/a.fvs.md', 'Videos/b.fvs.md'], pages: ['Videos/n.md'] })
    expect(await ctx.app.listFiles!()).toEqual(['Videos/a.fvs.md', 'Videos/b.fvs.md'])
    expect(await ctx.app.listPages!()).toEqual(['Videos/n.md'])
    await ctx.app.trash!('Videos/a.fvs.md')
    expect(await ctx.app.listFiles!()).toEqual(['Videos/b.fvs.md'])
    expect(await ctx.app.listPages!()).toEqual(['Videos/n.md'])
    await ctx.app.trash!('Videos/n.md')
    expect(await ctx.app.listPages!()).toEqual([])
  })

  it('停用后的插件删不了东西(入口挡一次,等清单那一下之后再挡一次)', async () => {
    bridge.current = { trashEntry: vi.fn() }
    const ctx = ctxOf('p-off')
    const v = vault({ files: ['a.fvs.md'] })
    let release = (): void => {}
    v.refreshStructure.mockImplementationOnce(() => new Promise<void>((done) => { release = done }))
    const pending = ctx.app.trash!('a.fvs.md')
    usePluginStore.getState().disable('p-off')
    release()
    await expect(pending).rejects.toThrow(/plugin disabled/)
    await expect(ctx.app.trash!('a.fvs.md')).rejects.toThrow(/plugin disabled/)
    expect(v.deletePage).not.toHaveBeenCalled()
  })
})
