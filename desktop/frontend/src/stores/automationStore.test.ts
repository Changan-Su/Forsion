import { beforeEach, expect, it, vi } from 'vitest'
import { suggestionDraft, useAutomation } from './automationStore'
import { getMuseAutomationSuggestions, getMuseTriggers, patchMuseAutomationSuggestion } from '../services/backendService'
import type { MuseAutomationSuggestion, MuseTriggerInfo, TanguDesktopConfig } from '../types'

vi.mock('../services/backendService', () => ({
  getSpecialConfig: vi.fn(async () => ({ config: null })), getMuseStatus: vi.fn(async () => null),
  getMuseTriggers: vi.fn(async () => []), getAutomationSessions: vi.fn(async () => []),
  getAgentSchedules: vi.fn(async () => []), getAutomationActions: vi.fn(async () => []),
  getMuseAutomationSuggestions: vi.fn(async () => []), patchMuseAutomationSuggestion: vi.fn(async () => ({ ok: true })),
}))
const trigger = { id: 'new-rule', desc: 'Reminder', enabled: false, cond: { type: 'manual' }, actions: [{ type: 'notify', title: 'Hello' }] } as MuseTriggerInfo
beforeEach(() => { vi.mocked(patchMuseAutomationSuggestion).mockClear(); useAutomation.setState({ triggers: [], suggestions: [], sel: null, builder: null, refreshNonce: 0 }) })

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

const sugg = (id: string): MuseAutomationSuggestion => ({ id, title: `T ${id}`, why: 'seen', source: { kind: 'muse', label: 'x' },
  rule: { desc: 'Weekly log', cond: { type: 'daily_at', time: '09:00' }, cooldownHours: 0, actions: [{ type: 'notify', title: 'Hi' }] } })

it('a suggestion opens as an unsaved, paused draft and keeps its snapshot when Muse replaces it', async () => {
  useAutomation.setState({ suggestions: [sugg('s1')] })
  useAutomation.getState().openSuggestion('s1')
  expect(useAutomation.getState().builder?.suggestion?.id).toBe('s1')
  expect(suggestionDraft(sugg('s1'))).toMatchObject({ id: '', enabled: false, desc: 'Weekly log', cond: { type: 'daily_at' } })
  await useAutomation.getState().refresh({} as TanguDesktopConfig) // Muse 换掉了这一组
  expect(useAutomation.getState().suggestions).toEqual([])
  expect(useAutomation.getState().builder?.suggestion?.id).toBe('s1')
})

it('saving a suggestion draft marks it used and it does not come back on the next poll', async () => {
  useAutomation.setState({ suggestions: [sugg('s2'), sugg('s3')] })
  useAutomation.getState().openSuggestion('s2')
  useAutomation.getState().acceptSaved(trigger)
  expect(vi.mocked(patchMuseAutomationSuggestion)).toHaveBeenCalledWith(expect.anything(), 's2', 'used')
  vi.mocked(getMuseAutomationSuggestions).mockResolvedValueOnce([sugg('s2'), sugg('s3')]) // 引擎还没收到时的旧快照
  await useAutomation.getState().refresh({} as TanguDesktopConfig)
  expect(useAutomation.getState().suggestions.map((s) => s.id)).toEqual(['s3'])
})

it('a failed dismiss puts the suggestion back; a 409 (already gone) keeps it hidden', async () => {
  useAutomation.setState({ suggestions: [sugg('s4'), sugg('s5')] })
  vi.mocked(patchMuseAutomationSuggestion).mockRejectedValueOnce(Object.assign(new Error('offline'), { status: 500 }))
  await expect(useAutomation.getState().dismissSuggestion('s4', 'timing')).rejects.toThrow('offline')
  expect(useAutomation.getState().suggestions.map((s) => s.id)).toEqual(['s4', 's5'])
  vi.mocked(patchMuseAutomationSuggestion).mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 409 }))
  await useAutomation.getState().dismissSuggestion('s5')
  expect(useAutomation.getState().suggestions.map((s) => s.id)).toEqual(['s4'])
})
