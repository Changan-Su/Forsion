// @vitest-environment happy-dom
// 右栏「记忆」视图:记忆本体在上,最近日志默认全折叠(10-13 前最近一天默认展开,日志盖过了记忆);点开的那天读的是去掉文件头和设备标记的那一份。
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RightPanel } from './RightPanel'
import * as api from '../services/backendService'
// t 必须是同一个函数:面板的 refresh 把它列在依赖里,每次渲染换一个就会无限重读
const { t } = vi.hoisted(() => ({ t: (key: string) => key }))
vi.mock('../i18n', () => ({ useI18n: () => ({ t }), registerMessages: () => {}, translate: t }))
vi.mock('./Markdown', async () => { const R = await import('react'); return { Markdown: (p: { content: string }) => R.createElement('div', { 'data-md': '' }, p.content) } })
vi.mock('./ChatToc', () => ({ ChatToc: () => null }))
vi.mock('./SubChatsTab', () => ({ SubChatsTab: () => null }))
vi.mock('@lcl/engine', () => ({ OverlayAt: () => null, nativeSheetPresenter: () => null, pickNativeCtxItem: async () => null }))
vi.mock('../services/backendService', () => ({ getAgentMemory: vi.fn(), listAgentLogDates: vi.fn(), getAgentLog: vi.fn(), getAgentLogSnapshot: vi.fn(), putAgentLog: vi.fn() }))
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.mocked(api.getAgentMemory).mockResolvedValue('- prefers short answers')
  vi.mocked(api.listAgentLogDates).mockResolvedValue(['2026-09-07', '2026-09-08'])
  vi.mocked(api.getAgentLog).mockImplementation(async (_t, _slug, date) => `# ${date}\n\n### 09:30\n@a1b2c3d4 did a thing on ${date}\n`)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

it('memory view: recent logs start folded; an opened day shows the reading copy', async () => {
  const props = { cfg: { backendUrl: 'http://engine', token: 'account' }, sessionId: 's1', sessionConfig: { agentSlug: 'alpha' }, running: false, messages: [], chatScrollRef: { current: null }, onToast: () => {}, onOpenPreview: () => {}, view: 'memory' } as any
  await act(async () => root.render(React.createElement(RightPanel, props)))
  const heads = () => [...host.querySelectorAll<HTMLButtonElement>('.agentmem-log-head')]
  expect(heads().map((b) => b.textContent)).toEqual(['2026-09-08', '2026-09-07'])
  expect(host.querySelectorAll('.agentmem-log-body').length).toBe(0)
  expect(host.textContent).toContain('- prefers short answers')
  await act(async () => heads()[0].click())
  expect(host.querySelector('.agentmem-log-body [data-md]')!.textContent).toBe('### 09:30\ndid a thing on 2026-09-08\n')
})
