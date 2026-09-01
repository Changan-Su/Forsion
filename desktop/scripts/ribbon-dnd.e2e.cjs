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

    // L. Space 快捷键 mod+1..9:号**只认上区当前排序**(拖动改序后号跟着走),收纳夹也占一个号且按下=弹浮层。
    //    这里钉的同样是接线:纯函数 rankIds 排好的序,必须就是键盘分发数的那一份。
    const hits = () => page.evaluate(() => window.__rbHits.join())
    await fresh(page)
    await page.keyboard.press('Meta+2')
    await page.waitForTimeout(60)
    check('L1 mod+2 = 上区第 2 个(tB)', (await hits()) === 'tB', await hits())
    await page.evaluate(() => window.__rb.getState().setZoneOrder('top', ['tD', 'tA', 'tB', 'tC']))
    await page.waitForTimeout(80)
    await page.keyboard.press('Meta+1')
    await page.waitForTimeout(60)
    check('L2 改序后 mod+1 跟着走(tD)', (await hits()) === 'tB,tD', await hits())
    // L3/L4:第 5 个位置放一个收纳夹(addFolder 追加到区末)。
    await fresh(page)
    await page.evaluate(() => window.__rb.getState().addFolder('top', 'FKB'))
    await page.waitForTimeout(120)
    await page.keyboard.press('Meta+5')
    await page.waitForTimeout(80)
    check('L3 第 5 个是收纳夹 → 弹出它的浮层', (await page.$eval('.rb-fly .rb-fly-head', (e) => e.textContent).catch(() => null)) === 'FKB')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(60)
    check('L4 Esc 关掉键盘开的浮层(鼠标不在上面,没有 mouseleave 可用)', (await page.$('.rb-fly')) === null)
    await page.keyboard.press('Meta+9')
    await page.waitForTimeout(60)
    check('L5 空号(mod+9)什么也不做', (await hits()) === '', await hits())
    // L6:收纳夹成员表里残留**解析不出来的 id**(图标退役 / 插件卸载 / 命令消失都会留下)。
    //     计数与空态必须按活成员算 —— 否则就是「标着 (1) 打开一片空白,连空态提示都不给」。
    await fresh(page)
    await page.evaluate(() => {
      window.__rb.getState().addFolder('top', 'FDEAD') // getState() 的快照是旧的,加完必须重取
      const fs = window.__rb.getState().folders
      window.__rb.getState().setFolderItems(fs[fs.length - 1].id, ['tA', 'rb-retired-ghost'])
    })
    await page.waitForTimeout(120)
    const folderTitle = await page.$eval('.rb-top .rb-folder', (e) => e.title)
    check('L6 收纳夹计数只算活成员(1 而非 2)', /\(1\)$/.test(folderTitle), folderTitle)
    await page.evaluate(() => {
      const s = window.__rb.getState()
      window.__rb.getState().setFolderItems(s.folders[s.folders.length - 1].id, ['rb-retired-ghost'])
    })
    await page.waitForTimeout(120)
    await page.hover('.rb-top .rb-folder')
    await page.waitForSelector('.rb-fly', { timeout: 3000 })
    check('L6b 全是死 id 的收纳夹给空态提示而不是空白', (await page.$('.rb-fly .rb-fly-empty')) !== null)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(60)

    // M. 槽位上的快捷键提示:只在展开态露、跟着排序走、没号的不画。绝对定位 —— 顺带确认它没把槽撑高
    //    (撑高 = slotH 常量失配 = 让位预览与落点全歪,所以这条必须量)。
    const keysOf = (page) => page.$$eval('.rb-top .rb-slot', (els) => els.map((e) => e.querySelector('.rb-key')?.textContent ?? ''))
    const slotHeights = (page) => page.$$eval('.rb-top .rb-slot', (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
    await fresh(page)
    check('M1 折叠态不显示快捷键提示', (await keysOf(page)).every((t) => t === ''), (await keysOf(page)).join('|'))
    const hCollapsed = await slotHeights(page)
    await page.evaluate(() => window.__rb.getState().toggleExpanded())
    await page.waitForTimeout(150)
    check('M2 展开态按顺序标 ⌘1..4', (await keysOf(page)).join() === '⌘1,⌘2,⌘3,⌘4', (await keysOf(page)).join())
    check('M3 提示不撑高槽位(撑高就会让位预览歪掉)', (await slotHeights(page)).join() === hCollapsed.map(() => 34).join(), `${(await slotHeights(page)).join()} ｜ 折叠 ${hCollapsed.join()}`)
    await page.evaluate(() => window.__rb.getState().setZoneOrder('top', ['tD', 'tA', 'tB', 'tC']))
    await page.waitForTimeout(120)
    const firstId = await page.$eval('.rb-top .rb-slot', (e) => e.dataset.id)
    check('M4 改序后 ⌘1 标在新的第一个上', firstId === 'tD' && (await keysOf(page))[0] === '⌘1', `${firstId} / ${(await keysOf(page))[0]}`)
    // 补到 10 个:第 10 个没有快捷键 → 不画提示
    await page.evaluate(() => {
      const s = window.__rb.getState()
      for (const n of ['E', 'F', 'G', 'H', 'I', 'J']) s.addRibbonIcon({ id: 't' + n, side: 'top', tooltip: () => 'Top ' + n, icon: s.items[0].icon, onClick() {} })
    })
    await page.setViewportSize({ width: 900, height: 1000 }) // 够高,10 个都不进「…」
    await page.waitForTimeout(250)
    const ks = await keysOf(page)
    check('M5 第 10 个没有快捷键 → 不画提示', ks.length === 10 && ks[8] === '⌘9' && ks[9] === '', `${ks.length} 个 ｜ ${ks.join('|')}`)
    await page.setViewportSize({ width: 900, height: 800 })

    // N. 未读角标(收件箱红点)× 快捷键提示:展开态角标必须贴**图标**右上角,不是行右端 ——
    //    行右端归 .rb-key,两个都往那儿放就是用户实报的「红点和 ⌘1 重合」。
    //    角标真身是 desktop 的 SpaceButton(.rb-btn.rb-space + .rb-badge 子节点),这里复刻同一 DOM,
    //    验的是 engine.css 的落点(engine 里没有 Space 概念,harness 造不出真的收件箱)。
    await fresh(page)
    await page.evaluate(() => window.__rb.getState().toggleExpanded())
    await page.waitForTimeout(150)
    await page.$eval('.rb-top .rb-slot .rb-btn', (b) => {
      b.classList.add('rb-space')
      const s = document.createElement('span')
      s.className = 'rb-badge'
      s.textContent = '3'
      b.appendChild(s)
    })
    await page.waitForTimeout(60)
    const geo = await page.$eval('.rb-top .rb-slot', (slot) => {
      const box = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom } }
      return {
        badge: box(slot.querySelector('.rb-badge')),
        key: box(slot.querySelector('.rb-key')),
        icon: box(slot.querySelector('.rb-btn svg')),
        row: box(slot),
      }
    })
    const hit = geo.badge.l < geo.key.r && geo.badge.r > geo.key.l && geo.badge.t < geo.key.b && geo.badge.b > geo.key.t
    check('N1 展开态红点与快捷键提示不重合', !hit, JSON.stringify(geo))
    check(
      'N2 红点贴在图标右上角(不是行右端)',
      geo.badge.l <= geo.icon.r && geo.badge.t < (geo.row.t + geo.row.b) / 2,
      `badge.l=${Math.round(geo.badge.l)} icon.r=${Math.round(geo.icon.r)} badge.t=${Math.round(geo.badge.t)} rowMid=${Math.round((geo.row.t + geo.row.b) / 2)}`,
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
