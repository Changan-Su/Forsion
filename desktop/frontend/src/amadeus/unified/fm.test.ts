/** P0 契约(2026-08-13):UnifiedPage 绝不把 frontmatter 喂进编辑器,也绝不在保存时丢它。 */
import { describe, it, expect } from 'vitest'
import { splitFm, composeFm, patchFm, setForeignFm, foreignFmObject, foreignFmText, setAmadeusStructure, layoutLineOf, canvasLineOf, fixStructKeys } from './fm'
import { classifyPageSource } from '@amadeus-shared/compiler/v4'
import { parseFrontmatter } from '@amadeus-shared/compiler/split'
import { parse as parseYaml } from 'yaml'

const FM = '---\nicon: "📘"\ncover: assets/x.png\ntags:\n  - a\n---\n'
const BODY = '# Hi\n\n正文段落。\n'

describe('splitFm / composeFm', () => {
  it('拆分往返字节恒等(有 fm)', () => {
    const raw = FM + BODY
    const { fmText, body } = splitFm(raw)
    expect(fmText).toBe(FM)
    expect(body).toBe(BODY)
    expect(composeFm(fmText, body)).toBe(raw)
  })
  it('无 fm:fmText 为空,正文原样', () => {
    const { fmText, body } = splitFm(BODY)
    expect(fmText).toBe('')
    expect(body).toBe(BODY)
  })
  it('正文里的 --- 分隔线不会被误当 fm', () => {
    const raw = '# t\n\n---\n\nafter\n'
    expect(splitFm(raw).fmText).toBe('')
  })
  it('v4-structured:amadeus_* 行留在 fmText,不进正文', () => {
    const raw = '---\namadeus_schema: amadeus.page/4\namadeus_layout: {"v":4,"rows":[]}\nicon: "🧭"\n---\nbody\n'
    const { fmText, body } = splitFm(raw)
    expect(body).toBe('body\n')
    expect(fmText).toContain('amadeus_layout')
  })
  it('空 frontmatter(---\\n---\\n)是合法块,不喂进正文(Codex P0)', () => {
    const raw = '---\n---\n正文\n'
    const { fmText, body } = splitFm(raw)
    expect(fmText).toBe('---\n---\n')
    expect(body).toBe('正文\n')
    expect(composeFm(fmText, body)).toBe(raw)
  })
  it('收尾栅栏必须独占一行:`---broken` 不是栅栏(Codex P1)', () => {
    const raw = '---\ntitle: x\n---broken\ncontent\n'
    expect(splitFm(raw).fmText).toBe('') // 未闭合 = 无 frontmatter,与 remark 口径一致
  })
  it('收尾栅栏在 EOF(无尾换行)也认', () => {
    const raw = '---\nicon: "📘"\n---'
    const { fmText, body } = splitFm(raw)
    expect(fmText).toBe(raw)
    expect(body).toBe('')
  })
})

describe('patchFm(chrome 写入)', () => {
  it('无 fm 的素文件 + icon → 生出 fm 块', () => {
    const next = patchFm('', { icon: '📘' })
    expect(next).toMatch(/^---\n/)
    expect(foreignFmObject(next).icon).toBe('📘')
  })
  it('删最后一个键 → fm 块整个消失', () => {
    const one = patchFm('', { icon: '📘' })
    expect(patchFm(one, { icon: undefined })).toBe('')
  })
  it('amadeus_* 保留行原样保留', () => {
    const fm = '---\namadeus_schema: amadeus.page/4\nicon: "🧭"\n---\n'
    const next = patchFm(fm, { cover: 'x.png' })
    expect(next).toContain('amadeus_schema: amadeus.page/4')
    expect(foreignFmObject(next).cover).toBe('x.png')
  })
  it('patch 键不能劫持保留键', () => {
    const next = patchFm('', { amadeus_layout: 'evil' })
    expect(next).toBe('')
  })
  it('外来 YAML 解析不了 → 拒改返回原文,绝不清空(Codex P0)', () => {
    const broken = '---\ntitle: "未闭合\nrank: [1, 2\n---\n'
    expect(patchFm(broken, { icon: '📘' })).toBe(broken)
  })
  it('空 frontmatter 块上 patch 正常生效', () => {
    const next = patchFm('---\n---\n', { icon: '📘' })
    expect(foreignFmObject(next).icon).toBe('📘')
  })
})

