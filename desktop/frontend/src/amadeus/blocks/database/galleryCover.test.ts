import { describe, expect, it } from 'vitest'
import { firstBodyImage } from './galleryCover'

describe('firstBodyImage', () => {
  it('returns null without an image', () => {
    expect(firstBodyImage(undefined)).toBeNull()
    expect(firstBodyImage('')).toBeNull()
    expect(firstBodyImage('> Source: https://example.com\n\nJust text')).toBeNull()
  })

  it('takes the first image in document order, either form', () => {
    expect(firstBodyImage('intro\n\n![[Plugins/clips/assets/a-1.jpg]]\n\n![x](https://cdn.example/b.png)'))
      .toEqual({ kind: 'wiki', target: 'Plugins/clips/assets/a-1.jpg' })
    expect(firstBodyImage('![cover](https://cdn.example/b.png)\n\n![[a.jpg]]'))
      .toEqual({ kind: 'md', src: 'https://cdn.example/b.png' })
  })

  it('wiki embeds: strips |width and #heading, skips non-image files and notes', () => {
    expect(firstBodyImage('![[photo.webp|200]]')).toEqual({ kind: 'wiki', target: 'photo.webp' })
    expect(firstBodyImage('![[Some note]]\n![[report.pdf]]\n![[pic.PNG#x]]')).toEqual({ kind: 'wiki', target: 'pic.PNG' })
  })

  it('markdown images: any target counts (CDN URLs often have no extension), angle brackets and titles allowed', () => {
    expect(firstBodyImage('![](https://img.example/abc?w=600)')).toEqual({ kind: 'md', src: 'https://img.example/abc?w=600' })
    expect(firstBodyImage('![a](<assets/one.png> "title")')).toEqual({ kind: 'md', src: 'assets/one.png' })
  })

  it('ignores plain links, unsafe schemes and images inside code', () => {
    expect(firstBodyImage('[Image](https://cdn.example/x.jpg)')).toBeNull()
    expect(firstBodyImage('![x](javascript:alert(1))\n![y](data:image/png;base64,AAA)')).toBeNull()
    expect(firstBodyImage('```md\n![[in-fence.png]]\n```\n`![[inline.png]]`\n\n![[real.png]]')).toEqual({ kind: 'wiki', target: 'real.png' })
    expect(firstBodyImage('~~~\n![[unclosed.png]]')).toBeNull()
  })

  it('stays fast on hostile bodies (many unclosed `![`)', () => {
    for (const body of ['!['.repeat(32_000), '![['.repeat(30_000), '![x]('.repeat(20_000), `${'x'.repeat(100_000)}![[late.png]]`]) {
      const t = performance.now()
      firstBodyImage(body)
      expect(performance.now() - t).toBeLessThan(500)
    }
    expect(firstBodyImage(`${'x'.repeat(30_000)}![[late.png]]`)).toBeNull() // only the start of the body is searched
  })
})
