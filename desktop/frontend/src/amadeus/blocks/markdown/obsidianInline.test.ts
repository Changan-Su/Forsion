// @vitest-environment happy-dom
//
// I-17(评审 2026-09-27,合并 R-20;拍板 #11):`==高亮==` / `%%注释%%` 零 schema 装饰的扫描口径,
// 以及行首 `==` 落盘不带反斜杠(setext 防护过宽)。渲染与光标露源码在台架:unified-page.check 的 P14e;
// 往返语料:check:rtcorpus 的 i17 条(含 <kbd>/<sub>/<sup>)。
import { describe, expect, it } from 'vitest'
import { roundTrip } from './parseFidelity.testkit'
import { scanObsidian } from './obsidianInline'
import { unescapeHighlightAtLineStart } from './tagEscape'
import { normalizeFragmentMd } from './MarkdownBlock'

const spans = (s: string): string[] => scanObsidian(s).map((x) => `${x.kind}:${s.slice(x.from, x.to)}`)

describe('scanObsidian', () => {
  it('高亮与注释', () => {
    expect(spans('x ==高亮== y')).toEqual(['hl:==高亮=='])
    expect(spans('a==b==c')).toEqual(['hl:==b=='])
    expect(spans('文字 %%注释%% 结尾')).toEqual(['cmt:%%注释%%'])
    expect(spans('%%\n多行\n%%')).toEqual(['cmt:%%\n多行\n%%'])
  })
  it('不误伤:=== / 贴空白 / 空内容 / 跨行 / 未闭合 / 公式', () => {
    expect(spans('a === b 与 x == y')).toEqual([])
    expect(spans('== 空白 ==')).toEqual([])
    expect(spans('====')).toEqual([])
    expect(spans('==a\nb==')).toEqual([])
    expect(spans('50%% 没收尾')).toEqual([])
    expect(spans('$a==b==c$')).toEqual([])
  })
  it('注释里的 == 不单独渲染', () => {
    expect(spans('%%里 ==x== 头%% 外 ==y==')).toEqual(['cmt:%%里 ==x== 头%%', 'hl:==y=='])
  })
})

describe('行首 ==高亮== 逐字往返(I-17)', () => {
  it.each([
    ['段首', '==重点== 正文\n'],
    ['列表项', '* ==项== 一\n* 二\n'],
    ['引用', '> ==引用== 行\n'],
  ])('%s', async (_n, md) => {
    expect(await roundTrip(md)).toBe(md)
  })
  it('setext 下划线(整行只有 =)的转义保留', () => {
    expect(unescapeHighlightAtLineStart('\\==\n')).toBe('\\==\n')
    expect(unescapeHighlightAtLineStart('\\=== \n')).toBe('\\=== \n')
    expect(unescapeHighlightAtLineStart('\\==x==\n')).toBe('==x==\n')
  })
  it('片段规范化(切块 / 结构化复制)同样还原', () => {
    expect(normalizeFragmentMd('\\==重点== 片段\n')).toBe('==重点== 片段\n')
  })
})
