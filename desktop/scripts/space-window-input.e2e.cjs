/** Real Electron mouse/keyboard input, native window lifecycle and cold restart. No synthesized DragEvent. */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'outputs/spacewindow-input')

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-space-input-'))
  const userdata = path.join(home, 'userdata')
  const stub = await startStubEngine({ sessions: [], messages: [], models: [] })
  fs.mkdirSync(`${userdata}-dev`, { recursive: true })
  fs.writeFileSync(path.join(`${userdata}-dev`, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'probe' }))
  let app, win, checks = 0, onboardingSkipped = false
  const records = []
  const check = (name, ok) => { assert.ok(ok, name); checks++; console.log(`PASS ${name}`) }
  const launch = async (scale) => {
    app = await electron.launch({ args: [`--user-data-dir=${userdata}`, `--force-device-scale-factor=${scale}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
    win = await app.firstWindow()
    await win.waitForSelector('#root')
    if (!onboardingSkipped) {
      assert.ok(await skipOnboarding(win), 'The main window must leave onboarding')
      onboardingSkipped = true
    } else await win.waitForFunction(() => {
      const host = document.querySelector('.shell-host')
      return host && getComputedStyle(host).visibility !== 'hidden'
    })
    await win.locator('.rb').waitFor()
    await win.locator('#tangu-splash').waitFor({ state: 'detached' })
    await win.waitForTimeout(500)
    // Windows native drag delivery requires the input window in front. Run this probe separately from other UI harnesses.
    await app.evaluate(({ BrowserWindow }, url) => {
      const main = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === url)
      main.show(); main.focus()
    }, win.url())
  }
  const satellites = () => app.windows().filter((page) => /[?&]space=/.test(page.url()))
  const closeWindow = async (page) => {
    const closed = page.waitForEvent('close')
    await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === url).close(), page.url())
    await closed
  }
  const waitVisible = async (page) => {
    for (let i = 0; i < 100; i++) {
      const visible = await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === url)?.isVisible(), page.url())
      if (visible) return
      await page.waitForTimeout(50)
    }
    throw new Error('The native Space window must become visible')
  }
  const open = async (action) => {
    const created = app.waitForEvent('window', { timeout: 10000 }).catch(async (error) => {
      console.log('Input events:', await win.evaluate(() => window.__inputDrags))
      await win.screenshot({ path: path.join(OUT, 'failed-main.png') }).catch(() => {})
      throw error
    })
    await action()
    const page = await created
    await page.locator('.dv-groupview').first().waitFor({ timeout: 20000 })
    await waitVisible(page)
    return page
  }
  const layout = (page) => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((key) => key.includes('tangu2_layout_detached_sp_agents')).map((key) => {
    const saved = JSON.parse(localStorage.getItem(key))
    return [key, Object.values(saved.dockview.panels).map((panel) => [panel.id, panel.params?.__type || panel.contentComponent]).sort()]
  })))
  const native = (page) => app.evaluate(({ BrowserWindow }, url) => {
    const win = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL() === url)
    return { title: win.getTitle(), bounds: win.getBounds() }
  }, page.url())
  try {
    for (const scale of process.env.SPACE_INPUT_SCALE ? [Number(process.env.SPACE_INPUT_SCALE)] : [1, 1.25, 1.5]) {
      await launch(scale)
      assert.equal(satellites().length, 0, 'The previously closed Space must not restore on the next launch')
      await app.evaluate(({ app }) => {
        globalThis.__spaceShows = []
        app.on('browser-window-created', (_event, win) => {
          const row = { id: win.webContents.id, visibleAtCreation: win.isVisible(), paintedAtShow: null }
          globalThis.__spaceShows.push(row)
          let painted = false
          win.once('ready-to-show', () => { painted = true })
          win.once('show', () => { row.paintedAtShow = painted })
        })
      })
      await win.evaluate(() => {
        window.__inputDrags = []
        for (const kind of ['dragstart', 'drop', 'dragend']) window.addEventListener(kind, (event) => window.__inputDrags.push({ kind, trusted: event.isTrusted, effect: event.dataTransfer?.dropEffect, screenX: event.screenX, screenY: event.screenY }), true)
      })
      const active = await win.evaluate(() => localStorage.getItem('forsion_tangu_active_space'))
      const slot = win.locator('.rb-top .rb-slot[data-id="space:agents"]')
      const box = await slot.boundingBox()
      const begin = async () => {
        await win.bringToFront()
        await app.evaluate(({ BrowserWindow }, url) => {
          const main = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === url)
          main.show(); main.moveTop(); main.focus()
        }, win.url())
        await win.waitForFunction(() => document.hasFocus())
        await win.waitForTimeout(100)
        await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await win.mouse.down()
        await win.waitForTimeout(100)
      }
      let sat = await open(async () => {
        await begin()
        await win.mouse.move(550, 400, { steps: 20 })
        await win.mouse.move(552, 402)
        await win.mouse.up()
      })
      const drag = await win.evaluate(() => window.__inputDrags)
      check(`${scale}: actual mouse input produces trusted dragstart/drop/dragend`, ['dragstart', 'drop', 'dragend'].every((kind) => drag.some((event) => event.kind === kind && event.trusted)))
      check(`${scale}: dragged Space opens without switching the main window or adding Ribbon`, new URL(sat.url()).searchParams.get('space') === 'agents' && await sat.locator('.rb').count() === 0 && await win.evaluate(() => localStorage.getItem('forsion_tangu_active_space')) === active)
      const show = await app.evaluate(({ BrowserWindow }, url) => {
        const id = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === url)?.webContents.id
        return globalThis.__spaceShows.find((row) => row.id === id)
      }, sat.url())
      check(`${scale}: detached window remains hidden until its first paint`, show.visibleAtCreation === false && show.paintedAtShow === true)
      const before = await native(sat)
      const drop = drag.find((event) => event.kind === 'drop')
      check(`${scale}: window appears at the mouse release point with move accepted`, Math.abs(before.bounds.x - drop.screenX) <= 2 && Math.abs(before.bounds.y - drop.screenY) <= 2 && drag.some((event) => event.kind === 'dragend' && event.effect === 'move'))
      check(`${scale}: system title follows the Space name`, before.title === await sat.title() && before.title === 'Agents')
      await sat.screenshot({ path: path.join(OUT, `agents-${scale}.png`) })
      await sat.locator('.dv-new-tab').first().click()
      await sat.waitForTimeout(700)
      const saved = await layout(sat)
      check(`${scale}: detached layout is saved before close`, JSON.stringify(saved).includes('launcher'))
      await closeWindow(sat)
      const edge = await win.locator('.rb').boundingBox()
      await begin()
      await win.mouse.move(edge.x + edge.width + 10, 400, { steps: 15 })
      await win.mouse.move(edge.x + edge.width + 11, 401)
      await win.mouse.up()
      await win.waitForTimeout(500)
      check(`${scale}: actual mouse release near Ribbon opens no window`, satellites().length === 0)
      await begin()
      await win.mouse.move(550, 400, { steps: 15 })
      await win.keyboard.press('Escape')
      await win.mouse.up()
      await win.waitForTimeout(500)
      check(`${scale}: Escape during an in-page mouse drag opens no window`, satellites().length === 0)
      const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
      sat = await open(() => slot.locator('.rb-btn').click({ modifiers: [mod] }))
      check(`${scale}: close/reopen restores the edited layout`, JSON.stringify(await layout(sat)) === JSON.stringify(saved))
      // Move/resize the owned window before a full app quit; closing it would deliberately remove the restore record.
      const expectedBounds = await app.evaluate(async ({ BrowserWindow }, url) => {
        const win = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL() === url)
        win.setBounds({ x: 120, y: 90, width: 820, height: 620 })
        // Let Windows finish its native frame geometry, while remaining inside the 400ms debounce.
        await new Promise((resolve) => setTimeout(resolve, 50))
        return win.getBounds()
      }, sat.url())
      // Quit immediately after changing bounds, before the 400ms state-save debounce can fire.
      await app.close(); app = null
      console.log('NOTE saved native state', fs.readFileSync(path.join(`${userdata}-dev`, 'detached-windows.json'), 'utf8'))
      await launch(scale)
      let restored
      for (let i = 0; i < 100; i++) {
        restored = satellites().find((page) => new URL(page.url()).searchParams.get('space') === 'agents')
        if (restored) break
        await win.waitForTimeout(100)
      }
      check(`${scale}: cold app restart restores one window for the Space`, !!restored && satellites().length === 1)
      await restored.locator('.dv-groupview').first().waitFor({ timeout: 20000 })
      await waitVisible(restored)
      const after = await native(restored)
      const restoredLayout = await layout(restored)
      console.log(`NOTE restore ${JSON.stringify({ expectedBounds, actualBounds: after.bounds, saved, restoredLayout })}`)
      check(`${scale}: restart retains bounds and edited layout`, JSON.stringify(after.bounds) === JSON.stringify(expectedBounds) && JSON.stringify(restoredLayout) === JSON.stringify(saved))
      await closeWindow(restored)
      records.push({ scale, drag, show, expectedBounds, after })
      await app.close(); app = null
      check(`${scale}: closing the native Space window then quitting removes its restore record`, JSON.parse(fs.readFileSync(path.join(`${userdata}-dev`, 'detached-windows.json'), 'utf8')).length === 0)
    }
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, records }, null, 2))
    console.log(`${checks} checks passed; screenshots: ${OUT}`)
  } finally {
    if (app) await app.close()
    await stub.close()
    // home was created by mkdtemp under os.tmpdir; all user data belongs to this probe.
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
