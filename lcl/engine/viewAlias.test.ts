/**
 * 宿主给的视图别名(viewAlias.ts)。病例:同一个插件包先装成普通目录、后从商店装了一份(运行身份变成 market-<UUID>),
 * 旧目录挪走后,用户存过的布局还记着 `plugin:<包 id>:x` —— 三栏全是「此视图暂不可用」,只能手点「恢复默认布局」。
 * 钉三处:Dockview 存档迁移(migrateLayoutBlob:面板、收起栈、浮层卡)、单列存档还原(applySCBlob:改名而不是当未注册剔掉)、
 * 单列店里已摆着的 leaf(adoptViewAliases)。另钉边界:没装规则 / 旧名字还注册着 / 规则抛错 = 一个都不动。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateLayoutBlob } from './dockviewStore'
import { useWorkspace, restoreSingleColumnLayout } from './singleColumnStore'
import { registerView, unregisterView } from './viewRegistry'
import { setLayoutViewAlias } from './viewAlias'
import type { LayoutEnvelopeV4 } from './layoutPersist'

const OLD = 'plugin:demo-suite:'
const NEW = 'plugin:market-00000000-0000-4000-8000-00000000000a:'
const rule = (type: string): string | null => (type.startsWith(OLD) ? NEW + type.slice(OLD.length) : null)
const view = (type: string) => registerView({ type, displayName: () => type, factory: () => null })

function blob(): LayoutEnvelopeV4 {
  return {
    version: 4,
    space: 'demo',
    dockview: {
      panels: {
        a: { id: 'a', contentComponent: '__frame', params: { __loc: 'main', __type: `${OLD}chat`, room: 'r1' } },
        b: { id: `${OLD}list`, contentComponent: `${OLD}list`, params: { __loc: 'left', __type: `${OLD}list` } },
        c: { id: 'c', contentComponent: 'chat', params: { __loc: 'right', __type: 'chat' } },
      },
    },
    sidebars: {
      left: { visible: true, stash: [] },
      right: { visible: false, stash: [{ type: `${OLD}details`, params: { tab: 'x' } }] },
    },
    floats: [{ type: `${OLD}chat`, form: 'mini', anchor: 'right', view: { type: `${OLD}chat-mini`, params: {} }, mainView: { type: `${OLD}chat`, params: { room: 'r1' } } }],
  }
}

afterEach(() => {
  setLayoutViewAlias(null)
  for (const t of ['chat', 'list', 'details']) { unregisterView(NEW + t); unregisterView(OLD + t) }
})

describe('Dockview 存档迁移', () => {
  it('旧身份的视图改到新名字:参数原样,侧栏组件名一起改,浮层卡三处都改', () => {
    setLayoutViewAlias(rule)
    const b = blob()
    expect(migrateLayoutBlob(b)).toBe(6)
    const panels = (b.dockview as { panels: Record<string, { contentComponent: string; params: Record<string, unknown> }> }).panels
    expect(panels.a).toMatchObject({ contentComponent: '__frame', params: { __type: `${NEW}chat`, room: 'r1' } })
    expect(panels.b).toMatchObject({ contentComponent: `${NEW}list`, params: { __type: `${NEW}list`, __loc: 'left' } })
    expect(panels.c.params.__type).toBe('chat')
    expect(b.sidebars.right.stash).toEqual([{ type: `${NEW}details`, params: { tab: 'x' } }])
    expect(b.floats![0]).toMatchObject({ type: `${NEW}chat`, view: { type: `${NEW}chat-mini` }, mainView: { type: `${NEW}chat`, params: { room: 'r1' } } })
  })

  it('没装规则 / 旧名字还注册着 / 规则抛错:一个都不动', () => {
    expect(migrateLayoutBlob(blob())).toBe(0)
    setLayoutViewAlias(() => { throw new Error('boom') })
    expect(migrateLayoutBlob(blob())).toBe(0)
    setLayoutViewAlias(rule)
    for (const t of ['chat', 'list', 'details', 'chat-mini']) view(OLD + t) // 旧身份还在跑:它的视图就是它的
    const b = blob()
    expect(migrateLayoutBlob(b)).toBe(0)
    expect(b.sidebars.right.stash[0].type).toBe(`${OLD}details`)
    unregisterView(`${OLD}chat-mini`)
  })
})

describe('单列 store(手机 / Mini)', () => {
  const EMPTY = {
    mainLeaves: [], leftLeaves: [], rightLeaves: [],
    activeMainId: null, leftActiveId: null, rightActiveId: null,
    leftVisible: false, rightVisible: false, focusedChatLeafId: null,
    wideMode: false, sidebarDefaults: { left: [], right: [] }, defaultBuilder: null,
  }
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
      clear: () => store.clear(),
    })
    view('chat')
    useWorkspace.setState(EMPTY)
  })

  it('还原存档:旧名字的 leaf 改名后留下(以前当未注册视图剔掉,主区回到默认页)', () => {
    for (const t of ['chat', 'list']) view(OLD + t)
    useWorkspace.getState().openView(`${OLD}chat`, { room: 'r1' }, 'main')
    useWorkspace.getState().openView(`${OLD}list`, {}, 'left')
    useWorkspace.getState().saveCurrent()
    for (const t of ['chat', 'list']) { unregisterView(OLD + t); view(NEW + t) } // 换成商店那份
    setLayoutViewAlias(rule)
    useWorkspace.setState(EMPTY)
    expect(restoreSingleColumnLayout()).toBe(true)
    const s = useWorkspace.getState()
    expect(s.mainLeaves.map((r) => [r.type, r.params])).toEqual([[`${NEW}chat`, { room: 'r1' }]])
    expect(s.leftLeaves.map((r) => r.type)).toEqual([`${NEW}list`])
  })

  it('已摆着的 leaf:新视图注册了才接过去,参数不动', () => {
    view(OLD + 'chat')
    useWorkspace.getState().openView(`${OLD}chat`, { room: 'r1' }, 'main')
    unregisterView(`${OLD}chat`)
    setLayoutViewAlias(rule)
    expect(useWorkspace.getState().adoptViewAliases()).toBe(0) // 新视图还没注册:改了也看不见,先不动
    view(`${NEW}chat`)
    expect(useWorkspace.getState().adoptViewAliases()).toBe(1)
    expect(useWorkspace.getState().mainLeaves.map((r) => [r.type, r.params])).toEqual([[`${NEW}chat`, { room: 'r1' }]])
    expect(useWorkspace.getState().adoptViewAliases()).toBe(0)
  })
})
