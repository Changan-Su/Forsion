// @vitest-environment happy-dom
/** 文件类标签在树上被改名、挪走、删除之后还攥着旧路径(2026-09-16)。
 *  第一版在视图里订阅 onNotePathGone —— 视图没挂载就收不到(Codex 评审):
 *  折叠侧栏里的面板被序列化进 stash、移动端单列壳只渲染当前那一个 leaf、崩进错误边界的视图已卸载。
 *  现在由工作区 store 层统一跟随:每次广播把**所有** leaf 记录(Dockview panel + stash / 单列三桶)过一遍。
 *  真 pageStore + 真 dockviewStore(Dockview 换最小桩,同 bottomPanel.test)/ 真 singleColumnStore。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('../stores/themeStore', () => ({ useTheme: (sel: (s: { mode: string; flat: boolean }) => unknown) => sel({ mode: 'light', flat: false }) }))
vi.mock('@amadeus/blocks/excalidraw/ExcalidrawEmbed', () => ({ ExcalidrawEmbed: () => null }))
vi.mock('@amadeus/blocks/database/DatabaseEmbed', () => ({ DatabaseEmbed: () => null }))
vi.mock('@amadeus/blocks', () => ({}))
vi.mock('@amadeus/pdf/PdfAnnotator', () => ({ PdfAnnotator: () => null }))
vi.mock('@amadeus/components/MediaPlayer', () => ({ MediaPlayer: () => null }))
vi.mock('../amadeusNav', () => ({ openFile: () => {} }))
vi.mock('../amadeus/plugins/viewSurface', () => ({ createPluginViewSurface: () => ({ surface: {}, dispose: () => {} }) }))
vi.mock('../amadeus/plugins/pluginStore', () => {
  const FT = { id: 'probe', extensions: ['.probe.md'], mount: () => () => {} }
  const state = { fileTypes: [{ pluginId: 'probe', item: FT }] }
  return {
    usePluginStore: Object.assign((sel: (s: typeof state) => unknown) => sel(state), { getState: () => state }),
    findFileType: (_fts: unknown, p: string) => (p.endsWith('.probe.md') ? FT : undefined),
    fileTypeBaseName: (p: string) => (p.split('/').pop() ?? p).replace(/\.probe\.md$/, ''),
    addPluginViewTeardown: () => () => {},
  }
})

type Case = { type: string; key: string; file: string; extra?: Record<string, unknown> }
const CASES: Case[] = [
  { type: 'amadeus-plugin-file', key: 'filePath', file: '导图.probe.md' },
  { type: 'amadeus-drawing', key: 'drawingPath', file: '板.excalidraw.md' },
  { type: 'amadeus-db', key: 'dbPath', file: '表.db', extra: { view: '看板' } },
  { type: 'amadeus-pdf', key: 'pdfPath', file: '书.pdf', extra: { page: 7 } },
  { type: 'amadeus-image', key: 'imagePath', file: '图.png' },
  { type: 'amadeus-media', key: 'path', file: '课.mp4', extra: { at: 120 } },
  { type: 'dashboard', key: 'dashPath', file: '盘.dashboard.md' },
]
const paramsOf = (c: Case, dir: string): Record<string, unknown> => ({ [c.key]: `${dir}${c.file}`, ...c.extra })
/** 树上的「页」只有普通笔记(含 .dashboard.md);插件复合后缀与白板被 listPages 排除,归 files。 */
const isPage = (p: string): boolean => p.endsWith('.md') && !/\.(probe|excalidraw)\.md$/.test(p)

