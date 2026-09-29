// 封面「调整位置」拖动(评审 2026-09-27 C-11)。
//  旧病:按框高换算 Δ% 且符号反了 —— 图片与手反向,16:9 约 1.3 倍、1:2 甩出框外、3:1 只有 0.37 倍;松手在 setState 的
//  updater 里调父级 setY,React 报「Cannot update a component while rendering a different component」。
//  现在:object-position Y% 的语义是「纵向余量(画出来的高 − 框高)的百分之几落在上方」,Δ% = −Δpx / 余量 × 100 → 图片跟手 1:1。
//  R1 三种比例(1:2 竖图 / 16:9 / 3:1 宽幅):指针下移 30px → 图片内容下移 30px(±1),松手落盘的 cover_y 与拖动末值一致
//  R2 整个拖动 + 松手过程零 React 警告
//  R3 比框还扁的图(10:1)没有纵向余量 → 不给「调整位置」按钮
// 用法:npm run check:coverrepo(= node scripts/e2e-editor.cjs --check=cover-reposition;worktree 里设 HARNESS_URL)
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
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function makeImg(b, w, h) {
  const gen = await b.newPage()
  const b64 = await gen.evaluate(([w, h]) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h
    const g = c.getContext('2d'); g.fillStyle = '#f2c94c'; g.fillRect(0, 0, w, h)
    return c.toDataURL('image/png').split(',')[1]
  }, [w, h])
  await gen.close()
  return Buffer.from(b64, 'base64')
}

/** 图片内容此刻在框里的纵向偏移(px,负 = 上移):object-fit:cover + object-position Y% 的定义式,按渲染实值算。 */
const contentTop = (page) => page.evaluate(() => {
  const img = document.querySelector('.amx-cover img')
  const nw = img.naturalWidth, nh = img.naturalHeight, bw = img.clientWidth, bh = img.clientHeight
  const drawn = nh * Math.max(bw / nw, bh / nh)
  const y = parseFloat(getComputedStyle(img).objectPosition.split(' ')[1])
  return { top: (bh - drawn) * y / 100, y }
})

async function openCover(b, w, h) {
  const png = await makeImg(b, w, h)
  const md = '---\ncover: https://cover.test/c.png\n---\n# 标题\n\n正文。\n'
  const page = await b.newPage({ viewport: { width: 1200, height: 800 }, locale: 'zh-CN' })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
  await page.route('https://cover.test/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: png }))
  await page.goto(`${URL}?upage&upane&useed=${encodeURIComponent(md)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.amx-cover img', { timeout: 120000 })
  await page.waitForFunction(() => document.querySelector('.amx-cover img').naturalWidth > 0)
  await page.waitForTimeout(400)
  await page.hover('.amx-cover')
  await page.waitForTimeout(150)
  return { page, errors }
}

async function drag(b, w, h) {
  const { page, errors } = await openCover(b, w, h)
  await page.locator('.amx-cover-tools button', { hasText: '调整位置' }).click()
  await page.waitForTimeout(150)
  const box = await page.evaluate(() => { const r = document.querySelector('.amx-cover img').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })
  const t0 = await contentTop(page)
  const sx = box.x + box.w * 0.4, sy = box.y + box.h * 0.35
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(sx, sy + 30, { steps: 6 })
  await page.waitForTimeout(120)
  const t1 = await contentTop(page)
  await page.mouse.up()
  await page.waitForTimeout(1300)
  const disk = await page.evaluate(() => { const ws = window.__upage.writes; const m = ws.length ? ws[ws.length - 1].text.match(/^cover_y: (.*)$/m) : null; return m ? parseFloat(m[1]) : null })
  await page.close()
  return { ratio: `${w}x${h}`, dMove: +(t1.top - t0.top).toFixed(1), yDrag: +t1.y.toFixed(1), disk, errors: errors.length }
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const rs = []
    for (const [w, h] of [[800, 1600], [1600, 900], [3000, 1000]]) rs.push(await drag(browser, w, h))
    record('R1 三种比例:指针下移 30px → 图片内容跟手下移 30px,落盘 cover_y = 拖动末值',
      rs.every((r) => Math.abs(r.dMove - 30) <= 1 && r.disk != null && Math.abs(r.disk - r.yDrag) <= 0.1), JSON.stringify(rs))
    record('R2 拖动 + 松手零 React 警告(setY 不在 updater 里)', rs.every((r) => r.errors === 0), JSON.stringify(rs.map((r) => r.errors)))
    const { page } = await openCover(browser, 3000, 300)
    const btns = await page.evaluate(() => [...document.querySelectorAll('.amx-cover-tools button')].map((x) => x.textContent))
    record('R3 比框还扁的图没有纵向余量 → 不给「调整位置」', btns.length > 0 && !btns.includes('调整位置'), JSON.stringify(btns))
    await page.close()
  } finally {
    await browser.close()
  }
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  process.exit(ok === results.length ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
