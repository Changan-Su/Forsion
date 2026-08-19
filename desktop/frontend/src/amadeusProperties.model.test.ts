/** 属性面板模型契约(2026-08-14 评审 P0):插件 fm 键(canvas 几何等)只在展示层隐藏,
 *  模型持全量 —— 任何一次「编辑别的键」的 commit 重建都必须把隐藏键原值带回去。 */
import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { parseFmEntries, fmEntriesToYaml } from './amadeusProperties'

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

  it('编译器保留键仍被剔除;全删返回空串', () => {
    const { entries } = parseFmEntries('amadeus_page: hijack\nreal: 1')
    expect(fmEntriesToYaml(entries)).toBe('real: 1')
    expect(fmEntriesToYaml([])).toBe('')
  })
})
