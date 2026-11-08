/** workspace.open(LCL 表面规范第三期)的真 Electron 台架:探针插件经 ctx.workspace.open / 旧三件打开自己的视图,看它们落到哪。
 *  ① Space 作用域浮层挂 View(取 forms.mini 的紧凑视图,surface = mini),同一份再开不另开、换参数;切走 Space 就藏、回来再出;
 *  ② 窗口作用域 + main 样子(surface = floating);③「在主面板显示」→ 主区开主视图、卡收掉;
 *  ④ 停靠回落(只能在侧栏的视图开主区 → 右栏);⑤ 桌面 Mini:workspace.open 和旧 openMiniPanel 指同一实体 = 同一扇;
 *  ⑥ Floating Panel:pin:true 置顶,旧 openFloatingPanel 再开同一扇且撤掉置顶;
 *  ⑦ Mini pin:false 不置顶、拖到屏幕边不折起来(对照:置顶的那扇会折);同一扇不带 pin 再开 = 回到置顶;贴着边折起来的那扇
 *     用 pin:false 再开 = 先展开再撤置顶;
 *  ⑧⑨ 重启(同一份 userData):Space 作用域的卡按布局开回来(插件晚到也等得到,锚点 / 参数是退出前那样);Mini 按实体键回到
 *     退出前的位置(userData/mini-windows.json);⑩ 没有渲染层报错。
 *  npx electron-vite build && npm run check:workspaceopen(上锁:node ../../.claude/hooks/devlock.cjs run --vehicle=e2e -- npm run check:workspaceopen)。
 *  隔离的假引擎 / 笔记库 / 插件;不往别的应用发任何输入。插件停用收卡在单测(workspaceOpenCtx / workspaceOpen.test)。 */
