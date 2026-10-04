/** 两级导航的闸(listFirstNow):只在画底部导航栏的原生宿主下生效,而且左栏必须拿得出能画的视图。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installNativeChromeHost } from './nativeChrome'
import { listFirstNow } from './listFirst'
import { registerView, unregisterView } from './viewRegistry'
import { useSpaceStore } from './spaceRegistry'
import { useWorkspace } from './singleColumnStore'
import type { SpaceDefinition } from './types'

const EMPTY = {
  mainLeaves: [], leftLeaves: [], rightLeaves: [],
  activeMainId: null, leftActiveId: null, rightActiveId: null,
  leftVisible: false, rightVisible: false, focusedChatLeafId: null,
  wideMode: false, sidebarDefaults: { left: [], right: [] },
}
const space = (extra: Partial<SpaceDefinition> = {}): SpaceDefinition => ({ id: 's', name: 'S', sidebarDefaults: { left: [], right: [] }, build: () => {}, ...extra })
let uninstall: (() => void) | null = null
const host = (spaces: boolean): void => { uninstall = installNativeChromeHost({ render: () => {}, spaces }) }

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) }, clear: () => store.clear(),
  })
  for (const t of ['chat', 'files']) registerView({ type: t, displayName: () => t, factory: () => null })
  useWorkspace.setState(EMPTY)
  useSpaceStore.setState({ spaces: [space()], activeSpaceId: 's' })
})
afterEach(() => { uninstall?.(); uninstall = null; unregisterView('gone') })

describe('listFirstNow', () => {
  it('没有原生宿主 / 宿主不画底栏 → 恒 false(web、桌面手机框、手机浏览器的抽屉不变)', () => {
    useWorkspace.getState().openView('files', {}, 'left')
    expect(listFirstNow()).toBe(false)
    host(false)
    expect(listFirstNow()).toBe(false)
  })

  it('原生底栏 × 有左栏视图 → true;宽屏、Space 退订(listFirst: false)、没有左栏 → false', () => {
    host(true)
    expect(listFirstNow()).toBe(false) // 没有左栏:主区就是第一层
    useWorkspace.getState().openView('files', {}, 'left')
    expect(listFirstNow()).toBe(true)
    useWorkspace.setState({ wideMode: true })
    expect(listFirstNow()).toBe(false)
    useWorkspace.setState({ wideMode: false })
    useSpaceStore.setState({ spaces: [space({ listFirst: false })] })
    expect(listFirstNow()).toBe(false)
  })

  it('左栏还没填(抽屉没开过)→ 看缺省:缺省里有注册在案的视图才算', () => {
    host(true)
    useWorkspace.setState({ sidebarDefaults: { left: [{ type: 'files', params: {} }], right: [] } })
    expect(listFirstNow()).toBe(true)
    useWorkspace.setState({ sidebarDefaults: { left: [{ type: 'gone', params: {} }], right: [] } })
    expect(listFirstNow()).toBe(false) // 卸掉的插件留下的缺省:画不出来
  })

  it('第一层不能是白页:左栏开着却空了、或 leaf 的视图类型没注册 → false(退回抽屉形态)', () => {
    host(true)
    const ws = useWorkspace.getState()
    ws.setSidebarDefaults({ left: [{ type: 'files', params: {} }], right: [] })
    ws.toggleSidebar('left') // 首开:按缺省填上
    expect(useWorkspace.getState().leftLeaves.map((r) => r.type)).toEqual(['files'])
    expect(listFirstNow()).toBe(true)
    // 视图被关光(插件自己关的),抽屉还开着
    useWorkspace.getState().closeLeaf(useWorkspace.getState().leftLeaves[0].id)
    expect(useWorkspace.getState().leftLeaves).toEqual([])
    expect(useWorkspace.getState().leftVisible).toBe(true)
    expect(listFirstNow()).toBe(false)
    // 关上再开 = 按缺省重填,列表层回来
    useWorkspace.getState().toggleSidebar('left')
    useWorkspace.getState().toggleSidebar('left')
    expect(listFirstNow()).toBe(true)
    // leaf 在、但类型已经不在注册表里(插件卸了)
    registerView({ type: 'gone', displayName: () => 'gone', factory: () => null })
    useWorkspace.setState({ ...EMPTY })
    useWorkspace.getState().openView('gone', {}, 'left')
    expect(listFirstNow()).toBe(true)
    unregisterView('gone')
    expect(listFirstNow()).toBe(false)
  })
})
