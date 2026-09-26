import { beforeEach, expect, it, vi } from 'vitest'
import { useAutomation } from './automationStore'
import { getMuseTriggers } from '../services/backendService'
import type { MuseTriggerInfo, TanguDesktopConfig } from '../types'

vi.mock('../services/backendService', () => ({
  getSpecialConfig: vi.fn(async () => ({ config: null })), getMuseStatus: vi.fn(async () => null),
  getMuseTriggers: vi.fn(async () => []), getAutomationSessions: vi.fn(async () => []),
  getAgentSchedules: vi.fn(async () => []), getAutomationActions: vi.fn(async () => []),
}))
const trigger = { id: 'new-rule', desc: 'Reminder', enabled: false, cond: { type: 'manual' }, actions: [{ type: 'notify', title: 'Hello' }] } as MuseTriggerInfo
beforeEach(() => useAutomation.setState({ triggers: [], sel: null, builder: null, refreshNonce: 0 }))

it('saving a new rule closes the builder and selects its actual returned ID', () => {
  useAutomation.getState().openBuilder(undefined, 'reminder')
  useAutomation.getState().acceptSaved(trigger)
  expect(useAutomation.getState()).toMatchObject({ builder: null, sel: { kind: 'trigger', triggerId: 'new-rule' }, triggers: [trigger] })
})

it('an in-flight old poll cannot erase a newly saved rule', async () => {
  let finish!: (rules: MuseTriggerInfo[]) => void
  vi.mocked(getMuseTriggers).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  const poll = useAutomation.getState().refresh({} as TanguDesktopConfig)
  useAutomation.getState().acceptSaved(trigger)
  finish([])
  await poll
  expect(useAutomation.getState().sel).toEqual({ kind: 'trigger', triggerId: trigger.id })
  expect(useAutomation.getState().triggers).toEqual([trigger])
})

it('a response without the list field keeps the previous list instead of storing undefined', async () => {
  useAutomation.setState({ triggers: [trigger] })
  vi.mocked(getMuseTriggers).mockResolvedValueOnce(undefined as unknown as MuseTriggerInfo[])
  await useAutomation.getState().refresh({} as TanguDesktopConfig)
  expect(useAutomation.getState().triggers).toEqual([trigger])
})