const fs = require('fs'), os = require('os'), path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-workspace-open-'))
const shots = path.join(temp, 'screenshots'), results = []
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
function check(name, ok, detail = '') { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : detail}`) }

const PROBE = `
  window.__probeCtx = ctx;
  const mk = (id, forms) => ctx.registerView({ id, title: 'Probe ' + id, ...(forms ? { forms } : {}), mount(el, view) {
    const box = document.createElement('div'); box.className = 'wo-probe wo-probe-' + id;
    box.style.cssText = 'padding:12px;font:13px system-ui;line-height:1.6';
    const render = () => { box.dataset.surface = view.surface || ''; box.textContent = id + ' · ' + (view.surface || '?') + ' · item ' + (view.getParams().item || '-'); };
    el.append(box); render(); const off = view.onParamsChanged(render);
    return () => off();
  } });
  mk('board', { main: true, side: true, mini: { view: 'board-mini' } });
  mk('board-mini');
  mk('side-only', { side: true });`

async function main() {
  const userData = path.join(temp, 'userdata'), vault = path.join(temp, 'vault'), probe = path.join(temp, 'plugins', 'wo-probe')
  for (const dir of [userData, userData + '-dev', vault, shots, probe]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(userData + '-dev', 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault }))
  fs.writeFileSync(path.join(vault, 'Note.md'), '# Note\n')
  fs.writeFileSync(path.join(probe, 'manifest.json'), JSON.stringify({ id: 'wo-probe', name: 'Workspace open probe', version: '1.0.0', minAppVersion: '0.0.1' }))
  fs.writeFileSync(path.join(probe, 'main.js'), PROBE)
  const stub = await startStubEngine({ sessions: [] })
  fs.writeFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'wo-token' }))
  let app
  const errors = []
  const launch = () => electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
    env: { ...process.env, TANGU_HOME: temp, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1', PI_CU_SOCKET_PATH: path.join(temp, 'bridge.sock') } })
  try {
    app = await launch()
    let win = await app.firstWindow()
    win.on('pageerror', (e) => errors.push(`main: ${e.message}`))
    await win.waitForSelector('.dv-groupview', { timeout: 30000, state: 'attached' })
    check('main window left onboarding', await skipOnboarding(win))
    await win.waitForFunction(() => !!window.__probeCtx?.workspace?.open, null, { timeout: 30000 })
    const wopen = (target, opts) => win.evaluate(([t, o]) => window.__probeCtx.workspace.open(t, o).then((r) => ({ ...r, close: !!r.close, closed: undefined })), [target, opts])
    const cards = (scope) => win.locator(`.lcl-float-layer[data-scope="${scope}"] > .lcl-float[data-view-float]`)

    // ① Space 作用域:紧凑视图、surface = mini、再开同一张
    const r1 = await wopen({ view: 'board', params: { item: '1' } }, { layer: { float: 'space' } })
    await win.locator('.lcl-float-layer[data-scope="space"] .wo-probe-board-mini').waitFor({ timeout: 10000 })
    check('space float shows the declared compact view in the Mini look', r1.ok && r1.layer.float === 'space' && r1.form === 'mini' && r1.close
      && await win.locator('.lcl-float-layer[data-scope="space"] .wo-probe-board-mini').getAttribute('data-surface') === 'mini', JSON.stringify(r1))
    await pause(600)
    await win.screenshot({ path: path.join(shots, 'space-float.png') })
    await wopen({ view: 'board', params: { item: '2' } }, { layer: { float: 'space' } })
    await pause(300)
    check('reopening the same view reuses the card and takes the new params', await cards('space').count() === 1
      && /item 2/.test(await win.locator('.wo-probe-board-mini').textContent()))
    const spaceCard = cards('space').first()
    // 回来点的是刚才亮着的那颗(主页那颗在 .rb-home,不是 .rb-slot)
    const home = await win.evaluate(() => document.querySelector('.rb-space[aria-current="page"]')?.getAttribute('aria-label'))
    const other = await win.evaluate(() => [...document.querySelectorAll('.rb-slot[data-id^="space:"]')].find((b) => !b.querySelector('.rb-space[aria-current="page"]'))?.getAttribute('data-id'))
    await win.locator(`.rb-slot[data-id="${other}"] .rb-space`).first().click()
    await pause(800)
    const hiddenAway = await spaceCard.evaluate((el) => el.hidden)
    if (home) await win.locator(`.rb-space[aria-label="${home}"]`).first().click()
    await pause(800)
    check('switching Space hides the card, coming back shows it again', hiddenAway && !(await spaceCard.evaluate((el) => el.hidden)), JSON.stringify({ home, other, hiddenAway }))

    // ② 窗口作用域 + main 样子
    const r2 = await wopen('board', { layer: { float: 'window', anchor: 'top-end' }, form: 'main' })
    await win.locator('.lcl-float-layer[data-scope="window"] .wo-probe-board').waitFor({ timeout: 10000 })
    check('window float in the main look shows the view itself (surface floating)', r2.ok && r2.form === 'main' && r2.layer.float === 'window'
      && await win.locator('.lcl-float-layer[data-scope="window"] .wo-probe-board').getAttribute('data-surface') === 'floating'
      && await cards('window').first().getAttribute('data-anchor') === 'top-end', JSON.stringify(r2))
    await pause(600) // 等入场淡入走完再截
    await win.screenshot({ path: path.join(shots, 'space-and-window-float.png') })
    await win.evaluate(() => window.__probeCtx.workspace.open('board', { layer: { float: 'window' }, form: 'main' }).then((r) => r.close()))
    await pause(400)
    check('close() takes the window card away', await cards('window').count() === 0)

    // ③ 在主面板显示
    await spaceCard.locator('.lcl-float-view-head button').first().click()
    await win.locator('.dv-groupview .wo-probe-board').first().waitFor({ timeout: 10000 })
    await pause(400)
    check('"Show in main panel" opens the main view in the main area and closes the card', await cards('space').count() === 0
      && /item 2/.test(await win.locator('.dv-groupview .wo-probe-board').first().textContent()))

    // ④ 停靠回落
    const r4 = await wopen('side-only', { layer: { dock: 'main' } })
    await win.locator('.wo-probe-side-only').first().waitFor({ timeout: 10000 })
    check('a side-only view asked for the main area docks in the right panel', r4.ok && r4.layer.dock === 'right' && r4.form === 'side', JSON.stringify(r4))

    // ⑤ 桌面 Mini:新入口和旧 openMiniPanel(紧凑视图 + mainViewId)是同一实体
    const minis = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.getURL().includes('window=mini')).map((w) => w.id))
    const r5 = await wopen({ view: 'board', params: { item: '5' } }, { layer: { float: 'desktop' } })
    let miniPage = null
    for (let i = 0; i < 100 && !miniPage; i++) {
      for (const p of app.windows()) if (!p.isClosed() && p.url().includes('window=mini') && await p.locator('.wo-probe-board-mini').count().catch(() => 0)) miniPage = p
      if (!miniPage) await pause(100)
    }
    if (miniPage) miniPage.on('pageerror', (e) => errors.push(`mini: ${e.message}`))
    check('desktop + mini opens a Mini window with the compact view, titled after the main view', r5.ok && r5.layer.float === 'desktop' && r5.form === 'mini' && !!miniPage
      && await miniPage.locator('.wo-probe-board-mini').getAttribute('data-surface') === 'mini'
      && /^Probe board$/.test(await miniPage.locator('.mini-card-space span').first().textContent().catch(() => '')), JSON.stringify(r5))
    if (miniPage) await miniPage.screenshot({ path: path.join(shots, 'desktop-mini.png') })
    await win.evaluate(() => window.__probeCtx.openMiniPanel('board-mini', { mainViewId: 'board', params: { item: '6' } }))
    await pause(800)
    check('old openMiniPanel(compact, { mainViewId }) reuses that same Mini window', (await minis()).length === 1
      && /item 6/.test((miniPage ? await miniPage.locator('.wo-probe-board-mini').textContent().catch(() => '') : '') || ''))

    // ⑥ Floating Panel:pin 置顶;旧入口再开同一扇、撤掉置顶
    const floating = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.getURL().includes('window=floating')).map((w) => ({ id: w.id, top: w.isAlwaysOnTop(), title: w.getTitle() })))
    const r6 = await wopen('board', { layer: { float: 'desktop', pin: true }, form: 'main' })
    let fl = []
    for (let i = 0; i < 100 && !fl.length; i++) { fl = await floating(); if (!fl.length) await pause(100) }
    check('desktop + main opens the Floating Panel, pinned on top', r6.ok && r6.form === 'main' && fl.length === 1 && fl[0].top === true, JSON.stringify({ r6, fl }))
    await win.evaluate(() => window.__probeCtx.openFloatingPanel('board'))
    await pause(500)
    const fl2 = await floating()
    check('old openFloatingPanel reopens that window and it is no longer on top (desktop ≠ on top)', fl2.length === 1 && fl2[0].id === fl[0]?.id && fl2[0].top === false, JSON.stringify(fl2))

    // ⑦ Mini pin:false
    const miniWins = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.getURL().includes('window=mini'))
      .map((w) => ({ id: w.id, top: w.isAlwaysOnTop(), ...w.getBounds() })))
    const pinnedId = (await miniWins())[0]?.id
    const r7 = await wopen({ view: 'board', params: { item: '7' } }, { layer: { float: 'desktop', pin: false }, key: 'loose' })
    let loose = null
    for (let i = 0; i < 100 && !loose; i++) { loose = (await miniWins()).find((w) => w.id !== pinnedId) ?? null; if (!loose) await pause(100) }
    check('desktop + mini with pin:false opens a Mini that is not on top (the other stays on top)', r7.ok && !!loose && loose.top === false
      && (await miniWins()).find((w) => w.id === pinnedId)?.top === true, JSON.stringify({ r7, list: await miniWins() }))
    const area = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
    const toEdge = (id) => app.evaluate(({ BrowserWindow }, [id, area]) => { const w = BrowserWindow.fromId(id); const b = w.getBounds(); w.setBounds({ x: area.x + area.width - b.width, y: b.y }) }, [id, area])
    const boundsOf = async (id) => (await miniWins()).find((w) => w.id === id)
    await toEdge(loose.id); await toEdge(pinnedId)
    await pause(1200)
    const looseAtEdge = await boundsOf(loose.id), pinnedAtEdge = await boundsOf(pinnedId)
    check('dragged to the screen edge: the pinned Mini folds, the unpinned one does not', pinnedAtEdge.x + pinnedAtEdge.width > area.x + area.width + 40
      && looseAtEdge.x + looseAtEdge.width === area.x + area.width, JSON.stringify({ area, pinnedAtEdge, looseAtEdge }))
    await wopen({ view: 'board', params: { item: '7' } }, { layer: { float: 'desktop' }, key: 'loose' })
    await pause(400)
    check('reopening that Mini without pin puts it back on top', (await boundsOf(loose.id))?.top === true)
    await wopen({ view: 'board', params: { item: '5' } }, { layer: { float: 'desktop', pin: false } })
    await pause(1200)
    const unfolded = await boundsOf(pinnedId)
    check('reopening the folded Mini with pin:false unfolds it first, then drops on-top', unfolded && unfolded.top === false && unfolded.x + unfolded.width <= area.x + area.width, JSON.stringify(unfolded))

    // ⑧ 退出前:Space 作用域开一张卡(锚点 / 参数 / key);那扇不置顶的 Mini 挪到空处
    await wopen({ view: 'board', params: { item: '8' } }, { layer: { float: 'space', anchor: 'top-start' }, key: 'keep' })
    await win.locator('.lcl-float-layer[data-scope="space"] .wo-probe-board-mini').waitFor({ timeout: 10000 })
    await wopen({ view: 'board', params: { item: '7' } }, { layer: { float: 'desktop', pin: false }, key: 'loose' })
    const spot = { x: area.x + 180, y: area.y + 160 }
    await app.evaluate(({ BrowserWindow }, [id, spot]) => BrowserWindow.fromId(id).setBounds(spot), [loose.id, spot])
    await pause(1200) // 判贴边 200ms + 记位置 + 400ms 去抖落盘 + 布局 100ms 去抖
    const looseBefore = await boundsOf(loose.id)
    await app.close()
    app = null
    const files = [path.join(userData, 'mini-windows.json'), path.join(userData + '-dev', 'mini-windows.json')].filter((f) => fs.existsSync(f))
    const saved = files.length ? JSON.parse(fs.readFileSync(files[0], 'utf8')) : {}
    const savedLoose = saved['view:plugin:wo-probe:board-mini#key:loose']
    check('Mini positions are written to userData/mini-windows.json by entity', !!savedLoose && savedLoose.x === looseBefore.x && savedLoose.y === looseBefore.y, JSON.stringify({ files, saved, looseBefore }))

    // ⑨ 重启
    app = await launch()
    win = await app.firstWindow()
    win.on('pageerror', (e) => errors.push(`main(2): ${e.message}`))
    await win.waitForSelector('.dv-groupview', { timeout: 30000, state: 'attached' })
    await win.waitForFunction(() => !!window.__probeCtx?.workspace?.open, null, { timeout: 30000 })
    await win.locator('.lcl-float-layer[data-scope="space"] .wo-probe-board-mini').waitFor({ timeout: 15000 }).catch(() => {})
    const back = cards('space')
    check('after a restart the Space card comes back with its params and anchor (plugin views register late)', await back.count() === 1
      && /item 8/.test(await win.locator('.lcl-float-layer[data-scope="space"] .wo-probe-board-mini').textContent().catch(() => ''))
      && await back.first().getAttribute('data-anchor') === 'top-start', JSON.stringify({ n: await back.count() }))
    await pause(600)
    await win.screenshot({ path: path.join(shots, 'restored-space-float.png') })
    await wopen({ view: 'board', params: { item: '7' } }, { layer: { float: 'desktop', pin: false }, key: 'loose' })
    let again = null
    for (let i = 0; i < 100 && !again; i++) { again = (await miniWins())[0] ?? null; if (!again) await pause(100) }
    check('after a restart the same Mini entity reopens where it was', !!again && again.x === looseBefore.x && again.y === looseBefore.y && again.top === false, JSON.stringify({ again, looseBefore }))

    check('no renderer errors', errors.length === 0, JSON.stringify(errors))
    console.log(`SCREENSHOTS ${shots}`)
  } catch (e) {
    if (app) for (const [i, page] of app.windows().entries()) { await page.screenshot({ path: path.join(shots, `failure-window-${i}.png`) }).catch(() => {}); console.log(`--- window ${i} ${page.url().slice(-60)}\n`, (await page.locator('body').innerText().catch(() => '')).slice(0, 600)) }
    console.log('ERRORS', JSON.stringify(errors))
    console.error(`FAILURE_SCREENSHOTS ${shots}`); throw e
  } finally { if (app) await app.close().catch(() => {}); await stub.close() }
  console.log(`${results.filter(Boolean).length}/${results.length} passed`)
  if (results.some((ok) => !ok)) process.exitCode = 1
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
