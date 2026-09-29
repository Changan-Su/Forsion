// R-10b(评审 2026-09-27):Obsidian 的空待办 `- [ ]` / `- [ ] ` / `- [x]` —— GFM 要求 `[ ]` 后「空白 + 非空白」才算勾选框,
// 这些被读成列表项里的字面 `[ ]`,编辑同一只列表就落盘成 `* \[ ]`。markEmptyTasks 在 mdast 上补认。
// 真浏览器那一半:check:taskbox 的 R10b / R10。
import { describe, expect, it } from 'vitest'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { markEmptyTasks } from './taskList'

/* eslint-disable @typescript-eslint/no-explicit-any */
const items = (md: string): string[] => {
  const tree: any = unified().use(remarkParse).use(remarkGfm).parse(md)
  markEmptyTasks(tree)
  const out: string[] = []
  const walk = (n: any): void => {
    if (n.type === 'listItem') {
      const p = n.children?.[0]
      const text = p?.type === 'paragraph' ? p.children.map((c: any) => c.value ?? '').join('') : ''
      out.push(`${n.checked == null ? '-' : n.checked ? 'x' : ' '}:${text}`)
    }
    for (const c of n.children ?? []) walk(c)
  }
  walk(tree)
  return out
}

describe('空待办读侧(R-10b)', () => {
  it('`- [ ]` / `- [ ] ` / `- [x]` / `- [X]` → 空待办(首段清空)', () => {
    expect(items('- [ ]\n- [ ] \n- [x]\n- [X]\n- [ ] 有字\n')).toEqual([' :', ' :', 'x:', 'x:', ' :有字'])
  })
  it('带子项的空待办照认;有序列表同理', () => {
    expect(items('- [ ]\n  - 子\n\n1. [x]\n')).toEqual([' :', '-:子', 'x:'])
  })
  it('不是恰好 `[ ]` 的不动:`[ ]x`、`[a]`、普通项', () => {
    expect(items('- [ ]x\n- [a]\n- 普通\n')).toEqual(['-:[ ]x', '-:[a]', '-:普通'])
  })
})
