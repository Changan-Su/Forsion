/** 切库写入泄漏防线(2026-07-24 用户实报「切到云端,本地库文件自己出现在云端库/web 端」):
 *  保存走「相对路径 + 当前根」,switchVaultSide 若先切根、后靠 loadPage 的 flushSave 落盘,
 *  旧库活动页就会原样写进新库(云侧凭空复制、再被在线同步推上服务器)。契约:
 *  ① 切根前 flush:待存内容的 savePage 必须发生在 amadeusSync.switchSide 之前;
 *  ② 切根后旧编辑器状态作废(activePage/manifest/blocks 清空),之后不得再有任何 savePage。 */
import { describe, it, expect, vi, afterEach } from 'vitest'

const calls: string[] = []
const savePage = vi.fn(async (path: string) => {
  calls.push(`save:${path}`)
})
const switchSide = vi.fn(async () => {
  calls.push('switch')
  // 空云库:switchVaultSide 走「清编辑器」分支,不涉 loadPage(本测试聚焦保存泄漏)
  return { root: '/cloud-root', pages: [], folders: [], lastPage: null }
})

async function freshStore() {
  vi.resetModules()
  calls.length = 0
  savePage.mockClear()
  switchSide.mockClear()
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('window', {
    amadeus: {
      savePage,
      listPages: async () => [],
      backlinks: async () => [],
    },
    amadeusSync: { switchSide },
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  return await import('./pageStore')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('pageStore.switchVaultSide 写入泄漏防线', () => {
  it('待存内容先在旧根落盘(savePage 先于 switchSide),切根后绝无再写', async () => {
    vi.useFakeTimers()
    const { usePageStore: store } = await freshStore()
    // 灌入「本地库开着一页」的编辑态
    store.setState({
      vaultSide: 'local',
      vaultRoot: '/local-root',
      activePage: 'local-note.md',
      manifest: { blocks: {} } as never,
      blocks: { b1: { content: 'hello' } } as never,
      pages: ['local-note.md'],
    })
    // 触发一次结构提交 → 挂 400ms 防抖保存(dirty 状态)
    store.getState()._commit({ blocks: {} } as never)
    expect(calls).toEqual([]) // 防抖中,尚未落盘

    await store.getState().switchVaultSide('cloud')

    // ① 顺序:旧根落盘先于切根
    expect(calls).toEqual(['save:local-note.md', 'switch'])
    // ② 旧编辑器状态作废
    const s = store.getState()
    expect(s.vaultSide).toBe('cloud')
    expect(s.activePage).toBeNull()
    expect(s.manifest).toBeNull()
    expect(s.blocks).toEqual({})
    // ③ 残余定时器/微任务全部跑完,不得再有任何写
    await vi.advanceTimersByTimeAsync(2000)
    expect(savePage).toHaveBeenCalledTimes(1)
  })

  it('无待存内容时切根不产生任何写', async () => {
    const { usePageStore: store } = await freshStore()
    store.setState({ vaultSide: 'local', vaultRoot: '/local-root', activePage: 'a.md', pages: ['a.md'] })
    await store.getState().switchVaultSide('cloud')
    expect(calls).toEqual(['switch'])
    expect(savePage).not.toHaveBeenCalled()
  })

  // 分屏(2026-07-29 用户实报「切换本地和云端有时候会造成残留的页面存到本地」):
  // 每个面板一份 store + 一个防抖定时器,只护住发起切换的那一份 = 隔壁面板的旧库笔记
  // 在根换掉之后才落盘,凭空出现在新库里。
  it('分屏:另一半屏的待存内容也在旧根落盘,切根后一并作废', async () => {
    vi.useFakeTimers()
    const mod = await freshStore()
    const store = mod.usePageStore
    store.setState({
      vaultSide: 'local',
      vaultRoot: '/local-root',
      activePage: 'a.md',
      manifest: { blocks: {} } as never,
      blocks: { b1: { content: 'x' } } as never,
      pages: ['a.md', 'b.md'],
    })
    store.getState()._commit({ blocks: {} } as never) // 主面板挂上防抖
    const other = mod.pageStoreFor('leaf-2') // 另一半屏
    other.setState({
      activePage: 'b.md',
      manifest: { blocks: {} } as never,
      blocks: { b2: { content: 'y' } } as never,
    })
    other.getState()._commit({ blocks: {} } as never) // 它也挂上防抖
    expect(calls).toEqual([])

    await store.getState().switchVaultSide('cloud')

    // ① 两份都在【旧根】落了盘,且都先于切根
    expect(calls.indexOf('switch')).toBe(2)
    expect(calls.slice(0, 2).sort()).toEqual(['save:a.md', 'save:b.md'])
    // ② 隔壁面板的编辑器状态也作废了
    expect(other.getState().activePage).toBeNull()
    expect(other.getState().blocks).toEqual({})
    // ③ 残余定时器跑完,不得再有任何写
    await vi.advanceTimersByTimeAsync(2000)
    expect(savePage).toHaveBeenCalledTimes(2)
  })
})
