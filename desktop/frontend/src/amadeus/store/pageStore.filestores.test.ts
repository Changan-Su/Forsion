/** 树上挪走 / 改名文件夹 / 删除时,多维表与白板还在防抖窗口里的改动(2026-09-16 Codex 评审)。
 *  movePage / renameFolder 原先只冲 page scope 与 unified 实例,deletePage / deleteFolder 只冲 unified ——
 *  dbStore(500ms)与 drawingStore(800ms)的待写没人管:文件挪走之后计时器照旧烧到**旧路径**,
 *  桌面的 CAS 写与白板写都是「缺文件即新建」→ 旧位置凭空长出一份幽灵文件,新位置反而少了这笔改动;
 *  删除则把刚进回收站的文件建回来。真 pageStore + 真 dbStore / drawingStore,只把宿主桥换成内存盘。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { blankDrawing, BLANK_SCENE_JSON, parseDrawing } from '@amadeus-shared/excalidraw/format'

const DB = JSON.stringify({ version: 1, name: '表', columns: [], rows: [] })
const BOARD = blankDrawing(BLANK_SCENE_JSON)
const SCENE2 = JSON.stringify({
  type: 'excalidraw', version: 2, source: 'test',
  elements: [{ id: 'e1', type: 'rectangle' }], appState: { viewBackgroundColor: '#ffffff' },
})
type PathGone = { from: string; kind: 'file' | 'prefix'; to: string | null; root: string }
const ipcLag = (): Promise<void> => new Promise((r) => setTimeout(r, 1000))
/** 边推时钟边等:动盘操作里有 ipcLag,假时钟不推就永远等不到回包。 */
const during = async (op: Promise<unknown>): Promise<void> => {
  await vi.advanceTimersByTimeAsync(3000)
  await op
}

async function setup(files: Record<string, string>) {
  vi.resetModules()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  const disk = new Map(Object.entries(files))
  const trash = new Map<string, string>()
  const under = (x: string, p: string): boolean => x === p || x.startsWith(`${p}/`)
  const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
  const isPage = (p: string): boolean => p.endsWith('.md') && !p.endsWith('.excalidraw.md')
  const remote: { cb: ((p: PathGone) => void) | null } = { cb: null }
  const amadeus = {
    listPages: async () => [...disk.keys()].filter(isPage),
    listFiles: async () => [...disk.keys()].filter((p) => !isPage(p)),
    listFolders: async () => [...new Set([...disk.keys()].map(dirOf).filter(Boolean))],
    pageIcons: async () => ({}),
    // 盘先动完、回包晚到(主进程改写全库引用要时间):防抖计时器正好在这个窗口里烧 —— 真会出事的前置态
    movePage: async (p: string, dst: string) => {
      const np = `${dst ? `${dst}/` : ''}${p.split('/').pop()}`
      disk.set(np, disk.get(p)!)
      disk.delete(p)
      await ipcLag()
      return np
    },
    renameFolder: async (f: string, name: string) => {
      const nf = dirOf(f) ? `${dirOf(f)}/${name}` : name
      for (const [k, v] of [...disk]) if (under(k, f)) { disk.delete(k); disk.set(nf + k.slice(f.length), v) }
      await ipcLag()
      return nf
    },
    trashEntry: async (p: string) => {
      for (const [k, v] of [...disk]) if (under(k, p)) { trash.set(k, v); disk.delete(k) }
    },
    // 与主进程同语义:db:write-cas 与 drawing 写都是「文件不在 = 新建」
    readDatabase: async (_page: string, ref: string) =>
      disk.has(ref) ? { status: 'ok', path: ref, data: JSON.parse(disk.get(ref)!), version: disk.get(ref) } : { status: 'missing' },
    writeDatabase: async (p: string, data: unknown) => { disk.set(p, JSON.stringify(data)) },
    writeDatabaseCas: async (p: string, data: unknown, version: string) => {
      const cur = disk.get(p) ?? ''
      if (cur && cur !== version) return { ok: false, version: cur }
      const text = JSON.stringify(data)
      disk.set(p, text)
      return { ok: true, version: text }
    },
    readDrawing: async (_page: string, ref: string) =>
      disk.has(ref) ? { status: 'ok', path: ref, source: disk.get(ref) } : { status: 'missing' },
    writeDrawing: async (p: string, source: string) => { disk.set(p, source) },
    onExternalChange: () => () => {},
    // 多窗口:主进程把别的窗口的路径广播转过来(见 pageStore 的 onPathGone 订阅)
    broadcastPathGone: vi.fn(),
    onPathGone: (cb: (p: PathGone) => void) => { remote.cb = cb; return () => {} },
  }
  vi.stubGlobal('window', { amadeus, addEventListener: () => {}, removeEventListener: () => {} })
  const pageStore = await import('./pageStore')
  const { useDbStore } = await import('./dbStore')
  const { useDrawStore } = await import('./drawingStore')
  // vaultRoot 先落:dbStore / drawingStore 见 vaultRoot 变化会整片清缓存
  pageStore.pageStoreFor(pageStore.MAIN_SCOPE).setState({ vaultRoot: '/vault' })
  await pageStore.usePageStore.getState().refreshStructure()
  return { ...pageStore, useDbStore, useDrawStore, disk, trash, amadeus, remote }
}

