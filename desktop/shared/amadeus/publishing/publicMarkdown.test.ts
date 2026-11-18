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
  it('reads the callout metadata slot: icon goes into the title, colour becomes data-bg, unknown words stay hidden (A5)', () => {
    const { html } = renderPublicMarkdown('> [!tip|🚀 blue wide] 发布节奏\n> 正文\n\n> [!fold|green]+ 折叠\n> 内容')
    expect(html).toContain('<aside class="md-callout" data-bg="blue"><p class="md-callout-title">🚀 发布节奏</p>')
    expect(html).toContain('<details class="md-callout md-fold" data-bg="green" open><summary>折叠</summary>')
    expect(html).not.toContain('wide')
    expect(html).not.toContain('|')
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
  it('renders image syntax pointing at a video as a muted autoplay loop, leaving embeds as click-to-play cards', () => {
    const { html } = renderPublicMarkdown('![Demo](/releases/2.13.5/x.mp4)')
    expect(html).toContain('<video src="/releases/2.13.5/x.mp4"')
    for (const attr of [' autoplay', ' muted', ' loop', ' playsinline', ' preload="metadata"', ' aria-label="Demo"', ' data-amadeus-demo'])
      expect(html).toContain(attr)
    expect(html).not.toContain('loading=')
    expect(html).not.toContain('data-amadeus-media')
    for (const url of ['/a.webm', '/A.MP4', '/a.mp4?v=1', 'https://forsion.net/api/website/media/0f1e.mp4'])
      expect(renderPublicMarkdown(`![x](${url})`).html).toContain('data-amadeus-demo')
    expect(renderPublicMarkdown('![](/a.mp4)', { locale: 'zh' }).html).toContain('aria-label="视频演示"')
    const embed = renderPublicMarkdown('![[/releases/film.mp4]]').html
    expect(embed).toContain('data-amadeus-media="video"')
    expect(embed).not.toContain('<video')
    // a demo loop is never taken as the poster of the embed that follows it
    const pair = renderPublicMarkdown('![Demo](/a.mp4)\n\n![[/b.mp4]]').html
    expect(pair).toContain('data-amadeus-demo')
    expect(pair).toContain('data-amadeus-media="video"')
    expect(pair).not.toContain('has-poster')
    expect(pair).not.toContain('<img')
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
  it('renders a ```toc block as a nested list of links to the heading ids, honoring min/max depth', () => {
    const md = '# Title\n\n```toc\nmin_depth: 1\nmax_depth: 3\n```\n\n## Goals\n\n## Split\n\n### Design\n\n#### Deep\n\n> ## In a quote\n\n## A <b> & c\n'
    const { title, html } = renderPublicMarkdown(md, { idPrefix: 'p', locale: 'zh' })
    expect(title).toBe('Title')
    expect(html).not.toContain('<pre>')
    const nav = /<nav class="md-toc" aria-label="目录">(.*?)<\/nav>/.exec(html)?.[1]
    expect(nav).toBe(
      '<ul><li><a href="#p-1">Goals</a></li><li><a href="#p-2">Split</a><ul><li><a href="#p-3">Design</a></li></ul></li>' +
        '<li><a href="#p-5">In a quote</a></li><li><a href="#p-6">A &lt;b&gt; &amp; c</a></li></ul>',
    )
    // 每条链接都指向真实存在的标题 id
    for (const id of nav!.matchAll(/href="#([^"]+)"/g)) expect(html).toContain(`id="${id[1]}"`)
    expect(renderPublicMarkdown('```toc\nmax_depth: 4\n```\n\n## A\n\n#### D\n').html).toContain('<a href="#md-2">D</a>')
  })
  it('drops a ```toc block with no headings in range instead of showing its source', () => {
    expect(renderPublicMarkdown('```toc\n```\n\nJust text.\n').html).toBe('<p>Just text.</p>')
    expect(renderPublicMarkdown('```toc\nmin_depth: 4\n```\n\n## A\n').html).not.toContain('md-toc')
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
