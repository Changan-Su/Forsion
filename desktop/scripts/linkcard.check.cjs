// 链接悬停卡 / 编辑面板的**几何 + 真指针**回归仪器(评审 2026-09-27 I-05,合并 P-06)。
//
// 病:`.amx-linkcard` / `.amx-linkedit` 两个类没写 position。OverlayAt(lcl/engine/menuAnchor.tsx)只给视口坐标
// left/top,定位方式归浮层自己的类 —— 漏了 fixed,卡片按静态流排到 `.am-app` 末尾(视口之外,鼠标一挪过去就收),
// 编辑面板的 z-index 不生效、被自己 z119 的遮罩盖住(一点输入框就关)。unified-page.check 那条只用 DOM click,
// 不看几何,所以一直绿着漏过去。这里全部走**真鼠标 / 真键盘 + elementFromPoint**。
//
// 断言(?upage 短文 与 &upane 长文 两套壳):
//   LC1 卡片 computed position=fixed、落在视口内、贴着链接下沿、elementFromPoint 命中卡片自己
//   LC2 真指针从链接挪进卡片,卡片不收
//   LC3 真鼠标点「编辑」→ 面板 fixed;链接输入框中心 elementFromPoint 命中输入框本身(不是遮罩);真点击后面板还在
//   LC4 改地址按 Enter 即保存(form 提交)→ 落盘带新地址;Esc 关闭面板且不写盘
//   LC5 页面滚动 → 卡片收起(fixed 坐标是悬停那一刻的,滚走了不能钉在原处)
//
// 用法:node scripts/e2e-editor.cjs --check=linkcard(或 npm run check:linkcard)
//      5173 被别的检出占着时:HARNESS_URL=http://localhost:<port>/harness.html
const fs = require('fs'), os = require('os'), path = require('path')
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
const SHOT = process.env.LINKCARD_SHOT_DIR || ''
const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function open(browser, md, flags) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  p.__errs = []
  p.on('pageerror', (e) => p.__errs.push(e.message))
  await p.goto(`${URL}?upage${flags}&useed=${encodeURIComponent(md)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await p.waitForSelector(PM, { timeout: 120000 })
  await p.waitForTimeout(500)
  return p
}
const linkRect = (p) => p.evaluate((s) => {
  const r = document.querySelector(s + ' a[href]').getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height, bottom: r.bottom }
}, PM)
const cardInfo = (p) => p.evaluate(() => {
  const c = document.querySelector('.amx-linkcard')
  if (!c) return null
  const r = c.getBoundingClientRect()
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  return { pos: getComputedStyle(c).position, x: r.left, y: r.top, w: r.width, h: r.height, inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth, hitSelf: !!hit?.closest('.amx-linkcard') }
})
const lastWrite = (p) => p.evaluate(() => { const w = window.__upage.writes; return w.length ? w[w.length - 1].text : null })
const writeCount = (p) => p.evaluate(() => window.__upage.writes.length)

/** 真鼠标悬停链接,等 500ms 出卡。 */
async function hoverLink(p) {
  const a = await linkRect(p)
  await p.mouse.move(a.x + a.w / 2, a.y + a.h / 2, { steps: 4 })
  await p.waitForTimeout(900)
  return a
}

async function shell(browser, label, md, flags) {
  const p = await open(browser, md, flags)
  const a = await hoverLink(p)
  const c = await cardInfo(p)
  check(`LC1 ${label} 卡片出现且 position=fixed`, !!c && c.pos === 'fixed', JSON.stringify(c))
  check(`LC1 ${label} 卡片在视口内、贴链接下沿`, !!c && c.inView && c.y >= a.bottom - 1 && c.y <= a.bottom + 24 && Math.abs(c.x - a.x) <= 24,
    JSON.stringify({ link: a, card: c && { x: c.x, y: c.y } }))
  check(`LC1 ${label} elementFromPoint 命中卡片自己`, !!c && c.hitSelf)
  if (SHOT && c) await p.screenshot({ path: path.join(SHOT, `linkcard-hover${flags.replace(/&/g, '_')}.png`) })
  if (!c) { await p.close(); return }
  // LC2 真指针挪进卡片
  await p.mouse.move(c.x + 20, c.y + c.h / 2, { steps: 12 })
  await p.waitForTimeout(450)
  check(`LC2 ${label} 真指针从链接挪进卡片,卡片不收`, !!(await cardInfo(p)))
  // LC3 真鼠标点「编辑」
  const btn = await p.evaluate(() => {
    const b = [...document.querySelectorAll('.amx-linkcard button')].find((x) => x.textContent === '编辑')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  if (!btn) { check(`LC3 ${label} 卡片上有「编辑」`, false); await p.close(); return }
  await p.mouse.click(btn.x, btn.y)
  await p.waitForTimeout(300)
  const ed = await p.evaluate(() => {
    const d = document.querySelector('.amx-linkedit')
    if (!d) return null
    const inp = d.querySelectorAll('input')[1]
    const r = inp.getBoundingClientRect()
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2
    return { pos: getComputedStyle(d).position, cx, cy, hitInput: document.elementFromPoint(cx, cy) === inp }
  })
  check(`LC3 ${label} 编辑面板 position=fixed 且链接输入框没被遮罩盖住`, !!ed && ed.pos === 'fixed' && ed.hitInput, JSON.stringify(ed))
  if (SHOT && ed) await p.screenshot({ path: path.join(SHOT, `linkcard-edit${flags.replace(/&/g, '_')}.png`) })
  if (!ed) { await p.close(); return }
  await p.mouse.click(ed.cx, ed.cy)
  await p.waitForTimeout(200)
  check(`LC3 ${label} 真点击链接输入框后面板还在`, !!(await p.$('.amx-linkedit')))
  // LC4 改地址 + Enter
  const before = await writeCount(p)
  await p.keyboard.press('Meta+a')
  await p.keyboard.type('https://new.example/x', { delay: 10 })
  await p.keyboard.press('Enter')
  await p.waitForTimeout(1400)
  const md1 = await lastWrite(p)
  check(`LC4 ${label} Enter 提交:面板关闭、落盘带新地址`, !(await p.$('.amx-linkedit')) && (await writeCount(p)) > before && /\]\(https:\/\/new\.example\/x\)/.test(md1 || ''),
    JSON.stringify((md1 || '').slice(0, 120)))
  // Esc:再开一次面板,按 Esc
  await p.mouse.move(5, 5)
  await p.waitForTimeout(400)
  await hoverLink(p)
  const btn2 = await p.evaluate(() => {
    const b = [...document.querySelectorAll('.amx-linkcard button')].find((x) => x.textContent === '编辑')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  if (btn2) {
    const card = await cardInfo(p)
    await p.mouse.move(card.x + 20, card.y + card.h / 2, { steps: 8 })
    await p.mouse.click(btn2.x, btn2.y)
    await p.waitForTimeout(250)
    const opened = !!(await p.$('.amx-linkedit'))
    const n0 = await writeCount(p)
    await p.keyboard.type('zz')
    await p.keyboard.press('Escape')
    await p.waitForTimeout(1300)
    check(`LC4 ${label} Esc 关闭面板且不写盘`, opened && !(await p.$('.amx-linkedit')) && (await writeCount(p)) === n0, `opened=${opened}`)
  } else check(`LC4 ${label} Esc 关闭面板且不写盘`, false, '第二次悬停没出卡')
  check(`LC ${label} pageerror=0`, p.__errs.length === 0, p.__errs.join(' | ').slice(0, 200))
  await p.close()
}

async function scrollCloses(browser) {
  const long = Array.from({ length: 40 }, (_, i) => `填充段 ${i}。`)
  // &upane = 生产壳(滚动盒是 .amx-pane);?upage 台架页本身滚不动,测不出。
  const p = await open(browser, ['# 标题', '段乙,带一个 [链接](https://example.com) 在这。', ...long].join('\n\n') + '\n', '&upane')
  const a = await hoverLink(p)
  const had = !!(await cardInfo(p))
  await p.mouse.wheel(0, 300)
  await p.waitForTimeout(400)
  check('LC5 &upane 滚动 → 卡片收起', had && !(await cardInfo(p)), `had=${had} link=${JSON.stringify(a)}`)
  await p.close()
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const short = '# T\n\n' + Array.from({ length: 3 }, (_, i) => `第${i}段 [链接${i}](https://example.com/${i}) 文字`).join('\n\n') + '\n'
  const long = '# T\n\n' + Array.from({ length: 40 }, (_, i) => `第${i}段 [链接${i}](https://example.com/${i}) 文字`).join('\n\n') + '\n'
  await shell(browser, '?upage 短文', short, '')
  await shell(browser, '&upane 长文', long, '&upane')
  await scrollCloses(browser)
  await browser.close()
  const pass = results.filter(Boolean).length
  console.log(`\n${pass}/${results.length} passed`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
