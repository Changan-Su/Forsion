import { describe, expect, it } from 'vitest'
import { createBlockSurface, samePage } from './blockSurface'
import { registerUnifiedPipe } from '../unified/lifecycle'
import type { PageStoreApi } from '../store/pageStore'
import type { PageSnapshot } from './types'

const blocks = { b1: 'a', b2: 'b' }
const base: PageSnapshot = {
  token: 'x.md#1', path: 'x.md', status: 'ready', text: 'a\n\nb', model: 'blocks',
  blocks, order: ['b1', 'b2'], fmExtra: '',
}

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

// ── 运行时(令牌口径 / 两条路由的快照 / v4 写口)。假 store 喂进 bind,不需要 React。 ──────────

type FakeState = Record<string, unknown>
function fakeStore(init: FakeState) {
  let state: FakeState = { activePage: null, activeNotePath: null, status: 'idle', blocks: {}, manifest: null, flatOrder: () => [], ...init }
  const subs = new Set<() => void>()
  return {
    api: {
      getState: () => state,
      subscribe: (f: () => void) => { subs.add(f); return () => subs.delete(f) },
    } as unknown as PageStoreApi,
    set(patch: FakeState) {
      state = { ...state, ...patch }
      for (const f of [...subs]) f()
    },
  }
}

describe('快照:两条路由', () => {
  it('v3 = 块表 + 按 order 拼的整篇文本(不是 Object.values 的插入序)', () => {
    const st = fakeStore({
      activePage: 'x.md', status: 'ready',
      blocks: { b2: { content: 'second' }, b1: { content: 'first' } }, // 故意反序落表
      manifest: { fmExtra: 'k: 1' },
      flatOrder: () => ['b1', 'b2'],
    })
    const { api, revoke } = createBlockSurface('t', { store: st.api, scope: 's1' })
    const pg = api.getPage()
    expect(pg.model).toBe('blocks')
    expect(pg.text).toBe('first\n\nsecond')
    expect(pg.order).toEqual(['b1', 'b2'])
    expect(pg.fmExtra).toBe('k: 1')
    revoke()
  })

  it('v4 = 正文来自 unified 实例,块表恒空且自报 model:text', () => {
    const st = fakeStore({ activeNotePath: 'v4.md' })
    const { api, revoke } = createBlockSurface('t', { store: st.api, scope: 's2' })
    expect(api.getPage()).toMatchObject({ path: 'v4.md', model: 'text', text: '', status: 'idle' })
    const off = registerUnifiedPipe({
      path: 'v4.md', flush: async () => {}, retire: () => {},
      bodyNow: () => '# 标题\n正文', fmNow: () => 'zot: 1',
    })
    const pg = api.getPage()
    expect(pg).toMatchObject({ model: 'text', text: '# 标题\n正文', fmExtra: 'zot: 1', status: 'ready' })
    expect(pg.order).toEqual([]) // ⚠️ 绝不给 v4 合成块 id:宁可空,不可假
    expect(Object.keys(pg.blocks)).toEqual([])
    off()
    revoke()
  })
})

describe('⚠️P0 页令牌:v4 下必须跟着 activeNotePath 走', () => {
  it('换笔记 → 换令牌;A→B→A 不复用旧令牌', () => {
    const st = fakeStore({ activeNotePath: 'a.md' })
    const { api, revoke } = createBlockSurface('t', { store: st.api, scope: 's3' })
    const tA = api.getPage().token
    st.set({ activeNotePath: 'b.md' })
    const tB = api.getPage().token
    st.set({ activeNotePath: 'a.md' })
    const tA2 = api.getPage().token
    // 只读 activePage 的老口径下三者恒等于 '#0' —— 那时 A 篇的令牌在 B 篇照样过闸。
    expect(tA).not.toBe(tB)
    expect(tA2).not.toBe(tA)
    revoke()
  })

  it('拿旧令牌提交一律被拒(块口与文本口都是)', () => {
    const st = fakeStore({ activeNotePath: 'a.md' })
    const { api, revoke } = createBlockSurface('t', { store: st.api, scope: 's4' })
    const stale = api.getPage().token
    st.set({ activeNotePath: 'b.md' })
    expect(api.insertBlockAfter(stale, null, 'x')).toBeNull()
    expect(api.insertMarkdown(stale, 'x')).toBe(false)
    revoke()
  })
})

describe('v4 写口', () => {
  it('insertBlockAfter 诚实返回 null(不是 \'\' —— 空串会让插件一路走成功分支)', () => {
    const st = fakeStore({ activeNotePath: 'v4.md' })
    const { api, revoke } = createBlockSurface('t', { store: st.api, scope: 's5' })
    expect(api.insertBlockAfter(api.getPage().token, null, '正文')).toBeNull()
    revoke()
  })

  it('insertMarkdown 转给 unified 实例,档位原样带过去;没有实例 → false', () => {
    const st = fakeStore({ activeNotePath: 'v4.md' })
    const { api, revoke } = createBlockSurface('t', { store: st.api, scope: 's6' })
    expect(api.insertMarkdown(api.getPage().token, '引用', 'start')).toBe(false) // 实例没挂
    const seen: Array<[string, string]> = []
    const off = registerUnifiedPipe({
      path: 'v4.md', flush: async () => {}, retire: () => {},
      insertMarkdown: (md, where) => { seen.push([md, where]); return true },
    })
    expect(api.insertMarkdown(api.getPage().token, '引用', 'start')).toBe(true)
    expect(api.insertMarkdown(api.getPage().token, '尾巴')).toBe(true) // 缺省档
    expect(seen).toEqual([['引用', 'start'], ['尾巴', 'cursor']])
    off()
    revoke()
  })
})

describe('subscribePage 的 v4 节拍', () => {
  it('实例挂上来要通知(正文从「问不到」变「问得到」,store 一声不吭)', () => {
    const st = fakeStore({ activeNotePath: 'v4.md' })
    const { api, revoke } = createBlockSurface('t', { store: st.api, scope: 's7' })
    const seen: string[] = []
    const stop = api.subscribePage((pg) => seen.push(pg.text))
    const off = registerUnifiedPipe({ path: 'v4.md', flush: async () => {}, retire: () => {}, bodyNow: () => '新正文' })
    expect(seen).toEqual(['新正文'])
    off()
    stop()
    revoke()
  })

  it('revoke 之后两个源都退订(store 与 unified 各再动一次,回调不该再响)', () => {
    const st = fakeStore({ activeNotePath: 'v4.md' })
    const { api, revoke } = createBlockSurface('t', { store: st.api, scope: 's8' })
    let n = 0
    api.subscribePage(() => { n++ })
    revoke()
    st.set({ activeNotePath: 'other.md' })
    const off = registerUnifiedPipe({ path: 'other.md', flush: async () => {}, retire: () => {}, bodyNow: () => 'x' })
    off()
    expect(n).toBe(0)
  })
})
