/** restoreVault 读不到上次那篇(2026-11-25):宿主无关的那半,用桩桥钉。真在线桥 × 假服务端的整条链见
 *  services/cloudBridgeRestoreGone.test.ts。判据是「新树里还有没有它」,不解析错误文案 —— 桌面主进程经 IPC 来的错误
 *  只剩一句 `Error invoking remote method …`,这里就用那个形状。回落只读不建:不调 newPage / writeTextFile / savePage。 */
import { afterEach, describe, expect, it, vi } from 'vitest'

type Info = { root: string; pages: string[]; folders: string[]; lastPage?: string }
let live: string[] = []
let listGate: Promise<void> | null = null
const ipcNotFound = (p: string): Error => new Error(`Error invoking remote method 'amadeus:loadPage': Error: Note not found: ${p}`)
const loaded = (p: string) => ({ manifest: { id: `pg_${p}`, title: p, schema: 'amadeus.page/3', root: { type: 'stack', children: [] }, blocks: {} }, blocks: {} })
const bridge = {
  restoreVault: vi.fn(async (): Promise<Info | null> => ({ root: '/vault', pages: ['gone.md', 'keep.md'], folders: [], lastPage: 'gone.md' })),
  listFiles: vi.fn(async () => [] as string[]),
  listPages: vi.fn(async () => { if (listGate) await listGate; return [...live] }),
  listFolders: vi.fn(async () => [] as string[]),
  loadPage: vi.fn(async (p: string) => { if (!live.includes(p)) throw ipcNotFound(p); return loaded(p) }),
  newPage: vi.fn(async () => { throw new Error('newPage must not run') }),
  readTextFile: vi.fn(async () => null),
  writeTextFile: vi.fn(async () => { throw new Error('writeTextFile must not run') }),
  savePage: vi.fn(async () => { throw new Error('savePage must not run') }),
}

async function freshStore() {
  vi.resetModules()
  for (const fn of Object.values(bridge)) fn.mockClear()
  live = ['keep.md']
  listGate = null
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('window', { amadeus: bridge, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true })
  return import('./pageStore')
}
const noWrites = () => {
  for (const fn of [bridge.newPage, bridge.writeTextFile, bridge.savePage]) expect(fn).not.toHaveBeenCalled()
}

afterEach(() => { vi.unstubAllGlobals() })

describe('pageStore.restoreVault × 启动页已不在', () => {
  it('IPC 形状的 not found + 新树里没有它 → 回落到新树第一篇,清错误,不建', async () => {
    const { usePageStore } = await freshStore()
    await usePageStore.getState().restoreVault()
    expect(usePageStore.getState()).toMatchObject({ activePage: 'keep.md', error: null, pages: ['keep.md'] })
    expect(bridge.loadPage.mock.calls.map((c) => c[0])).toEqual(['gone.md', 'keep.md'])
    noWrites()
  })

  it('新树里一篇都没有 → 空态(无错误),不建', async () => {
    const { usePageStore } = await freshStore()
    live = []
    await usePageStore.getState().restoreVault()
    expect(usePageStore.getState()).toMatchObject({ activePage: null, error: null, pages: [] })
    noWrites()
  })

  it('刷新树的途中用户自己点开了别的 → 不顶掉他', async () => {
    const { usePageStore } = await freshStore()
    live = ['keep.md', 'mine.md']
    let open!: () => void
    listGate = new Promise<void>((r) => { open = r })
    const restoring = usePageStore.getState().restoreVault()
    await vi.waitFor(() => expect(bridge.listPages).toHaveBeenCalled())
    listGate = null
    await usePageStore.getState().loadPage('mine.md')
    open()
    await restoring
    expect(usePageStore.getState().activePage).toBe('mine.md')
    expect(bridge.loadPage.mock.calls.map((c) => c[0])).toEqual(['gone.md', 'mine.md'])
    noWrites()
  })

  it('刷新树的途中换了库 → 作废,不回落', async () => {
    const { usePageStore } = await freshStore()
    let open!: () => void
    listGate = new Promise<void>((r) => { open = r })
    const restoring = usePageStore.getState().restoreVault()
    await vi.waitFor(() => expect(bridge.listPages).toHaveBeenCalled())
    usePageStore.setState({ vaultRoot: '/other' })
    open()
    await restoring
    expect(usePageStore.getState().activePage).toBeNull()
    expect(bridge.loadPage.mock.calls.map((c) => c[0])).toEqual(['gone.md'])
    noWrites()
  })
})
