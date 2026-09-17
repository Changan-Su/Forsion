// @vitest-environment happy-dom
/** 仪表盘标签「文件改名 / 删除后一直在加载」(2026-09-16 用户实报,截图:标签仍叫 ybp、树里已无 ybp、
 *  骨架屏不走)。路由的渲染判据是「本 scope 的 activePage === dashPath」,而装载 effect 只看
 *  [dashPath, vaultRoot]:任何把 activePage 挪走的动作 —— 改名的 remapScopePaths、删除后
 *  deletePage 把活动 scope 导航到下一篇、别处往本 scope 里 loadPage —— 都让它两边都等不到 = 永久骨架屏。
 *  真 pageStore + 真路由,只把两个重型子视图换成桩。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const ws = vi.hoisted(() => ({ leafById: (_id: string): unknown => null, closeLeaf: (_id: string): void => {} }))
vi.mock('@lcl/engine', () => ({
  Skeleton: () => createElement('div', { 'data-tag': 'skeleton' }),
  useWorkspace: { getState: () => ({ leafById: (id: string) => ws.leafById(id), closeLeaf: (id: string) => ws.closeLeaf(id) }) },
}))
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: { div: ({ initial: _i, animate: _a, exit: _e, transition: _t, ...rest }: Record<string, unknown>) => createElement('div', rest) },
  useReducedMotion: () => true,
}))
vi.mock('./DashboardGridView', () => ({ DashboardGridView: () => createElement('div', { 'data-tag': 'grid' }) }))
vi.mock('./DashboardCanvasView', () => ({ DashboardCanvasView: () => createElement('div', { 'data-tag': 'canvas' }) }))

const DASH = 'ybp.dashboard.md'
const LEAF = 'dash-leaf'

const pageOf = (p: string) => ({
  manifest: {
    schema: 1, id: p, title: p, createdAt: '', updatedAt: '', compiler: { version: '1' },
    root: { type: 'stack', children: [] }, blocks: {}, fmExtra: '',
  },
  blocks: {},
})

let root: Root | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.innerHTML = ''
})

/** createOnLoad = web(cloudBridge.loadOrCreate)/移动端的 loadPage 语义:缺文件即新建。桌面主进程是 createIfMissing:false。 */
async function mount(dashPath = DASH, { createOnLoad = false, params = {} as Record<string, unknown>, onDisk = true, listed = true } = {}) {
  vi.resetModules()
  const disk = new Set(onDisk ? ['1.md', dashPath] : ['1.md'])
  ;(window as unknown as { amadeus: unknown }).amadeus = {
    loadPage: async (p: string) => {
      if (!disk.has(p)) {
        if (!createOnLoad) throw new Error(`ENOENT ${p}`)
        disk.add(p)
      }
      return pageOf(p)
    },
    savePage: async () => {},
    listPages: async () => [...disk].sort(),
    listFolders: async () => [],
    listFiles: async () => [],
    pageIcons: async () => ({}),
    trashEntry: async (p: string) => { disk.delete(p) },
  }
  const store = await import('@amadeus/store/pageStore')
  const { DashboardView } = await import('./DashboardView')
  store.pageStoreFor(LEAF).setState({ vaultRoot: '/vault', pages: [...disk].filter((p) => listed || p !== dashPath).sort() })

  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // 同 dockviewStore.makeLeaf:每次包装出来的 leaf.params 都是**快照**,setParams 与面板的**现**参数合并。
  const panel = { params: { dashPath, ...params } as Record<string, unknown>, closed: false }
  const setParams = vi.fn((p: Record<string, unknown>) => { panel.params = { ...panel.params, ...p }; render() })
  const close = vi.fn(() => { panel.closed = true })
  const makeLeaf = () => ({ id: LEAF, type: 'dashboard', loc: 'main' as const, params: { ...panel.params }, setTitle: vi.fn(), setParams, close })
  ws.leafById = (id) => (id === LEAF && !panel.closed ? makeLeaf() : null)
  // 删除走 store 的 closeLeaf(followPathGone),不走裸 leaf.close();桩里等价于关掉这个面板。
  ws.closeLeaf = (id) => { if (id === LEAF) close() }
  const render = (): void => {
    const leaf = makeLeaf()
    root!.render(createElement(DashboardView, { leaf, params: leaf.params }))
  }
  await act(async () => render())
  await settle()
  const shown = (): string => [...container.querySelectorAll('[data-tag]')].map((e) => e.getAttribute('data-tag')).join(',')
  return { store, disk, panel, setParams, close, shown, text: () => container.textContent ?? '' }
}