describe('setForeignFm(属性面板整区替换)', () => {
  it('保留 amadeus_* 行,替换外来区', () => {
    const fm = '---\namadeus_schema: amadeus.page/4\nold: 1\n---\n'
    const next = setForeignFm(fm, 'title: hello\nrank: 2')
    expect(next).toContain('amadeus_schema')
    expect(next).not.toContain('old: 1')
    expect(foreignFmObject(next)).toMatchObject({ title: 'hello', rank: 2 })
  })
  it('清空外来区且无保留行 → ""', () => {
    expect(setForeignFm(FM, '')).toBe('')
  })
})

describe('setAmadeusStructure / layoutLineOf(分栏结构键,行级 splice 绝不过 YAML)', () => {
  const LAYOUT = '{"v":4,"rows":[{"columns":[{"refs":["a1"],"width":0.5},{"refs":["a2"],"width":0.5}],"tail":"t1"}]}'
  it('无 fm + layout → 生出 schema+layout 两行', () => {
    const next = setAmadeusStructure('', LAYOUT, null)
    expect(next).toBe(`---\namadeus_schema: amadeus.page/4\namadeus_layout: ${LAYOUT}\n---\n`)
    expect(layoutLineOf(next)).toBe(LAYOUT)
  })
  it('已有外来键:结构行置顶,外来行逐字原样', () => {
    const next = setAmadeusStructure('---\nicon: "📘"\n# note\n---\n', LAYOUT, null)
    expect(next).toContain('amadeus_schema: amadeus.page/4')
    expect(next.indexOf('amadeus_layout')).toBeLessThan(next.indexOf('icon'))
    expect(next).toContain('icon: "📘"')
    expect(next).toContain('# note')
  })
  it('null → 剥除结构行(其余原样);剥空整块消失', () => {
    const withStruct = setAmadeusStructure('---\nicon: "📘"\n---\n', LAYOUT, null)
    expect(setAmadeusStructure(withStruct, null, null)).toBe('---\nicon: "📘"\n---\n')
    expect(setAmadeusStructure(setAmadeusStructure('', LAYOUT, null), null, null)).toBe('')
  })
  it('引号键/重复行一并替换干净', () => {
    const messy = '---\n"amadeus_layout": {"v":4,"rows":[]}\namadeus_layout: old\namadeus_schema: x\n---\n'
    const next = setAmadeusStructure(messy, LAYOUT, null)
    expect(next.match(/amadeus_layout/g)?.length).toBe(1)
    expect(next).toContain(`amadeus_layout: ${LAYOUT}`)
  })
  it('layoutLineOf:无 layout 行 → null', () => {
    expect(layoutLineOf('---\nicon: x\n---\n')).toBe(null)
    expect(layoutLineOf('')).toBe(null)
  })
})

/** 发布阻断契约(方案 §6.0-2,2026-08-15):画布几何住在 fm 的 `amadeus_canvas` 单行 JSON 里,
 *  而 `amadeus_schema` 缺席会让 classifyPageSource 把文件判成 v3 → 拽进 v3 管线补号改写 = 毁档。
 *  所以「canvas 在场 ⇒ schema 在场」必须在**每个**结构区写点成立,这里钉的就是桌面端那个真身写点。 */
