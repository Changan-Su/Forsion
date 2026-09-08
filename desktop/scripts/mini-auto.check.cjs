/** Automatic Mini: real IPC, two isolated Electron processes and a replayable running session.
 * Default: companion process owns OS focus; helper lease is simulated (no physical HID).
 * npm run build && npm run check:miniauto
 * --native-helper [executable]: real helper/HID path against our own fixture window. */
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const nativeArg = process.argv.indexOf('--native-helper')
const nativeExecutable = nativeArg < 0 ? null : (process.argv[nativeArg + 1] || '/Applications/tangu-computer-use.app/Contents/MacOS/bridge')
const ROOT = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-mini-auto-'))
const pause = (ms) => new Promise((r) => setTimeout(r, ms)), results = []
function check(name, ok) { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) throw new Error(name) }
async function until(fn, timeout = 20000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const v = await fn(); if (v) return v; await pause(80) }
  throw new Error('Timed out: ' + fn.toString())
}

// Live replay has independent SSE clients for main + Mini. All unrelated boot endpoints use the common stub.
async function liveBackend() {
  const stub = await startStubEngine({ sessions: [{ id: 'current-cu', title: 'Computer Use current conversation', created_at: '2026-09-08T00:00:00Z', updated_at: '2026-09-08T00:00:00Z', agent_config: { execMode: 'host' } }] })
  const runs = []
  const emit = (run, type, payload) => {
    const event = { seq: run.events.length + 1, type, payload }
    run.events.push(event)
    for (const res of run.clients) { res.write(`data: ${JSON.stringify(event)}\n\n`); if (type === 'done') res.end() }
    if (type === 'done') { run.status = 'done'; run.clients.clear() }
  }
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://test'), p = u.pathname
    const json = (body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (p === '/agent/runs' && req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw), id = `r${runs.length + 1}`
      const run = { id, sessionId: body.session_id, status: 'running', assistant_message_id: `a-${id}`, events: [], clients: new Set() }
      runs.push(run); emit(run, 'token', { delta: `Working in the foreground (${id}).` })
      return json({ runId: id, assistantMessageId: run.assistant_message_id, userMessageId: `u-${id}` })
    }
    if (p === '/agent/runs' && req.method === 'GET') return json({ runs: runs.filter((r) => r.sessionId === u.searchParams.get('session_id')).map(({ id, status, assistant_message_id }) => ({ id, status, assistant_message_id })) })
    if (/^\/agent\/runs\/[^/]+\/events$/.test(p)) {
      const run = runs.find((r) => r.id === p.split('/')[3])
      if (!run) return json({})
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      for (const event of run.events) res.write(`data: ${JSON.stringify(event)}\n\n`)
      if (run.status === 'done') return res.end()
      run.clients.add(res); res.on('close', () => run.clients.delete(res)); return
    }
    const proxy = http.request(stub.url + req.url, { method: req.method, headers: req.headers }, (incoming) => {
      res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res)
    })
    proxy.on('error', () => { res.writeHead(502); res.end() }); req.pipe(proxy)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, runs, emit,
    close: async () => { for (const run of runs) for (const res of run.clients) res.end(); server.closeAllConnections(); server.close(); await stub.close() } }
}

