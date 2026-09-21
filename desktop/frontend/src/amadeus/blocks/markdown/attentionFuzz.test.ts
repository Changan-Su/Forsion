// @vitest-environment happy-dom
//
// attention 落盘的「不比修复前更坏」闸:真 Milkdown(commonmark + gfm)里随机拼段落,
// 修复前生产(milkdown 自带 handler)能原样往返的,挂上 attentionSerializer 之后也必须能。
// 为什么要它:这一块三轮都是「单测全绿、换个形状就毁数据」(`&#xNAN;`、emoji→U+FFFD、`\&#x61;`),
// 全是 09-18 两万段 fuzz 揪出来的。这里是缩成 4000 段的确定性版本(同一种子,每次同一批,~2.5s)。
// 它只守「新形状的回归」(变异实测:关 NaN 守卫 / 空壳不递归都会红);每条修复本身由 attentionFlanking.test.ts 的
// 定向用例钉 —— 反斜杠那条 2 万段里才 9 例,4000 段不一定抽得到。
// 只用 `*` 定界:混 `_` 的已知天花板见 attentionFlanking.ts 的 guardSurrogate 注释与 09-18 日志。
import { expect, it } from 'vitest'
import { Editor, config, defaultValueCtx, parserCtx, remarkStringifyOptionsCtx, rootCtx, schemaCtx, serializerCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { attentionHandlers } from './attentionFlanking'

/* eslint-disable @typescript-eslint/no-explicit-any */
const withHandlers = (handlers: object) =>
  config((ctx) => {
    ctx.update(remarkStringifyOptionsCtx, (o: any) => ({ ...o, handlers: { ...o.handlers, ...handlers } }))
  })

async function boot(handlers: object) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const ed = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root)
      ctx.set(defaultValueCtx, 'x')
    })
    .use(commonmark)
    .use(gfm)
    .use(withHandlers(handlers))
    .create()
  return ed.action((ctx) => ({ schema: ctx.get(schemaCtx), ser: ctx.get(serializerCtx), par: ctx.get(parserCtx) }))
}

// mulberry32:确定性,跑多少次都是同一批段落。
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
// 字符池:字母/汉字/普通空格/NBSP/标点/定界符/反斜杠/emoji/换行 —— 每一类都对应过一条真实事故。
const CHARS = ['a', '甲', ' ', ' ', '。', '（', '*', '_', '~', '&', '1', '\u{1F600}', '!', '[', '\\', '\n']

function build(schema: any, rnd: () => number) {
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]
  const runs: any[] = []
  for (let i = 0, n = 1 + Math.floor(rnd() * 4); i < n; i++) {
    let text = ''
    for (let j = 0, len = 1 + Math.floor(rnd() * 3); j < len; j++) text += pick(CHARS)
    const marks: any[] = []
    if (rnd() < 0.3) marks.push(schema.marks.strong.create({ marker: '*' }))
    if (rnd() < 0.3) marks.push(schema.marks.emphasis.create({ marker: '*' }))
    if (rnd() < 0.3) marks.push(schema.marks.strike_through.create())
    text.split('\n').forEach((part, k) => {
      if (k > 0) runs.push(schema.nodes.hardbreak.create({ isInline: true }))
      if (part) runs.push(schema.text(part, marks))
    })
  }
  if (!runs.length) runs.push(schema.text('z'))
  return schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, runs)])
}

/** 往返签名:可见文字(忽略空白)+ 每个非空白字符身上的 mark。 */
function sig(doc: any): string {
  let out = ''
  doc.descendants((n: any) => {
    if (n.isText) {
      const ms = n.marks.map((m: any) => m.type.name).sort().join('+')
      for (const ch of n.text) if (!/\s/u.test(ch)) out += `${ch}[${ms}]`
    }
    return true
  })
  return out
}

async function roundTrips(handlers: object, count: number): Promise<boolean[]> {
  const { schema, ser, par } = await boot(handlers)
  const rnd = rng(4242)
  const ok: boolean[] = []
  for (let i = 0; i < count; i++) {
    const doc = build(schema, rnd)
    const md = ser(doc)
    ok.push(!/NAN|&#xD[89A-F][0-9A-F]{2};|&#xA;/i.test(md) && sig(par(md)) === sig(doc))
  }
  return ok
}

it('4000 段随机文档:修复前能往返的,修复后一段都不许坏', async () => {
  const N = 4000
  const before = await roundTrips({}, N) // = 修复前生产:milkdown 自带 handler + gfm delete
  const after = await roundTrips(attentionHandlers, N)
  const regressed = before.flatMap((ok, i) => (ok && !after[i] ? [i] : []))
  expect(regressed).toEqual([])
  // 顺带钉住它确实在修东西:这批里修复前坏、修复后好的 09-18 首版是 897 段,加上相邻/嵌套 `*` run 之后 1005 段。
  // 掉到 950 以下说明某条修复被关了(变异实测:关掉相邻 run 那条即跌破)。
  const fixed = before.filter((ok, i) => !ok && after[i]).length
  expect(fixed).toBeGreaterThan(950)
}, 60000)
