// 内置使用手册(amadeusManual.ts + assets/manual/*.md)的出口门 —— 钉的是**内容会悄悄烂**这一类故障:
//   · 改了中文那份忘了英文 → 英文用户拿到一份过期手册,不报错、不崩、没人看得见;
//   · 手册正文误带 frontmatter → classifyPageSource 判成 v3,打开即被 v3 管线改写;
//   · 代码围栏没闭合 → 后半篇整个塌进一个代码块;
//   · 加了新命令没写进手册 → 手册与产品脱节。
// 红了不要来这里加豁免,去补另一份 / 去补那一条。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyPageSource, parseV4Source } from '@amadeus-shared/compiler/v4'
import { __dictSnapshot } from './i18n'
import './i18n.generated'

const HAN = /[一-鿿]/
const read = (f: string): string => readFileSync(join(__dirname, 'assets/manual', f), 'utf8')
const ZH = read('amadeus-manual.zh.md')
const EN = read('amadeus-manual.en.md')

/** 英文手册里汉字的**唯一合法形态 = 被引的界面原文**:反引号 / 「」 / 直引号 / 弯引号里,或代码围栏里。
 *  产品里确实有一批没本地化的中文串(表头「列 1」、属性类型「修改时间」、主题名「琉璃」…),
 *  英文用户屏幕上看到的就是那几个字 —— 手册照抄比抹掉有用。但**正文本身必须是英文**,
 *  所以规则不是「不许有汉字」而是「汉字必须被引号圈起来」。裸露的汉字 = 漏翻,红。 */
