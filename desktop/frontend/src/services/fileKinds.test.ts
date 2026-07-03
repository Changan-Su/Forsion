import { describe, expect, it } from 'vitest'
import { splitFrontmatter } from './fileKinds'

describe('splitFrontmatter', () => {
  it('无 frontmatter 原样返回', () => {
    const t = '# 标题\n\n正文 --- 中间的横线不是 frontmatter\n'
    expect(splitFrontmatter(t)).toEqual({ fm: '', body: t })
  })
  it('剥离头部 YAML 且往返恒等', () => {
    const fm = '---\ntitle: 测试\ntags: [a, b]\n---\n'
    const body = '# 正文\n\n---\n\n分割线保留\n'
    const r = splitFrontmatter(fm + body)
    expect(r.fm).toBe(fm)
    expect(r.body).toBe(body)
    expect(r.fm + r.body).toBe(fm + body)
  })
  it('CRLF frontmatter 也能剥离', () => {
    const t = '---\r\na: 1\r\n---\r\nbody'
    const r = splitFrontmatter(t)
    expect(r.body).toBe('body')
    expect(r.fm + r.body).toBe(t)
  })
  it('只有 frontmatter 没正文', () => {
    const t = '---\na: 1\n---\n'
    expect(splitFrontmatter(t)).toEqual({ fm: t, body: '' })
  })
  it('空 frontmatter(---\\n---\\n)也识别', () => {
    const t = '---\n---\nbody'
    const r = splitFrontmatter(t)
    expect(r.fm).toBe('---\n---\n')
    expect(r.body).toBe('body')
  })
  it('闭合线不独占一行(---xyz)不算 frontmatter', () => {
    const t = '---\ntitle: x\n---xyz\nbody'
    expect(splitFrontmatter(t)).toEqual({ fm: '', body: t })
  })
  it('闭合线带尾随空格允许', () => {
    const t = '---\na: 1\n---  \nbody'
    const r = splitFrontmatter(t)
    expect(r.fm + r.body).toBe(t)
    expect(r.body).toBe('body')
  })
})
