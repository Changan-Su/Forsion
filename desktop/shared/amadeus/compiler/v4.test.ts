// v4 格式契约(2026-08-13 spec):识别按 fm 键三分支、素文件与外来 md 同构、
// compile∘parse 不动点、v3→v4 升级规则(平凡布局全剥/分栏保锚/结构文件拒绝)。
import { describe, expect, it } from 'vitest'
import {
  PAGE_SCHEMA_V4,
  classifyPageSource,
  compileV4,
  parseV4Layout,
  parseV4Source,
  structureKeysFor,
  upgradeV3Source,
} from './v4'

const NOW = '2026-08-13T00:00:00.000Z'

function v3Source(fmLines: string[], body: string[]): string {
  return ['---', 'amadeus_page: pg_test01', 'amadeus_schema: amadeus.page/3', ...fmLines, '---', '', ...body, ''].join('\n')
}

describe('classifyPageSource:按 frontmatter 键判,绝不按标记判(spec §3.1)', () => {
  it('plain markdown → v4-plain', () => {
    expect(classifyPageSource('# 标题\n\n正文。\n')).toBe('v4-plain')
  })

  it('an innocent comment that happens to match the marker syntax stays v4-plain', () => {
    // 按标记判的误判类:外来 md 的 `<!-- a note -->` 会被送进 parseV3 补号并落盘改写。
    expect(classifyPageSource('<!-- a note -->\n\n正文。\n')).toBe('v4-plain')
  })

  it('any amadeus_* PREFIXED key → v3 (amadeus_layout alone / garbage schema / unknown key included)', () => {
    expect(classifyPageSource(v3Source([], ['<!-- a 1 -->', '', '正文']))).toBe('v3')
    expect(classifyPageSource('---\namadeus_layout: {"type":"stack","children":[]}\n---\n正文\n')).toBe('v3')
    expect(classifyPageSource('---\namadeus_schema: garbage\n---\n正文\n')).toBe('v3')
    // 前缀整体保留:未知 amadeus_* 键宁可保守当 v3,也不能误判成素文件(Codex #5)。
    expect(classifyPageSource('---\namadeus_custom: x\n---\n正文\n')).toBe('v3')
  })

  it('schema major 4 → v4-structured (quoted YAML tolerated); major 5 → future', () => {
    expect(classifyPageSource('---\namadeus_schema: amadeus.page/4\n---\n正文\n')).toBe('v4-structured')
    expect(classifyPageSource('---\namadeus_schema: "amadeus.page/4"\n---\n正文\n')).toBe('v4-structured')
    expect(classifyPageSource('---\namadeus_schema: amadeus.page/5\n---\n正文\n')).toBe('future')
  })
})

