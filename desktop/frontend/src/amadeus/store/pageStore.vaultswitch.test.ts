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
  const mod = await import('./pageStore')
  return mod.usePageStore
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('pageStore.switchVaultSide 写入泄漏防线', () => {
  it('待存内容先在旧根落盘(savePage 先于 switchSide),切根后绝无再写', async () => {
    vi.useFakeTimers()
    const store = await freshStore()
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
    const store = await freshStore()
    store.setState({ vaultSide: 'local', vaultRoot: '/local-root', activePage: 'a.md', pages: ['a.md'] })
    await store.getState().switchVaultSide('cloud')
    expect(calls).toEqual(['switch'])
    expect(savePage).not.toHaveBeenCalled()
  })
})
