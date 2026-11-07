/** Actual React composer, stable triggers, nested pages, View bounds and zoom. */
const fs = require('fs'), os = require('os'), path = require('path')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')
const base = new URL('/composer-narrow-harness.html', process.env.HARNESS_URL || 'http://localhost:5173')
const output = process.env.NARROW_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-composer-narrow-'))
fs.mkdirSync(output, { recursive: true })
const results = [], errors = []
function check(name, ok, detail) { results.push({ name, ok, detail }); if (!ok) console.log('FAIL ' + name + ' ' + JSON.stringify(detail)) }
const settle = p => p.waitForTimeout(150)
async function geometry(p, name) {
  const state = await p.evaluate(() => {
    const card = document.querySelector('.t2c-card'), r = card.getBoundingClientRect()
    const controls = [...card.querySelectorAll('.add-pill-btn,.mode-pill-btn,.model-pill-btn,.t2c-send,.t2c-stop,.t2c-mic-control,.t2c-ctxring-btn')]
      .filter(e => e.checkVisibility()).map(e => { const b = e.getBoundingClientRect(); return { name: e.className, x: b.left, y: b.top, w: b.width, h: b.height, inside: b.left >= r.left && b.right <= r.right + 1 && b.top >= r.top && b.bottom <= r.bottom + 1 } })
    const view = document.querySelector('.t2-chat-view').getBoundingClientRect()
    const menus = [...document.querySelectorAll('.composer-menu--compact:not([data-lcl-exit])')].filter(e => e.checkVisibility())
      .map(e => { const b = e.getBoundingClientRect(); const x = b.left + Math.min(12, b.width / 2), y = b.top + Math.min(12, b.height / 2)
        return { x: b.left, y: b.top, w: b.width, h: b.height, over: e.scrollWidth - e.clientWidth,
          inside: b.left >= Math.max(0, view.left) && b.right <= Math.min(innerWidth, view.right) + 1 && b.top >= Math.max(0, view.top) && b.bottom <= Math.min(innerHeight, view.bottom) + 1,
          hit: e.contains(document.elementFromPoint(x, y)) } })
    return { controls, menus }
  })
  check(name + ' controls stay inside card', state.controls.length >= 4 && state.controls.every(c => c.inside), state.controls)
  check(name + ' popup inside View and hittable', state.menus.every(m => m.inside && m.hit && m.over <= 1), state.menus)
}
;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, locale: 'zh-CN' })
    page.on('pageerror', e => errors.push(String(e)))
    for (const lang of ['zh', 'en']) for (const zoom of [1, 1.1]) {
      await page.goto(`${base}?lang=${lang}&zoom=${zoom}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
      await page.waitForSelector('.model-pill-compact:visible', { timeout: 60000 })
      for (const width of [280, 320, 420, 520]) for (const running of [false, true]) {
        await page.evaluate(({ width, running }) => window.__narrow.set({ width, height: 620, running, model: running ? 'long' : 'gpt-6-luna' }), { width, running })
        await settle(page)
        if (running) await page.locator('.t2c-ta').fill('steer draft')
        const label = `${lang} ${zoom} ${width} ${running ? 'running-long' : 'idle'}`
        await geometry(page, label)
        for (const selector of ['.model-pill-btn', '.mode-pill-btn', '.add-pill-btn']) {
          const trigger = page.locator(selector).first()
          const before = await trigger.boundingBox(), sendBefore = await page.locator('.t2c-send,.t2c-stop').last().boundingBox()
          await trigger.click(); await settle(page); await geometry(page, label + ' ' + selector)
          const after = await trigger.boundingBox(), sendAfter = await page.locator('.t2c-send,.t2c-stop').last().boundingBox()
          check(label + ' stable ' + selector, Math.abs(before.width - after.width) < 1 && Math.abs(sendBefore.x - sendAfter.x) < 1, { before, after, sendBefore, sendAfter })
          await page.keyboard.press('Escape'); await settle(page)
        }
        if (width === 320 && !running && zoom === 1.1) {
          await page.locator('.model-pill-btn').click(); await settle(page)
          await page.screenshot({ path: path.join(output, `model-${lang}-110.png`) })
          await page.keyboard.press('Escape')
        }
      }
    }
    await page.evaluate(() => window.__narrow.set({ width: 280, height: 380, running: false, model: 'gpt-6-luna' }))
    await page.locator('.t2c-ta').fill('')
    await page.locator('.add-pill-btn').click(); await settle(page)
    check('tight context and voice remain in Add', await page.locator('[data-composer-overflow="context"]').isVisible() && await page.locator('[data-composer-overflow="voice"]').isVisible())
    await page.locator('[data-composer-overflow="context"]').click(); await settle(page)
    check('tight context opens actual usage panel', await page.locator('.t2c-ctxring-pop.composer-menu--compact').isVisible())
    await geometry(page, 'tight short context')
    await page.keyboard.press('Escape')
    check('context Escape restores Add focus', await page.locator('.add-pill-btn').evaluate(e => document.activeElement === e))
    await page.locator('.model-pill-btn').click(); await page.locator('.cm-model-row').click(); await settle(page)
    check('model list replaces main menu', await page.locator('.cm-sub--inline').isVisible() && !(await page.locator('.cm-model-row').isVisible()))
    await geometry(page, 'short model list')
    await page.locator('.model-picker-search input').fill('deployment')
    const choice = page.locator('.cm-sub--inline .menu-item').filter({ hasText: 'Research / Very long' })
    check('search finds full long model name', await choice.count() === 1)
    await page.keyboard.press('Escape')
    check('first Escape returns to model row', await page.locator('.cm-model-row').isVisible())
    await page.keyboard.press('Escape')
    check('second Escape restores model trigger focus', await page.locator('.model-pill-btn').evaluate(e => document.activeElement === e))
    await page.locator('.add-pill-btn').click()
    await page.locator('[data-add-pane="view"]').click(); await settle(page)
    check('Add submenu replaces its parent', await page.locator('.add-menu-search input').isVisible() && !(await page.locator('[data-add-pane="view"]').isVisible()))
    await page.keyboard.press('Escape')
    check('Add Escape returns to parent row', await page.locator('[data-add-pane="view"]').isVisible())
    await page.keyboard.press('Escape')
    await page.locator('.mode-pill-btn').click(); await page.locator('[data-agent-switch]').click(); await settle(page)
    check('Agent selector stays inline', await page.locator('[data-pane="agents"].cm-sub--inline').isVisible())
    await geometry(page, 'inline Agent selector')
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
    await page.evaluate(() => window.__narrow.set({ running: true }))
    await page.locator('.t2c-stop').click()
    check('actual stop callback', await page.evaluate(() => window.__narrow.stopped === 1))
    await page.locator('.t2c-ta').fill('hello compact composer')
    await page.locator('.t2c-send').click()
    check('actual send callback', await page.evaluate(() => window.__narrow.sent.includes('hello compact composer')))
    for (const suffix of ['&light', '&skin=lavender']) {
      await page.goto(`${base}?lang=en&zoom=1.1${suffix}`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.model-pill-compact:visible'); await page.locator('.model-pill-btn').click(); await settle(page)
      await geometry(page, 'appearance ' + suffix)
      await page.screenshot({ path: path.join(output, suffix.includes('light') ? 'light.png' : 'lavender.png') })
    }
    await page.goto(`${base}?prompt&lang=en&zoom=1.1`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.model-pill-compact:visible'); await page.locator('.model-pill-btn').click(); await settle(page)
    check('shared prompt ModelPill uses compact menu', await page.locator('.composer-menu--compact').isVisible())
    await page.goto(`${base}?engine&lang=en`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.composer-chip--readonly')
    await page.evaluate(() => window.__narrow.set({ loaded: true, width: 280 }))
    await page.waitForSelector('.model-pill-wrap[data-compact]')
    const trigger = page.locator('.model-pill-btn')
    await trigger.focus(); await page.keyboard.press('Enter'); await settle(page)
    check('late engine catalog keeps compact layout', await page.locator('.composer-menu--compact').isVisible())
    check('keyboard-open moves focus into portal', await page.locator('.composer-menu--compact').evaluate(el => el.contains(document.activeElement)))
    await page.evaluate(() => { const input = document.createElement('input'); input.id = 'newer-dialog-input'; document.body.append(input); input.focus() })
    await page.keyboard.press('Escape')
    check('newer dialog keeps Escape and focus', await page.locator('.composer-menu--compact').isVisible() && await page.locator('#newer-dialog-input').evaluate(el => document.activeElement === el))
    await page.locator('.composer-menu--compact .cm-model-row').click()
    await page.locator('.composer-menu-back').click()
    await page.keyboard.press('Escape')
    await page.evaluate(() => document.querySelector('#newer-dialog-input').remove())
    check('no runtime errors', errors.length === 0, errors)
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ results, errors }, null, 2))
    console.log(`${results.filter(r => r.ok).length}/${results.length} passed; screenshots/report: ${output}`)
    if (results.some(r => !r.ok)) process.exitCode = 1
  } finally { await browser.close() }
})().catch(e => { console.error(e); process.exitCode = 1 })
