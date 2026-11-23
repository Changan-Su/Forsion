/** 两级导航里一趟的页内历史(listTrips):从列表点进去的那一页是起点,进来之前看过的页不排在列表前面。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installNativeChromeHost } from './nativeChrome'
import { beginReturnTrip, endReturnTrip, installListTrips, returnTripOrigin, touchedPage } from './listTrips'
import { useNav } from './navStore'
import { registerView } from './viewRegistry'
import { useSpaceStore } from './spaceRegistry'
import { useWorkspace } from './singleColumnStore'

const EMPTY = {
  mainLeaves: [], leftLeaves: [], rightLeaves: [],
  activeMainId: null, leftActiveId: null, rightActiveId: null,
  leftVisible: false, rightVisible: false, focusedChatLeafId: null,
  wideMode: false, sidebarDefaults: { left: [], right: [] },
}
let offs: Array<() => void> = []
const keys = (leaf = 'L'): string[] => (useNav.getState().stacks[leaf]?.entries ?? []).map((e) => e.key)
const idx = (leaf = 'L'): number => useNav.getState().stacks[leaf]?.idx ?? -1
const page = (key: string, leaf = 'L'): void => useNav.getState().record(leaf, { key, restore: () => {} })
const list = (on: boolean): void => useWorkspace.setState({ leftVisible: on })
/** 手机:原生宿主画底栏,这个 Space 的左栏里有一个画得出来的列表。 */
function phone(): void {
  offs.push(installNativeChromeHost({ render: () => {}, spaces: true }))
  useWorkspace.getState().openView('files', {}, 'left')
  list(true)
}

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) }, clear: () => store.clear(),
  })
  registerView({ type: 'files', displayName: () => 'files', factory: () => null })
  useWorkspace.setState(EMPTY)
  useSpaceStore.setState({ spaces: [{ id: 's', name: 'S', sidebarDefaults: { left: [], right: [] }, build: () => {} }], activeSpaceId: 's' })
  useNav.getState().reset()
  offs = [installListTrips()]
})
afterEach(() => { offs.forEach((off) => off()) })

describe('listTrips', () => {
  it('列表 → 甲 → 回列表 → 乙:栈里只有乙,返回没有页可退 = 回列表(用户实报:先翻回了甲)', () => {
    phone()
    list(false); page('甲')
    expect(keys()).toEqual(['甲'])
    list(true)
    list(false); page('乙') // 点条目:先收列表,那一页随后才记
    expect(keys()).toEqual(['乙'])
    expect(idx()).toBe(0)
  })

  it('人停在列表上时记进来的页(进 Space 时还原出来的那条会话)不叠:点别的条目进去,它不在前面', () => {
    phone()
    page('上次那条'); page('又一条')
    expect(keys()).toEqual(['又一条'])
    list(false); page('点的这条')
    expect(keys()).toEqual(['点的这条'])
  })

  it('一趟里面自己走出来的页照旧能退:碰过屏幕之后记下的往上叠', () => {
    phone()
    list(false); page('笔记')
    touchedPage()
    page('链接过去的另一篇')
    expect(keys()).toEqual(['笔记', '链接过去的另一篇'])
    expect(idx()).toBe(1)
  })

  it('点回刚才那一条(没有东西重新记它)再走出去:起点还在栈里,返回先回到它(Codex 评审 P2)', () => {
    phone()
    list(false); page('甲')
    list(true)
    list(false) // 同一条:会话 id / 笔记路径没变,不会再记一次
    touchedPage()
    page('从甲点出去的页')
    expect(keys()).toEqual(['甲', '从甲点出去的页'])
  })

  it('回到列表时退到一半的栈只留现在那一页(前后都不留)', () => {
    phone()
    list(false); page('a'); touchedPage(); page('b'); page('c')
    useNav.getState().back('L')
    expect(idx()).toBe(1)
    list(true)
    expect(keys()).toEqual(['b'])
    expect(idx()).toBe(0)
  })

  it('在列表上碰屏幕不算数(点条目的那一下就落在列表上)', () => {
    phone()
    page('旧')
    touchedPage()
    list(false); page('新')
    expect(keys()).toEqual(['新'])
  })

  it('没有列表层的宿主(桌面 / 网页 / 手机浏览器)一概不动:照浏览器式的栈记', () => {
    useWorkspace.getState().openView('files', {}, 'left')
    list(true)
    page('a'); page('b')
    list(false); page('c')
    expect(keys()).toEqual(['a', 'b', 'c'])
  })
})

describe('return trip from Home\'s Continue (2026-11-19): back from that page goes Home, not to the Space\'s list', () => {
  beforeEach(() => {
    useSpaceStore.setState({ spaces: [
      { id: 'home', name: 'Home', sidebarDefaults: { left: [], right: [] }, build: () => {} },
      { id: 's', name: 'S', sidebarDefaults: { left: [], right: [] }, build: () => {} },
    ], activeSpaceId: 'home' })
  })

  it('settles once the other Space shows its second level; the list level that switching passes through right after does not end it', () => {
    phone()
    list(false)
    beginReturnTrip('home')
    expect(returnTripOrigin()).toBeNull()
    useSpaceStore.setState({ activeSpaceId: 's' }) // mid-switch: already "the other Space, second level"
    expect(returnTripOrigin()).toBe('home')
    list(true); list(false) // landOnList, then the row's content opens
    expect(returnTripOrigin()).toBe('home')
  })

  it('ends when the list comes up later or the Space changes; a trip that never opened anything lapses', () => {
    vi.useFakeTimers()
    try {
      phone()
      list(false)
      beginReturnTrip('home'); useSpaceStore.setState({ activeSpaceId: 's' }); list(true); list(false)
      vi.advanceTimersByTime(1000)
      list(true) // the user brought the list up (a swipe): the trip is over
      expect(returnTripOrigin()).toBeNull()
      list(false); useSpaceStore.setState({ activeSpaceId: 'home' })
      beginReturnTrip('home'); useSpaceStore.setState({ activeSpaceId: 's' }); list(false)
      expect(returnTripOrigin()).toBe('home')
      useSpaceStore.setState({ activeSpaceId: 'home' })
      expect(returnTripOrigin()).toBeNull()
      beginReturnTrip('home')
      vi.advanceTimersByTime(4000)
      useSpaceStore.setState({ activeSpaceId: 's' }); list(true); list(false) // long after: someone else's navigation
      expect(returnTripOrigin()).toBeNull()
      endReturnTrip()
    } finally { vi.useRealTimers() }
  })

  it('ends when another tab comes to the front after the way in; off the phone two-level layout (turned sideways) there is no trip', () => {
    vi.useFakeTimers()
    try {
      phone()
      list(false)
      beginReturnTrip('home'); useSpaceStore.setState({ activeSpaceId: 's' })
      useWorkspace.getState().openView('files', {}, 'main') // the row's content opens in a tab: part of the way in
      expect(returnTripOrigin()).toBe('home')
      vi.advanceTimersByTime(1000)
      useWorkspace.getState().openView('files', { other: 1 }, 'main', { newTab: true }) // the user picked another tab
      expect(returnTripOrigin()).toBeNull()
      // a fresh trip, then the phone layout goes away (no native dock host any more): nothing to return through
      useSpaceStore.setState({ activeSpaceId: 'home' })
      beginReturnTrip('home'); useSpaceStore.setState({ activeSpaceId: 's' })
      expect(returnTripOrigin()).toBe('home')
      offs.shift()?.()
      expect(returnTripOrigin()).toBeNull()
      endReturnTrip()
    } finally { vi.useRealTimers() }
  })
})
