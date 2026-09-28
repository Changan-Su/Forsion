// @vitest-environment happy-dom
//
// D-18(评审 2026-09-27):任何微小编辑都整篇重新序列化,远处的块被改写。修法:未编辑的顶层块逐字回填原文(./verbatim)。
// 真 Milkdown(生产装配,见 parseFidelity.testkit.ts);真浏览器那一半:npm run check:rtcorpus。
//
// 两类断言:
//  · 逐字:编辑一处,其余块一个字节不变(含文首空行、文末有无换行、块间多空行、缩进起头的列表、缩进标记)。
//  · 安全(fuzz):任何编辑序列之后,逐字输出重解析 ≡ 今天的规范输出重解析(忽略标题 id / 链接 ref 这两个
//    解析副产物)—— 拼接只改「怎么写」,绝不改「写的是什么」。反例都来自各条闸(引用定义、EOF 未闭合围栏、
//    相邻同类列表、列表后缩进代码、首行 `---`)。
import { describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { TextSelection } from '@milkdown/kit/prose/state'
import { bootEditor, type Booted } from './parseFidelity.testkit'
import { adoptOrigins } from './verbatim'

/** 在第一个含 needle 的文本后插一个字(= 用户在那里打字)。 */
function typeAfter(b: Booted, needle: string, ch = 'Z'): void {
  let at = -1
  b.view.state.doc.descendants((n, pos) => {
    if (at >= 0) return false
    if (n.isText) { const i = n.text!.indexOf(needle); if (i >= 0) { at = pos + i + needle.length; return false } }
    return true
  })
  if (at < 0) throw new Error(`找不到 ${needle}`)
  b.view.dispatch(b.view.state.tr.insertText(ch, at))
}
function deleteTop(b: Booted, i: number): void {
  const doc = b.view.state.doc
  let from = 0
  for (let k = 0; k < i; k++) from += doc.child(k).nodeSize
  b.view.dispatch(b.view.state.tr.delete(from, from + doc.child(i).nodeSize))
}
function topPos(doc: PMNode, i: number): number {
  let p = 0
  for (let k = 0; k < i; k++) p += doc.child(k).nodeSize
  return p
}

async function editFirst(md: string): Promise<string> {
  const b = await bootEditor(md)
  try {
    typeAfter(b, 'EDITHERE')
    return b.saved()
  } finally {
    await b.destroy()
  }
}

describe('编辑一处,其余顶层块逐字不变', () => {
  const M = 'EDITHERE'
  it.each([
    ['表格对齐', `${M}\n\n| A | B |\n|---|---|\n| 1 | 2 |\n`],
    ['setext 标题(加载后 id 被改掉,靠邻居推断对回)', `${M}\n\nTitle\n=====\n\ntext\n`],
    ['`~~~` 围栏', `${M}\n\n~~~js\nx\n~~~\n`],
    ['`1. 1. 1.`', `${M}\n\n1. a\n1. b\n1. c\n`],
    ['分割线 `---` / `___`', `${M}\n\n---\n\nmid\n\n___\n\ntext\n`],
    ['`_em_` 与 `__strong__`', `${M}\n\n_emph_ and __strong__\n`],
    ['脚注', `${M}\n\nA[^1] B[^2].\n\n[^1]: one\n[^2]: two\n`],
    ['缩进代码', `${M}\n\n    code\n\ntext\n`],
    ['两空格硬换行', `${M}\n\nline one  \nline two\n`],
    ['`snake_case` 与 `5 * 3`', `${M}\n\nsnake_case_var and 5 * 3\n`],
    ['文末没有换行', `${M}\n\nlast`],
    ['文末多条空行', `${M}\n\nlast\n\n\n`],
    // 空行紧挨被编辑的块时按规范编码写(2N+1,见 softBreak.ts);不挨着的原样。
    ['文首空行(首块没被编辑)', `\n\n\nfirst\n\n${M}\n`],
    ['块间两条 / 三条空行', `${M}\n\nx\n\n\npara\n\n\n\nmore\n`],
    ['行首缩进起头的列表(切片回退到行首)', `${M}\n\n  - a\n  - b\n`],
    ['结构缩进标记跟着下一块走', `${M}\n\n<!-- amadeus-indent:2 -->\n## H\n\ntext\n`],
    ['callout', `${M}\n\n> [!note] Title\n> body\n`],
    ['整行 `<br>`', `${M}\n\n甲\n\n<br>\n\n乙\n`],
    ['引用式链接(定义完好)', `${M}\n\nsee [a][1] and [b][]\n\n[1]: http://example.com "T"\n[b]: http://x.y\n`],
    ['定义后紧跟正文', `${M}\n\n[a]: x\ntext\n`],
  ])('%s', async (_label, md) => {
    expect(await editFirst(md)).toBe(md.replace(M, M + 'Z'))
  })

  it('被编辑的块照旧规范化(附录 A:`_it_`→`*it*`、分割线的新写法 `***`)', async () => {
    expect(await editFirst('EDITHERE _it_\n\n---\n')).toBe('EDITHEREZ *it*\n\n---\n')
  })

  it('打开不改 = 原文逐字(canonical 口径)', async () => {
    for (const md of ['a\n\n- x\n- y\n', '\n\n# t\n\n| a |\n|---|\n| 1 |\n\n\n', 'x  \ny', '> [!tip]- T\n> b\n']) {
      const b = await bootEditor(md)
      try { expect(b.saved()).toBe(md) } finally { await b.destroy() }
    }
  })
})

describe('逐字的闸(不加它就会改结构 / 改语义)', () => {
  it('删掉定义 → 引用改写成带原地址的行内链接(否则重开指向剩下那条)', async () => {
    const b = await bootEditor('see [a][1] here\n\n[1]: http://x.example/docs\n\n[1]: http://x.example/docs/v2\n')
    try {
      deleteTop(b, 1)
      expect(b.saved()).toBe('see [a](http://x.example/docs) here\n\n[1]: http://x.example/docs/v2\n')
    } finally {
      await b.destroy()
    }
  })

  it('到 EOF 的未闭合围栏后面接了新段落 → 围栏走序列化(闭合),新段落不被吞', async () => {
    const b = await bootEditor('para\n\n```js\ncode')
    try {
      const s = b.view.state.schema
      b.view.dispatch(b.view.state.tr.insert(b.view.state.doc.content.size, s.nodes.paragraph.create(null, s.text('after'))))
      const out = b.saved()
      const kids: string[] = []
      b.parse(out).forEach((n) => { kids.push(n.type.name) })
      expect(kids).toEqual(['paragraph', 'code_block', 'paragraph'])
    } finally {
      await b.destroy()
    }
  })

  it('`---` 分割线被挪到正文首行 → 按 `***` 写(拍板 #16)', async () => {
    const b = await bootEditor('para\n\n---\n\ntext\n')
    try {
      deleteTop(b, 0)
      expect(b.saved()).toBe('***\n\ntext\n')
    } finally {
      await b.destroy()
    }
  })

  it('删掉中间块后两只同符列表相邻 → 仍是两只', async () => {
    const b = await bootEditor('- a\n\npara\n\n- b\n')
    try {
      deleteTop(b, 1)
      const kids: string[] = []
      b.parse(b.saved()).forEach((n) => { kids.push(n.type.name) })
      expect(kids).toEqual(['bullet_list', 'bullet_list'])
    } finally {
      await b.destroy()
    }
  })

  it('缩进代码挪到列表后面 → 不被吸进列表项', async () => {
    const b = await bootEditor('- a\n\n<!-- -->\n\n    code\n')
    try {
      deleteTop(b, 1)
      const kids: string[] = []
      b.parse(b.saved()).forEach((n) => { kids.push(n.type.name) })
      expect(kids).toEqual(['bullet_list', 'code_block'])
    } finally {
      await b.destroy()
    }
  })

  it('外部只改了格式(PM 内容相同)→ 回灌收养后按新盘上文本写', async () => {
    const b = await bootEditor('| A | B |\n|---|---|\n| 1 | 2 |\n\npara\n')
    try {
      const next = b.parse('|A|B|\n|-|-|\n|1|2|\n\npara\n')
      adoptOrigins(b.view.state.doc, next)
      typeAfter(b, 'para')
      expect(b.saved()).toBe('|A|B|\n|-|-|\n|1|2|\n\nparaZ\n')
    } finally {
      await b.destroy()
    }
  })
})

// ── fuzz:逐字输出与规范输出重解析结构相等 ─────────────────────────────────────────
const POOL = [
  'plain para', 'snake_case and 5 * 3', '_em_ and __strong__', 'see https://x.com/a_b ok', 'go www.x.com now',
  '- a\n- b\n  - c', '* x\n* y', '+ p\n+ q', '1. a\n1. b', '1) o\n2) p', '- [ ] t\n- [X] d', '- a\n\n- b', '  - ind\n  - two',
  '| A | B |\n|---|:-:|\n| 1 | 2 |', 'Title\n=====', 'Sub\n---', '## h2', '~~~js\nx\n~~~', '```\ny\n```', '    code',
  '---', '___', '***', '<div>\nhi\n</div>', '<!-- c -->', '> q\n> r', '> [!note] T\n> body', '$$\nx^2\n$$',
  '[1]: http://x.example', 'see [a][1] and [b]', '[b]: http://b.example "t"', 'A[^n] note', '[^n]: foot',
  'hard  \nbreak', '<br>', '<!-- amadeus-indent:1 -->\n## ind', '```js\nopen',
]
const GAPS = ['\n\n', '\n\n', '\n\n', '\n\n\n', '\n\n\n\n', '\n']

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

/** 比较口径:去掉解析副产物(标题 id、链接的 ref 原引用形)与纯写法 attr(强调的 `_`/`*` 定界符 —— 逐字保留原写法
 *  正是本修复的目的)。live=true 再去掉现文档里的「落盘形」attr:列表的 bullet / spread(新建节点带缺省值)、
 *  段落的 raw(定义行被编辑后 raw 还挂着旧原文,重解析出来已是普通段落)。 */
function shape(doc: PMNode, live = false): string {
  const drop = (type: string): string[] =>
    type === 'heading' ? ['id'] : type === 'link' ? ['ref'] : type === 'emphasis' || type === 'strong' ? ['marker']
    : live && /list/.test(type) ? ['bullet', 'spread'] : live && type === 'paragraph' ? ['raw'] : []
  const strip = (j: any): any => {
    if (Array.isArray(j)) return j.map(strip)
    if (!j || typeof j !== 'object') return j
    const o: any = {}
    for (const [k, v] of Object.entries(j)) {
      if (k === 'attrs' && v && typeof v === 'object') {
        const rest: any = { ...(v as any) }
        for (const d of drop(j.type)) delete rest[d]
        o[k] = rest
        continue
      }
      o[k] = strip(v)
    }
    return o
  }
  return JSON.stringify(strip(doc.toJSON()))
}

describe('fuzz:逐字拼接不改变写出去的语义', () => {
  // 判据:逐字输出重解析 ≡ 今天规范输出的重解析(没变差),或 ≡ 编辑器里的现文档(比今天更忠实 —— 规范输出自己
  // 有已知的往返病,例如结构缩进标记与空行还原互咬,逐字写回原文反而绕开了它)。两边都不等 = 拼接改了语义。
  it('随机文档 × 随机编辑:parse(逐字) ≡ parse(规范) 或 ≡ 现文档', async () => {
    // 复现 / 加压:VERBATIM_SEED=<n> VERBATIM_ITERS=<n> npx vitest run …/verbatim.test.ts
    const r = rng(Number(process.env.VERBATIM_SEED ?? 20260928))
    const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]
    for (let iter = 0, iters = Number(process.env.VERBATIM_ITERS ?? 160); iter < iters; iter++) {
      const n = 2 + Math.floor(r() * 6)
      const blocks = Array.from({ length: n }, () => pick(POOL))
      // `<br>` 后只接空行:单换行会把下一块吞成以 `<br>` 起头的多行 HTML 块,而规范序列化的 stripEmptyLineBr 会抹掉那行
      // `<br>`、块型当场变掉(规范输出自己的老毛病,与逐字无关;逐字只会让没编辑的这种块原样保住)。
      let md = (r() < 0.2 ? '\n\n' : '') + blocks.map((x, i) => (i ? (blocks[i - 1] === '<br>' ? '\n\n' : pick(GAPS)) : '') + x).join('') + pick(['\n', '', '\n\n\n'])
      const b = await bootEditor(md)
      const ops: string[] = []
      try {
        const steps = 1 + Math.floor(r() * 3)
        for (let s = 0; s < steps; s++) {
          const doc = b.view.state.doc
          const k = Math.floor(r() * doc.childCount)
          const op = Math.floor(r() * 6)
          const schema = b.view.state.schema
          if (op === 0) {
            // 在第 k 块里打字
            let at = -1
            doc.child(k).descendants((c, p) => { if (at < 0 && c.isTextblock) at = topPos(doc, k) + 1 + p + 1 + c.content.size; return at < 0 })
            if (at < 0 && doc.child(k).isTextblock) at = topPos(doc, k) + 1 + doc.child(k).content.size
            if (at >= 0) { b.view.dispatch(b.view.state.tr.insertText('Q', at)); ops.push(`type@${k}`) }
          } else if (op === 1 && doc.childCount > 1) {
            deleteTop(b, k); ops.push(`del@${k}`)
          } else if (op === 2) {
            b.view.dispatch(b.view.state.tr.insert(topPos(doc, k), schema.nodes.paragraph.create(null, schema.text('new')))); ops.push(`ins@${k}`)
          } else if (op === 3 && doc.childCount > 2) {
            const node = doc.child(k)
            const tr = b.view.state.tr.delete(topPos(doc, k), topPos(doc, k) + node.nodeSize)
            const to = Math.floor(r() * tr.doc.childCount)
            tr.insert(topPos(tr.doc, to), node)
            b.view.dispatch(tr); ops.push(`move@${k}->${to}`)
          } else if (op === 4) {
            b.view.dispatch(b.view.state.tr.insert(topPos(doc, k), doc.child(k))); ops.push(`dup@${k}`)
          } else {
            const li = schema.nodes.list_item.create(null, schema.nodes.paragraph.create(null, schema.text('nl')))
            b.view.dispatch(b.view.state.tr.insert(topPos(doc, k), schema.nodes.bullet_list.create(null, li))); ops.push(`list@${k}`)
          }
        }
        b.view.dispatch(b.view.state.tr.setSelection(TextSelection.atStart(b.view.state.doc)))
        const canonical = b.md()
        const saved = b.saved()
        const ctx = `iter=${iter} ops=${ops.join(',')}\n--- 原文 ---\n${JSON.stringify(md)}\n--- 规范 ---\n${JSON.stringify(canonical)}\n--- 逐字 ---\n${JSON.stringify(saved)}`
        const reparsed = b.parse(saved)
        const recanon = b.parse(canonical)
        const live = b.view.state.doc
        // 整篇等于其一;或(去掉空段落 —— 空行条数是规范输出自己的老毛病,不是拼接引入的)与其中一边块数相同、逐块
        // 等于那一边的同位块或另一边的某一块(逐字修好了某些块、别的块仍带规范输出的旧病 —— 混合也合法)。
        // 两边块数都对不上 = 拼接把块并了 / 拆了 = 红。
        const solid = (d: PMNode): PMNode[] => { const o: PMNode[] = []; d.forEach((c) => { if (!(c.type.name === 'paragraph' && c.content.size === 0)) o.push(c) }); return o }
        const [rs, rc, lv] = [solid(reparsed), solid(recanon), solid(live)]
        const canonSet = new Set(rc.map((x) => shape(x)))
        const liveSet = new Set(lv.map((x) => shape(x, true)))
        const same = shape(reparsed) === shape(recanon) || shape(reparsed, true) === shape(live, true)
          || (rs.length === lv.length && rs.every((x, i) => shape(x, true) === shape(lv[i], true) || canonSet.has(shape(x))))
          || (rs.length === rc.length && rs.every((x, i) => shape(x) === shape(rc[i]) || liveSet.has(shape(x, true))))
        expect(same, `${ctx}\n--- 逐字重解析 ---\n${shape(reparsed, true)}\n--- 现文档 ---\n${shape(live, true)}`).toBe(true)
      } finally {
        await b.destroy()
      }
    }
  }, 120_000)
})
