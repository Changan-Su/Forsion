// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
vi.mock('../services/backendService', () => ({ getAgentSchedules: vi.fn(async () => []) }))
vi.mock('../services/engine/targets', () => ({ homeTarget: () => ({}) }))
vi.mock('../amadeus/store/dbAggregateStore', () => ({ cellText: String }))
vi.mock('./appStore', async () => { const { create } = await import('zustand'); return { useApp: create(() => ({ cfg: {} })) } })
import { getAgentSchedules } from '../services/backendService'
import { useAgentSchedulePolling } from './agentScheduleStore'
import { useApp } from './appStore'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
it('fetches on first mount, shares polling, refreshes on target config changes and cleans up last consumer', async () => {
  vi.useFakeTimers()
  function Probe() { useAgentSchedulePolling(); return null }
  const roots = [createRoot(document.createElement('div')), createRoot(document.createElement('div'))]
  try {
    await act(async () => { roots[0].render(createElement(Probe)); roots[1].render(createElement(Probe)) })
    expect(getAgentSchedules).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(60000) })
    expect(getAgentSchedules).toHaveBeenCalledTimes(2)
    await act(async () => { useApp.setState({ cfg: { token: 'test' } as any }) })
    expect(getAgentSchedules).toHaveBeenCalledTimes(3)
    await act(async () => roots[0].unmount())
    await act(async () => { vi.advanceTimersByTime(60000) })
    expect(getAgentSchedules).toHaveBeenCalledTimes(4)
    await act(async () => roots[1].unmount())
    await act(async () => { vi.advanceTimersByTime(120000) })
    expect(getAgentSchedules).toHaveBeenCalledTimes(4)
  } finally { vi.useRealTimers() }
})
