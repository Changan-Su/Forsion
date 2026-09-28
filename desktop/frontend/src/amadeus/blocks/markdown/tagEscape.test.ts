// @vitest-environment happy-dom
//
// R-25(评审 2026-09-27 P1):行首 `#tag` 落盘被转义成 `\#tag`,标签索引(parseTags)与 Obsidian 都不认。
// 真 Milkdown(生产装配,parseFidelity.testkit)走「解析 → 序列化 → normalizeSerializedMd」。
// 真浏览器那一半:评审探针 verify-rich-5/tags.cjs(外来 md 编辑别处 / 新段行首亲手敲 `#tag`)。
// 负对照:把 normalizeSerializedMd 里的 unescapeTagAtLineStart 摘掉 → 「逐字往返」一组全红。
import { describe, expect, it } from 'vitest'
import { parseTags } from '@amadeus-shared/links'
import { roundTrip } from './parseFidelity.testkit'
import { unescapeTagAtLineStart } from './tagEscape'
import { normalizeFragmentMd } from './MarkdownBlock'

describe('行首 #tag 逐字往返(R-25)', () => {
  it.each([
    ['段首标签', 'ANCHOR\n\n#tag 与 #嵌套/标签 正文\n'],
    ['独占一段', '#tag\n'],
    ['列表项', '* #todo 买菜\n* 普通 #tag\n'],
    ['有序列表', '1. #first 一\n2. #second 二\n'],
    ['任务项', '* [ ] #todo 待办\n* [x] #done 完成\n'],
    ['引用', '> #idea 想法\n'],
    ['嵌套列表', '* 外层\n  * #inner 里层\n'],
    ['段内软换行后的行首', '第一行\n#tag 第二行\n'],
  ])('%s', async (_label, md) => {
    const out = await roundTrip(md)
    // 只比非空行:紧凑列表落盘变松散是 D-05(另案),与本条无关
    const lines = (s: string): string[] => s.split('\n').filter(Boolean)
    expect(lines(out)).toEqual(lines(md))
    expect(out).not.toContain('\\#')
  })

  it('落盘结果 parseTags 拿得到', async () => {
    const out = await roundTrip('#tag 正文\n\n* #todo 买菜\n\n> #idea 想法\n')
    expect(parseTags(out)).toEqual(expect.arrayContaining(['tag', 'todo', 'idea']))
  })

  it('去掉转义会变成标题的三种保留转义:`\\# ` / 行尾 `\\#` / `\\##`', async () => {
    for (const md of ['\\# 不是标题\n', '\\#\n', '\\##tag\n', '* \\# 列表里也不是标题\n']) {
      expect(await roundTrip(md)).toBe(md)
    }
  })

  it('真标题不受影响', async () => {
    expect(await roundTrip('# 标题\n\n## 二级 #tag\n')).toBe('# 标题\n\n## 二级 #tag\n')
  })

  it('围栏代码里的 `\\#` 逐字', async () => {
    const md = '```sh\n\\#tag 注释\n#include <x>\n```\n\n#tag\n'
    expect(await roundTrip(md)).toBe(md)
  })

  it('公式块里 LaTeX 的 `\\#`(字面井号)不被剥成 `#`(链序:须在 unescapeMathSource 之前)', async () => {
    const md = '$$\n\\#x + 1\n$$\n'
    expect(await roundTrip(md)).toBe(md)
  })
})

describe('unescapeTagAtLineStart(纯函数)', () => {
  it('前缀叠加与只动行首', () => {
    expect(unescapeTagAtLineStart('> * [ ] \\#a\n  \\#b 续行\ntext \\#c')).toBe('> * [ ] #a\n  #b 续行\ntext \\#c')
  })
  it('片段规范化(切块 / 结构化复制)同样还原', () => {
    expect(normalizeFragmentMd('\\#tag 片段\n')).toBe('#tag 片段\n')
  })
})
