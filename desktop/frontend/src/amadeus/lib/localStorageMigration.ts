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

/** A failed read, invalid source or occupied destination leaves the source in place. */
export function moveLocalStorageEntry(from: string, to: string, isValid: (raw: string) => boolean): void {
  try {
    const raw = localStorage.getItem(from)
    if (raw === null || !isValid(raw) || localStorage.getItem(to) !== null) return
    localStorage.setItem(to, raw)
    // The old tab can still be writing drafts. Keep a newer source or an unconfirmed copy.
    if (localStorage.getItem(to) === raw && localStorage.getItem(from) === raw) localStorage.removeItem(from)
  } catch { /* Keep the original on storage or validation failure. */ }
}
