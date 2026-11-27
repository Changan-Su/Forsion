import { describe, expect, it } from 'vitest'
import { floatingTitleBarOptions, macLightMetrics, macTrafficLightPosition, parseTabTitleBar, parseTrafficLightCenter, tabTitleBarOptions } from './tabTitleBar'

describe('tab title bar', () => {
  it('enables native overlay only on Windows and preserves other platform chrome', () => {
    expect(tabTitleBarOptions('win32')).toMatchObject({ titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000' } })
    expect(tabTitleBarOptions('darwin', { size: 14, pitch: 23 })).toEqual({ titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 9, y: 9 } })
    expect(floatingTitleBarOptions('darwin', { size: 14, pitch: 23 })).toEqual({ titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 12 } })
    expect(floatingTitleBarOptions('win32')).toEqual({ titleBarStyle: 'default' })
    expect(tabTitleBarOptions('linux')).toEqual({ titleBarStyle: 'default' })
  })
  it('rejects invalid renderer geometry and colors before calling the OS', () => {
    for (const input of [null, {}, { height: NaN, symbolColor: '#ffffff' }, { height: 31.5, symbolColor: '#ffffff' },
      { height: 0, symbolColor: '#ffffff' }, { height: 129, symbolColor: '#ffffff' }, { height: 32, symbolColor: 'var(--text)' }]) {
      expect(parseTabTitleBar(input)).toBeNull()
    }
    expect(parseTabTitleBar({ height: 35, symbolColor: '#eeeeee' })).toEqual({ height: 35, symbolColor: '#eeeeee' })
    expect(parseTabTitleBar({ height: 32, symbolColor: '#eeeeee', wholeUnit: 'true' })).toBeNull()
    expect(parseTabTitleBar({ height: 32, symbolColor: '#eeeeee', wholeUnit: true })).toEqual({ height: 32, symbolColor: '#eeeeee', wholeUnit: true })
  })
  it('centers macOS traffic lights on the measured top bar with equal left and top insets', () => {
    expect(macLightMetrics('27.0.0')).toEqual({ size: 14, pitch: 23 })
    expect(macLightMetrics('24.6.0')).toEqual({ size: 12, pitch: 20 })
    const tahoe = { size: 14, pitch: 23 }
    // 32px 标签行 × 界面缩放 100% / 110% / 120% / 200%
    expect(macTrafficLightPosition(16, tahoe)).toEqual({ x: 9, y: 9, end: 69 })
    expect(macTrafficLightPosition(17.6, tahoe)).toEqual({ x: 11, y: 11, end: 71 })
    expect(macTrafficLightPosition(19.2, tahoe)).toEqual({ x: 12, y: 12, end: 72 })
    expect(macTrafficLightPosition(32, tahoe)).toEqual({ x: 25, y: 25, end: 85 })
    expect(macTrafficLightPosition(16, { size: 12, pitch: 20 })).toEqual({ x: 10, y: 10, end: 62 })
  })
  it('rejects renderer traffic-light geometry outside a plausible top bar', () => {
    for (const input of [null, {}, { centerY: '16' }, { centerY: NaN }, { centerY: Infinity }, { centerY: 2 }, { centerY: 200 }]) {
      expect(parseTrafficLightCenter(input)).toBeNull()
    }
    expect(parseTrafficLightCenter({ centerY: 17.5 })).toBe(17.5)
  })
})
