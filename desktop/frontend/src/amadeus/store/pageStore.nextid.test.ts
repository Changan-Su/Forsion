/** 块 id 永不复用的**接线**测试(2026-08-05 Codex 评审指出:只测 helper 会放过没接线的产线)。
 *  真实序列:删掉最高号块 → 立刻插入新块 → 必须拿到新号,不得原地复用刚删的号,
 *  否则外部 `![[note#N]]` 嵌入静默错绑到新内容。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PageManifest } from '@amadeus-shared/compiler/types'

const MANIFEST: PageManifest = {
  schema: 'amadeus.page/3',
  id: 'pg_test',
  title: '笔记',
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:00.000Z',
  compiler: { version: '3.0.0' },
  root: {
    type: 'stack',
    children: [
      { type: 'row', id: 'row_1', columns: [{ id: 'col_1', width: 1, children: [{ ref: '1' }, { ref: '2' }] }] },
    ],
  },
  blocks: { 1: { type: 'markdown' }, 2: { type: 'markdown' } },
}

async function freshStore() {
  vi.resetModules()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('window', {
    amadeus: {
      loadPage: async () => ({
        manifest: structuredClone(MANIFEST),
        blocks: {
          1: { id: '1', type: 'markdown', content: '甲' },
          2: { id: '2', type: 'markdown', content: '乙' },
        },
      }),
      savePage: vi.fn(async () => undefined),
      listPages: async () => [],
      backlinks: async () => [],
      blockBacklinks: async () => [], // 无外部嵌入 → 删除不弹确认
      onExternalChange: () => () => {},
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  const mod = await import('./pageStore')
  return mod.usePageStore
}

beforeEach(() => {})
afterEach(() => { vi.unstubAllGlobals() })

describe('删除最高号块后插入不复用 id', () => {
  it('deleteBlock(2) → insertBlockAfter → 得 3 不是 2,且高水位进 manifest', async () => {
    const store = await freshStore()
    await store.getState().loadPage('笔记.md')
    expect(Object.keys(store.getState().manifest!.blocks).sort()).toEqual(['1', '2'])

    await store.getState().deleteBlock('2')
    expect(store.getState().manifest!.blocks['2']).toBeUndefined()
    expect(store.getState().manifest!.nextId).toBe(3) // 删除抬升高水位

    const newId = store.getState().insertBlockAfter('1', undefined, '新块')
    expect(newId).toBe('3') // 修复前这里是 '2':复用刚删的号
    expect(store.getState().manifest!.nextId).toBe(4) // 分配也推进
  })
})
