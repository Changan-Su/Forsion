/** v4(unified)那条路径信号 `activeNotePath` 的生命周期契约(2026-08-20 Codex 评审 high ×3)。
 *  v4 笔记**永不设** activePage,只读面板一律读 `noteOf = activePage ?? activeNotePath` ——
 *  于是凡是只照顾 activePage 的善后动作(换库、改名/移动、删除),都会把 v4 面板留在一个
 *  **上一个库 / 旧路径 / 已删掉**的路径上,图谱/反链/在场/聊天引用集体指着它。
 *  这三条钉的就是「activePage 有的善后,activeNotePath 一份不少」。 */
import { describe, it, expect, vi, afterEach } from 'vitest'

async function freshStore(pages: string[] = []) {
  vi.resetModules()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  const live = new Set(pages)
  vi.stubGlobal('window', {
    amadeus: {
      savePage: async () => {},
      listPages: async () => [...live],
      listFiles: async () => [],
      listFolders: async () => [],
      backlinks: async () => [],
      pageIcons: async () => ({}),
      trashEntry: async (p: string) => { live.delete(p) },
      deletePage: async (p: string) => { live.delete(p) },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  return await import('./pageStore')
}

afterEach(() => { vi.unstubAllGlobals() })

describe('activeNotePath 的善后契约', () => {
  it('noteOf:v3 用 activePage,v4 回落 activeNotePath', async () => {
    const { noteOf } = await freshStore()
    expect(noteOf({ activePage: 'a.md', activeNotePath: 'b.md' })).toBe('a.md')
    expect(noteOf({ activePage: null, activeNotePath: 'b.md' })).toBe('b.md')
    expect(noteOf({ activePage: null, activeNotePath: null })).toBeNull()
  })

  it('换库:resetAllScopeDocs 连 activeNotePath 一起清(否则新库面板指着旧库的相对路径)', async () => {
    const { usePageStore: store, resetAllScopeDocs } = await freshStore()
    store.setState({ activePage: null, activeNotePath: 'old-vault-note.md' })
    resetAllScopeDocs()
    expect(store.getState().activeNotePath).toBeNull()
  })

  it('分屏:换库/删除要扫到**每一个** scope,不只发起的那个', async () => {
    const mod = await freshStore()
    const other = mod.pageStoreFor('leaf-2') // 另一半屏
    mod.usePageStore.setState({ activePage: null, activeNotePath: 'a.md' })
    other.setState({ activePage: null, activeNotePath: 'b.md' })
    mod.resetAllScopeDocs()
    expect(mod.usePageStore.getState().activeNotePath).toBeNull()
    expect(other.getState().activeNotePath).toBeNull()

    other.setState({ activeNotePath: 'fd/x.md' })
    mod.clearScopeNotePaths('fd', 'prefix')
    expect(other.getState().activeNotePath).toBeNull()
  })

  it('改名/移动:remapScopePaths 两个字段都跟着换(v4 面板只有 activeNotePath)', async () => {
    const { usePageStore: store, remapScopePaths } = await freshStore()
    store.setState({ activePage: null, activeNotePath: 'dir/old.md' })
    remapScopePaths('dir/old.md', 'dir/new.md', 'file')
    expect(store.getState().activeNotePath).toBe('dir/new.md')

    store.setState({ activePage: null, activeNotePath: 'fd/sub/x.md' })
    remapScopePaths('fd', 'fd2', 'prefix')
    expect(store.getState().activeNotePath).toBe('fd2/sub/x.md')
  })

  it('改名不误伤:路径不匹配的一律不动', async () => {
    const { usePageStore: store, remapScopePaths } = await freshStore()
    store.setState({ activePage: null, activeNotePath: 'other.md' })
    remapScopePaths('dir/old.md', 'dir/new.md', 'file')
    expect(store.getState().activeNotePath).toBe('other.md')
    // 前缀不能靠 startsWith 裸判:'dirx/…' 不属于 'dir' 子树
    store.setState({ activeNotePath: 'dirx/a.md' })
    remapScopePaths('dir', 'dir2', 'prefix')
    expect(store.getState().activeNotePath).toBe('dirx/a.md')
  })

  it('删除:clearScopeNotePaths 清掉指向该文件/该子树的路径,其余不动', async () => {
    const { usePageStore: store, clearScopeNotePaths } = await freshStore()
    store.setState({ activePage: null, activeNotePath: 'gone.md' })
    clearScopeNotePaths('gone.md', 'file')
    expect(store.getState().activeNotePath).toBeNull()

    store.setState({ activeNotePath: 'fd/deep/x.md' })
    clearScopeNotePaths('fd', 'prefix')
    expect(store.getState().activeNotePath).toBeNull()

    store.setState({ activeNotePath: 'keep.md' })
    clearScopeNotePaths('gone.md', 'file')
    expect(store.getState().activeNotePath).toBe('keep.md')
  })

  // 广播:v3 靠「store 导航 → activePage 变 → 标签认领」自愈,v4 的 activePage 恒 null 走不到这条,
  // 标签会一直攥着已删/已挪走的路径(显示一个已退休、打字不落盘的编辑器)。
  it('删除会广播 (path, file, null),并清掉 activeNotePath', async () => {
    const mod = await freshStore(['gone.md', 'other.md'])
    const seen: Array<[string, string, string | null]> = []
    const off = mod.onNotePathGone((from, kind, to) => seen.push([from, kind, to]))
    mod.usePageStore.setState({ vaultRoot: '/v', pages: ['gone.md', 'other.md'], activePage: null, activeNotePath: 'gone.md' })
    await mod.usePageStore.getState().deletePage('gone.md')
    off()
    expect(seen).toContainEqual(['gone.md', 'file', null])
    expect(mod.usePageStore.getState().activeNotePath).toBeNull()
  })

  it('改名/移动会广播新路径(标签据此改指,而不是停在旧路径)', async () => {
    const mod = await freshStore()
    const seen: Array<[string, string, string | null]> = []
    const off = mod.onNotePathGone((from, kind, to) => seen.push([from, kind, to]))
    mod.remapScopePaths('dir/old.md', 'dir/new.md', 'file')
    mod.remapScopePaths('fd', 'fd2', 'prefix')
    off()
    expect(seen).toEqual([['dir/old.md', 'file', 'dir/new.md'], ['fd', 'prefix', 'fd2']])
  })
})
