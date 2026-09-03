// Amadeus 块级拖拽「左右分栏」落点判定实测(真浏览器 + 真 PageView/pageStore,harness.html?dnd)。
// 实报:text 块拖到 text 块左右边缘经常不成栏(closestCorners 用被拖块矩形四角算,
// 全宽 text 块必输给目标块本体 → 永远判成上下插入)。修 = 指针优先碰撞(pointerWithin)。
// 用法:node scripts/block-dnd.e2e.cjs(5173 没起会自起 vite,跑完自收)。
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
  for (const d of dirs.reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const URL = `${BASE}?dnd`

function ping() {
  return new Promise((res) => {
    const req = http.get(BASE, (r) => { res(r.statusCode === 200); r.resume() })
    req.on('error', () => res(false))
    req.setTimeout(1500, () => { req.destroy(); res(false) })
  })
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** dnd-kit PointerSensor(activationConstraint distance:5)驱动:按下 → 越过激活距离 →
 *  **激活后再量目标矩形**(sortable 拖拽中实时平移补位,拖拽前量的坐标会失效)→ 连续 move → 松手。
 *  where: 'left' | 'right' | 'center'(相对目标块)。 */
async function drag(page, blockId, targetId, where) {
  const handle = page.locator(`.block-host[data-block-id="${blockId}"] .drag-handle`)
  const hb = await handle.boundingBox()
  const sx = hb.x + hb.width / 2
  const sy = hb.y + hb.height / 2
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(sx + 9, sy + 9, { steps: 3 })
  await page.waitForTimeout(80) // 激活
  // 追踪式瞄准:sortable 拖拽中会实时补位(目标块随指针穿越持续平移),一次性瞄准必落空。
  // 人拖时眼睛在跟踪 → harness 用「移动→等→重量→收敛」循环,连续两轮目标矩形不动才算瞄准。
  let last = null
  for (let i = 0; i < 8; i++) {
    const r = await rectOf(page, targetId)
    const toX = where === 'left' ? r.x + 4 : where === 'right' ? r.x + r.width - 4 : r.x + r.width / 2
    const toY = r.y + r.height / 2
    await page.mouse.move(toX, toY, { steps: 10 })
    await page.waitForTimeout(120) // 补位动画 + MeasuringStrategy.Always 重测 edge 条
    const r2 = await rectOf(page, targetId)
    if (last && Math.abs(r2.y - r.y) < 2 && Math.abs(r2.x - r.x) < 2) break
    last = r2
  }
  await page.waitForTimeout(60)
  await page.mouse.up()
  await page.waitForTimeout(150)
}

const root = (page) => page.evaluate(() => window.__dndRoot)
const rectOf = (page, id) => page.locator(`.block-host[data-block-id="${id}"]`).boundingBox()

async function freshPage(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.block-host[data-block-id="b3"]', { timeout: 20000 })
  await page.waitForTimeout(300)
}

async function main() {
  let vite = null
  if (!(await ping())) {
    vite = spawn('npx', ['vite', 'frontend'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' })
    let up = false
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await ping()
    }
    if (!up) throw new Error('vite 起不来')
  }
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const page = await browser.newPage({ locale: 'zh-CN' })
    page.on('pageerror', (e) => console.log('[pageerror]', e.message))

    // A. 核心实报:text 块拖到另一 text 块右边缘 → 与其并排成两栏
    await freshPage(page)
    await drag(page, 'b3', 'b1', 'right')
    let t = await root(page)
    const rowA = t.children[0]
    check('A1 拖 b3 → b1 右缘:首行成两栏', rowA.columns.length === 2, `columns=${rowA.columns.length}`)
    check(
      'A2 两栏内容 = [b1, b3]',
      rowA.columns.length === 2 && rowA.columns[0].children[0]?.ref === 'b1' && rowA.columns[1].children[0]?.ref === 'b3',
      JSON.stringify(rowA.columns.map((c) => c.children.map((x) => x.ref))),
    )
    check('A3 b2 拆出独立行(只与目标那一块并排)', t.children.length === 2 && t.children[1].columns[0].children[0]?.ref === 'b2', `rows=${t.children.length}`)

    // B. 左缘对称:拖 b1 → b3 左缘
    await freshPage(page)
    await drag(page, 'b1', 'b3', 'left')
    t = await root(page)
    const rowB = t.children[t.children.length - 1]
    check(
      'B1 拖 b1 → b3 左缘:成 [b1, b3] 两栏',
      rowB.columns.length === 2 && rowB.columns[0].children[0]?.ref === 'b1' && rowB.columns[1].children[0]?.ref === 'b3',
      JSON.stringify(rowB.columns.map((c) => c.children.map((x) => x.ref))),
    )

    // C. 回归:拖到块中部仍是上下排序(别把重排抢成分栏)
    await freshPage(page)
    await drag(page, 'b3', 'b1', 'center')
    t = await root(page)
    const colC = t.children[0].columns[0]
    const orderC = colC.children.map((x) => x.ref).join()
    // sortable 补位下,指针最终停在 b1 原位或补位后槽位皆合法(与落点指示线一致);
    // 这里钉死的回归是「中部落点 = 同列插入,绝不劈成分栏」。
    check(
      'C1 拖 b3 → b1 中部:单列插入,不分栏',
      t.children.length === 1 && t.children[0].columns.length === 1 && (orderC === 'b3,b1,b2' || orderC === 'b1,b3,b2'),
      orderC,
    )

    // D. 已成栏后,把第三块拖进右栏块的右缘 → 三栏
    await freshPage(page)
    await drag(page, 'b3', 'b1', 'right')
    await drag(page, 'b2', 'b3', 'right')
    t = await root(page)
    const rowD = t.children[0]
    check(
      'D1 再拖 b2 → b3 右缘:三栏 [b1, b3, b2]',
      rowD.columns.length === 3 && rowD.columns.map((c) => c.children[0]?.ref).join() === 'b1,b3,b2',
      JSON.stringify(rowD.columns.map((c) => c.children.map((x) => x.ref))),
    )
  } finally {
    await browser.close()
    if (vite) vite.kill()
  }
  const fail = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - fail}/${results.length} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
