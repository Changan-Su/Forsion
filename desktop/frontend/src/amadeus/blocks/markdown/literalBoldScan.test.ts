// @vitest-environment happy-dom
// Literal bold: the display scanner must agree with the parser (random comparison, see ./literalBold).
// 加粗字面化:显示用的扫描器与解析器判断一致(随机对拍)。
//  · strict  — the source parses without italic / code / links: every strong node of the parser = one span of the
//              scanner, at the same place (the scanner runs on the editor's block text, the parser on the source).
//              严格:解析结果里没有斜体 / 代码 / 链接时,扫描器认出的加粗区间 = 解析器的 strong 节点。
//  · relaxed — italic is still a mark in this package and `*` is now written raw, so an italic right next to literal
//              stars can merge into one run on reopening (`*a **b* c**`): no letter lost, and from the second save on
//              the bytes are stable. 放宽:斜体仍是属性、旁边紧挨文字星号时,重开后结构可能变;只要求一个字不丢、第二次保存起字节稳定。
// Counts of the relaxed cases where structure did change are printed (they go into the PR).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { bootEditor, type Booted } from './parseFidelity.testkit'
import { normalizeSerializedMd } from './MarkdownBlock'
import { boldSpans, scanInput, type BoldSpan } from './literalBold'
import { setLiteralBold } from './literalBoldFlag'

/* eslint-disable @typescript-eslint/no-explicit-any */
type MdNode = any

let b: Booted
beforeAll(async () => {
  setLiteralBold(true)
  b = await bootEditor('x\n')
})
afterAll(async () => {
  await b.destroy()
  setLiteralBold(null)
})

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TOKENS = ['*', '**', '***', '_', '__', 'a', 'b', 'ab', ' ', ' ', '中', '文', '。', '：', '「', '」', '.', ',', '!', '(', ')',
  '\\', '\\*', '\\_', 'x_y', 'snake_case', '5 * 3', '\n', '😀']
const LINE_START = ['', '', '', '- ', '* ', '1. ', '> ', '# ']

function gen(r: () => number, withMarks: boolean): string {
  const n = 1 + Math.floor(r() * 12)
  let s = LINE_START[Math.floor(r() * LINE_START.length)]
  for (let i = 0; i < n; i++) {
    let t = TOKENS[Math.floor(r() * TOKENS.length)]
    if (t === '\n') t = '\n' + LINE_START[Math.floor(r() * LINE_START.length)]
    if (withMarks && r() < 0.08) t = ['`c`', '[l](u)', '~~s~~'][Math.floor(r() * 3)]
    s += t
  }
  return s.replace(/\\$/, '') + '\n'
}

// ── expected: flatten the parser's mdast (switch off, strong kept) the way PM lays out a text block ──
interface Flat { text: string; spans: BoldSpan[] }
const INLINE_PASS = new Set(['emphasis', 'delete', 'link', 'linkReference'])
function flatten(node: MdNode, src: string, out: Flat, flags: { marks: boolean; odd: boolean }): void {
  for (const k of node.children ?? []) {
    if (k.type === 'text' || k.type === 'amadeusEscape') out.text += k.value
    else if (k.type === 'inlineCode') { out.text += k.value; flags.marks = true }
    else if (k.type === 'break') out.text += '\n'
    else if (k.type === 'strong') {
      const s = k.position.start.offset
      const e = k.position.end.offset
      const open = src.slice(s, s + 2)
      const from = out.text.length
      out.text += open
      flatten(k, src, out, flags)
      out.text += src.slice(e - 2, e)
      out.spans.push({ from, to: out.text.length, delim: open as '**' | '__' })
    } else if (INLINE_PASS.has(k.type)) {
      flags.marks = true
      flatten(k, src, out, flags)
    } else {
      flags.odd = true
      out.text += '￼'
    }
  }
}
function expectedBlocks(src: string): { blocks: Flat[]; marks: boolean; odd: boolean } {
  setLiteralBold(false)
  let tree: MdNode
  try {
    const remark = b.remark()
    tree = remark.runSync(remark.parse(src), src)
  } finally {
    setLiteralBold(true)
  }
  const blocks: Flat[] = []
  const flags = { marks: false, odd: false }
  const walk = (n: MdNode): void => {
    if (n.type === 'paragraph' || n.type === 'heading') {
      const f: Flat = { text: '', spans: [] }
      flatten(n, src, f, flags)
      blocks.push(f)
      return
    }
    if (n.type === 'code' || n.type === 'html') return
    for (const k of n.children ?? []) walk(k)
  }
  walk(tree)
  return { blocks, ...flags }
}
function textblocks(doc: PMNode): PMNode[] {
  const out: PMNode[] = []
  doc.descendants((n) => {
    if (n.isTextblock) {
      if (!n.type.spec.code) out.push(n)
      return false
    }
    return true
  })
  return out
}
const save = (doc: PMNode): string => normalizeSerializedMd(b.serialize(doc))
const letters = (doc: PMNode): string => doc.textContent.replace(/[*_\\\s]/g, '')
const key = (s: BoldSpan[]): string => s.map((x) => `${x.from}-${x.to}${x.delim}`).sort().join(',')