describe('canvas ⇒ schema 不变式(发布阻断,画布文件绝不许掉回 v3)', () => {
  const LAYOUT = '{"v":4,"rows":[{"columns":[{"refs":["a1"],"width":0.5},{"refs":["a2"],"width":0.5}],"tail":"t1"}]}'
  const CANVAS = '{"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":800},"cards":[{"ref":"c1","x":900,"y":40,"w":480}]}'
  const bodyOf = (fm: string): string => composeFm(fm, '# Hi\n\n正文。\n')

  it('解散最后一个分栏行:schema 与 canvas 行都留下,文件仍判 v4-structured', () => {
    const withBoth = setAmadeusStructure('---\nicon: "📘"\n---\n', LAYOUT, CANVAS)
    expect(classifyPageSource(bodyOf(withBoth))).toBe('v4-structured')
    const dissolved = setAmadeusStructure(withBoth, null, canvasLineOf(withBoth))
    expect(layoutLineOf(dissolved)).toBe(null)
    expect(canvasLineOf(dissolved)).toBe(CANVAS) // 字节稳定
    expect(dissolved).toContain('amadeus_schema: amadeus.page/4')
    expect(classifyPageSource(bodyOf(dissolved))).toBe('v4-structured') // ← 掉成 'v3' 就是毁档
    expect(dissolved).toContain('icon: "📘"')
  })

  it('文档模式反复保存:canvas 行逐字不变(第二次起是不动点)', () => {
    let fm = setAmadeusStructure('---\nstatus: draft\n---\n', null, CANVAS)
    const first = fm
    for (let i = 0; i < 5; i++) fm = setAmadeusStructure(fm, null, canvasLineOf(fm)) // 每次防抖保存派生一遍
    expect(fm).toBe(first)
    expect(canvasLineOf(fm)).toBe(CANVAS)
    expect(classifyPageSource(bodyOf(fm))).toBe('v4-structured')
  })

  it('画布解散(canvas=null)且无分栏 → 结构键全剥,回落素文件', () => {
    const withCanvas = setAmadeusStructure('', null, CANVAS)
    expect(setAmadeusStructure(withCanvas, null, null)).toBe('')
    expect(classifyPageSource('# Hi\n')).toBe('v4-plain')
  })

  it('重复结构键取最后一条(与 parseSimpleYaml 同口径:后者胜)', () => {
    const dup = `---\namadeus_schema: amadeus.page/4\namadeus_canvas: {"v":1,"cards":[]}\namadeus_canvas: ${CANVAS}\n---\n`
    // 取第一条 = 读到的是后一份、写回的是前一份,一次保存就把有效几何换成旧值。
    expect(canvasLineOf(dup)).toBe(CANVAS)
    expect(canvasLineOf(setAmadeusStructure(dup, null, canvasLineOf(dup)))).toBe(CANVAS)
  })

  it('fixStructKeys:手删 schema(源码模式)→ 补回;没有结构键则一字不动', () => {
    const broken = `---\nicon: "📘"\namadeus_canvas: ${CANVAS}\n---\n`
    expect(classifyPageSource(bodyOf(broken))).toBe('v3') // ← 不修就是这个下场(进 v3 管线=毁档)
    const fixed = fixStructKeys(broken)
    expect(classifyPageSource(bodyOf(fixed))).toBe('v4-structured')
    expect(canvasLineOf(fixed)).toBe(CANVAS)
    // 只补不拆:两者都没有时原样返回(含「只剩一个孤零零 schema 行」的合法空态)
    const plain = '---\nicon: "📘"\n---\n'
    expect(fixStructKeys(plain)).toBe(plain)
    const lonely = '---\namadeus_schema: amadeus.page/4\nicon: "📘"\n---\n'
    expect(fixStructKeys(lonely)).toBe(lonely)
    // 已有 schema 的正常文件不被重排
    const ok = setAmadeusStructure('', LAYOUT, CANVAS)
    expect(fixStructKeys(ok)).toBe(ok)
  })

  it('canvas 是保留键:不落进属性面板的外来区(否则用户能编/YAML 往返会重排单行 JSON)', () => {
    const fm = setAmadeusStructure('---\nicon: "📘"\n---\n', null, CANVAS)
    expect(foreignFmText(fm)).toBe('icon: "📘"')
    expect(foreignFmObject(fm).amadeus_canvas).toBeUndefined()
  })
})

describe('foreignFmText', () => {
  it('外来键 YAML 原文逐字(注释/顺序保留)', () => {
    const fm = '---\n# note\nicon: "📘"\n---\n'
    expect(foreignFmText(fm)).toBe('# note\nicon: "📘"')
  })
})

/** D-01(2026-09-27 评审 P0):旧版记事本等工具写出的文件头 BOM。remark 解析前先剥 BOM(parseFrontmatter
 *  照认 fm),正则口径却不认 → fm 整块喂进编辑器,第一次保存写成 `***` + setext 标题,tags/aliases 全废。
 *  契约:BOM 恒归 fm 侧、逐字往返;所有行级改写摘 BOM 再放回字节 0。 */
