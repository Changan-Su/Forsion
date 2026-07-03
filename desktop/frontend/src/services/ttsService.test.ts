import { describe, it, expect, vi } from 'vitest'

vi.mock('./http', () => ({ authFetch: vi.fn() }))

import { speakableText } from './ttsService'

describe('speakableText', () => {
  it('drops fenced code blocks entirely, keeps inline code text', () => {
    const md = '看这段:\n```ts\nconst x = 1\n```\n用 `npm run dev` 启动。'
    const out = speakableText(md)
    expect(out).not.toContain('const x')
    expect(out).toContain('npm run dev')
  })

  it('keeps link/image text without URLs and strips markdown marks', () => {
    const out = speakableText('# 标题\n> 引用 **加粗** [文档](https://a.b/c) ![图](x.png)\n- 列表项')
    expect(out).not.toContain('https://a.b/c')
    expect(out).not.toContain('#')
    expect(out).not.toContain('**')
    expect(out).toContain('文档')
    expect(out).toContain('列表项')
  })

  it('caps at 4000 chars', () => {
    expect(speakableText('啊'.repeat(5000)).length).toBe(4000)
  })
})
