// @vitest-environment happy-dom
/**
 * 团队状态条的实时区域(集成遗留 L-5):以前整条 .t2o-bar 是 role=status,头像组(role=img)的可访问名带着
 * 每位成员的工作状态,状态一变读屏就把整条连同成员名单再念一遍。现在只有「人数 · 工作中 / 等审批」那行是 status。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrbitBar } from './OrbitBar'

vi.mock('../../i18n', () => ({ useI18n: () => ({ t: (k: string, v?: Record<string, unknown>) => (v ? `${k}:${Object.values(v).join('|')}` : k) }), registerMessages: () => {} }))
vi.mock('zustand/react/shallow', () => ({ useShallow: (f: unknown) => f }))
vi.mock('../../stores/appStore', () => {
  const state = {
    agentDefs: [{ slug: 'a', name: 'Ann' }, { slug: 'b', name: 'Bo' }], agentAvatars: {}, engines: [], teams: [], defaultAgentSlug: 'a',
    modelsResp: null, setSessionGroup: () => {}, ensureTeamSession: async () => null, setSeedOnce: () => {}, toast: () => {},
    teamWorkBySession: { s1: { a: { status: 'working' }, b: { status: 'waiting' } } },
  }
  return { useApp: (sel: (s: typeof state) => unknown) => sel(state) }
})
vi.mock('../../sessionNav', () => ({ openSession: () => {}, rotateSolo: async () => {} }))
vi.mock('../../components/GroupChatSetup', () => ({ GroupChatSetup: () => null }))
vi.mock('../../components/TeamEditor', () => ({ TeamEditor: () => null }))
vi.mock('../../components/EngineIcon', () => ({ EngineIcon: () => null }))
vi.mock('../../components/AgentAvatar', () => ({ AgentAvatar: () => React.createElement('span', { 'aria-hidden': true }) }))

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

it('头像组不在任何实时区域里;实时区域只有人数 / 工作状态那一行', async () => {
  await act(async () => root.render(React.createElement(OrbitBar, { sessionId: 's1', running: true, cfg: { groupChat: true, groupAgents: ['a', 'b'] } })))
  const avatars = host.querySelector('.t2o-bar-avatars')!
  expect(avatars.getAttribute('role')).toBe('img')
  expect(avatars.getAttribute('aria-label')).toContain('Ann')
  expect(avatars.closest('[role="status"], [aria-live]')).toBeNull()
  const live = [...host.querySelectorAll('[role="status"]')]
  expect(live.map((el) => el.className)).toEqual(['t2o-bar-sub'])
  expect(live[0].textContent).toContain('orbit.bar.working')
})
