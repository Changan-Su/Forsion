export const SLASH_CATEGORIES = ['basic', 'ai', 'plugin'] as const
export type SlashCategory = typeof SLASH_CATEGORIES[number]

export function slashCategory(item: { category?: SlashCategory }): SlashCategory {
  return item.category ?? 'basic'
}

/** Queries search every category; an explicit tab choice may still show an empty result. */
export function defaultSlashCategory(items: readonly { category?: SlashCategory }[], query: string): SlashCategory {
  return query.trim() && items.length ? slashCategory(items[0]) : 'basic'
}

export function moveSlashCategory(active: SlashCategory, key: string): SlashCategory | null {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null
  const index = SLASH_CATEGORIES.indexOf(active)
  return SLASH_CATEGORIES[(index + (key === 'ArrowRight' ? 1 : -1) + SLASH_CATEGORIES.length) % SLASH_CATEGORIES.length]
}

/** Every command occupies one ordinary menu row within its category. */
export function moveSlash(count: number, active: number, key: string): number | null {
  if (!count || (key !== 'ArrowUp' && key !== 'ArrowDown')) return null
  return Math.max(0, Math.min(count - 1, active + (key === 'ArrowDown' ? 1 : -1)))
}
