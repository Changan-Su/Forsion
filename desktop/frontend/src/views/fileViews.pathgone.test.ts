// @vitest-environment happy-dom
/** 文件类标签(插件文件 / 白板 / 多维表 / PDF / 图片 / 媒体)在树上被改名、挪走、删除之后还攥着旧路径
 *  (2026-09-16,仪表盘标签同病的另外六家)。pageStore 的 onNotePathGone 广播此前只有编辑器与仪表盘在听,
 *  这六个视图只认 leaf 参数,remapScopePaths 又只改 scope 的 activePage,不改 leaf 参数。
 *  真 pageStore + 真视图,只把各视图的重型子组件、插件宿主与工作区句柄换成桩。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type Rec = {
  type: string
  params: Record<string, unknown>
  setParams: (p: Record<string, unknown>) => void
  /** leaf 句柄自己的 close():dockview 里是裸 panel.api.close(),仪表盘卡里是 removeCard。 */
  close: () => void
  /** store 的 closeLeaf(id):带「最后一个主标签变 home / 侧栏补占位 / 清导航史」收尾的正路。 */
  closeLeaf: () => void
  replace: (p: Record<string, unknown>) => void
}
/** 工作区里真实存在的标签(leafById 查得到的)。仪表盘卡 / Agent Desk 卡是视图自己合成的句柄,不在这里。 */
const ws = vi.hoisted(() => ({ leaves: new Map<string, Rec>() }))

vi.mock('@lcl/engine', () => ({
  Skeleton: () => null,
  useWorkspace: {
    getState: () => ({
      // 与 dockviewStore 同形:api.panels 带 __type;leafById 现取参数;navigateLeaf 清掉旧参数整份换
      api: { panels: [...ws.leaves].map(([id, r]) => ({ id, params: { __type: r.type, ...r.params } })) },
      leafById: (id: string) => {
        const r = ws.leaves.get(id)
        return r ? { id, type: r.type, loc: 'main', params: r.params, setTitle: () => {}, setParams: r.setParams, close: r.close } : null
      },
      navigateLeaf: (id: string, _type: string, params: Record<string, unknown> = {}) => { ws.leaves.get(id)?.replace(params) },
      closeLeaf: (id: string) => { ws.leaves.get(id)?.closeLeaf() },
    }),
  },
}))
vi.mock('../stores/themeStore', () => ({ useTheme: (sel: (s: { mode: string; flat: boolean }) => unknown) => sel({ mode: 'light', flat: false }) }))
vi.mock('@amadeus/blocks/excalidraw/ExcalidrawEmbed', () => ({ ExcalidrawEmbed: () => null }))
vi.mock('@amadeus/blocks/database/DatabaseEmbed', () => ({ DatabaseEmbed: () => null }))
vi.mock('@amadeus/blocks', () => ({}))
vi.mock('@amadeus/pdf/PdfAnnotator', () => ({ PdfAnnotator: () => null }))
vi.mock('@amadeus/components/MediaPlayer', () => ({ MediaPlayer: () => null }))
vi.mock('../amadeusNav', () => ({ openFile: () => {} }))
vi.mock('../amadeus/plugins/viewSurface', () => ({ createPluginViewSurface: () => ({ surface: {}, dispose: () => {} }) }))
vi.mock('../amadeus/plugins/pluginStore', () => {
  // 插件自己读写文件(不经 surface.loadPage)—— 插件视图 scope 的 activePage 始终为空
  const FT = { id: 'probe', extensions: ['.probe.md'], mount: () => () => {} }
  const state = { fileTypes: [{ pluginId: 'probe', item: FT }] }
  return {
    usePluginStore: Object.assign((sel: (s: typeof state) => unknown) => sel(state), { getState: () => state }),
    findFileType: (_fts: unknown, p: string) => (p.endsWith('.probe.md') ? FT : undefined),
    fileTypeBaseName: (p: string) => (p.split('/').pop() ?? p).replace(/\.probe\.md$/, ''),
    addPluginViewTeardown: () => () => {},
  }
})

