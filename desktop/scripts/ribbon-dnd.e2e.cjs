/**
 * Ribbon 图标拖拽落点实测(真 Chromium + 真 HTML5 DnD + 真 ribbonRegistry,harness.html?ribbon)。
 *
 * 为什么存在:用户实报「落点明明显示了,松手却没动/还在原地」。两个真因都在 DOM 接线层,纯函数单测
 * 抓不到:
 *   1) 旧语义是「插到目标之前」—— 往下拖一格 = 移除后目标左移一位 = 空操作;而且永远排不到最后一位。
 *   2) 旧落点按「命中哪个子元素」判 —— 松手落在两槽之间那 4px gap 里,命中的是组容器,
 *      于是走 dropOnBar(zone, null) 静悄悄滑到区末尾。
 * 现在落点数学是纯函数(lcl slotIndexAt,见 ribbonRegistry.test.ts),这里钉的是接线:
 * **组级 dragover 算出的下标 → 让位预览 transform → drop 提交,三者必须是同一个**。
 *
 * 跑:node scripts/ribbon-dnd.e2e.cjs   (5173 没起会自起 vite,跑完自收;CHROMIUM_EXE 可覆盖)
 */
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
const URL = `${BASE}?ribbon`

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

const slots = (page, zone) =>
  page.$$eval(`.rb-${zone} .rb-slot`, (els) => els.map((e) => {
    const r = e.getBoundingClientRect()
    return { id: e.dataset.id, top: r.top, h: r.height, dy: e.style.transform }
  }))
const orderOf = (page, zone) => page.evaluate((z) => (z === 'top' ? window.__rb.getState().order : window.__rb.getState().bottomOrder), zone)

/** 一次真 HTML5 拖拽:抓住 from 槽的中点 → 把「被拖项的虚拟顶边」送到 y → 松手。
 *  onGap=true 时 dragover/drop 打在组容器上(模拟松手落在槽间隙);
 *  dropAt 覆盖 drop 的派发目标(模拟松手落在组外 —— mac 窗口拖拽区吞事件时就是这种局面)。 */
async function drag(page, zone, fromId, y, { onGap = false, dropAt = null } = {}) {
  const list = await slots(page, zone)
  const src = list.find((s) => s.id === fromId)
  const dt = await page.evaluateHandle(() => new DataTransfer())
  const startY = src.top + src.h / 2
  await page.dispatchEvent(`.rb-${zone} .rb-slot[data-id="${fromId}"]`, 'dragstart', { dataTransfer: dt, clientX: 22, clientY: startY })
  const grabDy = src.h / 2
  const pointerY = y + grabDy // 指针 = 被拖项虚拟顶边 + 抓取偏移
  const hit = list.find((s) => pointerY >= s.top && pointerY <= s.top + s.h) ?? src
  const at = onGap ? `.rb-${zone}` : `.rb-${zone} .rb-slot[data-id="${hit.id}"]`
  const ev = { dataTransfer: dt, clientX: 22, clientY: pointerY }
  await page.dispatchEvent(at, 'dragover', ev)
  await page.waitForTimeout(260) // 等让位动画走完再拍(190ms 过渡,拍早了量到半路的中间态)
  const preview = await slots(page, zone) // 提交前的屏幕实况
  await page.dispatchEvent(dropAt ?? at, 'drop', ev)
  await page.waitForTimeout(30)
  return preview
}

/** 让位预览下用户**眼睛看到的**顺序:按屏幕上的实际位置排(rect 已含 transform)。必须等于提交后的持久顺序。 */
const previewOrder = (preview) => [...preview].sort((a, b) => a.top - b.top).map((s) => s.id)

