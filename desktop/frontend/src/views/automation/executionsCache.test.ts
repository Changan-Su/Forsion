// @vitest-environment happy-dom
/**
 * 执行账本缓存的作用域(Codex 第一轮 D-2):以前按 cfg 对象引用分桶,别处改个默认模型 appStore 就换新 cfg,
 * 回到记录页又闪骨架。现在按「连接 + 账号」分桶:改模型不换桶,换后端 / 令牌 / 账号才换。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../services/backendService'
import { ExecutionsList, executionsCacheStats, executionsScope } from './AutomationRunsView'

const state = vi.hoisted(() => ({ cfg: { backendUrl: 'http://engine', token: 't', modelId: 'm1' } as Record<string, string>, authInfo: { accountId: 'u1' } as { accountId: string; loggedIn?: boolean } | null }))
const listeners = vi.hoisted(() => [] as Array<(s: unknown, prev: unknown) => void>)
vi.mock('../../stores/appStore', () => ({
  useApp: Object.assign((sel: (s: typeof state) => unknown) => sel(state), { subscribe: (fn: (s: unknown, prev: unknown) => void) => { listeners.push(fn); return () => {} } }),
}))
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

describe('缓存边界(Codex 第三轮 H1-5)', () => {
  it('缓存键里不出现明文令牌', () => {
    const scope = executionsScope({ backendUrl: 'http://engine', token: 'sk-live-SECRET-123' }, 'u1')
    expect(scope).not.toContain('sk-live-SECRET-123')
    expect(scope).not.toContain('SECRET')
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

it('桶数有上限、按最近使用淘汰;退出账号即整份清空(Codex 第三轮 H1-5)', async () => {
  const exec = { id: 'e1', status: 'done', origin: 'manual', created_at: '2026-09-25T10:00:00Z', steps: [], error: null }
  vi.mocked(api.getAutomationExecutions).mockResolvedValue([exec] as never)
  state.authInfo = { accountId: 'u1', loggedIn: true }
  // 十个不同连接各开一次记录页(长期运行、来回换连接)
  for (let i = 0; i < 10; i++) {
    state.cfg = { backendUrl: `http://engine-${i}`, token: `tok-${i}`, modelId: 'm1' }
    await act(async () => root.render(React.createElement(ExecutionsList, { triggerId: `tr-${i}` })))
    await act(async () => root.unmount())
    root = createRoot(host)
  }
  const { scopes, sizes } = executionsCacheStats()
  expect(scopes.length).toBeGreaterThan(0)
  expect(scopes.length, '桶数无上限:每个连接 / 令牌永久留一个桶').toBeLessThanOrEqual(4)
  expect(scopes.some((k) => k.includes('engine-9')), '最近用的那个连接必须还在').toBe(true)
  expect(scopes.some((k) => k.includes('engine-0')), '最久没用的连接应被淘汰').toBe(false)
  expect(scopes.join(' ')).not.toContain('tok-')
  expect(sizes.every((n) => n <= 40)).toBe(true)
  // 退出账号:整份清空
  expect(listeners.length, '模块应订阅登录态').toBeGreaterThan(0)
  const prev = { authInfo: { accountId: 'u1', loggedIn: true } }
  const next = { authInfo: { accountId: 'u1', loggedIn: false } }
  listeners.forEach((fn) => fn(next, prev))
  expect(executionsCacheStats().scopes).toEqual([])
})
