import { expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parseWorkbook } from './workbookParser'
it('includes table markup in the total workbook HTML byte budget', () => {
  const book = XLSX.utils.book_new()
  for (let i = 0; i < 32; i++) XLSX.utils.book_append_sheet(book, {
    A1: { t: 's', v: '' }, CV500: { t: 's', v: '' }, '!ref': 'A1:CV500',
  }, `Sheet ${i}`)
  const bytes = XLSX.write(book, { type: 'array', bookType: 'xlsx', compression: true })
  expect(bytes.byteLength).toBeLessThan(20 * 1024 * 1024)
  let total = 0
  try { total = parseWorkbook(bytes).sheets.reduce((n, sheet) => n + Buffer.byteLength(sheet.html), 0) }
  catch (error) { expect(String(error)).toContain('workbook-limits'); return }
  expect(total).toBeLessThanOrEqual(2 * 1024 * 1024)
})

it('counts UTF-8 bytes rather than only characters', () => {
  const csv = new TextEncoder().encode('\uFEFF' + '汉'.repeat(700000))
  expect(() => parseWorkbook(csv)).toThrow('workbook-limits')
})
