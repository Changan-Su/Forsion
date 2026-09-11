// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMemoryPanel } from './AgentMemoryPanel'
import * as api from '../services/backendService'
import type { AgentMemorySnapshot } from '../services/backendService'

vi.mock('../i18n', () => ({ registerMessages: () => {}, useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../services/backendService', () => ({
  getAgentMemorySnapshot: vi.fn(), putAgentMemory: vi.fn(), mutateAgentMemoryEntry: vi.fn(), listAgentMemoryRevisions: vi.fn(), restoreAgentMemory: vi.fn(),
  getAgentMemoryDream: vi.fn(), configureAgentMemoryDream: vi.fn(), startAgentMemoryDream: vi.fn(), cancelAgentMemoryDream: vi.fn(),
}))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const snapshot = (content = 'Agent A fact', version = 'v1'): AgentMemorySnapshot => ({ version, content, updatedAt: 1000, tombstones: [],
  entries: [{ id: 'fact-1', content, source: { kind: 'explicit', messageId: 'source-1' }, evidenceIds: ['source-1'], createdAt: 1000, updatedAt: 1000 }] })
const dream = { config: { enabled: false, modelId: '', timeoutMs: 60_000, maxOutputTokens: 4096, intervalHours: 6 }, status: { state: 'idle' as const, running: false }, candidates: 0 }
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  vi.mocked(api.getAgentMemorySnapshot).mockResolvedValue(snapshot())
  vi.mocked(api.getAgentMemoryDream).mockResolvedValue(dream)
  vi.mocked(api.listAgentMemoryRevisions).mockResolvedValue([])
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
const cfg = { backendUrl: 'http://backend-a', token: 'account-a' } as any
async function render(slug = 'alpha', config = cfg) {
  await act(async () => root.render(React.createElement(AgentMemoryPanel, { slug, cfg: config })))
}
function button(key: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((element) => element.textContent?.trim() === key)
  expect(found, `missing ${key}`).toBeTruthy(); return found!
}
async function click(key: string) { await act(async () => button(key).click()) }
async function setText(label: string, value: string) {
  const textarea = host.querySelector(`textarea[aria-label="${label}"]`) as HTMLTextAreaElement
  expect(textarea).toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
describe('Agent memory management', () => {
  it('discloses explicit shared-default scope and the non-erasure meaning of forgetting', async () => {
    await act(async () => root.render(React.createElement(AgentMemoryPanel, { slug: 'alpha', cfg, shareDefaultMemory: true })))
    expect(host.textContent).toContain('agentMemory.sharedHint')
    expect(host.textContent).not.toContain('agentMemory.dreamHint')
    expect(host.textContent).toContain('agentMemory.forgetHint')
  })
  it('late responses from a previous Agent/backend/account cannot paint or enable writes in the new identity', async () => {
    const old = deferred<AgentMemorySnapshot>()
    vi.mocked(api.getAgentMemorySnapshot).mockReturnValueOnce(old.promise)
    await render()
    await render('beta', { ...cfg, backendUrl: 'http://backend-b', token: 'account-b' })
    expect(host.querySelector('[data-agent-slug="beta"]')).toBeTruthy()
    await act(async () => old.resolve(snapshot('OLD_ACCOUNT_SECRET')))
    expect(host.textContent).not.toContain('OLD_ACCOUNT_SECRET')
    await click('agentMemory.forget')
    expect(api.mutateAgentMemoryEntry).toHaveBeenCalledWith(expect.objectContaining({ token: 'account-b' }), 'beta',
      { action: 'forget', id: 'fact-1', expectedVersion: 'v1' })
  })
  it('read failures are visible and never become editable empty memory', async () => {
    vi.mocked(api.getAgentMemorySnapshot).mockRejectedValueOnce(new Error('EIO: storage unavailable'))
    await render()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('EIO')
    expect(host.querySelector('textarea[aria-label="agentMemory.document"]')).toBeNull()
    expect(api.putAgentMemory).not.toHaveBeenCalled()
    await click('agentMemory.reload')
    expect(host.querySelector('textarea[aria-label="agentMemory.document"]')).toBeTruthy()
  })
  it('a 409 preserves the raw draft and its original version; refresh exposes the newer version without replacing it', async () => {
    vi.mocked(api.putAgentMemory).mockRejectedValue(new Error('409: Memory changed since it was read'))
    await render()
    await setText('agentMemory.document', 'MY_UNSAVED_DRAFT')
    // The raw editor's save button is the last save button when no entry is being edited.
    const saves = [...host.querySelectorAll('button')].filter((element) => element.textContent === 'common.save')
    await act(async () => saves.at(-1)!.click())
    expect(api.putAgentMemory).toHaveBeenCalledWith(cfg, 'alpha', 'MY_UNSAVED_DRAFT', 'v1')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('409')
    vi.mocked(api.getAgentMemorySnapshot).mockResolvedValue(snapshot('NEW_SERVER_FACT', 'v2'))
    await click('agentMemory.reload')
    expect((host.querySelector('textarea[aria-label="agentMemory.document"]') as HTMLTextAreaElement).value).toBe('MY_UNSAVED_DRAFT')
    expect(host.textContent).toContain('agentMemory.changed')
  })
  it('rapid duplicate forget clicks issue one versioned write, and a failed write is never shown as saved', async () => {
    const write = deferred<AgentMemorySnapshot>()
    vi.mocked(api.mutateAgentMemoryEntry).mockReturnValue(write.promise)
    await render()
    const forget = button('agentMemory.forget')
    await act(async () => { forget.click(); forget.click() })
    expect(api.mutateAgentMemoryEntry).toHaveBeenCalledTimes(1)
    expect(forget.disabled).toBe(true)
    await act(async () => write.reject(new Error('409 conflict')))
    expect(host.textContent).not.toContain('agentMemory.saved')
    expect(host.textContent).toContain('409 conflict')
  })
})