const EN_QUOTED = /`[^`\n]*`|\[\[[^\]\n]*\]\]|「[^」\n]*」|"[^"\n]*"|\u201c[^\u201d\n]*\u201d/g

/** 去掉围栏代码块(整段照抄的样例,里面写什么都行)。 */
const stripFences = (md: string): string => {
  const out: string[] = []
  let fence = false
  for (const line of md.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) { fence = !fence; continue }
    if (!fence) out.push(line)
  }
  return out.join('\n')
}

const headings = (md: string): Array<{ level: number; text: string }> => {
  const out: Array<{ level: number; text: string }> = []
  let fence = false
  for (const line of md.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) { fence = !fence; continue }
    if (fence) continue
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line)
    if (m) out.push({ level: m[1].length, text: m[2] })
  }
  return out
}

describe('Amadeus 使用手册', () => {
  it('A. 两份 .md 素材是纯散文(零 frontmatter)—— 锚与几何由 manualSource() 现推,不写死在素材里', () => {
    expect(classifyPageSource(ZH)).toBe('v4-plain')
    expect(classifyPageSource(EN)).toBe('v4-plain')
    expect(ZH.startsWith('---')).toBe(false)
    expect(EN.startsWith('---')).toBe(false)
    // 素材里不该有**真锚**(手写一枚会与推出来的重号)。判据照抄解析器的规矩:锚必须独占一行 ——
    // ⚠️ 别用子串匹配:手册**正在讲**这套语法,正文里有反引号包着的 `<!-- a k1 -->` 是内容不是锚。
    const REAL_ANCHOR = /^<!--\s*\/?a\s+[A-Za-z0-9_-]+\s*-->$/m
    expect(REAL_ANCHOR.test(ZH), 'zh 素材里手写了锚').toBe(false)
    expect(REAL_ANCHOR.test(EN), 'en 素材里手写了锚').toBe(false)
  })

  it('B. 两份不是占位/空壳(手册被清空也算内容烂)', () => {
    for (const [name, md] of [['zh', ZH], ['en', EN]] as const) {
      expect(md.length, `${name} 手册过短`).toBeGreaterThan(8000)
      // ⚠️ 别把 'placeholder' 一词列进来:那是英文界面里真实存在的名词(输入框占位符),手册要讲它。
      expect(/\bTODO\b|\bFIXME\b|\bTBD\b|待补|^# placeholder$/im.test(md), `${name} 手册里还留着占位标记`).toBe(false)
    }
  })

  it('C. 章节骨架逐条一致(层级序列相同 = 改了一份忘了另一份必红)', () => {
    const z = headings(ZH).map((h) => h.level)
    const e = headings(EN).map((h) => h.level)
    expect(e, `标题层级序列不一致:zh ${z.length} 条 / en ${e.length} 条 —— 两份必须成对更新`).toEqual(z)
    expect(z.filter((l) => l === 1), '每份手册恰好一个 H1').toHaveLength(1)
  })

  it('D. 英文手册里的汉字只以「被引的界面原文」形态出现(裸汉字 = 漏翻)', () => {
    const bad = stripFences(EN)
      .split('\n')
      .map((l, i) => [i + 1, l.replace(EN_QUOTED, '')] as const)
      .filter(([, l]) => HAN.test(l))
    expect(bad.map(([n, l]) => `${n}: ${l.trim()}`), '英文手册里有没被引号圈起来的中文 —— 要么翻译它,要么用「」/反引号标成界面原文').toEqual([])
  })

  it('E. 代码围栏成对闭合(单数个 ``` = 后半篇整个塌进代码块)', () => {
    for (const [name, md] of [['zh', ZH], ['en', EN]] as const) {
      const fences = md.split('\n').filter((l) => /^\s*(?:```|~~~)/.test(l)).length
      expect(fences % 2, `${name} 手册的 \`\`\` 围栏是单数个`).toBe(0)
    }
  })

  it('F. 每条 Amadeus 命令都在手册里(加了命令没写进手册 = 手册与产品脱节)', () => {
    const src = readFileSync(join(__dirname, 'amadeusCommands.ts'), 'utf8')
    const keys = [...src.matchAll(/translate\('([\w.]+)'\)/g)].map((m) => m[1]).filter((k) => k.startsWith('amadeus.'))
    expect(keys.length, '一条命令都没解析出来 —— 仪器已失效,先修解析').toBeGreaterThanOrEqual(12)
    const dict = __dictSnapshot()
    const missZh = keys.filter((k) => !ZH.includes(dict.zh[k]))
    const missEn = keys.filter((k) => !EN.includes(dict.en[k]))
    expect(missZh, `中文手册缺这些命令:${missZh.map((k) => `${k}=${dict.zh[k]}`).join(' / ')}`).toEqual([])
    expect(missEn, `英文手册缺这些命令:${missEn.map((k) => `${k}=${dict.en[k]}`).join(' / ')}`).toEqual([])
  })
})

// ── 画布适配(2026-09-05 用户实报「Canvas 没适配」)────────────────────────────────────
// 手册没有卡片时,切到画布**不是空白而是一条极长的主卡条** —— 0 张卡、看着就是「画布没做」。
// 下面这组钉的是「章 → 节」那张导图确实被发射出来了,而且发射得合法。
// ⚠️ 在 describe **之外**编译:manualSource() 第一次要把 300KB+ 的 md 经 Vite 转换进来,
//    整套跑的时候这一下会超过单条用例 5s 的默认上限(实测)。模块级 await 不受那个上限管。
const COMPILED: Record<'zh' | 'en', string> = {
  zh: await (await import('./amadeusManual')).manualSource('zh'),
  en: await (await import('./amadeusManual')).manualSource('en'),
}

// 这一节每条都要在 300KB+ 的源码上跑 classify / parseV4Source;整套并行跑时机器饱和,
// 默认 5s 上限会假红(单跑 2.6s,整套跑超时)。显式放宽,别用「重跑一次就绿了」糊过去。
const CANVAS_T = 30_000

