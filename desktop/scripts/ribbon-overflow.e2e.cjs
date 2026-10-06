/** Ribbon overflow: frame sampling + real pointer hits through the Unit menu.
 * Run with a local harness: HARNESS_URL=http://localhost:5176/harness.html node scripts/ribbon-overflow.e2e.cjs
 * --electron checks the built app, default registration order and light/dark/narrow screenshots.
 */
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict')
const { chromium } = require('playwright-core')
const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'outputs', 'ribbon-overflow')
fs.mkdirSync(OUT, { recursive: true })
const sleep = (page) => page.waitForTimeout(300)
const ids = (page, zone) => page.locator(`.rb-${zone} .rb-slot`).evaluateAll((els) => els.map((el) => el.dataset.id))

async function sample(page, zone) {
  return page.evaluate(async (zone) => {
    const strip = document.querySelector(`.rb-${zone} .rb-strip`)
    const slots = strip.querySelectorAll('.rb-slot')
    const anchor = zone === 'top' ? slots[0] : slots[slots.length - 1]
    const rows = []
    const read = () => rows.push({ h: strip.getBoundingClientRect().height, y: anchor.getBoundingClientRect().top,
      filled: strip.querySelectorAll('.rb-cell button').length })
    read()
    document.querySelector(`.rb-${zone} .rb-more`).click()
    const start = performance.now()
    while (performance.now() - start < 320) { await new Promise(requestAnimationFrame); read() }
    return rows
  }, zone)
}
function verifyMotion(rows, name) {
  const first = rows[0], last = rows.at(-1), delta = last.h - first.h
  assert.ok(Math.abs(delta) > 20, `${name}: changes height`)
  const middle = rows.filter((r) => r.h > Math.min(first.h, last.h) + 1 && r.h < Math.max(first.h, last.h) - 1)
  assert.ok(middle.length >= 3, `${name}: gradual height, ${JSON.stringify(rows)}`)
  assert.ok(Math.max(...rows.map((r) => r.y)) - Math.min(...rows.map((r) => r.y)) < 2, `${name}: anchored icons do not jump, ${JSON.stringify(rows)}`)
  for (let i = 1; i < rows.length; i++) assert.ok((rows[i].h - rows[i - 1].h) * Math.sign(delta) >= -1, `${name}: monotonic`)
  if (delta < 0) assert.ok(middle.some((r) => r.filled > 0), `${name}: outgoing icons retained`)
  console.log(`PASS ${name}: ${middle.length} intermediate frames, anchor stable`)
}

async function menuHit(page) {
  await page.locator('.unitsw-pill').click()
  await page.locator('.unitsw-menu .unitsw-row').first().waitFor()
  await sleep(page)
  const hit = await page.locator('.unitsw-menu .unitsw-row').first().evaluate((el) => {
    const r = el.getBoundingClientRect()
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
  })
  assert.ok(hit, 'Unit menu is painted and receives pointer hits outside the ribbon')
  await page.locator('.unitsw-menu .unitsw-row').first().click()
  await page.locator('.unitsw-menu').waitFor({ state: 'detached' })
}

