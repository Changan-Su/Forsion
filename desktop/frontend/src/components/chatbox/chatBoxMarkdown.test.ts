// @vitest-environment happy-dom
/** Chat Box format grammar: what a typed title is stored as, and what a stored title reads as.
 *  Real Milkdown with the box's own parts (./editorPlugins). The 11-20 measurement (instrument/todo-title-roundtrip.md) found
 *  `snake_case`, URLs with `_` / `&` and `5*3` stored with backslashes by the notes' serializer; these pin that the box
 *  stores them as typed, that a plain title loads and re-saves byte for byte, and that the readers' parse agrees. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Editor, editorViewCtx, parserCtx, rootCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import type { Node as PMNode, Schema } from '@milkdown/kit/prose/model'
import { chatBoxEditorPlugins } from './editorPlugins'
import { storeMarkdown } from './ChatBoxEditor'
import { inlineMarkdownToPlain, minimizeEscapes, parseInlineMarkdown, type ChatBoxFormat } from './chatBoxMarkdown'

interface Booted { parse(md: string): PMNode; store(doc: PMNode): string; schema: Schema; destroy(): Promise<void> }

async function boot(format: ChatBoxFormat): Promise<Booted> {
  const root = document.createElement('div')
  document.body.appendChild(root)
  // milkdown's ctx Timer never clears its 3s timeouts (see parseFidelity.testkit): collect and clear them on destroy.
  const timers: unknown[] = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) => { const id = realSetTimeout(fn, ms, ...args); timers.push(id); return id }) as typeof setTimeout
  let ed: Editor
  try {
    ed = await Editor.make().config((ctx) => { ctx.set(rootCtx, root) }).use(chatBoxEditorPlugins(format)).create()
  } finally { globalThis.setTimeout = realSetTimeout }
  return {
    parse: (md) => ed.action((ctx) => ctx.get(parserCtx)(md)) as PMNode,
    store: (doc) => ed.action((ctx: Ctx) => storeMarkdown(ctx, doc)),
    schema: ed.action((ctx) => ctx.get(editorViewCtx).state.schema),
    destroy: async () => { await ed.destroy(); for (const t of timers) clearTimeout(t as number); root.remove() },
  }
}

/** Plain-text titles people write. Each is stored exactly as typed. */
const AS_TYPED = ['5*3', 'a_b_c', 'snake_case_name', '#工作 交周报', '[[评审议程]]', '1. 买菜', '- x', '2026. 计划', 'C:\\dir\\a',
  'https://forsion.net/a_b?x=1&y=2', '@2026-11-21', '交周报 @2026-11-21T17:00', '<b>x</b>', '50% off & more', 'a  b', '> 引用',
  '价格 $5 * 2', '# 标题', '3~5 小时', '![[图.png]]', '[^1] 注', '| a | b |', '---', 'www.forsion.net', 'mail me@x.cn',
  // review 11-21: images are off, so `![x](y)` is text, not `!` + a link; a later pass frees an escape an earlier one kept
  '![cat](pic.png)', '*a**b']
/** Text that spells formatting: typed as plain characters it keeps the fewest backslashes that stop it turning into marks. */
const MARKUP = ['**会前材料**：设计', '`code`', '~~删~~', '[链接](https://a.b)', '*重要* 回电话', '<https://a.b>', '[[*x*]] 里']