type Case = {
  type: string
  key: string
  file: string
  /** 标签打开时就带着的其它参数,与挂载之后才改成的值(视图名 / 页码 / 时刻)。 */
  extra?: [Record<string, unknown>, Record<string, unknown>]
  load: () => Promise<ComponentType<any>>
}
const CASES: Case[] = [
  { type: 'amadeus-plugin-file', key: 'filePath', file: '导图.probe.md', load: async () => (await import('./AmadeusPluginFileView')).AmadeusPluginFileView },
  { type: 'amadeus-drawing', key: 'drawingPath', file: '板.excalidraw.md', load: async () => (await import('./AmadeusDrawingView')).AmadeusDrawingView },
  { type: 'amadeus-db', key: 'dbPath', file: '表.db', extra: [{ view: '表格' }, { view: '看板' }], load: async () => (await import('./AmadeusDbView')).AmadeusDbView },
  { type: 'amadeus-pdf', key: 'pdfPath', file: '书.pdf', extra: [{ page: 3 }, { page: 7 }], load: async () => (await import('./AmadeusPdfView')).AmadeusPdfView },
  { type: 'amadeus-image', key: 'imagePath', file: '图.png', load: async () => (await import('./AmadeusImageView')).AmadeusImageView },
  { type: 'amadeus-media', key: 'path', file: '课.mp4', extra: [{ at: 95 }, { at: 120 }], load: async () => (await import('./AmadeusMediaView')).AmadeusMediaView },
]
const LEAF = 'file-leaf'
/** 树上的「页」只有普通笔记;插件复合后缀与白板被 listPages 排除,归 files。 */
const isPage = (p: string): boolean => p.endsWith('.md') && !/\.(probe|excalidraw)\.md$/.test(p)

let root: Root | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.innerHTML = ''
})

async function mount(c: Case, filePath: string, { inWorkspace = true } = {}) {
  vi.resetModules()
  ws.leaves.clear()
  const disk = new Set(['1.md', filePath])
  const folders = new Set(filePath.includes('/') ? [filePath.slice(0, filePath.lastIndexOf('/'))] : [])
  const under = (x: string, p: string): boolean => x === p || x.startsWith(`${p}/`)
  ;(window as unknown as { amadeus: unknown }).amadeus = {
    loadPage: async (p: string) => { throw new Error(`这几个视图不该装页:${p}`) },
    savePage: async () => {},
    listPages: async () => [...disk].filter(isPage).sort(),
    listFolders: async () => [...folders].sort(),
    listFiles: async () => [...disk].filter((p) => !isPage(p)).sort(),
    pageIcons: async () => ({}),
    trashEntry: async (p: string) => {
      for (const x of [...disk]) if (under(x, p)) disk.delete(x)
      for (const f of [...folders]) if (under(f, p)) folders.delete(f)
    },
    readDatabase: async (_page: string, ref: string) =>
      disk.has(ref) ? { status: 'ok', path: ref, data: { version: 1, name: 'x', columns: [], rows: [] }, version: 'v1' } : { status: 'missing' },
    renameDbFile: async (oldPath: string, base: string) => {
      const dir = oldPath.includes('/') ? `${oldPath.slice(0, oldPath.lastIndexOf('/'))}/` : ''
      const newPath = `${dir}${base}.db`
      disk.delete(oldPath)
      disk.add(newPath)
      return { newPath, rewrittenPages: [] }
    },
  }
  const store = await import('@amadeus/store/pageStore')
  store.pageStoreFor(store.MAIN_SCOPE).setState({
    vaultRoot: '/vault',
    pages: [...disk].filter(isPage),
    files: [...disk].filter((p) => !isPage(p)),
    folders: [...folders],
  })

  const rec: Rec = {
    type: c.type,
    params: { [c.key]: filePath, ...c.extra?.[0] },
    // dockview updateParameters 是合并语义
    setParams: vi.fn((p: Record<string, unknown>) => { rec.params = { ...rec.params, ...p }; render() }),
    close: vi.fn(),
    closeLeaf: vi.fn(),
    replace: (p) => { rec.params = { ...p }; render() },
  }
  if (inWorkspace) ws.leaves.set(LEAF, rec)
  const View = await c.load()
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // 同 WorkspaceHost.leafFromProps:每次渲染发一个带**参数快照**的新 leaf —— 攥着挂载时快照的实现会被测出来。
  const render = (): void => root!.render(createElement(View, {
    leaf: { id: LEAF, type: c.type, loc: 'main', params: { ...rec.params }, setTitle: () => {}, setParams: rec.setParams, close: rec.close },
    params: rec.params,
  }))
  await act(async () => render())
  await settle()
  return { store, disk, rec }
}