async function harness() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXE || chromium.executablePath(), headless: true })
  try {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1000, height: 1000 } })
    await page.addInitScript(() => localStorage.clear())
    await page.goto(`${process.env.HARNESS_URL || 'http://localhost:5173/harness.html'}?ribbon&unit`)
    await page.locator('.unitsw-pill').waitFor()
    await page.evaluate(() => {
      const s = window.__rb.getState(), icon = s.items[0].icon
      for (const n of ['E', 'F']) s.addRibbonIcon({ id: 't' + n, side: 'top', icon, tooltip: n })
      for (const n of ['D', 'E']) s.addRibbonIcon({ id: 'b' + n, side: 'bottom', icon, tooltip: n })
      s.addRibbonIcon({ id: 'pin', side: 'bottom', pinned: true, icon, tooltip: 'Account' })
      s.setZoneOrder('bottom', ['bA', 'bB', 'bC', 'rb-unit', 'bD', 'bE'])
    })
    await sleep(page)
    assert.equal((await ids(page, 'top')).length, 5)
    assert.equal((await ids(page, 'bottom')).length, 5)
    assert.equal(await page.locator('.rb-pinned button').count(), 1)
    console.log('PASS five icons per zone, account separate')
    await page.evaluate(() => {
      const s = window.__rb.getState(), icon = s.items[0].icon
      for (const n of ['G', 'H', 'I']) s.addRibbonIcon({ id: 't' + n, side: 'top', icon, tooltip: n })
      for (const n of ['F', 'G', 'H']) s.addRibbonIcon({ id: 'b' + n, side: 'bottom', icon, tooltip: n })
      s.setZoneOrder('bottom', ['bA', 'bB', 'bC', 'rb-unit', 'bD', 'bE', 'bF', 'bG', 'bH'])
    })
    await sleep(page)
    for (const zone of ['top', 'bottom']) {
      verifyMotion(await sample(page, zone), `${zone} expand`)
      verifyMotion(await sample(page, zone), `${zone} collapse`)
    }
    // Wheel gesture interrupted by expansion must not commit its stale offset later.
    await page.locator('.rb-bottom').dispatchEvent('wheel', { deltaY: -24 })
    await page.waitForTimeout(45)
    await page.locator('.rb-bottom .rb-more').click()
    await sleep(page)
    assert.equal((await ids(page, 'bottom')).length, 9)
    await menuHit(page)
    assert.equal(await page.locator('.rb-open-bottom').count(), 1, 'clicking portal menu does not collapse/unmount owner')
    await page.locator('.rb-bottom .rb-more').click()
    await sleep(page)
    // Expose Unit in a translated, clipped strip: this was invisible despite a menu DOM existing.
    await page.locator('.rb-bottom').dispatchEvent('wheel', { deltaY: -36 })
    await page.waitForTimeout(450)
    assert.ok((await ids(page, 'bottom')).includes('rb-unit'))
    await menuHit(page)
    console.log('PASS Unit menu receives real clicks with overflow translation and expanded zone')
    // Negative control: the old missing height transition must be caught by the frame assertion.
    const noMotion = await page.addStyleTag({ content: '.rb-strip { transition: none !important }' })
    const lastNegative = await sample(page, 'top')
    assert.throws(() => verifyMotion(lastNegative, 'negative control'), /gradual height/)
    await noMotion.evaluate((el) => el.remove())
    await page.locator('.rb-top .rb-more').click()
    await sleep(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.locator('.rb-top .rb-more').click()
    await page.waitForTimeout(40)
    assert.ok(await page.locator('.rb-top .rb-strip').evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration) < 0.001))
    console.log('PASS reduced motion disables transitions')
  } finally { await browser.close() }
}

async function electronRun() {
  const electron = require('./lib/launch-electron.cjs')
  const { startStubEngine } = require('./lib/stub-engine.cjs')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-ribbon-overflow-'))
  const stub = await startStubEngine()
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url }, timeout: 60000 })
    const page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    await page.locator('#root').waitFor()
    await page.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = page.getByRole('button', { name: label, exact: true })
      if (await b.count()) { await b.click(); break }
    }
    await page.locator('.rb-bottom').waitFor()
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1100, 1000) })
    await sleep(page)
    assert.equal((await ids(page, 'bottom')).length, 5)
    await page.locator('.rb-bottom .rb-more').click()
    await sleep(page)
    assert.deepEqual(await ids(page, 'bottom'), ['rb-achievements', 'rb-unit', 'rb-feedback', 'rb-market', 'rb-mode', 'rb-cmd', 'rb-settings'])
    await menuHit(page)
    for (const mode of ['light', 'dark']) {
      await page.evaluate((mode) => { document.documentElement.dataset.mode = mode; document.documentElement.classList.toggle('dark', mode === 'dark') }, mode)
      await page.locator('.unitsw-pill').click()
      await sleep(page)
      await page.screenshot({ path: path.join(OUT, `electron-${mode}.png`) })
      await page.locator('.unitsw-menu .unitsw-row').first().click()
    }
    await page.locator('.rb-bottom .rb-more').click()
    await sleep(page)
    await page.locator('.rb-bottom').dispatchEvent('wheel', { deltaY: -36 })
    await page.waitForTimeout(450)
    await menuHit(page)
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(600, 600); w.setSize(700, 700) })
    await sleep(page)
    await page.locator('.rb-bottom .rb-more').click()
    await sleep(page)
    await menuHit(page)
    await page.locator('.unitsw-pill').click()
    await sleep(page)
    await page.screenshot({ path: path.join(OUT, 'electron-narrow.png') })
    console.log(`PASS real Electron: default order, 5 commands, menu clicks after scrolling/expanding, light/dark/narrow. Screenshots: ${OUT}`)
  } finally { if (app) await app.close(); await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
}
;(process.argv.includes('--electron') ? electronRun() : harness()).catch((e) => { console.error(e); process.exitCode = 1 })
