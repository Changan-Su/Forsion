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
    win.on('pageerror', error => console.log('PAGEERROR', error.message))
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
      if (process.env.SPACE_INPUT_HEIGHT) {
        main.setMinimumSize(880, 360)
        main.setBounds({ x: 10, y: 10, width: 1000, height: Number(process.env.SPACE_INPUT_HEIGHT) })
      }
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
      console.log('Input events:', await win.evaluate(() => window.__inputDrags.slice(-10)))
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
      if (process.platform === 'win32') await app.evaluate(({ screen }) => {
        // DevTools mouse input does not move the OS cursor. Use a fixed native DIP snapshot for routing;
        // the separate Sky acceptance run checks the actual OS cursor on physical displays.
        screen.getCursorScreenPoint = () => ({ x: 800, y: 650 })
      })
      await win.evaluate(() => {
        window.__inputDrags = []
        for (const kind of ['dragstart', 'drop', 'dragend', 'pointerdown', 'pointermove', 'pointerup', 'gotpointercapture', 'lostpointercapture', 'pointercancel', 'blur']) window.addEventListener(kind, (event) => window.__inputDrags.push({ kind, trusted: event.isTrusted, effect: event.dataTransfer?.dropEffect, screenX: event.screenX, screenY: event.screenY, buttons: event.buttons, primary: event.isPrimary, target: event.target?.tagName,
          pointerId: event.pointerId, cursor: kind === 'pointerup' ? window.tangu.cursorScreenPoint?.() : undefined }), true)
      })
      const active = await win.evaluate(() => localStorage.getItem('forsion_tangu_active_space'))
      const slot = win.locator('.rb-top .rb-slot[data-id="space:agents"]')
      const revealAgents = async () => {
        const more = win.locator('.rb-more[data-rb-more="top"]')
        if (!await slot.isVisible() && await more.getAttribute('aria-expanded') === 'false') await more.click()
        await slot.locator('.rb-btn').hover() // Wait for opening/cropping transitions and a hittable source.
      }
      const begin = async () => {
        await win.bringToFront()
        await app.evaluate(({ BrowserWindow }, url) => {
          const main = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === url)
          main.show(); main.moveTop(); main.focus()
        }, win.url())
        await win.waitForFunction(() => document.hasFocus())
        await win.waitForTimeout(100)
        await revealAgents()
        const box = await slot.boundingBox()
        assert.ok(box, 'The Agents source must be visible')
        const hit = await win.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-id]')?.getAttribute('data-id'), { x: box.x + box.width / 2, y: box.y + box.height / 2 })
        assert.equal(hit, 'space:agents', 'The mouse must start on the visible Agents source')
        await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await win.mouse.down()
        await win.waitForTimeout(100)
      }
      let sat = await open(async () => {
        await begin()
        await win.mouse.move(550, 400, { steps: 20 })
        await win.mouse.move(552, 402)
        if (process.platform === 'win32') {
          const state = await win.evaluate(() => ({ active: document.documentElement.classList.contains('rb-pointer-dragging'), cursor: getComputedStyle(document.querySelector('.rb-btn')).cursor, capture: [...document.querySelectorAll('.rb-btn')].some(button => button.hasPointerCapture(window.__inputDrags.find(e => e.kind === 'pointerdown')?.pointerId)), platform: window.tangu.platform, draggable: document.querySelector('.rb-slot[data-id="space:agents"]').draggable, events: window.__inputDrags }))
          console.log('NOTE capture', JSON.stringify({ ...state, events: state.events.slice(-3) }))
          check(`${scale}: captured drag retains pointer events and a grabbing cursor`, state.active && state.cursor === 'grabbing' && state.capture)
        }
        await win.mouse.up()
      })
      const drag = await win.evaluate(() => window.__inputDrags)
      const pointer = process.platform === 'win32'
      check(`${scale}: actual mouse input produces trusted gesture events`, (pointer ? ['pointerdown', 'pointermove', 'pointerup'] : ['dragstart', 'drop', 'dragend']).every((kind) => drag.some((event) => event.kind === kind && event.trusted)) && (!pointer || !drag.some(event => event.kind === 'dragstart')))
      check(`${scale}: dragged Space opens without switching the main window or adding Ribbon`, new URL(sat.url()).searchParams.get('space') === 'agents' && await sat.locator('.rb').count() === 0 && await win.evaluate(() => localStorage.getItem('forsion_tangu_active_space')) === active)
      const show = await app.evaluate(({ BrowserWindow }, url) => {
        const id = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === url)?.webContents.id
        return globalThis.__spaceShows.find((row) => row.id === id)
      }, sat.url())
      check(`${scale}: detached window remains hidden until its first paint`, show.visibleAtCreation === false && show.paintedAtShow === true)
      const before = await native(sat)
      const drop = drag.find((event) => event.kind === (pointer ? 'pointerup' : 'drop'))
      const point = pointer ? drop.cursor : drop
      console.log('NOTE position', JSON.stringify({ point, before }))
      check(`${scale}: window appears at the release point in native DIP coordinates`, Math.abs(before.bounds.x - point.screenX) <= 2 && Math.abs(before.bounds.y - point.screenY) <= 2)
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
      if (pointer) {
        const beforeOrder = await win.locator('.rb-top .rb-slot').evaluateAll(els => els.map(el => el.dataset.id))
        const other = win.locator('.rb-top .rb-slot').nth(beforeOrder.at(-1) === 'space:agents' ? 0 : beforeOrder.length - 1)
        const destination = await other.boundingBox()
        await begin()
        await win.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, { steps: 15 })
        await win.waitForTimeout(250)
        const preview = await win.locator('.rb-top .rb-slot').evaluateAll(els => els.map(el => ({ id: el.dataset.id, y: el.getBoundingClientRect().y })).sort((a,b) => a.y-b.y).map(el => el.id))
        await win.mouse.up()
        await win.waitForTimeout(250)
        const afterOrder = await win.locator('.rb-top .rb-slot').evaluateAll(els => els.map(el => el.dataset.id))
        console.log('NOTE reorder', JSON.stringify({ beforeOrder, preview, afterOrder }))
        check(`${scale}: pointer reorder commits the visible preview and opens no window`, JSON.stringify(preview) === JSON.stringify(afterOrder) && JSON.stringify(beforeOrder) !== JSON.stringify(afterOrder) && satellites().length === 0)
        for (const guest of ['iframe', 'webview']) {
          await win.evaluate(guest => {
            const el = document.createElement(guest)
            el.id = 'pointer-guest'; el.style.cssText = 'position:fixed;left:200px;top:180px;width:550px;height:400px;z-index:10000;background:#eee'
            if (guest === 'iframe') { el.setAttribute('sandbox', ''); el.srcdoc = '<h1>Isolated guest content</h1>' }
            else el.setAttribute('src', 'data:text/html,<h1>Embedded browser</h1>')
            document.body.appendChild(el)
          }, guest)
          await win.waitForTimeout(400)
          sat = await open(async () => { await begin(); await win.mouse.move(400, 300, { steps: 15 }); await win.mouse.up() })
          check(`${scale}: captured release over ${guest} opens one Space`, satellites().length === 1 && new URL(sat.url()).searchParams.get('space') === 'agents')
          await closeWindow(sat)
          await begin(); await win.mouse.move(400, 300, { steps: 15 }); await win.keyboard.press('Escape'); await win.mouse.up()
          await win.waitForTimeout(200)
          check(`${scale}: Escape over ${guest} cancels and removes drag feedback`, satellites().length === 0 && await win.locator('.rb-pointer-ghost').count() === 0 && !await win.evaluate(() => document.documentElement.classList.contains('rb-pointer-dragging')))
          await win.locator('#pointer-guest').evaluate(el => el.remove())
        }
        for (const x of [-140, (await win.evaluate(() => window.innerWidth)) + 140]) {
          sat = await open(async () => { await begin(); await win.mouse.move(150, 300, { steps: 8 }); await win.mouse.move(x, 300, { steps: 15 }); await win.mouse.up() })
          check(`${scale}: capture releases outside ${x < 0 ? 'left' : 'right'} edge`, satellites().length === 1)
          await closeWindow(sat)
          await begin(); await win.mouse.move(150, 300, { steps: 8 }); await win.mouse.move(x, 300, { steps: 15 }); await win.keyboard.press('Escape'); await win.mouse.up()
          await win.waitForTimeout(200)
          check(`${scale}: Escape outside ${x < 0 ? 'left' : 'right'} edge opens no window`, satellites().length === 0)
        }
        await slot.locator('.rb-btn').click()
        check(`${scale}: ordinary click still switches the Space`, await win.evaluate(() => localStorage.getItem('forsion_tangu_active_space')) === 'agents')
        const firstSlot = await win.locator('.rb-top .rb-slot').first().boundingBox()
        await begin(); await win.mouse.move(firstSlot.x + firstSlot.width / 2, firstSlot.y + firstSlot.height / 2, { steps: 12 }); await win.mouse.up()
        await win.waitForTimeout(250)
        for (const zoom of [.8, 1.25]) {
          await win.evaluate(zoom => { document.body.style.zoom = String(zoom); document.documentElement.style.setProperty('--uiz', String(zoom)) }, zoom)
          await win.waitForTimeout(350) // ResizeObserver may move the last visible item into overflow.
          await win.bringToFront()
          const more = win.locator('.rb-more[data-rb-more="top"]')
          if (await more.count() && await more.getAttribute('aria-expanded') === 'false') await more.click()
          sat = await open(async () => { await begin(); await win.mouse.move(400, 300, { steps: 12 }); await win.mouse.up() })
          check(`${scale}: pointer drag preserves application zoom ${zoom}`, satellites().length === 1 && await win.locator('.rb-pointer-shield').count() === 0)
          await closeWindow(sat)
        }
        await win.evaluate(() => { document.body.style.zoom = ''; document.documentElement.style.setProperty('--uiz', '1') })
        const expandedTop = win.locator('.rb-more[data-rb-more="top"][aria-expanded="true"]')
        if (await expandedTop.count()) await expandedTop.click()
        const originalV2 = await win.evaluate(() => {
          const old = localStorage.getItem('forsion_tangu_ribbon_v2')
          const v2 = JSON.parse(old || '{}')
          v2.folders = [...(v2.folders || []), { id: 'folder:pointer-probe', name: 'Pointer probe', zone: 'top', items: [] }]
          localStorage.setItem('forsion_tangu_ribbon_v2', JSON.stringify(v2))
          const order = JSON.parse(localStorage.getItem('forsion_tangu_ribbon_order') || '[]')
          localStorage.setItem('forsion_tangu_ribbon_order', JSON.stringify(['space:agents', 'folder:pointer-probe', ...order.filter(id => id !== 'space:agents')]))
          return old
        })
        await win.reload(); await slot.waitFor(); await win.locator('#tangu-splash').waitFor({ state: 'detached' })
        const folder = win.locator('.rb-folder[data-rb-folder="folder:pointer-probe"]')
        const revealFolder = async () => {
          const more = win.locator('.rb-more[data-rb-more="top"]')
          if (!await folder.isVisible() && await more.getAttribute('aria-expanded') === 'false') await more.click()
          await folder.hover()
        }
        await revealFolder()
        const folderBox = await folder.boundingBox()
        await begin(); await win.mouse.move(folderBox.x + folderBox.width / 2, folderBox.y + folderBox.height / 2, { steps: 12 }); await win.mouse.up()
        await win.waitForTimeout(250)
        check(`${scale}: pointer drag into a folder persists membership`, await win.evaluate(() => JSON.parse(localStorage.getItem('forsion_tangu_ribbon_v2')).folders.find(f => f.id === 'folder:pointer-probe').items.includes('space:agents')) && satellites().length === 0)
        const row = win.locator('.rb-fly-row[data-id="space:agents"]')
        const beginRow = async () => {
          await win.bringToFront(); await revealFolder(); await row.waitFor()
          const box = await row.boundingBox(); await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await win.mouse.down()
        }
        sat = await open(async () => { await beginRow(); await win.mouse.move(400, 300, { steps: 12 }); await win.mouse.up() })
        check(`${scale}: pointer tear-off from a folder opens its Space`, satellites().length === 1)
        await closeWindow(sat)
        await beginRow()
        const topBox = await win.locator('.rb-top .rb-slot[data-id^="space:"]').first().boundingBox()
        await win.mouse.move(topBox.x + topBox.width / 2, topBox.y + topBox.height / 2, { steps: 12 }); await win.mouse.up()
        await win.waitForTimeout(250)
        check(`${scale}: pointer drag out of a folder restores the Ribbon item`, await slot.count() === 1 && !await win.evaluate(() => JSON.parse(localStorage.getItem('forsion_tangu_ribbon_v2')).folders.find(f => f.id === 'folder:pointer-probe').items.includes('space:agents')))
        await win.evaluate(old => { if (old === null) localStorage.removeItem('forsion_tangu_ribbon_v2'); else localStorage.setItem('forsion_tangu_ribbon_v2', old) }, originalV2)
        await win.reload(); await slot.waitFor(); await win.locator('#tangu-splash').waitFor({ state: 'detached' })
      }
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
