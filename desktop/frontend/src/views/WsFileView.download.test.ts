// @vitest-environment happy-dom
/**
 * P1-DL · 预览失败不许把下载位一起藏掉:手机 / 设备页打开 display_file 的卡片是瞬态 target(没有本机 path),
 * 预览经隧道读对方电脑 —— >4MB 回 tooLarge、对方离线 / 超时直接失败。这两种状态下正文区都要给「下载」
 * (下载走 /unit/hostfile/download 流式,不受预览上限)。本机 path 的预览行为不变(打开 / 在文件管理器显示)。
 */
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

const { WsFileView } = await import('./WsFileView')
const { WorkspaceFilePreview } = await import('../components/WorkspaceFilePreview')

let host: HTMLDivElement
let root: Root
const leaf = (params: Record<string, unknown>): any => ({ params, setTitle: () => {}, setParams: () => {} })
async function render(params: Record<string, unknown>): Promise<void> {
  await act(async () => root.render(React.createElement(WsFileView, { leaf: leaf(params) } as any)))
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
}
/** 正文区(不含顶栏图标)里的「下载」按钮。 */
const bodyDownload = (): HTMLButtonElement | null =>
  [...host.querySelectorAll<HTMLButtonElement>('.wsfile-body button')].find((b) => b.textContent?.includes('下载')) ?? null

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); target = undefined; delete (window as any).tangu })

describe('WsFileView × 瞬态 target 的失败态仍给下载位', () => {
  it('预览超限(tooLarge):正文区有「下载」,点它调 target.download', async () => {
    const download = vi.fn()
    target = { name: 'big.docx', load: async () => ({ tooLarge: true, size: 9 * 1024 * 1024 }), download }
    await render({ tkey: 't1', name: 'big.docx' })
    const btn = bodyDownload()
    expect(btn).not.toBeNull()
    btn!.click()
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('预览读取失败(对方离线 / 超时):正文区同样有「下载」', async () => {
    const download = vi.fn()
    target = { name: 'report.docx', load: async () => { throw new Error('hostfile HTTP 504') }, download }
    await render({ tkey: 't2', name: 'report.docx' })
    const btn = bodyDownload()
    expect(btn).not.toBeNull()
    btn!.click()
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('没有下载能力的 target:失败态不凭空长出按钮', async () => {
    target = { name: 'x.docx', load: async () => { throw new Error('boom') } }
    await render({ tkey: 't3', name: 'x.docx' })
    expect(bodyDownload()).toBeNull()
  })
})

describe('WorkspaceFilePreview(浮层预览)× 失败态仍给下载位', () => {
  const mount = async (t: PreviewTarget): Promise<void> => {
    await act(async () => root.render(React.createElement(WorkspaceFilePreview, { target: t, onClose: () => {} })))
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  }
  it('tooLarge:正文区有「下载」', async () => {
    const download = vi.fn()
    await mount({ name: 'big.docx', load: async () => ({ tooLarge: true, size: 9 * 1024 * 1024 }), download })
    bodyDownload()!.click()
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('读取失败:正文区同样有「下载」', async () => {
    const download = vi.fn()
    await mount({ name: 'gone.docx', load: async () => { throw new Error('hostfile HTTP 504') }, download })
    expect(host.querySelector('.wsfile-body')?.textContent).toContain('加载失败')
    const btn = bodyDownload()
    expect(btn).not.toBeNull()
    btn!.click()
    expect(download).toHaveBeenCalledTimes(1)
  })
})
