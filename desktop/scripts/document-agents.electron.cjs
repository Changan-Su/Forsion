/**
 * Document instructions/tasks: real production Electron, main-process file IPC and disk.
 * Build desktop + tangu-agent first, then node scripts/document-agents.electron.cjs.
 * The managed engine has an isolated home and no provider credentials. Only renderer
 * /agent HTTP traffic is routed to startStubEngine; capabilities/config/file IPC stay real.
 * Existing vehicle=e2e devlocks allow isolated concurrent harnesses. Never pkill Electron.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
const OUT = process.env.DOCUMENT_AGENT_ELECTRON_SHOTS || '/private/tmp/forsion-document-agents-electron'
const TASK = '[data-document-agent="task"]'
const NOTE = 'seed'
const SESSION = 'document-session-1'
const SENTINEL = 'Source content stays on this page.'
const instructions = 'Use concise prose. Preserve source links.'
const fence = (kind, body) => `\`\`\`forsion-${kind}\n${typeof body === 'string' ? body : JSON.stringify(body)}\n\`\`\``
const seed = [
  '# Document agents', '',
  fence('instructions', 'Keep source links.'), '',
  fence('task', { v: 1, id: 'task-electron-1', agent: 'writer', prompt: 'Summarize the evidence on this page.' }), '',
  fence('prompt', { v: 1, id: 'prompt-electron-1', agent: 'writer', prompt: 'Draft a short introduction using this page.' }), '',
  SENTINEL, '',
].join('\n')
const results = [], pageErrors = [], diagnostics = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`)
  assert.ok(ok, name)
}
const waitFor = async (predicate, name, timeout = 20000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 100)) }
  throw new Error(`Timed out: ${name}`)
}

function protectHarness() {
  const lockPath = process.env.FORSION_DEVLOCK || '/tmp/forsion-devlock.json'
  let lock
  try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) } catch {}
  let alive = !!lock && Date.now() - Number(lock.started) < (Number(lock.ttlMin) || 90) * 60000
  if (alive && lock.pid) { try { process.kill(lock.pid, 0) } catch (error) { if (error.code !== 'EPERM') alive = false } }
  if (alive) {
    assert.equal(lock.vehicle, 'e2e', `GUI lock belongs to ${lock.what}; wait for the active dev inspection`)
    console.log(`Shared e2e protection: ${lock.what}; this harness does not modify or release that lock.`)
    return () => {}
  }
  let parent = ROOT, hook
  while (parent !== path.dirname(parent)) {
    const candidate = path.join(parent, '.claude/hooks/devlock.cjs')
    if (fs.existsSync(candidate)) { hook = candidate; break }
    parent = path.dirname(parent)
  }
  if (!hook) throw new Error('Missing ancestor .claude/hooks/devlock.cjs')
  execFileSync(process.execPath, [hook, 'acquire', '--vehicle=e2e', '--what=Document agents isolated Electron smoke', '--eta=10', `--pid=${process.pid}`])
  return () => {
    let current
    try { current = JSON.parse(fs.readFileSync(lockPath, 'utf8')) } catch {}
    if (current?.pid === process.pid) execFileSync(process.execPath, [hook, 'release'])
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  check('Production main and renderer builds exist', fs.existsSync(path.join(ROOT, 'out/main/main.js')) && fs.existsSync(path.join(ROOT, 'out/renderer/index.html')))
  const releaseProtection = protectHarness()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-document-agents-'))
  const userData = path.join(home, 'userdata'), vault = path.join(home, 'vault'), file = path.join(vault, `${NOTE}.md`)
  fs.mkdirSync(vault, { recursive: true })
  fs.writeFileSync(file, seed)
  const sessions = [], created = [], runDisk = [], opened = [], routed = []
  let app, win, second, capabilities
  const observeWindow = (page, name) => {
    page.setDefaultTimeout(15000)
    page.on('pageerror', (error) => pageErrors.push(`${name}: ${error.message}`))
    page.on('console', (message) => { if (message.type() === 'error') diagnostics.push({ window: name, error: message.text() }) })
    page.on('requestfailed', (request) => { if (request.url().startsWith('file:')) diagnostics.push({ window: name, missingLocalResource: request.url(), failure: request.failure()?.errorText }) })
  }
  const captureWindowState = async (page, name) => {
    if (!page || page.isClosed()) return
    await page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {})
    const visible = await page.evaluate(() => ({
      url: location.href, title: document.title, windowKind: document.documentElement.dataset.window,
      hasTanguBridge: !!window.tangu, hasAmadeusBridge: !!window.amadeus,
      visibleText: document.body.innerText.slice(0, 12000),
      taskBlocks: document.querySelectorAll('[data-document-agent="task"]').length,
    })).catch((error) => ({ readError: String(error) }))
    diagnostics.push({ window: name, visible })
  }
  const stub = await startStubEngine({
    sessions,
    agents: [{ slug: 'writer', name: 'Writer', description: 'Writing assistant', model: 'm1', thinkingLevel: 'off', tools: [], systemPrompt: 'Write clearly.', soul: '', skills: [], createdBy: 'user' }],
    override: async ({ path: requestPath, method, body }) => {
      if (requestPath === '/agent/sessions' && method === 'POST') {
        const input = await body()
        created.push(input)
        await new Promise((resolve) => setTimeout(resolve, 1200)) // Keep both independent renderers inside the pending claim window.
        const session = { id: SESSION, ...input, app_id: 'tangu', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
        sessions.unshift(session)
        return { session }
      }
      if (requestPath === '/agent/runs' && method === 'POST') {
        // Do not consume request body: the shared stub still records the real run and serves SSE.
        runDisk.push(fs.readFileSync(file, 'utf8'))
      }
      const detail = /^\/agent\/sessions\/([^/]+)\/detail$/.exec(requestPath)
      if (detail) { opened.push(detail[1]); return { session: sessions.find((session) => session.id === detail[1]) } }
      const config = /^\/agent\/sessions\/([^/]+)\/config$/.exec(requestPath)
      if (config && method === 'GET') return { agent_config: sessions.find((session) => session.id === config[1])?.agent_config || {} }
      if (requestPath === '/agent/special/config') return { config: { muse: { enabled: false }, historian: { enabled: false } } }
    },
  })
  stub.state.runDelayMs = 200
  stub.script([{ type: 'token', payload: { text: 'The evidence has been summarized.' } }, { type: 'done', payload: { content: 'The evidence has been summarized.' } }])
  for (const dir of [userData, `${userData}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({
      mode: 'managed', backendUrl: stub.url, token: 'e2e', cloudUrl: 'http://127.0.0.1:9',
      sandbox: 'none', browserEnabled: false, defaultWorkspaceDir: path.join(home, 'workspace'), modelId: 'm1', unitHostEnabled: false,
    }))
  }
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_BROWSER_CDP: 'off', TANGU_HARNESS_QUIET: '1' } })
    win = await app.firstWindow()
    observeWindow(win, 'main')
    await app.context().route('**/agent/**', async (route) => {
      const url = new URL(route.request().url())
      routed.push({ path: url.pathname, method: route.request().method() })
      await route.continue({ url: `${stub.url}${url.pathname}${url.search}` })
    })
    await win.waitForSelector('#root', { timeout: 40000 })
    check('Real shell leaves onboarding', await skipOnboarding(win))
    await win.waitForFunction(async () => (await window.tangu.getConfig()).backendState?.state === 'ready', null, { timeout: 40000 })
    capabilities = await win.evaluate(async () => {
      const config = await window.tangu.getConfig()
      return { platform: window.tangu.platform, explicitHost: window.tangu.executionCapabilities?.host ?? null, mode: config.mode, host: window.tangu.executionCapabilities?.host ?? (config.mode === 'managed'), backendReady: config.backendState?.state === 'ready' }
    })
    check('Host capability follows actual managed desktop config', capabilities.host && capabilities.mode === 'managed' && capabilities.backendReady, capabilities)
    check('Renderer loads production output without Vite HMR', !/^https?:/.test(win.url()) && !await win.evaluate(() => [...document.scripts].some((script) => script.src.includes('/@vite/client'))), win.url())

    const openNote = async (mode, locale, width) => {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 960), width)
      await win.evaluate(({ mode, locale }) => {
        localStorage.setItem('forsion_default_space', 'amadeus')
        localStorage.setItem('forsion_theme_lang', 'lovable')
        localStorage.setItem('forsion_theme_pref', mode)
        localStorage.setItem('tangu_locale', locale)
        localStorage.removeItem('forsion_theme_forced_scheme')
      }, { mode, locale })
      await win.reload({ waitUntil: 'domcontentloaded' })
      check(`${mode}/${locale} shell available`, await skipOnboarding(win, 600))
      await win.waitForSelector('.am-app', { timeout: 40000 })
      const row = win.locator('.t2s-srow', { hasText: NOTE }).first()
      if (!await row.isVisible()) await win.locator('.dv-edge-left').click().catch(() => {})
      await row.click({ timeout: 20000 })
      await win.waitForSelector(TASK, { timeout: 20000 })
      await win.evaluate(() => document.fonts.ready)
      await win.mouse.move(12, 12)
      check(`${mode}/${locale} actual theme`, await win.evaluate((mode) => document.documentElement.dataset.mode === mode, mode))
    }
    const shot = async (name) => { await win.evaluate(() => document.fonts.ready); await win.screenshot({ path: path.join(OUT, name) }) }
    await openNote('light', 'zh', 1280)
    check('Opening three document blocks never starts a run', await win.locator('[data-document-agent]').count() === 3 && stub.seen.runs.length === 0 && created.length === 0)
    check('Read-only opening preserves original file bytes', fs.readFileSync(file, 'utf8') === seed)
    await win.locator('[data-document-agent="instructions"] textarea').fill(instructions)
    await waitFor(() => fs.readFileSync(file, 'utf8').includes(instructions), 'instructions saved before second window')
    await shot('light-zh.png')
    const frames = await win.locator('[data-document-agent]').evaluateAll((nodes) => nodes.map((node) => {
      const style = getComputedStyle(node.closest('pre'))
      return { background: style.backgroundColor, padding: style.padding }
    }))
    check('Embedded cards have no extra code-block background or padding', frames.every((frame) => frame.background === 'rgba(0, 0, 0, 0)' && frame.padding === '0px'), frames)
    if (process.argv.includes('--appearance-only')) {
      await openNote('dark', 'zh', 1280)
      await shot('dark-zh.png')
      check('No renderer page errors', pageErrors.length === 0, pageErrors)
      return
    }
    const secondReady = app.waitForEvent('window')
    // Use the product's detached-window path: it supplies the ESM preload's
    // sandbox:false requirement, its own layout identity, and the actual note view.
    await win.evaluate((notePath) => window.tangu.openDetached([{ type: 'amadeus-editor', params: { notePath } }]), `${NOTE}.md`)
    second = await secondReady
    observeWindow(second, 'detached')
    await second.waitForSelector(TASK, { timeout: 40000 })
    check('Native detached window loads the same note with real preload bridges', await second.evaluate(() =>
      document.documentElement.dataset.window === 'detached' && !!window.tangu?.documentTasks && !!window.amadeus)
      && (await second.locator('.unified-body').textContent()).includes(SENTINEL), second.url())
    await captureWindowState(second, 'second-window')
    await Promise.all([win.locator(`${TASK} .am-doc-agent-action`).dblclick(), second.locator(`${TASK} .am-doc-agent-action`).click()])
    await waitFor(() => stub.seen.runs.length > 0 || win.locator(`${TASK} [role="alert"]`).count(), 'task dispatch or visible error')
    const alert = await win.locator(`${TASK} [role="alert"]`).allTextContents()
    await waitFor(() => stub.seen.runs.length > 0, 'one window owns dispatch')
    check('Two real windows plus double-click create one session and one HTTP run', created.length === 1 && stub.seen.runs.length === 1, { sessions: created.length, runs: stub.seen.runs.length, alert })
    const dataPath = await app.evaluate(({ app }) => app.getPath('userData'))
    const receipts = JSON.parse(fs.readFileSync(path.join(dataPath, 'document-task-receipts.json'), 'utf8')).receipts
    const receiptKey = Object.keys(receipts)[0]
    const receipt = receipts[receiptKey]
    const claim = await second.evaluate(({ key, signature }) => window.tangu.documentTasks.claim(key, signature), { key: receiptKey, signature: receipt.signature })
    check('A different renderer receives the durable existing session', claim.state === 'linked' && claim.sessionId === SESSION)
    await second.close()
    check('Session binding and current instructions reach disk before POST runs', runDisk.length === 1 && runDisk[0].includes(`"sessionId":"${SESSION}"`) && runDisk[0].includes(instructions) && runDisk[0].includes(SENTINEL))
    check('Dispatch uses chosen agent and the actual vault workspace', created[0].agent_config?.agentSlug === 'writer' && created[0].agent_config?.cwd === vault && created[0].project_path === vault && created[0].model_id === 'm1', created[0])
    check('Request includes source note and page instructions', stub.seen.runs[0].message.includes('seed.md') && stub.seen.runs[0].message.includes(instructions))
    check('Background dispatch leaves the original document visible', await win.locator('.am-app').isVisible() && await win.locator(TASK).isVisible() && (await win.locator('.unified-body').textContent()).includes(SENTINEL))
    await win.locator(`${TASK} .am-doc-agent-action`).getByText('查看会话', { exact: true }).waitFor()
    await openNote('dark', 'zh', 1280)
    check('Reload preserves the link and never re-sends', stub.seen.runs.length === 1 && created.length === 1 && (await win.locator(TASK).textContent()).includes('查看会话'))
    check('Reload preserves edited instructions', await win.locator('[data-document-agent="instructions"] textarea').inputValue() === instructions)
    await shot('dark-zh.png')
    // The real desktop currently enforces an 880px minimum window width. With the
    // sidebar present this gives a narrow document column without overriding app policy.
    await openNote('light', 'en', 880)
    check('Embedded blocks render English labels', (await win.locator('[data-document-agent="instructions"]').textContent()).includes('Page instructions') && (await win.locator(TASK).textContent()).includes('Open session'))
    await shot('narrow-en.png')
    const geometry = await win.locator('[data-document-agent]').evaluateAll((nodes) => ({ viewport: window.innerWidth, blocks: nodes.map((node) => ({ width: node.clientWidth, scroll: node.scrollWidth, right: node.getBoundingClientRect().right })) }))
    check('Narrow document blocks fit their visible container', geometry.blocks.every((box) => box.scroll <= box.width + 1 && box.right <= geometry.viewport + 1), geometry)
    const requestsBeforeOpen = routed.length
    await win.locator(`${TASK} .am-doc-agent-action`).click()
    await win.waitForSelector('.t2-chat-view', { timeout: 20000 })
    check('Open session navigates to the existing conversation without another run', await win.locator('.t2-chat-view').isVisible() && created.length === 1 && stub.seen.runs.length === 1)
    check('Opened conversation reads the persisted session identity', routed.slice(requestsBeforeOpen).some((request) => request.path.startsWith(`/agent/sessions/${SESSION}/`)), routed.slice(requestsBeforeOpen))
    await shot('existing-session.png')
    check('No renderer page errors', pageErrors.length === 0, pageErrors)
    console.log(`${results.length} checks passed; screenshots: ${OUT}`)
  } catch (error) {
    await captureWindowState(win, 'failure')
    await captureWindowState(second, 'second-failure')
    diagnostics.push(String(error?.stack || error))
    throw error
  } finally {
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ results, capabilities, pageErrors, diagnostics, created, runs: stub.seen.runs, runDisk, opened, routed }, null, 2))
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(OUT, 'saved-seed.md'))
    await app?.close().catch(() => {})
    await stub.close()
    fs.rmSync(home, { recursive: true, force: true })
    releaseProtection()
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
