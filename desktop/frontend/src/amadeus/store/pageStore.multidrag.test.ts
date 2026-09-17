/** 多选块拖拽布局契约：所选块按文档视觉序一次性搬运，左右分栏只生成一列、只记一次结构事务。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PageManifest } from '@amadeus-shared/compiler/types'

const manifest = (): PageManifest => ({
  schema: 'amadeus.page/3',
  id: 'pg_drag',
  title: 'Drag',
  createdAt: '',
  updatedAt: '',
  compiler: { version: 'test' },
  root: {
    type: 'stack',
    children: [
      { type: 'row', id: 'r1', columns: [{ id: 'c1', width: 1, children: [{ ref: 'b1' }, { ref: 'b2' }] }] },
      { type: 'row', id: 'r2', columns: [{ id: 'c2', width: 1, children: [{ ref: 'b3' }, { ref: 'b4' }] }] },
    ],
  },
  blocks: Object.fromEntries(['b1', 'b2', 'b3', 'b4'].map((id) => [id, { type: 'markdown' }])),
})

async function freshStore() {
  vi.resetModules()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('window', {
    amadeus: { savePage: vi.fn(async () => {}), onExternalChange: () => () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  const { usePageStore } = await import('./pageStore')
  const m = manifest()
  usePageStore.setState({
    activePage: 'Drag.md',
    manifest: m,
    blocks: Object.fromEntries(Object.keys(m.blocks).map((id) => [id, { id, type: 'markdown', content: id }])),
    status: 'ready',
  })
  return usePageStore
}

afterEach(() => vi.unstubAllGlobals())

const layout = (root: PageManifest['root']): string[][][] =>
  root.children.map((row) => row.columns.map((col) => col.children.map((ref) => ref.ref)))

describe('pageStore multi-block drag', () => {
  it('拖到目标块侧边：整组进入同一列，并保持原文档顺序而非选择顺序', async () => {
    const store = await freshStore()
    store.getState().pairBlocks(['b2', 'b1'], 'b3', 'right')
    expect(layout(store.getState().manifest!.root)).toEqual([
      [['b3'], ['b1', 'b2']],
      [['b4']],
    ])
  })

  it('拖到整行侧边：搬空的来源行被清理，整组只生成一个新列', async () => {
    const store = await freshStore()
    store.getState().addColumnWithBlock('r2', ['b1', 'b2'], 'left')
    expect(layout(store.getState().manifest!.root)).toEqual([
      [['b1', 'b2'], ['b3', 'b4']],
    ])
  })

  it('目标本身属于多选时不移动，避免把自己配到自己旁边', async () => {
    const store = await freshStore()
    const before = layout(store.getState().manifest!.root)
    store.getState().pairBlocks(['b2', 'b3'], 'b3', 'left')
    expect(layout(store.getState().manifest!.root)).toEqual(before)
  })
})
