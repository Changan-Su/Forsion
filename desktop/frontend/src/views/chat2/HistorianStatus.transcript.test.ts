// @vitest-environment happy-dom
/**
 * Historian「查看完整记录」入口的重试(Codex 第一轮 B1-3):展开后第一次查 /background 失败、或子会话还没建,
 * 以前只在记录数 / 运行态变化时再查 —— 这些值不变,入口就一直缺席(右栏又已把 Historian 行藏了)。
 * 现在没找到就定时重查,找到即停;收起时清掉定时器。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '../../services/backendService'
import { HistorianStatus, TRANSCRIPT_RETRY_MS } from './HistorianStatus'

vi.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }), registerMessages: () => {} }))
vi.mock('../../stores/appStore', () => {
  const state = { cfg: { backendUrl: 'http://engine', token: 't' }, connState: 'ok' }
  const useApp = (sel: (s: typeof state) => unknown) => sel(state)
  useApp.getState = () => state
  return { useApp }
})
vi.mock('../../stores/notificationStore', () => ({ notifyApp: vi.fn() }))
vi.mock('../../stores/notificationWiring', () => ({ takeFreshNominations: (items: unknown[]) => ({ fresh: [], seen: new Set(items.map(String)) }) }))
vi.mock('../../stores/childChatStore', () => ({ useChildChat: { getState: () => ({ open: vi.fn() }) } }))
vi.mock('../../components/Markdown', () => ({ Markdown: () => null }))
vi.mock('../agentProfileNav', () => ({ openAgentProfile: vi.fn() }))
vi.mock('../../services/backendService', () => ({
  getBackgroundSessions: vi.fn(),
  getSessionHistorian: vi.fn(async () => ({ running: false, records: [], activity: [] })),
}))

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks() })

const transcriptButton = () => host.querySelector('[data-historian-transcript]')
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

it('一次查询失败后照样定时重试,子会话出现即露出入口,然后不再查', async () => {
  const bg = vi.mocked(api.getBackgroundSessions)
  bg.mockRejectedValueOnce(new Error('503'))
    .mockResolvedValueOnce([])
    .mockResolvedValue([{ sessionId: 'hist-1', kind: 'historian', title: 'Historian', createdAt: '', runId: null, runStatus: null }])
  await act(async () => root.render(React.createElement(HistorianStatus, { sessionId: 's1' })))
  await act(async () => (host.querySelector('button.t2o-desk-row') as HTMLButtonElement).click())
  await flush()
  expect(bg).toHaveBeenCalledTimes(1)
  expect(transcriptButton()).toBeNull()
  await flush(TRANSCRIPT_RETRY_MS) // 第二次:还没建
  expect(bg).toHaveBeenCalledTimes(2)
  expect(transcriptButton()).toBeNull()
  await flush(TRANSCRIPT_RETRY_MS) // 第三次:找到了
  expect(bg).toHaveBeenCalledTimes(3)
  expect(transcriptButton()).not.toBeNull()
  await flush(TRANSCRIPT_RETRY_MS * 3)
  expect(bg).toHaveBeenCalledTimes(3) // 找到即停
})

it('收起后不再重试', async () => {
  const bg = vi.mocked(api.getBackgroundSessions)
  bg.mockResolvedValue([])
  await act(async () => root.render(React.createElement(HistorianStatus, { sessionId: 's1' })))
  const row = () => host.querySelector('button.t2o-desk-row') as HTMLButtonElement
  await act(async () => row().click())
  await flush()
  expect(bg).toHaveBeenCalledTimes(1)
  await act(async () => row().click()) // 收起
  await flush(TRANSCRIPT_RETRY_MS * 3)
  expect(bg).toHaveBeenCalledTimes(1)
})
