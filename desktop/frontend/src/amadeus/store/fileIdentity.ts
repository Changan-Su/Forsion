/** Reference addresses are scoped to the source directory; file identities are
 * assigned only after the host resolves the reference. Basename references use
 * the host's vault-wide lookup, and standalone views pass path as both arguments. */
export function fileReferenceKey(pagePath: string, ref: string): string {
  const page = pagePath.replace(/\\/g, '/')
  const target = ref.replace(/\\/g, '/')
  if (page === target || !target.includes('/')) return target
  return `${page.slice(0, page.lastIndexOf('/') + 1)}\0${target}`
}

let sequence = 0
export const newFileIdentity = (): string => `\0file:${++sequence}`

export interface FileEntryIdentity { path: string | null; identity?: string }

/** All public reference aliases point at one immutable entry. Queues use its
 * stable identity, which survives moves and cannot collide with a reused path. */
export function publishFileEntry<T extends FileEntryIdentity>(entries: Record<string, T>, key: string, entry: T): Record<string, T> {
  const next = { ...entries }
  if (entry.identity) {
    for (const [alias, previous] of Object.entries(next)) {
      if (previous.identity === entry.identity) next[alias] = entry
    }
    next[entry.identity] = entry
  }
  next[key] = entry
  if (entry.path) next[entry.path] = entry
  return next
}
