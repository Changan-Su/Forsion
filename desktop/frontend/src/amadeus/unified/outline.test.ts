// docHeadings 的契约:与渲染同源(不按文本行扫)、空标题不进、标题内部不下钻、level 夹到 1-6。
import { describe, expect, it } from 'vitest'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { docHeadings } from './outline'

/** docHeadings 只碰 doc.descendants / type.name / attrs.level / textContent —— 用最小替身
 *  即可诚实覆盖(同 canvas.test.ts 的做法),不必为纯函数契约把整套 PM schema 搭起来。 */
type Fake = { type: { name: string }; attrs?: Record<string, unknown>; textContent: string; children?: Fake[] }
const docOf = (...nodes: Fake[]): ProseNode =>
  ({
    descendants(f: (n: ProseNode, pos: number) => boolean | void) {
      let pos = 0
      const walk = (list: Fake[]): void => {
        for (const n of list) {
          const p = pos++
          const down = f(n as unknown as ProseNode, p)
          if (down !== false && n.children) walk(n.children)
        }
      }
      walk(nodes)
    },
  }) as unknown as ProseNode

const h = (level: number, text: string, children?: Fake[]): Fake => ({ type: { name: 'heading' }, attrs: { level }, textContent: text, children })
const para = (text: string): Fake => ({ type: { name: 'paragraph' }, textContent: text })

describe('docHeadings', () => {
  it('按文档序收标题,带 level 与 pos', () => {
    expect(docHeadings(docOf(h(1, '一'), para('正文'), h(3, '二')))).toEqual([
      { level: 1, text: '一', pos: 0 },
      { level: 3, text: '二', pos: 2 },
    ])
  })

  it('代码块里的 # 行不是标题(这正是不按文本行扫的理由)', () => {
    const code: Fake = { type: { name: 'code_block' }, textContent: '# 这不是标题\nls' }
    expect(docHeadings(docOf(code, h(2, '真标题')))).toEqual([{ level: 2, text: '真标题', pos: 1 }])
  })

  it('空标题不进大纲;标题内部不下钻', () => {
    const inner = h(2, '内层')
    expect(docHeadings(docOf(h(1, '   '), h(1, '外层', [inner])))).toEqual([{ level: 1, text: '外层', pos: 1 }])
  })

  it('level 缺失/越界一律夹到 1-6', () => {
    const bad: Fake = { type: { name: 'heading' }, attrs: {}, textContent: 'a' }
    expect(docHeadings(docOf(bad, h(0, 'b'), h(9, 'c'))).map((x) => x.level)).toEqual([1, 1, 6])
  })
})
