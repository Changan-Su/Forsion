// 评审 L-15:`![[笔记#标题]]` / `![[笔记#^块]]` / `![[笔记|x]]` 的拆解与只读切片。
import { describe, expect, it } from 'vitest'
import { sliceAnchoredBlock, sliceEmbedSubpath, sliceHeadingSection, splitNoteEmbed } from './noteEmbed'

const DOC = [
  '# 总览',
  '',
  '开头段。',
  '',
  '## 第一节',
  '',
  '第一节正文 **加粗**。',
  '',
  '```md',
  '## 围栏里的假标题',
  '```',
  '',
  '### 子节',
  '',
  '子节正文。',
  '',
  '## 第二节',
  '',
  '一段话 ^para1',
  '',
  '- 项目 A ^itemA',
  '  - A 的子项',
  '- 项目 B',
  '',
  '> 引用一',
  '> 引用二',
  '',
  '^quote1',
  '',
  '```js',
  'code()',
  '```',
  '',
  '^code1',
  '',
  '## `第三节` 带格式',
  '',
  '尾。',
].join('\n')

describe('splitNoteEmbed', () => {
  it('剥掉 | 后缀、按第一个 # 拆', () => {
    expect(splitNoteEmbed('笔记|300')).toEqual({ note: '笔记', subpath: null })
    expect(splitNoteEmbed('笔记#标题|别名')).toEqual({ note: '笔记', subpath: '标题' })
    expect(splitNoteEmbed('笔记#H1#H2')).toEqual({ note: '笔记', subpath: 'H1#H2' })
    expect(splitNoteEmbed('#^abc')).toEqual({ note: '', subpath: '^abc' })
  })
})

describe('sliceHeadingSection', () => {
  it('切到下一个同级或更高级标题前,子节算在内,围栏里的 # 行不当标题', () => {
    const s = sliceHeadingSection(DOC, '第一节')!
    expect(s.startsWith('## 第一节')).toBe(true)
    expect(s).toContain('### 子节')
    expect(s).toContain('## 围栏里的假标题') // 围栏内容原样带上
    expect(s).not.toContain('## 第二节')
  })
  it('嵌套链按祖先链、行内格式可容、大小写不敏感;找不到 → null', () => {
    expect(sliceHeadingSection(DOC, '第一节#子节')).toBe('### 子节\n\n子节正文。')
    expect(sliceHeadingSection(DOC, '第三节 带格式')).toBe('## `第三节` 带格式\n\n尾。')
    expect(sliceHeadingSection(DOC, '围栏里的假标题')).toBeNull()
    expect(sliceHeadingSection(DOC, '不存在')).toBeNull()
  })
})

describe('sliceAnchoredBlock', () => {
  it('段落行尾挂锚 → 那一段,去掉锚', () => {
    expect(sliceAnchoredBlock(DOC, 'para1')).toBe('一段话')
  })
  it('列表项行尾挂锚 → 那一项连同子项,不带兄弟项', () => {
    expect(sliceAnchoredBlock(DOC, 'itemA')).toBe('- 项目 A\n  - A 的子项')
  })
  it('光杆锚 → 上一整块(引用 / 代码块)', () => {
    expect(sliceAnchoredBlock(DOC, 'quote1')).toBe('> 引用一\n> 引用二')
    expect(sliceAnchoredBlock(DOC, 'code1')).toBe('```js\ncode()\n```')
  })
  it('找不到 → null', () => {
    expect(sliceAnchoredBlock(DOC, 'nope')).toBeNull()
  })
})

describe('sliceEmbedSubpath', () => {
  it('块锚先判,畸形 ^ 形态不当标题', () => {
    expect(sliceEmbedSubpath(DOC, '^para1')).toBe('一段话')
    expect(sliceEmbedSubpath(DOC, '^a b')).toBeNull()
    expect(sliceEmbedSubpath(DOC, '第二节')!.startsWith('## 第二节')).toBe(true)
  })
})
