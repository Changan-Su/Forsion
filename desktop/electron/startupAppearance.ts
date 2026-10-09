import { app, BrowserWindow, ipcMain, nativeImage, shell, systemPreferences } from 'electron'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createSerialQueue, writePrivateJson } from './configWrite'
import { DEFAULT_APPEARANCE, patchAppearance, readAppearance, type StartupAppearance } from '../shared/startupAppearance'
import { roundIconBitmap } from '../shared/iconShape'
import { keepMacIcon, keepWindowsIcon } from './systemIcon'

// Until the GPU process has reported, Chromium answers "disabled" for every feature, so asking early made
// hardware-accelerated machines look like software rendering. Registered at import: the report can beat `ready`.
let gpuReported = false
app.on('gpu-info-update', () => { gpuReported = true })

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
    if (!value.nativeIcon) return defaultIcon
    // Also cover previously saved square icons without rewriting the user's preference.
    const bitmap = icon.toBitmap({ scaleFactor: 1 })
    roundIconBitmap(bitmap, size.width, size.height)
    return nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height, scaleFactor: 1 })
  }
  let activeIcon = defaultIcon
  try { activeIcon = decode(state) } catch { state = { ...state, icon: null } }
  const apply = (icon: Electron.NativeImage): void => {
    if (icon.isEmpty()) return
    if (process.platform === 'darwin') app.dock?.setIcon(icon)
    else for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.setIcon(icon)
  }
  // The icon set above dies with the process: the same picture also goes to the system (see systemIcon.ts), again on
  // every launch because an update undoes it. Packaged builds only — in development the bundle is Electron's own.
  let keeping: Promise<void> = Promise.resolve()
  const keep = (): void => {
    if (!app.isPackaged) return
    const icon = state.icon && state.nativeIcon ? activeIcon : null
    const key = icon ? state.icon!.image : null
    const dir = app.getPath('userData')
    keeping = keeping.then(async () => {
      if (process.platform === 'darwin') {
        const bundle = resolve(process.execPath, '../../..')
        if (bundle.endsWith('.app')) await keepMacIcon({ bundle, dir }, key, () => icon!.toPNG())
      } else if (process.platform === 'win32') {
        const roaming = app.getPath('appData'), programs = 'Microsoft/Windows/Start Menu/Programs'
        const size = Math.min(256, icon?.getSize().width ?? 256)
        await keepWindowsIcon({
          shell, exe: process.execPath, dir,
          folders: [
            app.getPath('desktop'), join(roaming, programs), join(roaming, 'Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar'),
            // Installed for all users: usually not writable from here, and then left as they are.
            ...(process.env.ProgramData ? [join(process.env.ProgramData, programs)] : []),
            ...(process.env.PUBLIC ? [join(process.env.PUBLIC, 'Desktop')] : []),
          ],
        }, key, () => (icon!.getSize().width > size ? icon!.resize({ width: size, height: size }) : icon!).toPNG(), size)
      }
    }).catch((error) => console.error('[appearance] System icon not saved', error))
  }
  apply(activeIcon)
  keep()
  app.on('browser-window-created', (_event, win) => {
    if (process.platform !== 'darwin' && !activeIcon.isEmpty()) win.setIcon(activeIcon)
  })
  // Read-only public visual data, also available in preload before its page has a URL.
  ipcMain.on('appearance:initial', (event) => { event.returnValue = state })
  ipcMain.on('appearance:reducedMotion', (event) => {
    event.returnValue = systemPreferences.getAnimationSettings().prefersReducedMotion
  })
  ipcMain.on('appearance:softwareRendering', (event) => {
    event.returnValue = process.platform === 'win32' && gpuReported && /^(disabled|unavailable)/.test(String(app.getGPUFeatureStatus().gpu_compositing))
  })
  // The window is created hidden and shown after its first paint; the splash counts its minimum stay from then.
  ipcMain.handle('appearance:shown', (event) => new Promise<number>((resolve) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isVisible()) resolve(0)
    else win.once('show', () => resolve(Date.now()))
  }))
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
      keep()
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('appearance:changed', state)
      return state
    })
  })
}
