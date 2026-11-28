/** Snapshot keys before migration changes the storage enumeration. */
export function localStorageKeys(): string[] {
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key !== null) keys.push(key)
    }
    return keys
  } catch {
    return []
  }
}

export const NOTE_VIEW_LIMIT = 300

export interface RootMigration {
  copy(from: string, to: string, read: () => string | null, occupied?: () => boolean): void
}

/** Each family keeps a bounded record per destination. Never evict a decision and replay an old draft. */
export function rootMigration(root: string): RootMigration {
  return {
    copy(from, to, read, occupied = () => false) {
      const family = to.slice(0, to.indexOf(':'))
      const key = `amadeus.rootMigration:${root}:${family}`
      const id = JSON.stringify([from, to])
      try {
        const raw = localStorage.getItem(key)
        const records: unknown = JSON.parse(raw ?? '{}')
        if (!records || typeof records !== 'object' || Array.isArray(records) ||
            !Object.values(records).every((v) => v === 'pending' || v === 'done')) return
        const journal = records as Record<string, 'pending' | 'done'>
        if (journal[id] === 'done' || (!(id in journal) && Object.keys(journal).length >= NOTE_VIEW_LIMIT)) return
        const value = read()
        if (value === null) return
        journal[id] = 'pending'
        if (localStorage.getItem(key) !== raw) return
        localStorage.setItem(key, JSON.stringify(journal))
        // Check once more in the same synchronous section, immediately before the destination write.
        if (!occupied() && localStorage.getItem(to) === null &&
            !occupied() && localStorage.getItem(to) === null) localStorage.setItem(to, value)
        journal[id] = 'done'
        localStorage.setItem(key, JSON.stringify(journal))
      } catch { /* A pending item can retry. The source is also the recovery copy. */ }
    },
  }
}

export async function withRootMigration(root: string, run: (migration: RootMigration) => void | Promise<void>): Promise<void> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (locks?.request) await locks.request(`amadeus-root-migrate:${root}`, () => run(rootMigration(root)))
  else await run(rootMigration(root))
}
