// @vitest-environment happy-dom
//
// CJK 友好解析(./cjkFriendly)四层钉:
//  1. 真 milkdown 编辑器(与 attentionWiring 同法,从 serializerCtx 拿真落盘):磁盘上 `**注意：**后面` → 解析成
//     mark → 落 CommonMark 也认的字符引用形。不挂插件的负对照 = 用户实报的 `\*\*注意：\*\*后面`。
//  2. 落盘形用**不带**插件的 commonmark+gfm 重解析,mark 还在(Obsidian 按 CommonMark 走,未在 Obsidian 里实测)。
//  3. 装配:MarkdownBlock 里 `.use(cjkFriendlyRemark)` 在、且在 `.use(gfm)` 之后(反了删除线就不生效)。
//  4. 聊天气泡(components/Markdown)同一批串渲染成 <strong>/<em>/<del>。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Editor, defaultValueCtx, editorViewCtx, rootCtx, serializerCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { Markdown } from '../../../components/Markdown'
import { attentionSerializer } from './attentionFlanking'
import { cjkFriendlyRemark } from './cjkFriendly'

/** 起一个真编辑器(MarkdownBlock 的装配顺序),把 initial 灌进去再原样序列化出来。 */
const boot = async (initial: string, withCjk: boolean): Promise<string> => {
  const root = document.createElement('div')
  document.body.appendChild(root)
  let editor = Editor.make().config((ctx) => {
    ctx.set(rootCtx, root)
    ctx.set(defaultValueCtx, initial)
  })
  editor = editor.use(commonmark).use(gfm)
  if (withCjk) editor = editor.use(cjkFriendlyRemark) // ← MarkdownBlock 里那一行
  editor = editor.use(attentionSerializer)
  const ed = await editor.create()
  const md = ed.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc))
  await ed.destroy()
  root.remove()
  return md.trim()
}

/** 不带插件的 CommonMark+GFM(≈ Obsidian)读出来的 mark 种类。 */
const commonmarkMarks = (md: string): string[] => {
  const out: string[] = []
  const walk = (n: any): void => {
    if (n.type === 'strong' || n.type === 'emphasis' || n.type === 'delete') out.push(n.type)
    n.children?.forEach(walk)
  }
  walk(unified().use(remarkParse).use(remarkGfm).parse(md))
  return out
}

// [磁盘原文, 期望落盘, mark]。闭合定界符内侧是 CJK 标点、外侧是汉字 —— CommonMark 判不成立的那一类。
const CASES: Array<[string, string, string]> = [
  ['**注意：**后面', '**注意：**&#x540E;面', 'strong'],
  ['**「引号」**后面', '**「引号」**&#x540E;面', 'strong'],
  ['*（备注）*继续', '*（备注）*&#x7EE7;续', 'emphasis'],
  ['~~（备注）~~继续', '~~（备注）~~&#x7EE7;续', 'delete'],
]

describe('CJK 友好解析 × 真 milkdown', () => {
  it.each(CASES)('%s → 解析成 mark,落盘 %s,CommonMark 重读仍是 %s', async (src, saved, mark) => {
    const md = await boot(src, true)
    expect(md).toBe(saved)
    expect(commonmarkMarks(md)).toEqual([mark])
  })

  it.each(CASES)('负对照(不挂插件):%s 被转义成字面', async (src) => {
    expect(await boot(src, false)).toMatch(/\\[*~]/)
  })

  // 本来就成立的写法不许被改写(不制造 diff)。
  it.each(['这是**加粗**文字', '**🔥**热门', '~~删除~~。', '*斜体*与**加粗**'])('%s 原样往返', async (src) => {
    expect(await boot(src, true)).toBe(src)
  })
})

describe('装配', () => {
  it('MarkdownBlock:`.use(cjkFriendlyRemark)` 在 `.use(gfm)` 之后', () => {
    const src = readFileSync(join(__dirname, 'MarkdownBlock.tsx'), 'utf8')
    const gfmAt = src.indexOf('.use(gfm)')
    expect(gfmAt).toBeGreaterThan(-1)
    expect(src.indexOf('.use(cjkFriendlyRemark)')).toBeGreaterThan(gfmAt)
  })
})

describe('聊天气泡 components/Markdown', () => {
  const html = (content: string): string => renderToStaticMarkup(React.createElement(Markdown, { content }))
  it.each([
    ['**注意：**后面', '<strong>注意：</strong>后面'],
    ['*（备注）*继续', '<em>（备注）</em>继续'],
    ['~~（备注）~~继续', '<del>（备注）</del>继续'],
  ])('%s → %s', (src, expected) => {
    expect(html(src)).toContain(expected)
  })
})
