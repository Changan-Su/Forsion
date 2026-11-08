/** Mini 多开(LCL 表面规范第二期)的真 Electron 台架:按实体键复用 / 沿右缘往下排 / 6 扇上限且给提示 /
 * 关一扇不影响别的 / 语音通话自己一扇、不占名额 / 「复制一扇」/ 窗里换了 Space 之后按新实体认 / ⌘⇧M 开合最近那扇,
 * 外加每扇 Mini 的内存与首开耗时(定上限的依据)。
 * npx electron-vite build && npm run check:minimulti。隔离的假引擎 / 笔记库 / 插件;不往别的应用发任何输入。
 * 麦克风用 Chromium 假设备(通话那扇一挂载就拨号,真设备会弹系统授权)。 */
const fs = require('fs'), os = require('os'), path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const { writeWav, RATE, fakeMicSwitches } = require('./lib/voice-fixture.cjs')
const ROOT = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-mini-multi-'))
const shots = path.join(temp, 'screenshots'), results = []
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
function check(name, ok, detail = '') { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`) }
const LIMIT = 6

async function main() {
  const userData = path.join(temp, 'userdata'), vault = path.join(temp, 'vault'), probe = path.join(temp, 'plugins', 'mini-probe')
  for (const dir of [userData, userData + '-dev', vault, shots, probe]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(userData + '-dev', 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault }))
  fs.writeFileSync(path.join(vault, 'Mini note.md'), '# Mini note\n\n- [ ] Review Mini Panel @2026-09-07\n')
  fs.writeFileSync(path.join(probe, 'manifest.json'), JSON.stringify({ id: 'mini-probe', name: 'Mini probe', version: '1.0.0', minAppVersion: '0.0.1' }))
  fs.writeFileSync(path.join(probe, 'main.js'), `
    window.__probeCtx = ctx;
    for (const id of ['full', 'mini']) ctx.registerView({ id, title: 'Mini probe', mount(el, view) {
      const content = document.createElement('div'); content.className = 'mini-probe-' + id;
      const render = () => content.textContent = 'Item: ' + (view.getParams().itemId || 'none');
      el.append(content); render(); const off = view.onParamsChanged(render);
      return () => off();
    } });`)
  const wav = path.join(temp, 'silence.wav'); writeWav(wav, new Int16Array(RATE * 2))
  const session = (id) => ({ id, title: `Chat ${id}`, created_at: '2026-11-07T00:00:00Z', updated_at: '2026-11-07T00:00:00Z', agent_config: { execMode: 'host' } })
  const stub = await startStubEngine({ sessions: ['s-a', 's-b', 's-c', 's-d', 's-e'].map(session) })
  fs.writeFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'mini-multi-token' }))
  let app
  const errors = []
  try {
    app = await electron.launch({ args: [...fakeMicSwitches(wav), `--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: temp, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1', PI_CU_SOCKET_PATH: path.join(temp, 'bridge.sock') } })
    const win = await app.firstWindow()
    win.on('pageerror', (e) => errors.push(`main: ${e.message}`))
    await win.waitForSelector('.dv-groupview', { timeout: 30000, state: 'attached' })
    check('main window left onboarding', await skipOnboarding(win))
    await win.waitForFunction(() => !!window.__probeCtx, null, { timeout: 30000 })

    const seen = new WeakSet()
    const minis = () => app.windows().filter((w) => !w.isClosed() && w.url().includes('window=mini'))
    for (const w of minis()) seen.add(w)
    const watch = () => { for (const w of minis()) if (!seen.has(w)) { seen.add(w); w.on('pageerror', (e) => errors.push(`mini ${w.url()}: ${e.message}`)) } }
    /** 等到有 n 扇 Mini(主进程那边的真窗口数,渲染层页数会晚一点)。 */
    const native = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed() && w.webContents.getURL().includes('window=mini'))
      .map((w) => ({ id: w.id, pid: w.webContents.getOSProcessId(), visible: w.isVisible(), title: w.getTitle(), ...w.getBounds() })))
    const waitCount = async (n) => { let list = []; for (let i = 0; i < 200; i++) { list = await native(); if (list.length === n) break; await pause(50) } watch(); return list }
    /** 找显示着某个选择器的那扇 Mini 页面。 */
    const findMini = async (selector, timeout = 30000, except = []) => {
      const end = Date.now() + timeout
      while (Date.now() < end) {
        watch()
        for (const w of minis()) if (!except.includes(w) && await w.locator(selector).count().catch(() => 0)) return w
        await pause(100)
      }
      throw new Error(`no Mini shows ${selector}`)
    }
    const open = (opts) => win.evaluate((o) => window.tangu.openMini(o), opts)
    const area = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
    const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
    const noOverlap = (list) => list.every((a, i) => list.every((b, j) => i === j || !overlap(a, b)))

    // 1. 第一扇:右上角(同原来的单例),记首开耗时与内存
    const t0 = Date.now()
    const r1 = await open({ spaceId: 'calendar' })
    const calendar = await findMini('.mini-card-shell[data-space="calendar"]')
    const firstOpenMs = Date.now() - t0
    let list = await waitCount(1)
    check('first Mini opens top-right like before', r1?.ok === true && r1.reused === false && list.length === 1
      && list[0].x + list[0].width === area.x + area.width - 24 && list[0].y === area.y + 24, JSON.stringify({ r1, list, area }))

    // 2. 同一实体再开 = 叫出那扇 + 轻跳,不另开
    await calendar.evaluate(() => { window.__nudges = 0; window.tangu.onMiniNudge(() => window.__nudges++) })
    const r2 = await open({ spaceId: 'calendar', params: { anything: 1 } })
    await pause(300)
    list = await waitCount(1)
    check('same entity reopens the open window (focus + nudge, no second window)', r2?.ok && r2.reused && list.length === 1
      && await calendar.evaluate(() => window.__nudges) === 1, JSON.stringify(r2))

    // 3. 不同实体各开一扇,沿右缘往下排、不叠
    await open({ sessionId: 's-a' }); const chatA = await findMini('.mini-tangu [data-session-id="s-a"]')
    await open({ sessionId: 's-b' }); const chatB = await findMini('.mini-tangu [data-session-id="s-b"]')
    list = await waitCount(3)
    const right = area.x + area.width - 24
    check('three entities, three windows, stacked down the right edge without overlap', list.length === 3 && noOverlap(list)
      && list.filter((b) => b.x + b.width === right).length >= 2, JSON.stringify(list))
    const ra = await open({ sessionId: 's-a' })
    check('reopening a chat session focuses its window', ra?.reused === true && (await waitCount(3)).length === 3)

    // 4. 窗口标题 = 胶囊上的名字(托盘「全部 Mini」按它列)
    await pause(300)
    list = await native()
    check('window titles carry the capsule names for the tray list', list.some((b) => /ToDo List/.test(b.title)) && list.filter((b) => /Tangu|Chat s-/.test(b.title)).length === 2, JSON.stringify(list.map((b) => b.title)))

    // 5. 插件直开 + key、再补到 6 扇;第 7 扇不开,结果交回、主窗出提示
    await win.evaluate(() => window.__probeCtx.openMiniPanel('mini', { params: { itemId: '1' }, key: 'k1' }))
    await findMini('.mini-probe-mini')
    await win.evaluate(() => window.__probeCtx.openMiniPanel('mini', { params: { itemId: '2' }, key: 'k1' }))
    await pause(400)
    check('plugin openMiniPanel with the same key reuses its window', (await waitCount(4)).length === 4)
    await open({ sessionId: 's-c' }); await open({ sessionId: 's-d' })
    list = await waitCount(LIMIT)
    check(`${LIMIT} Mini windows open side by side without overlap`, list.length === LIMIT && noOverlap(list), JSON.stringify(list))
    const over = await open({ sessionId: 's-e' })
    await pause(500)
    check('the 7th is refused with a reason, not silently', over?.ok === false && over.reason === 'limit' && over.limit === LIMIT && (await native()).length === LIMIT, JSON.stringify(over))
    await win.evaluate(() => window.__probeCtx.openMiniPanel('mini', { key: 'k2' }))
    await win.waitForFunction(() => document.body.innerText.includes('最多同时开 6 个 Mini 窗口'), null, { timeout: 5000 }).catch(() => {})
    check('the user sees why (notification in the main window)', await win.evaluate(() => document.body.innerText.includes('最多同时开 6 个 Mini 窗口')))
    await win.screenshot({ path: path.join(shots, 'limit-notice-main.png') })

    // 6. 满了在 Mini 里点「复制一扇」:卡片里出提示(Mini 窗没有通知宿主)
    await calendar.locator('.mini-card-space').click()
    await calendar.locator('.mini-card-popover').getByRole('button', { name: '复制一扇', exact: true }).click()
    await calendar.locator('.mini-card-notice').waitFor({ timeout: 5000 }).catch(() => {})
    check('duplicate at the limit shows the notice inside the card', /最多同时开 6 个/.test(await calendar.locator('.mini-card-notice').textContent().catch(() => '')))
    await calendar.screenshot({ path: path.join(shots, 'limit-notice-mini.png') })

    // 7. 语音通话:自己一扇,不占名额,不顶掉别的 Mini;再拨一通 = 同一扇
    const call = (sid, duplicate) => open({ view: { type: 'voice-call', params: { sessionId: sid, model: 'stub/realtime', title: '语音通话' } },
      mainView: { type: 'chat', params: { sessionId: sid } }, title: '语音通话', ...(duplicate ? { duplicate: true } : {}) })
    const rc = await call('s-a')
    const voice = await findMini('.mini-card-shell[data-space="direct"] .mini-panel-view[data-view="voice-call"]')
    list = await waitCount(LIMIT + 1)
    check('voice call gets its own window even at the limit', rc?.ok && !rc.reused && list.length === LIMIT + 1 && noOverlap(list), JSON.stringify({ rc, n: list.length }))
    check('voice call did not replace any ordinary Mini', await calendar.locator('.mini-card-shell[data-space="calendar"]').count() === 1
      && await chatA.locator('[data-session-id="s-a"]').count() > 0)
    const rc2 = await call('s-b')
    await pause(400)
    check('a second call reuses the voice window', rc2?.reused === true && (await native()).length === LIMIT + 1)
    const rc3 = await call('s-b', true)
    await pause(300)
    check('even duplicate: true cannot open a second voice window', rc3?.reused === true && (await native()).length === LIMIT + 1, JSON.stringify(rc3))
    check('the voice window offers no duplicate', await voice.locator('.mini-card-space').isDisabled())
    await voice.screenshot({ path: path.join(shots, 'voice.png') })

    // 8. 关一扇:别的照旧在、内容不变;空出名额后「复制一扇」能开,落在空出来的位置
    const bBox = (await native()).find((b) => b.title.includes('s-b'))
    await chatB.getByRole('button', { name: '关闭 Mini Panel', exact: true }).click()
    list = await waitCount(LIMIT)
    check('closing one leaves the others alone', list.length === LIMIT && await calendar.locator('.mini-card-shell[data-space="calendar"]').count() === 1
      && await chatA.locator('[data-session-id="s-a"]').count() > 0 && await voice.locator('[data-view="voice-call"]').count() === 1)
    await calendar.locator('.mini-card-space').click()
    await calendar.locator('.mini-card-popover .mini-card-row-duplicate').waitFor()
    await calendar.waitForTimeout(400) // 下拉的液滴动效走完再截
    await calendar.screenshot({ path: path.join(shots, 'duplicate-menu.png') })
    await calendar.locator('.mini-card-popover').getByRole('button', { name: '复制一扇', exact: true }).click()
    list = await waitCount(LIMIT + 1)
    const dupPage = await findMini('.mini-card-shell[data-space="calendar"]', 30000, [calendar]).catch(() => null)
    check('duplicate window opens a second copy of the same Space', !!dupPage && list.length === LIMIT + 1 && noOverlap(list), JSON.stringify(list))
    const dupBox = list.reduce((a, b) => (b.id > a.id ? b : a)) // 最新建的那扇
    check('the copy reuses the freed slot', !!bBox && dupBox.x === bBox.x && dupBox.y === bBox.y, JSON.stringify({ bBox, dupBox }))

    // 9. 窗里换了 Space 之后,按新实体认:再开那个 Space 叫出这扇
    const dup = dupPage
    await dup.locator('.mini-card-space').click()
    await dup.locator('.mini-card-popover').getByRole('button', { name: 'Tangu', exact: true }).click()
    await dup.waitForSelector('.mini-card-shell[data-space="tangu"]')
    await pause(400)
    const rt = await open({ spaceId: 'tangu' })
    await pause(300)
    check('after switching Space inside, opening that Space focuses this window', rt?.reused === true && (await native()).length === LIMIT + 1, JSON.stringify(rt))

    // 10. ⌘⇧M(不带目标)开合最近用过的那扇
    const dupWin = await app.browserWindow(dup)
    await open(undefined); await pause(300)
    const hidden = !(await dupWin.evaluate((w) => w.isVisible()))
    await open(undefined); await pause(300)
    check('hotkey toggles the most recently used Mini', hidden && await dupWin.evaluate((w) => w.isVisible()))

    // 11. 内存:每扇 Mini 一个渲染进程
    const metrics = await app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, ws: m.memory.workingSetSize, priv: m.memory.privateBytes })))
    list = await native()
    const per = list.map((b) => metrics.find((m) => m.pid === b.pid)).filter(Boolean)
    const mb = (kb) => Math.round(kb / 1024)
    const avg = per.reduce((s, m) => s + m.ws, 0) / Math.max(1, per.length)
    const mainPid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('window='))?.webContents.getOSProcessId())
    const mainWs = metrics.find((m) => m.pid === mainPid)?.ws ?? 0
    console.log(`MEMORY ${per.length} Mini renderers: avg ${mb(avg)} MB, max ${mb(Math.max(...per.map((m) => m.ws)))} MB, min ${mb(Math.min(...per.map((m) => m.ws)))} MB (working set); main window renderer ${mb(mainWs)} MB; first open ${firstOpenMs} ms`)
    check('every Mini has its own renderer process measured', per.length === list.length && avg > 0)
    for (const w of minis()) await w.screenshot({ path: path.join(shots, `mini-${minis().indexOf(w)}.png`) }).catch(() => {})
    const voiceErr = errors.filter((e) => !/voice|realtime|WebSocket|getUserMedia/i.test(e))
    check('no renderer errors', voiceErr.length === 0, JSON.stringify(errors))
    console.log(`SCREENSHOTS ${shots}`)
  } catch (e) {
    if (app) {
      console.log('NATIVE', JSON.stringify(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ url: w.webContents.getURL().slice(-60), title: w.getTitle(), visible: w.isVisible(), ...w.getBounds() }))).catch(() => [])))
      for (const [i, page] of app.windows().entries()) { await page.screenshot({ path: path.join(shots, `failure-window-${i}.png`) }).catch(() => {}); console.log(`--- window ${i} ${page.url().slice(-60)}\n`, (await page.locator('body').innerText().catch(() => '')).slice(0, 600)) }
    }
    console.log('ERRORS', JSON.stringify(errors))
    console.error(`FAILURE_SCREENSHOTS ${shots}`); throw e
  } finally { if (app) await app.close().catch(() => {}); await stub.close() }
  console.log(`${results.filter(Boolean).length}/${results.length} passed`)
  if (results.some((ok) => !ok)) process.exitCode = 1
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
