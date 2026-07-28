import { describe, expect, it } from 'vitest'
import { blockContentStart, cursorFromSource, sourceOffsetFor } from './modeCursor'

// compile() 的真实形态:frontmatter + 每块 `<!-- a id -->\n\n内容`,块间空行分隔。
const SRC = ['---', 'amadeus_page: p1', '---', '', '<!-- a 1 -->', '', '第一块内容', '', '<!-- a 2 -->', '', '第二块 abc 尾巴', ''].join('\n')

describe('blockContentStart', () => {
  it('落在 marker 行之后的内容首字符', () => {
    expect(SRC.slice(blockContentStart(SRC, '1'), blockContentStart(SRC, '1') + 5)).toBe('第一块内容')
    expect(SRC.slice(blockContentStart(SRC, '2'), blockContentStart(SRC, '2') + 3)).toBe('第二块')
  })
  it('没有该块返回 -1', () => expect(blockContentStart(SRC, '9')).toBe(-1))
})

describe('sourceOffsetFor', () => {
  it('锚点命中 → 落在锚点之后', () => {
    const at = sourceOffsetFor(SRC, { blockId: '2', anchor: '第二块 abc' })
    expect(SRC.slice(at, at + 2)).toBe(' 尾')
  })
  it('锚点找不到 → 退到块首(绝不落到别的块)', () => {
    const at = sourceOffsetFor(SRC, { blockId: '2', anchor: '**粗体**' })
    expect(at).toBe(blockContentStart(SRC, '2'))
  })
  // 锚点只在本块范围内找:块 1 的文字不能把块 2 的光标勾过去。
  it('不跨块匹配', () => {
    const at = sourceOffsetFor(SRC, { blockId: '2', anchor: '第一块内容' })
    expect(at).toBe(blockContentStart(SRC, '2'))
  })
  it('空锚点 → 块首', () => expect(sourceOffsetFor(SRC, { blockId: '1', anchor: '' })).toBe(blockContentStart(SRC, '1')))
})

describe('cursorFromSource', () => {
  it('认出光标所在的块', () => {
    const at = SRC.indexOf('尾巴')
    expect(cursorFromSource(SRC, at)?.blockId).toBe('2')
    expect(cursorFromSource(SRC, SRC.indexOf('第一块') + 2)?.blockId).toBe('1')
  })
  it('锚点 = 块内光标前的原文', () => {
    expect(cursorFromSource(SRC, SRC.indexOf('尾巴'))?.anchor).toBe('第二块 abc ')
  })
  it('光标在 frontmatter 里(第一个 marker 之前)→ null,不瞎猜块', () => {
    expect(cursorFromSource(SRC, 5)).toBeNull()
  })
  // 往返:可视 → 源码 → 可视,块身份必须稳住
  it('往返保持块身份', () => {
    const at = sourceOffsetFor(SRC, { blockId: '2', anchor: '第二块 abc' })
    expect(cursorFromSource(SRC, at)?.blockId).toBe('2')
  })
})
