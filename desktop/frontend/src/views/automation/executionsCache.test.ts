// @vitest-environment happy-dom
/**
 * 执行账本缓存的作用域(Codex 第一轮 D-2):以前按 cfg 对象引用分桶,别处改个默认模型 appStore 就换新 cfg,
 * 回到记录页又闪骨架。现在按「连接 + 账号」分桶:改模型不换桶,换后端 / 令牌 / 账号才换。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../services/backendService'
import { ExecutionsList, executionsScope } from './AutomationRunsView'

const state = vi.hoisted(() => ({ cfg: { backendUrl: 'http://engine', token: 't', modelId: 'm1' } as Record<string, string>, authInfo: { accountId: 'u1' } as { accountId: string } | null }))
vi.mock('../../stores/appStore', () => ({ useApp: (sel: (s: typeof state) => unknown) => sel(state) }))
vi.mock('../../stores/automationStore', () => ({ useAutomation: (sel: (s: { refreshNonce: number }) => unknown) => sel({ refreshNonce: 0 }), sessionForTrigger: () => null }))
vi.mock('../../services/backendService', () => ({ getAutomationExecutions: vi.fn(), getAutomationRuns: vi.fn(), getHistorianActivity: vi.fn() }))
vi.mock('../../i18n', () => ({ useI18n: () => ({ t: (k: string) => k }), registerMessages: () => {} }))
vi.mock('@lcl/engine', () => ({ Skeleton: () => React.createElement('i', { className: 'sk' }) }))
vi.mock('./messages', () => ({}))
vi.mock('./automation.css', () => ({}))

describe('executionsScope', () => {
  it('只认连接与账号:改默认模型不换桶', () => {
    const a = executionsScope({ backendUrl: 'http://engine/', token: 't' }, 'u1')
    expect(executionsScope({ backendUrl: 'http://engine', token: 't' }, 'u1')).toBe(a)
    expect(executionsScope({ backendUrl: 'http://other', token: 't' }, 'u1')).not.toBe(a)
    expect(executionsScope({ backendUrl: 'http://engine', token: 't2' }, 'u1')).not.toBe(a)
    expect(executionsScope({ backendUrl: 'http://engine', token: 't' }, 'u2')).not.toBe(a)
  })
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

it('改了默认模型(cfg 换了新对象)后回到记录页:先画缓存,不出骨架', async () => {
  const exec = { id: 'e1', status: 'done', origin: 'manual', created_at: '2026-09-25T10:00:00Z', steps: [], error: null }
  vi.mocked(api.getAutomationExecutions).mockResolvedValue([exec] as never)
  await act(async () => root.render(React.createElement(ExecutionsList, { triggerId: 'tr-1' })))
  expect(host.querySelector('.auto-executions')).not.toBeNull()
  await act(async () => root.unmount())
  root = createRoot(host)
  state.cfg = { ...state.cfg, modelId: 'm2' } // appStore 换了一个新 cfg 对象
  vi.mocked(api.getAutomationExecutions).mockReturnValue(new Promise(() => {})) // 这次请求挂着不回
  await act(async () => root.render(React.createElement(ExecutionsList, { triggerId: 'tr-1' })))
  expect(host.querySelector('.sk')).toBeNull()
  expect(host.querySelector('.auto-executions')).not.toBeNull()
  // 换了账号:旧账号的记录绝不先画
  await act(async () => root.unmount())
  root = createRoot(host)
  state.authInfo = { accountId: 'u2' }
  await act(async () => root.render(React.createElement(ExecutionsList, { triggerId: 'tr-1' })))
  expect(host.querySelector('.auto-executions')).toBeNull()
})
