/** 2026-08-14 评审两 P0 的契约仪器(修完留仪器,铁律 #5):
 *  ① scope 摘表 × 同步重领养:disposePageStoreScope 的 stores.delete 挂在 flushSave().finally
 *    (≥1 个微任务)上,而 React 对同一 effect 的 cleanup→setup 同步连跑 —— 同名 scope 立即
 *    pageStoreFor 必须**取消**在途摘表,否则旧 finalizer 把新主人正用的 store 摘成孤儿
 *    (逃逸 flushAllScopes/换库 reset/外部回灌广播,切库时旧内容可写进新库)。
 *  ② deleteBlock 跨 await(反链查询/确认弹窗)后只比路径不够:A→B→A 往返路径相同但页已重装、
 *    块 id 已易主 —— loadNonce(整页装载身份)变了必须放弃提交。 */
import { describe, it, expect, vi, afterEach } from 'vitest'

const savePage = vi.fn(async () => {})
let backlinksImpl: (ref: string) => Promise<Array<{ path: string }>> = async () => []

async function freshStore() {
  vi.resetModules()
  savePage.mockClear()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('window', {
    amadeus: {
      savePage,
      listPages: async () => [],
      backlinks: async () => [],
      blockBacklinks: (ref: string) => backlinksImpl(ref),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    confirm: () => true,
  })
  return await import('./pageStore')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const settle = async (): Promise<void> => {
  // flushSave().finally 至少一个微任务;多让几拍 + 一个宏任务,确保 finalizer 真跑完
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

const seedManifest = {
  blocks: { b1: { type: 'markdown' } },
  root: { type: 'stack', children: [{ type: 'row', id: 'r1', columns: [{ id: 'c1', width: 1, children: [{ ref: 'b1' }] }] }] },
  nextId: 2,
} as never

describe('scope 摘表 × 同步重领养(pendingDispose)', () => {
  it('dispose 后同拍 pageStoreFor 同名 scope:复用同一实例,且旧 finalizer 不再摘表', async () => {
    const m = await freshStore()
    const s1 = m.pageStoreFor('plug:t')
    s1.setState({ activePage: 'x.canvas.md' })
    m.disposePageStoreScope('plug:t')
    const s2 = m.pageStoreFor('plug:t') // React cleanup→setup 同一拍重建 —— 微任务插不进来
    expect(s2).toBe(s1)
    await settle()
    // 摘表若未被取消,这里会凭空重建一个**空**店(activePage=null)= 孤儿分家的直接可观测面
    const s3 = m.pageStoreFor('plug:t')
    expect(s3).toBe(s1)
    expect(s3.getState().activePage).toBe('x.canvas.md')
  })

  it('正常 dispose(无人重领养)照旧回收', async () => {
    const m = await freshStore()
    const g1 = m.pageStoreFor('plug:g')
    m.disposePageStoreScope('plug:g')
    await settle()
    expect(m.pageStoreFor('plug:g')).not.toBe(g1)
  })
})

describe('deleteBlock 装载身份守卫(loadNonce)', () => {
  it('await 期间页被重装(路径相同):放弃删除', async () => {
    let release!: (v: Array<{ path: string }>) => void
    backlinksImpl = () => new Promise((r) => { release = r })
    const m = await freshStore()
    const store = m.pageStoreFor('plug:d')
    store.setState({ activePage: 'a.md', manifest: seedManifest, blocks: { b1: { id: 'b1', type: 'markdown', content: 'x' } } as never })
    const p = store.getState().deleteBlock('b1')
    // A→B→A:路径不变,但整页重装(loadNonce 换新对象、同名 id 已是别人)
    store.setState({ loadNonce: {}, manifest: seedManifest, blocks: { b1: { id: 'b1', type: 'markdown', content: '新页的同名块' } } as never })
    release([])
    await p
    expect(store.getState().blocks.b1).toBeDefined()
    expect(store.getState().blocks.b1.content).toBe('新页的同名块')
  })

  it('无重装:删除照常完成(守卫不误伤)', async () => {
    backlinksImpl = async () => []
    const m = await freshStore()
    const store = m.pageStoreFor('plug:d2')
    store.setState({ activePage: 'a.md', manifest: seedManifest, blocks: { b1: { id: 'b1', type: 'markdown', content: 'x' } } as never })
    await store.getState().deleteBlock('b1')
    expect(store.getState().blocks.b1).toBeUndefined()
  })
})
