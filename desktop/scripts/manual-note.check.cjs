// 内置使用手册(amadeusManual.ts + assets/manual/*.md)的**渲染**出口门。
// amadeusManual.test.ts 已经钉住了源码形态(素文件 / 骨架对称 / 围栏 / 命令齐全),那是文本层;
// 这里钉的是另一半:这么长一篇(中文 ~120KB、英文 ~310KB)在**真编辑器**里到底能不能打开、
// 打开要多久、表格与标注有没有塌成源码。内容类交付「断言全绿 ≠ 看起来对」,故 --shot 存图自查。
//
// 用法:npm run check:manual(加 --shot 存两张截图,照 DESIGN.md §8 交付前自查观感)
// ⚠️ 正文从**页面里** import 真模块拿(不在 node 侧另读一份 .md):真源只有那两个 .md,
//    node 侧重读一遍就等于测自己抄得像不像。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const URL_ = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const SHOT = process.argv.includes('--shot')
const SHOT_DIR = process.env.SHOT_DIR || os.tmpdir()
// 打开一篇长文的上限。定在 12s 是「人还能忍」的量级,不是性能目标 —— 越线说明手册长到该拆章了。
const OPEN_BUDGET_MS = 12000
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL_}?upage&upane&useed=x`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector(PM, { timeout: 20000 })

  const src = await p.evaluate(async () => {
    const m = await import('/src/amadeusManual.ts')
    return { zh: await m.manualSource('zh'), en: await m.manualSource('en'), paths: m.MANUAL_PATHS }
  })

  // M1 源码形态:v4 结构化(schema + canvas 成对在场),两个不同的文件名。
  // 结构键的发射判据是「schema 在场 ⟺ 分栏或画布任一在场」—— 剥了 schema 却留着 canvas 行的半吊子
  // 文件会被 classifyPageSource 判成 v3,拽进 v3 管线连正文带画布一起改写。
  const structured = (s) =>
    /^amadeus_schema: amadeus\.page\/4$/m.test(s) && /^amadeus_canvas: /m.test(s) && s.startsWith('---\n')
  record('M1 中英两份都是 v4 结构化文件(schema 与 canvas 成对),且是两个不同的文件名',
    structured(src.zh) && structured(src.en) && src.paths.zh !== src.paths.en && /\.md$/.test(src.paths.zh) && /\.md$/.test(src.paths.en),
    JSON.stringify({ zh: src.paths.zh, en: src.paths.en, zhKB: (src.zh.length / 1024) | 0, enKB: (src.en.length / 1024) | 0 }))

  // M2 骨架:一个 H1、19 个 H2,两份逐条同构(文本层已由 vitest 钉,这里只做一道廉价复核)。
  // ⚠️ 必须跳过围栏内部(``` 与 ~~~ 两种):代码样例里的 `# 注释` 不是标题,算进来骨架就错了。
  const FENCE = /^\s*(?:```|~~~)/
  /** 去掉 v4 结构键那段 frontmatter —— 下面所有「按标题取」的逻辑都只认正文。
   *  ⚠️ 漏了这一步,`split('\n',1)[0]` 拿到的是 `---` 而不是 H1(2026-09-05 踩过,表现是等一个永不为真的条件)。 */
  //    compileV4 发的是 `fm + '\n\n' + body`,所以剥完还要 trimStart —— 不然首行是空串,同样等不到。
  const bodyOf = (s) => s.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^\s+/, '')
  const outsideFences = (s) => {
    const out = []
    let fence = false
    for (const l of s.split('\n')) {
      if (FENCE.test(l)) { fence = !fence; continue }
      if (!fence) out.push(l)
    }
    return out
  }
  const skel = (s) => outsideFences(bodyOf(s)).filter((l) => /^#{1,6} /.test(l)).map((l) => l.match(/^#+/)[0].length)
  record('M2 两份标题层级序列一致,且恰好一个 H1 / 19 个 H2',
    JSON.stringify(skel(src.zh)) === JSON.stringify(skel(src.en))
      && skel(src.zh).filter((l) => l === 1).length === 1
      && skel(src.zh).filter((l) => l === 2).length === 19,
    JSON.stringify({ h: skel(src.zh).length, h2: skel(src.zh).filter((l) => l === 2).length }))

  for (const lang of ['zh', 'en']) {
    // ⚠️ 必须等**这门语言自己的 H1**,不能等「有 19 个 H2」:上一轮的文档还挂在那儿时后者立刻为真,
    //    第二轮于是量的是第一轮的 DOM(实测 12ms 通过 —— 典型假绿)。文件名也一并换掉。
    const h1 = bodyOf(src[lang]).split('\n', 1)[0].replace(/^#\s*/, '')
    // 全篇最后一个 H3 必须也渲染出来 —— 围栏漏闭合会把它之后的整片吞进代码块,这是那种事故的直接信号。
    const lastH3 = outsideFences(bodyOf(src[lang])).filter((l) => /^### /.test(l)).pop().replace(/^###\s*/, '').trim()
    const t0 = Date.now()
    await p.evaluate(([path_, md]) => window.__upage.switchFile(path_, md), [`Manual-${lang}.md`, src[lang]])
    await p.waitForFunction(
      (want) => document.querySelector('.unified-body .ProseMirror h1')?.textContent?.trim() === want
        && document.querySelectorAll('.unified-body .ProseMirror h2').length >= 19,
      h1,
      { timeout: OPEN_BUDGET_MS + 8000 },
    ).catch(async (e) => {
      const d = await p.evaluate(() => {
        const pm = document.querySelector('.unified-body .ProseMirror')
        return {
          h1: pm?.querySelector('h1')?.textContent?.slice(0, 40) ?? null,
          h2: pm?.querySelectorAll('h2').length ?? 0,
          cards: document.querySelectorAll('.amx-ucard').length,
          head: (pm?.innerText ?? '').slice(0, 200),
        }
      })
      console.log('[diag]', JSON.stringify(d))
      throw e
    })
    const ms = Date.now() - t0
    const dom = await p.evaluate(() => {
      const pm = document.querySelector('.unified-body .ProseMirror')
      const txt = pm?.innerText ?? ''
      return {
        h1: pm?.querySelectorAll('h1').length ?? 0,
        h2: pm?.querySelectorAll('h2').length ?? 0,
        h3: pm?.querySelectorAll('h3').length ?? 0,
        tables: pm?.querySelectorAll('table').length ?? 0,
        rows: pm?.querySelectorAll('table tr').length ?? 0,
        callouts: pm?.querySelectorAll('.callout').length ?? 0,
        todo: pm?.querySelectorAll('li[data-item-type="task"]').length ?? 0,
        code: pm?.querySelectorAll('pre').length ?? 0,
        // 源码泄漏:表格没被解析就会留下一行行 `|---|`。
        // ⚠️ 别拿「innerText 里有 ``` 开头的行」当围栏泄漏的判据 —— 手册**正在讲**围栏语法,
        //    表格里那格行内代码渲染出来就是 "``` + 空格",恒红(2026-09-05 踩过)。
        rawPipe: /^\s*\|\s*-{2,}/m.test(txt),
        lastH3: [...(pm?.querySelectorAll('h3') ?? [])].pop()?.textContent?.trim() ?? '',
      }
    })
    record(`M3-${lang} 真编辑器里渲染成结构而不是源码(表格/标注/待办/代码块都立起来了)`,
      dom.h1 === 1 && dom.h2 === 19 && dom.h3 >= 100 && dom.tables >= 30 && dom.callouts >= 20
        && dom.todo >= 1 && dom.code >= 1 && !dom.rawPipe && dom.lastH3 === lastH3,
      JSON.stringify({ ...dom, wantLastH3: lastH3 }))
    record(`M4-${lang} 打开耗时在预算内(越线 = 手册长到该拆章了)`, ms <= OPEN_BUDGET_MS, `${ms}ms / ${OPEN_BUDGET_MS}ms`)
    if (SHOT) {
      await p.screenshot({ path: path.join(SHOT_DIR, `manual-${lang}-top.png`) })
      await p.evaluate(() => document.querySelector('.unified-body .ProseMirror table')?.scrollIntoView({ block: 'center' }))
      await p.waitForTimeout(300)
      await p.screenshot({ path: path.join(SHOT_DIR, `manual-${lang}-table.png`) })
    }

    // ── 画布模式(2026-09-05 用户实报「Canvas 没适配」)────────────────────────────────
    // 没有卡的长笔记切过去**不是空白而是一条极长的主卡条**:0 张卡、看着就是「画布没做」。
    // 所以这里量的第一件事就是 cards > 0,第二件是它们没糊在一起。
    const segOk = await p.evaluate(() => {
      const bs = [...document.querySelectorAll('.amx-modeseg button')]
      if (bs.length < 2) return false
      bs[1].click()
      return true
    })
    record(`M5-${lang} 顶栏「文档 / 画布」胶囊在场并且能切过去`, segOk)
    await p.waitForFunction(() => {
      const s = document.querySelector('.amx-stage')
      return !!s && !s.classList.contains('amx-stage-off') && document.querySelectorAll('.amx-ucard').length > 0
    }, { timeout: 20000 }).catch(() => {})
    await p.waitForTimeout(600)
    const cv = await p.evaluate(() => {
      const stage = document.querySelector('.amx-stage')
      const cards = [...document.querySelectorAll('.amx-ucard')]
      // 重叠按**舞台坐标**判,不按屏幕矩形:屏幕上被裁掉的卡拿不到有效 rect,漏判就是假绿。
      const box = cards.map((c) => {
        const cs = getComputedStyle(c)
        const num = (v) => parseFloat(cs.getPropertyValue(v)) || 0
        return { ref: c.dataset.anchor, x: num('--amx-x'), y: num('--amx-y'), w: num('--amx-w'), h: c.offsetHeight }
      }).filter((b) => b.w > 0 && b.h > 0)
      let overlap = null
      for (let i = 0; i < box.length && !overlap; i++)
        for (let j = i + 1; j < box.length; j++) {
          const a = box[i], b = box[j]
          if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) { overlap = [a.ref, b.ref]; break }
        }
      return {
        stageOn: !!stage && !stage.classList.contains('amx-stage-off'),
        cards: cards.length,
        measured: box.length,
        lines: document.querySelectorAll('.amx-tree-line, .amx-stage-inner path').length,
        rawAnchor: (document.querySelector('.unified-body .ProseMirror')?.innerText ?? '').includes('<!-- a c1 -->'),
        overlap,
      }
    })
    record(`M6-${lang} 画布模式:章卡与节卡全部立起来、正文里零锚字面、两两不重叠`,
      cv.stageOn && cv.cards >= 19 + 100 && cv.measured === cv.cards && !cv.rawAnchor && cv.overlap === null,
      JSON.stringify(cv))
    if (SHOT) {
      await p.screenshot({ path: path.join(SHOT_DIR, `manual-${lang}-canvas.png`) })
      // 「适应内容」再来一张:随机 25% 视窗看不出整张导图排得好不好,交付前要看的是这一张。
      await p.evaluate(() => {
        const b = [...document.querySelectorAll('.amx-stage-hud button')].find((x) => /适应内容|Fit to content/.test(x.title ?? ''))
        b?.click()
      })
      await p.waitForTimeout(900)
      await p.screenshot({ path: path.join(SHOT_DIR, `manual-${lang}-canvas-fit.png`) })
      // 再点缩略图的左上角把视野挪到导图起点 —— 「适应内容」会被 25% 的缩放下限卡住(整张图比
      // 一屏大得多),落点是正中央,截出来看不出「章 → 节」的结构。
      const mm = await p.$('.amx-stage-minimap')
      if (mm) {
        const b = await mm.boundingBox()
        if (b) await p.mouse.click(b.x + b.width * 0.06, b.y + b.height * 0.12)
        await p.waitForTimeout(700)
        await p.screenshot({ path: path.join(SHOT_DIR, `manual-${lang}-canvas-head.png`) })
      }
    }
    // 切回文档,不影响下一轮
    await p.evaluate(() => { const bs = [...document.querySelectorAll('.amx-modeseg button')]; bs[0]?.click() })
    await p.waitForTimeout(400)
  }

  await browser.close()
  const bad = results.filter((r) => !r).length
  console.log(`\n${results.length - bad}/${results.length} 通过`)
  if (SHOT) console.log(`截图: ${SHOT_DIR}`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
