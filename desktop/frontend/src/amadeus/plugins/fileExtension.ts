import type { ExtendViewController, ExtendViewHandle } from '@lcl/engine/extendView'

/** A file mount must not retain the leaf's controller after navigation or plugin disable. */
export function scopeFileExtension(owner: ExtendViewController) {
  let live = true
  let handle: ExtendViewHandle | undefined
  const controller: ExtendViewController = {
    open(options) {
      if (!live) throw new Error('File view closed')
      handle = owner.open(options)
      return handle
    },
    close() { if (live) handle?.close() },
  }
  return { controller, dispose() { live = false; handle?.close(); handle = undefined } }
}
