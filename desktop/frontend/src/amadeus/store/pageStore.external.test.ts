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
const savePage = vi.fn(async () => undefined)

/** api.ts 在模块体读 window.amadeus → 先立桩再动态 import。 */
let extCb: ((p: string) => void) | null = null
/** typingGuard 装在 document 上(node 环境没有真 document,拿桩记下 handler 直接驱动)。 */
let docHandlers: Record<string, () => void> = {}
const fire = (type: string): void => docHandlers[type]?.()
async function freshStore() {
  vi.resetModules()
  extCb = null
  docHandlers = {}
  vi.stubGlobal('document', {
    addEventListener: (t: string, h: () => void) => { docHandlers[t] = h },
    removeEventListener: () => {},
  })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('window', {
    amadeus: {
      loadPage,
      reconcilePage,
      savePage,
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

beforeEach(() => { loadPage.mockClear(); reconcilePage.mockClear(); savePage.mockClear() })
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

  /** 2026-08-08 用户实报:多设备在线编辑时「输入法被自动关掉、最新输入的内容也没了」。
   *  根因是回灌走 hydrate 整页换内容 → MarkdownBlock 渲染期换 key 重挂 ProseMirror,
   *  正在组合的输入法随宿主一起销毁,而 markdownUpdated 那 200ms 防抖里的字还没进 store。
   *  这条钉死「组合中不许回灌」——把 awaitTypingQuiet 摘掉即刻转红。 */
  it('⚠️输入法组合中押后回灌,组合结束静默后才灌', async () => {
    vi.useFakeTimers()
    try {
      const store = await freshStore()
      await store.getState().loadPage('笔记.md')
      expect(docHandlers.compositionstart, 'typingGuard 没装上 —— 闸形同虚设').toBeTruthy()

      fire('compositionstart')
      extCb!('笔记.md')
      await vi.advanceTimersByTimeAsync(3000)
      expect(reconcilePage, '组合中被回灌 = 输入法当场被关').not.toHaveBeenCalled()
      expect(store.getState().blocks.b1.content).toBe('旧 笔记.md')

      fire('compositionend')
      await vi.advanceTimersByTimeAsync(2000)
      expect(reconcilePage).toHaveBeenCalled()
      expect(store.getState().blocks.b1.content).toBe('新内容')
    } finally {
      vi.useRealTimers()
    }
  })

  /** ⚠️评审 P0:押后回灌**必须同时冻结写盘**。防抖保存 400ms 与静默窗 700ms 都从 setBlockContent
   *  同一 tick 起算 → 只要闸押后了,那发写必然早 300ms 落盘,而它带的是**未合并**的本地内容:
   *  云端 seq 已被 409 学新 → PUT 直接 200,桌面 savePage 更是整文件覆写 —— 对端/agent 的整段改动
   *  被静默抹掉,无冲突无提示。把 save() 顶部那句 `await reconcileGate` 摘掉即刻转红。 */
  it('⚠️押后回灌期间不许写盘(否则陈旧本地内容覆盖对端改动)', async () => {
    vi.useFakeTimers()
    try {
      const store = await freshStore()
      await store.getState().loadPage('笔记.md')
      savePage.mockClear()

      fire('compositionstart')
      store.getState().setBlockContent('b1', '我正在打字') // 同时起了 400ms 防抖保存
      extCb!('笔记.md') // 对端来了改动 → 回灌被押后
      await vi.advanceTimersByTimeAsync(3000)
      expect(savePage, '押后窗口里写盘了 = 对端改动会被陈旧本地内容覆盖').not.toHaveBeenCalled()

      fire('compositionend')
      await vi.advanceTimersByTimeAsync(3000)
      expect(reconcilePage).toHaveBeenCalled()
      expect(savePage, '回灌落地后保存要照常补上').toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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
