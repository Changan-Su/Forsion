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
  const ownRows = sessions => sessions.filter(s => JSON.stringify(s).toLowerCase().includes('forsion, 中文验收.exe'))
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
    target = await electron.launch({ executablePath: exe, args: ['--force-renderer-accessibility', `--user-data-dir=${path.join(home, 'target-data')}`, fixture] })
    await target.firstWindow()
    fs.writeFileSync(path.join(home, 'runtime.json'), JSON.stringify({ pid: await app.evaluate(() => process.pid), targetPid: await target.evaluate(() => process.pid), exe: path.basename(exe), excludedCount: excluded.length }, null, 2))
    console.log('STAGE_HOME ' + home)
    while (!fs.existsSync(path.join(home, 'stop'))) {
      const file = path.join(home, 'command.json')
      if (fs.existsSync(file)) {
        const cmd = JSON.parse(fs.readFileSync(file, 'utf8')); fs.unlinkSync(file)
        if (typeof cmd.exclude === 'boolean') await win.evaluate(apps => window.tangu.computerHistory.setExclude({ apps, domains: [] }), [...excluded, ...(cmd.exclude ? [path.basename(exe)] : [])])
        if (cmd.clear) await win.evaluate(() => window.tangu.computerHistory.clear({ all: true }))
        await sleep(1200)
        const rows = ownRows(await win.evaluate(() => window.tangu.computerHistory.recent(1)))
        const state = (await win.evaluate(() => window.tangu.computerHistory.get())).state
        fs.writeFileSync(path.join(home, 'receipt.json'), JSON.stringify({ at: Date.now(), state, rows }, null, 2))
      }
      await sleep(150)
    }
  } finally {
    if (win) await win.evaluate(async () => { await window.tangu.computerHistory.setEnabled(false); await window.tangu.appRefs?.setGlobalHotkey?.('') }).catch(() => {})
    await target?.close().catch(() => {}); await app?.close().catch(() => {}); await stub.close()
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
