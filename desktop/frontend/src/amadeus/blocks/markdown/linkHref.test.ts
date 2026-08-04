import { describe, expect, it } from 'vitest'
import { normalizeHref } from './linkHref'

describe('normalizeHref', () => {
  it('裸域名补 https://', () => {
    expect(normalizeHref('example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(normalizeHref('  forsion.net  ')).toBe('https://forsion.net')
  })

  it('已有安全 scheme 原样留', () => {
    expect(normalizeHref('https://a.b/c')).toBe('https://a.b/c')
    expect(normalizeHref('http://a.b/c')).toBe('http://a.b/c')
    expect(normalizeHref('//cdn.x.com/a')).toBe('https://cdn.x.com/a')
  })

  it('⚠️只放 http(s):主进程的 openExternal 也只放这两个,放宽这里=造死链接', () => {
    expect(normalizeHref('mailto:x@y.z')).toBeNull()
    expect(normalizeHref('tel:123')).toBeNull()
    expect(normalizeHref('file:///etc/passwd')).toBeNull()
    expect(normalizeHref('obsidian://open?vault=x')).toBeNull()
  })

  it('站内相对路径不动', () => {
    expect(normalizeHref('./笔记.md')).toBe('./笔记.md')
    expect(normalizeHref('#小节')).toBe('#小节')
    expect(normalizeHref('/vault/a')).toBe('/vault/a')
  })

  it('可执行 scheme 一律拒绝(含空白绕过)', () => {
    expect(normalizeHref('javascript:alert(1)')).toBeNull()
    expect(normalizeHref('JaVaScRiPt:alert(1)')).toBeNull()
    expect(normalizeHref('java\tscript:alert(1)')).toBeNull()
    expect(normalizeHref('java\nscript:alert(1)')).toBeNull()
    expect(normalizeHref('data:text/html,<script>x</script>')).toBeNull()
    expect(normalizeHref('vbscript:msgbox')).toBeNull()
  })

  it('空输入 = 去掉链接', () => {
    expect(normalizeHref('')).toBeNull()
    expect(normalizeHref('   ')).toBeNull()
  })
})
