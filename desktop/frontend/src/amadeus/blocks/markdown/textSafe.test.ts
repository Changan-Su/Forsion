import { describe, expect, it } from 'vitest'
import { toMarkdown } from 'mdast-util-to-markdown'
import { handleText } from './textSafe'

const md = (value: string): string =>
  toMarkdown({ type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value }] }] } as never, { handlers: { text: handleText } as never })

describe('textSafe(K-20b:以空白结尾的文本也转义行首块标记)', () => {
  it('段落里的字面 `- ` / `1. ` / `# ` / `> ` 转义,重开仍是段落', () => {
    expect(md('- ')).toBe('\\- \n')
    expect(md('1. ')).toBe('1\\. \n')
    expect(md('# ')).toBe('\\# \n')
    expect(md('> ')).toBe('\\> \n')
  })
  it('无需转义的行尾空白原样保留,不写 &#x20;(milkdown 原本的取舍)', () => {
    expect(md('hello ')).toBe('hello \n')
    expect(md('甲 ')).toBe('甲 \n')
    expect(md('a - ')).toBe('a - \n')
  })
  it('不以空白结尾的照常走 state.safe', () => {
    expect(md('- a')).toBe('\\- a\n')
  })
})
