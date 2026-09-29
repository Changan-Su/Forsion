// @vitest-environment happy-dom
/**
 * P1-DL · display_file 在 host 会话里交出来的文件卡片,在手机 / 设备页上也能下载原文件:
 * 下载位一律交给会话所在那台电脑的 hostFs.downloadHostFile —— 本机桌面 = 在文件管理器显示(行为不变);
 * 手机 / Electron 看别的电脑 = GET {unitBase}/unit/hostfile/download(流式,不受预览的 4MB 隧道上限)→ 存文件;
 * 设备页 = unitShim 的 downloadHostFile。落库的消息形状不变({ name, path }),老消息同样长出下载位。
 * 远端的 target 不给 path —— 给了 openWsFile 就丢掉这里的 load / download,按本机 readHostFile 重建(那条路没有下载)。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []
let reply: (url: string) => Response = () => new Response('BYTES', { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
vi.mock('../services/http', () => ({
  authFetch: async (url: string) => { calls.push(String(url)); return reply(String(url)) },
}))

const { InlineFiles, targetFor } = await import('./InlineFiles')
const T = await import('../services/engine/targets')
const { useNotifications } = await import('../stores/notificationStore')

const U = '7f0e8a52-0000-4000-8000-00000000000a'
const API = 'https://api.forsion.test/api'
const cfg = { backendUrl: API, token: 'forsion-token', modelId: '' }
const ABS = '/Users/mac/proj/介绍….docx'
/** 落库的消息里就是这个形状(display_file 的历史记录,没有任何新字段)。 */
const stored = { name: '介绍….docx', path: ABS }
const DL = `${API}/units/${U}/proxy/unit/hostfile/download?path=${encodeURIComponent(ABS)}`
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5)) }
const texts = (): string[] => useNotifications.getState().items.map((n) => n.text)

async function onUnit(): Promise<void> {
  await T.setFocusTarget({ kind: 'unit', unitId: U })
  T.bindSession('s1', { kind: 'unit', unitId: U })
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  calls.length = 0
  reply = () => new Response('BYTES', { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
  T.resetFocusForTests()
  ;(window as any).tangu = { mobile: true }
  T.installEngineHost({ cfg: () => cfg, desktopConfig: () => ({ cloudApiBase: API }) })
  useNotifications.getState().dismissAll()
  useNotifications.setState({ prefs: { enabled: true, osEnabled: true, events: {} }, paused: false })
})
afterEach(() => { delete (window as any).tangu; T.clearSessionBindings() })

describe('targetFor × host 文件下载(P1-DL)', () => {
  it('手机(安卓 App):老消息形状也有下载位 → /unit/hostfile/download → 原生存「下载」,文件名是原名;不给 path', async () => {
    const saveDownload = vi.fn(async (name: string) => ({ name }))
    ;(window as any).tangu = { mobile: true, saveDownload }
    await onUnit()
    const t = targetFor(stored, cfg as any, 's1', 'host')
    expect(t.path).toBeUndefined()
    expect(t.download).toBeTypeOf('function')
    t.download!()
    await flush()
    expect(calls).toEqual([DL])
    expect(saveDownload).toHaveBeenCalledTimes(1)
    const [name, , blob] = saveDownload.mock.calls[0] as unknown as [string, string, Blob]
    expect(name).toBe('介绍….docx')
    expect(await blob.text()).toBe('BYTES')
  })

  it('设备页(unitShim):交给 window.tangu.downloadHostFile(原路径 + 原名);经 hub 的 readHostFile 不碰;不给 path', async () => {
    const downloadHostFile = vi.fn(async () => {})
    const readHostFile = vi.fn()
    ;(window as any).tangu = { unitPage: true, readHostFile, downloadHostFile }
    const t = targetFor(stored, cfg as any, 's1', 'host')
    expect(t.path).toBeUndefined()
    t.download!()
    await flush()
    expect(downloadHostFile).toHaveBeenCalledWith(ABS, '介绍….docx')
    expect(readHostFile).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it('本机桌面(Electron):一字不变 —— path 照给、下载 = revealHostPath(本机路径),不发任何请求', async () => {
    const revealHostPath = vi.fn(async () => ({ ok: true }))
    const readHostFile = vi.fn(async () => ({ mimeType: 'application/octet-stream', content: 'Qg==', size: 1 }))
    ;(window as any).tangu = { readHostFile, revealHostPath }
    const t = targetFor(stored, cfg as any, 's1', 'host')
    expect(t.path).toBe(ABS)
    t.download!()
    await t.load()
    await flush()
    expect(revealHostPath).toHaveBeenCalledWith(ABS)
    expect(readHostFile).toHaveBeenCalledWith(ABS)
    expect(calls).toEqual([])
  })

  it('下载失败看得见:413 给出大小与上限,别的状态码带码;都进通知', async () => {
    await onUnit()
    reply = () => new Response(JSON.stringify({ code: 'HOST_DOWNLOAD_TOO_LARGE', size: 300 * 1024 * 1024, limit: 256 * 1024 * 1024 }), { status: 413, headers: { 'Content-Type': 'application/json' } })
    targetFor(stored, cfg as any, 's1', 'host').download!()
    await flush()
    reply = () => new Response(JSON.stringify({ detail: 'not readable' }), { status: 404 })
    targetFor(stored, cfg as any, 's1', 'host').download!()
    await flush()
    expect(texts()).toEqual(expect.arrayContaining(['文件太大（300.0 MB），远程下载一次最多 256 MB', '下载失败（404）']))
  })
})

describe('InlineFiles × 读不出缩略图的图片(P1-DL)', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:thumb')
    URL.revokeObjectURL = vi.fn()
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })

  it('手机上 >4MB 的图(隧道预览 tooLarge):退化成文件卡片 —— 图没了,点开预览 / 下载的入口不能跟着没', async () => {
    await onUnit()
    reply = () => new Response(JSON.stringify({ mimeType: 'image/png', content: '', size: 9 * 1024 * 1024, tooLarge: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    await act(async () => root.render(React.createElement(InlineFiles, { files: [{ name: 'chart.png', path: '/Users/mac/proj/chart.png', mime: 'image/png' }], cfg: cfg as any, sessionId: 's1', execMode: 'host' })))
    await act(async () => { await flush() })
    expect(host.querySelector('img.inline-file-img')).toBeNull()
    expect(host.querySelector('button.inline-file-card')?.textContent).toContain('chart.png')
  })
})
