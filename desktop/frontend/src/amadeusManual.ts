/// <reference types="vite/client" />
/** 内置使用手册:一篇讲全 Amadeus 的参考文档,**中英各一份**同时落进用户的 vault。
 *
 *  与 amadeusTutorial 的分工:教程是「上手十分钟、边看边改」的第一站(文档/画布双模式示范);
 *  手册是「想查什么翻什么」的全量参考 —— 每个功能的入口、快捷键、与其他 Space 的联动都在里面。
 *
 *  ⚠️ 为什么正文不进 i18n 字典而是两个 .md 文件:
 *  1. 字典条目要过 `collectFragments` 的**括号配平扫描**(i18nCoverage.test),而手册正文里满是
 *     `{` `}`(代码样例、frontmatter 样例);配平一旦被吃错,整个片段解析失败、全文件的键报缺失。
 *  2. 正文里的反引号与 `${` 在模板串里各有转义规则,几万字手抄转义必错。
 *  .md 原样写、经 Vite `?raw` 内联(与 changelog.ts 同一手法),写的是什么落盘就是什么。
 *
 *  ⚠️ 两份**必须同时更新**:改了中文那份忘了英文,英文用户拿到的是一份过期手册 —— 不报错、不崩。
 *  amadeusManual.test.ts 钉住两份的章节骨架一致(标题数量与层级逐条比对),红了去补另一份。
 *
 *  ⚠️ 文件名是**标识而非文案**:它同时是 listPages 的比对键、readTextFile/writeTextFile 的路径、
 *  openNote 的目标,还落在用户磁盘上。所以中英两份用两个固定名字(而不是「跟随当前语言的一个名字」)——
 *  后者换一次语言就多生成一份、旧的那份再也认不出来。这与 TUTORIAL_PATH 同一条理由。
 */
import { compileV4 } from '@amadeus-shared/compiler/v4'
import { usePageStore } from '@amadeus/store/pageStore'
import { currentLocale, registerMessages, translate, type Locale } from './i18n'
import { openNote } from './amadeusNav'
import { seedNoteIfAbsent } from './amadeusSeedNote'

export const MANUAL_PATHS: Record<Locale, string> = {
  zh: 'Amadeus 使用手册.md',
  en: 'Amadeus User Manual.md',
}

registerMessages({
  'ammanual.toast.noVault': {
    zh: '请先打开一个笔记库(Vault),手册会生成到里面',
    en: 'Open a vault first — the manual is created inside it',
  },
  'ammanual.toast.failed': {
    zh: '手册生成失败:{err}',
    en: 'Could not create the manual: {err}',
  },
  'ammanual.toast.otherFailed': {
    zh: '{lang}版手册没能生成:{err}(这一份照常打开)',
    en: 'The {lang} copy of the manual could not be created: {err} (this one still opens)',
  },
})

/** 手册**同时兼容文档模式与画布模式**(2026-09-05 用户实报「Canvas 没适配」):
 *  磁盘上是一篇纯 markdown,但每一章、每一节各裹一枚卡锚,几何与层级进 `amadeus_canvas` 单键 ——
 *  文档模式从上往下读,画布模式摊成一张「章 → 节」的思维导图。
 *
 *  ⚠️ 没有卡的长笔记切到画布**不是空白而是一条极长的主卡条**(实测:0 张卡、25% 缩放下一条竖条),
 *  用户看到的就是「画布没做」。长文要么别给画布入口,要么就把结构摊出来 —— 这里选后者。
 *
 *  ⚠️ 锚与几何**从标题现推**,不写死在 .md 里:两份 .md 保持纯散文(谁都能直接编辑),
 *  加一章删一节,画布跟着变。写死一份坐标表迟早与正文对不上,而对不上的表现是
 *  「正文里露出 `<!-- a c7 -->` 字面」—— 因为 foldCanvas 只认**在册**的锚(canvas.ts 的 `cards`)。
 *  ⚠️ frontmatter 一律走 compileV4 发射,绝不手写(结构键的判据与顺序只有那一份真源)。 */
/** 卡片宽度。⚠️ 2026-09-05 试过加宽到 1100 想让卡矮一半、排得紧一点:**没用**,
 *  最陡的那张(c12_s4,表格 + 列表混排)照样压住下一张,而且英文那轮渲染慢到台架数到 0 张卡。
 *  高度的方差来自表格行与列表项,不来自换行 —— 加宽治不了它。维持 620。 */
const CARD_W = 620
/** 章与章之间横向分带 —— **不同章的卡永远落在不同的 x 区间,章间重叠在构造上就不可能**。
 *  只有同一章内部的节列要靠高度估算,估歪了由 check:manual 的重叠断言当场报出来。 */
const CH_DX = 1560
/** 节列相对本章卡的横向偏移。 */
const SEC_DX = 720

/** 卡片高度估算(px)。只用于**排版避让**,卡片实际高度是内容自适应(`h` 省略)。
 *  **宽估不窄估**:估短了卡片糊在一起,估长了只是画布上多几片空白 —— 无限画布上空白不要钱。
 *
 *  每源行 50px 这个数是**实测标定的**,不是拍的:把两份手册在真画布上渲染出来量 138 张节卡,
 *  实际高度 / 源行数 中位数 ≈ 21、p95 ≈ 28、**最大 ≈ 45**(表格行与列表项每条都比一行正文高)。
 *  取 35 时恰好只有最陡的那一张(c12_s4)压住下一张 —— 那次重叠就是 check:manual 的 M6 报出来的。
 *  改这里之后跑 `npm run check:manual`,重叠断言会当场告诉你够不够。 */