async function fresh(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.rb-top .rb-slot[data-id="tD"]', { timeout: 20000 })
  await page.waitForTimeout(200)
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
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } })
    page.on('pageerror', (e) => console.log('[pageerror]', e.message))
    // ribbon 顺序/展开态/收纳夹都落 localStorage → 每次导航前清掉,用例之间才互不串味。
    await page.addInitScript(() => localStorage.clear())

    // A. 实报主症:往下挪一格。旧的「插到目标之前」在这里是空操作 = 用户说的「松手还在原地」。
    await fresh(page)
    let s = await slots(page, 'top')
    let pv = await drag(page, 'top', 'tA', s[1].top)
    check('A1 tA 下移一格 = [tB,tA,tC,tD]', (await orderOf(page, 'top')).join() === 'tB,tA,tC,tD', (await orderOf(page, 'top')).join())
    check('A2 让位预览 = 提交结果(提示在哪就落在哪)', previewOrder(pv).join() === 'tB,tA,tC,tD', previewOrder(pv).join())

    // B. 排到最末:插入语义下永远够不着(只有 n 个「之前」,凑不出第 n+1 个位置)。
    await fresh(page)
    s = await slots(page, 'top')
    await drag(page, 'top', 'tA', s[3].top)
    check('B1 tA 拖到末槽 = [tB,tC,tD,tA]', (await orderOf(page, 'top')).join() === 'tB,tC,tD,tA', (await orderOf(page, 'top')).join())

    // C. 上移(方向对称)。
    await fresh(page)
    s = await slots(page, 'top')
    await drag(page, 'top', 'tD', s[0].top)
    check('C1 tD 拖到首槽 = [tD,tA,tB,tC]', (await orderOf(page, 'top')).join() === 'tD,tA,tB,tC', (await orderOf(page, 'top')).join())

    // D. 槽间隙里松手:旧代码命中组容器 → 静悄悄滑到区末尾;现在按几何落在该落的那格。
    await fresh(page)
    s = await slots(page, 'top')
    const gapY = s[0].top + s[0].h + 2 - s[0].h / 2 // 虚拟顶边落在 slot0/slot1 之间那 4px 里
    await drag(page, 'top', 'tA', gapY, { onGap: true })
    check('D1 间隙松手落在最近一格,不滑到末尾', (await orderOf(page, 'top')).join() === 'tB,tA,tC,tD', (await orderOf(page, 'top')).join())

    // E. 原地松手 = 不动(别虚报落点)。
    await fresh(page)
    s = await slots(page, 'top')
    await drag(page, 'top', 'tB', s[1].top + 3)
    check('E1 原地松手顺序不变', (await orderOf(page, 'top')).join() === 'tA,tB,tC,tD', (await orderOf(page, 'top')).join())

    // F. 命令区(下区)同一套。
    await fresh(page)
    s = await slots(page, 'bottom')
    await drag(page, 'bottom', 'bA', s[2].top)
    check('F1 bA 拖到末槽 = [bB,bC,bA]', (await orderOf(page, 'bottom')).join() === 'bB,bC,bA', (await orderOf(page, 'bottom')).join())

    // J. 松手落在**组外**(ribbon 根上)。真机上 mac 会把槽间隙/组边缘当窗口拖拽区吞掉 drop,
    //    浏览器里复现不了那层,但落点丢失的后果一样:drop 打到根上。根兜底必须照预览提交。
    await fresh(page)
    s = await slots(page, 'top')
    await drag(page, 'top', 'tA', s[1].top, { dropAt: '.rb' })
    check('J1 松手落在组外(ribbon 根)也照预览落', (await orderOf(page, 'top')).join() === 'tB,tA,tC,tD', (await orderOf(page, 'top')).join())
    // J2 是静态契约:拖动期整条 ribbon 必须退出窗口拖拽区,否则 mac 上 drop 根本到不了 JS。
    const css = fs.readFileSync(path.join(__dirname, '../../lcl/engine/engine.css'), 'utf8')
    check('J2 engine.css 里 .rb.rb-dragging 抑掉窗口拖拽区', /\.rb\.rb-dragging\s*\{[^}]*-webkit-app-region:\s*no-drag/.test(css))

    // K. 命令区溢出从**最上面**吃起(「…」在上,吃紧挨它那一端;上区反之)。
    await fresh(page)
    await page.evaluate(() => {
      const s = window.__rb.getState()
      for (const n of ['D', 'E', 'F', 'G', 'H']) s.addRibbonIcon({ id: 'b' + n, side: 'bottom', tooltip: () => 'Bot ' + n, icon: s.items[0].icon, onClick() {} })
      s.setZoneOrder('bottom', ['bA', 'bB', 'bC', 'bD', 'bE', 'bF', 'bG', 'bH'])
    })
    await page.setViewportSize({ width: 900, height: 330 }) // 挤到必须溢出
    await page.waitForTimeout(300)
    const shownBot = (await slots(page, 'bottom')).map((x) => x.id)
    const allBot = await orderOf(page, 'bottom')
    check('K1 命令区溢出从最上面吃起(留下靠账号卡那一端)', shownBot.length < allBot.length && shownBot.join() === allBot.slice(-shownBot.length).join(), `留下 ${shownBot.join()} ｜ 全量 ${allBot.join()}`)
    const shownTop = (await slots(page, 'top')).map((x) => x.id)
    const allTop = await orderOf(page, 'top')
    check('K2 上区反向:从最下面吃起(留下靠 head 那一端)', shownTop.join() === allTop.slice(0, shownTop.length).join(), `留下 ${shownTop.join()} ｜ 全量 ${allTop.join()}`)
    await page.setViewportSize({ width: 900, height: 800 })

    // I. 收纳夹自己被拖(codex#1):夹钮的 dragover 拒收「夹拖夹」→ 走组级画了让位预览,
    //    但它的 drop 以前无条件吃掉再被 dropIntoFolder 拒收 = 预览骗人、松手不动。
    await fresh(page)
    await page.evaluate(() => { window.__rb.getState().addFolder('top', 'F1'); window.__rb.getState().addFolder('top', 'F2') })
    await page.waitForTimeout(150)
    s = await slots(page, 'top')
    const [f1, f2] = s.slice(-2).map((x) => x.id)
    await drag(page, 'top', f1, s[s.length - 1].top) // 把 F1 拖到 F2 占的槽上
    const ord = (await orderOf(page, 'top')).slice(-2).join()
    check('I1 夹拖到另一个夹上 = 换位(不再被 dropIntoFolder 静默吞掉)', ord === [f2, f1].join(), ord)

    // H. 展开态(宽条):槽高 34 而非 32,让位位移用的是布局常量 slotH —— 与实测槽距对不上就会歪。
    await fresh(page)
    await page.evaluate(() => window.__rb.getState().toggleExpanded())
    await page.waitForTimeout(120)
    s = await slots(page, 'top')
    pv = await drag(page, 'top', 'tA', s[1].top)
    check('H1 展开态下移一格 = [tB,tA,tC,tD]', (await orderOf(page, 'top')).join() === 'tB,tA,tC,tD', (await orderOf(page, 'top')).join())
    check('H2 展开态让位预览 = 提交结果', previewOrder(pv).join() === 'tB,tA,tC,tD', previewOrder(pv).join())
    await page.evaluate(() => window.__rb.getState().toggleExpanded())

    // G. 命令区镜像:＋ 贴中间空隙在最上,图标列在下(与上区 [图标… / ＋] 对称)。
    await fresh(page) // 独立起一页:别继承 H 的展开态(localStorage 会存,跨用例串味)
    const kinds = await page.$$eval('.rb-bottom > *', (els) => els.map((e) => (e.classList.contains('rb-plus') ? '+' : e.classList.contains('rb-more') ? '…' : 'slot')))
    check('G1 下区首元素是 ＋(镜像对称)', kinds[0] === '+', kinds.join(' '))
    const topKinds = await page.$$eval('.rb-top > *', (els) => els.map((e) => (e.classList.contains('rb-plus') ? '+' : e.classList.contains('rb-more') ? '…' : 'slot')))
    check('G2 上区末元素是 ＋', topKinds[topKinds.length - 1] === '+', topKinds.join(' '))
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