type Panel = { id: string; title: string; params: Record<string, unknown>; group: { api: Record<string, unknown>; activePanel: unknown }; api: Record<string, unknown> }
/** 最小 Dockview 桩(同 lcl/engine/bottomPanel.test.ts):updateParameters 合并、值为 undefined 的键删掉。 */
function dockApi(seed: Array<{ id: string; type: string; loc?: string; params?: Record<string, unknown> }>) {
  const panels: Panel[] = []
  const mk = (id: string, params: Record<string, unknown>): Panel => {
    const group = { api: { width: 300, height: 600, setSize() {}, setConstraints() {} }, activePanel: null as unknown }
    const p: Panel = {
      id, title: id, params, group,
      api: {
        close: () => { const i = panels.indexOf(p); if (i >= 0) panels.splice(i, 1) },
        setActive: () => {}, setTitle: () => {},
        updateParameters: (np: Record<string, unknown>) => {
          p.params = { ...p.params, ...np }
          for (const k of Object.keys(np)) if (np[k] === undefined) delete p.params[k]
        },
      },
    }
    group.activePanel = p
    return p
  }
  for (const s of seed) panels.push(mk(s.id, { ...s.params, __loc: s.loc ?? 'main', __type: s.type }))
  const api = {
    width: 1600, height: 1000, panels, activePanel: null,
    getPanel: (id: string) => panels.find((p) => p.id === id),
    toJSON: () => ({}),
    addPanel: (o: { id: string; params: Record<string, unknown> }) => { const p = mk(o.id, o.params); panels.push(p); return p },
  }
  return { api, panels }
}

async function boot(kind: 'dock' | 'single', files: string[]) {
  vi.resetModules()
  // 桌面 Dockview store 还是单列(移动 / mini)store —— 与 workspaceStore 选择器同一个二选一
  vi.doMock('@lcl/engine', async () => {
    const { useWorkspace } = kind === 'single' ? await import('@lcl/engine/singleColumnStore') : await import('@lcl/engine/dockviewStore')
    return { Skeleton: () => null, useWorkspace }
  })
  const disk = new Set(files)
  const under = (x: string, p: string): boolean => x === p || x.startsWith(`${p}/`)
  const remote: { cb: ((p: { from: string; kind: 'file' | 'prefix'; to: string | null; root: string }) => void) | null } = { cb: null }
  const folders = (): string[] => [...new Set([...disk].flatMap((p) => p.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))))]
  ;(window as unknown as { amadeus: unknown }).amadeus = {
    loadPage: async (p: string) => { throw new Error(`跟随不许装页:${p}`) },
    savePage: async () => {},
    listPages: async () => [...disk].filter(isPage).sort(),
    listFolders: async () => folders().sort(),
    listFiles: async () => [...disk].filter((p) => !isPage(p)).sort(),
    pageIcons: async () => ({}),
    trashEntry: async (p: string) => { for (const x of [...disk]) if (under(x, p)) disk.delete(x) },
    readDatabase: async (_page: string, ref: string) =>
      disk.has(ref) ? { status: 'ok', path: ref, data: { version: 1, name: 'x', columns: [], rows: [] }, version: 'v1' } : { status: 'missing' },
    renameDbFile: async (oldPath: string, base: string) => {
      const newPath = `${oldPath.slice(0, oldPath.lastIndexOf('/') + 1)}${base}.db`
      disk.delete(oldPath)
      disk.add(newPath)
      return { newPath, rewrittenPages: [] }
    },
    broadcastPathGone: vi.fn(),
    onPathGone: (cb: typeof remote.cb) => { remote.cb = cb; return () => {} },
  }
  const store = await import('@amadeus/store/pageStore')
  store.pageStoreFor(store.MAIN_SCOPE).setState({
    vaultRoot: '/vault', pages: [...disk].filter(isPage), files: [...disk].filter((p) => !isPage(p)), folders: folders(),
  })
  const { registerView } = await import('@lcl/engine/viewRegistry')
  for (const t of ['home', 'sidebar-empty', 'x', 'amadeus-editor', ...CASES.map((c) => c.type)]) registerView({ type: t, displayName: t, factory: () => null })
  const { useWorkspace } = await import('@lcl/engine')
  const { installLeafPathFollow } = await import('./followPathGone')
  installLeafPathFollow()
  return { store, ws: useWorkspace as never as { getState(): any; setState(s: object): void }, disk, remote }
}

