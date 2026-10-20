import type { MiniDockMotion } from '../shared/miniDock'
import type { Edge, Rect } from './windowGeometry'

/** Keep the native window INSIDE its display. Only its card moves on the compositor;
 * the collapsed native region exposes the peek strip and passes all other input through.
 * No per-frame SetWindowPos, DPI round-trip, layout reflow or neighbouring-screen pixels. */
export function miniDockFrame(bounds: Rect, edge: Edge, peek: number): { x: number; y: number; clip: Rect } {
  const width = Math.min(peek, bounds.width), height = Math.min(peek, bounds.height)
  switch (edge) {
    case 'left': return { x: width - bounds.width, y: 0, clip: { x: 0, y: 0, width, height: bounds.height } }
    case 'right': return { x: bounds.width - width, y: 0, clip: { x: bounds.width - width, y: 0, width, height: bounds.height } }
    case 'top': return { x: 0, y: height - bounds.height, clip: { x: 0, y: 0, width: bounds.width, height } }
    case 'bottom': return { x: 0, y: bounds.height - height, clip: { x: 0, y: bounds.height - height, width: bounds.width, height } }
  }
}

interface DockWindow {
  isDestroyed(): boolean
  getContentBounds(): Rect
  setShape(rects: Rect[]): void
  webContents: { send(channel: string, request: MiniDockMotion): void }
}

export function createMiniDockMotion(win: DockWindow) {
  let id = 0, waiting = false, clip: Rect | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (done: number): void => {
    if (done !== id || !waiting) return // old completion after reversal, drag, reload or close
    clearTimeout(timer); waiting = false
    if (!win.isDestroyed()) win.setShape(clip ? [clip] : [])
  }
  const reset = (notify = true): void => {
    clearTimeout(timer); waiting = false; clip = null; id++
    if (win.isDestroyed()) return
    win.setShape([])
    if (notify) win.webContents.send('window:miniDockMotion', { id, x: 0, y: 0, animate: false })
  }
  return {
    set(edge: Edge, collapsed: boolean, peek: number): void {
      clearTimeout(timer)
      const frame = miniDockFrame(win.getContentBounds(), edge, peek)
      clip = collapsed ? frame.clip : null
      waiting = true; id++
      win.setShape([]) // release the peek mask BEFORE the opening animation
      win.webContents.send('window:miniDockMotion', { id, x: collapsed ? frame.x : 0, y: collapsed ? frame.y : 0, animate: true })
      // A stalled/reloading renderer must not leave an invisible full-size input blocker.
      const current = id
      timer = setTimeout(() => finish(current), 1200)
      timer.unref?.()
    },
    finish,
    reset,
    pending: () => waiting,
    stop: () => { clearTimeout(timer); waiting = false; id++ },
  }
}