describe('Amadeus 使用手册 · 画布几何', () => {
  const load = async (l: 'zh' | 'en'): Promise<string> => COMPILED[l]

  it('G. 编译出来的是 v4 结构化文件,schema 与 canvas 键都在场', async () => {
    for (const l of ['zh', 'en'] as const) {
      const src = await load(l)
      expect(classifyPageSource(src), `${l}`).toBe('v4-structured')
      expect(/^amadeus_schema: amadeus\.page\/4$/m.test(src), `${l} 缺 schema 行`).toBe(true)
      expect(parseV4Source(src).canvas, `${l} 缺 canvas 行`).toBeTruthy()
    }
  }, CANVAS_T)

  it('H. 每枚锚开闭成对,且**全部在 cards 在册** —— 不在册的锚会以字面注释露在正文里', async () => {
    for (const l of ['zh', 'en'] as const) {
      const src = await load(l)
      const open = [...src.matchAll(/^<!--\s*a\s+([A-Za-z0-9_-]+)\s*-->$/gm)].map((m) => m[1])
      const close = [...src.matchAll(/^<!--\s*\/a\s+([A-Za-z0-9_-]+)\s*-->$/gm)].map((m) => m[1])
      const canvas = JSON.parse(parseV4Source(src).canvas as string)
      const refs = canvas.cards.map((c: { ref: string }) => c.ref)
      expect(open, `${l} 开闭锚不成对`).toEqual(close)
      expect([...refs].sort(), `${l} 锚与 cards 对不上`).toEqual([...open].sort())
      expect(new Set(refs).size, `${l} 有重号的 ref`).toBe(refs.length)
      expect(open.length, `${l} 卡太少 —— 19 章 + 138 节`).toBeGreaterThanOrEqual(19 + 100)
    }
  }, CANVAS_T)

  it('I. 层级 tree 的两端都在册(悬空父只会静默少一层,不报错),且每节都挂在自己那一章下', async () => {
    for (const l of ['zh', 'en'] as const) {
      const canvas = JSON.parse(parseV4Source(await load(l)).canvas as string)
      const refs: string[] = canvas.cards.map((c: { ref: string }) => c.ref)
      const bad = Object.entries(canvas.tree as Record<string, string>)
        .filter(([kid, pa]) => !refs.includes(kid) || !refs.includes(pa) || kid.split('_')[0] !== pa)
      expect(bad, `${l} 层级有悬空或挂错章的:${JSON.stringify(bad)}`).toEqual([])
      expect(Object.keys(canvas.tree).length, `${l} 一个子卡都没有`).toBeGreaterThan(100)
    }
  }, CANVAS_T)

  it('J. 章与章横向分带,章间重叠在构造上不可能;同章节列单调下移', async () => {
    for (const l of ['zh', 'en'] as const) {
      const canvas = JSON.parse(parseV4Source(await load(l)).canvas as string)
      const cards: Array<{ ref: string; x: number; y: number; w: number }> = canvas.cards
      const byCh = new Map<string, typeof cards>()
      for (const c of cards) {
        const ch = c.ref.split('_')[0]
        byCh.set(ch, [...(byCh.get(ch) ?? []), c])
      }
      // 每一章占一条独立的 x 区间
      const spans = [...byCh.values()].map((g) => [Math.min(...g.map((c) => c.x)), Math.max(...g.map((c) => c.x + c.w))])
      spans.sort((a, b) => a[0] - b[0])
      for (let i = 1; i < spans.length; i++) {
        expect(spans[i][0], `第 ${i + 1} 章的 x 区间与上一章相交`).toBeGreaterThanOrEqual(spans[i - 1][1])
      }
      // 同章内节列 y 严格递增(估高只影响间距,不该出现回退)
      for (const [ch, g] of byCh) {
        const ys = g.filter((c) => c.ref.includes('_')).map((c) => c.y)
        for (let i = 1; i < ys.length; i++) expect(ys[i], `${ch} 的节列 y 没有单调下移`).toBeGreaterThan(ys[i - 1])
      }
    }
  }, CANVAS_T)
})
