// 画布插件格式 → v4 原生画布的迁移契约(2026-08-17)。
// 背景:用户的三篇存量画布笔记因为 fm 带裸 `canvas:` 键被 FOREIGN_ID_TREE_KEY 拒升级,
// 于是插件被退休后「两头落空」——插件的双模式钮没了,原生的模式钮又只活在 v4 路径上。
import { describe, expect, it } from 'vitest'
import { isPluginCanvasSource, migratePluginCanvas } from './canvasMigrate'
import { classifyPageSource } from './v4'

const NOW = '2026-08-17T00:00:00.000Z'
const src = (fm: string[], body: string[]): string => ['---', 'amadeus_page: pg_x', 'amadeus_schema: amadeus.page/3', ...fm, '---', '', ...body].join('\n')
const LAYOUT_1COL = 'amadeus_layout: {"type":"stack","children":[{"type":"row","id":"r1","columns":[{"id":"c1","width":1,"children":[{"ref":"1"},{"ref":"2"},{"ref":"3"}]}]}]}'

describe('migratePluginCanvas', () => {
  const PLUGIN = src(
    [LAYOUT_1COL, `canvas: '{"v":1,"mode":"canvas","n":{"2":{"x":900,"y":40,"w":480},"3":{"x":-4,"y":198}},"e":[{"a":"2","b":"3","label":"因为"},{"a":"3","b":"s1"}],"s":[{"id":"s1","t":"rect","x":60,"y":300,"w":220,"h":110}]}'`, 'icon: 🏦'],
    ['<!-- a 1 -->', '', '主卡这段没坐标。', '', '<!-- a 2 -->', '', '第一张卡。', '', '<!-- a 3 -->', '', '第二张卡。', ''],
  )

  it('识别插件格式', () => {
    expect(isPluginCanvasSource(PLUGIN)).toBe(true)
    expect(isPluginCanvasSource(src([LAYOUT_1COL], ['<!-- a 1 -->', '', '正文。']))).toBe(false)
    expect(isPluginCanvasSource('# 素文件\n')).toBe(false)
  })

  // ⚠️codex 2026-08-17 P2:判定原来用 `/m` 正则扫**整份原文**,正文里一行顶格的
  // `canvas: '{...}'`(写文档、贴示例、围栏代码块里都会出现)会被当成插件画布 ——
  // 第一次编辑时 router 就把普通正文当几何迁移掉 = 毁档。判定与迁移必须只看 frontmatter。
  it('⚠️正文里的 `canvas:` 行不算画布(正则不许越过 --- 栅栏)', () => {
    const bodyOnly = src([LAYOUT_1COL], [
      '<!-- a 1 -->', '', '插件画布的格式是这样的:', '',
      `canvas: '{"v":1,"mode":"canvas","n":{"2":{"x":10,"y":20}}}'`, '',
    ])
    expect(isPluginCanvasSource(bodyOnly)).toBe(false)
    expect(migratePluginCanvas('板.canvas.md', bodyOnly, NOW).ok).toBe(false)
  })

  it('围栏代码块里的 `canvas:` 同样不算', () => {
    const fenced = src([LAYOUT_1COL], ['<!-- a 1 -->', '', '```yaml', `canvas: '{"v":1}'`, '```', ''])
    expect(isPluginCanvasSource(fenced)).toBe(false)
  })

  it('有坐标的块成卡(锚与 x/y/w 原样),没坐标的块留主卡', () => {
    const r = migratePluginCanvas('板.canvas.md', PLUGIN, NOW)
    if (!r.ok) throw new Error(r.reason)
    const canvas = JSON.parse(/^amadeus_canvas:\s*(.*)$/m.exec(r.src)![1])
    expect(canvas.cards).toEqual([{ ref: '2', x: 900, y: 40, w: 480 }, { ref: '3', x: -4, y: 198, w: 400 }])
    expect(canvas.mode).toBe('canvas')
    // 卡片区恒在文末且顺序 = cards 序(否则读侧折叠会整体拒折)。
    expect(r.src.indexOf('主卡这段没坐标')).toBeLessThan(r.src.indexOf('<!-- a 2 -->'))
    expect(r.src.indexOf('<!-- a 2 -->')).toBeLessThan(r.src.indexOf('<!-- a 3 -->'))
    // 主卡块的锚被剥掉(它不是结构锚),卡片块的锚必须留着。
    expect(r.src).not.toContain('<!-- a 1 -->')
    expect(r.src).toContain('第一张卡。')
    expect(r.src).toContain('第二张卡。')
  })

  it('连线与形状转成 elements 带走(Phase 1 不渲染但一个都不许丢)', () => {
    const r = migratePluginCanvas('板.canvas.md', PLUGIN, NOW)
    if (!r.ok) throw new Error(r.reason)
    const canvas = JSON.parse(/^amadeus_canvas:\s*(.*)$/m.exec(r.src)![1])
    expect(canvas.elements).toEqual([
      { id: 's1', type: 'shape', shape: 'rect', x: 60, y: 300, w: 220, h: 110 },
      { id: 'e1', type: 'connector', from: { ref: '2' }, to: { ref: '3' }, label: '因为' },
      // 端点落在形状上用 {id},落在块上用 {ref} —— 混淆会让 Phase 2 的连线找错吸附目标。
      { id: 'e2', type: 'connector', from: { ref: '3' }, to: { id: 's1' } },
    ])
  })

  it('迁移产物是 v4-structured,且插件那份 canvas 键已被拿掉(不留第二个真源)', () => {
    const r = migratePluginCanvas('板.canvas.md', PLUGIN, NOW)
    if (!r.ok) throw new Error(r.reason)
    expect(classifyPageSource(r.src)).toBe('v4-structured')
    expect(/^canvas:/m.test(r.src)).toBe(false)
    expect(r.src).toContain('icon: 🏦') // 其余 fm 键原样保留
  })

  it('画布键里没有任何坐标/元素 → 就是一篇普通 v4 笔记,不发 canvas 键(懒物化口径)', () => {
    const r = migratePluginCanvas('板.canvas.md', src([LAYOUT_1COL, `canvas: '{"v":1,"mode":"doc"}'`], ['<!-- a 1 -->', '', '正文。']), NOW)
    if (!r.ok) throw new Error(r.reason)
    expect(/^amadeus_canvas:/m.test(r.src)).toBe(false)
    expect(r.src).toContain('正文。')
  })

  it('失效闭合:读不懂的 canvas 值 / 有多列行 → 拒绝迁移,文件原样留 v3', () => {
    expect(migratePluginCanvas('板.canvas.md', src([LAYOUT_1COL, "canvas: '{坏掉的'"], ['<!-- a 1 -->', '', '正文。']), NOW).ok).toBe(false)
    const twoCol = 'amadeus_layout: {"type":"stack","children":[{"type":"row","id":"r1","columns":[{"id":"c1","width":1,"children":[{"ref":"1"}]},{"id":"c2","width":1,"children":[{"ref":"2"}]}]}]}'
    const r = migratePluginCanvas('板.canvas.md', src([twoCol, `canvas: '{"v":1,"n":{"2":{"x":1,"y":2}}}'`], ['<!-- a 1 -->', '', '左', '', '<!-- a 2 -->', '', '右']), NOW)
    expect(r.ok).toBe(false)
  })
})
