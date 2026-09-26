import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { automationListSource as source, subscribeAutomation } from './automationListSource'
import { useAutomation } from '../../stores/automationStore'
import { useApp } from '../../stores/appStore'
import { useNotifications } from '../../stores/notificationStore'
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
  it('⚠️delete hides the row at once; the engine delete waits until the undo receipt has been on screen, and Undo keeps the rule', async () => {
    vi.useFakeTimers()
    const ntf = useNotifications.getState()
    ntf.dismissAll()
    const del = vi.spyOn(backend, 'deleteMuseTrigger').mockResolvedValue(undefined as never)
    const receipt = () => [...useNotifications.getState().items, ...useNotifications.getState().queue].find((n) => n.dedupeKey?.startsWith('automation.delete:'))
    const titles = () => source.items().map((item) => item.title)
    useAutomation.getState().setSel({ kind: 'trigger', triggerId: trigger.id })
    const action = source.itemMenu!(source.items({ group: 'rules' })[0]).find((a) => a.id === 'delete')!
    expect(action.danger).toBe(true)

    // Undo(NotificationHost 点动作钮 = run + dismiss):永不删,行回来,回执也走了
    action.run()
    expect(titles()).not.toContain('Inventory')
    expect(useAutomation.getState().sel).toBeNull()
    const r = receipt()!
    r.action!.run(); ntf.dismiss(r.id)
    vi.advanceTimersByTime(10_000)
    expect(del).not.toHaveBeenCalled()
    expect(receipt()).toBeUndefined()
    expect(titles()).toContain('Inventory')

    // 通知栈满:回执排队,没上屏就不计时
    for (let i = 0; i < 4; i++) ntf.notify({ text: `busy ${i}`, sticky: true })
    action.run()
    vi.advanceTimersByTime(20_000)
    expect(del).not.toHaveBeenCalled()
    for (const n of useNotifications.getState().items.filter((x) => x.text.startsWith('busy'))) ntf.dismiss(n.id)

    // 上屏后悬停暂停:照样不删;移开后走完剩余时长才删
    ntf.pause()
    vi.advanceTimersByTime(20_000)
    expect(del).not.toHaveBeenCalled()
    ntf.resume()
    vi.advanceTimersByTime(4999)
    expect(del).not.toHaveBeenCalled()
    const nonce = useAutomation.getState().refreshNonce
    vi.advanceTimersByTime(1)
    expect(del).toHaveBeenCalledWith(expect.anything(), trigger.id)
    expect(receipt()).toBeUndefined()
    await vi.waitFor(() => expect(useAutomation.getState().refreshNonce).toBeGreaterThanOrEqual(nonce + 2)) // 删完 bump + 落定 bump
    expect(titles()).not.toContain('Inventory') // 删掉了就一直藏着,不等下一次拉取
  })
})
