/** Ribbon overflow (2026-10-30): 「+N」count + side flyout that pours out of the button (lcl/engine/droplet.ts).
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
const fly = (zone) => `.rb-more-fly[data-rb-more-fly="${zone}"]`
const rows = (page, zone) => page.locator(`${fly(zone)} [data-id]`).evaluateAll((els) => els.map((el) => el.dataset.id))
const SETTLE = 700 // > --droplet-duration (420ms) with margin

/** Click 「+N」 in-page and sample the pour: Playwright's own click costs ~100ms, too coarse for a 420ms animation. */
async function pour(page, zone) {
  return page.evaluate(async (zone) => {
    const btn = document.querySelector(`[data-rb-more="${zone}"]`)
    const n = Number(btn.textContent.match(/\+(\d+)/)[1])
    btn.click()
    const frames = []
    const t0 = performance.now()
    while (performance.now() - t0 < 600) {
      await new Promise(requestAnimationFrame)
      const p = document.querySelector(`.rb-more-fly[data-rb-more-fly="${zone}"]`), layer = document.querySelector('.lcl-droplet')
      frames.push({ t: performance.now() - t0, pouring: !!p?.classList.contains('lcl-droplet-pouring'), bg: p && getComputedStyle(p).backgroundColor,
        layer: !!layer && getComputedStyle(layer).display !== 'none', clip: p && getComputedStyle(p).clipPath })
    }
    return { n, frames }
  }, zone)
}
function verifyPour({ frames }, name) {
  const mid = frames.filter((f) => f.t > 60 && f.t < 300)
  assert.ok(mid.length >= 3 && mid.every((f) => f.pouring && f.layer), `${name}: liquid visible while pouring, ${JSON.stringify(mid.slice(0, 3))}`)
  // 真面板不能早于液体停稳出现(10-29 打回):pouring 期间面板自己没有底色
  assert.ok(mid.every((f) => /rgba\(0, 0, 0, 0\)|transparent/.test(f.bg)), `${name}: panel has no fill of its own while pouring, ${mid[0].bg}`)
  assert.ok(new Set(mid.map((f) => f.clip)).size >= 3, `${name}: clip-path follows the liquid`)
  const end = frames.at(-1)
  assert.ok(!end.pouring && !end.layer && end.clip === 'none', `${name}: real panel takes over, ${JSON.stringify(end)}`)
  console.log(`PASS ${name}: ${mid.length} pouring frames, handed over to the real panel`)
}
async function retractSample(page, zone) {
  return page.evaluate(async (zone) => {
    document.querySelector(`[data-rb-more="${zone}"]`).click()
    await new Promise((r) => setTimeout(r, 40))
    const p = document.querySelector(`.rb-more-fly[data-rb-more-fly="${zone}"]`), layer = document.querySelector('.lcl-droplet')
    return { panel: !!p, pouring: !!p?.classList.contains('lcl-droplet-pouring'), layer: !!layer && getComputedStyle(layer).display !== 'none' }
  }, zone)
}
const leftovers = (page) => page.evaluate(() => ({ fly: document.querySelectorAll('.rb-more-fly').length, layer: document.querySelectorAll('.lcl-droplet').length, open: document.querySelectorAll('.rb-more.is-open').length }))

