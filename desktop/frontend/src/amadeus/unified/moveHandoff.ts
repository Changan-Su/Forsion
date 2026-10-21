/** A retiring editor remains the source of truth until its replacement has read it.
 * Keep the reader, rather than a snapshot taken before asynchronous file I/O.
 * The replacement merges only edits after the last successful handover write.
 */
import { mergeMovedText } from './writeSafety'

export interface MoveSnapshot {
  text: string
  caret?: { anchor: number; head: number; focused: boolean }
}

export interface MoveHandoff {
  capture(): MoveSnapshot
  acknowledge(ours: string, disk: string): void
  claim(disk: string): { text: string | null; snapshot: MoveSnapshot }
}

const pending = new Map<string, { at: number; handoff: MoveHandoff; timer: ReturnType<typeof setTimeout> }>()
const keyOf = (root: string | null, scope: string | null, path: string): string => JSON.stringify([root, scope, path])
const lifetime = 5 * 60_000

export function registerMoveHandoff(root: string | null, scope: string | null, path: string, base: string,
  read: () => MoveSnapshot, persist: (text: string | null, base: string) => void): MoveHandoff {
  // Unclaimed closed panes are backed by persistent drafts, not immortal readers.
  for (const [key, entry] of pending) if (Date.now() - entry.at > lifetime) { clearTimeout(entry.timer); pending.delete(key) }
  let disk: string | null = null
  let claimed = false
  let last: MoveSnapshot
  const handoff: MoveHandoff = {
    capture() {
      if (claimed) return last
      const snapshot = last = read()
      const text = disk == null ? snapshot.text : mergeMovedText(base, snapshot.text, disk)
      persist(text === (disk ?? base) ? null : text ?? snapshot.text, disk ?? base)
      return snapshot
    },
    acknowledge(ours, written) {
      if (claimed) return
      base = ours
      disk = written
      handoff.capture()
    },
    claim(currentDisk) {
      const snapshot = last = read()
      claimed = true
      const text = mergeMovedText(base, snapshot.text, currentDisk)
      persist(text === currentDisk ? null : text ?? snapshot.text, currentDisk)
      return { text, snapshot }
    },
  }
  const key = keyOf(root, scope, path)
  const previous = pending.get(key)
  if (previous) clearTimeout(previous.timer)
  const timer = setTimeout(() => { if (pending.get(key)?.handoff === handoff) pending.delete(key) }, lifetime)
  pending.set(key, { at: Date.now(), handoff, timer })
  handoff.capture()
  return handoff
}

export function hasMoveHandoff(root: string | null, scope: string | null, path: string): boolean {
  const key = keyOf(root, scope, path)
  const entry = pending.get(key)
  if (entry && Date.now() - entry.at > lifetime) { clearTimeout(entry.timer); pending.delete(key) }
  return pending.has(key)
}

export function claimMoveHandoff(root: string | null, scope: string | null, path: string, disk: string) {
  const key = keyOf(root, scope, path)
  if (!hasMoveHandoff(root, scope, path)) return null
  const entry = pending.get(key)!
  clearTimeout(entry.timer)
  pending.delete(key)
  return entry.handoff.claim(disk)
}
