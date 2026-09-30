import { describe, expect, it } from 'vitest'
import { renderPublicMarkdown, safePublicUrl } from './publicMarkdown'
import { platformPlayer } from './platformVideo'

describe('Amadeus publication dialect', () => {
  it('turns headings, GFM, CJK emphasis and folded callouts into a release document', () => {
    const result = renderPublicMarkdown(
      '# 新版本\n\n## 功能\n\n**中文**与 ~~旧版~~\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n> [!note]- 全部更新\n>\n> - 更新内容',
      { headingOffset: 1 },
    )
    expect(result.title).toBe('新版本')
    expect(result.html).toContain('<h3')
    expect(result.html).toContain('<strong>中文</strong>')
    expect(result.html).toContain('<del>旧版</del>')
    expect(result.html).toContain('<table>')
    expect(result.html).toContain(
      '<details class="md-callout md-fold"><summary>全部更新</summary>',
    )
  })
  it('combines standard poster image and native wiki video embed without loading a player', () => {
    const { html } = renderPublicMarkdown(
      '![Film](/releases/cover.jpg)\n\n![[/releases/film.mp4]]',
    )
    expect(html).toContain('data-amadeus-media="video"')
    expect(html).toContain('has-poster')
    expect(html).not.toContain('<video')
    expect(html.match(/<img /g)).toHaveLength(1)
  })
  it('keeps plain links as links and supports official providers in explicit embeds only', () => {
    expect(
      renderPublicMarkdown('[YouTube](https://youtu.be/abc12345)').html,
    ).not.toContain('data-amadeus-media')
    expect(
      renderPublicMarkdown('![[https://youtu.be/abc12345?t=1m30s]]').html,
    ).toContain('start=90')
    expect(
      renderPublicMarkdown(
        '![[https://www.bilibili.com/video/BV1xx411c7mD?p=2]]',
      ).html,
    ).toContain('page=2')
    expect(
      platformPlayer('https://youtube.com.evil.example/watch?v=abc12345'),
    ).toBeNull()
    expect(platformPlayer('https://evil.example/?bvid=BV1xx411c7mD')).toBeNull()
  })
  it('escapes text and code and blocks scripts, raw HTML and arbitrary iframes', () => {
    const { html } = renderPublicMarkdown(
      '<script>alert(1)</script>\n\n<iframe src="https://evil.example"></iframe>\n\n[x](javascript:alert(1))\n\n```html\n<script>evil</script>\n```\n\n![[javascript:alert(1)]]',
    )
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('&lt;script&gt;evil&lt;/script&gt;')
    for (const url of [
      'data:text/html,x',
      'javascript:alert(1)',
      '//evil.example',
      'https://good.example\n" onclick="x',
    ])
      expect(safePublicUrl(url, true)).toBeNull()
  })
  it('resolves native image embeds and relative media in cross-origin previews', () => {
    const { html } = renderPublicMarkdown('![[/demo.gif]]\n\n![[/demo.mp4]]', {
      baseUrl: 'https://public.example',
    })
    expect(html).toContain('src="https://public.example/demo.gif"')
    expect(html).toContain('data-src="https://public.example/demo.mp4"')
    expect(renderPublicMarkdown('![[BV1xx411c7mD]]').html).toContain(
      'href="https://www.bilibili.com/video/BV1xx411c7mD"',
    )
  })
  it('supports reference links and images and tolerates an empty draft', () => {
    expect(renderPublicMarkdown('').html).toBe('')
    expect(
      renderPublicMarkdown(
        '![cover][image]\n\n[link][site]\n\n[image]: /cover.jpg\n[site]: https://forsion.com',
      ).html,
    ).toContain('src="/cover.jpg"')
  })
})
