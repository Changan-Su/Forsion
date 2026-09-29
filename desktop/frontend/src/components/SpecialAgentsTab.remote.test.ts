// @vitest-environment happy-dom
/**
 * P1-K10b(INTEGRATION §4 G3):引擎对远程来源的 GET /agent/special/config 只回开关摘要 + remote:true。
 * 设备页的 home 就是那台电脑的引擎,设置页「后台 Agent」拿到的是这份摘要:要显示「只能在那台电脑上设置」+ 两个开关状态,
 * 不能把摘要当整份配置去读 allowedFolders.join(那样会落进「暂时无法读取」的错误态),也不渲染写不进去的编辑器。
 * 本机回包(整份配置)照旧渲染编辑器 —— 正对照。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpecialAgentsTab } from './SpecialAgentsTab'
import * as api from '../services/backendService'
import type { SpecialAgentsConfig } from '../types'

vi.mock('../i18n', () => ({ registerMessages: () => {}, useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../stores/appStore', () => ({ useApp: { getState: () => ({ refreshSpecialEnabled: vi.fn() }) } }))
vi.mock('../services/accountQuota', () => ({ publishAccountQuota: vi.fn(), subscribeAccountQuota: vi.fn(() => () => {}) }))
vi.mock('../services/backendService', () => ({
  getSpecialConfig: vi.fn(), saveSpecialConfig: vi.fn(), listModels: vi.fn(async () => ({ models: [] })), listAgents: vi.fn(async () => []),
}))

const FULL: SpecialAgentsConfig = {
  historian: { enabled: true, modelId: '', everyRounds: 3, firstRoundTrigger: true, mode: 'independent', prompt: '', harnessCandidates: true },
  muse: {
    enabled: false, modelId: '', restartWindowHours: 1, maxRestartsPerWindow: 3, maxIterationsPerCycle: 20, maxTodosPerWindow: 5,
    supervisorPollMinutes: 5, activeHours: null, allowedFolders: ['/Users/me/notes'], mode: 'ask', heartbeatMinutes: 120, notify: 'immediate', escalateTo: '',
  },
}
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
const render = async () => {
  await act(async () => root.render(React.createElement(SpecialAgentsTab, { cfg: { backendUrl: 'http://engine', token: 't' } as any })))
}

describe('SpecialAgentsTab · 远程来源的摘要', () => {
  it('remote:true → 只读说明 + 两个开关状态;没有编辑器、没有保存栏、没有错误态', async () => {
    vi.mocked(api.getSpecialConfig).mockResolvedValue({ config: { historian: { enabled: true, everyRounds: 7 }, muse: { enabled: false, supervisorPollMinutes: 11 } }, remote: true })
    await render()
    expect(host.textContent).toContain('specialUi.remoteOnly')
    expect(host.textContent).not.toContain('specialUi.loadFailed')
    const statuses = [...host.querySelectorAll('.special-agent-status')]
    expect(statuses.map((s) => s.querySelector('strong')?.textContent)).toEqual(['settings.special.historian', 'settings.special.muse'])
    expect(statuses.map((s) => s.querySelector('i')?.textContent)).toEqual(['settings.special.on', 'settings.special.off'])
    expect(statuses[0].querySelector('i')?.className).toBe('on')
    expect(host.querySelector('.special-editor')).toBeNull()
    expect(host.querySelector('.special-save')).toBeNull()
    expect(host.querySelector('textarea')).toBeNull()
    expect(host.querySelectorAll('button')).toHaveLength(0) // 不可点:远端写不进去,不给任何可操作控件
  })

  it('本机整份配置 → 照旧渲染编辑器(正对照)', async () => {
    vi.mocked(api.getSpecialConfig).mockResolvedValue({ config: FULL, defaults: { historianPrompt: 'default prompt' } })
    await render()
    expect(host.textContent).not.toContain('specialUi.remoteOnly')
    expect(host.querySelector('.special-editor')).not.toBeNull()
    expect(host.querySelector('.special-agent-status')).toBeNull()
    expect(host.querySelectorAll('.special-agent-nav > button')).toHaveLength(2)
  })
})
