import { describe, expect, it } from 'vitest'
import { parseMdTasks } from './mdTasks'

const P = 'note.md'
const T = 'note'
const parse = (md: string) => parseMdTasks(md, P, T)

describe('parseMdTasks', () => {
  it('三种项目符号 + 大小写 X 都算任务', () => {
    const r = parse('- [ ] a\n* [x] b\n+ [X] c')
    expect(r.map((t) => [t.text, t.checked])).toEqual([['a', false], ['b', true], ['c', true]])
  })

  it('记住最近的上级标题;标题之前的任务 heading 为空', () => {
    const r = parse('- [ ] 无归属\n# 一级\n- [ ] 甲\n### 三级\n- [ ] 乙')
    expect(r.map((t) => [t.heading, t.text])).toEqual([['', '无归属'], ['一级', '甲'], ['三级', '乙']])
  })

  it('围栏代码块里的任务不算,且只有同种栅栏能收口', () => {
    expect(parse('```\n- [ ] 代码里的\n```\n- [ ] 真的')).toHaveLength(1)
    expect(parse('```md\n~~~\n- [ ] 仍在 ``` 里\n```\n- [ ] 真的')).toHaveLength(1)
    expect(parse('~~~\n- [ ] 代码里的\n~~~')).toHaveLength(0)
  })

  it('行内代码写的 `[x]` 不是任务(用户笔记里的「状态约定」段就长这样)', () => {
    expect(parse('* `[x]`:原文标记为已完成。\n* `[ ]`:原文明确列出的待办。')).toHaveLength(0)
  })

  it('只有 HTML 标签/空白的占位行不算待办', () => {
    expect(parse('- [ ] <br />\n- [ ] 真的')).toEqual([expect.objectContaining({ text: '真的' })])
  })

  it('行号是 1-based,针对传入的这份文本', () => {
    expect(parse('# h\n\n- [ ] x')[0].line).toBe(3)
  })

  it('缩进的子任务照收(缩进不影响判定)', () => {
    expect(parse('- [ ] 父\n  - [ ] 子')).toHaveLength(2)
  })

  it('必须有一个空格分隔:`-[ ]` / `- []` 都不算', () => {
    expect(parse('-[ ] a\n- [] b')).toHaveLength(0)
  })

  // 与编辑器互锁:structuralSource.ts 把任务块写回磁盘的字面形态必须能被本解析器认出。
  // 负对照:把下面任一 SOURCE 改成 `-[ ] ` 之类,这条必须变红。
  it('编辑器写回磁盘的任务形态解析得出来(与 structuralSource 互锁)', () => {
    const SOURCE = { unchecked: '- [ ] ', checked: '- [x] ' }
    const r = parse(`${SOURCE.unchecked}未完\n${SOURCE.checked}已完`)
    expect(r.map((t) => [t.text, t.checked])).toEqual([['未完', false], ['已完', true]])
  })
})
