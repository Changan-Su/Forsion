/** 编辑器「问 Tangu」的引用文本(评审 G3-04)。纯函数:选区 / 块的文字 + 一行出处锚点。
 *
 *  出处锚点 = `[[<库相对路径>#<最近的标题>]]` —— 与 read_file 教模型写的引用同形(ChatWikiLink 渲染成
 *  「笔记 › 标题」,点开 openNoteAtHeading 定位)。**只定位到标题**:不给块铸 `^id`(那要改笔记),
 *  标题文本取 docHeadings,与 openNoteAtHeading 的匹配同源。标题里带 `[ ] | # ^` 这类会让链接解析失败的
 *  字符时退回只带路径,不造一个点了找不到的锚。 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { docHeadings } from './outline'
import { registerMessages } from '../../i18n'

// 块菜单(⠿)那一项的文案;选区工具栏那枚在 InlineToolbar 自己的表里(itb.askTangu)。
registerMessages({
  'unipage.menu.askTangu': { zh: '问 Tangu', en: 'Ask Tangu' },
})

/** 与侧栏引用交接(quoteInMainChat)同一上限。 */
export const ASK_QUOTE_MAX = 20_000

/** `from` 处(含)之前最近的一个标题;选区在标题里、或块菜单选中的就是标题(NodeSelection 的 from = 标题的 pos)都算那个标题。 */
export function headingAbove(doc: ProseNode, from: number): string | null {
  let hit: string | null = null
  for (const h of docHeadings(doc)) {
    if (h.pos > from) break
    hit = h.text
  }
  return hit
}

export function askTanguQuote(doc: ProseNode, from: number, to: number, notePath: string): string {
  // 块之间换行,图片 / 嵌入这类叶子不给字(引用只要文字;整篇另有侧栏的自动引用)。
  const text = doc.textBetween(from, to, '\n', '').trim().slice(0, ASK_QUOTE_MAX)
  if (!text) return ''
  const heading = headingAbove(doc, from)
  const anchor = heading && !/[[\]|#^\n]/.test(heading) ? `#${heading}` : ''
  return notePath ? `${text}\n— [[${notePath}${anchor}]]` : text
}
