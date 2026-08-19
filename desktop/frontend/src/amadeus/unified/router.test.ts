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

  it('.canvas.md 走普通笔记路由(2026-08-16 画布转原生:它不再是一等文件类型)', () => {
    // 用户报过两轮「画布的笔记模式跟普通 md 没对齐」——根因就是这里恒判 block(v3 块世界)。
    // .mindmap.md 仍留 v3(那套还是外置插件),两者的差别就是这条断言在守的东西。
    expect(routeNote('板.canvas.md', V3, true, NOW).editor).toBe('unified')
    expect(routeNote('图.mindmap.md', V3, true, NOW)).toEqual({ editor: 'block' })
  })

  it('插件格式画布笔记 → 走专用迁移进 unified(不是被 fm 键闸挡回 block)', () => {
    // 2026-08-17 用户实报「切换按钮没了」的根因就在这条:存量画布笔记 fm 带裸 `canvas:` 键,
    // 被 FOREIGN_ID_TREE_KEY 拒升级 → 恒判 block → 模式钮所在的 UnifiedPage 根本不上场,
    // 而插件又已退休 —— 两头落空。红了说明迁移这条路又断了。
    const plugin = ['---', 'amadeus_page: pg_x', 'amadeus_schema: amadeus.page/3',
      'amadeus_layout: {"type":"stack","children":[{"type":"row","id":"r1","columns":[{"id":"c1","width":1,"children":[{"ref":"1"},{"ref":"2"}]}]}]}',
      `canvas: '{"v":1,"mode":"canvas","n":{"2":{"x":9,"y":9,"w":300}}}'`, '---', '',
      '<!-- a 1 -->', '', '主卡。', '', '<!-- a 2 -->', '', '卡片。', ''].join('\n')
    const r = routeNote('板.canvas.md', plugin, true, NOW)
    expect(r.editor).toBe('unified')
    if (r.editor !== 'unified') return
    expect(r.initial).toContain('amadeus_canvas:')
    expect(r.diskRaw).toBe(plugin) // 回灌基线必须是盘上原字节,否则挂载补读会把 v3 原文灌回来冲掉迁移
    // 开关关掉时不迁移(用户显式选择留在块编辑器)。
    expect(routeNote('板.canvas.md', plugin, false, NOW)).toEqual({ editor: 'block' })
  })

  it('future schema → block(futureSchemaPage 原样只读在那边);读不到(新建流)→ block', () => {
    expect(routeNote('note.md', '---\namadeus_schema: amadeus.page/5\n---\n未来\n', true, NOW)).toEqual({ editor: 'block' })
    expect(routeNote('note.md', null, true, NOW)).toEqual({ editor: 'block' })
  })
})
