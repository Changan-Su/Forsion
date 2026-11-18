// 页内目录块 ```toc 的选项解析(编辑器 / 代码块工具条 / 发布页共用)。
import { describe, expect, it } from 'vitest'
import { parseTocRange, TOC_FENCE } from './tocBlock'

describe('parseTocRange', () => {
  it('缺省 H1–H3,插入骨架写的就是这个范围', () => {
    expect(parseTocRange('')).toEqual({ min: 1, max: 3 })
    expect(parseTocRange(TOC_FENCE.split('\n').slice(1, -1).join('\n'))).toEqual({ min: 1, max: 3 })
  })
  it('读 min_depth / max_depth,夹在 1–6', () => {
    expect(parseTocRange('min_depth: 2\nmax_depth: 4')).toEqual({ min: 2, max: 4 })
    expect(parseTocRange('min_depth: 0\nmax_depth: 9')).toEqual({ min: 1, max: 6 })
    expect(parseTocRange('  max_depth :  2  ')).toEqual({ min: 1, max: 2 })
  })
  it('写反了两头交换;只写一头时另一头跟着缺省走', () => {
    expect(parseTocRange('min_depth: 4\nmax_depth: 2')).toEqual({ min: 2, max: 4 })
    expect(parseTocRange('min_depth: 2')).toEqual({ min: 2, max: 3 })
    expect(parseTocRange('min_depth: 5')).toEqual({ min: 5, max: 5 })
    expect(parseTocRange('max_depth: 6')).toEqual({ min: 1, max: 6 })
  })
  it('不认识的行、写坏的值不报错,当没写', () => {
    expect(parseTocRange('style: bullet\ntitle: Contents\nmax_depth: two\nmin_depth: 1.5')).toEqual({ min: 1, max: 3 })
    expect(parseTocRange('varied_style: true\r\nmax_depth: 2\r\n')).toEqual({ min: 1, max: 2 })
  })
  it('同名写两次以后一次为准', () => {
    expect(parseTocRange('max_depth: 2\nmax_depth: 5')).toEqual({ min: 1, max: 5 })
  })
})
