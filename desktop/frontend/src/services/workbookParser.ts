import * as XLSX from 'xlsx'

export const WORKBOOK_MAX_BYTES = 20 * 1024 * 1024
export const WORKBOOK_TIMEOUT_MS = 5000
export type WorkbookPreview = { kind: 'xlsx'; sheets: { name: string; html: string }[] }
const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
function safeLink(target: string): string | null {
  try { const url = new URL(target); return /^(https?:|mailto:)$/.test(url.protocol) ? url.href : null } catch { return null }
}

// Called only in a disposable worker in production. Limit rendered dimensions independently
// of parser limits: malicious !ref ranges must never turn into an unbounded HTML loop.
export function parseWorkbook(bytes: Uint8Array): WorkbookPreview {
  if (bytes.byteLength > WORKBOOK_MAX_BYTES) throw new Error('workbook-too-large')
  const wb = XLSX.read(bytes, { type: 'array', sheetRows: 500, cellHTML: false, cellFormula: false })
  if (!wb.SheetNames.length || wb.SheetNames.length > 32) throw new Error('workbook-limits')
  let outputBytes = 0
  const encoder = new TextEncoder()
  const budget = (html: string) => {
    outputBytes += encoder.encode(html).byteLength
    if (outputBytes > 2 * 1024 * 1024) throw new Error('workbook-limits')
    return html
  }
  const sheets = wb.SheetNames.map(name => {
    const sheet = wb.Sheets[name]
    const range = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref'] || 'A1')
    if (range.e.r - range.s.r >= 500 || range.e.c - range.s.c >= 100) throw new Error('workbook-limits')
    budget('<table></table>')
    const rows: string[] = []
    for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 499); r++) {
      budget('<tr></tr>')
      const cells: string[] = []
      for (let c = range.s.c; c <= Math.min(range.e.c, range.s.c + 99); c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })]
        const value = escape(cell ? XLSX.utils.format_cell(cell) : '')
        const href = cell?.l?.Target ? safeLink(cell.l.Target) : null
        const html = href ? `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${value}</a>` : value
        cells.push(budget(`<td>${html}</td>`))
      }
      rows.push(`<tr>${cells.join('')}</tr>`)
    }
    return { name, html: `<table>${rows.join('')}</table>` }
  })
  return { kind: 'xlsx', sheets }
}
