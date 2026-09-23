import type { CellValue } from '@amadeus-shared/db/schema'

export type GridMove = 'left' | 'right' | 'up' | 'down' | 'next' | 'previous'

/** Horizontal arrows stay on the row; Tab wraps across rows. Invalid edges stay selected. */
export function nextGridCellIndex(index: number, count: number, width: number, move: GridMove): number {
  if (index < 0 || index >= count || width <= 0) return -1
  if (move === 'left' && index % width === 0) return index
  if (move === 'right' && index % width === width - 1) return index
  const delta = move === 'up' ? -width : move === 'down' ? width : move === 'left' || move === 'previous' ? -1 : 1
  const next = index + delta
  return next >= 0 && next < count ? next : index
}

/** Parsing happens at commit, so typing a minus sign, decimal or partial URL never destroys data. */
export function cellDraftValue(type: string, draft: string, previous: CellValue | undefined): CellValue | undefined {
  if (type === 'number') {
    if (!draft.trim()) return undefined
    const number = Number(draft.trim())
    return Number.isFinite(number) ? number : previous
  }
  if (type === 'page') return draft.trim() || previous
  if (type === 'url') {
    let url = draft.trim()
    if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url) && /^[\w-]+(\.[\w-]+)+/.test(url)) url = `https://${url}`
    return url || undefined
  }
  return draft.replace(/【【([^】\n]+)】】/g, '[[$1]]') || undefined
}
