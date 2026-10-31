/** Isolated recorder + real portable target with comma/Chinese executable name.
 * Native input is supplied only by the user/Sky. Existing window owners are
 * excluded before recording. Stop by creating <STAGE_HOME>/stop.
 */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { execFileSync } = require('node:child_process')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..'), sleep = ms => new Promise(r => setTimeout(r, ms))
function fixtureRows(sessions, browserUrl) {
  const fixture = new URL(browserUrl)
  return sessions.filter(s => {
    const owner = s.bundleId?.toLowerCase()
    if (owner === 'forsion, 中文验收.exe') return s.title === 'Forsion history comma Chinese acceptance'
    if (!['chrome.exe', 'msedge.exe'].includes(owner)) return false
    if (s.url) {
      try { const url = new URL(s.url); return url.origin === fixture.origin && url.pathname === fixture.pathname }
      catch { return false }
    }
    return s.title?.startsWith('Forsion browser history acceptance') === true
  })
}
function exclusionPolicy(base, allowApps, excludeTarget, exe) {
  if (allowApps.some(name => !['chrome.exe', 'msedge.exe', 'notepad.exe'].includes(name))) throw Error('Only explicit browser/Notepad test owners may be allowed')
  return [...base.filter(name => !allowApps.includes(name)), ...(excludeTarget ? [exe] : [])]
}
async function main() {
  if (process.platform !== 'win32') throw Error('Windows only')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-history-native-')), userData = path.join(home, 'userdata')
  const apps = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ConvertTo-Json -Compress -InputObject @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.ProcessName.ToLowerInvariant() + ".exe" } | Sort-Object -Unique)'], { encoding: 'utf8', windowsHide: true }))
  const excluded = [...new Set([...apps, 'electron.exe', 'powershell.exe', 'pwsh.exe'])]
  if (excluded.length >= 190) throw Error('Too many window owners to exclude safely')
  const runtime = path.join(home, 'runtime'); fs.cpSync(path.dirname(require('electron')), runtime, { recursive: true })
  const exe = path.join(runtime, 'Forsion, 中文验收.exe'); fs.renameSync(path.join(runtime, 'electron.exe'), exe)
  const fixture = path.join(home, 'target'); fs.mkdirSync(fixture)
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ main: 'main.cjs', name: 'history-native-target' }))
  fs.writeFileSync(path.join(fixture, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(async()=>{const w=new BrowserWindow({x:80,y:120,width:600,height:420,title:'Forsion history comma Chinese acceptance'});await w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<title>Forsion history comma Chinese acceptance</title><body style="font:22px sans-serif;padding:20px"><p>Isolated native input acceptance</p><label>Test text<input id="plain" style="display:block;width:90%;font:24px sans-serif" autofocus></label><p><label>Fake password<input id="secret" type="password" style="display:block;width:90%;font:24px sans-serif"></label>'))});app.on('window-all-closed',()=>app.quit())`)
  const stub = await startStubEngine(); let app, target, win
  const browserServer = require('node:http').createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>Forsion browser history acceptance</title><body style="font:24px sans-serif;padding:30px"><h1>Forsion browser history acceptance</h1><label>Test text <input id="plain" style="font:24px sans-serif;width:90%"></label><p>Local disposable fixture. No form submission.</p>')
  })
  await new Promise(resolve => browserServer.listen(0, '127.0.0.1', resolve))
  const browserUrl = `http://127.0.0.1:${browserServer.address().port}/`
  let allowApps = [], excludeTarget = false
  try {
    for (const d of [userData, userData + '-dev']) {
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'fixture', modelId: 'm1' }))
    }
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, LOCALAPPDATA: path.join(home, 'local'), USERDOMAIN: path.basename(home), TANGU_HARNESS_QUIET: '1' } })
    win = await app.firstWindow(); if (!await skipOnboarding(win)) throw Error('Onboarding did not close')
    await win.evaluate(apps => window.tangu.computerHistory.setExclude({ apps, domains: [] }), excluded)
    const opened = app.waitForEvent('window')
    await win.getByRole('button', { name: '设置', exact: true }).click(); const settings = await opened
    await settings.locator('.settings-nav').getByRole('button', { name: '电脑历史', exact: true }).click()
    await settings.locator('.ch-page [role="switch"]').first().click()
    await settings.locator('.ch-confirm--consent button').last().click()
    await settings.locator('.ch-page[data-ch-status="recording"]').waitFor({ timeout: 20000 })
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.hide() })
    if (process.env.HISTORY_BROWSER_ONLY !== '1') {
      target = await electron.launch({ executablePath: exe, args: ['--force-renderer-accessibility', `--user-data-dir=${path.join(home, 'target-data')}`, fixture] })
      await target.firstWindow()
    }
    fs.writeFileSync(path.join(home, 'runtime.json'), JSON.stringify({ pid: await app.evaluate(() => process.pid), targetPid: target ? await target.evaluate(() => process.pid) : null, exe: path.basename(exe), excludedCount: excluded.length, browserUrl }, null, 2))
    console.log('STAGE_HOME ' + home)
    console.log('BROWSER_URL ' + browserUrl)
    while (!fs.existsSync(path.join(home, 'stop'))) {
      const file = path.join(home, 'command.json')
      if (fs.existsSync(file)) {
        const cmd = JSON.parse(fs.readFileSync(file, 'utf8')); fs.unlinkSync(file)
        if (Array.isArray(cmd.allowApps)) {
          // Validate before changing the active command state.
          exclusionPolicy(excluded, cmd.allowApps, excludeTarget, path.basename(exe))
          allowApps = cmd.allowApps
        }
        if (typeof cmd.exclude === 'boolean') excludeTarget = cmd.exclude
        if (Array.isArray(cmd.allowApps) || typeof cmd.exclude === 'boolean') await win.evaluate(apps => window.tangu.computerHistory.setExclude({ apps, domains: [] }), exclusionPolicy(excluded, allowApps, excludeTarget, path.basename(exe)))
        if (cmd.clear) await win.evaluate(() => window.tangu.computerHistory.clear({ all: true }))
        await sleep(1200)
        const rows = fixtureRows(await win.evaluate(() => window.tangu.computerHistory.recent(1)), browserUrl)
        const state = (await win.evaluate(() => window.tangu.computerHistory.get())).state
        fs.writeFileSync(path.join(home, 'receipt.json'), JSON.stringify({ requestId: cmd.id || null, at: Date.now(), state, rows }, null, 2))
      }
      await sleep(150)
    }
  } finally {
    if (win) await win.evaluate(async () => { await window.tangu.computerHistory.setEnabled(false); await window.tangu.appRefs?.setGlobalHotkey?.('') }).catch(() => {})
    await target?.close().catch(() => {}); await app?.close().catch(() => {}); await stub.close(); await new Promise(resolve => browserServer.close(resolve))
  }
}
if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1 })
module.exports = { fixtureRows, exclusionPolicy }
