// @vitest-environment happy-dom
import React, { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DesktopPermissions } from './DesktopPermissions'
import { LocaleProvider, setLocaleGlobal } from '../i18n'
import type { DesktopPermissionId, DesktopPermissionsSnapshot, DesktopPermissionState } from '../types'

function snapshot(patch: Partial<DesktopPermissionsSnapshot> = {}): DesktopPermissionsSnapshot {
  return {
    platform: 'darwin', appName: 'Forsion', computerUseAvailable: true, helperInstalled: true, helperRunning: true,
    permissions: { computerAccessibility: 'granted', computerScreen: 'unverified', microphone: 'not-determined', camera: 'denied', screen: 'not-required' },
    ...patch,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

let host: HTMLDivElement
let root: Root
let mounted: boolean
const status = vi.fn<() => Promise<DesktopPermissionsSnapshot>>()
const request = vi.fn<NonNullable<NonNullable<Window['tangu']>['desktopPermissionRequest']>>()
const verify = vi.fn<() => Promise<DesktopPermissionsSnapshot>>()
const closeGuide = vi.fn<() => Promise<void>>()

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  setLocaleGlobal('zh')
  status.mockReset().mockResolvedValue(snapshot())
  request.mockReset().mockResolvedValue(snapshot())
  verify.mockReset().mockResolvedValue(snapshot({ permissions: { ...snapshot().permissions, computerScreen: 'granted' } }))
  closeGuide.mockReset().mockResolvedValue(undefined)
  window.tangu = { desktopPermissionsStatus: status, desktopPermissionRequest: request, desktopPermissionsVerify: verify, desktopPermissionsCloseGuide: closeGuide } as unknown as Window['tangu']
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mounted = true
})
afterEach(async () => {
  if (mounted) await act(async () => root.unmount())
  host.remove()
  delete window.tangu
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function mount(strict = false, mode: 'light' | 'dark' = 'light') {
  let element: React.ReactElement = React.createElement(LocaleProvider, { children: React.createElement(DesktopPermissions, { mode }) })
  if (strict) element = React.createElement(StrictMode, {}, element)
  await act(async () => root.render(element))
}
async function unmount() {
  await act(async () => root.unmount())
  mounted = false
}
const row = (id: DesktopPermissionId) => host.querySelector<HTMLElement>(`[data-permission="${id}"]`)!
async function click(label: string, within: HTMLElement = host) {
  const button = [...within.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label)
  expect(button, `Missing button: ${label}`).toBeTruthy()
  expect(button!.disabled).toBe(false)
  await act(async () => button!.click())
}
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

describe('DesktopPermissions', () => {
  it('mounts read-only, separates permission owners and explicitly verifies unverified screen access', async () => {
    await mount()
    expect(status).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
    expect(host.textContent).toContain('tangu-computer-use')
    expect(host.textContent).toContain('Forsion · 可选权限')
    expect(row('computerScreen').querySelector('[data-state="unverified"]')?.textContent).toBe('待验证')
    expect(row('computerScreen').textContent).toContain('尚未验证实际屏幕访问')
    expect(row('screen').querySelector('button')).toBeNull()
    await click('验证 Computer Use 权限')
    expect(verify).toHaveBeenCalledTimes(1)
    expect(row('computerScreen').querySelector('[data-state="granted"]')).not.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it('serializes passive reads across focus, visibility and polling; pauses in background', async () => {
    const pending = deferred<DesktopPermissionsSnapshot>()
    status.mockReturnValueOnce(pending.promise)
    await mount()
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await advance(9000)
    expect(status).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve(snapshot()))
    await advance(3000)
    expect(status).toHaveBeenCalledTimes(2)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await advance(9000)
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(status).toHaveBeenCalledTimes(2)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(status).toHaveBeenCalledTimes(3)
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(status).toHaveBeenCalledTimes(4)
    expect(request).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
  })

  it('shows a read failure independently of denied permissions and supports an explicit retry', async () => {
    status.mockRejectedValueOnce(new Error('IPC unavailable'))
    await mount()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('IPC unavailable')
    expect(host.querySelector('[data-state="denied"]')).toBeNull()
    await click('重试读取')
    expect(row('microphone').querySelector('[data-state="not-determined"]')).not.toBeNull()
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps the last known grants when a later read fails', async () => {
    await mount()
    status.mockRejectedValueOnce(new Error('Status unavailable'))
    await click('刷新状态')
    expect(row('computerAccessibility').querySelector('[data-state="granted"]')).not.toBeNull()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('已有结果可能已过期')
  })

  it('sets busy immediately, prevents double requests and polling, and forwards the current locale and mode', async () => {
    const pending = deferred<DesktopPermissionsSnapshot>()
    request.mockReturnValueOnce(pending.promise)
    await mount(false, 'dark')
    await act(async () => setLocaleGlobal('en'))
    const button = row('microphone').querySelector<HTMLButtonElement>('button')!
    await act(async () => { button.click(); button.click() })
    expect(request).toHaveBeenCalledExactlyOnceWith('microphone', { locale: 'en', mode: 'dark' })
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Opening permission setup')
    expect([...host.querySelectorAll<HTMLButtonElement>('button')].every((item) => item.disabled)).toBe(true)
    await advance(6000)
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(status).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve(snapshot()))
    expect(row('microphone').querySelector<HTMLButtonElement>('button')!.disabled).toBe(false)
  })

  it('does not overwrite a user action with a stale passive read, including a read failure', async () => {
    await mount()
    const oldRead = deferred<DesktopPermissionsSnapshot>()
    status.mockReturnValueOnce(oldRead.promise)
    await act(async () => window.dispatchEvent(new Event('focus')))
    await click('验证 Computer Use 权限')
    await act(async () => oldRead.resolve(snapshot()))
    expect(row('computerScreen').querySelector('[data-state="granted"]')).not.toBeNull()
    const failedRead = deferred<DesktopPermissionsSnapshot>()
    status.mockReturnValueOnce(failedRead.promise)
    await act(async () => window.dispatchEvent(new Event('focus')))
    await click('验证 Computer Use 权限')
    await act(async () => failedRead.reject(new Error('Old failure')))
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it.each(['request', 'verify'] as const)('retries a failed %s without losing the error on passive refresh', async (action) => {
    const mock = action === 'verify' ? verify : request
    mock.mockRejectedValueOnce(new Error('Guide unavailable'))
    await mount()
    if (action === 'verify') await click('验证 Computer Use 权限')
    else await click('打开系统设置', row('camera'))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Guide unavailable')
    expect(row('computerScreen').querySelector('[data-state="unverified"]')).not.toBeNull()
    await advance(3000)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Guide unavailable')
    await click('重试操作')
    expect(mock).toHaveBeenCalledTimes(2)
    if (action === 'request') expect(request).toHaveBeenLastCalledWith('camera', { locale: 'zh', mode: 'light' })
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('offers helper installation only on an explicit CU click', async () => {
    status.mockResolvedValue(snapshot({ helperInstalled: false, helperRunning: false, helperError: 'not-installed' }))
    await mount()
    await advance(6000)
    expect(request).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Computer Use 尚未安装')
    expect(row('microphone').textContent).not.toContain('安装')
    await click('安装并设置权限', row('computerAccessibility'))
    expect(request).toHaveBeenCalledWith('computerAccessibility', { locale: 'zh', mode: 'light' })
  })

  it.each(['outdated', 'wrong-identity', 'unreachable'] as const)('reports helper %s as a helper problem, not a denial', async (helperError) => {
    status.mockResolvedValue(snapshot({ helperError, permissions: { ...snapshot().permissions, computerAccessibility: 'unknown' } }))
    await mount()
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    expect(row('computerAccessibility').querySelector('[data-state="denied"]')).toBeNull()
    expect(row('computerAccessibility').querySelector('button')).not.toBeNull()
  })

  it('shows Windows CU capabilities and limitations without a macOS helper or no-op actions', async () => {
    status.mockResolvedValue(snapshot({ platform: 'win32', helperInstalled: false, helperRunning: false }))
    await mount()
    expect(row('computerAccessibility')).toBeNull()
    expect(row('computerScreen')).toBeNull()
    expect(host.textContent).toContain('Windows 隐私设置')
    expect(host.textContent).toContain('Windows 无需额外的 macOS')
    expect(host.textContent).toContain('UAC')
    expect(host.textContent).not.toContain('尚未安装')
    expect(host.textContent).not.toContain('验证 Computer Use 权限')
    expect(host.querySelector('.desktop-permissions-section')?.querySelector('button')).toBeNull()
  })

  it.each([
    { helperInstalled: false, helperRunning: false, helperError: 'not-installed' },
    { helperInstalled: true, helperRunning: false, helperError: 'not-running' },
    { helperInstalled: true, helperRunning: true, helperError: 'outdated' },
    { helperInstalled: true, helperRunning: true, helperError: 'wrong-identity' },
    { helperInstalled: true, helperRunning: true, helperError: 'unreachable' },
  ] satisfies Partial<DesktopPermissionsSnapshot>[] )('requires setup before verification when helper is $helperError', async (patch) => {
    status.mockResolvedValue(snapshot(patch))
    await mount()
    const button = host.querySelector<HTMLButtonElement>('.desktop-permissions-verify button')!
    expect(button.disabled).toBe(true)
    await act(async () => button.click())
    expect(verify).not.toHaveBeenCalled()
    expect(host.querySelector('.desktop-permissions-verify')?.textContent).toContain('请先点击')
  })

  it('disables a verification retry if a later read reports that the helper stopped', async () => {
    await mount()
    verify.mockRejectedValueOnce(new Error('Disconnected'))
    await click('验证 Computer Use 权限')
    status.mockResolvedValue(snapshot({ helperRunning: false, helperError: 'not-running' }))
    await advance(3000)
    const retry = host.querySelector<HTMLButtonElement>('.desktop-permissions-error button')!
    expect(retry.disabled).toBe(true)
    await act(async () => retry.click())
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('offers no invalid media requests on Linux when the host returns unavailable', async () => {
    status.mockResolvedValue(snapshot({ platform: 'linux', computerUseAvailable: false,
      permissions: { ...snapshot().permissions, microphone: 'unavailable', camera: 'unavailable', screen: 'not-required' } }))
    await mount()
    for (const id of ['microphone', 'camera', 'screen'] as const) expect(row(id).querySelector('button')).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    { platform: 'linux', computerUseAvailable: true },
    { platform: 'darwin', computerUseAvailable: false },
    { platform: 'win32', computerUseAvailable: false },
  ])('filters CU for $platform / available=$computerUseAvailable without losing optional media', async (patch) => {
    status.mockResolvedValue(snapshot(patch))
    await mount()
    expect(row('computerAccessibility')).toBeNull()
    expect(row('computerScreen')).toBeNull()
    expect(row('microphone')).not.toBeNull()
    expect(row('camera')).not.toBeNull()
    expect(row('screen')).not.toBeNull()
  })

  it.each(['granted', 'denied', 'not-determined', 'restricted', 'unknown', 'unverified', 'unavailable', 'not-required'] satisfies DesktopPermissionState[])(
    'renders %s without collapsing it into a grant or denial', async (state) => {
      status.mockResolvedValue(snapshot({ permissions: { ...snapshot().permissions, microphone: state } }))
      await mount()
      expect(row('microphone').querySelector(`[data-state="${state}"]`)).not.toBeNull()
      expect(row('microphone').textContent).not.toContain('desktopPermissions.')
      if (state === 'unavailable' || state === 'not-required') expect(row('microphone').querySelector('button')).toBeNull()
    },
  )

  it.each(['missing', 'cloudWeb', 'mobile', 'unitPage'] as const)('renders nothing and makes no host calls for %s', async (kind) => {
    if (kind === 'missing') delete window.tangu!.desktopPermissionsStatus
    else window.tangu![kind] = true
    await mount()
    expect(host.textContent).toBe('')
    expect(status).not.toHaveBeenCalled()
    await unmount()
    expect(closeGuide).not.toHaveBeenCalled()
  })

  it('allows a read-only host with absent optional action APIs', async () => {
    delete window.tangu!.desktopPermissionRequest
    delete window.tangu!.desktopPermissionsVerify
    delete window.tangu!.desktopPermissionsCloseGuide
    await mount()
    expect(row('microphone').querySelector('button')).toBeNull()
    expect(host.querySelectorAll('button')).toHaveLength(1)
    await unmount()
  })

  it.each(['read', 'request', 'verify'] as const)('closes the guide immediately on unmount during a pending %s and stops listeners/timers', async (action) => {
    const pending = deferred<DesktopPermissionsSnapshot>()
    if (action === 'read') status.mockReturnValueOnce(pending.promise)
    else if (action === 'request') request.mockReturnValueOnce(pending.promise)
    else verify.mockReturnValueOnce(pending.promise)
    await mount()
    if (action === 'request') await click('打开系统设置', row('microphone'))
    if (action === 'verify') await click('验证 Computer Use 权限')
    await unmount()
    expect(closeGuide).toHaveBeenCalledTimes(1)
    await act(async () => pending.reject(new Error('Late failure')))
    await advance(6000)
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(status).toHaveBeenCalledTimes(1)
    expect(host.textContent).toBe('')
  })

  it('isolates StrictMode effect lifetimes so the discarded read cannot win', async () => {
    const first = deferred<DesktopPermissionsSnapshot>()
    status.mockReturnValueOnce(first.promise)
    await mount(true)
    expect(status).toHaveBeenCalledTimes(2)
    await act(async () => first.resolve(snapshot({ appName: 'Stale app' })))
    expect(host.textContent).not.toContain('Stale app')
    expect(host.textContent).toContain('Forsion · 可选权限')
    expect(closeGuide).toHaveBeenCalledTimes(1)
  })

  it('updates all visible strings in place when switching languages, without new host work', async () => {
    await mount()
    await act(async () => setLocaleGlobal('en'))
    expect(host.textContent).toContain('Needs verification')
    expect(host.textContent).toContain('Forsion · Optional permissions')
    expect(host.textContent).not.toMatch(/[一-龥]|desktopPermissions\./)
    expect(status).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
  })

  it.each(['cream', 'coral', 'teal', 'lavender', 'zhi'].flatMap((skin) => ['light', 'dark'].map((mode) => ({ skin, mode }))))(
    'keeps every action and retry button readable in $skin / $mode using the actual styles', async ({ skin, mode }) => {
      const style = document.createElement('style')
      style.textContent = [
        readFileSync(resolve(__dirname, '../styles/base.css'), 'utf8'),
        readFileSync(resolve(__dirname, '../theme/skins.css'), 'utf8'),
        readFileSync(resolve(__dirname, './desktopPermissions.css'), 'utf8'),
      ].join('\n')
      document.head.append(style)
      const html = document.documentElement
      html.classList.toggle('dark', mode === 'dark')
      html.dataset.skin = skin
      html.dataset.bg = skin
      try {
        await mount()
        request.mockRejectedValueOnce(new Error('Request failed'))
        await click('打开系统设置', row('camera'))
        status.mockRejectedValueOnce(new Error('Read failed'))
        await click('刷新状态')
        const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')]
        expect(buttons.length).toBeGreaterThanOrEqual(7) // Includes setup, verify, refresh and both retry states.
        for (const button of buttons) {
          // Explicit text styling avoids native/default button ink leaking through theme resets.
          expect(button.classList.contains('ghost'), button.textContent ?? '').toBe(true)
          expect(textContrast(button), `${skin}/${mode}: ${button.textContent}`).toBeGreaterThanOrEqual(4.5)
        }
        if (mode === 'dark') {
          // Negative control: the reported black-text regression must fail this contrast check.
          buttons[0].style.color = 'rgb(0, 0, 0)'
          expect(textContrast(buttons[0])).toBeLessThan(4.5)
          buttons[0].style.removeProperty('color')
        }
      } finally {
        style.remove()
        html.classList.remove('dark')
        delete html.dataset.skin
        delete html.dataset.bg
      }
    },
  )
})

type Rgba = [number, number, number, number]
function rgba(value: string): Rgba {
  if (value === 'transparent' || !value) return [0, 0, 0, 0]
  if (/^#[\da-f]{6}$/i.test(value)) return [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16), 1]
  if (!/^rgba?\(/.test(value)) throw new Error(`Unresolved CSS color: ${value}`)
  const channels = value.match(/[\d.]+/g)!.map(Number)
  return [channels[0], channels[1], channels[2], channels[3] ?? 1]
}
function composite(front: Rgba, back: Rgba): Rgba {
  return [0, 1, 2].map((i) => front[i] * front[3] + back[i] * (1 - front[3])).concat(1) as Rgba
}
function luminance(color: Rgba): number {
  const linear = color.slice(0, 3).map((value) => { const v = value / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}
function textContrast(element: HTMLElement): number {
  const layers: Rgba[] = []
  for (let node: HTMLElement | null = element; node; node = node.parentElement) layers.push(rgba(getComputedStyle(node).backgroundColor))
  const background = layers.reverse().reduce((back, front) => composite(front, back), [255, 255, 255, 1] as Rgba)
  const ink = composite(rgba(getComputedStyle(element).color), background)
  const [high, low] = [luminance(ink), luminance(background)].sort((a, b) => b - a)
  return (high + 0.05) / (low + 0.05)
}
