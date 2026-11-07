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
const AGENT_SOURCES = [{ path: 'agents/research', size: 1, agent: true, name: '论文助手' }, { path: 'agents/muse', size: 1, agent: true, name: 'Muse' }, { path: 'agents/writing', size: 1, agent: true },
  { path: 'agents/historian-0b89aa950a0d', size: 1 }, { path: 'agents/qinche.backup-20261024', size: 1 }]
const content = (setup: (picks: Record<string, unknown>) => unknown, agents: unknown[] = AGENT_SOURCES) => {
  const invoke = vi.fn(async (ch: string, arg?: unknown) => {
    if (ch === 'penzor:sync:get') return { ok: true, value: { sources: [{ path: 'Amadeus', size: 2048, files: 12 }, ...agents] } }
    if (ch === 'penzor:sync:setup') return setup(arg as Record<string, unknown>)
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

it('新同步:三类默认勾上、Agents 一个都不勾;逐个勾、取消一类都会重新预览,开始同步拿凭据确认', async () => {
  spy.decided.mockClear(); spy.setSync.mockClear()
  const invoke = content((p) => ({ ok: true, value: { token: `t-${['notes', 'profile', 'plugins'].filter((k) => p[k]).length}-${(p.agentSlugs as string[]).join('+')}`, upload: 12, download: 0, bytes: 2048 } }))
  await openContent()
  const rows = () => [...host.querySelectorAll<HTMLInputElement>('.sync-setup-row > input')].map((b) => b.checked)
  expect(rows()).toEqual([true, false, true, true]) // 笔记、Agents(只显示勾了几个)、我的资料、插件
  expect(host.textContent).toContain('逐个选，默认一个都不同步')
  // 只列真 Agent,卜算子排最后、灰着勾不了;historian 临时目录、手动备份不出现
  const kids = () => [...host.querySelectorAll<HTMLElement>('.sync-setup-kid')]
  expect(kids().map((k) => [k.dataset.agent, k.querySelector('input')!.checked, k.querySelector('input')!.disabled])).toEqual([['research', false, false], ['writing', false, false], ['muse', false, true]])
  expect(kids()[0]!.textContent).toContain('论文助手'); expect(kids()[2]!.textContent).toContain('卜算子'); expect(kids()[2]!.textContent).toContain('暂不开放同步')
  expect(invoke).toHaveBeenLastCalledWith('penzor:sync:setup', { notes: true, profile: true, plugins: true, agents: false, agentSlugs: [] })
  expect(host.textContent).toContain('将上传 12 个文件')
  // 点 Agents 那一项的勾:不全选
  await act(async () => { host.querySelector<HTMLElement>('[data-testid="sync-setup-agents"] .sync-setup-copy b')!.click() })
  expect(kids().map((k) => k.querySelector('input')!.checked)).toEqual([false, false, false])
  await act(async () => { kids()[0]!.querySelector('input')!.click() })
  expect(rows()[1]).toBe(true) // 勾了一个,Agents 那一项就算勾上
  expect(invoke).toHaveBeenLastCalledWith('penzor:sync:setup', { notes: true, profile: true, plugins: true, agents: false, agentSlugs: ['research'] })
  await act(async () => { kids()[2]!.querySelector('input')!.click() }) // 卜算子点不动
  expect(invoke).toHaveBeenLastCalledWith('penzor:sync:setup', { notes: true, profile: true, plugins: true, agents: false, agentSlugs: ['research'] })
  await act(async () => { host.querySelectorAll<HTMLInputElement>('.sync-setup-row > input')[2]!.click() })
  expect(invoke).toHaveBeenLastCalledWith('penzor:sync:setup', { notes: true, profile: false, plugins: true, agents: false, agentSlugs: ['research'] })
  await act(async () => { btn('开始同步').click() })
  expect(invoke).toHaveBeenCalledWith('penzor:sync:apply', 't-2-research')
  expect(spy.setSync).toHaveBeenCalledWith('plugins', true)
  expect(spy.decided).toHaveBeenCalled()
  expect(host.querySelector('.sync-setup')).toBeNull()
})

it('新同步:本机没有 Agent(或老 Extend 不标真 Agent)时 Agents 这一项不出现', async () => {
  content(() => ({ ok: true, value: { token: 't', upload: 1, download: 0, bytes: 1 } }), [{ path: 'agents/research', size: 1 }, { path: 'agents/historian-0b89aa950a0d', size: 1 }])
  await openContent()
  expect(host.querySelector('[data-testid="sync-setup-agents"]')).toBeNull()
  expect([...host.querySelectorAll('.sync-setup-row > input')]).toHaveLength(3)
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

it('新同步:勾的 Agent 云端已有一份且不一样,卡片里问一次(缺省合在一起),选择随开始同步交给 Extend(11-06)', async () => {
  const at = new Date(2026, 10, 3, 14, 2).getTime()
  const invoke = content((p) => ({ ok: true, value: { token: 't-ask', upload: 1, download: 1, bytes: 10,
    ...((p.agentSlugs as string[]).includes('research') ? { agentAsks: [{ slug: 'research', namespace: 'default', cloudFiles: 3, localFiles: 2, differ: 1, cloudMtime: at, localMtime: at + 86_400_000 }] } : {}) } }))
  await openContent()
  expect(host.querySelector('[data-testid="sync-setup-asks"]')).toBeNull() // 没勾的不问
  await act(async () => { host.querySelector<HTMLInputElement>('.sync-setup-kid[data-agent="research"] input')!.click() })
  const ask = host.querySelector<HTMLElement>('[data-testid="sync-setup-asks"]')!
  expect(ask.textContent).toContain('论文助手 在云端已经有一份'); expect(ask.textContent).toContain('回收在 agents/.removed，能找回')
  const radios = () => [...ask.querySelectorAll<HTMLInputElement>('.sync-setup-opt input')]
  expect(radios().map((r) => r.checked)).toEqual([true, false, false])
  await act(async () => { radios()[2]!.click() })
  await act(async () => { btn('开始同步').click() })
  expect(invoke).toHaveBeenCalledWith('penzor:sync:apply', 't-ask', { research: 'local' })
})
