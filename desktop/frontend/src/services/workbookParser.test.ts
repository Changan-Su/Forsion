import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parseWorkbook, WORKBOOK_MAX_BYTES } from './workbookParser'

describe('untrusted workbook preview', () => {
  it('preserves Chinese sheet names, multiple sheets, dates, formula cached values and safe hyperlinks', () => {
    const wb = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([['中文', 42, new Date(2026, 9, 28)]])
    sheet.B1 = { t: 'n', v: 42, f: '40+2' }
    sheet.A1.l = { Target: 'https://example.com/report' }
    XLSX.utils.book_append_sheet(wb, sheet, '中文表名')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Second']]), 'Sheet 2')
    const result = parseWorkbook(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
    expect(result.sheets.map(s => s.name)).toEqual(['中文表名', 'Sheet 2'])
    expect(result.sheets[0].html).toContain('中文')
    expect(result.sheets[0].html).toContain('42')
    expect(result.sheets[0].html).toMatch(/10\/28\/26/)
    expect(result.sheets[0].html).toContain('https://example.com/report')
  })
  it('escapes cell markup and drops executable hyperlink schemes', () => {
    const wb = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([['<img src=x onerror=alert(1)>']])
    sheet.A1.l = { Target: 'javascript:alert(1)' }
    XLSX.utils.book_append_sheet(wb, sheet, 'Untrusted')
    const html = parseWorkbook(XLSX.write(wb, { type:'array', bookType:'xlsx' })).sheets[0].html
    expect(html).not.toContain('<img'); expect(html).not.toContain('javascript:')
    expect(html).toContain('&lt;img')
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(({} as any).polluted).toBeUndefined()
  })
  it('rejects oversized and corrupt ZIP workbooks', () => {
    expect(() => parseWorkbook(new Uint8Array(WORKBOOK_MAX_BYTES + 1))).toThrow('workbook-too-large')
    expect(() => parseWorkbook(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]))).toThrow()
  })
})
