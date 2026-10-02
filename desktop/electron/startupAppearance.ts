import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSerialQueue, writePrivateJson } from './configWrite'
import { DEFAULT_APPEARANCE, patchAppearance, readAppearance, type StartupAppearance } from '../shared/startupAppearance'

/** Initialized before any windows/preloads. One serialized writer for every app window. */
export async function registerStartupAppearance(isTrusted: (e: Electron.IpcMainInvokeEvent) => boolean): Promise<void> {
  const file = join(app.getPath('userData'), 'startup-appearance.json')
  const defaultIcon = nativeImage.createFromPath(app.isPackaged ? join(process.resourcesPath, 'tray.png') : join(__dirname, '../../build/icon.png'))
  let state: StartupAppearance = { ...DEFAULT_APPEARANCE }
  try { state = readAppearance(JSON.parse(await readFile(file, 'utf8'))) } catch { /* first launch / damaged preference */ }
  const decode = (value: StartupAppearance): Electron.NativeImage => {
    if (!value.icon) return defaultIcon
    // Bound PNG dimensions before native decoding (a tiny compressed file can be enormous).
    const bytes = Buffer.from(value.icon.image.slice('data:image/png;base64,'.length), 'base64')
    if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || bytes.toString('ascii', 12, 16) !== 'IHDR'
      || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(20) < 1
      || bytes.readUInt32BE(16) > 512 || bytes.readUInt32BE(20) > 512) throw new Error('Invalid native icon')
    const icon = nativeImage.createFromDataURL(value.icon.image)
    const size = icon.getSize()
    if (icon.isEmpty() || size.width > 512 || size.height > 512) throw new Error('Invalid native icon')
    return value.nativeIcon ? icon : defaultIcon
  }
  let activeIcon = defaultIcon
  try { activeIcon = decode(state) } catch { state = { ...state, icon: null } }
  const apply = (icon: Electron.NativeImage): void => {
    if (icon.isEmpty()) return
    if (process.platform === 'darwin') app.dock?.setIcon(icon)
    else for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.setIcon(icon)
  }
  apply(activeIcon)
  app.on('browser-window-created', (_event, win) => {
    if (process.platform !== 'darwin' && !activeIcon.isEmpty()) win.setIcon(activeIcon)
  })
  // Read-only public visual data, also available in preload before its page has a URL.
  ipcMain.on('appearance:initial', (event) => { event.returnValue = state })
  const serialize = createSerialQueue()
  ipcMain.handle('appearance:update', (event, patch, clearPlugin?: string) => {
    if (!isTrusted(event)) throw new Error('Untrusted appearance request')
    return serialize(async () => {
      if (clearPlugin && state.icon?.pluginId !== clearPlugin && state.splash?.pluginId !== clearPlugin) return state
      const next = clearPlugin ? {
        ...state,
        icon: state.icon?.pluginId === clearPlugin ? null : state.icon,
        splash: state.splash?.pluginId === clearPlugin ? null : state.splash,
      } : patchAppearance(state, patch)
      const icon = decode(next)
      await writePrivateJson(file, next)
      state = next
      activeIcon = icon
      apply(icon)
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('appearance:changed', state)
      return state
    })
  })
}
