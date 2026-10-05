import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'

// 「应用内链接用内置浏览器打开」缺省关(2026-10-05 用户定:网页链接默认交给系统浏览器);
// 内置浏览器 / 终端这些能力本身仍缺省开 —— 两种开关共用一份存储,缺省值不能再共用一个读取函数。
const LINKS = 'builtin.browser.inAppLinks'
const stub = (getItem: (k: string) => string | null): void => {
  vi.stubGlobal('localStorage', { getItem, setItem: () => {}, removeItem: () => {} })
}

let mod: typeof import('./index')
// 模块只载一次(它拖着几十个视图,机器忙的时候重载一遍就要好几秒);store 的初值在「什么都没存过」的存储下求。
beforeAll(async () => { stub(() => null); mod = await import('./index') }, 60_000)
afterEach(() => { vi.unstubAllGlobals() })

describe('应用内链接开关的缺省值', () => {
  it('没存过 = 关(交给系统浏览器);内置浏览器本身仍缺省开', () => {
    expect(mod.useBuiltins.getState().inAppLinks).toBe(false)
    expect(mod.useBuiltins.getState().enabled.browser).toBe(true)
    expect(mod.linksOn()).toBe(false)
  })

  it('存过的以存的为准', () => {
    stub((k) => (k === LINKS ? '1' : null))
    expect(mod.linksOn()).toBe(true)
    stub((k) => (k === LINKS ? '0' : null))
    expect(mod.linksOn()).toBe(false)
  })

  it('读不了存储 = 关', () => {
    stub(() => { throw new Error('denied') })
    expect(mod.linksOn()).toBe(false)
  })
})