describe('parseV4Source / compileV4', () => {
  it('a well-formed plain file round-trips byte-identically', () => {
    const raw = '# 标题\n\n第一段。\n\n<!-- a hook -->\n\n被锚的段。\n'
    const page = parseV4Source(raw)
    expect(page.kind).toBe('plain')
    expect(page.layout).toBeNull()
    expect(page.anchors).toEqual(['hook']) // 惰性锚:照常枚举,不切分文档
    expect(compileV4(page)).toBe(raw)
  })

  it('compile∘parse is a fixed point for structured pages', () => {
    const layout = { v: 4 as const, rows: [{ columns: [{ refs: ['a1'], width: 0.5 }, { refs: ['a2'], width: 0.5 }] }] }
    const src = compileV4({
      fmExtra: 'tags:\n  - alpha',
      layout,
      canvas: null,
      body: '<!-- a a1 -->\n\n左栏。\n\n<!-- a a2 -->\n\n右栏。\n',
    })
    const once = parseV4Source(src)
    expect(once.kind).toBe('structured')
    expect(once.layout).toEqual(layout)
    expect(once.anchors).toEqual(['a1', 'a2'])
    expect(once.fmExtra).toBe('tags:\n  - alpha')
    expect(compileV4(once)).toBe(src) // 不动点
  })

  it('plain files carry frontmatter ONLY when there is foreign fm', () => {
    const withFm = compileV4({ fmExtra: 'status: draft', layout: null, canvas: null, body: '正文。\n' })
    expect(withFm).toBe('---\nstatus: draft\n---\n\n正文。\n')
    expect(parseV4Source(withFm).fmExtra).toBe('status: draft')
    expect(compileV4({ fmExtra: '', layout: null, canvas: null, body: '正文。\n' })).toBe('正文。\n')
  })

  it('sanitizes reserved keys and bare --- lines out of fmExtra (same chokepoint rule as v3)', () => {
    const src = compileV4({
      fmExtra: ['amadeus_page: hijacked', 'status: draft', '---', 'evil: body'].join('\n'),
      layout: null,
      canvas: null,
      body: '正文。\n',
    })
    expect(src).toContain('status: draft')
    expect(src).toContain('evil: body')
    expect(src).not.toContain('amadeus_page')
    expect(classifyPageSource(src)).toBe('v4-plain') // 夹带的保留键没能把文件劫持成 v3
  })

  it('refuses to parse a v3/future source (caller must classify first)', () => {
    expect(() => parseV4Source(v3Source([], ['正文']))).toThrow(/v3/)
    expect(() => parseV4Source('---\namadeus_schema: amadeus.page/5\n---\n正文\n')).toThrow(/future/)
  })

  it('parseV4Layout rejects invalid shapes instead of guessing', () => {
    expect(parseV4Layout(undefined)).toBeNull()
    expect(parseV4Layout('not json')).toBeNull()
    expect(parseV4Layout('{"type":"stack","children":[]}')).toBeNull() // v3 形状不冒充 v4
    expect(parseV4Layout('{"v":4,"rows":[]}')).toEqual({ v: 4, rows: [] })
  })

  it('normalizes CRLF edges and whitespace-only bodies deterministically (Codex #7)', () => {
    const crlf = '---\r\nstatus: draft\r\n---\r\n\r\n正文。\n'
    const once = compileV4(parseV4Source(crlf))
    expect(once).toBe('---\nstatus: draft\n---\n\n正文。\n') // 头部 CRLF 残留不产生空行,fm 重建为 LF
    expect(compileV4(parseV4Source(once))).toBe(once) // 不动点
    expect(parseV4Source('\n').body).toBe('') // 纯空白文件规整为空,不主张字节级往返
    expect(compileV4({ fmExtra: '', layout: null, canvas: null, body: '\n\n' })).toBe('')
  })
})

describe('structureKeysFor:canvas ⇒ schema 不变式(方案 §6.0-1,单一判据)', () => {
  const LAYOUT = '{"v":4,"rows":[]}'
  const CANVAS = '{"v":1,"mode":"canvas","cards":[]}'
  it('两者皆无 → 一行不发(素文件)', () => {
    expect(structureKeysFor(null, null)).toEqual([])
  })
  it('画布单独在场也必须发 schema —— 只发 canvas = 文件判成 v3 = 毁档', () => {
    expect(structureKeysFor(null, CANVAS)).toEqual([`amadeus_schema: ${PAGE_SCHEMA_V4}`, `amadeus_canvas: ${CANVAS}`])
    expect(classifyPageSource(`---\n${structureKeysFor(null, CANVAS).join('\n')}\n---\n\n正文\n`)).toBe('v4-structured')
    // 反证:漏了 schema 的半吊子写者产出什么(这条掉进 v3 管线就会被补号改写)
    expect(classifyPageSource(`---\namadeus_canvas: ${CANVAS}\n---\n\n正文\n`)).toBe('v3')
  })
  it('分栏与画布并存 → schema/layout/canvas 三行,顺序固定', () => {
    expect(structureKeysFor(LAYOUT, CANVAS)).toEqual([
      `amadeus_schema: ${PAGE_SCHEMA_V4}`,
      `amadeus_layout: ${LAYOUT}`,
      `amadeus_canvas: ${CANVAS}`,
    ])
  })
  it('compileV4 携带画布往返不动点(fmExtra 与画布行互不干扰)', () => {
    const src = compileV4({ fmExtra: 'icon: "📘"', layout: null, canvas: CANVAS, body: '# Hi\n\n正文。\n' })
    const page = parseV4Source(src)
    expect(page.kind).toBe('structured')
    expect(page.layout).toBeNull()
    expect(page.canvas).toBe(CANVAS)
    expect(page.fmExtra).toBe('icon: "📘"')
    expect(compileV4(page)).toBe(src)
  })
  it('未知 amadeus_* 键:v4-structured 来源保留(不透明元数据),升级/素文件路径剥除', () => {
    const src = `---\namadeus_schema: ${PAGE_SCHEMA_V4}\namadeus_canvas: ${CANVAS}\namadeus_future: opaque\nicon: "📘"\n---\n\n正文。\n`
    const page = parseV4Source(src)
    expect(page.kind).toBe('structured')
    expect(page.fmExtra).toContain('amadeus_future: opaque')
    expect(compileV4(page)).toContain('amadeus_future: opaque') // 新端写的扩展不许被老端一次保存吞掉
    // kind 缺省 = 保守侧(剥):升级路径拿 v3 遗留垃圾键去发 v4 会二次误判成 v3
    expect(compileV4({ fmExtra: 'amadeus_next_id: 9\namadeus_junk: x', layout: null, canvas: null, body: '正文。\n' }))
      .toBe('正文。\n')
  })
  it('画布键空值 = 键在场但值坏了:逐字保留,不许连 schema 一起剥', () => {
    const src = `---\namadeus_schema: ${PAGE_SCHEMA_V4}\namadeus_canvas:\n---\n\n正文。\n`
    const page = parseV4Source(src)
    expect(page.canvas).toBe('')
    expect(classifyPageSource(compileV4(page))).toBe('v4-structured')
    expect(compileV4(page)).toContain('amadeus_canvas:')
  })
  it('画布是保留键:夹带在 fmExtra 里不能劫持结构区', () => {
    const src = compileV4({ fmExtra: `amadeus_canvas: ${CANVAS}`, layout: null, canvas: null, body: '正文。\n' })
    expect(src).toBe('正文。\n') // 前缀键整体被 sanitize 剥掉,素文件恒素
  })
})

