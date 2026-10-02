/** AI commands occupy one visual row; other commands each occupy a row. */
export function slashRows(items: readonly { aiCapsule?: boolean }[]): number[][] {
  const rows: number[][] = []
  let ai: number[] | undefined
  items.forEach((item, index) => {
    if (!item.aiCapsule) rows.push([index])
    else {
      if (!ai) { ai = []; rows.push(ai) }
      ai.push(index)
    }
  })
  return rows
}

export function moveSlash(items: readonly { aiCapsule?: boolean }[], active: number, key: string): number | null {
  const rows = slashRows(items)
  const rowIndex = rows.findIndex((row) => row.includes(active))
  const row = rows[rowIndex]
  if (!row) return null
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    if (!items[active]?.aiCapsule) return null
    return row[(row.indexOf(active) + (key === 'ArrowRight' ? 1 : -1) + row.length) % row.length]
  }
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return null
  return rows[Math.max(0, Math.min(rows.length - 1, rowIndex + (key === 'ArrowDown' ? 1 : -1)))][0]
}
