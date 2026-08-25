import { describe, it, expect } from 'vitest'
import { pickRecall, composerAutoHeight, slashTokenAt, fmtTokens } from './Composer2'

// slash 菜单的触发点:任意位置的 `/` 都算,但必须在行首或空白之后。
describe('slashTokenAt', () => {
  it('开头、句中、换行后都能触发', () => {
    expect(slashTokenAt('/mo', 3)).toEqual({ start: 0, token: '/mo' })
    expect(slashTokenAt('帮我看看 /comp', 10)).toEqual({ start: 5, token: '/comp' })
    expect(slashTokenAt('第一行\n/new', 8)).toEqual({ start: 4, token: '/new' })
  })
  it('词中间的斜杠不触发(路径、URL、除法)', () => {
    expect(slashTokenAt('http://x', 8)).toBeNull()
    expect(slashTokenAt('src/foo', 7)).toBeNull()
    expect(slashTokenAt('/Users/me/x', 11)).toEqual({ start: 0, token: '/Users/me/x' }) // 词仍在,但一条也匹配不上 → 菜单不弹
  })
  it('只看光标之前,且空格后即失效', () => {
    expect(slashTokenAt('/new 已经带参数', 5)).toBeNull()
    expect(slashTokenAt('/new', 2)).toEqual({ start: 0, token: '/n' })
  })
})

// autosize 高度:未布局(scrollHeight 0)时留 auto,绝不塌成 0px(治「首启引导后输入区消失」)。
describe('composerAutoHeight', () => {
  it('scrollHeight 0(未布局/display:none 面板)→ auto,不塌成 0px', () => {
    expect(composerAutoHeight(0)).toBe('auto')
    expect(composerAutoHeight(-5)).toBe('auto')
  })
  it('正常量到 → 夹到 [., maxPx]', () => {
    expect(composerAutoHeight(48)).toBe('48px')
    expect(composerAutoHeight(500)).toBe('200px') // 封顶
    expect(composerAutoHeight(500, 300)).toBe('300px')
  })
})

// Item 1 历史召回索引算术:↑ 由新到旧、↓ 回到暂存草稿,越界不动。
describe('pickRecall (composer history nav)', () => {
  const hist = ['first', 'second', 'third'] // 旧→新

  it('ArrowUp walks newest→oldest, then stops at oldest', () => {
    expect(pickRecall(hist, 0, true, 'draft')).toEqual({ pos: 1, val: 'third' })
    expect(pickRecall(hist, 1, true, 'draft')).toEqual({ pos: 2, val: 'second' })
    expect(pickRecall(hist, 2, true, 'draft')).toEqual({ pos: 3, val: 'first' })
    expect(pickRecall(hist, 3, true, 'draft')).toBeNull() // 已到最旧
  })

  it('ArrowDown walks back toward the stashed draft, then stops', () => {
    expect(pickRecall(hist, 3, false, 'draft')).toEqual({ pos: 2, val: 'second' })
    expect(pickRecall(hist, 1, false, 'draft')).toEqual({ pos: 0, val: 'draft' }) // 回到草稿
    expect(pickRecall(hist, 0, false, 'draft')).toBeNull() // 已在草稿
  })

  it('empty history never recalls', () => {
    expect(pickRecall([], 0, true, 'draft')).toBeNull()
  })
})

// token 计数进位:截断而非四舍五入 —— 四舍五入会把 999,950 写成 "1000.0k"。
describe('fmtTokens', () => {
  it('千位以下原样,满千 k、满百万 M', () => {
    expect(fmtTokens(0)).toBe('0')
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(1000)).toBe('1k')
    expect(fmtTokens(17607)).toBe('17.6k')
    expect(fmtTokens(128000)).toBe('128k')
    expect(fmtTokens(1e6)).toBe('1M')
    expect(fmtTokens(1234567)).toBe('1.2M')
  })
  it('进位边界不会溢出成 1000k', () => {
    expect(fmtTokens(999999)).toBe('999.9k')
  })
})
