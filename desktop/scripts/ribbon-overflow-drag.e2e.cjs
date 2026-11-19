/** Ribbon「+N」溢出浮层里的拖拽(2026-11-19 用户报:浮层里的条目拖不动了,Space 区和命令区都一样)。
 *
 * 真鼠标拖(按下 → 分步移动 → 松手),不手搓 DragEvent:按下那一刻「点别处就收浮层」也在被测范围里。
 * 每区三条路,各钉「松手前画出的落点 == 松手后的顺序」:
 *   R  浮层内重排(上移一格到首行 / 下移到末行)
 *   O  浮层 → 条上(拖出来常驻)
 *   I  条上 → 浮层的某一行(收进去,落在那一行之前),按下条上那一格时浮层不能先收走
 *   P  重载后顺序还在(持久化;只 --electron,harness 每次加载都重设顺序)
 * 顺序一律按「整区排布」比:上区 = 条上 + 浮层,命令区 = 浮层 + 条上(命令区的「+N」吃列表头)。
 *
 * 跑:
 *   node scripts/ribbon-overflow-drag.e2e.cjs                 浏览器 harness:原生 DnD 两区 + &pointer 指针拖拽(Windows 那条)
 *   node scripts/ribbon-overflow-drag.e2e.cjs --electron      真 Electron(先 npm run build),隔离 home,默认就有溢出
 *     仓根:node .claude/hooks/devlock.cjs run --vehicle=e2e --what="Ribbon 溢出拖拽" --eta=3 -- node <本脚本> --electron
 * HARNESS_URL 覆盖 harness 地址(默认 5173;没起会自起 vite,跑完自收)。
 * ⚠️ Playwright 的拖拽走 CDP 拦截,不经 mac 系统拖拽会话,也不看 -webkit-app-region —— 绿 ≠ 真机拖得动,真机另验。
 */
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), assert = require('assert/strict')
const { spawn } = require('child_process')
const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'outputs', 'ribbon-overflow-drag')
fs.mkdirSync(OUT, { recursive: true })
const ELECTRON = process.argv.includes('--electron')
const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const SETTLE = 700 // > 液滴 420ms

const fly = (zone) => `.rb-more-fly[data-rb-more-fly="${zone}"]`
const barIds = (page, zone) => page.locator(`.rb-${zone} .rb-slot`).evaluateAll((els) => els.map((el) => el.dataset.id))
// 浮层里的顶层行(收纳夹成员行不算:它们归收纳夹的顺序)
const flyIds = (page, zone) => page.locator(`${fly(zone)} > .rb-fly-row[data-id]`).evaluateAll((els) => els.map((el) => el.dataset.id))
async function layout(page, zone) {
  const bar = await barIds(page, zone)
  const rows = (await page.locator(fly(zone)).count()) ? await flyIds(page, zone) : []
  return zone === 'top' ? [...bar, ...rows] : [...rows, ...bar]
}
const moveTo = (list, id, to) => { const out = list.filter((x) => x !== id); out.splice(Math.max(0, Math.min(to, out.length)), 0, id); return out }
const insertBefore = (list, id, before) => { const out = list.filter((x) => x !== id); out.splice(out.indexOf(before), 0, id); return out }

async function openFly(page, zone) {
  if (await page.locator(fly(zone)).count()) return
  await page.locator(`.rb-${zone} .rb-more`).click()
  await page.waitForTimeout(SETTLE)
  assert.equal(await page.locator(fly(zone)).count(), 1, `${zone}: flyout opens`)
}
const center = async (page, sel) => { const b = await page.locator(sel).first().boundingBox(); assert.ok(b, `no box for ${sel}`); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }

/** 真鼠标拖:from / to 是选择器;松手前采一帧(落点线 / 浮层还在不在 / 有没有进拖动态)。 */
async function drag(page, fromSel, toSel, shot) {
  const a = await center(page, fromSel)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.waitForTimeout(60)
  const b = await center(page, toSel) // 按下之后再量:按下若把浮层收了,这里就量到收起途中的位置
  const steps = 14
  for (let i = 1; i <= steps; i++) await page.mouse.move(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps)
  await page.mouse.move(b.x + 1, b.y) // 再补一发:最后一发 dragover 的渲染落到下一帧
  await page.waitForTimeout(220)
  const mid = await page.evaluate(() => ({
    dragging: !!document.querySelector('.rb.rb-dragging'),
    fly: [...document.querySelectorAll('.rb-more-fly')].map((e) => e.dataset.rbMoreFly).join(),
    line: [...document.querySelectorAll('.rb-fly-row.drag-over, .rb-slot.drag-over')].map((e) => e.dataset.id + (e.classList.contains('below') ? ':below' : '')),
    preview: [...document.querySelectorAll('.rb-group .rb-slot')].filter((e) => e.style.transform).map((e) => e.dataset.id),
  }))
  if (shot) await page.screenshot({ path: shot, clip: { x: 0, y: 0, width: 360, height: page.viewportSize()?.height ?? 900 } })
  await page.mouse.up()
  await page.waitForTimeout(400)
  return mid
}