async function main() {
  if (process.platform !== 'darwin') { console.log('SKIP automatic Mini requires the macOS foreground helper'); return }
  const backend = await liveBackend(), userData = path.join(temp, 'userdata'), shots = path.join(temp, 'screenshots')
  fs.mkdirSync(userData + '-dev', { recursive: true }); fs.mkdirSync(shots)
  fs.writeFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: backend.url, token: 'mini-auto-test-token' }))
  const externalEntry = path.join(temp, 'external.cjs')
  fs.writeFileSync(externalEntry, `const { app, BrowserWindow } = require('electron'); app.whenReady().then(() => {
    const w = new BrowserWindow({ width: 540, height: 240, title: 'Mini automatic test — foreground fixture' });
    w.loadURL('data:text/html,<h2>Computer Use foreground fixture</h2><p>Isolated test window for Mini Panel.</p>');
  });`)
  let app, external, heartbeat, nativeHelper, nativeAsk
  const signal = () => { const now = Date.now(); fs.writeFileSync(path.join(temp, 'foreground.json'), JSON.stringify({ v: 1, active: true, updatedAt: now, expiresAt: now + 2500, helperPid: process.pid })) }
  const startInput = () => { signal(); heartbeat = setInterval(signal, 500) }
  const stopInput = () => { clearInterval(heartbeat); heartbeat = null; fs.rmSync(path.join(temp, 'foreground.json'), { force: true }) }
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: temp, TANGU_BACKEND_URL: backend.url, PI_CU_SOCKET_PATH: path.join(temp, 'bridge.sock') } })
    const win = await app.firstWindow(), errors = []
    app.on('window', (page) => page.on('pageerror', (e) => errors.push(e.message)))
    win.on('pageerror', (e) => errors.push(e.message))
    await win.waitForSelector('.dv-groupview', { timeout: 30000, state: 'attached' })
    for (const name of ['跳过引导', 'Skip']) { const b = win.getByRole('button', { name, exact: true }); if (await b.count()) { await b.click(); break } }
    await win.waitForSelector('.t2c-ta')
    const send = async () => {
      await win.locator('.t2c-ta').first().fill('Continue Computer Use')
      await win.locator('.t2c-ta').first().press('Enter')
      return until(() => backend.runs.at(-1)?.status === 'running' && backend.runs.at(-1))
    }
    const focusMain = async () => {
      await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); const w = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('window=')); w.show(); w.focus() })
      await until(() => app.evaluate(({ BrowserWindow }) => !!BrowserWindow.getFocusedWindow()))
    }
    const autoWindows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('transient=1')).map((w) => ({ id: w.id, visible: w.isVisible(), focused: w.isFocused() })))
    const autoVisible = async () => (await autoWindows()).find((w) => w.visible)
    let run = await send()
    await win.waitForSelector(`[data-chat-surface="chat"][data-session-id="${run.sessionId}"]`)
    if (!nativeExecutable) {
      await focusMain(); startInput(); await pause(700)
      check('foreground calls inside Forsion do not open Mini', (await autoWindows()).length === 0)
      stopInput()
    }
    external = await electron.launch({ args: [`--user-data-dir=${path.join(temp, 'external-data')}`, externalEntry], cwd: ROOT })
    const focusExternal = async () => {
      await external.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus() })
      await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow() === null))
    }
    await external.firstWindow(); await focusExternal(); await pause(500)
    check('external focus without physical input does not open Mini', (await autoWindows()).length === 0)
    const savedMini = await win.evaluate(() => { localStorage.setItem('forsion_mini_active_space', 'amadeus'); return Object.fromEntries(Object.entries(localStorage).filter(([k]) => /mini/.test(k))) })
    if (nativeExecutable) {
      // The native executable alone owns foreground.json and the physical cursor.
      // Keep a real running-session SSE fixture so no model/provider is needed.
      const net = require('net'), { spawn } = require('child_process')
      nativeAsk = (payload) => new Promise((resolve, reject) => {
        const socket = net.createConnection(path.join(temp, 'bridge.sock')); let data = ''
        const finish = (error, value) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value) }
        const timer = setTimeout(() => finish(new Error(`Native timeout: ${payload.cmd}`)), 20000)
        socket.on('error', (error) => finish(error))
        socket.on('connect', () => socket.write(JSON.stringify({ id: 'mini-native', ...payload }) + '\n'))
        socket.on('data', (chunk) => {
          data += chunk; if (!data.includes('\n')) return
          try { const response = JSON.parse(data.split('\n')[0]); finish(response.ok ? null : new Error(JSON.stringify(response.error)), response.result) }
          catch (error) { finish(error) }
        })
      })
      nativeHelper = spawn(nativeExecutable, ['serve', '--socket', path.join(temp, 'bridge.sock')], { stdio: 'ignore' })
      let nativeError; nativeHelper.on('error', (error) => { nativeError = error })
      const diagnostics = await until(async () => { if (nativeError) throw nativeError; return nativeAsk({ cmd: 'diagnostics' }).catch(() => false) })
      check('real helper has Accessibility permission', diagnostics.accessibility === true)
      const initial = JSON.parse(fs.readFileSync(path.join(temp, 'foreground.json'), 'utf8'))
      check('packaged helper creates its own idle signal', initial.v === 1 && !initial.active && initial.helperPid === nativeHelper.pid)
      const pid = await external.evaluate(() => process.pid)
      const roots = await nativeAsk({ cmd: 'listWindows', pid })
      const target = roots.find((w) => w.windowId)
      check('native helper resolves only the owned fixture window', !!target)
      const look = await nativeAsk({ cmd: 'look', pid, windowId: target.windowId, includeImage: true, readText: 'never' })
      await focusMain()
      check('Mini is absent before real foreground activation', (await autoWindows()).length === 0)
      const move = (x) => nativeAsk({ cmd: 'act', pid, lookId: look.lookId, action: 'moveMouse', target: { x, y: 100 }, policy: 'foreground', cursorOverlay: false, deferRootDelta: true })
      const action = await move(100)
      check('real physical input activates the external fixture', action.performed?.delivery === 'hid' && (await nativeAsk({ cmd: 'getFrontmost' })).pid === pid)
      await until(autoVisible)
      const mini = await until(() => app.windows().find((w) => w.url().includes('transient=1')))
      await mini.getByText('Working in the foreground (r1).', { exact: true }).waitFor()
      check('native foreground input automatically opens the current conversation', true)
      check('automatic Mini leaves focus in the external app', (await nativeAsk({ cmd: 'getFrontmost' })).pid === pid)
      await pause(700)
      const lease = JSON.parse(fs.readFileSync(path.join(temp, 'foreground.json'), 'utf8'))
      check('real short-input lease expires while Mini keeps the current run visible', lease.expiresAt < Date.now() && !!await autoVisible())
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('transient=1'))
        globalThis.__nativeSamples = []
        globalThis.__nativeTimer = setInterval(() => globalThis.__nativeSamples.push({ ...w.getBounds(), at: performance.now() }), 8)
      })
      await move(148); await pause(650)
      const samples = await app.evaluate(() => { clearInterval(globalThis.__nativeTimer); return globalThis.__nativeSamples })
      fs.writeFileSync(path.join(shots, 'native-motion.json'), JSON.stringify(samples))
      const moving = samples.filter((p, i) => i && p.x !== samples[i - 1].x)
      check('real mouse movement produces a visible window transition', moving.length >= 6 && moving.at(-1).at - moving[0].at >= 140)
      await mini.screenshot({ path: path.join(shots, 'native-current-conversation.png') })
      backend.emit(run, 'token', { delta: ' Real native input completed.' })
      await mini.getByText('Working in the foreground (r1). Real native input completed.', { exact: true }).waitFor()
      check('current conversation continues streaming after native input', true)
      backend.emit(run, 'done', {}); await until(async () => (await autoWindows()).length === 0)
      check('run completion closes native-triggered Mini', true)
      check('no renderer errors', errors.length === 0)
      console.log(`SCREENSHOTS ${shots}\n${results.filter(Boolean).length}/${results.length} passed (real native helper)`)
      return
    }
    startInput(); await until(autoVisible)
    const mini = await until(() => app.windows().find((w) => w.url().includes('transient=1')))
    await mini.getByText('Working in the foreground (r1).', { exact: true }).waitFor()
    check('opens current streaming conversation without ever opening manual Mini', true)
    check('automatic window never steals external app focus', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow() === null))
    await mini.screenshot({ path: path.join(shots, 'automatic-current-conversation.png') })
    // Hold focus in the companion process, control only the cursor samples, and record real OS window positions.
    await app.evaluate(({ screen }) => {
      const area = screen.getPrimaryDisplay().workArea
      globalThis.__miniMotionCursor = { x: area.x + 80, y: area.y + 80 }
      screen.getCursorScreenPoint = () => globalThis.__miniMotionCursor
    })
    await pause(1000)
    const move = async (dx) => {
      await app.evaluate(({ BrowserWindow }, dx) => {
        const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('transient=1'))
        globalThis.__miniMotionSamples = [{ ...win.getBounds(), at: performance.now() }]
        globalThis.__miniMotionCursor.x += dx
        globalThis.__miniMotionTimer = setInterval(() => globalThis.__miniMotionSamples.push({ ...win.getBounds(), at: performance.now() }), 8)
      }, dx)
      await pause(650)
      return app.evaluate(() => { clearInterval(globalThis.__miniMotionTimer); return globalThis.__miniMotionSamples })
    }
    const shortMove = await move(48)
    fs.writeFileSync(path.join(shots, 'motion-short.json'), JSON.stringify(shortMove))
    const moving = shortMove.filter((p, i) => i && p.x !== shortMove[i - 1].x)
    const shortTransitionVisible = moving.length >= 6 && moving.at(-1).at - moving[0].at >= 140
    stopInput(); await pause(700)
    check('remains visible between foreground calls in the same run', !!await autoVisible())
    const gapMove = await move(240)
    fs.writeFileSync(path.join(shots, 'motion-between-calls.json'), JSON.stringify(gapMove))
    console.log('MOTION', JSON.stringify({ shortFrames: moving.length, shortDurationMs: moving.at(-1)?.at - moving[0]?.at, betweenCallsPixels: gapMove.at(-1).x - gapMove[0].x }))
    check('short cursor moves have a visible linear transition over at least 140ms', shortTransitionVisible)
    check('the visible foreground conversation continues following between calls', gapMove.at(-1).x - gapMove[0].x === 240)
    backend.emit(run, 'token', { delta: ' Progress continues between calls.' })
    await mini.getByText('Working in the foreground (r1). Progress continues between calls.', { exact: true }).waitFor()
    check('same session continues streaming in the temporary window', true)
    await focusMain(); await until(async () => (await autoWindows()).length === 0)
    check('returning focus to Forsion closes the temporary window', true)
    check('temporary window preserves saved manual Space and layouts', JSON.stringify(savedMini) === JSON.stringify(await win.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => /mini/.test(k))))))
    await focusExternal(); startInput(); await until(autoVisible)
    backend.emit(run, 'done', {}); await until(async () => (await autoWindows()).length === 0)
    check('run completion closes automatic Mini even while a helper lease remains', true)
    stopInput(); await focusMain()
    await win.evaluate(() => window.tangu.openMini({ spaceId: 'amadeus' }))
    const manual = await until(() => app.windows().find((w) => w.url().includes('window=mini') && !w.url().includes('transient=1')))
    await manual.waitForSelector('.mini-card-shell[data-space="amadeus"]')
    await focusMain(); run = await send(); await focusExternal(); startInput(); await pause(700)
    check('visible manual Mini is preserved without an extra automatic window', (await autoWindows()).length === 0 && await manual.locator('.mini-card-shell[data-space="amadeus"]').count() === 1)
    stopInput(); await pause(700)
    const manualState = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('window=mini')); w.hide(); return { id: w.id, bounds: w.getBounds() } })
    // A fresh run resets the explicit manual-open suppression.
    backend.emit(run, 'done', {}); await focusMain(); run = await send(); await focusExternal(); startInput(); await until(autoVisible)
    backend.emit(run, 'done', {}); await until(async () => (await autoWindows()).length === 0)
    check('hidden manual Mini keeps its original window, content and bounds', await app.evaluate(({ BrowserWindow }, saved) => { const w = BrowserWindow.fromId(saved.id); return !!w && !w.isVisible() && JSON.stringify(w.getBounds()) === JSON.stringify(saved.bounds) }, manualState)
      && await manual.locator('.mini-card-shell[data-space="amadeus"]').count() === 1)
    stopInput(); await focusMain(); run = await send(); await focusExternal(); startInput(); await until(autoVisible)
    await win.evaluate(() => window.tangu.openMini()) // Same toggle as Cmd+Shift+M.
    await until(async () => (await autoWindows()).length === 0)
    await manual.waitForSelector(`.mini-tangu [data-session-id="${run.sessionId}"]`)
    check('manual toggle takes over the exact automatic conversation', true)
    backend.emit(run, 'done', {}); await pause(500)
    check('run completion leaves the taken-over manual Mini open', await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isVisible(), manualState.id))
    check('no renderer errors', errors.length === 0)
    console.log(`SCREENSHOTS ${shots}`)
  } catch (e) {
    if (app) for (const [i, page] of app.windows().entries()) { await page.screenshot({ path: path.join(shots, `failure-${i}.png`) }).catch(() => {}); console.log((await page.locator('body').innerText().catch(() => '')).slice(0, 2200)) }
    console.error(`FAILURE_SCREENSHOTS ${shots}`); throw e
  } finally {
    if (nativeHelper) {
      await nativeAsk({ cmd: 'shutdown' }).catch(() => {}); await pause(300)
      if (nativeHelper.exitCode === null) nativeHelper.kill('SIGTERM')
    }
    if (!nativeExecutable) stopInput()
    if (external) await external.close().catch(() => {}); if (app) await app.close().catch(() => {}); await backend.close()
  }
  console.log(`${results.filter(Boolean).length}/${results.length} passed`)
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
