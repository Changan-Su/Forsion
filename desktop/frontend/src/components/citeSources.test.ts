/**
 * 搜索来源编号(借鉴 DeepSeek chat-demo 方案 ②A)的渲染端判定:
 *   - 同一网址同一个号,按正文里第一次出现的顺序编;正文没引用的来源没有号
 *   - 老会话(工具结果上没有 metadata.sources)从文字里认网址,web_fetch 的正文不扫
 *   - web_fetch 要的网址与跳转后的网址认成同一页
 */
import { describe, expect, it } from 'vitest'
import type { ToolEvent, UiMessage, WebSource } from '../../../../tangu-agent/src/contracts/clientTypes'
import { cardExcerpt, citeEntryOf, citeIndexOf, citeKey, excerptAround, linkUrlsInOrder, sourcesFromMetadata } from './citeSources'

const A = 'https://www.hokkaido-ski.jp/niseko/beginner'
const B = 'https://www.rusutsu-resort.com/winter/lessons'
const C = 'https://travel.example-hokkaido.cn/furano-2026'
const src = (url: string, extra: Partial<WebSource> = {}): WebSource => ({ url, site: new URL(url).hostname.replace(/^www\./, ''), ...extra })
const search = (id: string, sources?: WebSource[], result = ''): ToolEvent => ({ id, name: 'web_search', arguments: '{"query":"q"}', done: true, result, ...(sources ? { sources } : {}) })
const fetchEv = (id: string, url: string, extra: Partial<ToolEvent> = {}): ToolEvent => ({ id, name: 'web_fetch', arguments: JSON.stringify({ url }), done: true, result: `[${url}]\nCite for the user: …\nbody`, ...extra })
const msg = (content: string, toolEvents: ToolEvent[], id = 'a1'): Pick<UiMessage, 'id' | 'content' | 'toolEvents'> => ({ id, content, toolEvents })

describe('citeKey', () => {
  it('不看协议、www、大小写、尾斜杠和片段;查询保留', () => {
    expect(citeKey('https://www.Example.com/a/')).toBe(citeKey('http://example.com/a'))
    expect(citeKey(`${A}#:~:text=%E7%BC%93`)).toBe(citeKey(A))
    expect(citeKey('https://e.com/a?x=1')).not.toBe(citeKey('https://e.com/a?x=2'))
  })
  it('中文路径:原样与百分号转义是同一页', () => {
    expect(citeKey('https://e.com/文档/页')).toBe(citeKey('https://e.com/%E6%96%87%E6%A1%A3/%E9%A1%B5'))
  })
  it('不是网页地址的给 null', () => {
    expect(citeKey('mailto:a@b.c')).toBeNull()
    expect(citeKey('not a url')).toBeNull()
  })
})

describe('linkUrlsInOrder', () => {
  it('按出现顺序认行内链接、尖括号、自动链接和裸网址,代码里的不算', () => {
    const md = [
      `先看 [缓坡](${A}) 和 <${B}>。`,
      '```',
      `[代码里](${C})`,
      '```',
      `行内代码 \`${C}\` 不算;裸网址 ${C}。`,
      `带括号 [x](https://en.wikipedia.org/wiki/Foo_(bar)) 结束`,
    ].join('\n')
    expect(linkUrlsInOrder(md)).toEqual([A, B, C, 'https://en.wikipedia.org/wiki/Foo_(bar)'])
  })
})