describe('inline profile', () => {
  let b: Booted
  beforeAll(async () => { b = await boot('inline') })
  afterAll(async () => { await b.destroy() })
  const typed = (t: string): PMNode => b.schema.node('doc', null, [b.schema.node('paragraph', null, t ? [b.schema.text(t)] : [])])
  const isPlain = (doc: PMNode): boolean => doc.childCount === 1 && doc.firstChild!.childCount === 1 && !doc.firstChild!.firstChild!.marks.length

  it.each(AS_TYPED)('stores %s as typed, and it reads back as plain text', (t) => {
    const stored = b.store(typed(t))
    expect(stored).toBe(t)
    const back = b.parse(stored)
    expect(back.textContent).toBe(t)
    expect(isPlain(back)).toBe(true)
  })
  it.each(MARKUP)('literal %s keeps only the escapes it needs', (t) => {
    const stored = b.store(typed(t))
    const back = b.parse(stored)
    expect(back.textContent).toBe(t)
    expect(isPlain(back)).toBe(true)
    expect(stored.replace(/\\/g, '')).toBe(t) // nothing but backslashes added
    expect((stored.match(/\\/g) ?? []).length).toBeLessThanOrEqual(1)
  })
  it.each([...AS_TYPED, ...MARKUP])('a stored %s loads and re-saves byte for byte', (t) => {
    expect(b.store(b.parse(t))).toBe(t)
  })
  it('writes formatting the way a note would', () => {
    const s = b.schema
    const m = (name: string, attrs?: Record<string, unknown>) => s.marks[name].create(attrs)
    const doc = s.node('doc', null, [s.node('paragraph', null, [
      s.text('会前材料', [m('strong')]), s.text('：'), s.text('设计', [m('emphasis')]), s.text(' '), s.text('a_b', [m('inlineCode')]),
      s.text(' '), s.text('旧', [m('strike_through')]), s.text(' '), s.text('官网', [m('link', { href: 'https://forsion.net' })]),
    ])])
    expect(b.store(doc)).toBe('**会前材料**：*设计* `a_b` ~~旧~~ [官网](https://forsion.net)')
  })
  it('a CJK neighbour of ** needs no character reference (every reader parses CJK-friendly)', () => {
    const s = b.schema
    const doc = s.node('doc', null, [s.node('paragraph', null, [s.text('注意：', [s.marks.strong.create()]), s.text('后面')])])
    const stored = b.store(doc)
    expect(stored).toBe('**注意：**后面')
    expect(b.parse(stored).eq(doc)).toBe(true)
  })
  it('a no-break space at the edge of a mark keeps its reference (the attention serializer is wired in)', () => {
    const s = b.schema
    const doc = s.node('doc', null, [s.node('paragraph', null, [s.text('abc\u00A0', [s.marks.strong.create()])])])
    expect(b.store(doc)).toBe('**abc&#xA0;**')
  })
  it('a line break in a value reads as a space (the inline schema has no break node)', () => {
    for (const md of ['A  \nB', 'A\\\nB', 'A\nB']) {
      const doc = b.parse(md)
      expect(doc.textContent, JSON.stringify(md)).toBe('A B')
      expect(parseInlineMarkdown(md).map((t) => t.text).join('')).toBe('A B')
    }
  })
  it('several paragraphs in a value read as one line, nothing dropped', () => {
    const doc = b.parse('第一行\n\n第二行')
    expect(doc.childCount).toBe(1)
    expect(doc.textContent).toBe('第一行 第二行')
  })
  it('parseInlineMarkdown reads every value the way the editor does', () => {
    const fixtures = [...AS_TYPED, ...MARKUP, '**粗** 和 *斜* 和 `码` 和 ~~删~~ 和 [链](https://a.b)', '**注意：**后面', 'API**注意**', '**[[评审议程]]** 之前', '[**加粗链接**](https://x.y)']
    for (const md of fixtures) {
      const runs: Array<{ text: string; marks: string }> = []
      b.parse(md).firstChild!.forEach((n) => {
        const marks = n.marks.map((x) => (x.type.name === 'link' ? `link:${x.attrs.href}` : x.type.name)).sort().join(',')
        runs.push({ text: n.text ?? '', marks })
      })
      const name: Record<string, string> = { strong: 'strong', em: 'emphasis', strike: 'strike_through', code: 'inlineCode' }
      const tokens = parseInlineMarkdown(md).map((t) => ({
        text: t.wiki !== undefined ? `[[${t.wiki}]]` : t.text,
        marks: [...Object.entries(name).filter(([k]) => (t as unknown as Record<string, unknown>)[k]).map(([, v]) => v), ...(t.href !== undefined ? [`link:${t.href}`] : [])].sort().join(','),
      }))
      // Adjacent runs with the same marks are one run in either reading.
      const merge = (xs: Array<{ text: string; marks: string }>) => xs.reduce<Array<{ text: string; marks: string }>>((a, x) => {
        const last = a[a.length - 1]
        if (last && last.marks === x.marks) last.text += x.text; else a.push({ ...x })
        return a
      }, [])
      expect(merge(tokens), md).toEqual(merge(runs))
    }
  })
})

