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

  it('跨块选区:段落 / 标题 / 每个列表项(含嵌套)/ 引用 / 标注(A5);表格、代码、图片不算', async () => {
    const b = await bootEditor(MD)
    try {
      const doc = b.view.state.doc
      const got = colorTargetsOf(b.view.state, { from: 0, to: doc.content.size })
      expect(names(got)).toEqual(['heading:标题', 'paragraph:正文', 'list_item:一', 'list_item:二嵌套', 'list_item:嵌套', 'blockquote:引用引用第二', 'blockquote:[!tip]'])
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

  it('光标:列表项 / 引用的第一段 = 容器,引用第二段 = 段落自己;标注标题行 = 整只标注、正文 = 段落;表格里没有目标', async () => {
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
      expect(at('[!tip]')).toBe('blockquote:[!tip]')
      expect(at('内容')).toBe('paragraph:内容')
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

describe('标注的底色进令牌元数据位(A5)', () => {
  const MD = '> [!tip] 甲\n> 正文一\n\n乙\n\n> [!note|🚀 wide]- 丙\n> 正文二\n'
  const all = (b: { view: { state: import('@milkdown/kit/prose/state').EditorState } }) => colorTargetsOf(b.view.state, { from: 0, to: b.view.state.doc.content.size })

  it('标注 + 段落 + 标注一次上色:标注写进 [!type|…],段落写段首标记;位置从后往前改不串位', async () => {
    const b = await bootEditor(MD)
    try {
      expect(names(all(b))).toEqual(['blockquote:[!tip]', 'paragraph:乙', 'blockquote:[!note'])
      b.view.dispatch(blockColorTr(b.view.state, all(b), { bg: 'blue' })!)
      // 标题行改过(哪怕只改令牌)就不再逐字写回,标题和正文之间多一行 `>` —— main 上改标题本来如此(Obsidian 显示一样),不是 A5 引入的
      expect(b.saved()).toBe('> [!tip|blue] 甲\n>\n> 正文一\n\n<span data-amadeus-bg="blue"></span>乙\n\n> [!note|🚀 blue wide]- 丙\n>\n> 正文二\n')
      expect(sharedColor(all(b), 'bg')).toBe('blue')
      // 字色只给段落;标注没有字色
      b.view.dispatch(blockColorTr(b.view.state, all(b), { fg: 'red' })!)
      expect(b.saved()).toBe('> [!tip|blue] 甲\n>\n> 正文一\n\n<span data-amadeus-bg="blue" data-amadeus-fg="red"></span>乙\n\n> [!note|🚀 blue wide]- 丙\n>\n> 正文二\n')
      // 「更多颜色」的 hex 对标注不生效(元数据位只存语义名)
      b.view.dispatch(blockColorTr(b.view.state, all(b), { bg: '#ff0000' })!)
      expect(b.saved()).toContain('> [!tip|blue] 甲')
      // 清除:令牌回到没有颜色的样子,认不得的词(wide)和图标留着
      b.view.dispatch(blockColorTr(b.view.state, all(b), { bg: '', fg: '' })!)
      expect(b.saved()).toBe('> [!tip] 甲\n>\n> 正文一\n\n乙\n\n> [!note|🚀 wide]- 丙\n>\n> 正文二\n')
    } finally { await b.destroy() }
  })

  it('元数据里的生词写回原样,不被 Markdown 转义(Codex 评审 A5 #2)', async () => {
    const b = await bootEditor('> [!tip|wide foo_bar] 甲\n> 正文\n')
    try {
      b.view.dispatch(blockColorTr(b.view.state, all(b), { bg: 'blue' })!)
      expect(b.saved()).toContain('> [!tip|blue wide foo_bar] 甲')
    } finally { await b.destroy() }
  })

  it('令牌前有 HTML 原子(A1 留着的颜色标记)的标注:不当上色目标,文档不动(Codex 评审 A5 #1)', async () => {
    const MD2 = '> <span data-amadeus-bg="red"></span>[!tip] 甲\n> 正文\n\n乙\n'
    const b = await bootEditor(MD2)
    try {
      expect(names(all(b))).toEqual(['paragraph:乙'])
      const { state } = b.view
      const p = posOf(state.doc, '', 'paragraph')
      expect(colorTargetAtCursor(state.apply(state.tr.setSelection(TextSelection.create(state.doc, p + 2))))).toBeNull()
      b.view.dispatch(blockColorTr(b.view.state, all(b), { bg: 'green' })!)
      expect(b.saved()).toContain('<span data-amadeus-bg="red"></span>[!tip] 甲')
      expect(b.saved()).toMatch(/^> <span data-amadeus-bg="red"><\/span>\[!tip\] 甲\n/)
      expect(b.saved().split('\n\n')[0]).not.toContain('green')
    } finally { await b.destroy() }
  })

  it('只有标注时 sharedColor 读令牌;没变化返回 null', async () => {
    const b = await bootEditor('> [!tip|green] 甲\n> 正文\n')
    try {
      expect(sharedColor(all(b), 'bg')).toBe('green')
      expect(sharedColor(all(b), 'fg')).toBe('')
      expect(blockColorTr(b.view.state, all(b), { bg: 'green' })).toBeNull()
      expect(blockColorTr(b.view.state, all(b), { fg: 'red' })).toBeNull()
    } finally { await b.destroy() }
  })
})
