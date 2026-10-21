import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'

/** Keep native Windows caption buttons (including Snap Layouts) inside the tab row. */
export function tabTitleBarOptions(platform: NodeJS.Platform = process.platform): BrowserWindowConstructorOptions {
  return platform === 'win32'
    ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#383837', height: 32 } }
    : { titleBarStyle: platform === 'darwin' ? 'hiddenInset' : 'default' }
}

export function watchTabTitleBar(win: BrowserWindow): void {
  if (process.platform !== 'win32') return
  // Chromium can retain the WCO rect in OS fullscreen even though the buttons
  // are hidden. Report the actual native state instead of reserving that gap.
  const report = (fullscreen: boolean): void => { if (!win.isDestroyed()) win.webContents.send('window:tabTitleBarFullscreen', fullscreen) }
  win.on('enter-full-screen', () => report(true))
  win.on('leave-full-screen', () => report(false))
}

export function parseTabTitleBar(input: unknown): { height: number; symbolColor: string } | null {
  if (!input || typeof input !== 'object') return null
  const { height, symbolColor } = input as Record<string, unknown>
  if (typeof height !== 'number' || !Number.isInteger(height) || height < 16 || height > 128) return null
  if (typeof symbolColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(symbolColor)) return null
  return { height, symbolColor }
}