/** 装载链是几跳微任务(flush → IPC → set → effect),多给几拍。 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

describe('仪表盘标签:文件改名 / 删除 / 被挪走后不许卡在骨架屏', () => {
  it('基线:打开即出网格', async () => {
    const { shown } = await mount()
    expect(shown()).toBe('grid')
  })

  it('改名(树上 renameAt 走 remapScopePaths):标签跟到新路径,继续显示', async () => {
    const { store, disk, panel, shown } = await mount()
    disk.delete(DASH); disk.add('dash222.dashboard.md')
    await act(async () => store.remapScopePaths(DASH, 'dash222.dashboard.md', 'file'))
    await settle()
    expect(panel.params.dashPath).toBe('dash222.dashboard.md')
    expect(shown()).toBe('grid')
  })

  it('改名不许把挂载之后改过的参数退回去(新建即解锁 → 点完成锁上 → 树上改名)', async () => {
    const { store, panel, setParams } = await mount(DASH, { params: { locked: false } })
    await act(async () => setParams({ locked: true })) // dashPath 没变:路由的订阅不重挂,闭包里还是挂载时的快照
    await settle()
    await act(async () => store.remapScopePaths(DASH, 'dash222.dashboard.md', 'file'))
    await settle()
    expect(panel.params).toMatchObject({ dashPath: 'dash222.dashboard.md', locked: true })
  })

  it('所在文件夹改名(prefix):同样跟过去', async () => {
    const { store, panel, shown } = await mount(`erp/${DASH}`)
    await act(async () => store.remapScopePaths('erp', 'erp2', 'prefix'))
    await settle()
    expect(panel.params.dashPath).toBe(`erp2/${DASH}`)
    expect(shown()).toBe('grid')
  })

  it('删除(仪表盘标签聚焦时树上删它 = 在本 scope 里 deletePage):关掉这个标签', async () => {
    const { store, close } = await mount()
    await act(async () => { await store.pageStoreFor(LEAF).getState().deletePage(DASH) })
    await settle()
    expect(close).toHaveBeenCalled()
  })

  it('删除时绝不把文件建回来(web/移动端 loadPage 缺文件即新建)', async () => {
    const { store, disk, close } = await mount(DASH, { createOnLoad: true })
    await act(async () => { await store.pageStoreFor(LEAF).getState().deletePage(DASH) })
    await settle()
    expect(disk.has(DASH)).toBe(false)
    expect(close).toHaveBeenCalled()
  })

  it('清单里已没有本文件、scope 又被挪走:落失败态,不重装、不建回', async () => {
    const { store, disk, shown, text } = await mount(DASH, { createOnLoad: true })
    disk.delete(DASH) // 外部删掉(无路径广播),结构刷新已到
    await act(async () => { await store.pageStoreFor(LEAF).getState().refreshStructure() })
    await act(async () => { await store.pageStoreFor(LEAF).getState().loadPage('1.md') })
    await settle()
    expect(disk.has(DASH)).toBe(false)
    expect(shown()).not.toContain('skeleton')
    expect(text()).toContain(DASH)
  })

  it('库已就绪、清单里没有、scope 还空着(换侧 / 启动恢复一个已删的仪表盘):不装载、不建回、落失败态', async () => {
    const { disk, shown, text } = await mount(DASH, { createOnLoad: true, onDisk: false, listed: false })
    await settle()
    expect(disk.has(DASH)).toBe(false)
    expect(shown()).not.toContain('skeleton')
    expect(text()).toContain(DASH)
  })

  it('清单只是还没刷到它(插件写完即开):刷新清单后正常打开,不落失败态', async () => {
    const { shown, text } = await mount(DASH, { listed: false })
    await settle()
    expect(shown()).toBe('grid')
    expect(text()).not.toContain(DASH)
  })

  it('别处往本 scope 装了别的页(activePage 被挪走):自愈重装,不停在骨架屏', async () => {
    const { store, shown } = await mount()
    await act(async () => { await store.pageStoreFor(LEAF).getState().loadPage('1.md') })
    await settle()
    expect(shown()).toBe('grid')
    expect(store.pageStoreFor(LEAF).getState().activePage).toBe(DASH)
  })

  it('本页装不出来(文件已不在):给出错误态,不是无尽骨架屏', async () => {
    const { store, disk, shown } = await mount()
    disk.delete(DASH) // 外部删掉(没有路径广播)后,又有人把本 scope 挪走
    await act(async () => { await store.pageStoreFor(LEAF).getState().loadPage('1.md') })
    await settle()
    expect(shown()).not.toContain('skeleton')
  })
})
