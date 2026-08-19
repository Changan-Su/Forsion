// fmExtra round-trip:外来 frontmatter(Obsidian properties 等)必须在 载入→编译 间逐字保留。
import { describe, expect, it } from 'vitest'
import { compile } from './compile'
import { parsePageSource } from './page'
import type { BlockId, LoadedPage } from './types'

const NOW = '2026-07-02T00:00:00.000Z'

function contentsOf(page: LoadedPage): Record<BlockId, string> {
  return Object.fromEntries(Object.entries(page.blocks).map(([id, b]) => [id, b.content]))
}

const FOREIGN = [
  '---',
  'tags:',
  '  - alpha',
  '  - beta',
  '# 用户注释也要保住',
  'status: draft',
  '---',
  '',
  '第一段。',
  '',
  '第二段(与上段同块,空行不拆块)。',
  '',
].join('\n')

describe('compiler fmExtra round-trip', () => {
  it('adopts foreign frontmatter into fmExtra and keeps the body one verbatim block', () => {
    const page = parsePageSource('note.md', FOREIGN, NOW)
    expect(page.manifest.fmExtra).toBe(['tags:', '  - alpha', '  - beta', '# 用户注释也要保住', 'status: draft'].join('\n'))
    const blocks = Object.values(page.blocks)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].content).toContain('第一段。\n\n第二段')
  })

  it('writes fmExtra back on compile and stays byte-stable across re-parses', () => {
    const p1 = parsePageSource('note.md', FOREIGN, NOW)
    const md1 = compile(p1.manifest, contentsOf(p1))
    expect(md1).toContain('  - beta')
    expect(md1).toContain('status: draft')
    expect(md1.indexOf('status: draft')).toBeLessThan(md1.indexOf('第一段'))

    const p2 = parsePageSource('note.md', md1, NOW) // 现在是 v3(带 amadeus_page)
    expect(p2.manifest.fmExtra).toBe(p1.manifest.fmExtra)
    const md2 = compile(p2.manifest, contentsOf(p2))
    expect(md2).toBe(md1)
  })

  it('sanitizes reserved keys and bare --- lines out of fmExtra at compile time', () => {
    const p = parsePageSource('note.md', FOREIGN, NOW)
    // 属性面板原文模式等写入方可能夹带保留键/裸 '---':落盘会劫持页 id / 提早闭合 frontmatter。
    p.manifest.fmExtra = ['amadeus_page: hijacked', 'status: draft', '---', 'evil: body'].join('\n')
    const md = compile(p.manifest, contentsOf(p))
    const fm = md.split('\n---\n')[0]
    expect(fm).toContain('status: draft')
    expect(fm).toContain('evil: body') // 键本身无害,保留
    expect(fm).not.toContain('amadeus_page: hijacked')
    const reparsed = parsePageSource('note.md', md, NOW)
    expect(reparsed.manifest.id).toBe(p.manifest.id) // 页 id 未被劫持
  })

  it('emits clean frontmatter when there is nothing foreign', () => {
    const p = parsePageSource('note.md', '只有正文,没有 frontmatter。\n', NOW)
    expect(p.manifest.fmExtra).toBeUndefined()
    const md = compile(p.manifest, contentsOf(p))
    const fm = md.split('---')[1]
    expect(fm.trim().split('\n')).toHaveLength(3) // 仅 amadeus_page/schema/layout
  })

  it('CRLF 正文:载入→编译 不引入 \\r\\n 垃圾前缀(前导正则吃 \\r,评审 P2)', () => {
    const src = '---\r\ntags: x\r\n---\r\n\r\n首段。\r\n\r\n次段。\r\n'
    const p = parsePageSource('note.md', src, NOW)
    const first = Object.values(p.blocks)[0]
    expect(first.content.startsWith('\r') || first.content.startsWith('\n')).toBe(false)
    expect(first.content).toContain('首段。')
  })

  it('长空白 run 不冻结(trimEnd 线性;/\\s+$/ 二次方回溯,评审 P1)', () => {
    const src = `前文。${' '.repeat(60000)}x\n`
    const t0 = Date.now()
    const p = parsePageSource('note.md', src, NOW)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(Object.values(p.blocks)[0].content).toContain('前文。')
  })

  it('块首行首制表符(段落缩进档)经 载入→编译 往返逐字保留', () => {
    // indentIo(2026-08-14):缩进落盘=行首字面 \t。parseBody 的 flush 只掐空行,
    // 不许把首个非空行的行首横向空白一并 trim 掉,否则每次 parse 丢一层缩进。
    const src = ['\t\t缩进两档的段落。', '', '正常段落。', ''].join('\n')
    const p1 = parsePageSource('note.md', src, NOW)
    const first = Object.values(p1.blocks)[0]
    expect(first.content.startsWith('\t\t缩进两档的段落。')).toBe(true)
    const md1 = compile(p1.manifest, contentsOf(p1))
    const p2 = parsePageSource('note.md', md1, NOW)
    expect(Object.values(p2.blocks)[0].content).toBe(first.content)
    expect(compile(p2.manifest, contentsOf(p2))).toBe(md1)
  })
})

describe('闭合符(2026-08-19 画布双标记)', () => {
  it('parseBody:闭合符收束块辖域,卡后内容是匿名主流,不吞进块', async () => {
    const { parseBody } = await import('./markers')
    const body = ['<!-- a k1 -->', '卡一甲。', '<!-- /a k1 -->', '', '卡后正文。', '', '<!-- a k2 -->', '卡二甲。'].join('\n')
    const blocks = parseBody(body)
    expect(blocks.map((b) => [b.id, b.content])).toEqual([
      ['k1', '卡一甲。'],
      [null, '卡后正文。'],
      ['k2', '卡二甲。'],
    ])
  })
  it('parseBody:无闭合符 = 旧辖域(到下一锚或文件尾),v3 文件行为不变', async () => {
    const { parseBody } = await import('./markers')
    const body = ['<!-- a k1 -->', '甲。', '<!-- a k2 -->', '乙。'].join('\n')
    expect(parseBody(body).map((b) => [b.id, b.content])).toEqual([['k1', '甲。'], ['k2', '乙。']])
  })
})

describe('闭合符畸形输入(Codex 08-19:编译器与编辑器辖域必须一致)', () => {
  it('parseBody:id 不匹配的闭合符按字面保留,不收束当前块', async () => {
    const { parseBody } = await import('./markers')
    const body = ['<!-- a k1 -->', '甲。', '<!-- /a k2 -->', '乙。', '<!-- /a k1 -->', '', '尾流。'].join('\n')
    expect(parseBody(body).map((b) => [b.id, b.content])).toEqual([
      ['k1', '甲。\n<!-- /a k2 -->\n乙。'],
      [null, '尾流。'],
    ])
  })
  it('parseBody:孤儿闭合符(无开锚在途)按字面保留在匿名主流', async () => {
    const { parseBody } = await import('./markers')
    const body = ['前文。', '<!-- /a k9 -->', '后文。'].join('\n')
    expect(parseBody(body).map((b) => [b.id, b.content])).toEqual([[null, '前文。\n<!-- /a k9 -->\n后文。']])
  })
})
