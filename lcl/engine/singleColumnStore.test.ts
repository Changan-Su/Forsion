/**
 * 单列(移动/mini)布局持久化。病史:这四个方法原本是写死的 no-op —— 冷启动 `mainLeaves.length===0`
 * 就直接 buildDefault、切 Space 时 applyNamed 恒 false 落到 resetLayout,于是**每次进 app / 每次进
 * Space 都是一张新页**,用户实报「移动端进去每次都是 new 的页面」。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useWorkspace, restoreSingleColumnLayout } from './singleColumnStore'
import { registerView } from './viewRegistry'

const EMPTY = {
  mainLeaves: [], leftLeaves: [], rightLeaves: [],
  activeMainId: null, leftActiveId: null, rightActiveId: null,
  leftVisible: false, rightVisible: false, focusedChatLeafId: null,
}

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
  for (const t of ['chat', 'note', 'files']) registerView({ type: t, displayName: () => t, factory: () => null })
  useWorkspace.setState(EMPTY)
})

/** 造一份「两个主标签,激活第二个」的现场。 */
function seed(): void {
  useWorkspace.getState().openView('chat', { sessionId: 's1' }, 'main')
  useWorkspace.getState().openView('note', { path: 'a.md' }, 'main', { newTab: true })
  useWorkspace.getState().openView('files', {}, 'left')
}

describe('单列布局持久化', () => {
  it('存 → 清空 → 还原:主区标签、参数、激活项都回来', () => {
    seed()
    const activeBefore = useWorkspace.getState().activeMainId
    useWorkspace.getState().saveCurrent()

    useWorkspace.setState(EMPTY)
    expect(restoreSingleColumnLayout()).toBe(true)

    const s = useWorkspace.getState()
    expect(s.mainLeaves.map((r) => r.type)).toEqual(['chat', 'note'])
    expect(s.mainLeaves[1].params).toEqual({ path: 'a.md' })
    expect(s.activeMainId).toBe(activeBefore)
    expect(s.leftLeaves.map((r) => r.type)).toEqual(['files'])
    expect(s.mainTabs.find((t) => t.active)?.type).toBe('note') // refreshTabs 也补跑了
  })

  it('抽屉开合不还原(单列侧栏是全屏浮层,一进 app 不该先看到它)', () => {
    seed()
    useWorkspace.getState().toggleSidebar('left')
    expect(useWorkspace.getState().leftVisible).toBe(true)
    useWorkspace.getState().saveCurrent()

    useWorkspace.setState(EMPTY)
    restoreSingleColumnLayout()
    expect(useWorkspace.getState().leftVisible).toBe(false)
    expect(useWorkspace.getState().leftLeaves.map((r) => r.type)).toEqual(['files']) // 内容还在,打开就有
  })

  it('视图已下线的 leaf 逐个剔除,不整份丢(端间差异:Tangu Web 没有 amadeus-*)', () => {
    seed()
    useWorkspace.setState({ mainLeaves: [...useWorkspace.getState().mainLeaves, { id: 'ghost#1', type: 'ghost', loc: 'main', params: {}, title: 'ghost' }] })
    useWorkspace.getState().saveCurrent()

    useWorkspace.setState(EMPTY)
    expect(restoreSingleColumnLayout()).toBe(true)
    expect(useWorkspace.getState().mainLeaves.map((r) => r.type)).toEqual(['chat', 'note'])
  })

  it('激活项指向已剔除的 leaf 时回落到最后一个,不留悬空 id', () => {
    useWorkspace.getState().openView('chat', {}, 'main')
    useWorkspace.setState({
      mainLeaves: [...useWorkspace.getState().mainLeaves, { id: 'ghost#1', type: 'ghost', loc: 'main', params: {}, title: 'g' }],
      activeMainId: 'ghost#1',
    })
    useWorkspace.getState().saveCurrent()

    useWorkspace.setState(EMPTY)
    restoreSingleColumnLayout()
    expect(useWorkspace.getState().activeMainId).toBe('chat#1')
  })

  // Codex 评审 2026-08-13:isBlob 只查三个桶是不是数组,桶里塞 null / 少字段就会在 knownLeaves
  // 里 `r.type` 抛错 —— 而 restoreSingleColumnLayout 外面没有 catch,壳会进错误边界而不是回落默认。
  it('结构损坏的存档不抛错,坏 leaf 逐个剔掉', () => {
    const bad = [null, 42, { type: 'chat' }, { id: 'x#1', type: 'chat', loc: 'main', params: null }, { id: 'ok#1', type: 'chat', loc: 'main', params: {}, title: 'ok' }]
    localStorage.setItem('lcl_sc_layout_v1', JSON.stringify({ v: 1, main: bad, left: [null], right: [], activeMainId: null, leftActiveId: null, rightActiveId: null }))
    expect(() => restoreSingleColumnLayout()).not.toThrow()
    expect(useWorkspace.getState().mainLeaves.map((r) => r.id)).toEqual(['ok#1'])
    expect(useWorkspace.getState().leftLeaves).toEqual([])
  })

  it('整份坏掉(主区一个都不剩)→ false,调用方去 buildDefault', () => {
    localStorage.setItem('lcl_sc_layout_v1', JSON.stringify({ v: 1, main: [null, { nope: 1 }], left: [], right: [], activeMainId: null, leftActiveId: null, rightActiveId: null }))
    expect(restoreSingleColumnLayout()).toBe(false)
  })

  it('首启 / 存过但主区全没了 → false,调用方去 buildDefault', () => {
    expect(restoreSingleColumnLayout()).toBe(false)
    useWorkspace.getState().saveCurrent() // 空现场
    expect(restoreSingleColumnLayout()).toBe(false)
  })

  it('命名布局(每-Space 槽)独立成对存取', () => {
    seed()
    useWorkspace.getState().saveNamed('space:tangu')
    expect(useWorkspace.getState().namedLayouts()).toEqual(['space:tangu'])

    useWorkspace.setState(EMPTY)
    useWorkspace.getState().openView('chat', {}, 'main')
    useWorkspace.getState().saveNamed('space:amadeus')

    expect(useWorkspace.getState().applyNamed('space:tangu')).toBe(true)
    expect(useWorkspace.getState().mainLeaves.map((r) => r.type)).toEqual(['chat', 'note'])
    expect(useWorkspace.getState().applyNamed('space:nope')).toBe(false) // 没存过 → 调用方 resetLayout
  })
})
