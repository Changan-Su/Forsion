// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OnboardingBackgroundAgents } from './OnboardingBackgroundAgents'
import * as api from '../services/backendService'
import type { EngineTarget } from '../services/engine/targets'
import type { SpecialAgentsConfig } from '../types'

vi.mock('../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../services/backendService', () => ({ getSpecialConfig: vi.fn(), saveSpecialConfig: vi.fn() }))
const refresh = vi.hoisted(() => vi.fn())
vi.mock('../stores/appStore', () => ({ useApp: { getState: () => ({ refreshSpecialEnabled: refresh }) } }))

const config: SpecialAgentsConfig = {
  historian: { enabled: true, modelId: 'historian-model', everyRounds: 7, firstRoundTrigger: true, autoEmoji: false, mode: 'independent', prompt: 'Keep me', harnessCandidates: true },
  muse: { enabled: true, modelId: 'muse-model', restartWindowHours: 1, maxRestartsPerWindow: 3, maxIterationsPerCycle: 20, maxTodosPerWindow: 5,
    supervisorPollMinutes: 5, activeHours: { start: 9, end: 17 }, allowedFolders: ['/my/project'], mode: 'ask', heartbeatMinutes: 120, notify: 'digest', escalateTo: '' },
}
const target = { key: 'home' } as unknown as EngineTarget
const resolveTarget = vi.fn(async () => target)
const busy = vi.fn()
let host: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks()
  vi.mocked(api.getSpecialConfig).mockResolvedValue({ config })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
async function render() {
  await act(async () => root.render(React.createElement(OnboardingBackgroundAgents, { resolveTarget, onBusyChange: busy })))
}
const toggle = (name: string) => host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${name}"]`)!
const click = async (name: string) => act(async () => toggle(name).click())

it('loads the current connection and retains previously disabled agents on re-entry', async () => {
  vi.mocked(api.getSpecialConfig).mockResolvedValue({ config: { historian: { ...config.historian, enabled: false }, muse: { ...config.muse, enabled: false } } })
  await render()
  expect(resolveTarget).toHaveBeenCalledOnce()
  expect(api.getSpecialConfig).toHaveBeenCalledWith(target)
  expect(toggle('Historian').getAttribute('aria-checked')).toBe('false')
  expect(toggle('Muse').getAttribute('aria-checked')).toBe('false')
  expect(api.saveSpecialConfig).not.toHaveBeenCalled()
})
it('turns each default-enabled agent off immediately using only its enabled field', async () => {
  let saved = structuredClone(config)
  vi.mocked(api.saveSpecialConfig).mockImplementation(async (_target, patch) => {
    saved = { historian: { ...saved.historian, ...patch.historian }, muse: { ...saved.muse, ...patch.muse } }
    return saved
  })
  await render()
  expect(toggle('Historian').getAttribute('aria-checked')).toBe('true')
  expect(toggle('Muse').getAttribute('aria-checked')).toBe('true')
  await click('Historian'); await click('Muse')
  expect(api.saveSpecialConfig).toHaveBeenNthCalledWith(1, target, { historian: { enabled: false } })
  expect(api.saveSpecialConfig).toHaveBeenNthCalledWith(2, target, { muse: { enabled: false } })
  expect(saved.historian).toEqual({ ...config.historian, enabled: false })
  expect(saved.muse).toEqual({ ...config.muse, enabled: false })
  expect(refresh).toHaveBeenCalledTimes(2)
  expect(busy.mock.calls).toEqual([[true], [false], [true], [false]])
})
it('keeps the saved value after a failed write and allows retry', async () => {
  vi.mocked(api.saveSpecialConfig).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ...config, historian: { ...config.historian, enabled: false } })
  await render(); await click('Historian')
  expect(toggle('Historian').getAttribute('aria-checked')).toBe('true')
  expect(host.querySelector('[role="alert"]')).not.toBeNull()
  expect(refresh).not.toHaveBeenCalled()
  expect(busy).toHaveBeenLastCalledWith(false)
  await click('Historian')
  expect(toggle('Historian').getAttribute('aria-checked')).toBe('false')
  expect(host.querySelector('[role="alert"]')).toBeNull()
})
it('blocks both toggles and navigation while an enable change is in flight', async () => {
  let complete!: (value: SpecialAgentsConfig) => void
  vi.mocked(api.saveSpecialConfig).mockReturnValue(new Promise((resolve) => { complete = resolve }))
  await render(); await click('Muse')
  expect(toggle('Historian').disabled).toBe(true)
  expect(toggle('Muse').disabled).toBe(true)
  expect(busy).toHaveBeenLastCalledWith(true)
  await click('Historian')
  expect(api.saveSpecialConfig).toHaveBeenCalledOnce()
  await act(async () => complete({ ...config, muse: { ...config.muse, enabled: false } }))
  expect(toggle('Muse').getAttribute('aria-checked')).toBe('false')
  expect(toggle('Historian').disabled).toBe(false)
  expect(busy).toHaveBeenLastCalledWith(false)
})
it('retries a failed load without exposing active switches or inventing default values', async () => {
  vi.mocked(api.getSpecialConfig).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ config })
  await render()
  expect(toggle('Historian').disabled).toBe(true)
  expect(toggle('Muse').disabled).toBe(true)
  expect(host.textContent).toContain('onboarding.background.loadFail')
  await act(async () => host.querySelector<HTMLButtonElement>('.ob-background-error button')!.click())
  expect(toggle('Historian').getAttribute('aria-checked')).toBe('true')
  expect(toggle('Muse').disabled).toBe(false)
})
it('honors the remote read-only projection', async () => {
  vi.mocked(api.getSpecialConfig).mockResolvedValue({ remote: true, config: { historian: { enabled: true, everyRounds: 3 }, muse: { enabled: false, supervisorPollMinutes: 5 } } })
  await render(); await click('Historian')
  expect(toggle('Historian').disabled).toBe(true)
  expect(toggle('Muse').disabled).toBe(true)
  expect(host.textContent).toContain('onboarding.background.remote')
  expect(api.saveSpecialConfig).not.toHaveBeenCalled()
})
it('allows cloud Historian configuration while explaining that Muse requires a local engine', async () => {
  vi.mocked(api.getSpecialConfig).mockResolvedValue({ config, cloud: true })
  await render(); await click('Muse')
  expect(toggle('Historian').disabled).toBe(false)
  expect(toggle('Muse').disabled).toBe(true)
  expect(host.textContent).toContain('onboarding.background.localOnly')
  expect(api.saveSpecialConfig).not.toHaveBeenCalled()
})
