// 路由决策(承载数据安全的那个判定)契约:素文件/外来 md 绝不进 v3 编译管线,
// v3 只在开关开启且升级器放行时走 unified,其余一律 block。
import { describe, expect, it } from 'vitest'
import { routeNote } from './router'

const NOW = '2026-08-13T00:00:00.000Z'
const V3 = ['---', 'amadeus_page: pg_r1', 'amadeus_schema: amadeus.page/3', 'amadeus_layout: {"type":"stack","children":[]}', '---', '', '<!-- a 1 -->', '', '正文。', ''].join('\n')

describe('routeNote', () => {
  it('plain markdown / foreign md → unified(今天它们是巨块,这是本轮的核心修复)', () => {
    const r = routeNote('note.md', '# 标题\n\n正文。\n', false, NOW)
    expect(r).toEqual({ editor: 'unified', initial: '# 标题\n\n正文。\n', diskRaw: '# 标题\n\n正文。\n', upgradedFromV3: false })
    // 无辜注释匹配标记语法也不改判(fm 键判定,spec §3.1)
    expect(routeNote('note.md', '<!-- a note -->\n\n正文。\n', false, NOW).editor).toBe('unified')
  })

  it('v4-structured → unified', () => {
    const src = '---\namadeus_schema: amadeus.page/4\namadeus_layout: {"v":4,"rows":[]}\n---\n\n正文。\n'
    expect(routeNote('note.md', src, false, NOW).editor).toBe('unified')
  })

  it('v3 → block(开关关);开关开 → unified 且喂升级后的 v4 源', () => {
    expect(routeNote('note.md', V3, false, NOW)).toEqual({ editor: 'block' })
    const r = routeNote('note.md', V3, true, NOW)
    expect(r.editor).toBe('unified')
    if (r.editor === 'unified') {
      expect(r.upgradedFromV3).toBe(true)
      expect(r.initial).toBe('正文。\n') // 平凡布局:全剥
    }
  })

  it('v3 + 开关开 + 升级被拒(mindmap fm 键)→ block,文件留在 v3', () => {
    const withMm = V3.replace('---\n\n', "mindmap: '{}'\n---\n\n")
    expect(routeNote('note.md', withMm, true, NOW)).toEqual({ editor: 'block' })
  })

  it('future schema → block(futureSchemaPage 原样只读在那边);读不到(新建流)→ block', () => {
    expect(routeNote('note.md', '---\namadeus_schema: amadeus.page/5\n---\n未来\n', true, NOW)).toEqual({ editor: 'block' })
    expect(routeNote('note.md', null, true, NOW)).toEqual({ editor: 'block' })
  })
})
