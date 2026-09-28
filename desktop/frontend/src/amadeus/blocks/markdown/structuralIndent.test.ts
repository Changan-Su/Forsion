// @vitest-environment happy-dom
//
// 结构缩进标记(`<!-- amadeus-indent:N -->`)× v4 空行还原(softBreak.ts 的 restoreBlankParagraphs):
// 标记被 structuralIndent 摘掉后,块的起点若仍按块自己那一行算,标记那一行 + 写侧标记后的空行会被当成「空段落」——
// 带缩进的标题 / 引用 / 列表每存一次就多一个空段落(越存越多)。D-18 的 fuzz 抓出来的老病。
import { describe, expect, it } from 'vitest'
import { bootEditor, roundTrip } from './parseFidelity.testkit'

async function kinds(md: string): Promise<string[]> {
  const b = await bootEditor(md)
  try {
    const out: string[] = []
    b.view.state.doc.forEach((n) => { out.push(n.type.name + (n.attrs.indent ? `:${n.attrs.indent}` : '') + (n.type.name === 'paragraph' && !n.content.size ? '(空)' : '')) })
    return out
  } finally {
    await b.destroy()
  }
}

describe('结构缩进标记不让空行越存越多', () => {
  it.each([
    ['标题', 'para\n\n<!-- amadeus-indent:1 -->\n\n## ind\n', ['paragraph', 'heading:1']],
    ['引用', 'para\n\n<!-- amadeus-indent:2 -->\n\n> q\n', ['paragraph', 'blockquote:2']],
    ['列表', 'para\n\n<!-- amadeus-indent:1 -->\n\n- a\n', ['paragraph', 'bullet_list:1']],
    ['标记紧贴块(手写形)', 'para\n\n<!-- amadeus-indent:1 -->\n## ind\n', ['paragraph', 'heading:1']],
    ['前面真有一个空段落(三条空行)', 'para\n\n\n\n<!-- amadeus-indent:1 -->\n\n## ind\n', ['paragraph', 'paragraph(空)', 'heading:1']],
  ])('%s:打开不多出空段落,存两轮稳定', async (_label, md, want) => {
    expect(await kinds(md)).toEqual(want)
    const once = await roundTrip(md)
    expect(await roundTrip(once)).toBe(once)
    expect(await kinds(once)).toEqual(want)
  })
})
