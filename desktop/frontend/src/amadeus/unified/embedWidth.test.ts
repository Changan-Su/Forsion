/** 嵌入宽度 `![[…|560]]` 的编解码 + 「管道段在别处另有含义」那道防线。
 *
 *  这条线是本轮唯一会**静默改别人渲染**的地方:统一把末段数字当宽度,`![[报告.md|2024]]`
 *  的跨笔记别名、`![[x.db|2024]]` 的视图名就会被吃掉。所以宽度只在判成 web/file 之后才读,
 *  这里正面钉住。 */
import { describe, it, expect } from 'vitest'
import { classifyEmbed } from './embedLayer'
import { embedWidthOf, withEmbedWidth, embedUrlOf, wikiSafeUrl } from '@amadeus-shared/pdfLink'
import { hostLabel } from '../blocks/markdown/MarkdownBlock'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'

/** classifyEmbed 只读 type.name / textContent / attrs.language —— 够用的假节点。 */
const para = (text: string): ProseNode =>
  ({ type: { name: 'paragraph' }, textContent: text, attrs: {} }) as unknown as ProseNode

describe('embedWidthOf / withEmbedWidth', () => {
  it('读末段纯数字', () => {
    expect(embedWidthOf('a.mp4#t=95|400')).toBe(400)
    expect(embedWidthOf('https://x.com/a|560')).toBe(560)
    expect(embedWidthOf('x.db|看板|300')).toBe(300)
  })
  it('没有管道段 / 末段非数字 → undefined', () => {
    expect(embedWidthOf('a.mp4')).toBeUndefined()
    expect(embedWidthOf('x.db|看板')).toBeUndefined()
    expect(embedWidthOf('报告.md|2024年度')).toBeUndefined()
  })
  it('位数越界不当宽度(1 位小于把手最小宽,5 位以上不像宽度)', () => {
    expect(embedWidthOf('a.mp4|5')).toBeUndefined()
    expect(embedWidthOf('a.mp4|123456')).toBeUndefined()
  })
  it('回写:换宽度 / 补宽度 / 去宽度,都不动前面的段', () => {
    expect(withEmbedWidth('a.mp4#t=95|400', 600)).toBe('a.mp4#t=95|600')
    expect(withEmbedWidth('a.mp4#t=95', 600)).toBe('a.mp4#t=95|600')
    expect(withEmbedWidth('x.db|看板', 600)).toBe('x.db|看板|600')
    expect(withEmbedWidth('a.mp4|400', null)).toBe('a.mp4')
  })
})

describe('classifyEmbed × 宽度', () => {
  it('web:宽度不进 URL', () => {
    const k = classifyEmbed(para('![[https://x.com/a|560]]'))
    expect(k).toEqual({ k: 'web', url: 'https://x.com/a', w: 560 })
  })
  it('媒体:时刻锚与宽度并存', () => {
    const k = classifyEmbed(para('![[a.mp4#t=95|400]]'))
    expect(k).toMatchObject({ k: 'file', name: 'a.mp4', fileKind: 'video', w: 400 })
    expect((k as { loc?: { at: number } }).loc?.at).toBe(95)
  })
  it('⚠️ 跨笔记别名不许被当宽度吃掉(target 原样保留、无 w)', () => {
    expect(classifyEmbed(para('![[报告.md|2024]]'))).toEqual({ k: 'note', target: '报告.md|2024' })
  })
  it('⚠️ 数据库视图名不许被当宽度吃掉', () => {
    expect(classifyEmbed(para('![[任务.db|2024]]'))).toEqual({ k: 'db', name: '任务.db', view: '2024' })
  })
})

describe('⚠️ URL 里的 `|` 是合法字符,只能剥末段宽度(Codex 2026-08-29)', () => {
  it('查询串里的管道不许被截断', () => {
    expect(embedUrlOf('https://x.test/?q=a|b')).toBe('https://x.test/?q=a|b')
    expect(classifyEmbed(para('![[https://x.test/?q=a|b]]'))).toEqual({ k: 'web', url: 'https://x.test/?q=a|b', w: undefined })
  })
  it('末段恰好是数字时才当宽度(其余仍属 URL)', () => {
    expect(classifyEmbed(para('![[https://x.test/?q=a|560]]'))).toEqual({ k: 'web', url: 'https://x.test/?q=a', w: 560 })
    expect(embedUrlOf('https://x.test/?q=a|b560')).toBe('https://x.test/?q=a|b560')
  })
  it('写入侧先编码,才不会造出读不回来的字面', () => {
    expect(wikiSafeUrl('https://x.test/?q=a|560')).toBe('https://x.test/?q=a%7C560')
    expect(embedUrlOf(wikiSafeUrl('https://x.test/?q=a|560'))).toBe('https://x.test/?q=a%7C560')
    expect(wikiSafeUrl('https://x.test/a]b')).toBe('https://x.test/a%5Db')
  })
  it('非网址仍是 null(别把文件名当 URL)', () => {
    expect(embedUrlOf('a.mp4#t=95|400')).toBeNull()
  })
})

describe('裸 URL 一律书签卡(2026-08-29:视频不再自动 embed)', () => {
  it('YouTube / B 站裸链 = bookmark,不是 web', () => {
    expect(classifyEmbed(para('https://www.youtube.com/watch?v=abc12345'))?.k).toBe('bookmark')
    expect(classifyEmbed(para('https://www.bilibili.com/video/BV1xx411c7mD'))?.k).toBe('bookmark')
  })
  it('嵌入形态才是播放器那条路(web)', () => {
    expect(classifyEmbed(para('![[https://www.youtube.com/watch?v=abc12345]]'))?.k).toBe('web')
  })
})

describe('hostLabel(「粘贴为 → 链接」的文字)', () => {
  it('取主机名并去 www.', () => {
    expect(hostLabel('https://www.example.com/a/b?c=1')).toBe('example.com')
    expect(hostLabel('https://chatgpt.com/c/6a91')).toBe('chatgpt.com')
  })
  it('解析不了就原样', () => {
    expect(hostLabel('不是地址')).toBe('不是地址')
  })
})
