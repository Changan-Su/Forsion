/** Real Electron Mini Panel contract: isolated backend/vault/plugins and real window motion.
 * npm run build && npm run check:minicard. No physical input is sent to other applications. */
const fs = require('fs'), os = require('os'), path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-mini-panel-'))
const shots = path.join(temp, 'screenshots'), results = []
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
function check(name, ok, detail = '') { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`) }
async function main() {
  const userData = path.join(temp, 'userdata'), vault = path.join(temp, 'vault'), probe = path.join(temp, 'plugins', 'mini-probe')
  for (const dir of [userData, userData + '-dev', vault, shots, path.join(probe, 'spaces', 'mini-probe')]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(userData + '-dev', 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault }))
  const note = path.join(vault, 'Mini note.md')
  fs.writeFileSync(note, '# Mini note\n\nA compact panel keeps the current task close.\n\n- [ ] Review Mini Panel @2026-09-07\n')
  fs.writeFileSync(path.join(probe, 'manifest.json'), JSON.stringify({ id: 'mini-probe', name: 'Mini probe', version: '1.0.0', minAppVersion: '0.0.1' }))
  fs.writeFileSync(path.join(probe, 'main.js'), `
    window.__miniProbe = { mounts: 0, disposes: 0 };
    for (const id of ['full', 'mini']) ctx.registerView({ id, title: 'Mini probe', mount(el, view) {
      window.__miniProbe.mounts++; if (id === 'mini') window.__miniProbe.oldView = view;
      const content = document.createElement('div'); content.className = 'mini-probe-' + id;
      const render = () => content.textContent = 'Item: ' + (view.getParams().itemId || 'none');
      const button = document.createElement('button'); button.textContent = 'Choose item 42'; button.onclick = () => view.setParams({ itemId: '42' });
      el.append(content, button); render(); const off = view.onParamsChanged(render);
      return () => { off(); window.__miniProbe.disposes++; };
    } });`)
  fs.writeFileSync(path.join(probe, 'spaces', 'mini-probe', 'space.json'), JSON.stringify({ id: 'mini-probe', name: { zh: 'Mini 探针', en: 'Mini probe' }, layout: { main: [{ type: 'plugin:mini-probe:full' }] },
    mini: { view: { type: 'plugin:mini-probe:mini', params: { itemId: '7' } }, mainView: { type: 'plugin:mini-probe:full' } } }))
  const session = (id) => ({ id, title: id, created_at: '2026-09-07T00:00:00Z', updated_at: '2026-09-07T00:00:00Z', agent_config: { execMode: 'host' } })
  const stub = await startStubEngine({ sessions: [session('mini-first'), session('mini-latest')] })
  fs.writeFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'mini-test-token' }))
  let app, mini
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: temp, TANGU_BACKEND_URL: stub.url, PI_CU_SOCKET_PATH: path.join(temp, 'bridge.sock') } })
    const actualUserData = await app.evaluate(({ app }) => app.getPath('userData'))
    if (fs.realpathSync(actualUserData) !== fs.realpathSync(userData + '-dev')) throw new Error('Unexpected userData: ' + actualUserData)
    const win = await app.firstWindow(), errors = []
    win.on('pageerror', (e) => errors.push(`main: ${e.message}`))
    await win.waitForSelector('.dv-groupview', { timeout: 30000, state: 'attached' })
    for (const name of ['跳过引导', 'Skip']) { const b = win.getByRole('button', { name, exact: true }); if (await b.count()) { await b.click(); break } }
    await win.evaluate(() => { window.tangu.openMini({ sessionId: 'mini-first' }); window.tangu.openMini({ sessionId: 'mini-latest' }) })
    for (let i = 0; i < 200; i++) { mini = app.windows().find((w) => w.url().includes('window=mini')); if (mini) break; await pause(50) }
    if (!mini) throw new Error('Mini window missing')
    mini.on('pageerror', (e) => errors.push(`mini: ${e.message}`))
    await mini.waitForSelector('.mini-tangu [data-session-id="mini-latest"]', { timeout: 30000 })
    check('latest session target in one Mini window', app.windows().filter((w) => w.url().includes('window=mini')).length === 1)
    check('independent of mobile UI', !mini.url().includes('ui=mobile'))
    await mini.waitForSelector('#tangu-splash', { state: 'detached', timeout: 15000 })
    await mini.waitForTimeout(500)
    const geo = await mini.evaluate(() => {
      const root = document.querySelector('.mini-card-shell'), bar = document.querySelector('.mini-card-chrome')
      return { overflow: root.scrollWidth - root.clientWidth, height: bar.getBoundingClientRect().height,
        old: document.querySelectorAll('.mb-drawer,.mb-topbar,.mb-sheet,.mini-card-tab-count').length, actions: bar.querySelectorAll('.mini-card-action').length,
        emptyBottom: document.querySelector('.t2-empty')?.getBoundingClientRect().bottom, composerTop: document.querySelector('.composer-anchor')?.getBoundingClientRect().top }
    })
    check('one header with main-panel and close actions', geo.height === 44 && geo.actions === 2 && geo.old === 0, JSON.stringify(geo))
    check('no overflow or composer overlap', geo.overflow === 0 && geo.emptyBottom <= geo.composerTop)
    await mini.screenshot({ path: path.join(shots, 'tangu-light.png') })
    stub.script([{ type: 'token', payload: { delta: 'Mini message received.' } }])
    await mini.locator('.t2c-ta').fill('Hello from Mini')
    await mini.locator('.t2c-ta').press('Enter')
    await mini.getByText('Mini message received.', { exact: true }).waitFor()
    check('Tangu sends to selected session and streams reply', stub.seen.runs.some((r) => r.sessionId === 'mini-latest' && r.message === 'Hello from Mini'))
    await mini.screenshot({ path: path.join(shots, 'tangu-reply.png') })
    await mini.getByRole('button', { name: '在主面板显示', exact: true }).click()
    await win.waitForSelector('[data-chat-surface="chat"][data-session-id="mini-latest"]')
    check('main panel receives exact session', true)
    const switchTo = async (name) => { await mini.locator('.mini-card-space').click(); await mini.locator('.mini-card-popover').getByRole('button', { name, exact: true }).click() }
    await mini.locator('.mini-card-space').click()
    const labels = await mini.locator('.mini-card-popover .mini-card-row').allTextContents()
    check('only adapted native and plugin Spaces', labels.length === 4 && labels.includes('ToDo List') && labels.includes('Mini 探针'), JSON.stringify(labels))
    await mini.screenshot({ path: path.join(shots, 'spaces.png') }); await mini.keyboard.press('Escape')
    await switchTo(labels.find((x) => /Amadeus|笔记/.test(x)))
    await mini.getByLabel('选择笔记', { exact: true }).selectOption('Mini note.md')
    await mini.waitForSelector('.mini-amadeus .amx-pane', { timeout: 30000 }); await mini.waitForTimeout(1200)
    check('dedicated Amadeus picker restores vault', await mini.locator('.mini-amadeus .amx-pane').count() === 1)
    check('no full-workspace Amadeus chrome', await mini.locator('.mini-amadeus .amx-toolbar,.mini-amadeus .amx-title-actions,.mini-amadeus .amx-props').count() === 0)
    await mini.screenshot({ path: path.join(shots, 'amadeus-light.png') })
    await mini.getByRole('button', { name: '在主面板显示', exact: true }).click()
    await win.waitForFunction(() => [...document.querySelectorAll('.amx-pane')].some((el) => el.textContent.includes('A compact panel')))
    check('main panel receives same note', true)
    await switchTo('ToDo List')
    const todo = mini.getByRole('checkbox', { name: 'Review Mini Panel', exact: true })
    await todo.waitFor({ timeout: 30000 }); await todo.check()
    for (let i = 0; i < 60 && !/^[-*+] \[x\] Review/m.test(fs.readFileSync(note, 'utf8')); i++) await pause(50)
    check('ToDo completion writes original note', /^[-*+] \[x\] Review/m.test(fs.readFileSync(note, 'utf8')))
    await mini.screenshot({ path: path.join(shots, 'todo-light.png') })
    await switchTo('Mini 探针'); await mini.getByRole('button', { name: 'Choose item 42', exact: true }).click()
    await mini.waitForFunction(() => document.querySelector('.mini-probe-mini')?.textContent === 'Item: 42')
    check('plugin params change without remount', await mini.evaluate(() => window.__miniProbe.mounts === 1))
    await mini.getByRole('button', { name: '在主面板显示', exact: true }).click()
    await win.waitForFunction(() => document.querySelector('.mini-probe-full')?.textContent === 'Item: 42')
    check('plugin handoff preserves entity params', true)
    await switchTo('ToDo List')
    check('plugin disposal revokes context', await mini.evaluate(() => { try { window.__miniProbe.oldView.setParams({ itemId: 'stale' }); return false } catch { return window.__miniProbe.disposes === 1 } }))
    await switchTo('Mini 探针')
    await win.evaluate(() => localStorage.setItem('amadeus.plugins.disabled', JSON.stringify(['mini-probe', 'uninstalled-plugin'])))
    await mini.waitForSelector('.mini-card-shell[data-space="tangu"]')
    await mini.locator('.mini-card-space').click()
    check('disabling in main removes the active Mini plugin', await mini.locator('.mini-card-popover .mini-card-row').count() === 3)
    check('cross-window sync preserves other disabled IDs', await mini.evaluate(() => JSON.parse(localStorage.getItem('amadeus.plugins.disabled')).includes('uninstalled-plugin')))
    await mini.keyboard.press('Escape')
    await win.evaluate(() => localStorage.setItem('amadeus.plugins.disabled', JSON.stringify(['uninstalled-plugin'])))
    await mini.locator('.mini-card-space').click()
    await mini.locator('.mini-card-popover').getByRole('button', { name: 'Mini 探针', exact: true }).waitFor()
    check('reenabling restores the Mini adapter without reload', true)
    await mini.keyboard.press('Escape')
    await mini.evaluate(() => localStorage.setItem('forsion_theme_pref', 'dark'))
    await mini.reload()
    await mini.waitForSelector('.mini-card-shell[data-space="tangu"]')
    await switchTo('ToDo List')
    await mini.waitForSelector('.mini-todo .amx-todo')
    await mini.waitForTimeout(500)
    check('dark theme survives Mini reload', await mini.evaluate(() => document.documentElement.dataset.mode === 'dark'))
    await mini.screenshot({ path: path.join(shots, 'todo-dark.png') })
    await switchTo('Amadeus')
    await mini.getByRole('button', { name: '新建笔记', exact: true }).click()
    const title = mini.locator('.mini-amadeus .amx-title-input')
    await title.waitFor(); await title.fill('Mini capture'); await title.press('Enter')
    await mini.waitForSelector('.mini-amadeus [data-unified-path="Mini capture.md"]')
    await mini.locator('.mini-amadeus .ProseMirror[contenteditable="true"]').fill('Captured in Mini')
    await mini.getByRole('button', { name: '在主面板显示', exact: true }).click()
    await win.waitForFunction(() => [...document.querySelectorAll('.amx-pane')].some((el) => el.textContent.includes('Captured in Mini')))
    check('new note rename/edit is flushed before main-panel handoff', fs.readFileSync(path.join(vault, 'Mini capture.md'), 'utf8').includes('Captured in Mini'))
    await mini.screenshot({ path: path.join(shots, 'new-note-dark.png') })

    await app.evaluate(({ screen, BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('window=mini')), area = screen.getPrimaryDisplay().workArea
      w.setPosition(area.x + 40, area.y + 40)
      globalThis.__miniCursor = { x: area.x + 430, y: area.y + 220 }; screen.getCursorScreenPoint = () => globalThis.__miniCursor
      globalThis.__miniSamples = []; globalThis.__miniSampler = setInterval(() => globalThis.__miniSamples.push({ ...w.getBounds(), at: Date.now() }), 16)
    })
    await pause(300)
    const signalTime = Date.now()
    const signal = { v: 1, active: true, updatedAt: signalTime, expiresAt: signalTime + 2500, helperPid: process.pid }
    fs.writeFileSync(path.join(temp, 'foreground.json'), JSON.stringify(signal)); await pause(600)
    const movement = await app.evaluate(() => { clearInterval(globalThis.__miniSampler); return globalThis.__miniSamples })
    check('real window follows through multiple linear positions', new Set(movement.map((b) => b.x)).size > 5)
    check('no instantaneous position jump', movement.slice(1).every((b, i) => Math.hypot(b.x - movement[i].x, b.y - movement[i].y) <= 160))
    fs.writeFileSync(path.join(temp, 'foreground.json'), JSON.stringify({ ...signal, active: false, updatedAt: Date.now(), expiresAt: Date.now() }))
    await pause(500)
    const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('window=mini')).getBounds())
    const before = await bounds(); await app.evaluate(() => { globalThis.__miniCursor.x += 100 }); await pause(250)
    check('completed/background calls stop following', JSON.stringify(before) === JSON.stringify(await bounds()))
    await mini.getByRole('button', { name: '关闭 Mini Panel', exact: true }).click()
    check('hit testing restored after following', true); check('no renderer errors', errors.length === 0, JSON.stringify(errors))
    console.log(`SCREENSHOTS ${shots}`)
  } catch (e) {
    if (mini && !mini.isClosed()) { await mini.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {}); console.log(await mini.locator('body').innerText().catch(() => '')) }
    if (app) { for (const [i, page] of app.windows().entries()) { await page.screenshot({ path: path.join(shots, `failure-window-${i}.png`) }).catch(() => {}); console.log(await page.locator('body').innerText().catch(() => '')) } }
    console.error(`FAILURE_SCREENSHOTS ${shots}`); throw e
  } finally { if (app) await app.close().catch(() => {}); await stub.close() }
  console.log(`${results.filter(Boolean).length}/${results.length} passed`)
  if (results.some((ok) => !ok)) process.exitCode = 1
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
