/** Real Windows packaged helper, Electron IPC, consent UI and lifecycle. No OS input synthesis. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'outputs', 'computer-history-windows')
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, timeout = 10000, interval = 100) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return true; await sleep(interval) }
  return false
}
async function main() {
  if (process.platform !== 'win32') throw new Error('This probe requires Windows')
  fs.mkdirSync(OUT, { recursive: true })
  const source = process.env.PI_COMPUTER_USE_WINDOWS_HELPER_PATH || path.join(ROOT, 'node_modules/@forsion/tangu-computer-use/prebuilt/windows/windows-bridge.exe')
  assert.ok(fs.existsSync(source), 'Published ComputerUse package contains Windows recorder')
  assert.equal(execFileSync(source, ['recorder-protocol'], { encoding: 'utf8', windowsHide: true }).trim(), '13')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-ch-win-'))
  const recorderDir = path.join(home, 'local/tangu-computer-use/recorder')
  const recorderPids = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `ConvertTo-Json -Compress -InputObject @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith('${recorderDir.replace(/'/g, "''")}\\', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.Id })`], { encoding: 'utf8', windowsHide: true }))
  // Exclude every current window owner; this probe checks IPC/lifecycle, not personal desktop contents.
  const apps = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', 'ConvertTo-Json -Compress -InputObject @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.ProcessName.ToLowerInvariant() + ".exe" } | Sort-Object -Unique)'], { encoding: 'utf8', windowsHide: true }))
  assert.ok(apps.length < 190, 'Window-owner exclusions fit the recorder policy')
  const stub = await startStubEngine()
  let app
  const results = []
  const check = (name, ok) => { results.push({ name, ok: !!ok }); assert.ok(ok, name); console.log(`PASS ${name}`) }
  try {
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, LOCALAPPDATA: path.join(home, 'local'), USERDOMAIN: path.basename(home) } })
    const win = await app.firstWindow()
    check('Onboarding dismissed', await skipOnboarding(win))
    await win.waitForFunction(() => !document.getElementById('tangu-splash'), null, { timeout: 20000 })
    check('Windows default off', (await win.evaluate(() => window.tangu.computerHistory.get())).state.status === 'off')
    check('App Dock IPC gated', (await win.evaluate(() => window.tangu.appDockOpen())).error === 'unsupported_platform')
    await win.keyboard.press('Control+k')
    await win.locator('.cmd-input').waitFor()
    for (const query of ['把对话贴到应用旁边', 'Dock a chat']) {
      await win.locator('.cmd-input').fill(query)
      await sleep(150)
      const commands = await win.locator('.cmd-item').evaluateAll(xs => xs.map(x => x.dataset.commandId))
      check(`App Dock command absent: ${query}`, commands.every(id => !/dock/i.test(id)))
    }
    await win.keyboard.press('Escape')
    await win.evaluate(apps => window.tangu.computerHistory.setExclude({ apps, domains: [] }), [...apps, 'electron.exe', 'powershell.exe', 'pwsh.exe'])
    const opened = app.waitForEvent('window', { timeout: 10000 })
    await win.getByRole('button', { name: '设置', exact: true }).click()
    const settings = await opened
    await settings.locator('.settings-nav').getByRole('button', { name: '电脑历史', exact: true }).click()
    await settings.locator('.ch-page').waitFor()
    await settings.locator('.ch-page [role="switch"]').first().click()
    check('Consent required', await settings.locator('.ch-confirm--consent').isVisible())
    await settings.locator('.ch-confirm--consent button').last().click()
    check('Actual recorder connected', await until(async () => (await win.evaluate(() => window.tangu.computerHistory.get())).state.status === 'recording'))
    check('Private recorder process exists', recorderPids().length === 1)
    check('Windows has no permission card', await settings.locator('.ch-permission').count() === 0)
    await settings.screenshot({ path: path.join(OUT, 'recording.png') })
    // Use actual displays when available: moving the owned test window changes its real OS scale.
    const displays = await app.evaluate(({ screen }) => screen.getAllDisplays().map(d => ({ scale: d.scaleFactor, area: d.workArea })))
    const bw = await app.browserWindow(settings)
    for (const d of displays) {
      await bw.evaluate((w, area) => w.setBounds({ x: area.x + 25, y: area.y + 25, width: Math.min(1000, area.width - 50), height: Math.min(850, area.height - 50) }), d.area)
      check(`Settings uses actual display scale ${d.scale}`, await until(async () => Math.abs(await settings.evaluate(() => devicePixelRatio) - d.scale) < .02))
      const fits = await settings.evaluate(() => { const e = document.querySelector('.ch-page'); return e.scrollWidth <= e.clientWidth + 1 })
      check(`Settings fits display scale ${d.scale}`, fits)
      await settings.screenshot({ path: path.join(OUT, `display-${d.scale}.png`) })
    }
    await win.evaluate(() => window.tangu.computerHistory.clear({ all: true }))
    check('Clear returns without a stuck operation', (await win.evaluate(() => window.tangu.computerHistory.get())).state.status === 'recording')
    await win.evaluate(() => window.tangu.computerHistory.setEnabled(false))
    check('Disable switches off', (await win.evaluate(() => window.tangu.computerHistory.get())).state.status === 'off')
    check('Recorder exits after its last subscriber disconnects', await until(() => recorderPids().length === 0, 75000, 1000))
  } finally {
    if (app) {
      for (const p of app.windows()) await p.screenshot({ path: path.join(OUT, `last-${app.windows().indexOf(p)}.png`) }).catch(() => {})
      await app.close()
    }
    await stub.close()
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))
  }
  console.log(`${results.length} passed`)
}
main().catch(e => { console.error(e); process.exitCode = 1 })