const nameOf = (text: string | undefined): unknown => (text ? JSON.parse(text).name : undefined)
const sceneOf = (text: string | undefined): string | undefined => (text ? parseDrawing(text)?.sceneJson : undefined)

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('多维表:防抖窗口里的改动 × 树上挪走 / 删除', () => {
  it('movePage:改动先落盘再挪,旧位置不会被写回来', async () => {
    const m = await setup({ '1.md': '', '资料/表.db': DB })
    await m.useDbStore.getState().load('资料/表.db', '资料/表.db')
    m.useDbStore.getState().mutate('资料/表.db', (d) => ({ ...d, name: '改过' }))
    await during(m.usePageStore.getState().movePage('资料/表.db', '归档'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(m.disk.has('资料/表.db')).toBe(false)
    expect(nameOf(m.disk.get('归档/表.db'))).toBe('改过')
  })

  it('挪走之后仍开着旧引用的地方继续改:写到新位置,不在旧位置建文件', async () => {
    const m = await setup({ '1.md': '', '资料/表.db': DB })
    await m.useDbStore.getState().load('资料/表.db', '资料/表.db')
    await during(m.usePageStore.getState().movePage('资料/表.db', '归档'))
    m.useDbStore.getState().mutate('资料/表.db', (d) => ({ ...d, name: '挪完再改' }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(m.disk.has('资料/表.db')).toBe(false)
    expect(nameOf(m.disk.get('归档/表.db'))).toBe('挪完再改')
  })

  it('deletePage:回收站里是最新内容,文件不被建回来;之后的改动是空操作', async () => {
    const m = await setup({ '1.md': '', '资料/表.db': DB })
    await m.useDbStore.getState().load('资料/表.db', '资料/表.db')
    m.useDbStore.getState().mutate('资料/表.db', (d) => ({ ...d, name: '删前改过' }))
    await m.usePageStore.getState().deletePage('资料/表.db')
    await vi.advanceTimersByTimeAsync(2000)
    expect(nameOf(m.trash.get('资料/表.db'))).toBe('删前改过')
    expect(m.disk.has('资料/表.db')).toBe(false)
    expect(m.useDbStore.getState().entries['资料/表.db']?.status).toBe('missing')
    m.useDbStore.getState().mutate('资料/表.db', (d) => ({ ...d, name: '删后又改' }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(m.disk.has('资料/表.db')).toBe(false)
  })

  it('别的窗口挪走了它(路径广播经主进程转来,本窗来不及先落盘):待写跟到新位置', async () => {
    const m = await setup({ '1.md': '', '资料/表.db': DB })
    await m.useDbStore.getState().load('资料/表.db', '资料/表.db')
    m.useDbStore.getState().mutate('资料/表.db', (d) => ({ ...d, name: '本窗改的' }))
    m.disk.set('归档/表.db', m.disk.get('资料/表.db')!) // 另一个窗口动的盘
    m.disk.delete('资料/表.db')
    m.remote.cb!({ from: '资料/表.db', kind: 'file', to: '归档/表.db', root: '/vault' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(m.disk.has('资料/表.db')).toBe(false)
    expect(nameOf(m.disk.get('归档/表.db'))).toBe('本窗改的')
  })
})

describe('白板:防抖窗口里的笔画 × 树上改名文件夹 / 删除', () => {
  it('renameFolder:笔画先落盘再改名,旧文件夹不会被建回来', async () => {
    const m = await setup({ '1.md': '', '资料/板.excalidraw.md': BOARD })
    await m.useDrawStore.getState().load('资料/板.excalidraw.md', '资料/板.excalidraw.md')
    m.useDrawStore.getState().save('资料/板.excalidraw.md', SCENE2)
    await during(m.usePageStore.getState().renameFolder('资料', '资料2'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(m.disk.has('资料/板.excalidraw.md')).toBe(false)
    expect(sceneOf(m.disk.get('资料2/板.excalidraw.md'))).toBe(SCENE2)
  })

  it('改名之后画布还挂着旧引用、接着画:写到新位置', async () => {
    const m = await setup({ '1.md': '', '资料/板.excalidraw.md': BOARD })
    await m.useDrawStore.getState().load('资料/板.excalidraw.md', '资料/板.excalidraw.md')
    await during(m.usePageStore.getState().renameFolder('资料', '资料2'))
    m.useDrawStore.getState().save('资料/板.excalidraw.md', SCENE2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(m.disk.has('资料/板.excalidraw.md')).toBe(false)
    expect(sceneOf(m.disk.get('资料2/板.excalidraw.md'))).toBe(SCENE2)
  })

  it('deleteFolder:回收站里有这笔,文件不被建回来;画布卸载时的冲刷也不写', async () => {
    const m = await setup({ '1.md': '', '资料/板.excalidraw.md': BOARD })
    await m.useDrawStore.getState().load('资料/板.excalidraw.md', '资料/板.excalidraw.md')
    m.useDrawStore.getState().save('资料/板.excalidraw.md', SCENE2)
    await m.usePageStore.getState().deleteFolder('资料')
    await m.useDrawStore.getState().flush('资料/板.excalidraw.md') // = Board 卸载
    await vi.advanceTimersByTimeAsync(2000)
    expect(sceneOf(m.trash.get('资料/板.excalidraw.md'))).toBe(SCENE2)
    expect(m.disk.has('资料/板.excalidraw.md')).toBe(false)
    expect(m.useDrawStore.getState().entries['资料/板.excalidraw.md']?.status).toBe('missing')
  })

  it('movePage 白板本身:不在旧位置留幽灵', async () => {
    const m = await setup({ '1.md': '', '板.excalidraw.md': BOARD })
    await m.useDrawStore.getState().load('板.excalidraw.md', '板.excalidraw.md')
    m.useDrawStore.getState().save('板.excalidraw.md', SCENE2)
    await during(m.usePageStore.getState().movePage('板.excalidraw.md', '归档'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(m.disk.has('板.excalidraw.md')).toBe(false)
    expect(sceneOf(m.disk.get('归档/板.excalidraw.md'))).toBe(SCENE2)
  })
})

describe('笔记连带 .fd 子文件夹删除:子文件夹没删掉', () => {
  it('不广播「.fd 整棵已删」:里面的多维表条目照常可写,标签不被关', async () => {
    const m = await setup({ '1.md': '', 'N.md': '# N\n', 'N.fd/表.db': DB })
    const trash = m.amadeus.trashEntry
    m.amadeus.trashEntry = async (p: string) => {
      if (p.endsWith('.fd')) throw new Error('EBUSY')
      await trash(p)
    }
    await m.useDbStore.getState().load('N.fd/表.db', 'N.fd/表.db')
    const seen: string[] = []
    m.onNotePathGone((from, kind, to) => seen.push(`${from}|${kind}|${to}`))
    await m.usePageStore.getState().deletePage('N.md')
    expect(m.disk.has('N.fd/表.db')).toBe(true)
    expect(seen).toEqual(['N.md|file|null'])
    expect(m.useDbStore.getState().entries['N.fd/表.db']?.status).toBe('ok')
  })
})

describe('回收站先挪走、后记元数据:后一步失败也 reject,可条目已经离库', () => {
  const lateFail = (m: Awaited<ReturnType<typeof setup>>, match: (p: string) => boolean) => {
    const trash = m.amadeus.trashEntry
    m.amadeus.trashEntry = async (p: string) => {
      await trash(p)
      if (match(p)) throw new Error('ENOSPC: trash meta')
    }
  }

  it('deletePage:按盘面判定已删 —— 广播照发、多维表条目标缺失,之后的改动不把文件建回来', async () => {
    const m = await setup({ '1.md': '', '资料/表.db': DB })
    lateFail(m, () => true)
    await m.useDbStore.getState().load('资料/表.db', '资料/表.db')
    const seen: string[] = []
    m.onNotePathGone((from, kind, to) => seen.push(`${from}|${kind}|${to}`))
    await m.usePageStore.getState().deletePage('资料/表.db')
    expect(seen).toEqual(['资料/表.db|file|null'])
    m.useDbStore.getState().mutate('资料/表.db', (d) => ({ ...d, name: '删后又改' }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(m.disk.has('资料/表.db')).toBe(false)
  })

  it('笔记连带的 .fd 与 deleteFolder 同理', async () => {
    const m = await setup({ '1.md': '', 'N.md': '# N\n', 'N.fd/表.db': DB, '资料/板.excalidraw.md': BOARD })
    lateFail(m, (p) => p.endsWith('.fd') || p === '资料')
    const seen: string[] = []
    m.onNotePathGone((from, kind, to) => seen.push(`${from}|${kind}|${to}`))
    await m.usePageStore.getState().deletePage('N.md')
    await m.usePageStore.getState().deleteFolder('资料')
    expect(seen).toEqual(['N.md|file|null', 'N.fd|prefix|null', '资料|prefix|null'])
  })
})

describe('路径广播跨窗口转发', () => {
  it('本窗发起的挪动/删除经主进程转给别的窗口,带上库根', async () => {
    const m = await setup({ '1.md': '', '资料/表.db': DB })
    await during(m.usePageStore.getState().movePage('资料/表.db', '归档'))
    await m.usePageStore.getState().deletePage('归档/表.db')
    expect(m.amadeus.broadcastPathGone.mock.calls.map((c) => c[0])).toEqual([
      { from: '资料/表.db', kind: 'file', to: '归档/表.db', root: '/vault' },
      { from: '归档/表.db', kind: 'file', to: null, root: '/vault' },
    ])
  })

  it('别的窗口转来的广播只在本窗收尾、不再转回去;库根对不上(那边开的是另一个库)一概不理', async () => {
    const m = await setup({ '1.md': '', '资料/表.db': DB })
    const seen: Array<[string, string, string | null]> = []
    m.onNotePathGone((from, kind, to) => seen.push([from, kind, to]))
    m.remote.cb!({ from: '资料', kind: 'prefix', to: '资料2', root: '/另一个库' })
    m.remote.cb!({ from: '资料', kind: 'prefix', to: '资料2', root: '/vault' })
    m.remote.cb!({ from: '资料2/表.db', kind: 'file', to: null, root: '/vault' })
    expect(seen).toEqual([['资料', 'prefix', '资料2'], ['资料2/表.db', 'file', null]])
    expect(m.amadeus.broadcastPathGone).not.toHaveBeenCalled()
  })
})
