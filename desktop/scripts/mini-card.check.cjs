/** Real Electron Mini Panel contract: isolated backend/vault/plugins and real window geometry.
 * npm run build && npm run check:minicard. No physical input is sent to other applications. */
const fs = require('fs'), os = require('os'), path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
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
      el.append(content, button);
      if (id === 'full') { const direct = document.createElement('button'); direct.textContent = 'Open direct Mini'; direct.onclick = () => ctx.openMiniPanel?.('mini', { title: 'Direct Mini', params: { itemId: '99' }, mainViewId: 'full' }); el.appendChild(direct); }
      render(); const off = view.onParamsChanged(render);
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
    check('main window left onboarding', await skipOnboarding(win))
    await win.evaluate(() => { window.tangu.openMini({ sessionId: 'mini-first' }); window.tangu.openMini({ sessionId: 'mini-latest' }) })
    for (let i = 0; i < 200; i++) { mini = app.windows().find((w) => w.url().includes('window=mini')); if (mini) break; await pause(50) }
    if (!mini) throw new Error('Mini window missing')
    mini.on('pageerror', (e) => errors.push(`mini: ${e.message}`))
    await mini.waitForSelector('.mini-tangu [data-session-id="mini-latest"]', { timeout: 30000 })
    check('latest session target in one Mini window', app.windows().filter((w) => w.url().includes('window=mini')).length === 1)
    check('independent of mobile UI', !mini.url().includes('ui=mobile'))
    check('Mini window never mounts the Forsion startup splash', await mini.locator('#tangu-splash').count() === 0)
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
    // Mini 与主窗同源共享「最近使用」:紧凑适配器进去 = 主窗启动器把它开进主区(09-16 单列壳记账补丁的 Codex 评审)
    check('compact plugin view stays out of shared recents', await mini.evaluate(() => !JSON.parse(localStorage.getItem('forsion_tangu_recent_views') || '[]').some((i) => i.key.startsWith('view:plugin:mini-probe:mini'))))
    await mini.getByRole('button', { name: '在主面板显示', exact: true }).click()
    await win.waitForFunction(() => document.querySelector('.mini-probe-full')?.textContent === 'Item: 42')
    check('plugin handoff preserves entity params', true)
    await win.getByRole('button', { name: 'Open direct Mini', exact: true }).click()
    await mini.waitForSelector('.mini-card-shell[data-space="direct"]')
    await mini.waitForFunction(() => document.querySelector('.mini-probe-mini')?.textContent === 'Item: 99')
    check('plugin can open a direct Mini without a Space', await mini.locator('.mini-card-space', { hasText: 'Direct Mini' }).count() === 1)
    await win.evaluate(() => window.tangu.openMini({ spaceId: 'calendar' }))
    await mini.waitForSelector('.mini-card-shell[data-space="calendar"]')
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
    await mini.waitForSelector('.mini-card-shell[data-space="calendar"]')
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
      // This section isolates the manual window's own behavior; mini-auto.check.cjs covers real cross-process OS focus.
      globalThis.__miniOriginalFocusedWindow = BrowserWindow.getFocusedWindow
      BrowserWindow.getFocusedWindow = () => null
      const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('window=mini')), area = screen.getPrimaryDisplay().workArea
      w.setPosition(area.x + 40, area.y + 40)
      globalThis.__miniCursor = { x: area.x + 430, y: area.y + 220 }; screen.getCursorScreenPoint = () => ({ ...globalThis.__miniCursor }) // 同真接口:每次一个新对象
      globalThis.__miniIgnore = []; const set = w.setIgnoreMouseEvents.bind(w)
      w.setIgnoreMouseEvents = (v) => { globalThis.__miniIgnore.push(v); set(v) }
    })
    const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('window=mini')).getBounds())
    const lastIgnore = () => app.evaluate(() => globalThis.__miniIgnore.at(-1))
    const parked = await bounds()
    const signalTime = Date.now()
    const signal = { v: 1, active: true, updatedAt: signalTime, expiresAt: signalTime + 2500, helperPid: process.pid }
    fs.writeFileSync(path.join(temp, 'foreground.json'), JSON.stringify(signal)); await pause(600)
    await app.evaluate(() => { globalThis.__miniCursor.x += 240 }); await pause(250)
    check('foreground Computer Use leaves Mini where the user put it', JSON.stringify(parked) === JSON.stringify(await bounds()))
    check('clicks pass through the card while the pointer is elsewhere', await lastIgnore() === true)
    await app.evaluate((_, b) => { globalThis.__miniCursor = { x: b.x + 100, y: b.y + 20 } }, parked); await pause(200)
    check('the card is grabbable under the pointer', await lastIgnore() === false)
    await app.evaluate(() => { globalThis.__miniCursor.x += 600 }); await pause(200)
    check('leaving the card passes clicks through again', await lastIgnore() === true)
    fs.writeFileSync(path.join(temp, 'foreground.json'), JSON.stringify({ ...signal, active: false, updatedAt: Date.now(), expiresAt: Date.now() }))
    await pause(500)
    check('hit testing restored after Computer Use, still in place', await lastIgnore() === false && JSON.stringify(parked) === JSON.stringify(await bounds()))
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getFocusedWindow = globalThis.__miniOriginalFocusedWindow })

    // 拖边改大小:渲染层只报哪条边,位移由主进程读光标算(光标在上面已换成 __miniCursor)。
    await switchTo('ToDo List'); await mini.waitForSelector('.mini-todo .amx-todo')
    const dragEdge = async (edge, dx, dy) => {
      const box = await mini.locator(`.mini-card-edge[data-edge="${edge}"]`).boundingBox()
      // 角上的热区被卡片圆角裁掉一块(裁多少随主题的圆角变):按它朝卡片里面的那个角
      const corner = edge.length === 2
      const x = !corner ? box.x + box.width / 2 : edge.includes('w') ? box.x + box.width - 2 : box.x + 2
      const y = !corner ? box.y + box.height / 2 : edge.includes('n') ? box.y + box.height - 2 : box.y + 2
      await mini.mouse.move(x, y); await mini.mouse.down()
      await app.evaluate((_, d) => { globalThis.__miniCursor.x += d.dx; globalThis.__miniCursor.y += d.dy }, { dx, dy })
      await mini.mouse.move(x + 1, y); await pause(150) // 已捕获指针:挪出热区也算拖动
    }
    const nudge = (dx, dy) => app.evaluate((_, d) => { globalThis.__miniCursor.x += d.dx; globalThis.__miniCursor.y += d.dy }, { dx, dy })
    const fills = () => mini.evaluate(() => { const r = document.querySelector('.mini-card-shell').getBoundingClientRect(); return Math.abs(r.width - innerWidth) < 1 && Math.abs(r.height - innerHeight) < 1 })
    const before = await bounds()
    await win.evaluate(() => window.tangu.miniResize('se', true)); await nudge(60, 60)
    await win.evaluate(() => window.tangu.miniResize('se')); await pause(100); await nudge(-60, -60)
    check('only the Mini window itself can resize the card', JSON.stringify(before) === JSON.stringify(await bounds()))
    await dragEdge('s', 0, -200)
    const shorter = await bounds()
    check('dragging the bottom edge shrinks the card in place', shorter.height === before.height - 200 && shorter.width === before.width && shorter.x === before.x && shorter.y === before.y, JSON.stringify(shorter))
    check('content follows the new size', await fills())
    await mini.screenshot({ path: path.join(shots, 'todo-resized.png') })
    await mini.mouse.up(); await pause(100)
    // 松手后主进程要忘掉起手位置:此时再来一条不带起手的「拖动」,只能从当前光标重新起算(位移为零)
    await nudge(0, -100); await mini.evaluate(() => window.tangu.miniResize('s')); await pause(100)
    check('releasing ends the resize', JSON.stringify(shorter) === JSON.stringify(await bounds()))
    await mini.evaluate(() => window.tangu.miniResize(null))
    // 贴边折叠时不改大小:缩窄会把露在屏内的把手也带出屏幕,卡片就找不回来了
    const setX = (x) => app.evaluate(({ BrowserWindow }, x) => { const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('window=mini')); w.setPosition(x, w.getBounds().y) }, x)
    const left = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea.x)
    await setX(left + 4); await pause(900)
    const tucked = await bounds()
    await mini.evaluate(() => window.tangu.miniResize('e', true)); await nudge(-60, 0)
    await mini.evaluate(() => window.tangu.miniResize('e')); await pause(100); await nudge(60, 0)
    await mini.evaluate(() => window.tangu.miniResize(null))
    check('a card tucked against the screen edge is not resized', tucked.x < left && JSON.stringify(tucked) === JSON.stringify(await bounds()), JSON.stringify(tucked))
    await setX(left + 40); await pause(900)
    check('pulled back from the edge it is free again', (await bounds()).x === left + 40)
    await dragEdge('nw', 9999, 9999); await mini.mouse.up()
    const smallest = await bounds()
    check('clamped to the minimum, opposite corner anchored', smallest.width === 260 && smallest.height === 160 && smallest.x + smallest.width === shorter.x + shorter.width && smallest.y + smallest.height === shorter.y + shorter.height, JSON.stringify(smallest))
    await switchTo('Tangu'); await mini.waitForSelector('.mini-tangu .t2c-ta'); await pause(300)
    check('no overflow at the minimum size', await fills() && await mini.evaluate(() => { const root = document.querySelector('.mini-card-shell'); return root.scrollWidth === root.clientWidth }))
    await mini.screenshot({ path: path.join(shots, 'tangu-min.png') })
    await dragEdge('e', 120, 0); await mini.mouse.up(); await dragEdge('s', 0, 140); await mini.mouse.up()
    const kept = await bounds()
    await mini.getByRole('button', { name: '关闭 Mini Panel', exact: true }).click()
    for (let i = 0; i < 100 && app.windows().some((w) => w.url().includes('window=mini')); i++) await pause(50)
    await win.evaluate(() => window.tangu.openMini({ spaceId: 'calendar' }))
    for (let i = 0; i < 200; i++) { mini = app.windows().find((w) => w.url().includes('window=mini')); if (mini) break; await pause(50) }
    mini.on('pageerror', (e) => errors.push(`mini: ${e.message}`))
    await mini.waitForSelector('.mini-todo .amx-todo', { timeout: 30000 })
    const reopened = await bounds()
    check('reopened card keeps the size the user chose', reopened.width === kept.width && reopened.height === kept.height && kept.width === 380 && kept.height === 300, JSON.stringify(reopened))
    await mini.screenshot({ path: path.join(shots, 'todo-reopened.png') })
    await mini.getByRole('button', { name: '关闭 Mini Panel', exact: true }).click()
    check('no renderer errors', errors.length === 0, JSON.stringify(errors))
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
