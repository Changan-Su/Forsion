/** Windows real native references through rendered chat chips. No fake helper or OS input synthesis.
 * Own Electron target executable and temporary profiles; leaves installed Forsion untouched.
 * Run under the repository e2e devlock. Native hotkeys/admin/virtual desktops remain separate checks.
 */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'outputs/windows-apprefs-desktop')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const results = []
const check = (name, passed, detail) => { results.push({ name, passed: !!passed, detail }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`); assert.ok(passed, name) }
async function until(predicate, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await predicate()) return true; await sleep(100) }
  return false
}
async function main() {
  assert.equal(process.platform, 'win32')
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-native-refs-'))
  // A separate executable basename prevents an app reference from selecting an
  // unrelated developer Electron window and gives this portable target its own ID.
  const runtime = path.join(home, 'runtime')
  fs.cpSync(path.dirname(require('electron')), runtime, { recursive: true })
  const exe = path.join(runtime, 'WindowsAcceptance.exe')
  fs.renameSync(path.join(runtime, 'electron.exe'), exe)
  const fixture = path.join(home, 'target'); fs.mkdirSync(fixture)
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ main: 'main.cjs', name: 'windows-reference-acceptance' }))
  fs.writeFileSync(path.join(fixture, 'main.cjs'), `
const { app, BrowserWindow, screen } = require('electron');
app.whenReady().then(async () => {
  globalThis.targets = [];
  const displays = screen.getAllDisplays().sort((a,b) => a.bounds.x-b.bounds.x);
  for (const [i, title] of ['ZZ Windows reference A', 'ZZ Windows reference B'].entries()) {
    const area = (i ? screen.getPrimaryDisplay() : displays[0]).workArea;
    const w = new BrowserWindow({ x: area.x + 80, y: area.y + 80, width: 640, height: 420, title, backgroundColor: '#233148' });
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<title>' + title + '</title><body style="background:#233148;color:white;font:24px sans-serif">' + title + '<p>Isolated native reference target</p><input placeholder="Acceptance text only"></body>'));
    globalThis.targets.push(w);
  }
});
app.on('window-all-closed', () => app.quit());`)
  let target, app, stub
  let failed
  try {
    target = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${path.join(home, 'target-data')}`, fixture] })
    await target.firstWindow()
    assert.ok(await until(async () => await target.evaluate(() => globalThis.targets?.length === 2)))
    const native = () => target.evaluate(() => globalThis.targets.map(w => ({ title: w.getTitle(), focused: w.isFocused(), minimized: w.isMinimized(), bounds: w.getBounds() })))
    const original = await native()
    const at = Date.now()
    stub = await startStubEngine({
      sessions: [{ id: 'apprefs', title: 'Windows native references', model_id: 'm1', archived: false, agent_config: null, project_path: null, project_name: null, created_at: '2026-10-24 00:00:00', updated_at: '2026-10-24 00:00:00' }],
      messages: [{ id: 'u1', role: 'user', content: 'Windows native targets: ' + Array.from({ length: 16 }, (_, i) => `[[window://windowsacceptance.exe|ZZ Windows reference ${i % 2 ? 'B' : 'A'}]]`).join(' '), timestamp: at, attachments: null }],
    })
    const userData = path.join(home, 'userdata')
    for (const dir of [userData, userData + '-dev']) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'fixture' }))
    }
    const launch = async () => {
      app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
        env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, FORSION_TEST_DESKTOP: '', TANGU_HARNESS_QUIET: '0' } })
      const page = await app.firstWindow()
      await page.evaluate(() => localStorage.setItem('forsion_default_space', 'tangu'))
      await page.reload(); assert.ok(await skipOnboarding(page))
      await page.locator('#tocmsg-u1 .app-ref').first().waitFor({ timeout: 30000 })
      return page
    }
    let win = await launch()
    const chip = name => win.locator('#tocmsg-u1 .app-ref', { hasText: `ZZ Windows reference ${name}` }).first()
    check('actual native target has a distinct portable executable ID', (await win.evaluate(() => window.tangu.appRefs.list())).windows.filter(w => /^ZZ Windows reference [AB]$/.test(w.title)).every(w => w.id === 'windowsacceptance.exe'))
    check('sixteen real chat chips resolve to live Windows windows', await until(async () => await win.locator('#tocmsg-u1 .app-ref[data-state="live"]').count() === 16))
    for (const [name, index] of [['A', 0], ['B', 1]]) {
      const start = Date.now(); await chip(name).click()
      check(`chat chip activates native window ${name}`, await until(async () => (await native())[index].focused), { ms: Date.now() - start })
      check(`activation preserves ${name} position and size on its real display`, JSON.stringify((await native())[index].bounds) === JSON.stringify(original[index].bounds), original[index].bounds)
    }
    await target.evaluate(() => globalThis.targets[0].minimize())
    check('fixture is actually minimized before testing restoration', (await native())[0].minimized)
    await chip('A').click()
    check('rendered chip restores and focuses the minimized window', await until(async () => { const w = (await native())[0]; return w.focused && !w.minimized }))
    await target.evaluate(() => globalThis.targets[0].setTitle('ZZ Windows renamed native target'))
    await sleep(1400)
    await chip('B').click(); await until(async () => (await native())[1].focused)
    await chip('A').hover(); await sleep(1000)
    check('remembered chip stays live after native title change', await chip('A').getAttribute('data-state') === 'live')
    await chip('A').click()
    check('old title chip still activates the same native window', await until(async () => (await native())[0].focused))
    const count = (await native()).length
    await app.close(); app = null
    win = await launch()
    await chip('A').hover(); await sleep(1500)
    check('restart marks unmatched old title as closed', await chip('A').getAttribute('data-state') === 'closed')
    await chip('A').click()
    check('restart fallback activates an existing window without another launch', await until(async () => (await native()).some(w => w.focused)) && (await native()).length === count)
    // Count actual child-process starts, independent of short process lifetimes.
    await app.evaluate(() => {
      const cp = process.mainModule.require('node:child_process'); const original = cp.execFile
      globalThis.__nativeRefSpawns = []
      cp.execFile = function (file, ...args) { if (/powershell(?:\.exe)?$/i.test(file)) globalThis.__nativeRefSpawns.push({ file: String(file).split(/[\\/]/).at(-1), at: Date.now() }); return original.call(this, file, ...args) }
      const sync = process.mainModule.require('node:module').syncBuiltinESMExports
      sync()
      globalThis.__restoreNativeRefSpawns = () => { cp.execFile = original; sync() }
    })
    await sleep(3500)
    await win.evaluate(() => window.tangu.appRefs.list())
    const known = await app.evaluate(() => { const n = globalThis.__nativeRefSpawns.length; globalThis.__nativeRefSpawns = []; return n })
    check('PowerShell counter observes a known production list request through ESM imports', known > 0, { known })
    await win.mouse.move(2, 2); await sleep(65000)
    const starts = await app.evaluate(() => { const starts = globalThis.__nativeRefSpawns; globalThis.__restoreNativeRefSpawns(); return starts })
    check('sixteen idle chips cause no recurring PowerShell starts over 65 seconds', starts.length === 0, starts)
    await win.screenshot({ path: path.join(OUT, 'native-chat-chips.png') })
  } catch (error) {
    failed = error; console.error(error)
    if (app) for (const [i, page] of app.windows().entries()) {
      await page.screenshot({ path: path.join(OUT, `failure-${i}.png`) }).catch(() => {})
      fs.writeFileSync(path.join(OUT, `failure-${i}.txt`), await page.locator('body').innerText().catch(() => 'unavailable'))
    }
  }
  finally {
    await app?.close().catch(() => {}); await target?.close().catch(() => {}); await stub?.close()
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, failed: failed?.message || null }, null, 2))
  }
  if (failed) throw failed
  console.log(`${results.length}/${results.length} passed`)
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
