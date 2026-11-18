// @vitest-environment happy-dom
//
// 页内目录块(```toc):落盘逐字往返(真 Milkdown,生产装配顺序,见 parseFidelity.testkit)、嵌入层认领口径、
// 列哪些标题。真浏览器那一半(插入 / 跟着标题变 / 点了跳 / 露源码改范围 / 撤销):npm run check:tocblock。
import { describe, expect, it } from 'vitest'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { TOC_FENCE, parseTocRange } from '@amadeus-shared/tocBlock'
import { bootEditor, roundTrip } from '../markdown/parseFidelity.testkit'
import { classifyEmbed } from '../../unified/embedLayer'
import { tocHeadings } from './TocBlock'

const code = (language: string, textContent: string) => ({ type: { name: 'code_block' }, attrs: { language }, textContent }) as unknown as ProseNode

describe('```toc 存盘重开逐字不变', () => {
  it.each([
    ['斜杠插入的骨架', `${TOC_FENCE}\n`],
    ['夹在正文与标题之间', `开头一段。\n\n${TOC_FENCE}\n\n## 本周目标\n\n正文。\n`],
    ['不认识的行原样保留', '```toc\nstyle: bullet\nmin_depth: 2\ntitle: 本页\nvaried_style: true\n```\n'],
    ['空块', '```toc\n```\n'],
  ])('%s', async (_label, md) => {
    expect(await roundTrip(md)).toBe(md)
  })
})

describe('classifyEmbed · toc', () => {
  it('任何内文都认领(空块 / 写坏的范围也渲染成目录)', () => {
    expect(classifyEmbed(code('toc', 'min_depth: 1\nmax_depth: 3'))).toEqual({ k: 'toc', src: 'min_depth: 1\nmax_depth: 3' })
    expect(classifyEmbed(code('toc', ''))).toEqual({ k: 'toc', src: '' })
    expect(classifyEmbed(code('toc', 'max_depth: lots'))).toEqual({ k: 'toc', src: 'max_depth: lots' })
  })
  it('别的语言照旧是代码', () => {
    expect(classifyEmbed(code('tocx', 'min_depth: 1'))).toBeNull()
    expect(classifyEmbed(code('', 'toc'))).toBeNull()
  })
})

describe('tocHeadings', () => {
  it('按范围列本页标题(文档顺序),空标题和代码块里的 # 行不算', async () => {
    const b = await bootEditor('# 总览\n\n```toc\n```\n\n## 三方分工\n\n### 设计\n\n#### 太深\n\n## \n\n```md\n## 围栏里的假标题\n```\n\n- 列表\n\n  ## 列表里的标题\n')
    try {
      const all = tocHeadings(b.view.state.doc, parseTocRange(''))
      expect(all.map((h) => `${h.level}:${h.text}`)).toEqual(['1:总览', '2:三方分工', '3:设计', '2:列表里的标题'])
      expect(tocHeadings(b.view.state.doc, parseTocRange('min_depth: 2\nmax_depth: 4')).map((h) => h.text)).toEqual(['三方分工', '设计', '太深', '列表里的标题'])
      // pos 指向真实的标题节点(点条目跳转靠它取 DOM)
      for (const h of all) expect(b.view.state.doc.nodeAt(h.pos)?.type.name).toBe('heading')
    } finally { await b.destroy() }
  })
})
