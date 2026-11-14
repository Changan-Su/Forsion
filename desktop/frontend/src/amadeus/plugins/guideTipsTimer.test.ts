// @vitest-environment happy-dom
/**
 * guideTips 每秒一次的检查(ensureRunning 起的那只表)不能活过它的页面。
 *
 * 实翻(2026-11-13):桌面端全量 vitest 全部通过却退出码 1 —— 一个测试文件跑完、happy-dom 把 document 等全局摘掉之后,
 * 这只表又响了一下,`document.hidden` 抛 ReferenceError(Uncaught Exception,归到碰巧正在跑的那个文件)。
 * pluginStore 一引入 hostTips 就登记提示、起表,所以凡是带 DOM 又连着 pluginStore 的测试文件都会留下一只;
 * 红不红只看那个 worker 在拆掉环境之后又活了多久,所以是偶发,单跑哪个文件都不红。
 *
 * 这里直接做那两件事:把 document 摘掉 / 换成另一个,再让表响 —— 不能抛,并且表自己停。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Guide = typeof import('./guideTips')
const TIP = { id: 't', at: 'anchor', style: 'ring', title: 'T', text: 'B' } as never

/** 每条用例一份新的模块实例(表是模块级的,起过就不再起)。返回登记之前挂着几只表。 */
async function boot(): Promise<{ guide: Guide; before: number }> {
  vi.resetModules()
  const guide = await import('./guideTips')
  const before = vi.getTimerCount()
  guide.registerGuideTips('p', [TIP])
  return { guide, before }
}

/** 换掉全局 document(undefined = 摘掉,和测试环境拆全局时一样),返回还原函数。 */
function swapDocument(next: Document | undefined): () => void {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'document')!
  if (next === undefined) delete (globalThis as { document?: Document }).document
  else Object.defineProperty(globalThis, 'document', { configurable: true, enumerable: desc.enumerable, writable: true, value: next })
  return () => { Object.defineProperty(globalThis, 'document', desc) }
}

beforeEach(() => { vi.useFakeTimers(); localStorage.clear() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('guide tips timer does not outlive its page', () => {
  it('registering tips starts exactly one timer, and it keeps running while the page is there', async () => {
    const { guide, before } = await boot()
    expect(vi.getTimerCount()).toBe(before + 1)
    guide.registerGuideTips('q', [TIP]) // 再登记不会再起一只
    expect(vi.getTimerCount()).toBe(before + 1)
    vi.advanceTimersByTime(5_000)
    expect(vi.getTimerCount()).toBe(before + 1)
  })

  it('page gone (document removed, as after a test environment is torn down): the tick does not throw and stops itself', async () => {
    const { before } = await boot()
    const restore = swapDocument(undefined)
    try {
      expect(typeof document).toBe('undefined')
      expect(() => vi.advanceTimersByTime(1_100)).not.toThrow()
      expect(vi.getTimerCount()).toBe(before)
    } finally { restore() }
  })

  it('page replaced by another document: the old timer stops without reading the new page', async () => {
    const { before } = await boot()
    const other = document.implementation.createHTMLDocument('next')
    const read = vi.spyOn(other, 'querySelectorAll')
    const restore = swapDocument(other)
    try {
      expect(() => vi.advanceTimersByTime(1_100)).not.toThrow()
      expect(vi.getTimerCount()).toBe(before)
      expect(read).not.toHaveBeenCalled()
    } finally { restore() }
  })

  it('once stopped it stays stopped (a late registration on the dead page does not restart it)', async () => {
    const { guide, before } = await boot()
    const restore = swapDocument(undefined)
    try { vi.advanceTimersByTime(1_100) } finally { restore() }
    expect(vi.getTimerCount()).toBe(before)
    guide.registerGuideTips('r', [TIP])
    expect(vi.getTimerCount()).toBe(before)
  })
})
