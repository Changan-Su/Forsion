/** split.ts 的 frontmatter 识别口径(2026-09-27 评审 D-01 / V-01)。 */
import { describe, it, expect } from 'vitest'
import { extractFrontmatterExtra, fmEntries, parseFrontmatter, stripFrontmatter } from './split'

describe('fmEntries(顶层 YAML 条目分组,V-01)', () => {
  it('键行 + 缩进续行 + 顶格 `- ` 序列项为一组', () => {
    expect(fmEntries(['a: 1', 'b:', '  x: 1', '  y:', '    - z', 'tags:', '- p', '- q', 'c: 2'])).toEqual([
      ['a: 1'], ['b:', '  x: 1', '  y:', '    - z'], ['tags:', '- p', '- q'], ['c: 2'],
    ])
  })
  it('夹在续行中间的空行/顶格注释归条目;条目之后的空行/注释单独成组', () => {
    expect(fmEntries(['# head', 'b:', '  x: 1', '', '# mid', '  y: 2', '', '# tail', 'c: 3'])).toEqual([
      ['# head'], ['b:', '  x: 1', '', '# mid', '  y: 2'], [''], ['# tail'], ['c: 3'],
    ])
  })
  it('开头就是续行(孤儿)各自成组,CRLF 行尾不影响判定', () => {
    expect(fmEntries(['  orphan: 1', 'k:\r', '  v: 1\r', '\r', 'j: 2\r'])).toEqual([
      ['  orphan: 1'], ['k:\r', '  v: 1\r'], ['\r'], ['j: 2\r'],
    ])
    // 空序列项 `-`(CRLF 下是 `-\r`)同样是续行,不是新键(N-1)
    expect(fmEntries(['tags:\r', '-\r', '- a\r', 'j: 2\r'])).toEqual([['tags:\r', '-\r', '- a\r'], ['j: 2\r']])
  })
})

describe('parseFrontmatter:CRLF 行尾(N-1,Windows / git autocrlf 的 v3 笔记)', () => {
  // 旧病:parseSimpleYaml 按 '\n' 切行,`(.*)$` 越不过行尾 \r → 只认得最后一行(收尾栅栏前那行没有 \r)。
  // v3 的 amadeus_schema / amadeus_layout 全丢 → classifyPageSource 判成 v4-plain,跳过升级,首击把 v3 布局写坏。
  const lines = ['---', 'amadeus_page: pg_r1', 'amadeus_schema: amadeus.page/3', 'amadeus_layout: {"type":"stack","children":[]}', 'tags: [t3]', '---', '', '正文。', '']
  it.each([
    ['CRLF', lines.join('\r\n')],
    ['BOM + CRLF', '\uFEFF' + lines.join('\r\n')],
  ])('%s:每个键都读得到,值不带 \\r', (_k, raw) => {
    expect(parseFrontmatter(raw)).toEqual({
      amadeus_page: 'pg_r1', amadeus_schema: 'amadeus.page/3', amadeus_layout: '{"type":"stack","children":[]}', tags: '[t3]',
    })
  })
})

describe('fmEntries:多行 flow 的顶格收尾(N-2)', () => {
  it('顶格 `}` / `]` / `,` 不可能起一个键,归上一个条目', () => {
    expect(fmEntries(['k: [', '  1', ']', 'j: {', '  a: 1', '}', 'm: {a: 1', ', b: 2}', 'n: 2'])).toEqual([
      ['k: [', '  1', ']'], ['j: {', '  a: 1', '}'], ['m: {a: 1', ', b: 2}'], ['n: 2'],
    ])
  })
  it('extractFrontmatterExtra:多行 flow 的 amadeus_canvas 连同顶格 `}` 一起剔(不在外来区留孤儿)', () => {
    const raw = ['---', 'tags: [a]', 'amadeus_schema: amadeus.page/4', 'amadeus_canvas: {', '  "v": 1, "mode": "canvas"', '}', 'aliases: [z]', '---', '正文'].join('\n')
    expect(extractFrontmatterExtra(raw)).toBe('tags: [a]\naliases: [z]')
  })
})

describe('extractFrontmatterExtra:amadeus_* 按条目剔除(V-01)', () => {
  it('块状写法的 amadeus_canvas/amadeus_layout 连同续行一起剔,外来键逐字留下', () => {
    const raw = [
      '---', 'amadeus_schema: amadeus.page/4', 'amadeus_canvas:', '  v: 1', '  cards:', '    - ref: k1', '      x: 480',
      'tags:', '  - a', 'amadeus_layout:', '  v: 4', '  rows: []', '# 备注', 'status: draft', '---', '正文',
    ].join('\n')
    expect(extractFrontmatterExtra(raw)).toBe('tags:\n  - a\n# 备注\nstatus: draft')
  })
  it('单行写法与老口径一致', () => {
    expect(extractFrontmatterExtra('---\n# n\namadeus_schema: amadeus.page/4\nicon: "📘"\n---\nx')).toBe('# n\nicon: "📘"')
  })
})

describe('stripFrontmatter:文件头 BOM(D-01)', () => {
  it('BOM + fm 整块剥掉(与 remark 同口径)', () => {
    for (const raw of ['\uFEFF---\ntags: [a]\n---\nbody\n', '\uFEFF---\r\ntags: [a]\r\n---\r\nbody\n']) {
      expect(stripFrontmatter(raw)).toBe('body\n')
      expect(parseFrontmatter(raw).tags).toBe('[a]')
    }
  })
  it('BOM 无 fm:原样(不剥 BOM,也不误认正文里的 ---)', () => {
    expect(stripFrontmatter('\uFEFF# T\n\n---\n\nx\n')).toBe('\uFEFF# T\n\n---\n\nx\n')
  })
})
