// @vitest-environment happy-dom
/**
 * P1-K6 S2 · 内联缩略图按会话所在的目标取字节(§3.7):手机经 hub 打「我的电脑」时 `<img src>` 不带凭据(隧道 cookie
 * 对手机源是跨站、Bearer 不进 URL)→ 沙箱文件读 /agent/workspace/read 做 blob、host 文件读 {unitBase}/unit/hostfile。
 * 焦点在本端 → 与改造前一样用直链 / window.tangu.readHostFile。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []
vi.mock('../services/http', () => ({
  authFetch: async (url: string) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ path: 'a.png', mimeType: 'image/png', content: 'iVBORw0K', encoding: 'base64', size: 6 }), { status: 200 })
  },
}))

const { InlineFiles } = await import('./InlineFiles')
const T = await import('../services/engine/targets')

const U = '7f0e8a52-0000-4000-8000-00000000000a'
const API = 'https://api.forsion.test/api'
const cfg = { backendUrl: API, token: 'forsion-token', modelId: '' }

let host: HTMLDivElement
let root: Root
async function render(execMode: 'host' | 'sandbox', path: string): Promise<void> {
  await act(async () => root.render(React.createElement(InlineFiles, { files: [{ name: 'a.png', path, mime: 'image/png' }], cfg, sessionId: 's1', execMode })))
  await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
}
const img = (): string | null => host.querySelector('img.inline-file-img')?.getAttribute('src') ?? null

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  calls.length = 0
  T.resetFocusForTests()
  ;(window as any).tangu = { mobile: true }
  T.installEngineHost({ cfg: () => cfg, desktopConfig: () => ({ cloudApiBase: API }) })
  URL.createObjectURL = vi.fn(() => 'blob:thumb')
  URL.revokeObjectURL = vi.fn()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete (window as any).tangu; T.clearSessionBindings() })

describe('InlineFiles.Thumb × 目标', () => {
  it('unit + 沙箱文件:不给直链,读 /agent/workspace/read 做 blob', async () => {
    await T.setFocusTarget({ kind: 'unit', unitId: U })
    T.bindSession('s1', { kind: 'unit', unitId: U }) // S4:会话在那台上建(绑定是路由真源)
    await render('sandbox', 'out/a.png')
    expect(img()).toBe('blob:thumb')
    expect(calls).toEqual([`${API}/units/${U}/proxy/engine/agent/workspace/read?sessionId=s1&appId=tangu&path=out%2Fa.png`])
    expect(calls.some((u) => /token=/.test(u))).toBe(false)
  })

  it('unit + host 文件:读那台电脑的 /unit/hostfile(不是本机 window.tangu.readHostFile)', async () => {
    const local = vi.fn()
    ;(window as any).tangu = { mobile: true, readHostFile: local }
    await T.setFocusTarget({ kind: 'unit', unitId: U })
    T.bindSession('s1', { kind: 'unit', unitId: U })
    await render('host', '/Users/mac/proj/a.png')
    expect(img()).toBe('blob:thumb')
    expect(calls).toEqual([`${API}/units/${U}/proxy/unit/hostfile?path=%2FUsers%2Fmac%2Fproj%2Fa.png`])
    expect(local).not.toHaveBeenCalled()
  })

  it('焦点在本端(云端 home):沙箱文件照旧直链,不额外读字节', async () => {
    await render('sandbox', 'out/a.png')
    expect(img()).toBe(`${API}/agent/workspace/download?sessionId=s1&appId=tangu&path=out%2Fa.png`)
    expect(calls).toEqual([])
  })

  it('桌面本机 host 文件照旧走 window.tangu.readHostFile', async () => {
    const local = vi.fn(async () => ({ mimeType: 'image/png', content: 'iVBORw0K', size: 6 }))
    ;(window as any).tangu = { readHostFile: local }
    await render('host', '/Users/me/a.png')
    expect(local).toHaveBeenCalledWith('/Users/me/a.png')
    expect(img()).toBe('blob:thumb')
    expect(calls).toEqual([])
  })
})
