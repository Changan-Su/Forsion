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
const { findChromium } = require('./lib/find-chromium.cjs')

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
    vite = spawn(process.execPath, [path.join(__dirname, '../node_modules/vite/bin/vite.js'), 'frontend'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore', windowsHide: true })
    let up = false
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await ping()
    }
    if (!up) throw new Error('vite 起不来')
  }
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 900, height: 800 } })
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
    await page.click('.rb-top .rb-more') // 6 项也遵守常驻 5 项；展开后才可拖动两个夹。
    await page.waitForTimeout(300)
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
    // 收纳夹钮 09-25 起不挂原生 title(收起态走自绘浮签,收纳夹悬停直接弹浮层),名字 + 计数在 aria-label
    const folderTitle = await page.$eval('.rb-top .rb-folder', (e) => e.getAttribute('aria-label') || e.title)
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
    // 补到 10 个:10-02 起上区只常驻 5 个(用户拍板 v1),第 6 个起进「…」—— 常驻的正好标 ⌘1..5,不跳号
    await page.evaluate(() => {
      const s = window.__rb.getState()
      for (const n of ['E', 'F', 'G', 'H', 'I', 'J']) s.addRibbonIcon({ id: 't' + n, side: 'top', tooltip: () => 'Top ' + n, icon: s.items[0].icon, onClick() { window.__rbHits.push('t' + n) } })
    })
    await page.setViewportSize({ width: 900, height: 1000 }) // 够高:进「…」只因常驻上限,不因高度
    await page.waitForTimeout(250)
    const ks = await keysOf(page)
    const hasMore = !!(await page.$('.rb-top .rb-more'))
    check('M5 补到 10 个:上区只常驻 5 个(标 ⌘1..5),其余进「…」', ks.join() === '⌘1,⌘2,⌘3,⌘4,⌘5' && hasMore, `${ks.length} 个 ｜ ${ks.join('|')} ｜ more=${hasMore}`)
    // 号按整条上区排序分,不按「露在外面的」:收进「…」的第 6 个照样 mod+6 直达(序 = tD,tA,tB,tC,tE,tF…)。
    await page.evaluate(() => { window.__rbHits.length = 0 })
    await page.keyboard.press('Meta+6')
    await page.waitForTimeout(80)
    const hit6 = await page.evaluate(() => window.__rbHits.join())
    check('M5b 收进「…」的第 6 个照样 mod+6 直达', hit6 === 'tF', hit6)

    // W. 滚轮翻看(10-02 用户要求,类 Agent 选择条):DOM 不滚,露出的那一窗平移。第二版「丝滑 + 吸附」:
    //    手势中按 px 跟手,停手 120ms 吸附到整格,吸附过渡走完(+240ms)才提交新窗口。每下之间停 450ms
    //    = 每下都是独立手势;deltaY 只给 10px,顺带钉「慢转的滚轮一下只有几 px 也得挪一格」。
    const SETTLE = 450
    const idsIn = (zone) => page.$$eval(`.rb-${zone} .rb-slot`, (els) => els.map((e) => e.dataset.id))
    const wheelAt = async (zone, dy, times = 1, gap = SETTLE) => {
      const b = await page.$eval(`.rb-${zone} .rb-slot`, (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
      await page.mouse.move(b.x, b.y)
      for (let i = 0; i < times; i++) { await page.mouse.wheel(0, dy); await page.waitForTimeout(gap) }
      if (gap < SETTLE) await page.waitForTimeout(SETTLE)
    }
    const top0 = await idsIn('top')
    await wheelAt('top', 10)
    const top1 = await idsIn('top'), k1 = await keysOf(page)
    check('W1 上区往下滚一下:窗口后移一格,提示标真实位置(⌘2..⌘6)', top1[0] === top0[1] && top1.length === 5 && k1.join() === '⌘2,⌘3,⌘4,⌘5,⌘6', `${top1.join()} ｜ ${k1.join('|')}`)
    // 快捷键不跟着滚动变(10-02 用户确认):滚过以后 mod+1 仍是整区第一个(tD,已滚出窗口)。
    await page.evaluate(() => { window.__rbHits.length = 0 })
    await page.keyboard.press('Meta+1')
    await page.waitForTimeout(80)
    const hit1 = await page.evaluate(() => window.__rbHits.join())
    check('W1b 滚过以后 mod+1 仍是整区第一个(号不随滚动变)', hit1 === 'tD', hit1)
    // 丝滑 + 吸附:滚一下 10px 的 60ms 后,列停在两格之间(跟手,不是整格)、窗外格子临时画出图标;
    // 停手后吸附到整格(新窗口起点 × 槽距),占位清空。
    const pitch = await page.$$eval('.rb-top .rb-slot', (els) => els[1].getBoundingClientRect().top - els[0].getBoundingClientRect().top)
    const ty = (m) => { const v = /matrix\(([^)]+)\)/.exec(m); return v ? Number(v[1].split(',')[5]) : 0 }
    const stripNow = () => page.evaluate(() => ({ tr: getComputedStyle(document.querySelector('.rb-top .rb-strip-in')).transform, filled: [...document.querySelectorAll('.rb-top .rb-cell')].filter((c) => c.childElementCount).length }))
    await page.mouse.wheel(0, 10)
    await page.waitForTimeout(60)
    const mid = await stripNow()
    await page.waitForTimeout(SETTLE)
    const end = await stripNow()
    const offGrid = (y) => Math.abs(y / pitch - Math.round(y / pitch)) > 0.05
    check('W1c 丝滑:手势中列停在两格之间、窗外格子画出图标;停手吸附到整格(第 3 格起)、占位清空', offGrid(ty(mid.tr)) && mid.filled > 0 && Math.abs(ty(end.tr) + 2 * pitch) < 0.5 && end.filled === 0, JSON.stringify({ pitch, mid: ty(mid.tr), filledMid: mid.filled, end: ty(end.tr), filledEnd: end.filled }))
    // 触控板式连续小 delta(6 × 15px ≈ 2.4 格,16ms 一发 = 同一手势):累加跟手,停手四舍五入吸附 → 再挪 2 格。
    const before8 = await idsIn('top')
    await wheelAt('top', 15, 6, 16)
    const after8 = await idsIn('top')
    check('W8 连续小 delta 累加、停手按最近整格吸附(≈2.4 格 → 2 格)', after8[0] === top0[4] && before8[0] === top0[2], `${before8.join()} → ${after8.join()}`)
    await wheelAt('top', -10, 2)
    await wheelAt('top', -10)
    await wheelAt('top', 10, 8)
    const k2 = await keysOf(page)
    check('W2 滚到底夹住:露最后 5 个(⌘6..⌘9,第 10 个无号)', k2.join() === '⌘6,⌘7,⌘8,⌘9,', k2.join('|'))
    // 「…」= 展开:滚过去的前几个点开就在条上(10-02 起「…」不再弹浮层)。
    await page.click('.rb-top .rb-more')
    await page.waitForTimeout(150)
    const openTop = await idsIn('top')
    check('W3 滚过去的前几个点「…」展开后就在条上', top0.slice(0, 5).every((id) => openTop.includes(id)) && openTop.length === 10, openTop.join())
    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
    await wheelAt('top', -10, 8)
    check('W4 往上滚回来:窗口复原', (await idsIn('top')).join() === top0.join(), (await idsIn('top')).join())
    await page.evaluate(() => {
      const s = window.__rb.getState()
      for (const n of ['D', 'E', 'F']) s.addRibbonIcon({ id: 'b' + n, side: 'bottom', tooltip: () => 'Bot ' + n, icon: s.items[0].icon, onClick() {} })
    })
    await page.waitForTimeout(200)
    const bot0 = await idsIn('bottom')
    await wheelAt('bottom', -10)
    const bot1 = await idsIn('bottom')
    check('W5 命令区往上滚一下:露出前面藏着的那一个(命令区「…」在上)', bot0.join() === 'bB,bC,bD,bE,bF' && bot1.join() === 'bA,bB,bC,bD,bE', `${bot0.join()} → ${bot1.join()}`)
    await wheelAt('bottom', 10, 3)
    check('W6 命令区往下滚回来:贴底复原', (await idsIn('bottom')).join() === bot0.join(), (await idsIn('bottom')).join())
    // 鼠标滚轮一格常见 100–120px:一下只许挪一格(照原生换算会跳 3 格,5 格的窗口一下翻掉大半)。
    await wheelAt('top', 120)
    const top2 = await idsIn('top')
    check('W7 一下 120px 的滚轮只挪一格', top2[0] === top0[1], `${top0.join()} → ${top2.join()}`)
    await wheelAt('top', -120)
    await page.setViewportSize({ width: 900, height: 800 })

    // X. 「…」= 展开(10-02 用户要求):点上区「…」→ 上区铺满、命令区让出来;点 Ribbon 图标不收,点别处 / Esc /
    //    窗口失焦(点进 iframe 视图时事件到不了本窗口)收回。命令区「…」镜像:上区与主位槽一起让出来。
    await fresh(page)
    await page.evaluate(() => {
      const s = window.__rb.getState()
      for (const n of ['E', 'F', 'G', 'H', 'I']) s.addRibbonIcon({ id: 't' + n, side: 'top', tooltip: () => 'Top ' + n, icon: s.items[0].icon, onClick() { window.__rbHits.push('t' + n) } })
      for (const n of ['D', 'E', 'F']) s.addRibbonIcon({ id: 'b' + n, side: 'bottom', tooltip: () => 'Bot ' + n, icon: s.items[0].icon, onClick() {} })
      s.addRibbonIcon({ id: 'pin', side: 'bottom', pinned: true, tooltip: () => 'Pinned', icon: s.items[0].icon, onClick() {} })
    })
    await page.waitForTimeout(250)
    const isOpen = () => page.evaluate(() => ({ top: !!document.querySelector('.rb.rb-open-top'), bottom: !!document.querySelector('.rb.rb-open-bottom') }))
    const pinBottom = () => page.$eval('.rb-pinned', (e) => Math.round(e.getBoundingClientRect().bottom))
    const pin0 = await pinBottom()
    await page.click('.rb-top .rb-more')
    await page.waitForTimeout(150)
    const xTop = await idsIn('top')
    const xMore = await page.$eval('.rb-top .rb-more', (b) => ({ exp: b.getAttribute('aria-expanded'), label: b.getAttribute('aria-label') }))
    check('X1 点上区「…」:上区 9 个全露、命令区让出来、钮变「收起」', xTop.length === 9 && !(await page.$('.rb-bottom')) && xMore.exp === 'true' && xMore.label === '收起', `${xTop.join()} ｜ ${JSON.stringify(xMore)}`)
    check('X2 上区展开时账号卡仍贴底', (await pinBottom()) === pin0, `${pin0} → ${await pinBottom()}`)
    await page.evaluate(() => { window.__rbHits.length = 0 })
    await page.click('.rb-top .rb-slot[data-id="tI"] .rb-btn')
    await page.waitForTimeout(100)
    check('X3 点展开区里的图标:照常触发、不收起', (await page.evaluate(() => window.__rbHits.join())) === 'tI' && (await isOpen()).top, JSON.stringify(await isOpen()))
    await page.mouse.click(600, 400)
    await page.waitForTimeout(150)
    check('X4 点 Ribbon 以外任意处:收回,命令区回来、上区回到 5 个', !(await isOpen()).top && !!(await page.$('.rb-bottom')) && (await idsIn('top')).length === 5, `${(await idsIn('top')).length} ｜ ${JSON.stringify(await isOpen())}`)
    await page.click('.rb-bottom .rb-more')
    await page.waitForTimeout(150)
    const xBot = await idsIn('bottom')
    const homeShown = await page.$eval('.rb-home', (e) => getComputedStyle(e).display !== 'none')
    check('X5 点命令区「…」:命令区全露、上区与主位槽让出来', (await isOpen()).bottom && !(await page.$('.rb-top')) && !homeShown && xBot.length === 6, `${xBot.join()} ｜ home=${homeShown}`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    check('X6 Esc 收回', !(await isOpen()).bottom && !!(await page.$('.rb-top')), JSON.stringify(await isOpen()))
    await page.click('.rb-top .rb-more')
    await page.waitForTimeout(100)
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.waitForTimeout(150)
    check('X7 窗口失焦(点进 iframe 视图)收回', !(await isOpen()).top, JSON.stringify(await isOpen()))
    await page.click('.rb-top .rb-more')
    await page.waitForTimeout(100)
    await page.click('.rb-top .rb-more')
    await page.waitForTimeout(150)
    check('X8 再点「收起」收回', !(await isOpen()).top && (await idsIn('top')).length === 5, JSON.stringify(await isOpen()))

    // Y. 滚动后自动归位(10-04 用户要求,设置里可关):翻过以后,点 Ribbon 以外的地方 / 点开条上的一个条目 /
    //    窗口失焦,隔 600ms 滑回原位。光滚不点不动,「…」不算,延迟内再滚就作废;开关读 localStorage,用时才读。
    await fresh(page)
    await page.evaluate(() => {
      const s = window.__rb.getState()
      for (const n of ['E', 'F', 'G', 'H', 'I']) s.addRibbonIcon({ id: 't' + n, side: 'top', tooltip: () => 'Top ' + n, icon: s.items[0].icon, onClick() { window.__rbHits.push('t' + n) } })
      for (const n of ['D', 'E', 'F']) s.addRibbonIcon({ id: 'b' + n, side: 'bottom', tooltip: () => 'Bot ' + n, icon: s.items[0].icon, onClick() {} })
    })
    await page.waitForTimeout(250)
    const HOME = 600 + 240 + 260 // HOME_DELAY + 滑回过渡 + 余量
    const topNow = async () => (await idsIn('top')).join()
    const outside = () => page.mouse.click(500, 400)
    const yTop0 = await topNow()
    await wheelAt('top', 10)
    const yTop1 = await topNow()
    await page.waitForTimeout(HOME)
    check('Y1 光滚不点:停在翻到的位置', yTop1 !== yTop0 && (await topNow()) === yTop1, `${yTop0} → ${yTop1}`)
    await outside()
    await page.waitForTimeout(300)
    const yMid = await topNow()
    await page.waitForTimeout(HOME)
    check('Y2 点 Ribbon 以外:先停一下(300ms 时还没动),随后滑回原位', yMid === yTop1 && (await topNow()) === yTop0, `300ms=${yMid} ｜ 之后=${await topNow()}`)
    await wheelAt('top', 10, 2)
    const yShown = await idsIn('top')
    const yLast = yShown[yShown.length - 1] // 翻出来的那个
    await page.evaluate(() => { window.__rbHits.length = 0 })
    await page.click(`.rb-top .rb-slot[data-id="${yLast}"] .rb-btn`)
    await page.waitForTimeout(HOME)
    const yHit = await page.evaluate(() => window.__rbHits.join())
    check('Y3 点开翻出来的条目:照常触发,随后归位', yHit === yLast && (await topNow()) === yTop0, `点 ${yLast} 命中 ${yHit} ｜ ${await topNow()}`)
    await wheelAt('top', 10)
    const y4 = await topNow()
    await page.click('.rb-top .rb-more')
    await page.waitForTimeout(150)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(HOME)
    check('Y4 点「…」再 Esc 收起:不触发归位', y4 !== yTop0 && (await topNow()) === y4, `${y4} → ${await topNow()}`)
    await outside()
    await page.waitForTimeout(200)
    await wheelAt('top', 10) // 延迟内又滚
    await page.waitForTimeout(HOME)
    const y5 = await topNow()
    check('Y5 延迟内又滚:归位作废,停在新位置', y5 !== yTop0 && y5 !== y4, `${y4} → ${y5}`)
    await page.evaluate(() => localStorage.setItem('forsion_ribbon_auto_home', '0'))
    await outside()
    await page.waitForTimeout(HOME)
    const y6 = await topNow()
    await page.evaluate(() => localStorage.setItem('forsion_ribbon_auto_home', '1'))
    await outside()
    await page.waitForTimeout(HOME)
    check('Y6 设置关掉:点别处不归位;重新打开后下一次点击就归位(不用刷新)', y6 === y5 && (await topNow()) === yTop0, `关=${y6} ｜ 开=${await topNow()}`)
    const yBot0 = (await idsIn('bottom')).join()
    await wheelAt('bottom', -10)
    const yBot1 = (await idsIn('bottom')).join()
    await outside()
    await page.waitForTimeout(HOME)
    check('Y7 命令区同理:翻出藏着的,点别处后贴底复原', yBot1 !== yBot0 && (await idsIn('bottom')).join() === yBot0, `${yBot0} → ${yBot1} → ${(await idsIn('bottom')).join()}`)
    await wheelAt('top', 10)
    const y8 = await topNow()
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.waitForTimeout(HOME)
    check('Y8 窗口失焦(点进 iframe 视图)也归位', y8 !== yTop0 && (await topNow()) === yTop0, `${y8} → ${await topNow()}`)
    await page.mouse.move(22, 200)
    await page.mouse.wheel(0, 10)
    await page.waitForTimeout(60) // 手势还在跟手、窗口没提交
    const y10mid = ty((await stripNow()).tr)
    await outside()
    await page.waitForTimeout(HOME + 400)
    check('Y10 滚一下马上点(吸附还没走完):照样归位', y10mid !== 0 && (await topNow()) === yTop0, `点的那一刻列位移 ${y10mid} ｜ ${await topNow()}`)
    // 评审两条:归位滑动途中又滚一小下不能被吞;排队之后才关掉开关,到点不该再执行。
    await wheelAt('top', 10)
    await outside()
    await page.waitForTimeout(600 + 90) // 归位那 240ms 滑动的中途
    await page.mouse.move(22, 200)
    await page.mouse.wheel(0, 4)
    await page.waitForTimeout(SETTLE + 300)
    const y11 = await topNow()
    check('Y11 归位滑动途中又滚 4px:挪一格,不被吞', y11 === yTop1, y11)
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.waitForTimeout(100)
    await page.evaluate(() => localStorage.setItem('forsion_ribbon_auto_home', '0'))
    await page.waitForTimeout(HOME)
    const y12 = await topNow()
    await page.evaluate(() => localStorage.setItem('forsion_ribbon_auto_home', '1'))
    await outside()
    await page.waitForTimeout(HOME)
    check('Y12 排队后才关掉开关:到点不执行;重新打开后归位', y12 === yTop1 && (await topNow()) === yTop0, `关=${y12} ｜ 开=${await topNow()}`)
    const y9 = await page.evaluate(() => ({ tr: document.querySelector('.rb-top .rb-strip-in').style.transform, filled: [...document.querySelectorAll('.rb .rb-cell')].filter((c) => c.childElementCount).length }))
    check('Y9 归位后列的位移清零、窗外占位清空', y9.tr === '' && y9.filled === 0, JSON.stringify(y9))

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

    // O. 收起态自绘浮签(取代原生 title,09-25 U-21):悬停 1s 弹、0.1s 内换图标立刻弹、拖动 / 按下即收;
    //    开关类命令(Command.checked)钉进命令区后按钮带 aria-pressed / .is-on。
    await fresh(page)
    const titles = await page.$$eval('.rb-top .rb-btn, .rb-bottom .rb-btn, .rb-head .rb-toggle', (els) => els.filter((e) => e.title).map((e) => e.className))
    check('O1 收起态 Ribbon 钮不挂原生 title(否则与浮签叠成两层)', titles.length === 0, titles.join('|'))
    const tipText = () => page.evaluate(() => document.querySelector('.rb-tip')?.textContent ?? null)
    const center = async (sel) => { const b = await page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }); return b }
    let c = await center('.rb-top .rb-slot[data-id="tA"] .rb-btn')
    await page.mouse.move(c.x, c.y)
    await page.waitForTimeout(500)
    const early = await tipText()
    await page.waitForTimeout(700)
    const late = await tipText()
    check('O2 悬停 0.5s 还不弹、1.2s 弹出且是该钮的名字', early === null && late === 'Top A', `0.5s=${early} 1.2s=${late}`)
    const tipGeo = await page.evaluate(() => {
      const t = document.querySelector('.rb-tip')?.getBoundingClientRect()
      const b = document.querySelector('.rb-top .rb-slot[data-id="tA"] .rb-btn')?.getBoundingClientRect()
      const rb = document.querySelector('.rb')?.getBoundingClientRect()
      return t && b && rb ? { dy: Math.abs((t.top + t.bottom) / 2 - (b.top + b.bottom) / 2), gap: t.left - rb.right } : null
    })
    check('O3 浮签贴在 Ribbon 右侧、与按钮垂直居中', !!tipGeo && tipGeo.dy <= 1.5 && tipGeo.gap >= 2 && tipGeo.gap <= 12, JSON.stringify(tipGeo))
    c = await center('.rb-top .rb-slot[data-id="tB"] .rb-btn')
    await page.mouse.move(c.x, c.y)
    await page.waitForTimeout(60)
    check('O4 已弹过后换到相邻钮立刻弹(skip-delay)', (await tipText()) === 'Top B', String(await tipText()))
    await page.mouse.down()
    await page.waitForTimeout(30)
    check('O5 按下鼠标即收', (await tipText()) === null, String(await tipText()))
    await page.mouse.up()
    await page.waitForTimeout(1300)
    check('O5b 点完鼠标还停在原钮上不再重新弹', (await tipText()) === null, String(await tipText()))
    await page.mouse.move(400, 400)
    await page.evaluate(() => window.__rb.getState().toggleExpanded())
    await page.waitForTimeout(80)
    c = await center('.rb-top .rb-slot[data-id="tA"] .rb-btn')
    await page.mouse.move(c.x, c.y)
    await page.waitForTimeout(1200)
    check('O6 展开态(名称已可见)不弹浮签', (await tipText()) === null, String(await tipText()))
    await page.evaluate(() => window.__rb.getState().toggleExpanded())
    await page.mouse.move(400, 400)
    await page.evaluate(() => window.__rb.getState().addCommandItem('h-toggle'))
    await page.waitForTimeout(80)
    const tgl = '.rb-bottom .rb-slot[data-id="cmd:h-toggle"] .rb-btn'
    const before = await page.$eval(tgl, (e) => ({ pressed: e.getAttribute('aria-pressed'), on: e.classList.contains('is-on') }))
    await page.click(tgl)
    await page.waitForTimeout(60)
    const after = await page.$eval(tgl, (e) => ({ pressed: e.getAttribute('aria-pressed'), on: e.classList.contains('is-on') }))
    check('O7 开关类命令钉进命令区:点前 aria-pressed=false、点后 true 且 .is-on', before.pressed === 'false' && !before.on && after.pressed === 'true' && after.on, `${JSON.stringify(before)} → ${JSON.stringify(after)}`)
    const plain = await page.$eval('.rb-bottom .rb-slot[data-id="bA"] .rb-btn', (e) => e.hasAttribute('aria-pressed'))
    check('O8 非开关项不带 aria-pressed(不然读屏报「未按下」)', !plain)
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
