import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { MINI_WINDOW_LIMIT, VOICE_CALL_VIEW, miniEntityKey, normalizeMiniOpenOptions, type MiniOpenOptions } from '../shared/miniPanel'

export interface MiniSessionEntry {
  target?: MiniOpenOptions
  bounds: { x: number; y: number; width: number; height: number }
  visible: boolean
  pinned: boolean
}

/** Separate from the per-entity geometry cache: only windows still open at quit are restored. */
export function miniSessionState(file: string) {
  let writable = false
  return {
    read(): MiniSessionEntry[] {
      try {
        const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
        if (!Array.isArray(data)) throw new Error('Mini session must be an array')
        const entries: MiniSessionEntry[] = []
        for (const raw of data) {
          if (!raw || typeof raw !== 'object') throw new Error('Invalid Mini session entry')
          const { bounds: b, visible, pinned } = raw
          if (!b || !['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k])) || b.width <= 0 || b.height <= 0
            || typeof visible !== 'boolean' || typeof pinned !== 'boolean') throw new Error('Invalid Mini session bounds')
          const target = normalizeMiniOpenOptions(raw.target)
          if (raw.target != null && !target) throw new Error('Invalid Mini session target')
          if (miniEntityKey(target) === VOICE_CALL_VIEW) continue // Never restart a live call.
          if (entries.length < MINI_WINDOW_LIMIT) entries.push({ target, bounds: { x: b.x, y: b.y, width: b.width, height: b.height }, visible, pinned })
        }
        writable = true
        return entries
      } catch (error) {
        writable = (error as NodeJS.ErrnoException).code === 'ENOENT'
        if (!writable) console.error('[win] Mini session unreadable; preserving it:', error)
        return []
      }
    },
    write(entries: MiniSessionEntry[]): void {
      if (!writable) return
      const temp = `${file}.${process.pid}.tmp`
      try {
        writeFileSync(temp, JSON.stringify(entries), { encoding: 'utf8', mode: 0o600 })
        renameSync(temp, file)
      } catch (error) {
        try { rmSync(temp, { force: true }) } catch { /* best effort */ }
        console.error('[win] Could not save Mini session:', error)
      }
    },
  }
}
