// @vitest-environment happy-dom
/**
 * Agents 同步先封住(2026-11-27 智库同步统一方案第 0 步):设置 › Agents 里每个 Agent 的「云同步」锁住写「暂不同步」,
 * 列表行的云图标点不了;保存 Agent 时请求里不带 cloudSync(引擎那边封着也不收,这里连发都不发)。
 * 负对照:AGENT_SYNC_SEALED 改回 false 时这一条红(勾和行按钮回来、保存带 cloudSync)。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ saveAgentDef: vi.fn(async (_t: unknown, body: Record<string, unknown>) => body) }))
vi.mock('../services/backendService', () => ({
  listAgents: vi.fn(async () => [{ slug: 'writer', name: 'Writer', description: '', model: '', systemPrompt: 'Write well', cloudSync: true, shareDefaultMemory: false }]),
  saveAgentDef: api.saveAgentDef, deleteAgentDef: vi.fn(), listModels: vi.fn(async () => ({ models: [] })),
  uploadAgentAvatar: vi.fn(), fetchAgentAvatar: vi.fn(async () => null), deleteAgentAvatar: vi.fn(),
  getAgentsMeta: vi.fn(async () => ({ defaultSlug: 'xyra' })), putAgentsMeta: vi.fn(), getUserProfile: vi.fn(async () => 'profile'), putUserProfile: vi.fn(),
  fetchToolCatalog: vi.fn(async () => []),
}))
vi.mock('@lcl/engine', () => ({ useWorkspace: { getState: () => ({ openView: vi.fn() }) } }))
vi.mock('../stores/appStore', () => ({ useApp: { getState: () => ({}) } }))
vi.mock('../achievements/store', () => ({ track: vi.fn() }))
vi.mock('../activity/log', () => ({ act: vi.fn() }))
vi.mock('./AgentMemoryModal', () => ({ AgentMemoryModal: () => null }))

import { AgentsTab } from './AgentsTab'
import { translate } from '../i18n'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('tangu', { authStatus: async () => ({ loggedIn: true }) })
  api.saveAgentDef.mockClear()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })

it('the per-agent cloud sync is locked as "not syncing for now" and saving sends no cloudSync', async () => {
  await act(async () => root.render(React.createElement(AgentsTab, { cfg: {} as any })))
  await flush()
  const rowBtn = host.querySelector<HTMLButtonElement>('button[data-agent-sync-sealed]')!
  expect(rowBtn.disabled).toBe(true)
  expect(rowBtn.title).toBe(translate('settings.agents.cloudSyncSealed'))
  await act(async () => host.querySelector<HTMLButtonElement>(`button[title="${translate('common.edit')}"]`)!.click())
  const field = host.querySelector<HTMLElement>('[data-agent-sync-sealed].field')!
  expect(field.textContent).toContain(translate('sync.sealed'))
  expect(field.querySelector('input')).toBeNull()
  const save = [...host.querySelectorAll<HTMLButtonElement>('button.btn.primary')].find((b) => !b.disabled)!
  await act(async () => save.click())
  await flush()
  expect(api.saveAgentDef).toHaveBeenCalledTimes(1)
  expect(api.saveAgentDef.mock.calls[0]![1]).not.toHaveProperty('cloudSync')
  expect(api.saveAgentDef.mock.calls[0]![1]).toMatchObject({ shareDefaultMemory: false, systemPrompt: 'Write well' })
})
