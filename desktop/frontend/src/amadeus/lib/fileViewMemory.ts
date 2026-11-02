/** Local reading positions belong to the device, never the document payload.
 * One storage key per file/kind: a window writing one file cannot overwrite another window's state.
 * Pending writes are readable immediately, including a Space switch inside the debounce interval. */
export interface FileViewStates {
  drawing: { x: number; y: number; z: number }
  image: { actual: boolean; top: number; left: number }
  /** top/left are PDF page coordinates, independent of pane width and zoom. */
  pdf: { page: number; scale: string; top: number; left: number }
  media: { time: number; rate: number }
}
export type FileViewKind = keyof FileViewStates
const PREFIX = 'amx.fileView.v1:'
const pending = new Map<string, string>()
let timer: ReturnType<typeof setTimeout> | undefined

export function fileViewKey(kind: FileViewKind, root: string | null | undefined, path: string, context = ''): string {
  return root && path ? PREFIX + JSON.stringify([kind, root, path, context]) : ''
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
function valid(kind: FileViewKind, value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  switch (kind) {
    case 'drawing': return finite(v.x) && finite(v.y) && finite(v.z) && v.z >= 0.1 && v.z <= 30
    case 'image': return typeof v.actual === 'boolean' && finite(v.top) && v.top >= 0 && finite(v.left) && v.left >= 0
    case 'pdf': return finite(v.page) && Number.isInteger(v.page) && v.page >= 1 && finite(v.top) && finite(v.left)
      && typeof v.scale === 'string' && (['auto', 'page-fit', 'page-width', 'page-actual'].includes(v.scale) || (Number(v.scale) > 0 && Number(v.scale) <= 10))
    case 'media': return finite(v.time) && v.time >= 0 && finite(v.rate) && v.rate >= 0.0625 && v.rate <= 16
  }
}

export function readFileView<K extends FileViewKind>(kind: K, key: string): FileViewStates[K] | null {
  if (!key) return null
  try {
    const raw = pending.get(key) ?? localStorage.getItem(key)
    const value: unknown = raw ? JSON.parse(raw) : null
    return valid(kind, value) ? value as FileViewStates[K] : null
  } catch { return null }
}

export function writeFileView<K extends FileViewKind>(kind: K, key: string, value: FileViewStates[K]): void {
  if (!key || !valid(kind, value)) return
  pending.set(key, JSON.stringify(value))
  if (!timer) timer = setTimeout(flushFileViews, 500)
}

export function flushFileViews(): void {
  clearTimeout(timer); timer = undefined
  for (const [key, value] of pending) {
    try { localStorage.setItem(key, value); pending.delete(key) } catch { /* Keep session memory when storage is unavailable. */ }
  }
}

/** Run before path broadcasts/remounts, including folder moves. No document bytes are changed. */
export function remapFileViews(root: string | null, from: string, to: string, prefix: boolean): void {
  if (!root || from === to) return
  const keys = new Set(pending.keys())
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith(PREFIX)) keys.add(k) } } catch { /* pending still usable */ }
  const move = (p: string): string => p === from || (prefix && p.startsWith(from + '/')) ? to + p.slice(from.length) : p
  for (const key of keys) {
    try {
      const [kind, r, path, context] = JSON.parse(key.slice(PREFIX.length)) as string[]
      if (r !== root) continue
      const next = fileViewKey(kind as FileViewKind, r, move(path), move(context))
      if (next === key) continue
      const raw = pending.get(key) ?? localStorage.getItem(key)
      if (!raw) continue
      // Only remove the old record after the replacement is safely stored.
      localStorage.setItem(next, raw)
      localStorage.removeItem(key)
      pending.delete(key)
    } catch { /* A failed read is unknown; leave the record untouched. */ }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushFileViews)
  window.addEventListener('beforeunload', flushFileViews)
}
