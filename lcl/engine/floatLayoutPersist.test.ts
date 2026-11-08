/**
 * 浮层卡 × Space 布局的接线(2026-11-08,LCL 表面规范第三期收尾;§7「Space 作用域的锚点和拖过的位置跟 Space 布局一起记」)。
 * 跑真 dockviewStore,Dockview 换成最小桩(同 layoutResetUndo.test),浮层那头换成假的 FloatPersistence —— 只锁 dockviewStore
 * 什么时候问 / 交 / 收;workspaceOpen 那半(开回来、挂起、锚点)在 desktop/frontend/src/workspaceOpen.test.ts。
 *   ① 存布局:归属知道 → 信封带上这个 Space 的 floats;没有卡不写这个键;归属不明不问、不写
 *   ② 换布局(applyLayout:切 Space / 撤销重置 / 命名布局)→ 按信封的 space 交回 floats;没归属的不动卡
 *   ③ 用户亲手「恢复默认布局」→ 收掉这个 Space 的卡,快照里记着,撤销交回去;自动重置不碰卡
 *   ④ 浮层那头抛错不连累存布局
 *   ⑤ Codex 评审(11-08 第二轮):别的 Space 存的命名布局套到这里,卡开进这里(不回存它的那个 Space 藏着);Dockview 图是空的
 *      (停靠的全关了,只剩卡)那份照默认重建,但卡照样开回来(冷启动、切 Space 两条路)
 * 负对照(11-08 已实跑红):envelope 不带 floats → ①红;applyLayout 不调 restoreFloats → ②红;resetLayout 不 clear → ③红;
 * floatsOf 不 try → ④红;applyLayout 按信封的 space 还原 → ⑤「开进这里」红;applyNamed / 冷启动遇空图不还原卡 → ⑤「Dockview 图是空的」各红一次。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DockviewApi } from 'dockview-react'
import { tryRestoreLayout, useWorkspace } from './dockviewStore'
import { setRibbonActions } from './ribbonRegistry'
import { floatPersistence, setFloatPersistence, type FloatPersistence } from './floatPersistSeam'
import { loadLayout, isLayoutEnvelopeV4, readPersistedFloats, saveLayout, saveNamedLayout, type PersistedFloat } from './layoutPersist'

const mem = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, v) },
  removeItem: (k: string) => { mem.delete(k) },
}

function mkApi() {
  const loaded: unknown[] = []
  let layout: { tag: string } = { tag: 'user-layout' }
  const api = {
    panels: [] as unknown[], groups: [] as Array<{ panels: Array<{ id: string }> }>, activePanel: null, width: 1200, height: 800,
    getPanel: () => undefined,
    grid: { root: { type: 'branch', data: [] as unknown[] } } as { root: unknown },
    clear() { layout = { tag: 'cleared' } },
    toJSON: () => ({ ...layout, grid: api.grid, panels: {} }),
    fromJSON(j: { tag: string }) { loaded.push(j); layout = { tag: j.tag } },
  }
  useWorkspace.getState().setApi(api as unknown as DockviewApi)
  return { api, loaded }
}

const card = (type: string, anchor = 'top-end'): PersistedFloat => ({ type, form: 'mini', anchor, view: { type, params: { n: 1 } }, mainView: { type, params: { n: 1 } } })
let real: FloatPersistence | null
let fake: { collect: ReturnType<typeof vi.fn>; restore: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> }

beforeEach(() => {
  mem.clear()
  real = floatPersistence()
  fake = { collect: vi.fn((space: string) => (space === 'cloud' ? [card('v')] : [])), restore: vi.fn(), clear: vi.fn() }
  setFloatPersistence(fake)
})
afterEach(() => { setFloatPersistence(real); setRibbonActions({ notify: undefined }) })

describe('浮层卡 × Space 布局', () => {
  it('① 存布局:归属知道就带上这个 Space 的卡;没卡不写这个键;归属不明不问', () => {
    mkApi()
    useWorkspace.setState({ sideProfileKey: 'cloud' })
    useWorkspace.getState().saveCurrent()
    expect(fake.collect).toHaveBeenLastCalledWith('cloud')
    expect(loadLayout()).toMatchObject({ space: 'cloud', floats: [card('v')] })
    useWorkspace.setState({ sideProfileKey: 'chat' })
    useWorkspace.getState().saveCurrent()
    expect(loadLayout()!.space).toBe('chat')
    expect('floats' in loadLayout()!).toBe(false)
    fake.collect.mockClear()
    useWorkspace.setState({ sideProfileKey: null })
    useWorkspace.getState().saveCurrent()
    expect(fake.collect).not.toHaveBeenCalled()
    expect('floats' in loadLayout()!).toBe(false)
  })

  it('② 换布局:按信封的 space 交回 floats;没归属的不动卡', () => {
    mkApi()
    const blob = { version: 4 as const, space: 'cloud', floats: [card('v')], dockview: { tag: 'x' }, sidebars: { left: { visible: true, stash: [] }, right: { visible: true, stash: [] } } }
    expect(useWorkspace.getState().applyLayout(blob)).toBe(true)
    expect(fake.restore).toHaveBeenCalledWith('cloud', [card('v')])
    fake.restore.mockClear()
    const { space: _s, ...noOwner } = blob
    void _s
    useWorkspace.getState().applyLayout(noOwner)
    expect(fake.restore).not.toHaveBeenCalled()
  })

  it('③ 亲手「恢复默认布局」收掉这个 Space 的卡,撤销交回;自动重置不碰卡', () => {
    const notify = vi.fn()
    setRibbonActions({ notify })
    mkApi()
    useWorkspace.setState({ sideProfileKey: 'cloud' })
    useWorkspace.getState().resetLayout({ undoable: true })
    expect(fake.clear).toHaveBeenCalledWith('cloud')
    const [, action] = notify.mock.calls[0] as [string, { run(): void }]
    action.run()
    expect(fake.restore).toHaveBeenCalledWith('cloud', [card('v')])
    fake.clear.mockClear()
    useWorkspace.getState().resetLayout()
    expect(fake.clear).not.toHaveBeenCalled()
  })

  it('④ 浮层那头抛错不连累存布局', () => {
    mkApi()
    fake.collect.mockImplementation(() => { throw new Error('boom') })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    useWorkspace.setState({ sideProfileKey: 'cloud' })
    useWorkspace.getState().saveCurrent()
    expect(loadLayout()).toMatchObject({ space: 'cloud' })
    err.mockRestore()
  })

  it('⑤ 别的 Space 存的命名布局套到这里:卡开进这里', () => {
    mkApi()
    useWorkspace.setState({ sideProfileKey: 'chat' })
    const blob = { version: 4 as const, space: 'cloud', floats: [card('v')], dockview: { tag: 'x' }, sidebars: { left: { visible: true, stash: [] }, right: { visible: true, stash: [] } } }
    useWorkspace.getState().applyLayout(blob)
    expect(fake.restore).toHaveBeenCalledWith('chat', [card('v')])
  })

  it('⑤ Dockview 图是空的(只剩卡):照默认重建,卡照样开回来 —— 切 Space(applyNamed)和冷启动两条路', () => {
    const { api } = mkApi()
    useWorkspace.setState({ sideProfileKey: 'cloud' })
    const blank = { version: 4 as const, space: 'cloud', floats: [card('v')], dockview: { panels: {} }, sidebars: { left: { visible: true, stash: [] }, right: { visible: true, stash: [] } } }
    saveNamedLayout('space:cloud', blank)
    expect(useWorkspace.getState().applyNamed('space:cloud')).toBe(false)
    expect(fake.restore).toHaveBeenCalledWith('cloud', [card('v')])
    fake.restore.mockClear()
    saveLayout(blank)
    expect(tryRestoreLayout(api as unknown as DockviewApi)).toBe(false)
    expect(fake.restore).toHaveBeenCalledWith('cloud', [card('v')])
  })

  it('信封里不成形的 floats 逐条丢,不连累整份布局', () => {
    const good = card('v')
    expect(readPersistedFloats([null, 'junk', { type: 'v' }, { ...good, form: 'side' }, { ...good, view: { type: '' } }, { ...good, key: 3 }, good])).toEqual([good])
    expect(readPersistedFloats('junk')).toEqual([])
    const env = { version: 4, dockview: {}, sidebars: { left: { visible: true, stash: [] }, right: { visible: true, stash: [] } } }
    expect(isLayoutEnvelopeV4({ ...env, floats: 'junk' })).toBe(true)
  })
})
