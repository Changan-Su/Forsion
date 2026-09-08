import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Rectangle } from 'electron'
import type { DesktopPermissionsSnapshot } from '../shared/desktopPermissions'

// Pure geometry/HTML tests only: importing this file never launches Electron.
vi.mock('electron', () => ({ BrowserWindow: class {}, screen: {} }))
import { clampPermissionGuideBounds, permissionGuideBounds, escapePermissionGuideHtml,
  permissionGuideAction, permissionGuideHtml } from './permissionGuide'

const main = { x: 0, y: 25, width: 1440, height: 850 }
const left = { x: -1280, y: 25, width: 1280, height: 800 }
const above = { x: 120, y: -1000, width: 1600, height: 960 }
const inside = (r: Rectangle, area: Rectangle) => {
  expect(r.x).toBeGreaterThanOrEqual(area.x)
  expect(r.y).toBeGreaterThanOrEqual(area.y)
  expect(r.x + r.width).toBeLessThanOrEqual(area.x + area.width)
  expect(r.y + r.height).toBeLessThanOrEqual(area.y + area.height)
}

describe('permission guide placement', () => {
  it('uses the right side when there is room', () => {
    const settings = { x: 100, y: 80, width: 700, height: 600 }
    expect(permissionGuideBounds([main], settings)).toEqual({ x: 812, y: 80, width: 300, height: 520 })
  })
  it('uses the left side when Settings is near the right edge', () => {
    const settings = { x: 650, y: 80, width: 700, height: 600 }
    expect(permissionGuideBounds([main], settings).x).toBe(338)
  })
  it('uses a free bottom side when neither horizontal side fits', () => {
    const settings = { x: 100, y: 40, width: 1200, height: 240 }
    const r = permissionGuideBounds([main], settings)
    expect(r.y).toBe(292)
    inside(r, main)
  })
  it('keeps negative X and Quartz negative Y on their own displays', () => {
    expect(permissionGuideBounds([main, left], { x: -1200, y: 80, width: 650, height: 600 }).x).toBe(-538)
    const r = permissionGuideBounds([main, above], { x: 200, y: -920, width: 800, height: 600 })
    expect(r).toEqual({ x: 1012, y: -920, width: 300, height: 520 })
    inside(r, above)
  })
  it('chooses the display containing most of a spanning Settings window', () => {
    inside(permissionGuideBounds([main, left], { x: -900, y: 100, width: 1100, height: 600 }), left)
  })
  it('clamps Settings that is offscreen, fullscreen, or taller than the work area', () => {
    for (const settings of [
      { x: 1300, y: 800, width: 900, height: 1200 },
      { x: 0, y: 0, width: 1440, height: 900 },
      { x: -5000, y: -5000, width: 600, height: 600 },
    ]) inside(permissionGuideBounds([main], settings), main)
  })
  it('starts at the display edge and preserves a manually dragged fallback', () => {
    expect(permissionGuideBounds([main])).toEqual({ x: 1128, y: 37, width: 300, height: 520 })
    const moved = { x: -800, y: 110, width: 300, height: 520 }
    expect(permissionGuideBounds([main, left], undefined, moved)).toEqual(moved)
    inside(permissionGuideBounds([main], undefined, moved), main) // disconnected display
  })
  it('shrinks on small displays and returns integer bounds for fractional inputs', () => {
    const tiny = { x: -240, y: -200, width: 240, height: 200 }
    expect(permissionGuideBounds([tiny])).toEqual({ x: -228, y: -188, width: 216, height: 176 })
    const r = clampPermissionGuideBounds({ x: 2.3, y: 890.5, width: 300, height: 520 }, main)
    inside(r, main)
    expect(Object.values(r).every(Number.isInteger)).toBe(true)
  })
  it('ignores invalid native bounds and invalid previous coordinates', () => {
    const invalid = { x: NaN, y: 0, width: 600, height: 500 }
    expect(permissionGuideBounds([main], invalid, invalid)).toEqual(permissionGuideBounds([main]))
  })
})

function snapshot(state: DesktopPermissionsSnapshot['permissions']['screen'] = 'unverified'): DesktopPermissionsSnapshot {
  return { platform: 'darwin', appName: 'Electron', computerUseAvailable: false,
    helperInstalled: false, helperRunning: false,
    permissions: { computerAccessibility: 'denied', computerScreen: state, screen: state,
      microphone: 'denied', camera: 'not-determined' } }
}

describe('permission guide content and navigation', () => {
  it('escapes every HTML delimiter, including already escaped input', () => {
    expect(escapePermissionGuideHtml(`<b title="x">Tom & 'Jerry'</b>`))
      .toBe('&lt;b title=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/b&gt;')
    expect(escapePermissionGuideHtml('&lt;')).toBe('&amp;lt;')
  })
  it('only accepts the four exact internal actions', () => {
    for (const action of ['close', 'return', 'open', 'verify']) {
      expect(permissionGuideAction(`https://permission-guide.invalid/${action}`)).toBe(action)
    }
    for (const url of ['https://example.com', 'javascript:alert(1)', 'file:///tmp/test',
      'https://permission-guide.invalid/verify?next=close', 'https://permission-guide.invalid/close#x',
      'https://permission-guide.invalid.evil/close', 'https://permission-guide.invalid@evil/close',
      'https://permission-guide.invalid/next']) expect(permissionGuideAction(url)).toBeUndefined()
  })
  it('uses the snapshot media identity, escapes injected markup, and fixes the CU identity', () => {
    const data = snapshot()
    data.appName = '</strong><script>alert("x")</script>'
    const html = permissionGuideHtml({ id: 'microphone', snapshot: data })
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(permissionGuideHtml({ id: 'computerScreen', snapshot: data })).toContain('<strong>tangu-computer-use</strong>')
  })
  it('honors both locale and mode and treats unverified screen access as incomplete', () => {
    const en = permissionGuideHtml({ id: 'screen', snapshot: snapshot(), options: { locale: 'en', mode: 'dark' } })
    expect(en).toContain('lang="en" data-mode="dark"')
    expect(en).toContain('Not verified')
    expect(en).not.toContain('status success')
    expect(en).not.toContain('This permission is ready')
    expect(en).not.toMatch(/[\u3400-\u9fff]/)
    const zh = permissionGuideHtml({ id: 'screen', snapshot: snapshot('granted'), options: { locale: 'zh', mode: 'light' } })
    expect(zh).toContain('lang="zh" data-mode="light"')
    expect(zh).toContain('主动点击下一项')
  })
  it('keeps close and return available on errors and during verification', () => {
    const html = permissionGuideHtml({ id: 'camera', snapshot: snapshot('granted'), error: 'read', busy: true })
    expect(html).toContain('Could not read permission status')
    expect(html).toContain('href="https://permission-guide.invalid/close"')
    expect(html).toContain('href="https://permission-guide.invalid/return"')
    expect(html).not.toContain('status success')
  })
  it('allows only the exact embedded stylesheet and prohibits scripts and network resources', () => {
    const html = permissionGuideHtml({ id: 'camera' })
    const style = html.match(/<style>([\s\S]*?)<\/style>/)![1]
    expect(html).toContain(`style-src 'sha256-${createHash('sha256').update(style).digest('base64')}'`)
    for (const directive of ['default-src', 'script-src', 'connect-src', 'frame-src', 'form-action', 'base-uri']) {
      expect(html).toContain(`${directive} 'none'`)
    }
    expect(html).not.toContain('unsafe-inline')
  })
})
