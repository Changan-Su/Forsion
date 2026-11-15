// @vitest-environment happy-dom
// 回车口径开关(./enterMode、./lineGap):空行编码与「旧笔记不被改写」的读写闭环,开关关 / 开两种都跑。
// 三个口径:saved() = 落盘(含逐字回填);md() = 纯序列化(不逐字,验编码本身是不是不动点);结构 = 重开前后的 PM 文档。
import { afterEach, describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { history } from '@milkdown/kit/plugin/history'
import { undo } from '@milkdown/kit/prose/history'
import { bootEditor, type Booted } from './parseFidelity.testkit'
import { setEnterInlineForTest } from './enterMode'
import { TIGHT_MANAGED, withTightManaged } from './lineGap'
import { applyTypedTrigger, lineTriggerAtCursor } from './blockTriggers'
import { reconcileTr } from '../../unified/reconcileDiff'

afterEach(() => setEnterInlineForTest(false))

/** 结构指纹:顶层块类型 + 紧贴记号 + 文字 + 软/硬换行;标题 id 不算。 */
const shape = (doc: PMNode): string => {
  const out: string[] = []
  doc.forEach((n) => {
    let t = ''
    n.descendants((c) => {
      if (c.isText) t += c.text
      else if (c.type.name === 'hardbreak') t += c.attrs.isInline ? '⏎' : '↵'
      return true
    })
    out.push(`${n.type.name}${n.attrs.amxTight ? '+t' : ''}${n.attrs.amxTightBefore ? '+tb' : ''}:${t}`)
  })
  return out.join(' | ')
}

const OLD_NOTES: Array<[string, string]> = [
  ['段落之间空一行', 'one\n\ntwo\n\nthree\n'],
  ['空两行', 'a\n\n\nb\n'],
  ['空三行', 'a\n\n\n\nb\n'],
  ['文首文末有空行', '\n\nhead\n\nbody\n\n\n'],
  ['一段里三行单换行', 'line one\nline two\nline three\n'],
  ['粗体跨行', 'x **bold\nacross** y\nnext line\n'],
  ['列表项带单换行', '- item one\n  continued\n- item two\n'],
  ['引用带单换行', '> quote a\n> quote b\n\nafter\n'],
  ['callout 带单换行', '> [!note] Title\n> body a\n> body b\n'],
  ['标题后紧跟正文', '# Title\nbody right after\n\n## Sub\nmore\n'],
  ['混合', '# H\n\npara a\npara b\n\n\n- l1\n- l2\n\n> q\n\n```\ncode\n```\nafter code\n'],
]

/** [名字, 原文, 在哪段文字后面打一个 Z]。前十三组 = 「只在别处改」;带「段内」的 = 改多行段落里的一行。 */
const EDITS: Array<[string, string, string]> = [
  ['段落之间空一行', 'one\n\ntwo\n\nthree\n', 'three'],
  ['空两行', 'a\n\n\nb\n\nedit\n', 'edit'],
  ['空三行', 'a\n\n\n\nb\n\nedit\n', 'edit'],
  ['文末有空行(改文首那块)', '\n\nhead\n\nbody\n\n\n', 'head'],
  ['文首有空行(改文末那块)', '\n\nhead\n\nbody\n\n\n', 'body'],
  ['一段里三行单换行', 'line one\nline two\nline three\n\nedit\n', 'edit'],
  ['粗体跨行', 'x **bold\nacross** y\nnext line\n\nedit\n', 'edit'],
  ['列表项带单换行', '- item one\n  continued\n- item two\n\nedit\n', 'edit'],
  ['引用带单换行', '> quote a\n> quote b\n\nedit\n', 'edit'],
  ['callout 带单换行', '> [!note] Title\n> body a\n> body b\n\nedit\n', 'edit'],
  ['标题后紧跟正文(改正文)', '# Title\nbody right after\n\n## Sub\nmore\n', 'more'],
  ['标题后紧跟正文(改别段)', '# Title\nbody right after\n\n## Sub\nmore\n\nedit\n', 'edit'],
  ['代码块后紧跟正文', '```\ncode\n```\nafter code\n\nedit\n', 'edit'],
  ['段内:改第二行', 'line one\nline two\nline three\n', 'line two'],
  ['段内:两空格硬换行', 'a one  \nb two\nc three\n', 'b two'],
  ['段内:反斜杠硬换行', 'a one\\\nb two\nc three\n', 'b two'],
  ['段内:行内 br', 'a one<br>\nb two\nc three\n', 'b two'],
  ['段内:续行缩进', 'a one\n   b two\nc three\n', 'b two'],
  ['段内:粗体跨行时改末行', 'x **bold\nacross** y\nnext line\n', 'next line'],
  ['callout 内改一行', '> [!note] Title\n> body a\n> body b\n', 'body b'],
]

/** 在含 target 的文本块里、target 之后的文档位置。 */
function posAfter(doc: PMNode, target: string): number {
  let at = -1
  doc.descendants((n, pos) => {
    if (at < 0 && n.isTextblock) {
      const i = n.textBetween(0, n.content.size, '\n', '￼').indexOf(target)
      if (i >= 0) {
        let off = 0
        n.forEach((c, cOff) => {
          if (at >= 0) return
          const len = c.isText ? c.text!.length : 1
          if (off + len >= i + target.length) at = pos + 1 + cOff + (i + target.length - off)
          off += len
        })
      }
    }
    return at < 0
  })
  return at
}

const topPos = (doc: PMNode, k: number): number => { let p = 0; for (let i = 0; i < k; i++) p += doc.child(i).nodeSize; return p }

describe.each([['off', false], ['inline', true]] as const)('开关 %s', (_label, on) => {
  it.each(OLD_NOTES)('旧笔记原样:%s', async (_name, md) => {
    setEnterInlineForTest(on)
    const b = await bootEditor(md)
    try {
      // 不编辑直接取:逐字节等于原文
      expect(b.saved()).toBe(md)
      // 纯序列化(不逐字)再解析一次:结构不变(编码是不动点)
      const again = b.parse(b.md())
      expect(shape(again)).toBe(shape(b.view.state.doc))
    } finally { await b.destroy() }
  })

  // 已知没过的格:off = 现状(空行编码 2N+1、标题后紧跟正文编辑一次被插空行);两空格硬换行在改同一段时被规范成 `\`;
  // 续行缩进只有被改的那一行丢了行首空格;callout 内改一行被拆成多段。后三条两种口径一样,不归本开关。
  const KNOWN: Record<string, string[]> = {
    off: ['文首有空行(改文末那块)', '标题后紧跟正文(改正文)', '段内:两空格硬换行', '段内:续行缩进', 'callout 内改一行'],
    inline: ['段内:两空格硬换行', '段内:续行缩进', 'callout 内改一行'],
  }
  for (const [name, md, target] of EDITS) (KNOWN[_label].includes(name) ? it.fails : it)(`改一个字,没碰的行逐字不变:${name}`, async () => {
    setEnterInlineForTest(on)
    const b = await bootEditor(md)
    try {
      const at = posAfter(b.view.state.doc, target)
      expect(at).toBeGreaterThan(-1)
      b.view.dispatch(b.view.state.tr.setSelection(TextSelection.create(b.view.state.doc, at)).insertText('Z'))
      const out = b.saved()
      const k = md.indexOf(target) + target.length
      expect(out).toBe(md.slice(0, k) + 'Z' + md.slice(k))
      // 存出来的再当新笔记打开,不编辑直接取:逐字节相同;纯序列化重开结构不变
      const b2 = await bootEditor(out)
      try {
        expect(b2.saved()).toBe(out)
        expect(shape(b2.parse(b2.md()))).toBe(shape(b2.view.state.doc))
      } finally { await b2.destroy() }
    } finally { await b.destroy() }
  })
})

// ── 过期紧贴记号(只在开关开着时有记号)──────────────────────────────────────────
// 每条都挑「新邻居能紧贴」的情形:记号过期了不清,存盘就会把空行悄悄吞掉。
describe('开关 inline:紧贴记号随邻居变化', () => {
  const boot = async (md: string): Promise<Booted> => { setEnterInlineForTest(true); return bootEditor(md, { extra: [history].flat() }) }
  const delTop = (b: Booted, k: number): void => {
    const doc = b.view.state.doc
    b.view.dispatch(b.view.state.tr.delete(topPos(doc, k), topPos(doc, k) + doc.child(k).nodeSize))
  }
  const moveTop = (b: Booted, k: number, to: number): void => {
    const doc = b.view.state.doc
    const node = doc.child(k)
    const tr = b.view.state.tr.delete(topPos(doc, k), topPos(doc, k) + node.nodeSize)
    tr.insert(topPos(tr.doc, to), node)
    b.view.dispatch(tr)
  }

  it('下一块被删、换来一个能紧贴的标题 → 记号清掉,空行留着', async () => {
    const md = 'alpha\n- item\n\n## Next\n'
    const b = await boot(md)
    try {
      expect(shape(b.view.state.doc)).toBe('paragraph+t:alpha | bullet_list:item | heading:Next')
      delTop(b, 1)
      expect(shape(b.view.state.doc)).toBe('paragraph:alpha | heading:Next')
      expect(b.saved()).toBe('alpha\n\n## Next\n')
    } finally { await b.destroy() }
  })

  it('撤销删除 → 记号回来,存盘回到原文', async () => {
    const md = 'alpha\n- item\n\n## Next\n'
    const b = await boot(md)
    try {
      delTop(b, 1)
      const ed = b.view
      expect(undo(ed.state, ed.dispatch)).toBe(true) // 删块和随后的清记号是同一个撤销组
      expect(shape(ed.state.doc)).toBe('paragraph+t:alpha | bullet_list:item | heading:Next')
      expect(b.saved()).toBe(md)
    } finally { await b.destroy() }
  })

  it('紧贴的块被挪走、落到一个标题前面 → 它身上的记号清掉', async () => {
    const md = 'alpha\n- item\n\n## H\n\nlast\n'
    const b = await boot(md)
    try {
      moveTop(b, 0, 1) // alpha 挪到列表之后、标题之前
      expect(shape(b.view.state.doc)).toBe('bullet_list:item | paragraph:alpha | heading:H | paragraph:last')
      expect(b.saved()).toBe('- item\n\nalpha\n\n## H\n\nlast\n')
    } finally { await b.destroy() }
  })

  it('中间插进新块 → 前一块的记号清掉', async () => {
    const md = '## T\nbody\n'
    const b = await boot(md)
    try {
      const { schema } = b.view.state
      b.view.dispatch(b.view.state.tr.insert(b.view.state.doc.child(0).nodeSize, schema.nodes.blockquote.create(null, schema.nodes.paragraph.create(null, schema.text('q')))))
      expect(shape(b.view.state.doc)).toBe('heading:T | blockquote:q | paragraph:body')
      expect(b.saved()).toBe('## T\n\n> q\n\nbody\n')
    } finally { await b.destroy() }
  })

  it('紧贴段被从中间拆开 → 前半段不紧贴,后半段接过记号', async () => {
    const md = 'alpha.beta\n## H\n'
    const b = await boot(md)
    try {
      b.view.dispatch(b.view.state.tr.split(posAfter(b.view.state.doc, 'alpha.')))
      expect(shape(b.view.state.doc)).toBe('paragraph:alpha. | paragraph+t:beta | heading:H')
      expect(b.saved()).toBe('alpha.\n\nbeta\n## H\n')
    } finally { await b.destroy() }
  })

  it('两段并成一段 → 并成的段接过下半段的记号', async () => {
    const md = 'para\n\nbody\n## H\n'
    const b = await boot(md)
    try {
      b.view.dispatch(b.view.state.tr.join(b.view.state.doc.child(0).nodeSize))
      expect(shape(b.view.state.doc)).toBe('paragraph+t:parabody | heading:H')
      expect(b.saved()).toBe('parabody\n## H\n')
    } finally { await b.destroy() }
  })

  it('改紧贴标题下面的正文、改标题的 attr → 记号不动', async () => {
    const md = '## T\nbody\n\nnext\n'
    const b = await boot(md)
    try {
      b.view.dispatch(b.view.state.tr.insertText('Z', posAfter(b.view.state.doc, 'body')))
      const h = b.view.state.doc.child(0)
      b.view.dispatch(b.view.state.tr.setNodeMarkup(0, undefined, { ...h.attrs, align: 'center' }))
      b.view.dispatch(b.view.state.tr.setNodeMarkup(0, undefined, { ...b.view.state.doc.child(0).attrs, align: 'left' }))
      expect(shape(b.view.state.doc)).toBe('heading+t:T | paragraph:bodyZ | paragraph:next')
      expect(b.saved()).toBe('## T\nbodyZ\n\nnext\n')
    } finally { await b.destroy() }
  })

  it.each([
    ['只改了紧贴标题下面的正文', '## T\nbody\n\nnext\n', '## T\nbody EXT\n\nnext\n'],
    ['只改了紧贴的标题', '## T\nbody\n\nnext\n', '## T2\nbody\n\nnext\n'],
    ['外部把紧贴改成隔一条空行', '## T\nbody\n\nnext\n', '## T\n\nbody\n\nnext\n'],
    ['外部把空行去掉、改成紧贴', '## T\n\nbody\n\nnext\n', '## T\nbody\n\nnext\n'],
  ])('外部回灌(最小差异事务)%s → 编辑器与盘上一致,再存逐字等于盘上', async (_n, before, after) => {
    const b = await boot(before)
    try {
      const next = b.parse(after)
      const tr = reconcileTr(b.view.state, next)
      expect(tr).not.toBeNull()
      b.view.dispatch(tr!)
      expect(shape(b.view.state.doc)).toBe(shape(next))
      expect(b.md()).toBe(after)
    } finally { await b.destroy() }
  })

  it('整篇替换(外部回灌)→ 新内容自带的记号保留', async () => {
    const b = await boot('x\n')
    try {
      const next = b.parse('## T\nbody\n\nalpha\n- item\n')
      b.view.dispatch(b.view.state.tr.replaceWith(0, b.view.state.doc.content.size, next.content))
      expect(shape(b.view.state.doc)).toBe('heading+t:T | paragraph:body | paragraph+t:alpha | bullet_list:item')
      expect(b.saved()).toBe('## T\nbody\n\nalpha\n- item\n')
    } finally { await b.destroy() }
  })
})

// ── 紧贴只在「下一块真能另起一块」时成立(评审抓到的四格)────────────────────────────
describe('开关 inline:紧贴的安全判定', () => {
  const boot = async (md: string): Promise<Booted> => { setEnterInlineForTest(true); return bootEditor(md) }
  const solid = (doc: PMNode): string => shape(doc).replace(/\+tb?/g, '')

  it('标题末尾回车新起的正文,后面是逐字抄回的缩进代码 → 中间留空行(否则代码被吞成正文的续行)', async () => {
    const b = await boot('## H\n    code\n')
    try {
      const st = b.view.state
      const hEnd = st.doc.child(0).nodeSize - 1
      const tr = st.tr.split(hEnd, 1, [{ type: st.schema.nodes.paragraph }])
      tr.setNodeMarkup(0, undefined, { ...tr.doc.child(0).attrs, amxTight: true })
      const pPos = tr.doc.child(0).nodeSize
      tr.setNodeMarkup(pPos, undefined, { ...tr.doc.child(1).attrs, amxTight: true })
      b.view.dispatch(tr.setMeta(TIGHT_MANAGED, true))
      b.view.dispatch(b.view.state.tr.insertText('body', pPos + 1))
      const out = b.saved()
      expect(out).toBe('## H\nbody\n\n    code\n')
      expect(solid(b.parse(out))).toBe(solid(b.view.state.doc))
    } finally { await b.destroy() }
  })

  it('段落紧接多行标题(写出去是 setext)→ 中间留空行,重开还是段落 + 标题', async () => {
    const b = await boot('alpha\ntitle\nomega\n')
    try {
      const st = b.view.state
      let br = -1
      st.doc.descendants((n, pos) => { if (br < 0 && n.type.name === 'hardbreak') br = pos; return br < 0 })
      const tr = st.tr.delete(br, br + 1).split(br)
      tr.setNodeMarkup(0, undefined, { ...tr.doc.child(0).attrs, amxTight: true })
      b.view.dispatch(tr.setMeta(TIGHT_MANAGED, true))
      withTightManaged(() => {
        const s2 = b.view.state
        b.view.dispatch(s2.tr.setBlockType(s2.doc.child(0).nodeSize + 1, s2.doc.child(0).nodeSize + 1, s2.schema.nodes.heading, { level: 1 }))
      })
      const out = b.saved()
      expect(out.startsWith('alpha\n\n')).toBe(true)
      expect(solid(b.parse(out))).toBe(solid(b.view.state.doc))
    } finally { await b.destroy() }
  })

  it('段落紧接首项只有图片的列表:改段落的字不插空行', async () => {
    const md = 'a\n- ![alt](x)\n'
    const b = await boot(md)
    try {
      b.view.dispatch(b.view.state.tr.insertText('Z', posAfter(b.view.state.doc, 'a')))
      expect(b.saved()).toBe('aZ\n- ![alt](x)\n')
    } finally { await b.destroy() }
  })

  it('第二行敲 `- ` 成列表:上半段仍紧贴列表(转换事务不被当成邻居变了)', async () => {
    const b = await boot('alpha\n-title\nomega\n')
    try {
      const at = posAfter(b.view.state.doc, '-')
      b.view.dispatch(b.view.state.tr.setSelection(TextSelection.create(b.view.state.doc, at)))
      const hit = lineTriggerAtCursor(b.view.state.selection.$from)
      expect(hit?.trig.kind).toBe('bullet')
      expect(applyTypedTrigger(b.view, hit!.trig, ' ', hit!.br)).toBe(true)
      expect(shape(b.view.state.doc)).toBe('paragraph+t:alpha | bullet_list:title⏎omega')
      const out = b.saved()
      expect(out.startsWith('alpha\n')).toBe(true)
      expect(out.startsWith('alpha\n\n')).toBe(false)
      expect(solid(b.parse(out))).toBe(solid(b.view.state.doc))
    } finally { await b.destroy() }
  })
})