const PX_PER_SOURCE_LINE = 50
function estimateHeight(md: string, locale: Locale): number {
  const perLine = locale === 'en' ? 62 : 30 // CARD_W 下一行大致容得下的字符数(随 CARD_W 一起改)
  let lines = 0
  for (const line of md.split('\n')) lines += Math.max(1, Math.ceil(line.length / perLine))
  return 160 + lines * PX_PER_SOURCE_LINE
}

/** 把手册正文切成「章 → 节」。围栏内的 `#` 不算标题(代码样例里满是它)。 */
function splitChapters(md: string): { preamble: string; chapters: Array<{ head: string; sections: string[] }> } {
  const lines = md.split('\n')
  const pre: string[] = []
  const chapters: Array<{ head: string[]; sections: string[][] }> = []
  let fence = false
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) fence = !fence
    if (!fence && /^## /.test(line)) { chapters.push({ head: [line], sections: [] }); continue }
    if (!fence && /^### /.test(line) && chapters.length) { chapters[chapters.length - 1].sections.push([line]); continue }
    const cur = chapters[chapters.length - 1]
    if (!cur) { pre.push(line); continue }
    ;(cur.sections.length ? cur.sections[cur.sections.length - 1] : cur.head).push(line)
  }
  const join = (a: string[]): string => a.join('\n').trim()
  return {
    preamble: join(pre),
    chapters: chapters.map((c) => ({ head: join(c.head), sections: c.sections.map(join) })),
  }
}

/** 手册正文 + 画布几何。
 *  ⚠️ 动态 import:手册正文有几万字,静态 import 会把它压进启动那一坨 chunk(命令面板在启动即注册)。 */
export async function manualSource(locale: Locale): Promise<string> {
  const raw = locale === 'en'
    ? (await import('./assets/manual/amadeus-manual.en.md?raw')).default
    : (await import('./assets/manual/amadeus-manual.zh.md?raw')).default
  const md = raw.replace(/\r\n/g, '\n').replace(/\s*$/, '\n')
  const { preamble, chapters } = splitChapters(md)

  const cards: Array<{ ref: string; x: number; y: number; w: number }> = []
  const tree: Record<string, string> = {}
  const blocks: string[] = []
  const wrap = (ref: string, text: string): string => `<!-- a ${ref} -->\n\n${text}\n\n<!-- /a ${ref} -->`

  chapters.forEach((ch, i) => {
    const chRef = `c${i + 1}`
    const x = i * CH_DX
    cards.push({ ref: chRef, x, y: 0, w: CARD_W })
    blocks.push(wrap(chRef, ch.head))
    let y = 0
    ch.sections.forEach((sec, j) => {
      const secRef = `${chRef}_s${j + 1}`
      cards.push({ ref: secRef, x: x + SEC_DX, y, w: CARD_W })
      tree[secRef] = chRef
      blocks.push(wrap(secRef, sec))
      y += estimateHeight(sec, locale) + 80 // 80 = 节与节之间的留白
    })
  })

  const canvas = {
    v: 1,
    mode: 'doc', // 缺省当文档读:手册首先是从上往下查的参考,画布是另一种看法(第 6 章讲怎么切)
    main: { x: -900, y: 0, w: 720 }, // 未入卡的只剩开篇与目录,摆在整条章链的左边当封面
    cards,
    tree,
  }
  return compileV4({
    kind: 'structured',
    fmExtra: '',
    layout: null,
    canvas: JSON.stringify(canvas),
    body: [preamble, ...blocks].join('\n\n'),
  })
}

/** 打开手册:两份都没有就都生成,已有的原样不动(**绝不覆盖** —— 用户在上面改的东西就是他的笔记了),
 *  再打开当前界面语言的那一份。
 *  ⚠️ 两处都得出声:没开 vault、写盘失败 —— 命令面板点一下什么都不发生是本仓反复栽的那种「静默失败」。 */
export async function openManual(): Promise<void> {
  const toast = (text: string, error = false): void => {
    window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text, error } }))
  }
  const ps = usePageStore.getState()
  if (!ps.vaultRoot) {
    toast(translate('ammanual.toast.noVault'))
    return
  }
  const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
  const locale = currentLocale()
  const other: Locale = locale === 'zh' ? 'en' : 'zh'
  // ⚠️ 两份**分开 try**(Codex 09-05):合在一起的话,另一份写失败会在 catch 里 return,
  //    连手上这份已经躺在盘上的都打不开了 —— 用户点了「打开使用手册」什么都不发生。
  try {
    if (await seedNoteIfAbsent(MANUAL_PATHS[locale], await manualSource(locale))) await ps.refreshPages()
  } catch (e) {
    toast(translate('ammanual.toast.failed', { err: msg(e) }), true)
    return // 手上这份都没有,没什么可打开的
  }
  // 另一份是「顺带也放一份」(用户提:放两份)。它失败不拦着看手册,但也不许静默 ——
  // 「说好两份只出来一份」不出声的话,用户永远不知道少了什么。
  try {
    if (await seedNoteIfAbsent(MANUAL_PATHS[other], await manualSource(other))) await ps.refreshPages()
  } catch (e) {
    toast(translate('ammanual.toast.otherFailed', { lang: translate(`locale.${other}`), err: msg(e) }), true)
  }
  await openNote(MANUAL_PATHS[locale])
}