// 胶囊点开 = 设置 › 设备(10-17 撤了弹出菜单);这里只证它画出来、中心点能点中(不被裁 / 不被液体层盖)
async function capsuleHit(page) {
  const hit = await page.locator('.unitsw-pill').evaluate((el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
  })
  assert.ok(hit, 'Unit capsule is painted and receives pointer hits')
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
      const barBefore = await ids(page, zone), other = zone === 'top' ? 'bottom' : 'top', otherBefore = await ids(page, other)
      const sample = await pour(page, zone)
      verifyPour(sample, `${zone} open`)
      const listed = await rows(page, zone)
      assert.equal(listed.length, sample.n, `${zone}: +N == rows in the flyout (${listed})`)
      assert.ok(listed.every((id) => !barBefore.includes(id)), `${zone}: flyout lists only what the bar hides`)
      assert.deepEqual(await ids(page, zone), barBefore, `${zone}: bar does not move`)
      assert.deepEqual(await ids(page, other), otherBefore, `${zone}: the other zone stays`)
      assert.equal(await page.locator(`[data-rb-more="${zone}"]`).getAttribute('aria-expanded'), 'true')
      const r = await retractSample(page, zone)
      assert.ok(r.panel && r.pouring && r.layer, `${zone}: clicking +N again retracts (pours back), not vanishes: ${JSON.stringify(r)}`)
      await page.waitForTimeout(SETTLE)
      assert.deepEqual(await leftovers(page), { fly: 0, layer: 0, open: 0 }, `${zone}: retract cleans up`)
      console.log(`PASS ${zone}: +${sample.n} lists the hidden ${sample.n}, bar steady, retracts on second click`)
    }
    // Esc / click elsewhere / picking a row all retract
    for (const how of ['esc', 'outside', 'row']) {
      await page.locator('.rb-top .rb-more').click()
      await page.waitForTimeout(SETTLE)
      if (how === 'esc') await page.keyboard.press('Escape')
      else if (how === 'outside') await page.mouse.click(700, 500)
      else await page.locator(`${fly('top')} [data-id] .rb-btn`).first().click()
      await page.waitForTimeout(SETTLE)
      assert.deepEqual(await leftovers(page), { fly: 0, layer: 0, open: 0 }, `${how} retracts`)
    }
    console.log('PASS Esc / click elsewhere / picking a row retract the flyout')
    // Interrupted: retract mid-pour continues from that frame, nothing left behind
    await page.evaluate(async () => { const b = document.querySelector('[data-rb-more="top"]'); b.click(); await new Promise((r) => setTimeout(r, 120)); b.click() })
    await page.waitForTimeout(SETTLE)
    assert.deepEqual(await leftovers(page), { fly: 0, layer: 0, open: 0 }, 'mid-pour retract cleans up')
    console.log('PASS retract mid-pour')
    // Unit capsule hidden in the command flyout: hit-testable there, clicking it retracts the flyout
    await page.locator('.rb-bottom .rb-more').click()
    await page.waitForTimeout(SETTLE)
    assert.ok((await rows(page, 'bottom')).includes('rb-unit'))
    await capsuleHit(page)
    await page.locator('.unitsw-pill').click()
    await page.waitForTimeout(SETTLE)
    assert.deepEqual(await leftovers(page), { fly: 0, layer: 0, open: 0 }, 'clicking the capsule row retracts the flyout')
    // Expose Unit in a translated, clipped strip: this was invisible despite a menu DOM existing.
    await page.locator('.rb-bottom').dispatchEvent('wheel', { deltaY: -36 })
    await page.waitForTimeout(450)
    assert.ok((await ids(page, 'bottom')).includes('rb-unit'))
    await capsuleHit(page)
    console.log('PASS Unit capsule is clickable from the flyout and from a scrolled strip')
    // Negative control: a panel painting its own fill while pouring (the 10-29 regression) must be caught.
    const neg = await page.addStyleTag({ content: '.lcl-droplet-pouring { background: var(--bg-card, #fff) !important }' })
    await page.locator('.rb-bottom').dispatchEvent('wheel', { deltaY: 200 }); await page.waitForTimeout(800)
    const negSample = await pour(page, 'top')
    assert.throws(() => verifyPour(negSample, 'negative control'), /no fill of its own/)
    await neg.evaluate((el) => el.remove())
    await page.keyboard.press('Escape')
    await page.waitForTimeout(SETTLE)
    console.log('PASS negative control: early panel fill is caught')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.locator('.rb-top .rb-more').click()
    await page.waitForTimeout(40)
    assert.equal(await page.locator('.lcl-droplet').count(), 0, 'reduced motion: no liquid')
    assert.equal(await page.locator(fly('top')).count(), 1)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    assert.deepEqual(await leftovers(page), { fly: 0, layer: 0, open: 0 })
    console.log('PASS reduced motion: fade only')
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
    await page.waitForTimeout(SETTLE)
    assert.deepEqual([...await rows(page, 'bottom'), ...await ids(page, 'bottom')], ['rb-achievements', 'rb-unit', 'rb-feedback', 'rb-market', 'rb-mode', 'rb-cmd', 'rb-settings'])
    await capsuleHit(page)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(SETTLE)
    for (const mode of ['light', 'dark']) {
      await page.evaluate((mode) => { document.documentElement.dataset.mode = mode; document.documentElement.classList.toggle('dark', mode === 'dark') }, mode)
      // 冻在 190ms(液体半长、丝还连着)截一张,截图延迟盖不住 420ms,不冻拍到的已经流完了
      await page.evaluate(async () => { document.querySelector('.rb-bottom .rb-more').click(); await new Promise(requestAnimationFrame); document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 190 }) })
      await page.screenshot({ path: path.join(OUT, `electron-${mode}-pour.png`) })
      await page.evaluate(() => document.getAnimations().forEach((a) => a.play()))
      await page.waitForTimeout(SETTLE)
      await page.screenshot({ path: path.join(OUT, `electron-${mode}.png`) })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(SETTLE)
    }
    await page.locator('.rb-bottom').dispatchEvent('wheel', { deltaY: -36 })
    await page.waitForTimeout(450)
    await capsuleHit(page)
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(600, 600); w.setSize(700, 700) })
    await sleep(page)
    await page.locator('.rb-top .rb-more').click()
    await page.waitForTimeout(SETTLE)
    await page.screenshot({ path: path.join(OUT, 'electron-narrow.png') })
    console.log(`PASS real Electron: default order, 5 commands + flyout, menu clicks from the flyout and after scrolling, light/dark/narrow. Screenshots: ${OUT}`)
  } finally { if (app) await app.close(); await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
}
;(process.argv.includes('--electron') ? electronRun() : harness()).catch((e) => { console.error(e); process.exitCode = 1 })
