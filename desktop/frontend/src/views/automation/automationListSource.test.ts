import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { automationListSource as source, subscribeAutomation } from './automationListSource'
import { useAutomation } from '../../stores/automationStore'
import { useApp } from '../../stores/appStore'
import * as backend from '../../services/backendService'
import type { MuseTriggerInfo } from '../../types'

const oldRefresh = useAutomation.getState().refresh
const trigger: MuseTriggerInfo = {
  id: 'existing-db', desc: 'Inventory', enabled: true, createdAt: '2026-09-01', lastFiredAt: null, cooldownHours: 0,
  cond: { type: 'db_changed', path: 'inventory.db', vault: '/original-vault', event: 'cell_changed', columnId: 'a', columnIds: ['a', 'b'], where: [{ column: 'status', op: 'eq', value: 'ready' }] },
  actions: [{ type: 'tool_call', tool: 'existing_tool', args: { enabled: false, limit: 0 } }],
}
beforeEach(() => {
  useAutomation.setState({ triggers: [trigger, { ...trigger, id: 'finished', desc: 'Old reminder', enabled: false, cond: { type: 'at', datetime: '2000-01-01T09:00' } }],
    schedules: [], sel: null, builder: null, refresh: vi.fn(async () => {}) })
})
afterEach(() => { useAutomation.setState({ refresh: oldRefresh }); vi.restoreAllMocks(); vi.useRealTimers() })

describe('native automation workspace source', () => {
  it('collects finished rules in their group and still finds them through search, without fetching during render', () => {
    expect(source.items().map((item) => item.title)).toContain('Inventory')
    expect(source.items().map((item) => item.title)).not.toContain('Old reminder')
    expect(source.items({ group: 'finished' }).map((item) => item.title)).toEqual(['Old reminder'])
    expect(source.items({ query: 'old' }).map((item) => item.title)).toEqual(['Old reminder'])
    expect(source.items({ query: 'inventory.db' }).map((item) => item.title)).toEqual(['Inventory'])
    source.groups!()
    expect(useAutomation.getState().refresh).not.toHaveBeenCalled()
  })
  it('shares one polling subscription between the workspace and main view, and cleans it up', () => {
    vi.useFakeTimers()
    const refresh = useAutomation.getState().refresh
    const stopList = subscribeAutomation(() => {}), stopMain = subscribeAutomation(() => {})
    try {
      expect(refresh).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(8000)
      expect(refresh).toHaveBeenCalledTimes(2)
      stopList()
      useAutomation.getState().bump()
      expect(refresh).toHaveBeenCalledTimes(3)
    } finally { stopMain() }
    vi.advanceTimersByTime(8000)
    expect(refresh).toHaveBeenCalledTimes(3)
  })
  it('the native menu toggle preserves the full old trigger and tool payload', async () => {
    const save = vi.spyOn(backend, 'saveMuseTrigger').mockResolvedValue({ ...trigger, enabled: false })
    source.itemMenu!(source.items({ group: 'rules' })[0]).find((action) => action.id === 'toggle')!.run()
    await Promise.resolve()
    expect(save.mock.calls[0][1]).toMatchObject({ id: trigger.id, enabled: false, actor: 'user', cooldown_hours: 0,
      path: 'inventory.db', vault: '/original-vault', column_ids: ['a', 'b'], where: [{ column: 'status', op: 'eq', value: 'ready' }], actions: trigger.actions })
  })
  it('notifies every mounted consumer when agent labels change and unsubscribes closed consumers', () => {
    const original = useApp.getState().agentDefs
    const first = vi.fn(), second = vi.fn()
    const stopFirst = subscribeAutomation(first), stopSecond = subscribeAutomation(second)
    try {
      useApp.setState({ agentDefs: [...original] })
      expect(first).toHaveBeenCalledTimes(1)
      expect(second).toHaveBeenCalledTimes(1)
      stopFirst()
      useApp.setState({ agentDefs: [...original] })
      expect(first).toHaveBeenCalledTimes(1)
      expect(second).toHaveBeenCalledTimes(2)
    } finally { stopSecond(); useApp.setState({ agentDefs: original }) }
  })
  it('marks the selected rule with the shared active key and clears the marker while drafting', () => {
    useAutomation.getState().setSel({ kind: 'trigger', triggerId: trigger.id })
    expect(source.activeKey!()).toBe(source.items({ group: 'rules' })[0].key)
    useAutomation.getState().openBuilder()
    expect(source.activeKey!()).toBeNull()
  })
})
