/** Mini session restoration through real quit/relaunch, isolated from all user state. Build first. */
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..'), home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-mini-restart-'))
const userData = path.join(home, 'userdata'), stateFile = path.join(userData + '-dev', 'mini-session.json')

async function main() {
  const stub = await startStubEngine({ sessions: [{ id: 'mini-test', title: 'Mini test', created_at: '2026-11-12T00:00:00Z', updated_at: '2026-11-12T00:00:00Z' }] })
  fs.mkdirSync(userData + '-dev', { recursive: true })
  fs.writeFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'mini-test' }))
  const vault = path.join(home, 'vault'), plugin = path.join(home, 'plugins', 'restart-probe')
  fs.mkdirSync(vault); fs.mkdirSync(plugin, { recursive: true })
  for (const name of ['A', 'B']) fs.writeFileSync(path.join(vault, `${name}.md`), `# ${name}\n\nMini restart fixture.\n`)
  fs.writeFileSync(path.join(userData + '-dev', 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault }))
  fs.writeFileSync(path.join(plugin, 'manifest.json'), JSON.stringify({ id: 'restart-probe', name: 'Restart probe', version: '1.0.0', minAppVersion: '0.0.1' }))
  fs.writeFileSync(path.join(plugin, 'main.js'), `window.__restartProbe=ctx;ctx.registerView({id:'mini',title:'Restart probe',mount(el,view){const b=document.createElement('button');b.id='restart-next';b.textContent='Switch to B';b.onclick=()=>view.setParams({item:'B'});el.append(b);return()=>{b.remove()}}});`)
  let app
  const boot = async () => {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1' } })
    await app.firstWindow()
    let win
    for (let i = 0; i < 200; i++) {
      win = app.windows().find(w => /index\.html/.test(w.url()) && !w.url().includes('window='))
      if (win) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.ok(win, 'Main window must be selected independently of restored Mini load order')
    await win.waitForSelector('.dv-groupview', { timeout: 30000, state: 'attached' })
    await skipOnboarding(win)
    return win
  }
  const miniCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().includes('window=mini')).length)
  try {
    const win = await boot()
    await win.evaluate(async () => {
      await window.tangu.openMini({ spaceId: 'calendar' })
      await window.tangu.openMini({ spaceId: 'calendar', duplicate: true })
      await window.tangu.openMini({ sessionId: 'mini-test' })
    })
    for (let i = 0; i < 100 && await miniCount() !== 3; i++) await win.waitForTimeout(100)
    assert.equal(await miniCount(), 3)
    await win.waitForFunction(() => !!window.__restartProbe)
    await win.evaluate(async () => {
      await window.tangu.openMini({ spaceId: 'amadeus', params: { notePath: 'A.md' }, pin: false })
      window.__restartProbe.openMiniPanel('mini', { params: { item: 'A' } })
    })
    for (let i = 0; i < 100 && await miniCount() !== 5; i++) await win.waitForTimeout(100)
    assert.equal(await miniCount(), 5)
    const findPage = async selector => {
      for (let i = 0; i < 100; i++) {
        for (const page of app.windows()) if (await page.locator(selector).count()) return page
        await win.waitForTimeout(100)
      }
      throw new Error(`Mini not ready: ${selector}`)
    }
    const direct = await findPage('#restart-next')
    await direct.locator('#restart-next').click()
    // Change the current note through the Mini's actual picker.
    const note = await findPage('.mini-amadeus')
    await note.locator('.mini-card-picker').click()
    await note.locator('.mini-card-row').filter({ hasText: /^B$/ }).click()
    await note.waitForFunction(() => document.querySelector('.mini-amadeus [data-amx-src="B.md"]'))
    // Close one explicitly. Duplicates retain independent positions and visibility.
    await app.evaluate(({ BrowserWindow, screen }) => {
      const ws = BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().includes('window=mini')).sort((a, b) => a.id - b.id)
      const area = screen.getPrimaryDisplay().workArea
      ws[0].setBounds({ x: area.x, y: area.y + 100, width: 300, height: 350 })
      ws[1].setBounds({ x: area.x + area.width - 310, y: area.y + 140, width: 310, height: 390 }); ws[1].hide()
      ws[2].close()
    })
    await win.waitForTimeout(800)
    await app.close(); app = null
    assert.ok(fs.existsSync(stateFile), 'Open Mini windows are not saved at quit')
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    assert.equal(saved.length, 4)
    assert.equal(saved[2].pinned, false)
    assert.equal(saved[1].visible, false)
    assert.equal(saved[2].target.params.notePath, 'B.md')
    assert.equal(saved[3].target.view.params.item, 'B')
    assert.notEqual(saved[0].bounds.x, saved[1].bounds.x, 'Docked duplicates keep independent expanded positions')
    const again = await boot()
    for (let i = 0; i < 100 && await miniCount() !== 4; i++) await again.waitForTimeout(100)
    assert.equal(await miniCount(), 4, 'Only the still-open Minis should reopen')
    const restored = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().includes('window=mini'))
      .sort((a, b) => a.id - b.id).map(w => ({ bounds: process.platform === 'win32' ? w.getContentBounds() : w.getBounds(), pinned: w.isAlwaysOnTop(), visible: w.isVisible() })))
    assert.deepEqual(restored.map(w => w.bounds), saved.map(w => w.bounds))
    assert.deepEqual(restored.map(w => w.pinned), [true, true, false, true])
    assert.deepEqual(restored.map(w => w.visible), saved.map(w => w.visible))
    console.log('PASS Mini quit/relaunch: duplicates, independent bounds, visibility, pin state, and explicitly closed windows')
  } finally { if (app) await app.close(); await stub.close(); console.log('Evidence:', home) }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
