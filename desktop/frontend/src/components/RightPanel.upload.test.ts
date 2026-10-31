// @vitest-environment happy-dom
// 会话文件面板的上传:一选文件就出「正在传」的那一行(环 + 已传 / 总共),传完换成列表里的真行;失败的留着给重试 / 移除。
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RightPanel } from './RightPanel'
import * as api from '../services/backendService'
const { t } = vi.hoisted(() => ({ t: (key: string) => key }))
vi.mock('../i18n', () => ({ useI18n: () => ({ t }), registerMessages: () => {}, translate: t }))
vi.mock('./Markdown', () => ({ Markdown: () => null }))
vi.mock('./ChatToc', () => ({ ChatToc: () => null }))
vi.mock('./SubChatsTab', () => ({ SubChatsTab: () => null }))
vi.mock('@lcl/engine', () => ({ OverlayAt: () => null, nativeSheetPresenter: () => null, pickNativeCtxItem: async () => null }))
vi.mock('../services/engine/targets', () => ({ targetForSession: () => ({ key: 'home' }), homeTarget: () => ({ key: 'home' }) }))
vi.mock('../services/backendService', () => ({ listWorkspace: vi.fn(), uploadWorkspaceFiles: vi.fn(), deleteWorkspaceFile: vi.fn() }))

let host: HTMLDivElement
let root: Root
let files: Array<{ path: string; size: number; mimeType: string; updatedAt: number }>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  files = []
  vi.mocked(api.listWorkspace).mockImplementation(async () => files)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.mocked(api.uploadWorkspaceFiles).mockReset() })

const props = { cfg: {}, sessionId: 's1', sessionConfig: { execMode: 'sandbox' }, running: false, messages: [], chatScrollRef: { current: null }, onToast: () => {}, onOpenPreview: () => {}, view: 'workspace' } as any
const pick = async (f: File) => {
  const input = host.querySelector<HTMLInputElement>('input[type=file]')!
  Object.defineProperty(input, 'files', { value: [f], configurable: true })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
}
const until = async (ok: () => boolean) => { for (let i = 0; i < 50 && !ok(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)) }) }

it('shows the uploading row at once, then the real row after the upload lands', async () => {
  let land!: () => void
  vi.mocked(api.uploadWorkspaceFiles).mockImplementation((_t, _sid, list, opts) => new Promise((res) => {
    opts?.onProgress?.(0.5)
    land = () => { files = [{ path: `/${list[0].path}`, size: 4, mimeType: 'audio/mp4', updatedAt: 1 }]; res({ success: true, saved: 1, total: 1, errors: [] }) }
  }))
  await act(async () => root.render(React.createElement(RightPanel, props)))
  await pick(new File([new Uint8Array(4)], 'talk.m4a', { type: 'audio/mp4' }))
  await until(() => !!host.querySelector('.file-row--uploading') && !!land)
  const row = host.querySelector('.file-row--uploading')!
  expect(row.textContent).toContain('talk.m4a')
  expect(host.querySelector('.panel-note')).toBeNull() // 「还没有文件」不和正在传的那一行同时出现
  await act(async () => land())
  await until(() => !host.querySelector('.file-row--uploading'))
  expect(host.querySelector('.file-row--uploading')).toBeNull()
  expect([...host.querySelectorAll('.file-row .file-name')].map((n) => n.textContent)).toEqual(['talk.m4a'])
})

it('keeps a failed upload with retry and remove', async () => {
  vi.mocked(api.uploadWorkspaceFiles).mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce({ success: true, saved: 1, total: 1, errors: [] })
  await act(async () => root.render(React.createElement(RightPanel, props)))
  await pick(new File([new Uint8Array(4)], 'report.pdf', { type: 'application/pdf' }))
  await until(() => !!host.querySelector('.file-row--uploading.is-failed'))
  const failed = host.querySelector('.file-row--uploading.is-failed')!
  expect(failed.textContent).toContain('panel.upload.failed')
  const [retry] = [...failed.querySelectorAll('button')]
  expect(retry.title).toBe('panel.upload.retry')
  await act(async () => retry.click())
  await until(() => !host.querySelector('.file-row--uploading'))
  expect(api.uploadWorkspaceFiles).toHaveBeenCalledTimes(2)
  // 再来一个失败的,点移除:那一行没了,不再重试
  vi.mocked(api.uploadWorkspaceFiles).mockRejectedValueOnce(new Error('disk full'))
  await pick(new File([new Uint8Array(4)], 'b.pdf', { type: 'application/pdf' }))
  await until(() => !!host.querySelector('.file-row--uploading.is-failed'))
  await act(async () => [...host.querySelector('.file-row--uploading.is-failed')!.querySelectorAll('button')][1].click())
  expect(host.querySelector('.file-row--uploading')).toBeNull()
})