describe('文件头 BOM(D-01)', () => {
  const B = '\uFEFF'
  const LAYOUT = '{"v":4,"rows":[{"columns":[{"refs":["a1"],"width":0.5},{"refs":["a2"],"width":0.5}],"tail":"t1"}]}'
  const CANVAS = '{"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":800},"cards":[{"ref":"c1","x":900,"y":40,"w":480}]}'

  it('BOM + fm:BOM 并进 fmText,正文干净,拼回逐字', () => {
    const raw = `${B}---\ntags: [a]\naliases: [x]\n---\n正文\n`
    const { fmText, body } = splitFm(raw)
    expect(fmText).toBe(`${B}---\ntags: [a]\naliases: [x]\n---\n`)
    expect(body).toBe('正文\n')
    expect(composeFm(fmText, body)).toBe(raw)
    expect(foreignFmObject(fmText)).toEqual({ tags: ['a'], aliases: ['x'] })
  })

  it('BOM + CRLF fm 同样认,拼回逐字', () => {
    const raw = `${B}---\r\ntags: [a]\r\naliases: [x]\r\n---\r\n正文\r\n`
    const { fmText, body } = splitFm(raw)
    expect(fmText.startsWith(`${B}---`)).toBe(true)
    expect(body).toBe('正文\r\n')
    expect(composeFm(fmText, body)).toBe(raw)
  })

  it('BOM 无 fm:BOM 独苗当 fmText(编辑器吃不下它),拼回逐字', () => {
    const raw = `${B}# T\n\n正文\n`
    const { fmText, body } = splitFm(raw)
    expect(fmText).toBe(B)
    expect(body).toBe('# T\n\n正文\n')
    expect(composeFm(fmText, body)).toBe(raw)
    expect(foreignFmObject(fmText)).toEqual({})
    expect(foreignFmText(fmText)).toBe('')
  })

  it('两套判据一致:splitFm 认到 fm ⟺ remark(parseFrontmatter)认到 fm', () => {
    for (const raw of [
      `${B}---\ntags: [a]\n---\nx\n`, `${B}---\r\ntags: [a]\r\n---\r\nx\r\n`, `${B}---\n---\nx\n`,
      `${B}# T\n`, '---\ntags: [a]\n---\nx\n', '# T\n',
    ]) {
      const sawFm = splitFm(raw).fmText.includes('---')
      expect([raw, sawFm]).toEqual([raw, Object.keys(parseFrontmatter(raw)).length > 0 || /^\uFEFF?---\r?\n---/.test(raw)])
    }
  })

  it('首击派生(null,null)不动 BOM fm —— 修前这里返回 "",第一击删光整块 fm', () => {
    const fm = `${B}---\ntags: [a]\naliases: [x]\n---\n`
    expect(setAmadeusStructure(fm, null, null)).toBe(fm)
    expect(setAmadeusStructure(B, null, null)).toBe(B)
  })

  it('setAmadeusStructure:BOM 留在字节 0,外来行逐字,结构键读得回', () => {
    const next = setAmadeusStructure(`${B}---\nicon: "📘"\n---\n`, LAYOUT, CANVAS)
    expect(next.startsWith(`${B}---\namadeus_schema: amadeus.page/4\n`)).toBe(true)
    expect(next).toContain('icon: "📘"')
    expect(layoutLineOf(next)).toBe(LAYOUT)
    expect(canvasLineOf(next)).toBe(CANVAS)
    expect(classifyPageSource(composeFm(next, 'x\n'))).toBe('v4-structured')
    // 剥空:整块消失但 BOM 仍在字节 0
    expect(setAmadeusStructure(setAmadeusStructure(B, LAYOUT, null), null, null)).toBe(B)
    // 无块 + BOM 独苗 → 生出块,BOM 在前
    expect(setAmadeusStructure(B, null, CANVAS)).toBe(`${B}---\namadeus_schema: amadeus.page/4\namadeus_canvas: ${CANVAS}\n---\n`)
  })

  it('BOM + CRLF 多键 fm:结构区重写后不混杂 CRLF/LF(D-19 同批),外来键全在', () => {
    const fm = `${B}---\r\ntags: [a]\r\naliases: [x]\r\nstatus: draft\r\n---\r\n`
    const next = setAmadeusStructure(fm, LAYOUT, null)
    expect(next.startsWith(B)).toBe(true)
    expect(next).not.toContain('\r')
    expect(foreignFmObject(next)).toEqual({ tags: ['a'], aliases: ['x'], status: 'draft' })
    expect(layoutLineOf(next)).toBe(LAYOUT)
  })

  it('patchFm(点图标):BOM 在字节 0、只有一个 fm 块、原有键不丢', () => {
    const next = patchFm(`${B}---\ntags: [a]\n---\n`, { icon: '📘' })
    expect(next.startsWith(`${B}---\n`)).toBe(true)
    expect(next.slice(1).match(/^---$/gm)?.length).toBe(2) // 恰好一个 fm 块(修前会在 BOM 前再叠一个)
    expect(foreignFmObject(next)).toMatchObject({ tags: ['a'], icon: '📘' })
    // BOM 独苗上加键 → 生出块;再删掉 → 退回 BOM 独苗
    const one = patchFm(B, { icon: '📘' })
    expect(one.startsWith(`${B}---\n`)).toBe(true)
    expect(foreignFmObject(one).icon).toBe('📘')
    expect(patchFm(one, { icon: undefined })).toBe(B)
  })

  it('setForeignFm(属性面板提交):BOM 留住;清空外来区 → BOM 独苗', () => {
    const fm = `${B}---\namadeus_schema: amadeus.page/4\nold: 1\n---\n`
    const next = setForeignFm(fm, 'title: hello')
    expect(next.startsWith(`${B}---\namadeus_schema: amadeus.page/4\n`)).toBe(true)
    expect(foreignFmObject(next)).toEqual({ title: 'hello' })
    expect(setForeignFm(`${B}---\nold: 1\n---\n`, '')).toBe(B)
  })

  it('BOM fm 上的结构键读取', () => {
    const fm = `${B}---\namadeus_schema: amadeus.page/4\namadeus_canvas: ${CANVAS}\n---\n`
    expect(canvasLineOf(fm)).toBe(CANVAS)
    expect(fixStructKeys(fm)).toBe(fm)
  })
})

