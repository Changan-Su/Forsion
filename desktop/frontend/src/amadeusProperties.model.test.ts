/** 属性面板模型契约(2026-08-14 评审 P0):插件 fm 键(canvas 几何等)只在展示层隐藏,
 *  模型持全量 —— 任何一次「编辑别的键」的 commit 重建都必须把隐藏键原值带回去。 */
import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { parseFmEntries, fmEntriesToYaml, draftToCommit } from './amadeusProperties'
import { patchYamlText } from '@amadeus-shared/db/pageFrontmatter'

const FM = [
  'status: draft',
  'canvas: \'{"v":1,"n":{"b1":{"x":40,"y":80}},"e":[]}\'',
  'tags:',
  '  - alpha',
].join('\n')

describe('属性面板模型:隐藏键经 commit 重建存活', () => {
  it('编辑别的键 → canvas 键与值原样保留', () => {
    const { ok, entries } = parseFmEntries(FM)
    expect(ok).toBe(true)
    // 模拟面板行编辑:全量列表按 idx 改 status(隐藏键 canvas 就在列表里,不许先 filter)
    const edited = entries.map((e) => (e.key === 'status' ? { ...e, value: 'done' } : e))
    const out = fmEntriesToYaml(edited)
    const round = parseYaml(out) as Record<string, unknown>
    expect(round.status).toBe('done')
    expect(round.canvas).toBe('{"v":1,"n":{"b1":{"x":40,"y":80}},"e":[]}')
    expect(round.tags).toEqual(['alpha'])
  })

  it('删除可见键 → 隐藏键不受株连', () => {
    const { entries } = parseFmEntries(FM)
    const idx = entries.findIndex((e) => e.key === 'status')
    const out = fmEntriesToYaml(entries.filter((_, j) => j !== idx))
    const round = parseYaml(out) as Record<string, unknown>
    expect(round.status).toBeUndefined()
    expect(round.canvas).toContain('"b1"')
  })

  it('行级提交(D-20):编辑别的键 → 隐藏的 canvas 行字节不变', () => {
    const out = patchYamlText(FM, { status: 'done' })!
    expect(out).toBe(FM.replace('status: draft', 'status: done'))
    expect(patchYamlText(FM, { status: undefined })).toBe(FM.replace('status: draft\n', ''))
  })

  it('编译器保留键仍被剔除;全删返回空串', () => {
    const { entries } = parseFmEntries('amadeus_page: hijack\nreal: 1')
    expect(fmEntriesToYaml(entries)).toBe('real: 1')
    expect(fmEntriesToYaml([])).toBe('')
  })
})

// C-01(评审 2026-09-27 P0):失焦提交判据。DOM 层(外部改写后白点零写入、显示新值)在
// unified-page.check 的 PR 组;这里钉纯判据,尤其「只比当前 prop 不够」的那条变体。
describe('属性面板失焦判据 draftToCommit(C-01)', () => {
  it('没打过字(草稿 null)→ 不写,哪怕外部已把值改了(白点一下绝不写盘)', () => {
    expect(draftToCommit(null, 'todo', 'done')).toBeNull()
  })

  it('打了字又改回开始编辑时的值,期间外部改了同字段 → 不写(只比当前值会把旧值写回)', () => {
    expect(draftToCommit('todo', 'todo', 'done')).toBeNull()
  })

  it('与当前值相同 → 不写;真改了 → 返回草稿', () => {
    expect(draftToCommit('done', 'todo', 'done')).toBeNull()
    expect(draftToCommit('doing', 'todo', 'todo')).toBe('doing')
    // 冲突(本地胜):外部改成 done、用户打成 doing → 以用户输入为准
    expect(draftToCommit('doing', 'todo', 'done')).toBe('doing')
  })

  it('归一函数(数字/键名 trim)参与三方比较,返回归一后的值', () => {
    const trim = (s: string): string => s.trim()
    expect(draftToCommit(' 3 ', '3', '3', trim)).toBeNull()
    expect(draftToCommit(' 7 ', '3', '3', trim)).toBe('7')
  })
})
