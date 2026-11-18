// @vitest-environment happy-dom
// 整块颜色:对谁上色(块菜单 / 跨块选区 / 斜杠光标)+ 一次上色一个撤销步。真 Milkdown 文档(parseFidelity.testkit)。
import { describe, expect, it } from 'vitest'
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { bootEditor } from '../blocks/markdown/parseFidelity.testkit'
import { blockColorTr, colorTargetAtCursor, colorTargetsOf, sharedColor } from './blockColorCommands'

const names = (ts: Array<{ node: PMNode }>): string[] => ts.map((t) => `${t.node.type.name}:${t.node.textContent.slice(0, 6)}`)
const posOf = (doc: PMNode, text: string, type?: string): number => {
  let at = -1
  doc.descendants((n, pos) => { if (at < 0 && (!type || n.type.name === type) && n.textContent.startsWith(text)) at = pos; return at < 0 })
  return at
}

describe('colorTargetsOf / colorTargetAtCursor', () => {
  const MD = '# 标题\n\n正文\n\n- 一\n- 二\n  - 嵌套\n\n> 引用\n>\n> 引用第二段\n\n> [!tip] 标注\n> 内容\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```js\nx\n```\n\n![](a.png)\n'

  it('跨块选区:段落 / 标题 / 每个列表项(含嵌套)/ 引用;标注、表格、代码、图片不算', async () => {
    const b = await bootEditor(MD)
    try {
      const doc = b.view.state.doc
      const got = colorTargetsOf(b.view.state, { from: 0, to: doc.content.size })
      expect(names(got)).toEqual(['heading:标题', 'paragraph:正文', 'list_item:一', 'list_item:二嵌套', 'list_item:嵌套', 'blockquote:引用引用第二'])
    } finally { await b.destroy() }
  })

  it('块菜单选中整只列表 → 每一项;选中单个列表项 → 只它和它的子项', async () => {
    const b = await bootEditor(MD)
    try {
      const { state } = b.view
      const list = posOf(state.doc, '一', 'bullet_list')
      expect(names(colorTargetsOf(state.apply(state.tr.setSelection(NodeSelection.create(state.doc, list))), null))).toEqual(['list_item:一', 'list_item:二嵌套', 'list_item:嵌套'])
      const item = posOf(state.doc, '一', 'list_item')
      expect(names(colorTargetsOf(state.apply(state.tr.setSelection(NodeSelection.create(state.doc, item))), null))).toEqual(['list_item:一'])
    } finally { await b.destroy() }
  })

  it('光标:列表项 / 引用的第一段 = 容器,引用第二段 = 段落自己,标注 / 表格里没有目标', async () => {
    const b = await bootEditor(MD)
    try {
      const { state } = b.view
      const at = (text: string): string | null => {
        const p = posOf(state.doc, text, 'paragraph')
        const t = colorTargetAtCursor(state.apply(state.tr.setSelection(TextSelection.create(state.doc, p + 1))))
        return t ? `${t.node.type.name}:${t.node.textContent.slice(0, 6)}` : null
      }
      expect(at('正文')).toBe('paragraph:正文')
      expect(at('一')).toBe('list_item:一')
      expect(at('引用')).toBe('blockquote:引用引用第二')
      expect(at('引用第二段')).toBe('paragraph:引用第二段')
      expect(at('标注')).toBeNull()
      expect(at('1')).toBeNull()
    } finally { await b.destroy() }
  })
})

describe('blockColorTr', () => {
  it('多块一次上色;清除两路一起清;没变化返回 null(撤销步在台架 check:blockcolor 里验)', async () => {
    const b = await bootEditor('甲\n\n乙\n\n丙\n')
    try {
      const all = () => colorTargetsOf(b.view.state, { from: 0, to: b.view.state.doc.content.size })
      b.view.dispatch(blockColorTr(b.view.state, all(), { bg: 'blue' })!)
      b.view.dispatch(blockColorTr(b.view.state, all(), { fg: 'red' })!)
      expect(sharedColor(all(), 'bg')).toBe('blue')
      expect(sharedColor(all(), 'fg')).toBe('red')
      expect(blockColorTr(b.view.state, all(), { bg: 'blue' })).toBeNull()
      expect(b.saved()).toBe('<span data-amadeus-bg="blue" data-amadeus-fg="red"></span>甲\n\n<span data-amadeus-bg="blue" data-amadeus-fg="red"></span>乙\n\n<span data-amadeus-bg="blue" data-amadeus-fg="red"></span>丙\n')
      b.view.dispatch(blockColorTr(b.view.state, all(), { bg: '', fg: '' })!)
      expect(b.saved()).toBe('甲\n\n乙\n\n丙\n')
      expect(sharedColor(all(), 'bg')).toBe('')
    } finally { await b.destroy() }
  })
})