/** 删除链是几跳微任务(flush → IPC → refreshStructure → 广播),多给几拍。 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

describe.each(CASES)('$type 标签:树上改名 / 挪走 / 删除后不攥旧路径', (c) => {
  it('改名或挪走(file 广播):跟到新路径,挂载后改过的其它参数不被退回', async () => {
    const { store, rec } = await mount(c, c.file)
    if (c.extra) await act(async () => rec.setParams(c.extra![1]))
    await act(async () => store.remapScopePaths(c.file, `归档/${c.file}`, 'file'))
    await settle()
    expect(rec.params).toEqual({ [c.key]: `归档/${c.file}`, ...c.extra?.[1] })
    expect(rec.closeLeaf).not.toHaveBeenCalled()
    expect(rec.close).not.toHaveBeenCalled()
  })

  it('所在文件夹改名(prefix 广播):跟过去', async () => {
    const { store, rec } = await mount(c, `资料/${c.file}`)
    await act(async () => store.remapScopePaths('资料', '资料2', 'prefix'))
    await settle()
    expect(rec.params[c.key]).toBe(`资料2/${c.file}`)
  })

  it('树上删除(deletePage):经 store 的 closeLeaf 关掉标签,不走裸 leaf.close()、不改指到任何路径', async () => {
    const { store, disk, rec } = await mount(c, c.file)
    await act(async () => { await store.usePageStore.getState().deletePage(c.file) })
    await settle()
    expect(disk.has(c.file)).toBe(false)
    expect(rec.closeLeaf).toHaveBeenCalled()
    expect(rec.close).not.toHaveBeenCalled()
    expect(rec.setParams).not.toHaveBeenCalled()
  })

  it('所在文件夹删除(deleteFolder):关掉标签', async () => {
    const { store, rec } = await mount(c, `资料/${c.file}`)
    await act(async () => { await store.usePageStore.getState().deleteFolder('资料') })
    await settle()
    expect(rec.closeLeaf).toHaveBeenCalled()
    expect(rec.close).not.toHaveBeenCalled()
  })

  it('不在工作区里的宿主(仪表盘卡 / Desk 卡)一概不动:卡片的 close() = 从仪表盘里删卡并落盘', async () => {
    const { store, rec } = await mount(c, c.file, { inWorkspace: false })
    await act(async () => store.remapScopePaths(c.file, `归档/${c.file}`, 'file'))
    await act(async () => { await store.usePageStore.getState().deletePage(c.file) })
    await settle()
    expect(rec.setParams).not.toHaveBeenCalled()
    expect(rec.close).not.toHaveBeenCalled()
    expect(rec.closeLeaf).not.toHaveBeenCalled()
  })

  it('无关路径的广播不动(同名前缀的兄弟文件夹不算子树)', async () => {
    const { store, rec } = await mount(c, `资料2/${c.file}`)
    await act(async () => store.remapScopePaths('资料', '别处', 'prefix'))
    await act(async () => store.remapScopePaths(`x-${c.file}`, 'y', 'file'))
    await settle()
    expect(rec.setParams).not.toHaveBeenCalled()
    expect(rec.close).not.toHaveBeenCalled()
    expect(rec.closeLeaf).not.toHaveBeenCalled()
  })
})

describe('插件文件:视图内换文件', () => {
  it('插件经 surface.loadPage 在本视图里换到另一个同类型文件:标签参数跟过去', async () => {
    const c = CASES.find((x) => x.type === 'amadeus-plugin-file')!
    const { store, rec } = await mount(c, c.file)
    // surface 在本测试里是桩,直接摆出「本视图 scope 先装着本文件、再被插件换成另一张」这两步状态
    const scope = store.pageStoreFor(`plug:${LEAF}`)
    await act(async () => scope.setState({ activePage: c.file }))
    await act(async () => scope.setState({ activePage: '另一张.probe.md' }))
    await settle()
    expect(rec.params.filePath).toBe('另一张.probe.md')
    expect(rec.closeLeaf).not.toHaveBeenCalled()
  })
})

describe('多维表:树上 / 标题改名走 renameDb', () => {
  it('标签跟到新名,正在看的视图(view 参数)不丢', async () => {
    const c = CASES.find((x) => x.type === 'amadeus-db')!
    const { rec } = await mount(c, `资料/${c.file}`)
    const { renameDb } = await import('@amadeus/lib/dbFileOps')
    await act(async () => { await renameDb(`资料/${c.file}`, '新表') })
    await settle()
    expect(rec.params).toEqual({ dbPath: '资料/新表.db', view: '表格' })
  })
})