/** 删除链是几跳微任务(flush → IPC → refreshStructure → 广播),多给几拍。 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
const ALL = CASES.flatMap((c) => [`资料/${c.file}`, `资料2/${c.file}`, c.file])

describe('桌面 Dockview:后台标签与折叠侧栏(stash)里的文件标签都跟随', () => {
  const seed = (dirs: string[]) => [
    { id: 'front', type: 'x' },
    ...dirs.flatMap((d) => CASES.map((c) => ({ id: `${c.type}@${d}`, type: c.type, params: paramsOf(c, d) }))),
  ]

  it('文件夹改名(prefix):面板与 stash 条目改指,其它参数与 __loc/__type 原样;同名前缀的兄弟文件夹不算子树', async () => {
    const { store, ws } = await boot('dock', ALL)
    const { api, panels } = dockApi(seed(['资料/', '资料2/']))
    ws.getState().setApi(api)
    ws.setState({ stash: { left: [], right: CASES.map((c) => ({ type: c.type, params: paramsOf(c, '资料/') })), bottom: [] } })
    await act(async () => store.remapScopePaths('资料', '归档', 'prefix'))
    for (const c of CASES) {
      expect(panels.find((p) => p.id === `${c.type}@资料/`)!.params).toEqual({ ...paramsOf(c, '归档/'), __loc: 'main', __type: c.type })
      expect(panels.find((p) => p.id === `${c.type}@资料2/`)!.params).toEqual({ ...paramsOf(c, '资料2/'), __loc: 'main', __type: c.type })
    }
    expect(ws.getState().stash.right).toEqual(CASES.map((c) => ({ type: c.type, params: paramsOf(c, '归档/') })))
  })

  it('单个文件改名 / 挪走(file):只动攥着这一个路径的', async () => {
    const { store, ws } = await boot('dock', ALL)
    const { api, panels } = dockApi(seed(['', '资料/']))
    ws.getState().setApi(api)
    for (const c of CASES) await act(async () => store.remapScopePaths(c.file, `归档/${c.file}`, 'file'))
    for (const c of CASES) {
      expect(panels.find((p) => p.id === `${c.type}@`)!.params[c.key]).toBe(`归档/${c.file}`)
      expect(panels.find((p) => p.id === `${c.type}@资料/`)!.params[c.key]).toBe(`资料/${c.file}`)
    }
  })

  it('文件夹删除:树下的标签全关、stash 里的条目摘掉;别处的原样', async () => {
    const { store, ws } = await boot('dock', ALL)
    const { api, panels } = dockApi(seed(['资料/', '资料2/']))
    ws.getState().setApi(api)
    const keep = { type: 'amadeus-pdf', params: { pdfPath: '资料2/书.pdf' } }
    ws.setState({ stash: { left: [], right: [...CASES.map((c) => ({ type: c.type, params: paramsOf(c, '资料/') })), keep], bottom: [] } })
    await act(async () => { await store.usePageStore.getState().deleteFolder('资料') })
    await settle()
    expect(panels.map((p) => p.id).sort()).toEqual(['front', ...CASES.map((c) => `${c.type}@资料2/`)].sort())
    expect(ws.getState().stash.right).toEqual([keep])
  })

  it('删除走 store 的 closeLeaf,不是裸 panel.api.close():主区只剩它 → 就地变 home;侧栏只剩它 → 补空占位', async () => {
    const { store, ws } = await boot('dock', ALL)
    const { api, panels } = dockApi([
      { id: 'only-main', type: 'amadeus-pdf', params: { pdfPath: '书.pdf' } },
      { id: 'only-right', type: 'amadeus-image', loc: 'right', params: { imagePath: '图.png' } },
    ])
    ws.getState().setApi(api)
    await act(async () => { await store.usePageStore.getState().deletePage('书.pdf') })
    await act(async () => { await store.usePageStore.getState().deletePage('图.png') })
    await settle()
    expect(panels.map((p) => [p.params.__loc, p.params.__type])).toEqual([['main', 'home'], ['right', 'sidebar-empty']])
    expect(panels[0].id).toBe('only-main') // 同一个 panel 就地换型,不是关掉再新开
  })
})

describe('单列壳(移动端 / mini):只渲染当前那一个 leaf,后台的也要跟', () => {
  const recs = (dir: string) => CASES.map((c) => ({ id: `${c.type}#1`, type: c.type, loc: 'main', params: paramsOf(c, dir), title: c.type }))

  it('后台主区 leaf 与抽屉里的 leaf:改名跟随、删除关掉,当前 leaf 不受影响', async () => {
    const { store, ws } = await boot('single', ALL)
    ws.setState({
      mainLeaves: [{ id: 'front', type: 'x', loc: 'main', params: {}, title: 'x' }, ...recs('资料/')],
      leftLeaves: [{ id: 'side', type: 'amadeus-pdf', loc: 'left', params: { pdfPath: '资料/书.pdf', page: 2 }, title: 'pdf' }],
      rightLeaves: [], activeMainId: 'front', leftActiveId: 'side',
    })
    await act(async () => store.remapScopePaths('资料', '归档', 'prefix'))
    expect(ws.getState().mainLeaves.slice(1).map((r: { params: unknown }) => r.params)).toEqual(CASES.map((c) => paramsOf(c, '归档/')))
    expect(ws.getState().leftLeaves[0].params).toEqual({ pdfPath: '归档/书.pdf', page: 2 })

    await act(async () => { await store.usePageStore.getState().deleteFolder('资料') })
    await settle()
    // 挪走之后树上已经没有「资料」了:删的是改名后的那一份才会关
    expect(ws.getState().mainLeaves).toHaveLength(1 + CASES.length)
    await act(async () => { await store.usePageStore.getState().deleteFolder('归档') })
    await settle()
    expect(ws.getState().mainLeaves.map((r: { id: string }) => r.id)).toEqual(['front'])
    expect(ws.getState().leftLeaves).toEqual([])
    expect(ws.getState().activeMainId).toBe('front')
  })

  it('主区只剩被删的那个 → 就地变 home(不是整桶清空)', async () => {
    const { store, ws } = await boot('single', ALL)
    ws.setState({ mainLeaves: [{ id: 'm', type: 'amadeus-db', loc: 'main', params: { dbPath: '表.db' }, title: 'db' }], leftLeaves: [], rightLeaves: [], activeMainId: 'm' })
    await act(async () => { await store.usePageStore.getState().deletePage('表.db') })
    await settle()
    expect(ws.getState().mainLeaves.map((r: { id: string; type: string }) => [r.id, r.type])).toEqual([['m', 'home']])
  })
})

describe('笔记编辑器标签(amadeus-editor)', () => {
  it('没挂载的编辑器标签也跟随改名;删除不关标签,改指到库里还活着的一篇(同已挂载编辑器的回落)', async () => {
    const { store, ws } = await boot('dock', ['1.md', '资料/笔记.md', '资料/别的.md'])
    const { api, panels } = dockApi([{ id: 'front', type: 'x' }, { id: 'ed', type: 'amadeus-editor', params: { notePath: '资料/笔记.md', followActive: false } }])
    ws.getState().setApi(api)
    ws.setState({ stash: { left: [], right: [{ type: 'amadeus-editor', params: { notePath: '资料/别的.md' } }], bottom: [] } })
    await act(async () => store.remapScopePaths('资料/笔记.md', '资料/改名.md', 'file'))
    expect(panels[1].params.notePath).toBe('资料/改名.md')
    await act(async () => { await store.usePageStore.getState().deleteFolder('资料') })
    await settle()
    expect(panels[1].params).toEqual({ notePath: '1.md', followActive: false, __loc: 'main', __type: 'amadeus-editor' })
    expect(ws.getState().stash.right).toEqual([{ type: 'amadeus-editor', params: { notePath: '1.md' } }])
  })
})

describe('多窗口:别的窗口转来的路径广播', () => {
  it('本窗的标签照样跟随,且不再转回主进程', async () => {
    const { ws, remote } = await boot('dock', ALL)
    const { api, panels } = dockApi([{ id: 'front', type: 'x' }, { id: 'p', type: 'amadeus-pdf', params: { pdfPath: '资料/书.pdf', page: 3 } }])
    ws.getState().setApi(api)
    await act(async () => remote.cb!({ from: '资料', kind: 'prefix', to: '归档', root: '/vault' }))
    expect(panels[1].params.pdfPath).toBe('归档/书.pdf')
    await act(async () => remote.cb!({ from: '归档/书.pdf', kind: 'file', to: null, root: '/vault' }))
    expect(panels.map((p) => p.id)).toEqual(['front'])
    expect((window as unknown as { amadeus: { broadcastPathGone: ReturnType<typeof vi.fn> } }).amadeus.broadcastPathGone).not.toHaveBeenCalled()
  })

  it('只挂了文件视图的分离窗没恢复库根(vaultRoot 为空):照样跟 —— 它读写的就是主进程当前的库', async () => {
    const { store, ws, remote } = await boot('dock', ALL)
    store.pageStoreFor(store.MAIN_SCOPE).setState({ vaultRoot: null })
    const { api, panels } = dockApi([{ id: 'p', type: 'amadeus-pdf', params: { pdfPath: '资料/书.pdf' } }])
    ws.getState().setApi(api)
    await act(async () => remote.cb!({ from: '资料', kind: 'prefix', to: '归档', root: '/vault' }))
    expect(panels[0].params.pdfPath).toBe('归档/书.pdf')
  })
})

describe('多维表:树上 / 标题改名走 renameDb', () => {
  it('标签跟到新名,正在看的视图(view 参数)不丢', async () => {
    const { ws } = await boot('dock', ['1.md', '资料/表.db'])
    const { api, panels } = dockApi([{ id: 'front', type: 'x' }, { id: 'db', type: 'amadeus-db', params: { dbPath: '资料/表.db', view: '表格' } }])
    ws.getState().setApi(api)
    const { renameDb } = await import('@amadeus/lib/dbFileOps')
    await act(async () => { await renameDb('资料/表.db', '新表') })
    expect(panels[1].params).toEqual({ dbPath: '资料/新表.db', view: '表格', __loc: 'main', __type: 'amadeus-db' })
  })
})

type Mounted = { type: string; key: string; file: string; load: () => Promise<ComponentType<any>> }
const VIEWS: Mounted[] = [
  { type: 'amadeus-plugin-file', key: 'filePath', file: '导图.probe.md', load: async () => (await import('./AmadeusPluginFileView')).AmadeusPluginFileView },
  { type: 'amadeus-drawing', key: 'drawingPath', file: '板.excalidraw.md', load: async () => (await import('./AmadeusDrawingView')).AmadeusDrawingView },
  { type: 'amadeus-db', key: 'dbPath', file: '表.db', load: async () => (await import('./AmadeusDbView')).AmadeusDbView },
  { type: 'amadeus-pdf', key: 'pdfPath', file: '书.pdf', load: async () => (await import('./AmadeusPdfView')).AmadeusPdfView },
  { type: 'amadeus-image', key: 'imagePath', file: '图.png', load: async () => (await import('./AmadeusImageView')).AmadeusImageView },
  { type: 'amadeus-media', key: 'path', file: '课.mp4', load: async () => (await import('./AmadeusMediaView')).AmadeusMediaView },
]

let root: Root | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.innerHTML = ''
})

/** 视图挂在一个**不属于工作区**的宿主里(仪表盘 ViewCard / Agent Desk 自己合成的 leaf)。 */
async function mountCard(v: Mounted) {
  const env = await boot('dock', ['1.md', v.file])
  env.ws.getState().setApi(dockApi([{ id: 'front', type: 'x' }]).api)
  const card = { id: 'card', type: v.type, loc: 'main' as const, params: { [v.key]: v.file } as Record<string, unknown>, setTitle: () => {}, setParams: vi.fn(), close: vi.fn() }
  const View = await v.load()
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(View, { leaf: card, params: card.params })))
  await settle()
  return { ...env, card }
}

describe.each(VIEWS)('$type 挂在卡片里', (v) => {
  it('卡片宿主一概不动:卡片的 close() = 从仪表盘里删卡并落盘', async () => {
    const { store, card } = await mountCard(v)
    await act(async () => store.remapScopePaths(v.file, `归档/${v.file}`, 'file'))
    await act(async () => { await store.usePageStore.getState().deletePage(v.file) })
    await settle()
    expect(card.setParams).not.toHaveBeenCalled()
    expect(card.close).not.toHaveBeenCalled()
  })
})

describe('插件文件:视图内换文件', () => {
  it('插件经 surface.loadPage 在本视图里换到另一个同类型文件:标签参数跟过去', async () => {
    const v = VIEWS[0]
    const { store, card } = await mountCard(v)
    // surface 在本测试里是桩,直接摆出「本视图 scope 先装着本文件、再被插件换成另一张」这两步状态
    const scope = store.pageStoreFor(`plug:${card.id}`)
    await act(async () => scope.setState({ activePage: v.file }))
    await act(async () => scope.setState({ activePage: '另一张.probe.md' }))
    await settle()
    expect(card.setParams).toHaveBeenCalledWith({ filePath: '另一张.probe.md' })
  })
})
