// D-19:CRLF 笔记按原行尾写回。UnifiedPage 在磁盘 I/O 边界用这三个函数;真浏览器那一半见 check:rtcorpus 的 d19.*。
import { describe, expect, it } from 'vitest'
import { eolOf, fromDisk, toDisk } from './eol'

describe('eol(D-19)', () => {
  it('只认纯 CRLF;混杂 / 纯 LF / 孤立 CR / 无换行 → LF', () => {
    expect(eolOf('a\r\nb\r\n')).toBe('\r\n')
    expect(eolOf('a\r\nb\n')).toBe('\n')
    expect(eolOf('a\nb\n')).toBe('\n')
    expect(eolOf('a\r\nb\rc')).toBe('\n')
    expect(eolOf('abc')).toBe('\n')
  })
  it('纯 CRLF 往返逐字;混杂的原样不动', () => {
    for (const s of ['---\r\ntags: [a]\r\n---\r\n# T\r\n\r\nbody\r\n', 'a\r\nb\n', 'a\nb']) {
      const d = fromDisk(s)
      expect(d.text.includes('\r\n') && d.eol === '\r\n').toBe(false)
      expect(toDisk(d.text, d.eol)).toBe(s)
    }
  })
  it('写回时编辑器新出的行也按 CRLF', () => {
    expect(toDisk('a\nb\n\nc', '\r\n')).toBe('a\r\nb\r\n\r\nc')
  })
})
