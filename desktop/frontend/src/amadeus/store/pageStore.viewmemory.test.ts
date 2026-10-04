/** 侧栏改名 / 移动 / 文件夹改名都经 remapScopePaths:本机视图记忆(锁定、排版选项,评审 C-21 / C-07)要跟着新路径走 ——
 *  此前只有标题行内改名搬记忆,拖进文件夹后全宽 / 锁定悄悄丢了。转播过来的窗口(别的窗口发起)不再搬一遍:
 *  localStorage 各窗共用,发起方已经搬好,再搬会拿本窗缓存里的旧条目盖掉新条目。 */
import { describe, it, expect, vi, afterEach } from 'vitest'

async function freshStore() {
  vi.resetModules()
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v) },
    removeItem: (k: string) => { data.delete(k) },
    get length() { return data.size },
    key: (i: number) => [...data.keys()][i] ?? null,
  })
  let relay: ((e: { from: string; kind: 'file' | 'prefix'; to: string | null; root: string }) => void) | null = null
  vi.stubGlobal('window', {
    amadeus: {
      listPages: async () => [],
      listFiles: async () => [],
      listFolders: async () => [],
      pageIcons: async () => ({}),
      onPathGone: (cb: typeof relay) => { relay = cb },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  })
  const store = await import('./pageStore')
  const vm = await import('../unified/viewMemory')
  store.usePageStore.setState({ vaultRoot: '/v' })
  return { ...store, vm, relay: () => relay! }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('remapScopePaths 搬本机视图记忆', () => {
  it('改名 / 移动(file):排版选项与锁定跟到新路径,旧路径清空', async () => {
    const { remapScopePaths, vm } = await freshStore()
    vm.writeNotePageStyle('/v', 'a.md', { wide: true, font: 'serif' })
    vm.writeNoteLocked('/v', 'a.md', true)
    remapScopePaths('a.md', 'dir/a.md', 'file')
    expect(vm.readNotePageStyle('/v', 'dir/a.md')).toEqual({ wide: true, small: false, font: 'serif' })
    expect(vm.readNoteLocked('/v', 'dir/a.md')).toBe(true)
    expect(vm.readNotePageStyle('/v', 'a.md')).toEqual(vm.DEFAULT_PAGE_STYLE)
    expect(vm.readNoteLocked('/v', 'a.md')).toBe(false)
  })

  it('文件夹改名 / 移动(prefix):子树里每篇的排版选项跟着走', async () => {
    const { remapScopePaths, vm } = await freshStore()
    vm.writeNotePageStyle('/v', 'dir/sub/n.md', { small: true })
    remapScopePaths('dir', 'dir2', 'prefix')
    expect(vm.readNotePageStyle('/v', 'dir2/sub/n.md').small).toBe(true)
    expect(vm.readNotePageStyle('/v', 'dir/sub/n.md').small).toBe(false)
  })

  it('别的窗口转播过来的改名:本窗不再搬(发起窗已搬好)', async () => {
    const { relay, vm } = await freshStore()
    vm.writeNotePageStyle('/v', 'b.md', { wide: true })
    relay()({ from: 'b.md', kind: 'file', to: 'c.md', root: '/v' })
    expect(vm.readNotePageStyle('/v', 'b.md').wide).toBe(true)
    expect(vm.readNotePageStyle('/v', 'c.md').wide).toBe(false)
  })
})
