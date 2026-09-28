// @vitest-environment happy-dom
//
// I-03(评审 2026-09-27,用户拍板 #1):单个 `~` 不算删除线。`3~5小时，持续2~3周` 打开就被划线、编辑任意一处
// 落盘成 `3~~5`(Obsidian 里也变删除线);现场键入 `3~5` 又被转义成 `3\~5`。三层同口径(anchoredMarkRules.ts 注释):
// 输入规则只认 `~~`、解析两处 singleTilde:false、落盘只转义「紧挨另一个 `~`」的那种。
// 真 Milkdown(生产装配,parseFidelity.testkit):磁盘 md → PM → 序列化 → normalizeSerializedMd,与落盘同源。
import { describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import { bootEditor, roundTrip } from './parseFidelity.testkit'

const strikes = (b: Awaited<ReturnType<typeof bootEditor>>): string[] => {
  const out: string[] = []
  b.view.state.doc.descendants((n) => { if (n.isText && n.marks.some((m) => m.type.name === 'strike_through')) out.push(n.text!) })
  return out
}

describe('单个 `~` 逐字往返(不划线、不改写、不转义)', () => {
  it.each([
    ['评审原例', '范围: 每天3~5小时，持续2~3周\n'],
    ['中英混排', '约 3~5 天,好的~\n'],
    ['英文区间', 'en: 3~5 days or 2~3 weeks\n'],
    ['语气词', '好的~ 谢谢~\n'],
    ['一对单 `~` 包词', 'a ~删~ b\n'],
  ])('%s', async (_l, md) => {
    expect(await roundTrip(md)).toBe(md)
    const b = await bootEditor(md)
    try { expect(strikes(b)).toEqual([]) } finally { await b.destroy() }
  })

  it('编辑别处后落盘,`3~5` 仍是 `3~5`(评审:改一处就落成 `3~~5`)', async () => {
    const md = '编辑这里\n\n范围: 每天3~5小时，持续2~3周\n'
    const b = await bootEditor(md)
    try {
      const end = b.view.state.doc.firstChild!.nodeSize - 1
      b.view.dispatch(b.view.state.tr.setSelection(TextSelection.create(b.view.state.doc, end)).insertText('X'))
      expect(b.md()).toBe('编辑这里X\n\n范围: 每天3~5小时，持续2~3周\n')
    } finally { await b.destroy() }
  })
})

describe('`~~` 删除线与该转义的照旧', () => {
  it('`~~删~~` 仍是删除线且逐字往返', async () => {
    const md = '前 ~~删~~ 后\n'
    expect(await roundTrip(md)).toBe(md)
    const b = await bootEditor(md)
    try { expect(strikes(b)).toEqual(['删']) } finally { await b.destroy() }
  })
  it.each([
    ['字面 `~~`(转义过的)', 'a\\~\\~b\n'],
    ['字面 `~` 贴着删除线', 'a\\~~~删~~\n'],
    ['三连字面', 'x \\~\\~\\~ y\n'],
  ])('%s:落盘仍转义,重开不变删除线', async (_l, md) => {
    expect(await roundTrip(md)).toBe(md)
  })
})

describe('中文口语的连串 `~`', () => {
  it.each([
    ['好的~~~(三连不是定界符)', '好的\\~\\~\\~\n'],
    ['四连', '嗯\\~\\~\\~\\~ 好\n'],
  ])('%s:存量转义形逐字不变', async (_l, md) => {
    expect(await roundTrip(md)).toBe(md)
  })
})
