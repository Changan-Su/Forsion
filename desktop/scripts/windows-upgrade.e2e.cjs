/** Real v2.13.4 code creates a Windows profile; current code reopens it.
 * Both renderers use the same isolated HTTP origin, as an installed update uses
 * the same file origin. Never rewrite the old profile's paths to manufacture it.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const { spawn, execFileSync } = require('node:child_process')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
const OLD = process.env.FORSION_UPGRADE_OLD_ROOT
const PORT = Number(process.env.FORSION_UPGRADE_PORT || 5210)
const ORIGIN = `http://127.0.0.1:${PORT}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const results = []
const check = (value, name) => { assert.ok(value, name); results.push(name); console.log(`PASS ${name}`) }
function pdf() {
  const stream = 'BT /F1 18 Tf 40 100 Td (Upgrade PDF) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let text = '%PDF-1.4\n'; const offsets = []
  objects.forEach((obj, i) => { offsets.push(text.length); text += `${i + 1} 0 obj\n${obj}\nendobj\n` })
  const at = text.length
  return text + `xref\n0 6\n0000000000 65535 f \n` + offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`
}
async function responding() {
  return new Promise(resolve => {
    const req = http.get(ORIGIN, response => { response.resume(); resolve(response.statusCode === 200) })
    req.on('error', () => resolve(false)); req.setTimeout(1000, () => { req.destroy(); resolve(false) })
  })
}
async function main() {
  assert.equal(process.platform, 'win32')
  assert.ok(OLD, 'FORSION_UPGRADE_OLD_ROOT must point at a built v2.13.4 checkout')
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: OLD, encoding: 'utf8' }).trim()
  assert.ok(revision.startsWith('60f78259'), `Unexpected old code: ${revision}`)
  assert.ok(!await responding(), 'Upgrade test port must be unused')
  const output = process.env.FORSION_UPGRADE_OUTPUT || os.tmpdir()
  fs.mkdirSync(output, { recursive: true })
  const home = fs.mkdtempSync(path.join(output, 'forsion-real-upgrade-'))
  const vault = path.join(home, 'Vault'), ud = path.join(home, 'userdata')
  const rel = '子目录/升级笔记.md', draftRel = '子目录/草稿笔记.md', dbRel = '子目录/升级日程.db', pdfRel = '子目录/升级文档.pdf', dashRel = '子目录/升级仪表盘.dashboard.md'
  fs.mkdirSync(path.join(vault, '子目录'), { recursive: true }); fs.mkdirSync(path.join(vault, '目标夹'))
  fs.writeFileSync(path.join(vault, rel), '# 升级笔记\n\nRetained note content.\n')
  fs.writeFileSync(path.join(vault, draftRel), '# 草稿笔记\n\nOriginal draft baseline.\n')
  fs.writeFileSync(path.join(vault, pdfRel), pdf())
  fs.writeFileSync(path.join(vault, dashRel), '---\ntitle: 升级仪表盘\n---\n')
  const day = new Date().toISOString().slice(0, 10)
  fs.writeFileSync(path.join(vault, dbRel), JSON.stringify({ version: 2, name: '升级日程', columns: [{ id: 'title', name: '标题', type: 'text' }, { id: 'when', name: '日期', type: 'calendarDate' }], rows: [{ id: 'upgrade_event', cells: { title: 'Upgrade calendar event', when: day } }] }))
  for (const dir of [ud, `${ud}-dev`]) {
    fs.mkdirSync(dir)
    for (const name of ['amadeus-config.json', 'amadeus-config.dev.json']) fs.writeFileSync(path.join(dir, name), JSON.stringify({ lastVault: vault, localVault: vault }))
  }
  const stub = await startStubEngine()
  let app, win, server, serverExit
  const start = async root => {
    server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'frontend', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: root, windowsHide: true, stdio: 'ignore' })
    serverExit = new Promise(resolve => { server.once('exit', resolve); server.once('error', resolve) })
    for (let i = 0; i < 60 && !await responding(); i++) await sleep(500)
    assert.ok(await responding(), 'Renderer server must start')
    app = await electron.launch({ args: [`--user-data-dir=${ud}`, '--lang=zh-CN', root], cwd: root,
      env: { ...process.env, TANGU_HOME: home, FORSION_WORKSPACE_DIR: path.join(home, 'workspace'), TANGU_BACKEND_URL: stub.url, ELECTRON_RENDERER_URL: ORIGIN } })
    win = await app.firstWindow()
    win.on('pageerror', error => console.error(`PAGEERROR ${error.message}`))
    // A fresh checkout compiles this renderer through Vite on its first load.
    // CI captured the real update wizard only after the generic 15s wait had
    // expired, so wait for its actual button before attempting to dismiss it.
    assert.ok(await skipOnboarding(win, 60000), 'Actual app must leave onboarding')
  }
  const stopServer = async () => {
    if (server) {
      const child = server; server = null
      child.kill()
      await Promise.race([serverExit, sleep(3000)])
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([serverExit, sleep(1000)]) }
    }
    for (let i = 0; i < 30 && await responding(); i++) await sleep(100)
  }
  const crash = async () => {
    await app.evaluate(({ session }) => session.defaultSession.flushStorageData())
    await sleep(200)
    const closed = app.waitForEvent('close')
    execFileSync('taskkill.exe', ['/PID', String(app.process().pid), '/T', '/F'], { windowsHide: true, stdio: 'pipe', timeout: 15000 })
    await closed; app = null
    await stopServer()
  }
  const tab = name => win.locator('.dv-tab').filter({ hasText: name })
  const treeRow = async (name, folder = '子目录') => {
    const row = win.locator('.t2s-srow').filter({ hasText: name }).first()
    if (!await row.count()) await win.locator('.t2s-folder-row').filter({ hasText: folder }).first().click()
    await row.waitFor({ timeout: 10000 })
    return row
  }
  const open = async name => {
    const row = await treeRow(name)
    await row.click({ modifiers: ['Control'] })
    await tab(name).first().waitFor({ timeout: 30000 })
    await tab(name).first().click()
    await sleep(600)
  }
  try {
    await start(OLD)
    await win.locator('.rb-space[aria-label="笔记"], .rb-space[aria-label="Note"]').first().click()
    await win.locator('.t2s-folder-row').filter({ hasText: '子目录' }).first().click()
    await win.evaluate(async ({ compiler, dashRel }) => {
      const { compileDashboardRecipe } = await import(compiler)
      const compiled = compileDashboardRecipe({ cards: [{ kind: 'text', id: 'upgrade_card', md: '# Old dashboard\n\nRetained dashboard content.' }] })
      if (!compiled.ok) throw new Error(compiled.error)
      await window.amadeus.writeTextFile(dashRel, compiled.text)
    }, { compiler: '/@fs/' + path.join(OLD, 'shared/amadeus/dashboardRecipe.ts').replaceAll('\\', '/'), dashRel })
    for (const name of ['升级笔记', '升级日程', '升级文档', '升级仪表盘']) await open(name)
    const original = await win.evaluate(async ({ vault }) => {
      const { usePageStore } = await import('/src/amadeus/store/pageStore.ts')
      const { useAmadeusPrefs } = await import('/src/amadeusPrefs.ts')
      const { useCalendarConfig } = await import('/src/amadeus/store/calendarConfigStore.ts')
      const state = usePageStore.getState()
      if (state.vaultRoot !== vault) throw new Error('Old runtime is not using fixture vault')
      const note = state.pages.find(p => p.endsWith('升级笔记.md'))
      const db = state.files.find(p => p.endsWith('升级日程.db'))
      if (!note || !db) throw new Error('Old runtime did not enumerate fixture files')
      useAmadeusPrefs.getState().toggleStar(note); useAmadeusPrefs.getState().togglePin(note)
      const cfg = useCalendarConfig.getState()
      cfg.addMember(vault, db, 'when'); cfg.setColor(vault, db, '#b57bd0'); cfg.setDefault(vault, db)
      localStorage.setItem('forsion_default_space', '__last__')
      return { note, db, prefs: JSON.parse(localStorage.getItem(`amadeus_prefs:${vault}`)), calendar: JSON.parse(localStorage.getItem('amadeus.calendar.cfg'))[vault] }
    }, { vault })
    check(original.note.includes('\\') && original.db.includes('\\'), 'actual 2.13.4 Windows enumeration produces legacy backslash paths')
    check(original.prefs.starred.includes(original.note) && original.calendar.colors[original.db] === '#b57bd0', 'old runtime itself writes legacy preferences and calendar state')
    await tab('升级笔记').first().click()
    await win.locator('.amx-more-btn').last().click()
    await win.getByRole('button', { name: '锁定页面', exact: true }).click()
    await win.getByRole('button', { name: '解锁', exact: true }).waitFor()
    check(true, 'old UI locks the real legacy note')
    await open('草稿笔记')
    await win.locator('.ProseMirror p:visible').filter({ hasText: 'Original draft baseline.' }).click()
    await win.keyboard.press('End')
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('file:write-text')
      ipcMain._invokeHandlers.set('file:write-text', (event, rel, ...args) => String(rel).replaceAll('\\', '/') === '子目录/草稿笔记.md' ? new Promise(() => {}) : original(event, rel, ...args))
    })
    await win.keyboard.type(' UNSAVED FROM OLD VERSION')
    await win.evaluate(() => window.dispatchEvent(new Event('pagehide')))
    const oldDrafts = await win.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('amadeus.unsavedDraft:')).map(k => ({ key: k, data: JSON.parse(localStorage.getItem(k)) })))
    check(oldDrafts.some(d => d.key.includes('\\') && d.data.text.includes('UNSAVED FROM OLD VERSION')), 'old editor creates its real unsaved legacy-key draft')
    check(!fs.readFileSync(path.join(vault, draftRel), 'utf8').includes('UNSAVED'), 'crash fixture really has unwritten input')
    await crash()
    await start(ROOT)
    for (const name of ['升级笔记', '升级日程', '升级文档', '升级仪表盘', '草稿笔记']) {
      await tab(name).first().waitFor({ timeout: 30000 })
      check(await tab(name).count() === 1, `upgrade restores one ${name} tab`)
    }
    await tab('升级笔记').first().click()
    await win.getByRole('button', { name: '解锁', exact: true }).waitFor()
    check(await win.locator('.ProseMirror[contenteditable="true"]:visible').count() === 0, 'legacy note remains read-only after upgrade')
    await win.getByText('Retained note content.', { exact: true }).waitFor()
    const upgraded = await win.evaluate(async ({ vault }) => {
      const { useAmadeusPrefs } = await import('/src/amadeusPrefs.ts')
      const { useCalendarConfig } = await import('/src/amadeus/store/calendarConfigStore.ts')
      return { prefs: useAmadeusPrefs.getState(), calendar: useCalendarConfig.getState().byVault[vault] }
    }, { vault })
    check(upgraded.prefs.starred.filter(p => p === rel).length === 1 && upgraded.prefs.pins.filter(p => p === rel).length === 1, 'real old favorites and pins survive once under canonical paths')
    check(upgraded.calendar.members[dbRel]?.dateCol === 'when' && upgraded.calendar.colors[dbRel] === '#b57bd0' && upgraded.calendar.defaultDbPath === dbRel, 'real old calendar membership, color and default source survive')
    await win.locator('.rb-space[aria-label="日历"], .rb-space[aria-label="Calendar"]').first().click()
    const event = win.locator('.amx-cal-chip-ev, .amx-cal-event').filter({ hasText: 'Upgrade calendar event' }).first()
    await event.waitFor({ timeout: 30000 })
    check(await event.evaluate(el => getComputedStyle(el).getPropertyValue('--amx-event-color').trim()) === '#b57bd0', 'calendar visibly renders the old source event with its retained color')
    await win.screenshot({ path: path.join(home, 'calendar.png') })
    await win.locator('.rb-space[aria-label="笔记"], .rb-space[aria-label="Note"]').first().click()
    await tab('升级日程').first().click()
    await win.getByText('Upgrade calendar event', { exact: true }).first().waitFor()
    const before = await tab('升级日程').count()
    await (await treeRow('升级日程')).click()
    check(await tab('升级日程').count() === before, 'clicking the legacy-restored database reuses its tab')
    await tab('升级仪表盘').first().click()
    await win.getByText('Retained dashboard content.', { exact: true }).waitFor()
    check(true, 'legacy dashboard restores real card content')
    await tab('升级文档').first().click()
    await win.waitForFunction(() => [...document.querySelectorAll('.pdfa-container .pdfViewer .page[data-page-number="1"][data-loaded="true"]')].some(page => {
      if (!page.getBoundingClientRect().width || !page.querySelector('.textLayer')?.textContent.includes('Upgrade PDF')) return false
      const canvas = page.querySelector('canvas')
      if (!canvas?.width || !canvas.height) return false
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      let ink = 0
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 0 && data[i] < 120 && data[i + 1] < 120 && data[i + 2] < 120) ink++
      return ink > 20
    }))
    check(true, 'legacy PDF tab renders its page')
    await tab('草稿笔记').first().click()
    const draft = win.locator('[data-save="draft"]')
    await draft.waitFor(); await draft.getByRole('button').first().click()
    for (let i = 0; i < 100 && !fs.readFileSync(path.join(vault, draftRel), 'utf8').includes('UNSAVED FROM OLD VERSION'); i++) await sleep(100)
    check(fs.readFileSync(path.join(vault, draftRel), 'utf8').includes('UNSAVED FROM OLD VERSION'), 'restoring the real old draft writes all input to the original file')
    await tab('升级笔记').first().click()
    await win.getByRole('button', { name: '解锁', exact: true }).click()
    // The actual old runtime may have saved this as a legacy block document.
    // Exercise whichever editor its real bytes select after upgrading.
    await win.locator('.ProseMirror[contenteditable="true"]:visible').first().waitFor()
    await win.evaluate(async rel => { const { usePageStore } = await import('/src/amadeus/store/pageStore.ts'); await usePageStore.getState().movePage(rel, '目标夹') }, rel)
    await win.locator('.ProseMirror[contenteditable="true"]:visible p').filter({ hasText: 'Retained note content.' }).first().click()
    await win.keyboard.press('End'); await win.keyboard.type(' UPGRADE MOVE')
    for (let i = 0; i < 100 && !fs.readFileSync(path.join(vault, '目标夹/升级笔记.md'), 'utf8').includes('UPGRADE MOVE'); i++) await sleep(100)
    check(fs.readFileSync(path.join(vault, '目标夹/升级笔记.md'), 'utf8').includes('UPGRADE MOVE'), 'the restored editor continues saving to its moved path')
    check(fs.existsSync(path.join(vault, '目标夹/升级笔记.md')) && !fs.existsSync(path.join(vault, rel)), 'restored legacy note moves with its open editor')
    check(!fs.readdirSync(path.join(vault, '子目录')).some(name => name.includes('(conflict')) && !fs.readdirSync(path.join(vault, '目标夹')).some(name => name.includes('(conflict')), 'moving the old note creates no conflict copy')
    await (await treeRow('升级笔记', '目标夹')).click()
    check(await tab('升级笔记').count() === 1, 'clicking the moved legacy note does not duplicate its tab')
    await win.screenshot({ path: path.join(home, 'upgrade.png') })
    await app.close(); app = null; await stopServer()
    await start(ROOT)
    await tab('升级笔记').first().click()
    await win.locator('.ProseMirror[contenteditable="true"]:visible').filter({ hasText: 'Retained note content. UPGRADE MOVE' }).first().waitFor()
    check(await win.getByRole('button', { name: '解锁', exact: true }).count() === 0, 'unlock survives another complete restart')
    await tab('草稿笔记').first().click()
    await win.locator('.ProseMirror[contenteditable="true"]:visible').filter({ hasText: 'UNSAVED FROM OLD VERSION' }).first().waitFor()
    check(await win.locator('[data-save="draft"]').count() === 0, 'restored old draft does not reappear after restart')
    console.log(`${results.length}/${results.length} passed\nEVIDENCE ${home}`)
  } catch (error) {
    if (win && !win.isClosed()) { await win.screenshot({ path: path.join(home, 'failure.png') }).catch(() => {}); console.error((await win.locator('body').innerText().catch(() => '')).slice(-6000)) }
    console.error(`EVIDENCE ${home}`); throw error
  } finally {
    if (app) await app.close().catch(() => {})
    await stopServer(); await stub.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
