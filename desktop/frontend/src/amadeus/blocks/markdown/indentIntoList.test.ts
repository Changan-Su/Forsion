// @vitest-environment happy-dom
//
// 先 Tab 再转列表 / 引用 = 先转再 Tab:段落的缩进档归容器,不留在列表项段落上(否则列表符与正文间撑出空隙)。
import { describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import { applyTrigger } from './blockTriggers'
import { bootEditor, roundTrip } from './parseFidelity.testkit'

async function turn(md: string, kind: 'bullet' | 'ordered' | 'quote'): Promise<string[]> {
  const b = await bootEditor(md)
  try {
    const { view } = b
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    expect(applyTrigger(view, kind === 'ordered' ? { kind, order: 1 } : { kind }, null)).toBe(true)
    const out: string[] = []
    view.state.doc.descendants((n) => { if (!n.isText) out.push(n.type.name + (n.attrs.indent ? `:${n.attrs.indent}` : '')) })
    return out
  } finally {
    await b.destroy()
  }
}

describe('缩进段落转列表 / 引用', () => {
  it.each([
    ['bullet', ['bullet_list:2', 'list_item', 'paragraph']],
    ['ordered', ['ordered_list:2', 'list_item', 'paragraph']],
    ['quote', ['blockquote:2', 'paragraph']],
  ] as const)('%s:档位挪到容器', async (kind, want) => {
    expect(await turn('&#9;&#9;缩进\n', kind)).toEqual(want)
  })
  it('标题带档位转列表同样挪到列表', async () => {
    expect(await turn('<!-- amadeus-indent:1 -->\n\n## 题\n', 'bullet')).toEqual(['bullet_list:1', 'list_item', 'paragraph'])
  })
  it.each([
    ['档位不同 → 不并(并了 Tab 出来的档位就丢)', '- a\n\n&#9;b\n', ['bullet_list:0:1', 'bullet_list:1:1']],
    ['同档照旧并', '- a\n\nb\n', ['bullet_list:0:2']],
  ])('紧邻前一个列表:%s', async (_l, md, want) => {
    const b = await bootEditor(md)
    try {
      const { view } = b
      let at = 0
      view.state.doc.descendants((n, p) => { if (n.type.name === 'paragraph' && n.textContent === 'b') at = p + 1 })
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)))
      applyTrigger(view, { kind: 'bullet' }, null)
      const out: string[] = []
      view.state.doc.forEach((n) => { out.push(`${n.type.name}:${n.attrs.indent}:${n.childCount}`) })
      expect(out).toEqual(want)
    } finally {
      await b.destroy()
    }
  })
  it('旧版存下的「列表项里带缩进」打开即归零', async () => {
    const b = await bootEditor('* &#9;旧\n')
    try {
      const p = b.view.state.doc.firstChild!.firstChild!.firstChild!
      expect([p.type.name, p.attrs.indent, p.textContent]).toEqual(['paragraph', 0, '旧'])
    } finally {
      await b.destroy()
    }
    expect(await roundTrip('* &#9;旧\n')).not.toContain('&#9;')
  })
})
