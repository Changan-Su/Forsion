// @vitest-environment happy-dom
/** Exercise the actual tab entry: parser errors retain an actionable explanation
 * and download, and changing/closing the tab cancels its parser lifetime. */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreviewTarget } from '../components/WorkspaceFilePreview'

let target: PreviewTarget | undefined
vi.mock('./wsFileNav', () => ({ getTransientTarget: () => target, hostTargetFor: () => target, pendingWrites: new Map() }))
// 与本测无关的重模块(编辑器 / 笔记库 / 插件)换成桩:只测正文区的失败态
vi.mock('../amadeus/blocks/markdown/MarkdownBlock', () => ({ PlainMarkdownEditor: () => null }))
vi.mock('../stores/appStore', () => ({ useApp: { getState: () => ({ toast: () => {}, tr: (k: string) => k }) } }))
vi.mock('./chat2/FilesPanel', () => ({ bumpDir: () => {} }))
vi.mock('@amadeus/store/pageStore', () => ({ usePageStore: (sel: (s: { vaultRoot: null }) => unknown) => sel({ vaultRoot: null }) }))
vi.mock('@amadeus/plugins/pluginStore', () => ({ usePluginStore: (sel: (s: { fileTypes: [] }) => unknown) => sel({ fileTypes: [] }), findFileType: () => null }))
vi.mock('../amadeusNav', () => ({ openNote: () => {} }))
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: '' }))

const workbook = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../services/workbookPreview', () => ({ loadWorkbook: workbook.load }))
const { WsFileView } = await import('./WsFileView')

let host: HTMLDivElement
let root: Root
const leaf = (params: Record<string, unknown>): any => ({ params, setTitle: () => {}, setParams: () => {} })
async function render(params: Record<string, unknown>): Promise<void> {
  await act(async () => root.render(React.createElement(WsFileView, { leaf: leaf(params) } as any)))
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
}
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  workbook.load.mockReset()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); target = undefined; delete (window as any).tangu })

describe('WsFileView workbook lifetime and budget errors', () => {
  it('shows the workbook budget explanation and preserves download after parse rejection', async () => {
    workbook.load.mockRejectedValue(new Error('workbook-html-limit'))
    const download = vi.fn()
    target = { name: 'large.xlsx', load: async () => ({ mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: new Uint8Array([1]), size: 1 }), download }
    await render({ tkey: 'large', name: 'large.xlsx' })
    expect(host.textContent).toMatch(/无法预览工作簿|Cannot preview this workbook/)
    const button = host.querySelector<HTMLButtonElement>('.wsfile-fallback button')!
    expect(button).not.toBeNull()
    button.click()
    expect(download).toHaveBeenCalledOnce()
  })
  it('aborts the old parser when changing files and aborts the new parser on unmount', async () => {
    workbook.load.mockImplementation((_bytes: Uint8Array, signal?: AbortSignal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    target = { name: 'a.xlsx', load: async () => ({ mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: new Uint8Array([1]), size: 1 }) }
    await render({ tkey: 'a', name: 'a.xlsx' })
    const oldSignal = workbook.load.mock.calls.at(-1)?.[1] as AbortSignal | undefined
    expect(oldSignal).toBeDefined()
    expect(oldSignal?.aborted).toBe(false)
    target = { name: 'b.xlsx', load: async () => ({ mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: new Uint8Array([2]), size: 1 }) }
    await render({ tkey: 'b', name: 'b.xlsx' })
    expect(oldSignal?.aborted).toBe(true)
    const newSignal = workbook.load.mock.calls.at(-1)?.[1] as AbortSignal
    expect(newSignal).not.toBe(oldSignal)
    expect(newSignal.aborted).toBe(false)
    await act(async () => root.render(null))
    expect(newSignal.aborted).toBe(true)
    expect(host.textContent).not.toContain('workbook')
  })
})
