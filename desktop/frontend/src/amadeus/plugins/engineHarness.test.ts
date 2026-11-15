import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectHarnessRows, engineSessionActions, registerEngineHarness, resetEngineHarnessForTest } from './engineHarness'

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

  it('形态不对同步抛', () => {
    expect(() => registerEngineHarness('p', { engineId: 'DSH!' } as never, () => true)).toThrow(/engineId/)
    expect(() => registerEngineHarness('p', { engineId: 'dsh', sessionActions: [{ id: 'x' }] } as never, () => true)).toThrow(/run/)
  })
})
