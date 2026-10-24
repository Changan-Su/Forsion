/**
 * Chat 链接预览卡的渲染端判定(纯函数;出卡、接力、取数在 Electron 台架 e2e-linkcard 里看):
 *   - 只有 PR / issue 形状的链接才去问引擎,别的链接一次请求都不发(素卡只看 URL)
 *   - 素卡第二行:认得的站写站名,路径长了留头两段和文件名
 */
import { describe, expect, it } from 'vitest'
import { linkPlace, mayHaveRichCard } from './ChatLinkCard'

describe('mayHaveRichCard', () => {
  it.each([
    'https://github.com/Changan-Su/Forsion/pull/153',
    'https://github.com/a/b/issues/9#issuecomment-1',
    'https://github.com/a/b/pull/7/files',
    'https://git.forsion.net/forsion/genesis/pulls/12',
    'https://h.example/git/o/r/issues/3?x=1',
  ])('问引擎:%s', (href) => expect(mayHaveRichCard(href)).toBe(true))

  it.each([
    'https://example.com/docs/DESIGN.md',
    'https://github.com/a/b',
    'https://github.com/a/b/pull/abc',
    'https://github.com/a/b/pull/1x',
    'http://github.com/a/b/pull/1',
    'mailto:a@b.c',
  ])('不问:%s', (href) => expect(mayHaveRichCard(href)).toBe(false))
})

describe('linkPlace', () => {
  it('认得的站写站名,长路径中间省略,文件名留着', () => {
    expect(linkPlace('https://git.forsion.net/forsion/genesis/src/branch/main/DESIGN.md')).toEqual({
      host: 'git.forsion.net', site: 'Forsion Git', dest: 'git.forsion.net/forsion/genesis/…/DESIGN.md', file: true,
    })
  })
  it('别的站只写主机 + 路径;路径里的中文解码', () => {
    expect(linkPlace('https://example.com/%E6%96%87%E6%A1%A3/a')).toEqual({ host: 'example.com', site: undefined, dest: 'example.com/文档/a', file: false })
    expect(linkPlace('https://example.com/')).toMatchObject({ dest: 'example.com', file: false })
  })
  it('解析不了的原样给出', () => {
    expect(linkPlace('not a url')).toEqual({ host: 'not a url', dest: 'not a url', file: false })
  })
})
