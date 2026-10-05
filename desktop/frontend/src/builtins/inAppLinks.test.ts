import { describe, it, expect, vi, afterEach } from 'vitest'

// 「应用内链接用内置浏览器打开」缺省关(2026-10-05 用户定:网页链接默认交给系统浏览器);
// 内置浏览器 / 终端这些能力本身仍缺省开 —— 两种开关共用一份存储,缺省值不能再共用一个读取函数。
const LINKS = 'builtin.browser.inAppLinks'

async function load(getItem: (k: string) => string | null) {
  vi.resetModules()
  vi.stubGlobal('localStorage', { getItem, setItem: () => {}, removeItem: () => {} })
  return (await import('./index')).useBuiltins.getState()
}

afterEach(() => { vi.unstubAllGlobals() })

describe('应用内链接开关的缺省值', () => {
  it('没存过 = 关(交给系统浏览器);内置浏览器本身仍缺省开', async () => {
    const s = await load(() => null)
    expect(s.inAppLinks).toBe(false)
    expect(s.enabled.browser).toBe(true)
  })

  it('存过的以存的为准', async () => {
    expect((await load((k) => (k === LINKS ? '1' : null))).inAppLinks).toBe(true)
    expect((await load((k) => (k === LINKS ? '0' : null))).inAppLinks).toBe(false)
  })

  it('读不了存储 = 关', async () => {
    const s = await load((k) => { if (k === LINKS) throw new Error('denied'); return null })
    expect(s.inAppLinks).toBe(false)
  })
})
