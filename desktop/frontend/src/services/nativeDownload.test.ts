// P1-DL:downloadWorkspaceFile 在安卓 App(有 window.tangu.saveDownload)走原生存「下载」,否则照旧 <a download>。
// 断言「分流对不对」与「提示是不是人话」:成功 toast 带原生回的实际文件名;超限在读 body 之前就拒;原生错误码本地化。
// 语言由 testSetup 钉 zh。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectionTarget } from './engine/targets'

const authFetch = vi.fn()
vi.mock('./http', () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }))

const api = await import('./backendService')
const { NATIVE_DOWNLOAD_MAX_BYTES } = await import('./nativeDownload')
const { useNotifications } = await import('../stores/notificationStore')

const cfg = { backendUrl: 'http://127.0.0.1:4100', token: 'engine-token', modelId: 'm' }
const URL_B = 'http://127.0.0.1:4100/agent/workspace/download?sessionId=s&appId=tangu&path=%2Fout%2Fb.txt'
const texts = (): string[] => useNotifications.getState().items.map((n) => n.text)

type Anchor = { href?: string; download?: string; click: ReturnType<typeof vi.fn> }
let anchors: Anchor[]
let createElement: ReturnType<typeof vi.fn>

beforeEach(() => {
  authFetch.mockReset()
  authFetch.mockImplementation(async () => new Response('hello', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))
  useNotifications.getState().dismissAll()
  useNotifications.setState({ prefs: { enabled: true, osEnabled: true, events: {} }, paused: false })
  anchors = []
  createElement = vi.fn(() => { const a: Anchor = { click: vi.fn() }; anchors.push(a); return a })
  vi.stubGlobal('document', { createElement, hasFocus: () => true })
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }))
})
afterEach(() => vi.unstubAllGlobals())

describe('downloadWorkspaceFile × 原生存「下载」(P1-DL)', () => {
  it('有桥:交给 window.tangu.saveDownload(名字 / MIME / 字节),不碰 <a download>,toast 用原生回的实际文件名', async () => {
    const save = vi.fn(async () => ({ name: 'b (1).txt' }))
    vi.stubGlobal('window', { tangu: { saveDownload: save } })
    await api.downloadWorkspaceFile(connectionTarget(cfg), 's', '/out/b.txt')
    expect(authFetch).toHaveBeenCalledTimes(1)
    expect(authFetch.mock.calls[0][0]).toBe(URL_B)
    expect(save).toHaveBeenCalledTimes(1)
    const [name, mime, blob] = save.mock.calls[0] as unknown as [string, string, Blob]
    expect(name).toBe('b.txt')
    expect(mime).toBe('text/plain;charset=utf-8')
    expect(await blob.text()).toBe('hello')
    expect(createElement).not.toHaveBeenCalled()
    expect(texts()).toEqual(['已保存到「下载」：b (1).txt'])
  })

  it('无桥(desktop / web / 移动端 dev):照旧 <a download>,不弹「已保存」', async () => {
    vi.stubGlobal('window', { tangu: {} })
    await api.downloadWorkspaceFile(connectionTarget(cfg), 's', '/out/b.txt')
    expect(createElement).toHaveBeenCalledWith('a')
    expect(anchors).toHaveLength(1)
    expect(anchors[0].download).toBe('b.txt')
    expect(anchors[0].click).toHaveBeenCalledTimes(1)
    expect(texts()).toEqual([])
  })

  it('无 window(node / worker):不抛,走 <a download>', async () => {
    vi.stubGlobal('window', undefined)
    await api.downloadWorkspaceFile(connectionTarget(cfg), 's', '/out/b.txt')
    expect(anchors[0].download).toBe('b.txt')
  })

  it('Content-Length 超 50 MB:读 body 之前就拒(本地化),桥一次都不调', async () => {
    const save = vi.fn(async () => ({ name: 'x' }))
    vi.stubGlobal('window', { tangu: { saveDownload: save } })
    const blob = vi.fn()
    authFetch.mockImplementation(async () => ({
      ok: true, status: 200, body: null,
      headers: new Headers({ 'Content-Length': String(NATIVE_DOWNLOAD_MAX_BYTES + 1) }),
      blob,
    }))
    await expect(api.downloadWorkspaceFile(connectionTarget(cfg), 's', '/out/big.zip')).rejects.toThrow('文件太大（50.0 MB），手机上一次最多保存 50 MB')
    expect(blob).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('没有 Content-Length 但 blob 超限:照样拒,桥不调', async () => {
    const save = vi.fn(async () => ({ name: 'x' }))
    vi.stubGlobal('window', { tangu: { saveDownload: save } })
    authFetch.mockImplementation(async () => ({
      ok: true, status: 200, headers: new Headers(),
      blob: async () => ({ size: 60 * 1024 * 1024, type: '' }),
    }))
    await expect(api.downloadWorkspaceFile(connectionTarget(cfg), 's', '/out/big.zip')).rejects.toThrow('文件太大（60.0 MB）')
    expect(save).not.toHaveBeenCalled()
  })

  it('原生拒绝:unsupported_os / too_large / 其余 code 都换成本地化的一句话,不弹「已保存」', async () => {
    for (const [code, want] of [
      ['unsupported_os', '保存到「下载」需要 Android 10 及以上'],
      ['too_large', '文件太大（0.0 MB），手机上一次最多保存 50 MB'],
      ['io', '保存到「下载」失败：IOException'],
    ] as const) {
      vi.stubGlobal('window', { tangu: { saveDownload: vi.fn(async () => { throw Object.assign(new Error(code === 'io' ? 'IOException' : 'x'), { code }) }) } })
      await expect(api.downloadWorkspaceFile(connectionTarget(cfg), 's', '/out/b.txt')).rejects.toThrow(want)
    }
    expect(texts()).toEqual([])
  })

  it('下载本身失败(非 2xx):照旧抛 downloadFailed,桥不调', async () => {
    const save = vi.fn(async () => ({ name: 'x' }))
    vi.stubGlobal('window', { tangu: { saveDownload: save } })
    authFetch.mockImplementation(async () => new Response('nope', { status: 404 }))
    await expect(api.downloadWorkspaceFile(connectionTarget(cfg), 's', '/out/b.txt')).rejects.toThrow('下载失败 (404)')
    expect(save).not.toHaveBeenCalled()
  })

  it('en 界面:成功提示是英文', async () => {
    const { setLocaleGlobal } = await import('../i18n')
    setLocaleGlobal('en')
    try {
      vi.stubGlobal('window', { tangu: { saveDownload: vi.fn(async () => ({ name: 'b.txt' })) } })
      await api.downloadWorkspaceFile(connectionTarget(cfg), 's', '/out/b.txt')
      expect(texts()).toEqual(['Saved to Downloads: b.txt'])
    } finally { setLocaleGlobal('zh') }
  })
})
