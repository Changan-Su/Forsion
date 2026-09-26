/** Forsion Events Space -> Tangu cross-layout probe (isolated Electron profile). */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron: electron } = require('playwright-core')

const root = path.join(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-events-switch-'))
const source = process.env.EVENTS_PLUGIN_DIR || path.join(os.homedir(), '.forsion-dev/plugins/forsion-events')
const installSlug = process.env.EVENTS_INSTALL_SLUG || 'forsion-events'
const packagedApp = process.env.EVENTS_PACKAGED_APP || ''
if (!fs.existsSync(path.join(source, 'manifest.json'))) throw new Error(`Missing installed Events plugin: ${source}`)
fs.cpSync(source, path.join(home, 'plugins', installSlug), { recursive: true })

;(async () => {
  let app
  try {
    app = await electron.launch({
      ...(packagedApp ? { executablePath: packagedApp } : {}),
      args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ...(packagedApp ? [] : [root])], cwd: root,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1', ...(packagedApp ? {} : { ELECTRON_RENDERER_URL: process.env.REPRO_DEV_URL || 'http://localhost:5273' }) },
    })
    const win = await app.firstWindow()
    const errors = []
    win.on('pageerror', (error) => errors.push(`pageerror ${error.message}`))
    win.on('console', (message) => {
      if (message.type() === 'error' || /\[(amadeus|spaces)\]/.test(message.text())) errors.push(`${message.type()} ${message.text()}`)
    })
    if (packagedApp) await win.reload()
    await win.waitForSelector('#root', { timeout: 40000 })
    for (const label of ['跳过引导', 'Skip']) {
      const button = win.getByRole('button', { name: label, exact: true }).first()
      if (await button.isVisible().catch(() => false)) { await button.click(); break }
    }
    await win.waitForSelector('.wb-dockview', { state: 'attached', timeout: 40000 })
    await win.locator('#tangu-splash').waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})
    console.log('boot', await win.evaluate(() => ({ title: document.title, dock: getComputedStyle(document.querySelector('.wb-dockview')).display })))
    if (process.env.EVENTS_PROBE_ONLY === '1') {
      await win.waitForTimeout(3500)
      const loaded = await win.evaluate(async () => ({
        version: await window.tangu?.appVersion?.(),
        sources: (await window.amadeus?.listPlugins?.())?.filter((p) => p.id === 'forsion-events').map((p) => ({ id: p.id, blocked: p.blocked, bytes: p.code?.length })),
        spaces: (await window.tangu?.spacesList?.())?.filter((s) => s.plugin === 'forsion-events').map((s) => s.slug),
        style: !!document.getElementById('forsion-events-style'),
      }))
      await win.keyboard.press('Meta+k')
      await win.keyboard.type('Forsion 活动')
      await win.waitForTimeout(300)
      const command = (await win.locator('body').innerText()).includes('Forsion 活动:打开')
      await win.keyboard.press('Escape')
      let space = (await win.locator('body').innerText()).includes('Forsion 活动')
      if (!space) {
        await win.getByText('全部 Spaces').first().click().catch(() => {})
        space = (await win.locator('body').innerText()).includes('Forsion 活动')
      }
      if (process.env.EVENTS_EXPECT_SHORTCUT === '1') {
        await win.keyboard.press('Escape')
        await win.getByText('🌕 活动', { exact: true }).first().click()
        await win.waitForSelector('.fe-root', { timeout: 10000 })
      }
      console.log('compat', { ...loaded, command, space, errors: errors.slice(0, 8) })
      if (!loaded.sources?.length || !loaded.spaces?.length || !loaded.style || !command || !space) throw new Error('Installed Events plugin is missing a main-window entry')
      return
    }
    await win.evaluate(() => {
      window.__types = () => {
        try {
          const blob = JSON.parse(localStorage.getItem('tangu2_layout_v4') || 'null')
          return Object.values(blob.dockview.panels).map((p) => p.params?.__type || p.contentComponent)
        } catch { return [] }
      }
    })
    const clickSpace = async (name) => {
      const direct = await win.evaluate((target) => {
        const button = [...document.querySelectorAll('.rb-space')].find((node) => (node.title || node.textContent || '').includes(target))
        if (!button) return false
        button.click()
        return true
      }, name)
      if (direct) return
      if (name === 'Forsion 活动') {
        await win.getByText('全部 Spaces').first().click()
        await win.getByText(name, { exact: true }).last().click({ timeout: 20000 })
        return
      }
      throw new Error(`Space button missing: ${name}`)
    }
    await clickSpace('Forsion 活动')
    await win.waitForTimeout(1200)
    console.log('events', await win.evaluate(() => ({ active: localStorage.getItem('forsion_tangu_active_space'), types: window.__types(), view: !!document.querySelector('.fe-root'), guest: !!document.querySelector('webview') })))
    await win.evaluate(() => {
      window.__spaceFrames = []
      document.addEventListener('click', (e) => {
        if (!e.target?.closest?.('button.rb-space:not(.on)')) return
        window.__exitPaint = { visibility: document.querySelector('.fe-root')?.style.visibility, active: localStorage.getItem('forsion_tangu_active_space') }
      }, true)
      let start = performance.now()
      const frame = () => {
        window.__spaceFrames.push({ t: Math.round(performance.now() - start), active: localStorage.getItem('forsion_tangu_active_space'), view: !!document.querySelector('.fe-root'), guest: !!document.querySelector('webview'), tab: document.querySelector('.dv-active-tab')?.textContent?.trim() || '', types: window.__types() })
        if (performance.now() - start < 900) requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
    await clickSpace('Tangu')
    await win.waitForTimeout(1100)
    const frames = await win.evaluate(() => window.__spaceFrames)
    const exitPaint = await win.evaluate(() => window.__exitPaint)
    console.log('exit-before-layout', exitPaint)
    console.log('frames', JSON.stringify(frames.filter((x, i) => i === 0 || i === frames.length - 1 || x.view || x.types.some((t) => t.includes('forsion-events'))).slice(0, 25)))
    const final = await win.evaluate(() => ({ active: localStorage.getItem('forsion_tangu_active_space'), types: window.__types(), view: !!document.querySelector('.fe-root') }))
    console.log('final', final)
    if (exitPaint?.visibility !== 'hidden') throw new Error('Events surface remained visible until after Space navigation')
    if (final.active !== 'tangu' || final.view || final.types.some((type) => type.includes('forsion-events'))) throw new Error('Tangu still contains the Events surface')
  } finally {
    if (app) await app.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})().catch((e) => { console.error(e); process.exitCode = 1 })
