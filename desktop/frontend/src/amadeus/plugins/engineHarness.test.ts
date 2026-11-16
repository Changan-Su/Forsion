import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectHarnessRows, engineRailViewType, engineSessionActions, registerEngineHarness, resetEngineHarnessForTest, subscribeEngineHarness } from './engineHarness'

afterEach(() => resetEngineHarnessForTest())

describe('engineHarness', () => {
  it('按引擎收插件给的行;抛错的那家当没有、不连坐别家', async () => {
    let alive = true
    registerEngineHarness('fusion', { engineId: 'dsh', rows: () => [{ id: 'runtime', label: 'Runtime', text: '0.2.2-rc.3' }] }, () => alive)
    registerEngineHarness('broken', { engineId: 'dsh', rows: () => { throw new Error('boom') } }, () => true)
    registerEngineHarness('other', { engineId: 'claude-code', rows: () => [{ id: 'x', label: 'X' }] }, () => true)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await collectHarnessRows('dsh', { agentSlug: 'a' })).map((r) => `${r.owner}:${r.row.id}`)).toEqual(['fusion:runtime'])
    alive = false // 插件停用:它的行不再画
    expect(await collectHarnessRows('dsh', { agentSlug: 'a' })).toEqual([])
    err.mockRestore()
  })

  it('对话右键菜单的项按引擎取,每个插件最多 4 项;dispose 后撤掉', () => {
    const run = () => {}
    const h = registerEngineHarness('fusion', { engineId: 'dsh', sessionActions: Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, label: 'Open', run })) }, () => true)
    expect(engineSessionActions('dsh')).toHaveLength(4)
    expect(engineSessionActions('claude-code')).toHaveLength(0)
    h.dispose()
    expect(engineSessionActions('dsh')).toHaveLength(0)
  })

  it('右栏页:按引擎取插件登记的 View(全名 plugin:<插件>:<id>);插件停用 / dispose 后没有;登记表变了通知订阅者', () => {
    const seen = vi.fn()
    const off = subscribeEngineHarness(seen)
    let alive = true
    const h = registerEngineHarness('dsh2forsion', { engineId: 'dsh', railView: 'rail' }, () => alive)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(engineRailViewType('dsh')).toBe('plugin:dsh2forsion:rail')
    expect(engineRailViewType('claude-code')).toBeNull()
    alive = false
    expect(engineRailViewType('dsh')).toBeNull()
    alive = true
    h.dispose()
    expect(engineRailViewType('dsh')).toBeNull()
    expect(seen).toHaveBeenCalledTimes(2)
    off()
    // 只给行、不给右栏页的那家不算
    registerEngineHarness('other', { engineId: 'dsh', rows: () => [] }, () => true)
    expect(engineRailViewType('dsh')).toBeNull()
  })

  it('形态不对同步抛', () => {
    expect(() => registerEngineHarness('p', { engineId: 'dsh', railView: 'plugin:x:y' } as never, () => true)).toThrow(/railView/)
    expect(() => registerEngineHarness('p', { engineId: 'dsh', railView: 3 } as never, () => true)).toThrow(/railView/)
    expect(() => registerEngineHarness('p', { engineId: 'DSH!' } as never, () => true)).toThrow(/engineId/)
    expect(() => registerEngineHarness('p', { engineId: 'dsh', sessionActions: [{ id: 'x' }] } as never, () => true)).toThrow(/run/)
  })
})
