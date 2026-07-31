/**
 * callout 令牌落盘去转义。remark 把行首 `[` 写成 `\[`,Obsidian 就不认这个 callout 了 ——
 * 而「Obsidian 里原生可折叠」正是折叠块选这套落盘格式的全部理由。
 * 渲染那一半(正则漏 `]` 导致 callout 从来没生效)由 editor-triggers e2e 的 T34 钉。
 */
import { describe, expect, it } from 'vitest'
import { unescapeCalloutToken } from './callout'

describe('unescapeCalloutToken', () => {
  it('引用行首的令牌去转义', () => {
    expect(unescapeCalloutToken('> \\[!note]- 标题\n> 内容\n')).toBe('> [!note]- 标题\n> 内容\n')
  })

  it('折叠块同理', () => {
    expect(unescapeCalloutToken('> \\[!fold]-这是标题')).toBe('> [!fold]-这是标题')
  })

  it('嵌套引用也认', () => {
    expect(unescapeCalloutToken('> > \\[!tip] 里层')).toBe('> > [!tip] 里层')
  })

  it('普通段落里的 \\[ 不动(那里的转义是必要的)', () => {
    expect(unescapeCalloutToken('\\[!note] 不在引用里')).toBe('\\[!note] 不在引用里')
  })

  it('引用里非令牌形状的 \\[ 不动', () => {
    expect(unescapeCalloutToken('> \\[链接]')).toBe('> \\[链接]')
  })

  it('没有转义时原样返回', () => {
    expect(unescapeCalloutToken('> [!note] 已经是对的')).toBe('> [!note] 已经是对的')
  })
})
