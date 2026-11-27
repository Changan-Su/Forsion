import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import { release } from 'node:os'

/** macOS 红绿灯的尺寸(pt):macOS 26(Darwin 25)起直径 14、间距 23;之前 12 / 20。 */
export function macLightMetrics(darwinRelease: string = release()): { size: number; pitch: number } {
  return parseInt(darwinRelease, 10) >= 25 ? { size: 14, pitch: 23 } : { size: 12, pitch: 20 }
}

/** 红绿灯中心对齐窗口顶条的中线 centerY(窗口 DIP),左距 = 上距(macOS 原生窗口的惯例,2026-11-27 方案 C)。
 * Electron 的按钮位置只收整数;end = 第三颗灯的右缘,渲染层据此给标签行让位。 */
export function macTrafficLightPosition(centerY: number, metrics = macLightMetrics()): { x: number; y: number; end: number } {
  const y = Math.max(0, Math.round(centerY - metrics.size / 2))
  return { x: y, y, end: y + metrics.pitch * 2 + metrics.size }
}

/** 渲染层报来的顶条中线:有限数、落在合理范围内才认(界面缩放 0.5–2 × 32–38px 的行)。 */
export function parseTrafficLightCenter(input: unknown): number | null {
  if (!input || typeof input !== 'object') return null
  const { centerY } = input as Record<string, unknown>
  return typeof centerY === 'number' && Number.isFinite(centerY) && centerY >= 6 && centerY <= 64 ? centerY : null
}

/** Keep native Windows caption buttons (including Snap Layouts) inside the tab row.
 * macOS: the first frame already centers the lights on the 32px tab row at 100% UI zoom; the renderer
 * re-centers them on the measured row once it knows the real zoom (installMacTrafficLights). */
export function tabTitleBarOptions(platform: NodeJS.Platform = process.platform, metrics = macLightMetrics()): BrowserWindowConstructorOptions {
  if (platform === 'win32') return { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#383837', height: 32 } }
  if (platform !== 'darwin') return { titleBarStyle: 'default' }
  const { x, y } = macTrafficLightPosition(16, metrics)
  return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x, y } }
}

/** Floating panels (settings / store / side chat): macOS lights centered on the 38px .floating-native-chrome. */
export function floatingTitleBarOptions(platform: NodeJS.Platform = process.platform, metrics = macLightMetrics()): BrowserWindowConstructorOptions {
  if (platform !== 'darwin') return { titleBarStyle: 'default' }
  const { x, y } = macTrafficLightPosition(19, metrics)
  return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x, y } }
}

export function watchTabTitleBar(win: BrowserWindow): void {
  if (process.platform !== 'win32') return
  // Chromium can retain the WCO rect in OS fullscreen even though the buttons
  // are hidden. Report the actual native state instead of reserving that gap.
  const report = (fullscreen: boolean): void => { if (!win.isDestroyed()) win.webContents.send('window:tabTitleBarFullscreen', fullscreen) }
  win.on('enter-full-screen', () => report(true))
  win.on('leave-full-screen', () => report(false))
}

export function parseTabTitleBar(input: unknown): { height: number; symbolColor: string; wholeUnit?: boolean } | null {
  if (!input || typeof input !== 'object') return null
  const { height, symbolColor, wholeUnit } = input as Record<string, unknown>
  if (typeof height !== 'number' || !Number.isInteger(height) || height < 16 || height > 128) return null
  if (typeof symbolColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(symbolColor)) return null
  if (wholeUnit !== undefined && typeof wholeUnit !== 'boolean') return null
  return { height, symbolColor, ...(typeof wholeUnit === 'boolean' ? { wholeUnit } : {}) }
}
