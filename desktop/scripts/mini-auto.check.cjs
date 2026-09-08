/** Automatic Mini: real IPC, two isolated Electron processes and a replayable running session.
 * The companion process owns OS focus; only the helper lease is simulated (no physical HID).
 * npm run build && npm run check:miniauto */
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
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
    w.loadURL('data:text/html,<h2>Computer Use foreground fixture</h2><p>Isolated test window. No physical input is emitted.</p>');
  });`)
  let app, external, heartbeat
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
    await focusMain(); startInput(); await pause(700)
    check('foreground calls inside Forsion do not open Mini', (await autoWindows()).length === 0)
    stopInput()
    external = await electron.launch({ args: [`--user-data-dir=${path.join(temp, 'external-data')}`, externalEntry], cwd: ROOT })
    const focusExternal = async () => {
      await external.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus() })
      await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow() === null))
    }
    await external.firstWindow(); await focusExternal(); await pause(500)
    check('external focus without physical input does not open Mini', (await autoWindows()).length === 0)
    const savedMini = await win.evaluate(() => { localStorage.setItem('forsion_mini_active_space', 'amadeus'); return Object.fromEntries(Object.entries(localStorage).filter(([k]) => /mini/.test(k))) })
    startInput(); await until(autoVisible)
    const mini = await until(() => app.windows().find((w) => w.url().includes('transient=1')))
    await mini.getByText('Working in the foreground (r1).', { exact: true }).waitFor()
    check('opens current streaming conversation without ever opening manual Mini', true)
    check('automatic window never steals external app focus', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow() === null))
    await mini.screenshot({ path: path.join(shots, 'automatic-current-conversation.png') })
    stopInput(); await pause(700)
    check('remains visible between foreground calls in the same run', !!await autoVisible())
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
  } finally { stopInput(); if (external) await external.close().catch(() => {}); if (app) await app.close().catch(() => {}); await backend.close() }
  console.log(`${results.filter(Boolean).length}/${results.length} passed`)
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