describe('upgradeV3Source(spec §5.1)', () => {
  it('trivial layout → plain markdown: markers, layout, next_id and page id all dropped', () => {
    const raw = v3Source(['amadeus_next_id: 9'], [
      '<!-- a 1 -->', '', '第一段。', '',
      '<!-- a 2 -->', '', // 空块:自然流中直接消失
      '<!-- a 3 -->', '', '第二块首段。', '', '第二块次段(块内空行保留)。',
    ])
    const res = upgradeV3Source('note.md', raw, NOW)
    if (!res.ok) throw new Error(res.reason)
    expect(res.src).toBe('第一段。\n\n第二块首段。\n\n第二块次段(块内空行保留)。\n')
    expect(classifyPageSource(res.src)).toBe('v4-plain')
  })

  it('keeps foreign frontmatter (Obsidian properties) while dropping every amadeus_* key', () => {
    const raw = v3Source(['tags:', '  - alpha', 'status: draft'], ['<!-- a 1 -->', '', '正文。'])
    const res = upgradeV3Source('note.md', raw, NOW)
    if (!res.ok) throw new Error(res.reason)
    expect(res.src).toBe('---\ntags:\n  - alpha\nstatus: draft\n---\n\n正文。\n')
  })

  it('strips UNKNOWN amadeus_* keys on upgrade — the prefix is reserved wholesale (Codex #5)', () => {
    const raw = v3Source(['amadeus_custom: x', 'status: draft'], ['<!-- a 1 -->', '', '正文。'])
    const res = upgradeV3Source('note.md', raw, NOW)
    if (!res.ok) throw new Error(res.reason)
    expect(res.src).not.toContain('amadeus_custom')
    expect(res.src).toContain('status: draft')
  })

  it('column rows keep their anchors + a v4 layout; single-column rows flow naturally', () => {
    const layout = {
      type: 'stack',
      children: [
        { type: 'row', id: 'row_a', columns: [
          { id: 'col_a', width: 0.5, children: [{ ref: '1' }] },
          { id: 'col_b', width: 0.5, children: [{ ref: '2' }] },
        ] },
        { type: 'row', id: 'row_b', columns: [{ id: 'col_c', width: 1, children: [{ ref: '3' }] }] },
      ],
    }
    const raw = v3Source([`amadeus_layout: ${JSON.stringify(layout)}`], [
      '<!-- a 1 -->', '', '左栏。', '',
      '<!-- a 2 -->', '', '右栏。', '',
      '<!-- a 3 -->', '', '整宽段落。',
    ])
    const res = upgradeV3Source('note.md', raw, NOW)
    if (!res.ok) throw new Error(res.reason)
    const page = parseV4Source(res.src)
    expect(page.kind).toBe('structured')
    // 分栏行带 tail 界标锚封底(Codex 终审 P1:锚辖域到下一锚/EOF,没有 tail 的话
    // 行后自然流会被末列吞进来)。tail 从 t1 起与既有块 id 避撞。
    expect(page.layout).toEqual({ v: 4, rows: [{ columns: [{ refs: ['1'], width: 0.5 }, { refs: ['2'], width: 0.5 }], tail: 't1' }] })
    expect(page.anchors).toEqual(['1', '2', 't1']) // 分栏行保锚(id 原样,历史引用不断)+ tail;整宽块剥标记
    expect(res.src).toContain('整宽段落。')
    expect(res.src).toContain('<!-- a t1 -->')
    expect(res.src.indexOf('<!-- a t1 -->')).toBeLessThan(res.src.indexOf('整宽段落。')) // tail 立在行后内容之前
    expect(res.src).not.toContain('<!-- a 3 -->')
    expect(res.src).not.toContain('amadeus_page')
  })

  it('preserves alphabetic ids verbatim through the upgrade (no renumber on the way)', () => {
    const raw = v3Source([], ['<!-- a ai-root -->', '', '根节点。'])
    const res = upgradeV3Source('note.md', raw, NOW)
    if (!res.ok) throw new Error(res.reason)
    expect(res.src).toBe('根节点。\n') // 平凡布局:锚也剥(素文件),内容未被重编号搅动
  })

  it('refuses plugin-structured files and frontmatter id-trees', () => {
    const v3 = v3Source([], ['<!-- a 1 -->', '', '正文。'])
    expect(upgradeV3Source('图.mindmap.md', v3, NOW)).toEqual({ ok: false, reason: 'plugin-structured-file' })
    expect(upgradeV3Source('画.excalidraw.md', v3, NOW)).toEqual({ ok: false, reason: 'plugin-structured-file' })
    // ⚠️ 画布 2026-08-16 转原生后 `.canvas.md` **不再是一等文件类型**:它就是个普通笔记,照常升 v4
    // (画布成了任意 v4 笔记的一种模式,几何存 amadeus_canvas)。这条断言是路由翻转的门 —— 改红了
    // 说明有人把 canvas 加回了 PLUGIN_FILETYPE,那等于把画布退回 v3 块世界(用户为此打回过两轮)。
    expect(upgradeV3Source('板.canvas.md', v3, NOW).ok).toBe(true)
    const withMindmap = v3Source(["mindmap: '{\"1\":{\"p\":null,\"o\":0}}'"], ['<!-- a 1 -->', '', '正文。'])
    expect(upgradeV3Source('note.md', withMindmap, NOW)).toEqual({ ok: false, reason: 'plugin-structured-frontmatter' })
    const withDash = v3Source(["dashboard: '{\"1\":[0,0,2,2]}'"], ['<!-- a 1 -->', '', '正文。'])
    expect(upgradeV3Source('note.md', withDash, NOW)).toEqual({ ok: false, reason: 'plugin-structured-frontmatter' })
    // **已退役的**画布插件那套裸 `canvas:` 键仍要拒:存量文件的坐标按块 id 引用,升级剥标记会
    // 让它们整片孤儿。原生画布用的是 amadeus_canvas(带前缀,不匹配这条规则),不受影响。
    const withCanvas = v3Source(["canvas: '{\"v\":1,\"n\":{\"1\":{\"x\":0,\"y\":0}}}'"], ['<!-- a 1 -->', '', '正文。'])
    expect(upgradeV3Source('note.md', withCanvas, NOW)).toEqual({ ok: false, reason: 'plugin-structured-frontmatter' })
    // 引号键是合法 YAML,拒绝规则不能被引号绕过(Codex #3)。
    const quotedMindmap = v3Source(['"mindmap": \'{"1":{"p":null,"o":0}}\''], ['<!-- a 1 -->', '', '正文。'])
    expect(upgradeV3Source('note.md', quotedMindmap, NOW)).toEqual({ ok: false, reason: 'plugin-structured-frontmatter' })
    expect(upgradeV3Source('note.md', '纯正文。\n', NOW)).toEqual({ ok: false, reason: 'not-v3' })
    expect(upgradeV3Source('note.md', '---\namadeus_schema: amadeus.page/5\n---\n正文\n', NOW)).toEqual({ ok: false, reason: 'not-v3' })
  })
})
