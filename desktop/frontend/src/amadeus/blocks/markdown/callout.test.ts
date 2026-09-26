/**
 * callout 令牌落盘去转义。remark 把行首 `[` 写成 `\[`,Obsidian 就不认这个 callout 了 ——
 * 而「Obsidian 里原生可折叠」正是折叠块选这套落盘格式的全部理由。
 * 渲染那一半(正则漏 `]` 导致 callout 从来没生效)由 editor-triggers e2e 的 T34 钉。
 */
import { describe, expect, it } from 'vitest'
import { splitCalloutTitle, unescapeCalloutToken } from './callout'

describe('splitCalloutTitle', () => {
  const paragraph = (value: string) => ({ type: 'paragraph', position: {}, children: [{ type: 'text', value }] })
  it('标准单换行 callout 拆开标题与正文，嵌套同样处理', () => {
    const nested = { type: 'blockquote', children: [paragraph('[!fold]- 内层\n内容')] }
    const tree = { type: 'blockquote', children: [paragraph('[!fold]+ 标题\n正文'), nested] }
    splitCalloutTitle(tree)
    expect(tree.children).toHaveLength(3)
    expect(tree.children[0].children?.[0]).toMatchObject({ value: '[!fold]+ 标题' })
    expect(tree.children[1].children?.[0]).toMatchObject({ value: '正文' })
    expect(nested.children).toHaveLength(2)
  })
  it('标题粗体及正文内联格式不丢失', () => {
    const bold = { type: 'strong', children: [{ type: 'text', value: '重要' }] }
    const tree = { type: 'blockquote', children: [{ type: 'paragraph', position: {}, children: [
      { type: 'text', value: '[!fold]+ ' }, bold, { type: 'break' }, { type: 'text', value: '内容' },
    ] }] }
    splitCalloutTitle(tree)
    expect(tree.children).toHaveLength(2)
    expect(tree.children[0].children[1]).toEqual(bold)
  })
  it('普通引用、普通段落与正文段落的软换行不变', () => {
    const tree = { type: 'root', children: [
      paragraph('一\n二'),
      { type: 'blockquote', children: [paragraph('普通引用\n换行')] },
      { type: 'blockquote', children: [paragraph('[!fold]+ 标题'), paragraph('正文\n换行')] },
    ] }
    const before = JSON.stringify(tree)
    splitCalloutTitle(tree)
    expect(JSON.stringify(tree)).toBe(before)
  })
  it('只拆标题后的第一个换行:正文里的软换行 / 硬换行留在同一段(Codex 评审)', () => {
    const tree = { type: 'blockquote', children: [{ type: 'paragraph', position: {}, children: [
      { type: 'text', value: '[!fold]+ 标题\n第一行' }, { type: 'break' }, { type: 'text', value: '第二行\n第三行' },
    ] }] }
    splitCalloutTitle(tree)
    expect(tree.children).toHaveLength(2)
    expect(tree.children[0].children).toEqual([{ type: 'text', value: '[!fold]+ 标题' }])
    expect(tree.children[1].children).toEqual([{ type: 'text', value: '第一行' }, { type: 'break' }, { type: 'text', value: '第二行\n第三行' }])
  })
  it('序列化树无 position 时保持原样，重复读取幂等', () => {
    const tree = { type: 'blockquote', children: [{ type: 'paragraph', children: [{ type: 'text', value: '[!fold]+ 标题\n正文' }] }] }
    splitCalloutTitle(tree)
    expect(tree.children).toHaveLength(1)
    const parsed = { type: 'blockquote', children: [paragraph('[!note]- 标题\n内容')] }
    splitCalloutTitle(parsed)
    const once = JSON.stringify(parsed)
    splitCalloutTitle(parsed)
    expect(JSON.stringify(parsed)).toBe(once)
  })
})

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