/** V-01(2026-09-27 评审 P0):外部 YAML 工具把单行 JSON 的结构键重排成块状多行(项目自己的 yaml 包缺省
 *  配置往返一次就会)。修前 structLineOf 要求值与键同行 → 判成「没有这个键」,绕过 canvas.ts 的
 *  「读不懂就逐字保留」;删键又只摘键行 → 缩进续行成孤儿,整块 fm 解析不了,画布/分栏几何与 tags 全丢。
 *  契约:能读就读(画布/分栏照常显示),读不懂就逐字保留;删键连续行;任何写出的 fm 必须仍是合法 YAML。 */
describe('块状 YAML 结构键(V-01)', () => {
  const FLOW_CANVAS = '{"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":400},"cards":[{"ref":"k1","x":480,"y":0,"w":300}]}'
  const BLOCK = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_canvas:', '  v: 1', '  mode: canvas', '  main:', '    x: 0', '    y: 0', '    w: 400',
    '  cards:', '    - ref: k1', '      x: 480', '      y: 0', '      w: 300',
    'tags:', '  - a', '  - b', '---', '',
  ].join('\n')
  const LAYOUT_BLOCK = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_layout:', '  v: 4', '  rows:', '    - columns:', '        - refs:', '            - a1', '          width: 0.6',
    '        - refs:', '            - a2', '          width: 0.4',
    'tags:', '  - x', '---', '',
  ].join('\n')
  const inner = (fm: string): unknown => parseYaml(/^\uFEFF?---\n([\s\S]*?)---\n$/.exec(fm)![1])

  it('读侧:块状 canvas/layout 折成单行 JSON(画布/分栏照常显示)', () => {
    expect(canvasLineOf(BLOCK)).toBe(FLOW_CANVAS)
    expect(JSON.parse(layoutLineOf(LAYOUT_BLOCK)!)).toEqual({ v: 4, rows: [{ columns: [{ refs: ['a1'], width: 0.6 }, { refs: ['a2'], width: 0.4 }] }] })
  })

  it('值没变 → 整块逐字不动(派生每击都跑,第一击不许把块状改写)', () => {
    expect(setAmadeusStructure(BLOCK, layoutLineOf(BLOCK), canvasLineOf(BLOCK))).toBe(BLOCK)
    expect(setAmadeusStructure(LAYOUT_BLOCK, layoutLineOf(LAYOUT_BLOCK), canvasLineOf(LAYOUT_BLOCK))).toBe(LAYOUT_BLOCK)
    expect(fixStructKeys(BLOCK)).toBe(BLOCK)
  })

  it('值变了 → 该键改写成单行 JSON,续行一个不剩,其余块状键与外来键原样,整块仍是合法 YAML', () => {
    const moved = FLOW_CANVAS.replace('"x":480', '"x":520')
    const next = setAmadeusStructure(BLOCK, null, moved)
    expect(next).toBe(['---', 'amadeus_schema: amadeus.page/4', `amadeus_canvas: ${moved}`, 'tags:', '  - a', '  - b', '---', ''].join('\n'))
    expect(inner(next)).toMatchObject({ amadeus_canvas: JSON.parse(moved), tags: ['a', 'b'] })
    // 分栏块状 + 画布新物化:分栏整块原样,画布单行
    const both = setAmadeusStructure(LAYOUT_BLOCK, layoutLineOf(LAYOUT_BLOCK), FLOW_CANVAS)
    expect(both).toContain(LAYOUT_BLOCK.split('\n').slice(2, 12).join('\n'))
    expect(inner(both)).toMatchObject({ amadeus_layout: JSON.parse(layoutLineOf(LAYOUT_BLOCK)!), amadeus_canvas: JSON.parse(FLOW_CANVAS), tags: ['x'] })
  })

  it('删键(解散)连同续行一起删,不留孤儿', () => {
    expect(setAmadeusStructure(BLOCK, null, null)).toBe('---\ntags:\n  - a\n  - b\n---\n')
    expect(setAmadeusStructure(LAYOUT_BLOCK, null, null)).toBe('---\ntags:\n  - x\n---\n')
  })

  it('读不懂的块状值:非 null(键在场)、JSON 读不出 → 写入侧 fail-closed,整组逐字保留', () => {
    // 块标量里是一段非 JSON 文本(YAML 合法、画布读不懂)
    const scalar = '---\namadeus_schema: amadeus.page/4\namadeus_canvas: >-\n  not json: at all\n  second line\ntags: [a]\n---\n'
    const v = canvasLineOf(scalar)
    expect(v).toBe('not json: at all second line')
    expect(() => JSON.parse(v!)).toThrow()
    expect(setAmadeusStructure(scalar, null, v)).toBe(scalar)
    // 旁边的分栏新物化:画布那组原样,整块仍合法
    const LAYOUT = '{"v":4,"rows":[{"columns":[{"refs":["a1"],"width":0.5},{"refs":["a2"],"width":0.5}],"tail":"t1"}]}'
    const next = setAmadeusStructure(scalar, LAYOUT, v)
    expect(next).toContain('amadeus_canvas: >-\n  not json: at all\n  second line\n')
    expect(inner(next)).toMatchObject({ amadeus_canvas: 'not json: at all second line', tags: ['a'] })
    // YAML 本身就坏(引用了别的条目里的锚):返回整段原文,同样逐字保留
    const alias = '---\namadeus_schema: amadeus.page/4\namadeus_canvas:\n  v: *nope\ntags: [a]\n---\n'
    const raw = canvasLineOf(alias)
    expect(raw).toBe('amadeus_canvas:\n  v: *nope')
    expect(setAmadeusStructure(alias, null, raw)).toBe(alias)
    expect(setAmadeusStructure(alias, LAYOUT, raw)).toContain('amadeus_canvas:\n  v: *nope\n')
  })

  it('重复键仍是后者胜(块状在后)', () => {
    const dup = BLOCK.replace('amadeus_canvas:\n', 'amadeus_canvas: {"v":1,"cards":[]}\namadeus_canvas:\n')
    expect(canvasLineOf(dup)).toBe(FLOW_CANVAS)
    const next = setAmadeusStructure(dup, null, canvasLineOf(dup))
    expect(next.match(/amadeus_canvas/g)).toHaveLength(1)
    expect(canvasLineOf(next)).toBe(FLOW_CANVAS)
  })

  it('属性面板:外来区不带结构键续行(不再掉进「原文」模式),patchFm 不被拒,块状结构键原样', () => {
    expect(foreignFmText(BLOCK)).toBe('tags:\n  - a\n  - b')
    expect(foreignFmObject(BLOCK)).toEqual({ tags: ['a', 'b'] })
    const next = patchFm(BLOCK, { icon: '📘' })
    expect(next).toContain(BLOCK.split('\n').slice(2, 14).join('\n'))
    expect(inner(next)).toMatchObject({ amadeus_canvas: JSON.parse(FLOW_CANVAS), tags: ['a', 'b'], icon: '📘' })
    const committed = setForeignFm(BLOCK, 'tags: [z]')
    expect(inner(committed)).toMatchObject({ amadeus_canvas: JSON.parse(FLOW_CANVAS), tags: ['z'] })
  })

  it('CRLF 源文的单行结构键照样读得到(修前 `(.+)$` 过不了行尾 \\r → 判成「没有」,首击剥掉几何)', () => {
    const crlf = `---\r\namadeus_schema: amadeus.page/4\r\namadeus_canvas: ${FLOW_CANVAS}\r\ntags: [a]\r\n---\r\n`
    expect(canvasLineOf(crlf)).toBe(FLOW_CANVAS)
    const next = setAmadeusStructure(crlf, layoutLineOf(crlf), canvasLineOf(crlf))
    expect(canvasLineOf(next)).toBe(FLOW_CANVAS)
    expect(next).not.toContain('\r')
  })
})

