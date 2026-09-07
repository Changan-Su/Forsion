/**
 * Coding Studio: real Electron, real preview guest, real file watcher and source snapshots.
 * Run after npm run build: node scripts/coding-studio.e2e.cjs
 *
 * Only the model backend and native folder picker are fixtures. File reads/writes, preview
 * serving, guest inspection, change detection, snapshot and restore all use production paths.
 * All fixtures, vault, userData and TANGU_HOME are isolated. No process killing or real AI runs.
 * Screenshots + JSON results go to ../outputs/coding-studio-*. Keep temp data on failure.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.resolve(__dirname, '..')
const OUTPUT = path.resolve(ROOT, '../outputs')
const results = []
const rendererErrors = []
const geometry = []
const motion = []
const SAMPLE = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Studio fixture</title>
<style>body{margin:0;padding:32px;font:16px system-ui;background:#f7f6f2;color:#172b2b}main{max-width:640px;margin:30px auto}h1{font-size:38px;line-height:1.15}p{line-height:1.6}button{font:inherit;background:#244b43;color:white;border:0;border-radius:10px;padding:12px 20px;cursor:pointer}small{display:block;margin-top:24px}</style></head>
<body><main><small>CODING STUDIO · LOCAL PROJECT</small><h1 id="headline">A working first version</h1><p>Preview this project, try the button, then make a focused change.</p><button id="counter">Count: 0</button><small id="version">BASELINE</small></main>
<script>window.studioCounter=0;document.getElementById('counter').onclick=()=>{document.getElementById('counter').textContent='Count: '+(++window.studioCounter)};</script></body></html>`

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, ...(detail ? { detail } : {}) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` | ${detail}` : ''}`)
}
async function until(read, timeout = 12000) {
  const end = Date.now() + timeout
  let value
  while (Date.now() < end) {
    try { value = await read(); if (value) return value } catch { /* Rendering/navigation may be in flight. */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}
