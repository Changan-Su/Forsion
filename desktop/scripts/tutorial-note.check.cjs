// 内置使用教程(amadeusTutorial.ts)的出口门:它是**内容**,而内容会悄悄烂 ——
// 少一个闭合锚、卡没在册、fm 键写歪,用户第一次打开看到的就是一篇露着 `<!-- a t1 -->` 的破笔记。
// 用法:npm run check:tutorial(加 --shot 顺便存两张截图,交付前照 DESIGN.md §8 自查观感)
//
// ⚠️ 源码从**页面里** import 真模块拿(不在 node 侧另抄一份):教程的真源只有 amadeusTutorial.ts,
//    node 侧重打一遍就等于测自己抄得像不像。
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

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const SHOT = process.argv.includes('--shot')
const SHOT_DIR = process.env.SHOT_DIR || os.tmpdir()
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage&upane&useed=x`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector(PM, { timeout: 20000 })
  const src = await p.evaluate(async () => (await import('/src/amadeusTutorial.ts')).tutorialSource())
  const fmLine = (/^amadeus_canvas:\s*(.*)$/m.exec(src) || [])[1] ?? null
  let canvas = null
  try { canvas = JSON.parse(fmLine) } catch { /* null */ }
  const anchors = [...src.matchAll(/^<!--\s*a\s+([A-Za-z0-9_-]+)\s*-->$/gm)].map((m) => m[1])
  const closers = [...src.matchAll(/^<!--\s*\/a\s+([A-Za-z0-9_-]+)\s*-->$/gm)].map((m) => m[1])
  const refs = (canvas?.cards ?? []).map((c) => c.ref)
  record('T1 源码形态:schema 行在场、canvas 行可解析、每张卡开闭锚成对、锚与 cards 在册一一对应',
    /^amadeus_schema:/m.test(src) && !!canvas && canvas.v === 1
      && anchors.length > 0 && JSON.stringify(anchors) === JSON.stringify(closers)
      && JSON.stringify([...refs].sort()) === JSON.stringify([...anchors].sort()),
    JSON.stringify({ anchors: anchors.length, refs: refs.length, mode: canvas?.mode, tree: Object.keys(canvas?.tree ?? {}).length }))
  // 层级只许指向在册的卡(指到不存在的锚 = 界面上那一档缩进/框永远不出现,还没人报错)。
  const treeOk = Object.entries(canvas?.tree ?? {}).every(([c, pa]) => refs.includes(c) && refs.includes(pa))
  record('T2 层级 tree 的两端都在册(悬空父只会静默少一层缩进,不报错)', treeOk, JSON.stringify(canvas?.tree ?? {}))

  await p.goto(`${URL}?upage&upane&useed=${encodeURIComponent(src)}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector(PM, { timeout: 20000 })
  await p.waitForTimeout(1200)
  const doc = await p.evaluate(() => ({
    cards: [...document.querySelectorAll('.amx-ucard')].map((c) => c.dataset.anchor),
    child: [...document.querySelectorAll('.amx-ucard')].filter((c) => c.className.includes('amx-card-child')).map((c) => c.dataset.anchor),
    raw: (document.querySelector('.unified-body .ProseMirror')?.innerText ?? '').includes('<!-- a '),
    stageOff: document.querySelector('.amx-stage')?.classList.contains('amx-stage-off') ?? null,
    h1: document.querySelector('.unified-body .ProseMirror h1')?.textContent ?? '',
    todo: document.querySelectorAll('li[data-item-type="task"]').length,
  }))
  record('T3 文档模式:每张卡都折出来、子卡带缩进档、正文里零锚字面、开篇有标题与动手区待办',
    JSON.stringify(doc.cards) === JSON.stringify(anchors)
      && doc.child.length === Object.keys(canvas?.tree ?? {}).length
      && !doc.raw && doc.stageOff === true && !!doc.h1 && doc.todo >= 1,
    JSON.stringify(doc))
  if (SHOT) await p.screenshot({ path: path.join(SHOT_DIR, 'tutorial-doc.png') })

  // 打一个字 → 派生一次:教程的 canvas 行必须**逐字不变**(卡片几何/层级不许被首次编辑吃掉)。
  const before = await p.evaluate(() => {
    window.__upage.probe.flush?.()
    return (/^amadeus_canvas:\s*(.*)$/m.exec(window.__upage.probe.fmState?.().fm ?? '') || [])[1] ?? null
  })
  await p.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard[data-anchor] p')][0]
    const r = document.createRange()
    r.selectNodeContents(el)
    r.collapse(false)
    const s = window.getSelection()
    s.removeAllRanges()
    s.addRange(r)
  })
  await p.keyboard.type('改')
  await p.waitForTimeout(900)
  const after = await p.evaluate(() => {
    window.__upage.probe.flush?.()
    return (/^amadeus_canvas:\s*(.*)$/m.exec(window.__upage.probe.fmState?.().fm ?? '') || [])[1] ?? null
  })
  record('T4 编辑一次后 canvas 行逐字不变(几何与层级不被首次编辑吃掉)', !!before && before === after,
    JSON.stringify({ before: (before ?? '').slice(0, 80), same: before === after }))

  // 画布模式:卡全在、层级线数 == tree 条数。
  const seg = await p.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent ?? '').trim() === '画布')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  if (seg) await p.mouse.click(seg.x, seg.y)
  await p.waitForTimeout(900)
  const cv = await p.evaluate(() => ({
    on: !document.querySelector('.amx-stage')?.classList.contains('amx-stage-off'),
    cards: document.querySelectorAll('.amx-ucard').length,
    lines: document.querySelectorAll('.amx-el-conn.is-tree').length,
    overlap: (() => { // 卡片两两不重叠:摆位是手写坐标,加卡时最容易压在一起
      const bs = [...document.querySelectorAll('.amx-ucard')].map((c) => ({
        x: Number(c.dataset.x), y: Number(c.dataset.y), w: c.offsetWidth, h: c.offsetHeight,
      }))
      for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], b = bs[j]
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return `${i}x${j}`
      }
      return null
    })(),
  }))
  record('T5 画布模式:卡片全在、层级线条数 == tree 条数、卡片两两不重叠',
    cv.on && cv.cards === anchors.length && cv.lines === Object.keys(canvas?.tree ?? {}).length && cv.overlap === null,
    JSON.stringify(cv))
  if (SHOT) await p.screenshot({ path: path.join(SHOT_DIR, 'tutorial-canvas.png') })
  await browser.close()
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  console.log('SKIP  openTutorial() 的落盘链(readTextFile → writeTextFile → refreshPages → openNote):台架无 vault 后端,真机点验')
  process.exit(ok === results.length ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