// N-2(2026-09-28):多行 flow 写法的结构键,收尾 `}` / `]` 顶格(yaml 包接受这种写法)。
describe('多行 flow 结构键 + 顶格收尾(N-2)', () => {
  const inner = (fm: string): unknown => parseYaml(fm.replace(/^﻿?---\r?\n/, '').replace(/---\r?\n?$/, ''))
  const pretty = ['amadeus_canvas: {', '  "v": 1, "mode": "canvas",', '  "cards": [{"ref": "k1", "x": 480, "y": 0, "w": 300}]', '}']
  const CANVAS = '{"v":1,"mode":"canvas","cards":[{"ref":"k1","x":480,"y":0,"w":300}]}'
  it.each([
    ['结构键在最前', ['amadeus_schema: amadeus.page/4', ...pretty, 'tags: [a]']],
    ['结构键排在外来键之后(修前:条目被挪到最前、顶格 `}` 留在原位 → 首击写出非法 YAML)', ['tags: [a]', 'amadeus_schema: amadeus.page/4', ...pretty, 'aliases: [z]']],
  ])('%s:顶格收尾行归条目,读得出单行 JSON;首击后整块仍是合法 YAML、几何与外来键都在', (_k, lines) => {
    const fm = `---\n${lines.join('\n')}\n---\n`
    expect(inner(fm)).toBeTruthy() // 前提:原文是合法 YAML
    expect(canvasLineOf(fm)).toBe(CANVAS)
    const next = setAmadeusStructure(fm, layoutLineOf(fm), canvasLineOf(fm))
    expect(inner(next)).toMatchObject({ amadeus_schema: 'amadeus.page/4', amadeus_canvas: JSON.parse(CANVAS), tags: ['a'] })
    // 外来区(属性面板)同样不带结构键的收尾孤儿
    expect(foreignFmText(fm)).not.toMatch(/^[}\]]/m)
  })

  // fail-closed 兜底:重组结构区会**挪动**条目(结构键归到最前)。原文合法、挪完却不合法的形态(这里:结构键引用了
  // 排在它前面的外来键锚点,挪到最前就成了「别名先于锚点」)→ 原样返回,绝不写出一块解析不了的 fm。
  it('原文合法而重组后不合法 → setAmadeusStructure / setForeignFm 原样返回', () => {
    const fm = `---\nx: &c ${CANVAS}\namadeus_schema: amadeus.page/4\namadeus_canvas: *c\n---\n`
    expect(inner(fm)).toBeTruthy()
    expect(setAmadeusStructure(fm, layoutLineOf(fm), canvasLineOf(fm))).toBe(fm)
    // setForeignFm:外来区连续的一段 → 原位替换(D-20),锚点仍在别名之前,合法;外来区被保留行隔开 → 走重组 →
    // 结构键挪到最前成了「别名先于锚点」→ 原样返回
    expect(setForeignFm(fm, 'x: &c {"v":1}\ntags: [b]')).toBe(`---\nx: &c {"v":1}\ntags: [b]\namadeus_schema: amadeus.page/4\namadeus_canvas: *c\n---\n`)
    const split = `---\nx: &c ${CANVAS}\namadeus_schema: amadeus.page/4\ny: 1\namadeus_canvas: *c\n---\n`
    expect(inner(split)).toBeTruthy()
    expect(setForeignFm(split, 'x: &c {"v":1}\ny: 2')).toBe(split)
    // 对照:原文本来就解析不了(重复键等)→ 不拦,照旧按行级规则重写(兜底只防「由好变坏」)
    const dup = `---\ntags: [a]\ntags: [b]\namadeus_schema: amadeus.page/4\n---\n`
    expect(setAmadeusStructure(dup, null, CANVAS)).toContain(`amadeus_canvas: ${CANVAS}`)
  })
})