/** Record actual rendered geometry every animation frame across an ordinary UI action. */
async function traceMotion(win, name, selector, action, dimension = 'width', closest = '') {
  await win.evaluate(({ selector, dimension, closest }) => {
    window.__studioMotion = new Promise(resolve => {
      const samples = [], start = performance.now()
      const tick = now => {
        const element = document.querySelector(selector)
        const target = closest ? element?.closest(closest) : element
        const value = target?.getBoundingClientRect()[dimension] || 0
        const surface = selector === '.csu-code-pane' ? document.querySelector('.csu-guest-surface') : null
        samples.push({ ms: Math.round(now - start), value: Math.round(value * 10) / 10,
          ...(surface ? { previewOpacity: Number(getComputedStyle(surface).opacity), previewVisible: getComputedStyle(surface).visibility === 'visible' } : {}) })
        if (now - start < 900) requestAnimationFrame(tick)
        else resolve(samples)
      }
      requestAnimationFrame(tick)
    })
  }, { selector, dimension, closest })
  await action()
  const samples = await win.evaluate(() => window.__studioMotion)
  const values = samples.map(s => s.value)
  const min = Math.min(...values), max = Math.max(...values)
  const middle = samples.filter(s => s.value > min + 2 && s.value < max - 2)
  const result = { name, dimension, min, max, intermediateFrames: middle.length, samples }
  motion.push(result)
  check(name, max - min > 12 && middle.length >= 3, JSON.stringify({ min, max, intermediateFrames: middle.length }))
  return result
}
async function closeStudioTool(win) {
  const placement = win.locator('.csu-tool-placement button').first()
  await placement.focus()
  await win.keyboard.press('Escape')
  await win.waitForSelector('.csu-tool-view', { state: 'detached' })
}
/** A short native-compositor recording makes the delivered motion directly reviewable. */
async function recordMotionDemo(app, win) {
  if (process.env.STUDIO_MOTION_VIDEO !== '1') return
  const directory = path.join(OUTPUT, 'coding-studio-motion-frames')
  fs.mkdirSync(directory, { recursive: true })
  const recording = (async () => {
    const start = Date.now()
    for (let i = 0; i < 120; i++) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, start + i * 50 - Date.now())))
      const png = await app.evaluate(async ({ BrowserWindow }) => {
        const frame = await BrowserWindow.getAllWindows()[0].capturePage()
        return frame.resize({ width: 1400 }).toPNG().toString('base64')
      })
      fs.writeFileSync(path.join(directory, `${String(i).padStart(4, '0')}.png`), Buffer.from(png, 'base64'))
    }
  })()
  const pause = () => win.waitForTimeout(650)
  await pause()
  await win.locator('.csu-tool-nav').getByRole('button', { name: 'Project brief', exact: true }).click()
  await pause()
  await win.getByRole('button', { name: 'Move to bottom panel', exact: true }).click()
  await pause()
  await closeStudioTool(win)
  await pause()
  await win.locator('.csu-modes').getByRole('button', { name: 'Split', exact: true }).click()
  await pause()
  await win.getByRole('button', { name: 'Phone · 390', exact: true }).click()
  await pause()
  await win.locator('.csu-modes').getByRole('button', { name: 'Preview', exact: true }).click()
  await recording
  await win.getByRole('button', { name: 'Responsive', exact: true }).click()
}
async function guestEval(win, script) {
  return win.locator('webview.csx-frame').evaluate((view, code) => view.executeJavaScript(code), script)
}
async function guestId(win) {
  return win.locator('webview.csx-frame').evaluate(view => view.getWebContentsId())
}
async function shoot(app, win, suffix) {
  await win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await win.waitForTimeout(350)
  // CDP captureScreenshot can offset embedded webview surfaces on Retina displays.
  // Capture the native compositor so the artifact matches the actual application.
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const bitmap = await BrowserWindow.getAllWindows()[0].capturePage()
    return bitmap.toPNG().toString('base64')
  })
  fs.writeFileSync(path.join(OUTPUT, `coding-studio-${suffix}.png`), Buffer.from(png, 'base64'))
}
/** Let both renderer surfaces paint, then allow the embedded compositor to settle. */
async function settlePreview(win) {
  await Promise.all([
    win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))),
    guestEval(win, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'),
  ])
  await win.waitForTimeout(500)
}
/** DOM geometry alone cannot prove that Electron composited a visible guest correctly. */
async function previewDiagnostic(app, win, suffix) {
  await settlePreview(win)
  const host = await win.evaluate(() => {
    const read = selector => {
      const el = document.querySelector(selector)
      if (!el) return null
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      const properties = ['display', 'position', 'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'margin', 'padding', 'transform', 'transformOrigin', 'zoom', 'overflow', 'overflowX', 'overflowY', 'alignItems', 'justifyContent', 'flex', 'flexShrink', 'boxSizing', 'contain', 'visibility', 'opacity']
      return { rect: { x: r.x, y: r.y, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
        clientWidth: el.clientWidth, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight,
        style: Object.fromEntries(properties.map(p => [p, s[p]])) }
    }
    return { innerWidth, innerHeight, devicePixelRatio,
      root: { theme: document.documentElement.dataset.theme, skin: document.documentElement.dataset.skin, bg: document.documentElement.dataset.bg, mode: document.documentElement.dataset.mode, classes: document.documentElement.className },
      body: read('body'), stage: read('.csp-stage'), viewport: read('.csp-viewport'), webview: read('webview.csx-frame') }
  })
  const guest = await guestEval(win, `(() => {
    const read = selector => {
      const el = document.querySelector(selector); if (!el) return null;
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      const properties = ['display','position','width','height','minWidth','maxWidth','margin','marginLeft','marginRight','padding','transform','zoom','overflow','boxSizing','font','visibility','opacity'];
      return { rect: { x:r.x,y:r.y,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height },
        clientWidth:el.clientWidth,clientHeight:el.clientHeight,scrollWidth:el.scrollWidth,scrollHeight:el.scrollHeight,
        style:Object.fromEntries(properties.map(p=>[p,s[p]])) };
    };
    const headline = read('#headline'); const r = headline && headline.rect;
    const intersection = r ? { width: Math.max(0, Math.min(r.right,innerWidth)-Math.max(r.left,0)), height: Math.max(0,Math.min(r.bottom,innerHeight)-Math.max(r.top,0)) } : {width:0,height:0};
    return { innerWidth,innerHeight,devicePixelRatio,scrollX,scrollY,documentClientWidth:document.documentElement.clientWidth,documentClientHeight:document.documentElement.clientHeight,
      body:read('body'),main:read('main'),headline,
      headlineInViewport:!!r && r.width>0 && r.height>0 && r.left>=-1 && r.top>=-1 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1,
      headlineVisibleArea:intersection.width*intersection.height,
      headlineVisible:!!r && intersection.width*intersection.height>0 && headline.style.display!=='none' && headline.style.visibility!=='hidden' && Number(headline.style.opacity)>0 };
  })()`)
  const id = await guestId(win)
  const captured = await app.evaluate(async ({ webContents }, id) => {
    const contents = webContents.fromId(id)
    const bitmap = await contents.capturePage()
    return { zoomFactor: contents.getZoomFactor(), size: bitmap.getSize(), empty: bitmap.isEmpty(), png: bitmap.toPNG().toString('base64') }
  }, id)
  const report = { stage: suffix, host, guest, guestId: id, zoomFactor: captured.zoomFactor, captureSize: captured.size, captureEmpty: captured.empty }
  geometry.push(report)
  console.log(`GEOMETRY ${suffix} ${JSON.stringify(report)}`)
  fs.writeFileSync(path.join(OUTPUT, `coding-studio-${suffix}-geometry.json`), JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(OUTPUT, `coding-studio-${suffix}-guest.png`), Buffer.from(captured.png, 'base64'))
  await shoot(app, win, suffix)
  check(`${suffix}: heading fits inside the actual guest viewport`, guest.headlineInViewport,
    JSON.stringify({ viewport: [guest.innerWidth, guest.innerHeight], headline: guest.headline?.rect, zoomFactor: captured.zoomFactor }))
  if (suffix === 'phone') check('Phone headline has nonzero visible area in the guest', guest.headlineVisible && guest.headlineVisibleArea > 0, String(guest.headlineVisibleArea))
  return report
}
async function openCodingSpace(win) {
  const locator = '.rb-space[title="编码工作室"], .rb-space[title="Coding Studio"], .rb-space[title="Coding"]'
  const direct = win.locator(locator).first()
  if (await direct.isVisible().catch(() => false)) { await direct.click(); return }
  const more = win.locator('.rb-top .rb-more').first()
  if (await more.isVisible().catch(() => false)) {
    await more.hover()
    await win.locator(`.rb-fly ${locator.split(', ').join(', .rb-fly ')}`).first().click()
    return
  }
  // Space can also be pinned to the home launcher rather than the ribbon.
  const tile = win.locator('.hp-tile').filter({ hasText: /编码工作室|Coding Studio/ }).first()
  if (await tile.isVisible().catch(() => false)) { await tile.click(); return }
  throw new Error('Coding Space is not available in the ribbon or home launcher')
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) throw new Error('Build first: cd desktop && npm run build')
  fs.mkdirSync(OUTPUT, { recursive: true })
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-coding-studio-'))
  const userData = path.join(testDir, 'userdata')
  const vault = path.join(testDir, 'vault')
  const managed = path.join(testDir, 'Project')
  const project = path.join(testDir, 'Imported studio project')
  for (const dir of [`${userData}-dev`, vault, managed, project]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(`${userData}-dev`, 'amadeus-config.dev.json'), JSON.stringify({ localVault: vault, lastVault: vault }))
  fs.writeFileSync(path.join(`${userData}-dev`, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', defaultWorkspaceDir: path.join(testDir, 'sessions') }))
  fs.writeFileSync(path.join(project, 'index.html'), SAMPLE)
  fs.writeFileSync(path.join(project, '.env'), 'TEST_SETTING=before\n')
  const session = { id: 'coding-fixture', title: 'Studio fixture chat', summary: '', archived: false, model_id: 'm1',
    agent_config: null, project_path: project, project_name: 'Imported studio project',
    created_at: '2026-09-07 00:00:00', updated_at: '2026-09-07 00:00:00' }
  const stub = await startStubEngine({ sessions: [session] })
  let app
  let win
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', TANGU_HOME: testDir, TANGU_BACKEND_URL: stub.url }, timeout: 45000,
    })
    win = await app.firstWindow()
    win.setDefaultTimeout(12000)
    win.on('pageerror', error => rendererErrors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1540, 1040) })
    await win.waitForSelector('#root', { state: 'attached', timeout: 45000 })
    // First-run onboarding hides the shell. Dismiss it before waiting for a visible group.
    await until(async () => await win.getByText('跳过引导', { exact: true }).first().isVisible().catch(() => false)
      || await win.getByText('Skip', { exact: true }).first().isVisible().catch(() => false)
      || await win.locator('.dv-groupview').first().isVisible().catch(() => false), 45000)
    for (const text of ['跳过引导', 'Skip']) {
      const skip = win.getByText(text, { exact: true }).first()
      if (await skip.isVisible().catch(() => false)) { await skip.click(); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 45000 })
    // Override only root selection so launchpad never scans the user's project directory.
    await app.evaluate(({ dialog, ipcMain }, fixture) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture.project] })
      ipcMain.removeHandler('codeProjects:root')
      ipcMain.handle('codeProjects:root', () => fixture.managed)
    }, { project, managed })
    await openCodingSpace(win)
    await win.waitForSelector('.csl-launchpad')
    await shoot(app, win, 'launchpad')
    await traceMotion(win, 'Optional brief details expand through intermediate heights', '.csl-details', () => win.locator('.csl-details summary').click(), 'height')
    await traceMotion(win, 'Optional brief details collapse through intermediate heights', '.csl-details', () => win.locator('.csl-details summary').click(), 'height')
    check('Launchpad has six editable templates and a real import action', await win.locator('.csl-template').count() === 6 && await win.locator('.csl-import').isEnabled())
    check('Studio requires a project before accepting a build request', await win.locator('.t2c-ta').first().isDisabled()
      && (await win.locator('.t2c-ta').first().getAttribute('placeholder')).includes('创建或打开'))
    await win.locator('.csl-import').click()
    await win.waitForSelector('.csu-workspace')
    const ready = await until(() => guestEval(win, 'document.getElementById("version")?.textContent === "BASELINE"'))
    check('Import renders the actual project file in an Electron guest', ready)
    if (!ready) throw new Error('Guest did not load the imported project')
    check('Import does not rewrite the existing source', fs.readFileSync(path.join(project, 'index.html'), 'utf8') === SAMPLE)
    const beforeToolsGuest = await guestId(win)
    await guestEval(win, 'window.studioLayoutSentinel="survive-panel-changes"')
    await traceMotion(win, 'Brief opens with a real native right panel tween', '.csu-tool-view', () => win.locator('.csu-tool-nav').getByRole('button', { name: '项目简报', exact: true }).click(), 'width', '.dv-groupview')
    check('Brief joins a real native right panel instead of an internal aside', await win.locator('.wb-extend[data-side=right] .csu-tool-view[data-tool=brief]').count() === 1 && await win.locator('.csu-panel').count() === 0)
    const briefGoal = win.getByLabel('项目目标', { exact: true })
    await briefGoal.fill('Preserve this unsaved brief while moving panels.')
    await briefGoal.evaluate(el => { el.dataset.qaIdentity = 'original-brief' })
    await win.locator('.csu-tool-nav').getByRole('button', { name: '项目简报', exact: true }).click()
    check('Repeated tool trigger focuses the same form and preserves its draft', await briefGoal.getAttribute('data-qa-identity') === 'original-brief' && (await briefGoal.inputValue()).includes('unsaved brief'))
    for (const [side, label] of [['left', '移至左侧面板'], ['bottom', '移至底部面板'], ['right', '移至右侧面板']]) {
      await win.getByRole('button', { name: label, exact: true }).click()
      await win.waitForSelector(`.wb-extend[data-side=${side}] .csu-tool-view`)
      check(`Moving the tool to ${side} preserves the actual form DOM and draft`, await briefGoal.getAttribute('data-qa-identity') === 'original-brief' && (await briefGoal.inputValue()).includes('unsaved brief'))
    }
    await shoot(app, win, 'temp-view-right')
    await traceMotion(win, 'Closing a solo Temp View keeps content through the collapse tween', '.csu-tool-view', () => closeStudioTool(win), 'width', '.dv-groupview')
    check('Closing the tool restores the original chat and leaves no temporary tab', await win.locator('.t2c-ta').first().isVisible() && await win.locator('[data-transient-view]').count() === 0)
    await win.locator('.csu-tool-nav').getByRole('button', { name: '项目简报', exact: true }).click()
    check('Reopening the brief preserves the project draft', await briefGoal.getAttribute('data-qa-identity') === 'original-brief')
    await closeStudioTool(win)
    check('Opening, moving and closing native Temp panels preserve the guest and page memory', await guestId(win) === beforeToolsGuest && await guestEval(win, 'window.studioLayoutSentinel') === 'survive-panel-changes')
    const initialGuestId = await guestId(win)
    await win.locator('.t2c-ta').first().focus()
    check('Focusing chat first selects its native panel', await win.locator('.t2c-ta').first().evaluate(el => el.closest('.dv-groupview').classList.contains('dv-active-group')))
    const counter = await guestEval(win, '(()=>{const r=document.getElementById("counter").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
    const guestBox = await win.locator('webview.csx-frame').boundingBox()
    await win.mouse.click(guestBox.x + counter.x, guestBox.y + counter.y)
    const focusReturns = !!await until(async () => await guestEval(win, 'window.studioCounter') === 1 && await win.locator('.csu-workspace').evaluate(el => el.closest('.dv-groupview').classList.contains('dv-active-group')))
    check('A real preview click activates its owner panel and reaches the guest button', focusReturns, JSON.stringify(await win.evaluate(() => ({ activeElement: document.activeElement?.tagName, insideSurface: document.querySelector('.csu-guest-surface').contains(document.activeElement), ownerActive: document.querySelector('.csu-workspace').closest('.dv-groupview').classList.contains('dv-active-group') }))))
    // Drive the real native tab drag listeners, then inspect the same browser hit test
    // used by computeDropTarget. Do not mutate the internal dragging marker or store.
    const dragHit = await win.evaluate(async () => {
      const owner = document.querySelector('.csu-workspace').closest('.dv-groupview')
      const tab = owner.querySelector('.wb-tab'), transfer = new DataTransfer()
      tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }))
      await new Promise(requestAnimationFrame)
      const r = document.querySelector('.csp-anchor').getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      const during = hit?.closest('.dv-groupview') === owner
      hit?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }))
      const indicator = document.querySelector('.wb-drop-zone')
      const dropTarget = !!indicator && getComputedStyle(indicator).display !== 'none' && indicator.getBoundingClientRect().width > 0
      tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }))
      await new Promise(requestAnimationFrame)
      return { during, dropTarget, restored: document.querySelector('.csu-guest-surface').contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }
    })
    check('Native tab dragging shows a split target over the preview and restores guest interaction afterwards', dragHit.during && dragHit.dropTarget && dragHit.restored && await guestId(win) === initialGuestId, JSON.stringify(dragHit))
    await traceMotion(win, 'Phone width changes continuously instead of snapping', '.csp-viewport', () => win.getByRole('button', { name: '手机 · 390', exact: true }).click())
    const phoneWidth = await until(async () => {
      const width = await guestEval(win, 'window.innerWidth')
      return width <= 391 && width >= 350 ? width : false
    })
    check('Phone preset applies a real guest viewport of 390 CSS pixels', !!phoneWidth, String(phoneWidth))
    await previewDiagnostic(app, win, 'phone')
    const previewExit = await traceMotion(win, 'Preview to code animates the actual pane width', '.csu-code-pane', () => win.locator('.csu-modes').getByRole('button', { name: '代码', exact: true }).click())
    check('The real preview remains painted during its exit fade', previewExit.samples.filter(sample => sample.previewVisible && sample.previewOpacity > 0.05 && sample.previewOpacity < 0.95).length >= 3)
    check('Code mode displays the actual project editor', await win.locator('.csu-code-pane').isVisible())
    await traceMotion(win, 'Code to split animates the actual pane width', '.csu-code-pane', () => win.locator('.csu-modes').getByRole('button', { name: '并排', exact: true }).click())
    check('Split mode displays code and preview together', await win.locator('.csu-code-pane').isVisible() && await win.locator('.csu-preview-pane').isVisible())
    check('Code / split / device changes preserve the preview guest and app state', await guestId(win) === initialGuestId && await guestEval(win, 'window.studioCounter') === 1)
    await previewDiagnostic(app, win, 'split')
    // Exercise CodeMirror's actual contenteditable/input path through StudioEditor
    // and the host writer; no direct editor controller or application state writes.
    await win.locator('.csu-modes').getByRole('button', { name: '代码', exact: true }).click()
    const editor = win.locator('.csu-code-pane .cm-content[contenteditable="true"]').first()
    await editor.waitFor()
    const editorSource = `${SAMPLE}\n<!-- Saved through the real Coding Studio editor. -->`
    await editor.fill(editorSource)
    const editorSaved = await until(async () => fs.readFileSync(path.join(project, 'index.html'), 'utf8') === editorSource
      && await win.locator('.cs-editor').getAttribute('data-status') === 'saved')
    check('Editing the actual code surface saves the exact content through the host writer', editorSaved)
    if (!editorSaved) throw new Error('CodeMirror input did not reach the project file')
    await editor.fill(SAMPLE)
    const editorReset = await until(async () => fs.readFileSync(path.join(project, 'index.html'), 'utf8') === SAMPLE
      && await win.locator('.cs-editor').getAttribute('data-status') === 'saved')
    check('A second real editor change restores the exact baseline without a pending draft', editorReset)
    if (!editorReset) throw new Error('Editor did not return the project to the baseline')
    await win.locator('.csu-modes').getByRole('button', { name: '预览', exact: true }).click()
    await win.getByRole('button', { name: '自适应', exact: true }).click()

    await win.getByRole('button', { name: '选择页面元素', exact: true }).click()
    const inspecting = await until(() => guestEval(win, 'typeof window.__forsionStudioInspect === "function"'))
    if (!inspecting) throw new Error('Inspector was not installed into the preview guest')
    // A real guest mouse event, not a fabricated console payload or host selection callback.
    const point = await guestEval(win, '(()=>{const r=document.getElementById("headline").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()')
    await traceMotion(win, 'Selecting an element expands the focused edit form continuously', '.csu-reveal', () => app.evaluate(({ webContents }, { id, point }) => {
      const guest = webContents.fromId(id)
      guest.sendInputEvent({ type: 'mouseMove', ...point })
      guest.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
      guest.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    }, { id: initialGuestId, point }), 'height')
    await win.waitForSelector('.csu-selection')
    check('Inspector produces a source-context selection from the real guest', (await win.locator('.csu-selection').textContent()).includes('#headline'))
    await win.locator('.csu-selection input').fill('Make this heading larger and preserve the current colors.')
    await previewDiagnostic(app, win, 'focused-edit')
    await traceMotion(win, 'Adding an edit to chat collapses the form continuously', '.csu-reveal', () => win.getByRole('button', { name: '加入对话', exact: true }).click(), 'height')
    const draft = await until(async () => {
      const value = await win.locator('.t2c-ta').first().inputValue().catch(() => '')
      return value.includes('Make this heading larger') && value.includes('#headline') ? value : false
    })
    check('Focused edit reaches the chat draft with selector and user request', !!draft)
    check('Import and draft actions never send a model request', stub.seen.runs.length === 0)

    await guestEval(win, 'console.error("CODING_STUDIO_TEST_ERROR")')
    await traceMotion(win, 'Issues opens with a real native bottom panel tween', '.csu-tool-view', () => win.getByRole('button', { name: '问题', exact: true }).click(), 'height', '.dv-groupview')
    check('Issues lives in a native bottom Temp View outside the preview', await win.locator('.wb-extend[data-side=bottom] .csu-tool-view[data-tool=issues]').count() === 1 && await win.locator('.csu-workspace .wb-extend').count() === 0)
    check('Actual guest console errors appear in the Issues panel', !!await until(async () => (await win.locator('.csu-issue').allTextContents()).some(text => text.includes('CODING_STUDIO_TEST_ERROR'))))
    await shoot(app, win, 'issues')
    await win.getByRole('button', { name: '版本', exact: true }).click()
    await win.locator('.csu-version-create input').fill('Working baseline')
    await win.getByRole('button', { name: '保存版本', exact: true }).click()
    await win.locator('.csu-version').filter({ hasText: 'Working baseline' }).waitFor()
    check('A named source snapshot is visible after a real save', await win.locator('.csu-version').filter({ hasText: 'Working baseline' }).count() === 1)

    const updated = SAMPLE.replace('A working first version', 'A changed version').replace('BASELINE', 'UPDATED')
    fs.writeFileSync(path.join(project, 'index.html'), updated)
    fs.writeFileSync(path.join(project, 'added.js'), 'console.log("added after snapshot")\n')
    fs.writeFileSync(path.join(project, '.env'), 'TEST_SETTING=after\n')
    check('External disk writes automatically refresh the actual guest preview', !!await until(() => guestEval(win, 'document.getElementById("version")?.textContent === "UPDATED"')))
    await win.getByRole('button', { name: '恢复源码 Working baseline', exact: true }).click()
    await win.locator('.csu-restore-confirm').getByRole('button', { name: '恢复源码', exact: true }).click()
    const restored = await until(() => fs.readFileSync(path.join(project, 'index.html'), 'utf8') === SAMPLE && !fs.existsSync(path.join(project, 'added.js')))
    check('Restore puts the exact source back and removes added source files', restored)
    check('Restore preserves excluded environment configuration', fs.readFileSync(path.join(project, '.env'), 'utf8') === 'TEST_SETTING=after\n')
    check('Restore refreshes the real preview back to the baseline', !!await until(() => guestEval(win, 'document.getElementById("version")?.textContent === "BASELINE"')))
    check('Restore preserves a backup of the preceding version', !!await until(async () => await win.locator('.csu-version').count() >= 2))
    await shoot(app, win, 'versions')

    await win.locator('.csu-project').click()
    await win.waitForSelector('.csl-launchpad')
    check('Leaving the project removes all of its temporary native views', !!await until(async () => await win.locator('[data-transient-view]').count() === 0))
    check('Leaving the project disposes its stable preview surface and guest', !!await until(async () => await win.locator('.csu-guest-surface').count() === 0 && await win.locator('webview').count() === 0))
    check('Temporary Studio tools never enter saved workspace layouts', await win.evaluate(() => Object.entries(localStorage).filter(([key]) => /layout/i.test(key)).every(([,value]) => !value.includes('__extend-') && !value.includes('coding-tool:'))))
    check('An imported project remains discoverable on the launchpad', !!await until(async () => (await win.locator('.csl-project').allTextContents()).some(text => text.includes('Imported studio project'))))

    // Use the real persisted preferences + startup loader. Do not synthesize theme tokens
    // or change data-theme/data-skin/data-bg: the current design language stays intact.
    // Keys are defined by themeStore.ts persistPref and i18n.tsx LS_KEY respectively.
    const originalTheme = await win.evaluate(() => ({ theme: document.documentElement.dataset.theme, skin: document.documentElement.dataset.skin, bg: document.documentElement.dataset.bg }))
    await win.evaluate(() => localStorage.setItem('forsion_theme_pref', 'dark'))
    await win.reload()
    await win.waitForSelector('.dv-groupview', { timeout: 45000 })
    await openCodingSpace(win)
    await win.waitForSelector('.csl-launchpad', { timeout: 45000 })
    await until(() => win.evaluate(() => document.documentElement.classList.contains('dark') && document.documentElement.dataset.mode === 'dark'))
    await win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await win.waitForTimeout(500)
    const darkState = await win.evaluate(() => ({ theme: document.documentElement.dataset.theme, skin: document.documentElement.dataset.skin, bg: document.documentElement.dataset.bg, mode: document.documentElement.dataset.mode, dark: document.documentElement.classList.contains('dark') }))
    check('Dark preference uses the real theme loader and preserves the selected theme axes', darkState.dark && darkState.mode === 'dark'
      && darkState.theme === originalTheme.theme && darkState.skin === originalTheme.skin && darkState.bg === originalTheme.bg, JSON.stringify(darkState))
    await shoot(app, win, 'launchpad-dark')
    await win.evaluate(() => localStorage.setItem('tangu_locale', 'en'))
    await win.reload()
    await win.waitForSelector('.dv-groupview', { timeout: 45000 })
    await openCodingSpace(win)
    await win.waitForSelector('.csl-launchpad', { timeout: 45000 })
    check('English preference translates the live launchpad', !!await until(async () => await win.getByRole('heading', { name: 'Coding Studio', exact: true }).isVisible().catch(() => false))
      && await win.getByRole('button', { name: 'Create project', exact: true }).isVisible()
      && await win.getByRole('button', { name: 'Open local folder', exact: true }).isVisible())
    await win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await win.waitForTimeout(500)
    await shoot(app, win, 'launchpad-dark-en')
    await win.locator('.csl-project').filter({ hasText: 'Imported studio project' }).click()
    await win.waitForSelector('.csu-workspace')
    await until(() => guestEval(win, 'document.getElementById("version")?.textContent === "BASELINE"'))
    check('English preference translates the live project toolbar', await win.getByRole('button', { name: 'Select an element', exact: true }).isVisible()
      && await win.getByRole('button', { name: 'Versions', exact: true }).isVisible())
    await previewDiagnostic(app, win, 'workspace-dark-en')
    await win.emulateMedia({ reducedMotion: 'reduce' })
    const reduced = await win.evaluate(async () => {
      const button = document.querySelector('button[aria-label="Phone · 390"]')
      const before = document.querySelector('.csp-viewport').getBoundingClientRect().width
      button.click()
      const samples = []
      for (let i = 0; i < 8; i++) {
        await new Promise(requestAnimationFrame)
        samples.push(document.querySelector('.csp-viewport').getBoundingClientRect().width)
      }
      return { before, samples }
    })
    motion.push({ name: 'Reduced motion phone width', ...reduced })
    check('Reduced motion changes device width without a tween', reduced.samples.every(value => Math.abs(value - reduced.samples.at(-1)) < 1))
    const reducedPanel = await win.evaluate(async () => {
      document.querySelector('.csu-tool-nav button')?.click()
      const samples = []
      for (let i = 0; i < 8; i++) {
        await new Promise(requestAnimationFrame)
        samples.push(document.querySelector('.wb-extend[data-side=right]')?.closest('.dv-groupview').getBoundingClientRect().width ?? 0)
      }
      return samples
    })
    motion.push({ name: 'Reduced motion native panel', samples: reducedPanel })
    check('Reduced motion also disables the native Temp View size tween', reducedPanel[0] > 50 && reducedPanel.every(value => Math.abs(value - reducedPanel.at(-1)) < 1))
    await closeStudioTool(win)
    await win.getByRole('button', { name: 'Responsive', exact: true }).click()
    await win.emulateMedia({ reducedMotion: 'no-preference' })
    await recordMotionDemo(app, win)
    // Stable browser surfaces must follow shell zoom and leave overlays above them.
    await win.locator('.csu-modes').getByRole('button', { name: 'Preview', exact: true }).focus()
    await win.keyboard.press('Meta+k')
    await win.locator('.cmd-panel input').fill('Coding Studio · Versions')
    const commandAbovePreview = await win.locator('.cmd-panel').evaluate(el => {
      const r = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(100, r.height / 2)))
    })
    check('The command palette remains above and interactive over the stable preview', commandAbovePreview)
    await win.locator('.cmd-item').filter({ hasText: 'Coding Studio · Versions' }).click()
    check('A real command palette action opens the same native Studio tool', !!await until(async () => await win.locator('.wb-extend[data-side=bottom] .csu-tool-view[data-tool=history]').count() === 1))
    await closeStudioTool(win)
    await win.locator('.csu-modes').getByRole('button', { name: 'Preview', exact: true }).focus()
    await win.keyboard.press('Meta+=')
    const zoomAligned = await until(() => win.evaluate(() => {
      const anchor = document.querySelector('.csp-anchor'), stage = document.querySelector('.csp-stage')
      if (!anchor || !stage || Number(getComputedStyle(document.body).zoom) <= 1) return false
      const a = anchor.getBoundingClientRect(), b = stage.getBoundingClientRect()
      return ['left','top','width','height'].every(key => Math.abs(a[key] - b[key]) < 2)
    }))
    check('Stable preview geometry follows the real application zoom command', zoomAligned)
    await shoot(app, win, 'zoomed-preview')
    await win.keyboard.press('Meta+0')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 800))
    await win.waitForTimeout(450)
    check('A narrower workspace keeps the project toolbar and footer within the view', await win.evaluate(() => {
      const parent = document.querySelector('.csx.csu').getBoundingClientRect()
      return ['.csu-head','.csu-tool-nav','.csu-status'].every(selector => {
        const el = document.querySelector(selector), r = el.getBoundingClientRect()
        return r.left >= parent.left - 1 && r.right <= parent.right + 1 && el.scrollWidth <= el.clientWidth + 1
      })
    }))
    await shoot(app, win, 'narrow-workspace')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1540, 1040))
    await win.waitForTimeout(350)
    // Create through the production launchpad and brief panel. A prepared request must
    // remain a draft; no sample app or stub response is substituted for generation.
    await win.locator('.csu-project').click()
    await win.waitForSelector('.csl-launchpad')
    await win.locator('.csl-template').filter({ hasText: 'Writing assistant' }).click()
    check('Choosing a template fills an editable brief and its real capability',
      (await win.locator('.csl-idea').inputValue()).includes('AI writing assistant')
      && await win.getByRole('button', { name: 'AI chat', exact: true }).getAttribute('aria-pressed') === 'true')
    const createdName = 'E2E Brief Project'
    const createdProject = path.join(managed, createdName)
    const briefFile = path.join(createdProject, 'FORSION_BRIEF.md')
    const createdIdea = 'Build a reading notebook with searchable notes and a clear empty state.'
    const createdAudience = 'Students who are learning to code.'
    const createdConstraints = 'Keep data on this device and preserve keyboard navigation.'
    await win.locator('.csl-idea').fill(createdIdea)
    await win.locator('.csl-details summary').click()
    await win.getByLabel('Who is it for?', { exact: true }).fill(createdAudience)
    await win.getByLabel('Requirements to keep', { exact: true }).fill(createdConstraints)
    await win.getByLabel('Project name', { exact: true }).fill(createdName)
    await shoot(app, win, 'create-brief')
    await win.getByRole('button', { name: 'Create project', exact: true }).click()
    await win.waitForSelector('.csu-workspace')
    const createdOnDisk = await until(() => fs.existsSync(briefFile))
    check('Create project makes the real managed directory and portable brief', createdOnDisk
      && fs.statSync(createdProject).isDirectory()
      && (await win.locator('.csu-project').textContent()).includes(createdName))
    if (!createdOnDisk) throw new Error('Creating a project did not persist FORSION_BRIEF.md')
    check('The composer visibly stays bound to the created project', await win.locator('[data-studio-project]').getAttribute('data-studio-project') === createdProject
      && (await win.locator('[data-studio-project]').textContent()).includes(createdName)
      && await win.locator('.newchat-projectbar .project-selector').count() === 0)
    const createdBrief = fs.readFileSync(briefFile, 'utf8')
    check('The saved brief preserves user edits, audience, constraints and selected SDK',
      [createdIdea, createdAudience, createdConstraints, 'window.forsion.ai.chat'].every(value => createdBrief.includes(value)))
    check('Creating from a prompt template does not fabricate generated application files',
      fs.readdirSync(createdProject).filter(name => !name.startsWith('.')).every(name => name === 'FORSION_BRIEF.md'))
    check('The new project brief reaches the actual composer as an unsent draft', !!await until(async () => {
      const value = await win.locator('.t2c-ta').first().inputValue().catch(() => '')
      return [createdIdea, createdAudience, createdConstraints].every(text => value.includes(text))
    }) && stub.seen.runs.length === 0)
    await win.getByRole('button', { name: 'Project brief', exact: true }).first().click()
    const updatedIdea = `${createdIdea} Allow exporting my notes as JSON.`
    await win.getByLabel('Project goal', { exact: true }).fill(updatedIdea)
    await win.getByRole('button', { name: 'Save brief', exact: true }).click()
    check('Saving an edited brief updates the physical project file', !!await until(() => fs.readFileSync(briefFile, 'utf8').includes(updatedIdea)))
    await win.getByRole('button', { name: 'Plan first', exact: true }).click()
    check('Plan first selects the existing chat plan mode and queues the updated brief', !!await until(async () => {
      const value = await win.locator('.t2c-ta').first().inputValue().catch(() => '')
      const mode = win.locator('.mode-pill-btn.active').first()
      return value.includes(updatedIdea) && await mode.isVisible().catch(() => false)
        && /plan/i.test(await mode.textContent())
    }))
    await shoot(app, win, 'created-project-plan')
    await win.locator('.csu-project').click()
    await win.waitForSelector('.csl-launchpad')
    check('A newly created project is listed once across managed and recent projects', !!await until(async () =>
      await win.locator('.csl-project').filter({ hasText: createdName }).count() === 1))
    check('New project and brief actions preserve the imported project source', fs.readFileSync(path.join(project, 'index.html'), 'utf8') === SAMPLE)
    check('All workflows complete without a model request', stub.seen.runs.length === 0)
    check('No renderer exception occurred', rendererErrors.length === 0, rendererErrors.join('; ').slice(0, 800))
  } catch (error) {
    check('E2E workflow completes', false, error.stack || String(error))
    if (win) await shoot(app, win, 'failure').catch(() => {})
  } finally {
    if (app) await app.close().catch(() => {})
    stub.close()
    fs.writeFileSync(path.join(OUTPUT, 'coding-studio-results.json'), JSON.stringify({ testDir, results, rendererErrors, geometry, motion }, null, 2))
    fs.writeFileSync(path.join(OUTPUT, 'coding-studio-motion.json'), JSON.stringify(motion, null, 2))
    const failed = results.filter(result => !result.ok)
    console.log(`\n${results.length - failed.length}/${results.length} passed; fixture: ${testDir}`)
    if (failed.length) process.exitCode = 1
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