describe('citeIndexOf', () => {
  const sources = [src(A, { title: '二世谷新手指南', snippet: '山脚有一条 1.2 公里的缓坡。', date: '2026-10-28' }), src(B), src(C)]

  it('同一网址同一个号,按第一次出现编;没引用的没有号', () => {
    const idx = citeIndexOf(msg(`[留寿都](${B}) … [缓坡](${A}) … 再说一次 [缓坡长](${A}/)`, [search('s1', sources)]))!
    expect(citeEntryOf(idx, B)?.n).toBe(1)
    expect(citeEntryOf(idx, A)?.n).toBe(2)
    expect(citeEntryOf(idx, `${A}/`)).toBe(citeEntryOf(idx, A))
    expect(citeEntryOf(idx, C)?.n).toBeUndefined()
    expect(citeEntryOf(idx, 'https://other.example/x')).toBeUndefined()
    expect(idx.entries.map((e) => e.url)).toEqual([A, B, C])
    expect(citeEntryOf(idx, A)?.src?.title).toBe('二世谷新手指南')
  })

  it('没有搜索 / 读网页的回答直接是 null;出错 / 没跑完的调用不算', () => {
    expect(citeIndexOf(msg(`[x](${A})`, [{ id: 'r', name: 'read_file', done: true }]))).toBeNull()
    expect(citeIndexOf(msg(`[x](${A})`, []))).toBeNull()
    expect(citeIndexOf(msg(`[x](${A})`, [{ ...search('s', sources), isError: true }, { ...search('t', sources), done: false }]))).toBeNull()
  })

  it('web_fetch:要的网址与跳转后的同一页;搜到过的标读过,摘要用读到的文字', () => {
    const final = 'https://www.rusutsu-resort.com/winter/lessons-2026'
    const ev = fetchEv('f1', B, { result: `[${final}]\nCite for the user: …\n中文、英文教练全季可约,半天团体课 9,800 日元起。`, sources: [src(final, { title: '冬季课程' })] })
    const idx = citeIndexOf(msg(`[教练全季可约](${final})`, [search('s1', sources), ev]))!
    const e = citeEntryOf(idx, B)!
    expect(citeEntryOf(idx, final)).toBe(e)
    expect(e.n).toBe(1)
    expect(e.searchCalls).toEqual(['s1'])
    expect(e.fetchCalls).toEqual(['f1'])
    expect(cardExcerpt(e, '教练全季可约')).toMatchObject({ hit: '教练全季可约' })
  })

  it('老会话:没有结构化来源,网址从结果文字里认;web_fetch 只认参数和头,正文里的链接不当来源', () => {
    const text = `Search results (Bocha):\n1. 二世谷\n  ${A}\n  缓坡。\n2. 留寿都\n  ${B}.`
    const page = fetchEv('f1', C, { result: `[${C}]\nCite…\n正文里有 [别的站](https://elsewhere.example/p) 链接` })
    const idx = citeIndexOf(msg(`[缓坡](${A}) [课程](${B}) [富良野](${C}) [别处](https://elsewhere.example/p)`, [search('s1', undefined, text), page]))!
    expect([A, B, C].map((u) => citeEntryOf(idx, u)?.n)).toEqual([1, 2, 3])
    expect(citeEntryOf(idx, A)?.src).toBeUndefined() // 悬停卡退回素卡
    expect(citeEntryOf(idx, 'https://elsewhere.example/p')).toBeUndefined()
  })

  it('一条回答里两次搜索都搜到同一页:一个条目、两个调用', () => {
    const idx = citeIndexOf(msg(`[a](${A})`, [search('s1', [src(A)]), search('s2', [src(A), src(B)])]))!
    expect(idx.entries).toHaveLength(2)
    expect(citeEntryOf(idx, A)?.searchCalls).toEqual(['s1', 's2'])
  })

  it('缓存:同一份 toolEvents + 正文给同一个对象;正文一变就重编', () => {
    const events = [search('s1', sources)]
    const one = citeIndexOf(msg(`[a](${A})`, events))
    expect(citeIndexOf(msg(`[a](${A})`, events))).toBe(one)
    const two = citeIndexOf(msg(`[b](${B}) [a](${A})`, events))!
    expect(two).not.toBe(one)
    expect(citeEntryOf(two, B)?.n).toBe(1)
  })
})

describe('sourcesFromMetadata', () => {
  it('只认 web_search / web_fetch;站点按网址自己算;非网页地址丢掉', () => {
    expect(sourcesFromMetadata('read_file', { sources: [src(A)] })).toBeUndefined()
    expect(sourcesFromMetadata('web_search', undefined)).toBeUndefined()
    expect(sourcesFromMetadata('web_search', { sources: [{ url: 'javascript:alert(1)' }, { url: A, site: 'evil.example', title: 1, date: 'yesterday' }] }))
      .toEqual([{ url: A, site: 'hokkaido-ski.jp' }])
  })
})

describe('excerptAround', () => {
  it('找到被引那句,前面太长从附近句首起', () => {
    const t = `${'前文很长很长。'.repeat(20)}格兰比洛雪场山脚有一条 1.2 公里的缓坡,适合新手。后面还有。`
    const ex = excerptAround(t, '一条 1.2 公里的缓坡')!
    expect(ex.hit).toBe('一条 1.2 公里的缓坡')
    expect(ex.before.startsWith('格兰比洛')).toBe(true)
    expect(excerptAround(t, '不存在的句子')).toBeNull()
  })
})