const results = []
async function step(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS ${name}`) }
  catch (e) { results.push({ name, ok: false }); console.log(`FAIL ${name}\n     ${String(e.message).split('\n').join('\n     ')}`) }
}

/** 一区的四条路。pick(rows) 挑浮层里能拖的行(命令区避开设备胶囊那种自带交互的组件条目)。 */
async function zoneSuite(page, zone, { label, reload, pick = (rows) => rows }) {
  const tag = `${label} ${zone}`
  await step(`${tag} R1 浮层内上移:末行拖到首行`, async () => {
    await openFly(page, zone)
    const rows = pick(await flyIds(page, zone)), before = await layout(page, zone)
    assert.ok(rows.length >= 2, `need ≥2 draggable rows, got ${rows}`)
    const d = rows.at(-1), t = rows[0]
    const mid = await drag(page, `${fly(zone)} > [data-id="${d}"]`, `${fly(zone)} > [data-id="${t}"]`, ELECTRON && path.join(OUT, `electron-${zone}-reorder-line.png`))
    assert.ok(mid.dragging, `drag started from a flyout row: ${JSON.stringify(mid)}`)
    assert.deepEqual(mid.line, [t], `insertion line on the target row (above it): ${JSON.stringify(mid)}`)
    assert.deepEqual(await layout(page, zone), moveTo(before, d, before.indexOf(t)), 'committed where the line was')
  })
  await step(`${tag} R2 浮层内下移:首行拖到末行`, async () => {
    await openFly(page, zone)
    const rows = pick(await flyIds(page, zone)), before = await layout(page, zone)
    const d = rows[0], t = rows.at(-1)
    const mid = await drag(page, `${fly(zone)} > [data-id="${d}"]`, `${fly(zone)} > [data-id="${t}"]`)
    assert.deepEqual(mid.line, [`${t}:below`], `moving down draws the line under the target: ${JSON.stringify(mid)}`)
    assert.deepEqual(await layout(page, zone), moveTo(before, d, before.indexOf(t)))
  })
  await step(`${tag} O 浮层 → 条上第 2 格`, async () => {
    await openFly(page, zone)
    const rows = pick(await flyIds(page, zone)), bar = await barIds(page, zone), before = await layout(page, zone)
    const d = rows[0], t = bar[1]
    const mid = await drag(page, `${fly(zone)} > [data-id="${d}"]`, `.rb-${zone} .rb-slot[data-id="${t}"]`)
    assert.ok(mid.dragging, JSON.stringify(mid))
    assert.deepEqual(mid.line, [t], `bar shows where it lands: ${JSON.stringify(mid)}`)
    assert.deepEqual(await layout(page, zone), moveTo(before, d, before.indexOf(t)))
    assert.equal((await barIds(page, zone))[1], d, 'now pinned on the bar')
  })
  await step(`${tag} I 条上 → 浮层某行之前(按下条上那格时浮层不收)`, async () => {
    await openFly(page, zone)
    const rows = pick(await flyIds(page, zone)), bar = (await barIds(page, zone)).filter((id) => pick([id]).length), before = await layout(page, zone)
    const d = bar[1], t = rows[1] ?? rows[0]
    const mid = await drag(page, `.rb-${zone} .rb-slot[data-id="${d}"]`, `${fly(zone)} > [data-id="${t}"]`)
    assert.equal(mid.fly, zone, `flyout stays open while dragging from the bar: ${JSON.stringify(mid)}`)
    assert.deepEqual(mid.line, [t], `line above the target row: ${JSON.stringify(mid)}`)
    assert.deepEqual(await layout(page, zone), insertBefore(before, d, t))
    assert.ok((await flyIds(page, zone)).includes(d), 'it is in the flyout now')
  })
  await step(`${tag} C 条上单击一格:浮层照样收`, async () => {
    await openFly(page, zone)
    const id = (await barIds(page, zone)).find((x) => pick([x]).length)
    // 只点不拖:拿 mousedown/up 不带位移,浮层要收(原来按下就收,现在改在 click 收)
    await page.evaluate((sel) => { const el = document.querySelector(sel); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true })); el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })) }, `.rb-${zone} .rb-slot[data-id="${id}"] .rb-btn`)
    await page.waitForTimeout(SETTLE)
    assert.equal(await page.locator(fly(zone)).count(), 0, 'click on a bar slot retracts the flyout')
  })
  if (reload) await step(`${tag} P 重载后顺序还在`, async () => {
    await openFly(page, zone)
    const before = await layout(page, zone)
    await reload()
    await openFly(page, zone)
    assert.deepEqual(await layout(page, zone), before)
    await page.keyboard.press('Escape'); await page.waitForTimeout(SETTLE)
  })
}

function ping(url) {
  return new Promise((res) => { const req = http.get(url, (r) => { res(r.statusCode === 200); r.resume() }); req.on('error', () => res(false)); req.setTimeout(1500, () => { req.destroy(); res(false) }) })
}

async function harness() {
  const { chromium } = require('playwright-core')
  const { findChromium } = require('./lib/find-chromium.cjs')
  let vite = null
  if (!(await ping(BASE))) {
    vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'frontend'], { cwd: ROOT, stdio: 'ignore', windowsHide: true })
    for (let i = 0; i < 60 && !(await ping(BASE)); i++) await new Promise((r) => setTimeout(r, 500))
  }
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    for (const mode of ['native', 'pointer']) {
      const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1000, height: 1000 } })
      await page.addInitScript(() => { if (!sessionStorage.getItem('rbKeep')) { localStorage.clear(); sessionStorage.setItem('rbKeep', '1') } })
      const url = `${BASE}?ribbon${mode === 'pointer' ? '&pointer' : ''}`
      const seed = () => page.evaluate((mode) => {
        const s = window.__rb.getState(), icon = s.items[0].icon
        const has = (id) => s.items.some((i) => i.id === id)
        if (mode === 'native') for (const n of ['E', 'F', 'G', 'H', 'I']) if (!has('t' + n)) s.addRibbonIcon({ id: 't' + n, side: 'top', icon, tooltip: n })
        for (const n of ['D', 'E', 'F', 'G', 'H']) if (!has('b' + n)) s.addRibbonIcon({ id: 'b' + n, side: 'bottom', icon, tooltip: n })
      }, mode)
      const load = async () => { await page.goto(url); await page.locator('.rb-top .rb-slot').first().waitFor(); await seed(); await page.waitForTimeout(300) }
      await load()
      // harness 每次加载都重设顺序,持久化只在 --electron 里验
      await zoneSuite(page, 'top', { label: mode })
      if (mode === 'native') await zoneSuite(page, 'bottom', { label: mode })
      if (mode === 'pointer') {
        await step('pointer 浮层里的 Space 拖到窗外仍是撕出开窗', async () => {
          await openFly(page, 'top')
          const d = (await flyIds(page, 'top'))[0]
          const a = await center(page, `${fly('top')} > [data-id="${d}"]`)
          await page.mouse.move(a.x, a.y); await page.mouse.down()
          for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + 60 * i, a.y)
          await page.mouse.up(); await page.waitForTimeout(300)
          assert.deepEqual(await page.evaluate(() => window.__rbTorn), [d.slice('space:'.length)])
        })
      }
      await page.close()
    }
  } finally { await browser.close(); vite?.kill() }
}

async function electronRun() {
  const electron = require('./lib/launch-electron.cjs')
  const { startStubEngine } = require('./lib/stub-engine.cjs')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-ribbon-overflow-drag-'))
  const stub = await startStubEngine()
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1' }, timeout: 60000 })
    const page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    await page.locator('#root').waitFor()
    await page.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = page.getByRole('button', { name: label, exact: true })
      if (await b.count()) { await b.click(); break }
    }
    await page.locator('.rb-bottom .rb-more').waitFor()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 1000))
    await page.waitForTimeout(500)
    const reload = async () => { await page.reload(); await page.locator('.rb-bottom .rb-more').waitFor(); await page.waitForTimeout(1500) }
    // 命令区藏着设备胶囊(组件条目,自己吃指针)—— 它不在本次范围,挑普通命令拖
    const plain = (rows) => rows.filter((id) => id !== 'rb-unit')
    for (const zone of ['top', 'bottom']) await zoneSuite(page, zone, { label: 'electron', reload, pick: zone === 'bottom' ? plain : undefined })
    await openFly(page, 'top')
    await page.screenshot({ path: path.join(OUT, 'electron-top-open.png') })
    console.log(`screenshot: ${path.join(OUT, 'electron-top-open.png')}`)
  } finally { await app?.close(); stub.close?.() }
}

;(async () => {
  await (ELECTRON ? electronRun() : harness())
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} passed`)
  process.exit(bad.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
