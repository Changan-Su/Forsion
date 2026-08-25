import { describe, expect, it, vi } from 'vitest'
import { applyWindowMaterial, parseWindowMaterialRequest, type MaterialWindow } from './windowMaterial'

function fakeWindow(): MaterialWindow & {
  setBackgroundColor: ReturnType<typeof vi.fn>
  setVibrancy: ReturnType<typeof vi.fn>
} {
  return {
    isDestroyed: () => false,
    setBackgroundColor: vi.fn(),
    setVibrancy: vi.fn(),
  }
}

describe('window material', () => {
  it('只接受白名单材质与明暗值', () => {
    expect(parseWindowMaterialRequest({ material: 'system-glass', mode: 'dark' }))
      .toEqual({ material: 'system-glass', mode: 'dark' })
    expect(parseWindowMaterialRequest({ material: 'blur(999px)', mode: 'dark' })).toBeNull()
    expect(parseWindowMaterialRequest({ material: 'opaque', mode: 'auto' })).toBeNull()
    expect(parseWindowMaterialRequest({ material: 'opaque', mode: 'light', backgroundColor: '#FBF5EF' }))
      .toEqual({ material: 'opaque', mode: 'light', backgroundColor: '#fbf5ef' })
    expect(parseWindowMaterialRequest({ material: 'opaque', mode: 'light', backgroundColor: 'red;url(x)' })).toBeNull()
    expect(parseWindowMaterialRequest(null)).toBeNull()
  })

  it('macOS 系统玻璃使用透明窗口底 + 高透 sidebar vibrancy', () => {
    const win = fakeWindow()
    applyWindowMaterial(win, { material: 'system-glass', mode: 'light' }, 'darwin')
    expect(win.setBackgroundColor).toHaveBeenCalledWith('#00000000')
    expect(win.setVibrancy).toHaveBeenCalledWith('sidebar', { animationDuration: 180 })
  })

  it('撤下玻璃与非 macOS 降级均按明暗恢复实色窗口底', () => {
    const mac = fakeWindow()
    applyWindowMaterial(mac, { material: 'opaque', mode: 'dark' }, 'darwin')
    expect(mac.setVibrancy).toHaveBeenCalledWith(null, { animationDuration: 140 })
    expect(mac.setBackgroundColor).toHaveBeenCalledWith('#252327')

    const win = fakeWindow()
    applyWindowMaterial(win, { material: 'system-glass', mode: 'light' }, 'win32')
    expect(win.setVibrancy).not.toHaveBeenCalled()
    expect(win.setBackgroundColor).toHaveBeenCalledWith('#fbf8f5')
  })

  it('实色窗口底优先跟随当前 skin，而不是写死 cream', () => {
    const mac = fakeWindow()
    applyWindowMaterial(mac, { material: 'opaque', mode: 'light', backgroundColor: '#fbf5ef' }, 'darwin')
    expect(mac.setBackgroundColor).toHaveBeenCalledWith('#fbf5ef')

    const win = fakeWindow()
    applyWindowMaterial(win, { material: 'system-glass', mode: 'dark', backgroundColor: '#141414' }, 'win32')
    expect(win.setBackgroundColor).toHaveBeenCalledWith('#141414')
  })
})
