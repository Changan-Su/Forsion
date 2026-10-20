// @vitest-environment happy-dom
/**
 * 首登同步卡排在弹窗队列里(条款卡在前):排队等着时用户在条款卡点了「不同意并退出登录」,
 * 轮到它时不能再弹出来让人开同步(Codex 评审 P2)。负对照:没退出登录,条款卡关掉后照常弹。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const sync = vi.hoisted(() => {
  const subs = new Set<() => void>()
  let snap: Record<string, unknown> | null = null
  return {
    get: () => snap,
    set: (s: Record<string, unknown>) => { snap = s; subs.forEach((f) => f()) },
    subscribe: (f: () => void) => { subs.add(f); return () => subs.delete(f) },
  }
})
vi.mock('../windowKind', () => ({ windowKind: () => 'main' }))
vi.mock('./OnboardingWizard', () => ({ ONBOARDING_DISMISS_KEY: 'test-onboarding-done' }))
vi.mock('../services/accountName', () => ({ watchAccountName: () => () => {} }))
vi.mock('@lcl/engine', () => ({ setActiveSpace: () => {}, useSpaceStore: { getState: () => ({ spaces: [] }) } }))
vi.mock('../services/syncSetup', async (orig) => ({
  wantsSyncCard: ((await orig()) as typeof import('../services/syncSetup')).wantsSyncCard,
  getSync: sync.get, subscribeSync: sync.subscribe,
  startSyncSetup: () => {}, markSyncDecided: () => {}, applySyncChoices: async () => [], openPenzorSync: () => {},
}))

import { SyncSetupHost } from './SyncSetupCard'
import { releasePopup, requestPopup, usePopupQueue } from '../stores/popupQueue'

const snap = (signedIn: boolean) => ({
  signedIn, decided: false,
  notes: { available: true, on: false, running: false, rootName: 'Vault' },
  agents: { on: false }, plugins: { on: false },
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.setItem('test-onboarding-done', '1')
  usePopupQueue.setState({ waiting: [], active: null, blocked: false })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear()
})

async function queuedBehindTerms(): Promise<void> {
  sync.set(snap(true))
  requestPopup('terms', 0)
  await act(async () => root.render(React.createElement(SyncSetupHost)))
  await act(async () => { vi.advanceTimersByTime(2600) })
  expect(usePopupQueue.getState().waiting.map((e) => e.id)).toEqual(['syncSetup']) // 排上了、还没轮到
  expect(host.querySelector('.sync-setup')).toBeNull()
}

it('排队时退出登录:条款卡关掉后同步卡不再弹、也撤出了队列', async () => {
  await queuedBehindTerms()
  await act(async () => sync.set(snap(false)))
  await act(async () => releasePopup('terms'))
  expect(host.querySelector('.sync-setup')).toBeNull()
  expect(usePopupQueue.getState()).toMatchObject({ active: null, waiting: [] })
})

it('负对照:没退出登录,条款卡关掉后同步卡照常弹', async () => {
  await queuedBehindTerms()
  await act(async () => releasePopup('terms'))
  expect(host.querySelector('.sync-setup')).not.toBeNull()
})
