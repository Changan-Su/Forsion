import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { clampAmbientRect, paletteFromRgba } from '../shared/ambientPalette'

/** Only the requesting window's visible page. No desktop capture, disk writes,
 * image IPC, or overlapping captures; hidden/minimized windows cost nothing. */
export function installAmbientPalette(trusted: (event: IpcMainInvokeEvent) => boolean): void {
  const pending = new Set<number>()
  const last = new Map<number, number>()
  ipcMain.handle('ui:ambientPalette', async (event, raw: unknown) => {
    if (!trusted(event)) return null
    const sender = event.sender
    const win = BrowserWindow.fromWebContents(sender)
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || pending.has(sender.id)) return null
    if (Date.now() - (last.get(sender.id) ?? 0) < 240) return null
    const [width, height] = win.getContentSize()
    const rect = clampAmbientRect(raw, width, height)
    if (!rect) return null
    if (!last.has(sender.id)) sender.once('destroyed', () => { last.delete(sender.id); pending.delete(sender.id) })
    last.set(sender.id, Date.now())
    pending.add(sender.id)
    try {
      const image = await sender.capturePage(rect)
      if (image.isEmpty()) return null
      const small = image.resize({ width: 12, height: 18, quality: 'good' })
      const bitmap = small.toBitmap()
      // NativeImage bitmap is BGRA on the supported little-endian desktops.
      const rgba = new Uint8Array(bitmap.length)
      for (let i = 0; i < bitmap.length; i += 4) {
        rgba[i] = bitmap[i + 2]; rgba[i + 1] = bitmap[i + 1]; rgba[i + 2] = bitmap[i]; rgba[i + 3] = bitmap[i + 3]
      }
      return paletteFromRgba(rgba, 12, 18)
    } catch { return null } finally { pending.delete(sender.id) }
  })
}
