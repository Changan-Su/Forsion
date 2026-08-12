import { beforeEach, describe, expect, it, vi } from 'vitest'
import { foldedSet, headingLevel, sectionBoundaryLevel, useHeadingFold } from './headingFoldStore'

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

describe('sectionBoundaryLevel(小节边界:块内标题也算)', () => {
  it('取块内所有行里最小的标题级别', () => {
    expect(sectionBoundaryLevel('正文\n## 二\n正文\n# 一')).toBe(1)
    expect(sectionBoundaryLevel('正文\n### 三\n正文\n## 二')).toBe(2)
  })
  it('⚠️回归:块中间的标题不能漏检(漏了就一折到底)', () => {
    // headingLevel 只看首行 —— 这正是 2026-08-08 那个「折叠吞掉整篇」的根因
    expect(headingLevel('正文A\n## 二\n正文B')).toBe(0)
    expect(sectionBoundaryLevel('正文A\n## 二\n正文B')).toBe(2)
  })
  it('代码块里的 # 注释不是标题', () => {
    expect(sectionBoundaryLevel('```sh\n# 这是注释\necho hi\n```')).toBe(0)
    expect(sectionBoundaryLevel('```\n# 注释\n```\n## 真标题')).toBe(2)
  })
  it('整块无标题 → 0', () => {
    expect(sectionBoundaryLevel('纯正文\n第二行')).toBe(0)
    expect(sectionBoundaryLevel('a #b #c')).toBe(0)
    expect(sectionBoundaryLevel('')).toBe(0)
    expect(sectionBoundaryLevel(undefined)).toBe(0)
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
