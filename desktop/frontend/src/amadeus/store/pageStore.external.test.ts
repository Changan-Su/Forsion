/** 外部文件变更回灌的订阅**必须是模块级**的契约。
 *  背景 bug(2026-07-27 用户实报「agent 改了文件 view 有时候不更新,要刷新一下」):
 *  订阅原本挂在 AmadeusPagesView(左栏笔记树)的 effect 里,而左栏切到「会话/文件」档、
 *  或人在 Agent Desk / Coding Space 时那个组件根本没挂载 → 没人收 externalChange →
 *  编辑器停在旧内容;更糟的是下一次敲键的防抖保存会把陈旧文档写回磁盘、抹掉 agent 的改动。
 *  这条用例钉住「不挂任何组件也能回灌」——它只 import store,不渲染任何 React。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PageManifest } from '@amadeus-shared/compiler/types'

const MANIFEST = { root: { type: 'stack', children: [] } } as unknown as PageManifest
const loadPage = vi.fn(async (path: string) => ({ manifest: MANIFEST, blocks: { b1: { type: 'markdown', content: `旧 ${path}` } } }))
const reconcilePage = vi.fn(async () => ({ manifest: MANIFEST, blocks: { b1: { type: 'markdown', content: '新内容' } } }))

/** api.ts 在模块体读 window.amadeus → 先立桩再动态 import。 */
let extCb: ((p: string) => void) | null = null
async function freshStore() {
  vi.resetModules()
  extCb = null
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('window', {
    amadeus: {
      loadPage,
      reconcilePage,
      savePage: vi.fn(async () => undefined),
      listPages: async () => [],
      backlinks: async () => [],
      onExternalChange: (cb: (p: string) => void) => { extCb = cb; return () => {} },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  const mod = await import('./pageStore')
  return mod.usePageStore
}

beforeEach(() => { loadPage.mockClear(); reconcilePage.mockClear() })
afterEach(() => { vi.unstubAllGlobals() })

describe('externalChange 回灌', () => {
  it('不挂载任何视图组件也订阅得到,当前页内容被回灌', async () => {
    const store = await freshStore()
    expect(extCb, '模块体没订阅 onExternalChange —— 一旦退回组件级订阅,左栏切档就停止回灌').toBeTruthy()

    await store.getState().loadPage('笔记.md')
    expect(store.getState().blocks.b1.content).toBe('旧 笔记.md')

    extCb!('笔记.md')
    await vi.waitFor(() => expect(store.getState().blocks.b1.content).toBe('新内容'))
  })

  it('改的不是当前页则不动内存文档(单页 store 的既有语义)', async () => {
    const store = await freshStore()
    await store.getState().loadPage('笔记.md')
    extCb!('别的.md')
    await Promise.resolve()
    expect(reconcilePage).not.toHaveBeenCalled()
    expect(store.getState().blocks.b1.content).toBe('旧 笔记.md')
  })
})
