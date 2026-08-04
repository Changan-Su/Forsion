import { beforeEach, describe, expect, it, vi } from 'vitest'
import { foldedSet, headingLevel, useHeadingFold } from './headingFoldStore'

describe('headingLevel', () => {
  it('识别 # ~ ######', () => {
    expect(headingLevel('# 一级')).toBe(1)
    expect(headingLevel('###### 六级\n后续行')).toBe(6)
  })
  it('CommonMark 允许最多三个前导空格', () => {
    expect(headingLevel('   ## 缩进标题')).toBe(2)
    expect(headingLevel('    ## 四个空格是代码块')).toBe(0)
  })
  it('非标题回 0', () => {
    expect(headingLevel('正文')).toBe(0)
    expect(headingLevel('#没空格')).toBe(0)
    expect(headingLevel('####### 七个井号')).toBe(0)
    expect(headingLevel('> # 引用里的标题')).toBe(0)
    expect(headingLevel('')).toBe(0)
    expect(headingLevel(undefined)).toBe(0)
  })
})

describe('折叠状态', () => {
  beforeEach(() => {
    const mem = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    })
    useHeadingFold.setState({ byPage: {} })
  })

  it('toggle 开合同一个 id', () => {
    const t = useHeadingFold.getState().toggle
    t('a.md', '3')
    expect([...foldedSet(useHeadingFold.getState().byPage, 'a.md')]).toEqual(['3'])
    t('a.md', '3')
    expect(foldedSet(useHeadingFold.getState().byPage, 'a.md').size).toBe(0)
  })

  it('⚠️按笔记分桶:块 id 是每份文件自己的小整数,跨笔记必然重号', () => {
    useHeadingFold.getState().toggle('a.md', '3')
    expect(foldedSet(useHeadingFold.getState().byPage, 'a.md').has('3')).toBe(true)
    expect(foldedSet(useHeadingFold.getState().byPage, 'b.md').has('3')).toBe(false)
  })

  it('全部展开后不留空桶(localStorage 不越积越大)', () => {
    useHeadingFold.getState().toggle('a.md', '3')
    useHeadingFold.getState().toggle('a.md', '3')
    expect(Object.keys(useHeadingFold.getState().byPage)).toEqual([])
  })

  it('落 localStorage(重开笔记折叠还在)', () => {
    useHeadingFold.getState().toggle('a.md', '7')
    expect(JSON.parse(localStorage.getItem('amadeus.heading.fold')!)).toEqual({ 'a.md': ['7'] })
  })
})
