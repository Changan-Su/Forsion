import type { Rect } from './windowGeometry'

/** Native transparent-window resizing can take longer than a mouse report.
 * Keep at most one pending frame instead of replaying stale intermediate sizes.
 * Pointer release flushes the final position synchronously.
 */
export function createMiniResizeQueue(apply: (bounds: Rect) => void) {
  let pending: Rect | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
    const next = pending; pending = undefined
    if (next) apply(next)
  }
  return {
    push(bounds: Rect): void {
      pending = bounds
      timer ??= setTimeout(flush, 16)
    },
    flush,
    cancel(): void {
      if (timer) clearTimeout(timer)
      timer = undefined; pending = undefined
    },
  }
}
