// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMemoryModal } from './AgentMemoryModal'
import { AgentLogPanel, logForReading } from './AgentLogPanel'
import * as api from '../services/backendService'
import { homeTarget } from '../services/engine/targets'
vi.mock('../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }), registerMessages: () => {}, translate: (key: string) => key }))
vi.mock('./AgentMemoryPanel', () => ({ AgentMemoryPanel: () => null }))
vi.mock('./Markdown', async () => { const R = await import('react'); return { Markdown: (p: { content: string }) => R.createElement('div', { 'data-md': '' }, p.content) } })
vi.mock('../services/backendService', () => ({
  listAgentLogDates: vi.fn(), getAgentLogSnapshot: vi.fn(), putAgentLog: vi.fn(),
  listAgentLibrary: vi.fn(async () => []), getAgentHarness: vi.fn(async () => ({ entries: [], journal: [] })),
}))
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.mocked(api.listAgentLogDates).mockResolvedValue(['2026-09-07', '2026-09-08'])
  vi.mocked(api.getAgentLogSnapshot).mockReset().mockResolvedValue({ date: '2026-09-08', content: '# 2026-09-08\n\n### 09:30\n@a1b2c3d4 original log\n', version: 'log-v1' })
  vi.mocked(api.putAgentLog).mockReset().mockRejectedValue(Object.assign(new Error('409: log changed'), { status: 409 }))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
it('log saves include the loaded version; a conflict leaves the editable draft and never reports saved', async () => {
  const cfg = { backendUrl: 'http://engine', token: 'account' } as any
  await act(async () => root.render(React.createElement(AgentMemoryModal, { cfg, slug: 'alpha', name: 'Alpha', onClose: () => {} })))
  const buttons = () => [...host.querySelectorAll('button')]
  await act(async () => buttons().find((b) => b.textContent === 'settings.agents.tabLog')!.click())
  // 最近一天默认展开、只读了那一天;读的是去掉文件头和设备标记的那一份,编辑框里是磁盘原文
  expect(vi.mocked(api.getAgentLogSnapshot).mock.calls.map((c) => c[2])).toEqual(['2026-09-08'])
  expect(host.querySelector('[data-md]')!.textContent).toBe('### 09:30\noriginal log\n')
  expect(host.querySelector('textarea')).toBeNull()
  await act(async () => buttons().find((b) => b.getAttribute('aria-label') === 'agentLog.editDay')!.click())
  const textarea = host.querySelector('textarea')!
  expect(textarea.value).toBe('# 2026-09-08\n\n### 09:30\n@a1b2c3d4 original log\n')
  // 编辑期间不许换天(草稿对着的是开始编辑时的版本)
  expect([...host.querySelectorAll<HTMLButtonElement>('.agentmem-log-head')].every((b) => b.disabled)).toBe(true)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'my log draft')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => buttons().find((b) => b.textContent?.trim() === 'common.save')!.click())
  // P1-K6 S3:请求走 homeTarget()(活目标;按对象身份比,别让深比较去读 getter —— 本测没装宿主)
  const put = vi.mocked(api.putAgentLog).mock.calls.at(-1)!
  expect(put[0]).toBe(homeTarget())
  expect(put.slice(1)).toEqual(['alpha', '2026-09-08', 'my log draft', 'log-v1'])
  expect(host.querySelector('textarea')!.value).toBe('my log draft')
  // 冲突给的是本地化的那句和一条出路,不是引擎的原话
  expect(host.textContent).toContain('agentLog.changed')
  expect(host.textContent).toContain('agentLog.discardAndReload')
  expect(host.textContent).not.toContain('409: log changed')
  expect(host.textContent).not.toContain('settings.agents.memSaved')
})

it('logForReading drops the date title and the per-entry device marker, and leaves everything else alone', () => {
  expect(logForReading('# 2026-09-08\n\n### 09:30\n@a1b2c3d4 did a thing\n\n### 10:00\n@0f9e8d7c mailed @alice\n')).toBe('### 09:30\ndid a thing\n\n### 10:00\nmailed @alice\n')
  // 手写的条目以 @某人 开头:不是设备号的形状,原样留着
  expect(logForReading('### 11:00\n@alice asked for the draft\n')).toBe('### 11:00\n@alice asked for the draft\n')
  expect(logForReading('free-form notes\n@not a marker')).toBe('free-form notes\n@not a marker')
})

// 下面两条直接挂面板(成长 › 日志那种用法:常驻挂载,active 随显隐翻转)。
const typeInto = async (textarea: HTMLTextAreaElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
})
const click = async (pick: () => HTMLButtonElement | undefined) => act(async () => pick()!.click())
const button = (match: (b: HTMLButtonElement) => boolean) => () => [...host.querySelectorAll('button')].find(match)

it('a draft keeps the version it started from: showing the panel again never re-reads under an open draft', async () => {
  const cfg = { backendUrl: 'http://engine', token: 'account' } as any
  const render = (active: boolean) => act(async () => root.render(React.createElement(AgentLogPanel, { cfg, slug: 'alpha', active })))
  vi.mocked(api.putAgentLog).mockReset().mockResolvedValue({ ok: true })
  await render(true)
  await click(button((b) => b.getAttribute('aria-label') === 'agentLog.editDay'))
  await typeInto(host.querySelector('textarea')!, 'my log draft')
  // 别处在这期间改了这一天:再读就会拿到 log-v2
  vi.mocked(api.getAgentLogSnapshot).mockResolvedValue({ date: '2026-09-08', content: 'changed elsewhere', version: 'log-v2' })
  const reads = vi.mocked(api.getAgentLogSnapshot).mock.calls.length
  await render(false)
  await render(true)
  expect(vi.mocked(api.getAgentLogSnapshot).mock.calls.length).toBe(reads)
  expect(host.querySelector('textarea')!.value).toBe('my log draft')
  await click(button((b) => b.textContent?.trim() === 'common.save'))
  expect(vi.mocked(api.putAgentLog).mock.calls.at(-1)!.slice(1)).toEqual(['alpha', '2026-09-08', 'my log draft', 'log-v1'])
})

it('a refresh whose dates request fails late does not take the open draft off the screen', async () => {
  const cfg = { backendUrl: 'http://engine', token: 'account' } as any
  await act(async () => root.render(React.createElement(AgentLogPanel, { cfg, slug: 'alpha' })))
  let failDates!: (e: Error) => void
  vi.mocked(api.listAgentLogDates).mockReturnValue(new Promise((_resolve, reject) => { failDates = reject }))
  await click(button((b) => b.textContent === 'common.refresh'))
  await click(button((b) => b.getAttribute('aria-label') === 'agentLog.editDay'))
  await typeInto(host.querySelector('textarea')!, 'typed while the list was still loading')
  await act(async () => failDates(new Error('engine went away')))
  expect(host.querySelector('textarea')?.value).toBe('typed while the list was still loading')
  expect(host.textContent).toContain('engine went away')
})
