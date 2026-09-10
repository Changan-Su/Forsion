// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMemoryModal } from './AgentMemoryModal'
import * as api from '../services/backendService'
vi.mock('../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('./AgentMemoryPanel', () => ({ AgentMemoryPanel: () => null }))
vi.mock('../services/backendService', () => ({
  listAgentLogDates: vi.fn(), getAgentLogSnapshot: vi.fn(), putAgentLog: vi.fn(),
  listAgentLibrary: vi.fn(async () => []), getAgentHarness: vi.fn(async () => ({ entries: [], journal: [] })),
}))
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.mocked(api.listAgentLogDates).mockResolvedValue(['2026-09-08'])
  vi.mocked(api.getAgentLogSnapshot).mockResolvedValue({ date: '2026-09-08', content: 'original log', version: 'log-v1' })
  vi.mocked(api.putAgentLog).mockReset().mockRejectedValue(new Error('409: log changed'))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
it('log saves include the loaded version; a conflict leaves the editable draft and never reports saved', async () => {
  const cfg = { backendUrl: 'http://engine', token: 'account' } as any
  await act(async () => root.render(React.createElement(AgentMemoryModal, { cfg, slug: 'alpha', name: 'Alpha', onClose: () => {} })))
  const buttons = () => [...host.querySelectorAll('button')]
  await act(async () => buttons().find((b) => b.textContent === 'settings.agents.tabLog')!.click())
  const textarea = host.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'my log draft')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => buttons().find((b) => b.textContent?.trim() === 'common.save')!.click())
  expect(api.putAgentLog).toHaveBeenCalledWith(cfg, 'alpha', '2026-09-08', 'my log draft', 'log-v1')
  expect(textarea.value).toBe('my log draft')
  expect(host.textContent).toContain('409: log changed')
  expect(host.textContent).not.toContain('settings.agents.memSaved')
})
