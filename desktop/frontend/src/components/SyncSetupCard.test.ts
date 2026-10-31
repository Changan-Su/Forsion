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
const spy = vi.hoisted(() => ({ decided: vi.fn(), setSync: vi.fn(async () => ({ ok: true })), focus: vi.fn() }))
vi.mock('../windowKind', () => ({ windowKind: () => 'main' }))
vi.mock('./OnboardingWizard', () => ({ ONBOARDING_DISMISS_KEY: 'test-onboarding-done' }))
vi.mock('../services/accountName', () => ({ watchAccountName: () => () => {} }))
vi.mock('@lcl/engine', () => ({ setActiveSpace: () => {}, useSpaceStore: { getState: () => ({ spaces: [] }) } }))
vi.mock('../services/syncSetup', async (orig) => ({
  wantsSyncCard: ((await orig()) as typeof import('../services/syncSetup')).wantsSyncCard,
  getSync: sync.get, subscribeSync: sync.subscribe,
  startSyncSetup: () => {}, markSyncDecided: spy.decided, setSync: spy.setSync, applySyncChoices: async () => [], openPenzorSync: spy.focus,
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

// 新同步那版(2026-10-23 蓬洲云同步简化):四类勾选、Extend 给预览、开始 = 拿凭据确认
const content = (setup: (picks: Record<string, boolean>) => unknown) => {
  const invoke = vi.fn(async (ch: string, arg?: unknown) => {
    if (ch === 'penzor:sync:get') return { ok: true, value: { sources: [{ path: 'Amadeus', size: 2048, files: 12 }, { path: 'agents/research', size: 1 }, { path: 'agents/writing', size: 1 }] } }
    if (ch === 'penzor:sync:setup') return setup(arg as Record<string, boolean>)
    return { ok: true, value: undefined }
  })
  vi.stubGlobal('tangu', { cloudInvoke: invoke })
  return invoke
}
async function openContent(): Promise<void> {
  sync.set({ ...snap(true), contentRules: true })
  await act(async () => root.render(React.createElement(SyncSetupHost)))
  await act(async () => { vi.advanceTimersByTime(2600) })
}
const btn = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === name)!

it('新同步:四类默认勾上,取消一类会重新预览,开始同步拿凭据确认', async () => {
  spy.decided.mockClear(); spy.setSync.mockClear()
  const invoke = content((p) => ({ ok: true, value: { token: `t-${Object.values(p).filter(Boolean).length}`, upload: 12, download: 0, bytes: 2048 } }))
  await openContent()
  const boxes = [...host.querySelectorAll<HTMLInputElement>('.sync-setup-row input')]
  expect(boxes.map((b) => b.checked)).toEqual([true, true, true, true])
  expect(host.textContent).toContain('2 个 Agent')
  expect(host.textContent).toContain('将上传 12 个文件')
  await act(async () => { boxes[2]!.click() })
  expect(invoke).toHaveBeenLastCalledWith('penzor:sync:setup', { notes: true, agents: true, profile: false, plugins: true })
  await act(async () => { btn('开始同步').click() })
  expect(invoke).toHaveBeenCalledWith('penzor:sync:apply', 't-3')
  expect(spy.setSync).toHaveBeenCalledWith('plugins', true)
  expect(spy.decided).toHaveBeenCalled()
  expect(host.querySelector('.sync-setup')).toBeNull()
})

it('新同步:这台已经开过(setup 回 null)就不弹', async () => {
  spy.decided.mockClear()
  content(() => ({ ok: true, value: null }))
  await openContent()
  expect(host.querySelector('.sync-setup')).toBeNull()
  expect(spy.decided).toHaveBeenCalled()
})

it('新同步:老 Extend 没有 setup 通道时退回「选择同步范围」', async () => {
  content(() => { throw new Error('not a Forsion Extend channel: penzor:sync:setup') })
  await openContent()
  expect(btn('选择同步范围')).toBeTruthy()
})
