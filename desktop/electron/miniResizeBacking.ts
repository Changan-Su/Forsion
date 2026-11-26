import type { Rect } from './windowGeometry'

interface FrameSize {
  width: number
  height: number
}

interface ResizeCompositor {
  setNativeBackground(color: string): void
  watchPresentedFrames(callback: (size: FrameSize) => void, radius: number): () => void
  canClearWithoutFrame(): boolean
}

const TRANSPARENT = '#00000000'
const MAX_RELEASE_WAIT_MS = 300

/** The capture can already have the requested size while some of its pixels
 * still contain the transparent strips from an older presentation. */
export function miniFrameCoversEdges(bitmap: Uint8Array, { width, height }: FrameSize, radius: number): boolean {
  const inset = Math.ceil(radius) + 2 // Exclude the antialiased rounded corners.
  if (width <= inset * 2 || height <= inset * 2 || bitmap.length !== width * height * 4) return false
  const painted = (x: number, y: number): boolean => bitmap[(y * width + x) * 4 + 3] >= 224
  for (let x = inset; x < width - inset; x++) {
    if (!painted(x, 0) || !painted(x, height - 1)) return false
  }
  for (let y = inset; y < height - inset; y++) {
    if (!painted(0, y) || !painted(width - 1, y)) return false
  }
  return true
}

/**
 * Windows can present newly enlarged HWND bounds before Chromium has painted
 * a matching frame. Give the rounded native region a theme-coloured backing
 * for that interval while keeping the web contents transparent.
 */
export function createMiniResizeBacking(compositor: ResizeCompositor) {
  let color = '#fbf8f5'
  let active = false
  let cancelRelease: (() => void) | undefined

  const clear = (): void => {
    cancelRelease?.()
    cancelRelease = undefined
    if (!active) return
    active = false
    compositor.setNativeBackground(TRANSPARENT)
  }

  return {
    setColor(next: string): void {
      if (next === color) return
      color = next
      if (active) compositor.setNativeBackground(color)
    },
    begin(): void {
      cancelRelease?.()
      cancelRelease = undefined
      if (active) return
      active = true
      compositor.setNativeBackground(color)
    },
    settle(bounds: Pick<Rect, 'width' | 'height'>, radius: number): void {
      if (!active) return
      cancelRelease?.()
      const sameSize = (frame: FrameSize): boolean =>
        frame.width === bounds.width && frame.height === bounds.height
      let stop: (() => void) | undefined
      const timer = setTimeout(() => {
        if (cancelRelease !== cancel) return
        if (compositor.canClearWithoutFrame()) clear()
        else {
          // Stop capturing if Chromium stalls. Preserve the backing under the
          // visible rounded region until the next gesture or window transition.
          cancelRelease = undefined
          cancel()
        }
      }, MAX_RELEASE_WAIT_MS)
      const cancel = (): void => { clearTimeout(timer); stop?.() }
      cancelRelease = cancel
      stop = compositor.watchPresentedFrames((frame) => {
        if (cancelRelease === cancel && sameSize(frame)) clear()
      }, radius)
      if (cancelRelease !== cancel) stop()
    },
    clear,
  }
}
