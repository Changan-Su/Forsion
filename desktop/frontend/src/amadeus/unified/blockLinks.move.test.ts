import { describe, expect, it } from 'vitest'
import { appendToNote, endsInsideOpenBlock, rebaseRelativeLinks } from './blockLinks'

// B-15「移动到…」的三处落盘保真(Codex 复核):相对链接跨目录重算、目标末尾未收尾不追加、追加不改写目标原文。
describe('moveBlocksTo helpers', () => {
  it('rebases relative md links across folders, leaves images / urls / anchors / fences alone', () => {
    const md = '见 [文档](../Other.md#sec) 与 [外链](https://x.io/a) [锚](#h) ![图](pic.png)\n\n```\n[代码](a.md)\n```'
    expect(rebaseRelativeLinks(md, 'a/b', 'c')).toBe('见 [文档](../a/Other.md#sec) 与 [外链](https://x.io/a) [锚](#h) ![图](pic.png)\n\n```\n[代码](a.md)\n```')
    expect(rebaseRelativeLinks('[x](y.md)', 'a', 'a')).toBe('[x](y.md)')
    expect(rebaseRelativeLinks('[x](y.md)', '', 'd/e')).toBe('[x](../../y.md)')
  })
  it('detects an unclosed fence or html comment at the end', () => {
    expect(endsInsideOpenBlock('正文\n\n```js\nconst a = 1\n')).toBe(true)
    expect(endsInsideOpenBlock('正文\n<!-- 注释没收尾\n')).toBe(true)
    expect(endsInsideOpenBlock('```js\nx\n```\n\n<!-- ok -->\n')).toBe(false)
    expect(endsInsideOpenBlock('````\n```\n````\n')).toBe(false)
  })
  it('appends without touching the original text, keeping CRLF', () => {
    expect(appendToNote('甲\n\n\n', 'X')).toBe('甲\n\n\nX\n')
    expect(appendToNote('甲', 'X')).toBe('甲\n\nX\n')
    expect(appendToNote('甲\n', 'X')).toBe('甲\n\nX\n')
    expect(appendToNote('甲\r\n乙\r\n', 'X\nY')).toBe('甲\r\n乙\r\n\r\nX\r\nY\r\n')
    expect(appendToNote('', 'X')).toBe('X\n')
  })
})
