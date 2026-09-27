/** P0 契约(2026-08-13):UnifiedPage 绝不把 frontmatter 喂进编辑器,也绝不在保存时丢它。 */
import { describe, it, expect } from 'vitest'
import { splitFm, composeFm, patchFm, setForeignFm, foreignFmObject, foreignFmText, setAmadeusStructure, layoutLineOf, canvasLineOf, fixStructKeys } from './fm'
import { classifyPageSource } from '@amadeus-shared/compiler/v4'
import { parseFrontmatter } from '@amadeus-shared/compiler/split'

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
