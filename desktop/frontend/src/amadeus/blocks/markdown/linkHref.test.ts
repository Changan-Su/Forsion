import { describe, expect, it } from 'vitest'
import { hrefKind, normalizeHref, noteLinkTarget } from './linkHref'

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

  it('L-07:单段文件名是库内文件,不补 https(`.md` 恰好是真实顶级域)', () => {
    expect(normalizeHref('Note.md')).toBe('Note.md')
    expect(normalizeHref('笔记.md')).toBe('笔记.md')
    expect(normalizeHref('My%20Note.md')).toBe('My%20Note.md')
    expect(normalizeHref('Note.md#小节')).toBe('Note.md#小节')
    expect(normalizeHref('report.pdf')).toBe('report.pdf')
    expect(normalizeHref('sub/Other.md')).toBe('sub/Other.md')
    // 对照:真域名照旧补
    expect(normalizeHref('example.com')).toBe('https://example.com')
    expect(normalizeHref('example.com/readme.md')).toBe('https://example.com/readme.md')
  })
})

describe('hrefKind(编辑器与容器共用的分流判据,L-07)', () => {
  it.each([
    ['Note.md', 'note'],
    ['./sub/Other.md', 'note'],
    ['My%20Note.md', 'note'],
    ['笔记.md#小节', 'note'],
    ['report.pdf', 'file'],
    ['assets/a.pdf', 'file'],
    ['https://example.com', 'external'],
    ['example.com', 'external'],
    ['//cdn.x.com/a', 'external'],
    ['https://x.com/readme.md', 'external'],
    ['#小节', 'other'],
    ['mailto:x@y.z', 'other'],
    ['amadeus-asset://a.png', 'other'],
    ['javascript:alert(1)', 'other'],
  ])('%s → %s', (href, kind) => {
    expect(hrefKind(href)).toBe(kind)
  })
})

describe('noteLinkTarget(→ openWikiLink 的目标)', () => {
  const pages = ['Note.md', 'sub/Other.md', 'dir/sub/Other.md', 'dir/Here.md', 'My Note.md']
  it('裸名原样(openWikiLink 自己按同目录 → .fd → 全库找)', () => {
    expect(noteLinkTarget('Note.md', 'dir/Here.md', pages)).toBe('Note.md')
    expect(noteLinkTarget('My%20Note.md', null, pages)).toBe('My Note.md')
    expect(noteLinkTarget('Note.md#小节', null, pages)).toBe('Note.md')
  })
  it('./ 与 ../ 按源笔记所在目录解析', () => {
    expect(noteLinkTarget('./sub/Other.md', 'dir/Here.md', pages)).toBe('dir/sub/Other.md')
    expect(noteLinkTarget('../Note.md', 'dir/Here.md', pages)).toBe('Note.md')
    expect(noteLinkTarget('./sub/Other.md', 'Root.md', pages)).toBe('sub/Other.md')
  })
  it('带 / 不带 ./:源目录下有就用它,没有就当库根路径', () => {
    expect(noteLinkTarget('sub/Other.md', 'dir/Here.md', pages)).toBe('dir/sub/Other.md')
    expect(noteLinkTarget('sub/Other.md', 'x/Here.md', pages)).toBe('sub/Other.md')
    expect(noteLinkTarget('/sub/Other.md', 'dir/Here.md', pages)).toBe('sub/Other.md')
  })
})