describe('parseInlineMarkdown', () => {
  it('wiki links: alias shown, nothing inside read as markup', () => {
    expect(parseInlineMarkdown('看 [[周计划|这周]] 和 [[a_b_c]]')).toEqual([
      { text: '看 ', from: 0, to: 2 },
      { text: '这周', wiki: '周计划|这周', from: 2, to: 12 },
      { text: ' 和 ', from: 12, to: 15 },
      { text: 'a_b_c', wiki: 'a_b_c', from: 15, to: 24 },
    ])
  })
  it('wiki links are read where the editor sees text: not in code, not split by marks (review 11-21)', () => {
    expect(parseInlineMarkdown('`[[x]]`')).toEqual([{ text: '[[x]]', code: true, from: 1, to: 6 }])
    expect(parseInlineMarkdown('[[*x*]]').some((t) => t.wiki !== undefined)).toBe(false)
    const src = '&#65;[[p]]'
    const w = parseInlineMarkdown(src).find((t) => t.wiki !== undefined)!
    expect(src.slice(w.from, w.to)).toBe('[[p]]')
  })
  it('offsets point at the run in the source, inside its delimiters', () => {
    const src = '交周报 **明天下午** 前'
    const bold = parseInlineMarkdown(src).find((t) => t.strong)!
    expect(src.slice(bold.from, bold.to)).toBe('明天下午')
  })
  it('block-looking text, HTML and bare URLs stay text', () => {
    for (const t of ['1. 买菜', '# x', '> q', '<b>x</b>', 'https://a.b/c_d']) expect(parseInlineMarkdown(t)).toEqual([{ text: t, from: 0, to: t.length }])
  })
  it('plain reading for labels, sorting and notifications', () => {
    expect(inlineMarkdownToPlain('**会前材料**：设计 [[评审议程|议程]] `x_y`')).toBe('会前材料：设计 议程 x_y')
    expect(inlineMarkdownToPlain('')).toBe('')
  })
})

describe('parseInlineMarkdown offsets (review 11-21, second pass)', () => {
  /** Runs in source order, never overlapping, each spelling its own text (or its `[[…]]`). */
  const wellFormed = (src: string): void => {
    let end = 0
    for (const t of parseInlineMarkdown(src)) {
      expect(t.from).toBeGreaterThanOrEqual(end)
      expect(t.to).toBeGreaterThanOrEqual(t.from)
      end = t.to
    }
  }
  it('escapes and a wiki link inside bold: exact, non-overlapping ranges', () => {
    const src = '**A \\*x\\* [[foo]] B** rest'
    const runs = parseInlineMarkdown(src)
    expect(runs.map((t) => src.slice(t.from, t.to))).toEqual(['A \\*x\\* ', '[[foo]]', ' B', ' rest'])
    expect(runs.map((t) => t.text)).toEqual(['A *x* ', 'foo', ' B', ' rest'])
    wellFormed(src)
  })
  it('a wiki run covers its whole [[…]], padded alias or not', () => {
    const src = '[[note| alias ]] x'
    const w = parseInlineMarkdown(src)[0]
    expect(w).toMatchObject({ text: 'alias', wiki: 'note| alias ', from: 0, to: 16 })
  })
  it('a code span: inside the backticks and the stripped spaces, even when its text is a backtick', () => {
    for (const [src, inner] of [['`` ` `` a', '`'], ['` x `', 'x'], ['``a`b``', 'a`b'], ['`  `', '  ']] as const) {
      const c = parseInlineMarkdown(src).find((t) => t.code)!
      expect(c.text).toBe(inner)
      expect(src.slice(c.from, c.to)).toBe(inner)
    }
  })
  it('a link: the text run sits inside the brackets; the target is outside every run', () => {
    const src = '[Plan](https://x.test/2026-11-28) 明天'
    const runs = parseInlineMarkdown(src)
    expect(runs.map((t) => src.slice(t.from, t.to))).toEqual(['Plan', ' 明天'])
    wellFormed(src)
  })
  it('CRLF / CR line breaks read as a space, in code spans too', () => {
    expect(inlineMarkdownToPlain('A\r\nB')).toBe('A B')
    expect(inlineMarkdownToPlain('A\rB')).toBe('A B')
    expect(inlineMarkdownToPlain('`a\nb` c')).toBe('a b c')
  })
  it('stays well-formed over a mixed bag', () => {
    for (const src of ['&#65;[[p]] **b** `c` ~~d~~ [e](https://f) g', '交周报 **明天下午** 前', '\\[[x]] y', 'a  \nb', '**[[Plan #work]]**', 'p1\n\np2']) wellFormed(src)
  })
})

describe('minimizeEscapes', () => {
  const same = (keep: string[]) => (c: string) => !keep.some((k) => !c.includes(k))
  it('drops what the check allows, keeps the rest', () => {
    expect(minimizeEscapes('a\\_b \\*c\\*', same(['\\*c']))).toBe('a_b \\*c*')
  })
  it('long values get one all-at-once try (each test is a parse; review 11-21)', () => {
    const long = 'x\\_'.repeat(2000)
    expect(minimizeEscapes(long, () => true)).toBe('x_'.repeat(2000))
    const calls = vi.fn(() => false)
    expect(minimizeEscapes(long, calls)).toBe(long)
    expect(calls).toHaveBeenCalledTimes(1)
  })
})
