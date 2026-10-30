/** Real built ChatView, isolated profile and controlled backend; no user data. */
const fs = require('fs'), os = require('os'), path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-narrow-electron-'))
const shots = process.env.NARROW_SHOTS || path.join(home, 'shots')
fs.mkdirSync(shots, { recursive: true })
let checks = 0
function check(name, ok, detail) { if (!ok) throw new Error(`FAIL ${name}: ${JSON.stringify(detail)}`); console.log('PASS ' + name); checks++ }
;(async () => {
  const models = [{ id: 'gpt-6-luna', name: 'gpt-6-luna', provider: 'stub', contextWindow: 272000 },
    { id: 'long', name: 'Research / Very long model deployment name 0123456789', provider: 'stub', contextWindow: 272000 }]
  const stub = await startStubEngine({ models, agents: [{ slug: 'arioso', name: 'Arioso', createdBy: 'user' }], engines: [], override: ({ path: p, method }) => p === '/agent/runs' && method === 'GET' ? { runs: [] } : undefined })
  const userdata = path.join(home, 'userdata')
  for (const dir of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }))
  }
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1' } })
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1120, 900))
    await win.waitForSelector('#root')
    await skipOnboarding(win)
    await win.evaluate(() => localStorage.setItem('forsion_default_space', 'tangu'))
    await win.reload({ waitUntil: 'domcontentloaded' })
    const view = win.locator('.t2-chat-view').first()
    await view.waitFor({ timeout: 40000 })
    await view.locator('.model-pill-btn:not(:disabled)').waitFor({ timeout: 40000 })
    await view.locator('.t2c-ta').fill('hi')
    await win.evaluate(() => { const r = document.documentElement; r.classList.add('dark'); r.dataset.mode = 'dark'; r.dataset.skin = 'cream'; r.dataset.bg = 'cream' })
    for (const zoom of [1, 1.1]) for (const width of [280, 320, 420]) {
      await win.evaluate(value => { document.body.style.zoom = String(value); window.dispatchEvent(new Event('forsion:uizoom')) }, zoom)
      await view.evaluate((el, width) => { el.style.flex = 'none'; el.style.width = width + 'px'; el.style.height = '740px' }, width)
      await win.waitForTimeout(250)
      const row = view.locator('.t2c-row')
      check(`${zoom} ${width} compact actual ChatView`, await row.getAttribute('data-compact') === 'true')
      const rect = await view.evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } })
      for (const selector of ['.model-pill-btn', '.mode-pill-btn', '.add-pill-btn']) {
        const trigger = view.locator(selector), before = await trigger.boundingBox(), sendBefore = await view.locator('.t2c-send').boundingBox()
        await trigger.click()
        const menu = win.locator('.composer-menu--compact:not([data-lcl-exit])').last()
        await menu.waitFor(); await win.waitForTimeout(180)
        const bounds = await menu.boundingBox(), after = await trigger.boundingBox(), sendAfter = await view.locator('.t2c-send').boundingBox()
        check(`${zoom} ${width} stable ${selector}`, Math.abs(after.width - before.width) < 1 && Math.abs(sendAfter.x - sendBefore.x) < 1, { before, after, sendBefore, sendAfter })
        check(`${zoom} ${width} bounded ${selector}`, bounds.x >= rect.left && bounds.x + bounds.width <= rect.right + 1 && bounds.y >= rect.top && bounds.y + bounds.height <= rect.bottom + 1, { bounds, rect })
        if (width === 320 && selector === '.model-pill-btn') {
          await win.screenshot({ path: path.join(shots, `chatview-${zoom}-dark.png`) })
          await view.screenshot({ path: path.join(shots, `chatview-${zoom}-dark-view.png`) })
        }
        await win.keyboard.press('Escape'); await win.waitForTimeout(120)
      }
    }
    await view.evaluate(el => { el.style.width = '280px' })
    stub.script([{ type: '__hold' }])
    await view.locator('.t2c-send').click()
    await view.locator('.t2c-stop').waitFor({ timeout: 15000 })
    await view.locator('.t2c-ta').fill('queued follow-up')
    const runningBounds = await view.evaluate(el => {
      const card = el.querySelector('.t2c-card').getBoundingClientRect()
      return [...el.querySelectorAll('.t2c-row button')].filter(e => e.checkVisibility()).map(e => { const r = e.getBoundingClientRect(); return { cls: e.className, left: r.left, right: r.right, fits: r.left >= card.left && r.right <= card.right + 1 } })
    })
    check('280px running with follow-up keeps send and stop inside card', runningBounds.every(b => b.fits), runningBounds)
    await view.locator('.t2c-stop').click()
    await win.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.dataset.mode = 'light' })
    await view.evaluate(el => { el.style.width = '320px' })
    await view.locator('.model-pill-btn').click(); await win.waitForTimeout(180)
    await win.screenshot({ path: path.join(shots, 'chatview-110-light.png') })
    await view.screenshot({ path: path.join(shots, 'chatview-110-light-view.png') })
    console.log(`${checks}/${checks} passed; screenshots: ${shots}`)
  } finally { if (app) await app.close(); await stub.close() }
})().catch(e => { console.error(e); process.exitCode = 1 })