interface Tally { strict: number; relaxed: number; unmodelled: number; changed: number; hist: Record<number, number> }

/** One random case. Returns failure strings (empty = pass). 一个随机用例。 */
function runCase(src: string, t: Tally, samples: { unstable1: string[]; changed: string[] }): string[] {
  const fails: string[] = []
  const exp = expectedBlocks(src)
  const doc = b.parse(src)
  // empty text blocks (an empty list item gets an empty paragraph in PM, none in mdast) are left out on both sides
  // 空文本块两边都不比(空列表项在 PM 里有一个空段落,mdast 里没有)
  const tbs = textblocks(doc).filter((tb) => tb.content.size > 0)
  exp.blocks = exp.blocks.filter((x) => x.text.length > 0)
  const modelled = !exp.odd && tbs.length === exp.blocks.length && tbs.every((tb, k) => scanInput(tb).text === exp.blocks[k].text)
  const s1 = save(doc)
  const d1 = b.parse(s1)
  const s2 = save(d1)
  const d2 = b.parse(s2)
  const s3 = save(d2)
  const rounds = s3 !== s2 ? 3 : s2 !== s1 ? 2 : 1
  t.hist[rounds] = (t.hist[rounds] ?? 0) + 1
  // no letter lost; bytes stable from the second save on 一个字不丢;第二次保存起字节稳定
  if (letters(d1) !== letters(doc) || letters(d2) !== letters(doc)) fails.push(`lost ${JSON.stringify({ src, s1, s2 })}`)
  if (s3 !== s2) fails.push(`unstable ${JSON.stringify({ src, s1, s2, s3 })}`)
  else if (s2 !== s1 && samples.unstable1.length < 8) samples.unstable1.push(JSON.stringify({ src, s1, s2 }))
  const shape = (d: PMNode): string => textblocks(d).map((tb) => key(boldSpans(tb))).join('|')
  if (!modelled) {
    t.unmodelled++

  } else if (!exp.marks) {
    t.strict++
    tbs.forEach((tb, k) => {
      const got = key(boldSpans(tb))
      const want = key(exp.blocks[k].spans)
      if (got !== want) fails.push(`scanner≠parser ${JSON.stringify({ src, block: scanInput(tb).text, got, want })}`)
    })
    // what was shown is what the saved file means 看到的加粗 = 存盘后重开的加粗
    if (shape(d1) !== shape(doc)) fails.push(`reopen changed bold ${JSON.stringify({ src, s1 })}`)
    return fails
  }
  if (modelled) t.relaxed++
  if (shape(d1) !== shape(doc)) {
    t.changed++
    if (samples.changed.length < 12) samples.changed.push(JSON.stringify({ src, s1 }))
  }
  return fails
}

describe('literal bold scanner vs parser (random)', () => {
  for (const [seed, count] of [[20261115, 4000], [7, 4000]] as const) {
    it(`seed ${seed}: strict cases match the parser; every case keeps its letters and is stable from the second save`, () => {
      const r = rng(seed)
      const t: Tally = { strict: 0, relaxed: 0, unmodelled: 0, changed: 0, hist: {} }
      const samples = { unstable1: [] as string[], changed: [] as string[] }
      const fails: string[] = []
      for (let i = 0; i < count; i++) fails.push(...runCase(gen(r, i % 4 === 3), t, samples))
      console.log(`[litbold fuzz ${seed}] strict ${t.strict}, relaxed (italic / code / link) ${t.relaxed}, unmodelled ${t.unmodelled}; ` +
        `relaxed whose bold changed after save + reopen ${t.changed}; saves until the bytes stop changing ${JSON.stringify(t.hist)}`)
      if (samples.unstable1.length) console.log(`[litbold fuzz ${seed}] first save not yet stable (second is):\n${samples.unstable1.join('\n')}`)
      if (samples.changed.length) console.log(`[litbold fuzz ${seed}] relaxed, bold changed after reopen:\n${samples.changed.join('\n')}`)
      expect(fails.slice(0, 10)).toEqual([])
    }, 180_000)
  }
})
/* eslint-enable @typescript-eslint/no-explicit-any */
