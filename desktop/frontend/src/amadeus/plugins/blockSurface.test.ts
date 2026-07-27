import { describe, expect, it } from 'vitest'
import { samePage } from './blockSurface'
import type { PageSnapshot } from './types'

const blocks = { b1: 'a', b2: 'b' }
const base: PageSnapshot = { token: 'x.md#1', path: 'x.md', status: 'ready', blocks, order: ['b1', 'b2'], fmExtra: '' }

describe('samePage(subscribePage 的去重判据)', () => {
  it('同一份 = 等价(整页 save bump 的无关字段不该惊动插件)', () => {
    expect(samePage(base, { ...base })).toBe(true)
  })

  it('换页 / 加载态 / 外来 frontmatter 变了都要通知', () => {
    expect(samePage(base, { ...base, path: 'y.md' })).toBe(false)
    expect(samePage(base, { ...base, status: 'loading' })).toBe(false)
    expect(samePage(base, { ...base, fmExtra: 'mindmap: {}' })).toBe(false)
  })

  it('块内容改了要通知(靠 contentMap 缓存换引用,不是深比较)', () => {
    expect(samePage(base, { ...base, blocks: { b1: 'a!', b2: 'b' } })).toBe(false)
  })

  it('⚠️块数不变但顺序/身份变了也要通知(只比长度会漏掉「删一个加一个」)', () => {
    expect(samePage(base, { ...base, order: ['b2', 'b1'] })).toBe(false)
    expect(samePage(base, { ...base, order: ['b1', 'b3'] })).toBe(false)
    expect(samePage(base, { ...base, order: ['b1'] })).toBe(false)
  })
})

  it('⚠️页令牌变了必须通知(A→B→A 之后块 id 已易主,只比路径会认成同一页)', () => {
    expect(samePage(base, { ...base, token: 'x.md#3' })).toBe(false)
  })

  it("saving 归一成 ready:防抖保存的过程态不该让插件整树重渲两遍", () => {
    expect(samePage(base, { ...base, status: 'saving' })).toBe(true)
    expect(samePage({ ...base, status: 'saving' }, { ...base, status: 'ready' })).toBe(true)
    expect(samePage(base, { ...base, status: 'loading' })).toBe(false)
  })
