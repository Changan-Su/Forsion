/** One-off production updater acceptance on a disposable GitHub-hosted Windows VM. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { extractFile } = require('@electron/asar')
const electron = require('./lib/launch-electron.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const oldVersion = '2.13.6'
const newVersion = '2.13.7'
const filename = 'Forsion-2.13.7-x64.exe'
const bytes = 461841453
const sha512 = 'L6xNl/Mx7ZDlRElNMjM45n4XavlxJQNtZqeXAdcINguLVixsr6LOhBL2Sf68hqIDbEAvldhqCds4zd4BoT78HQ=='
const sha256 = 'ee40d0c73b07ea0ea2a49675df979a2c7b1a764ed89f8e06c60e8b03871298b0'
const website = 'https://forsion.net/api/website'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const check = (condition, name) => { assert.ok(condition, name); console.log('PASS ' + name) }
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))

async function until(label, read, timeout) {
  const end = Date.now() + timeout
  do {
    const value = await read()
    if (value) return value
    await sleep(300)
  } while (Date.now() < end)
  throw new Error('Timed out: ' + label)
}

function relaunchedProcess(exe, oldPid) {
  const source = `
    $ErrorActionPreference = 'Stop'
    $owner = Get-CimInstance Win32_Process -Filter "Name = 'Forsion.exe'" | Where-Object {
      $_.ExecutablePath -eq $env:FORSION_UPDATE_TEST_EXE -and $_.ProcessId -ne ${oldPid} -and $_.CommandLine -notmatch '--type='
    } | Where-Object { [long](Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($owner) { @{pid=$owner.ProcessId; exe=$owner.ExecutablePath} | ConvertTo-Json -Compress }
  `
  const json = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
    env: { ...process.env, FORSION_UPDATE_TEST_EXE: exe }, windowsHide: true, encoding: 'utf8', timeout: 12000,
  }).trim()
  return json ? JSON.parse(json) : null
}

async function main() {
  assert.ok(process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted')
  const root = path.join(process.env.RUNNER_TEMP, 'forsion-website-upgrade')
  const exe = path.join(root, 'application', 'Forsion.exe')
  assert.equal(process.env.FORSION_UPDATE_TEST_ROOT, root)
  assert.equal(process.env.FORSION_UPDATE_TEST_EXE, exe)
  const out = path.join(root, 'evidence')
  const rawNetLog = path.join(root, 'netlog-private.json')
  const home = path.join(root, 'profile')
  const asar = path.join(path.dirname(exe), 'resources', 'app.asar')
  const cacheName = /^updaterCacheDirName:\s*['"]?([\w.-]+)['"]?\s*$/m
    .exec(fs.readFileSync(path.join(path.dirname(asar), 'app-update.yml'), 'utf8'))?.[1]
  assert.ok(cacheName && cacheName !== '.' && cacheName !== '..', 'Updater cache must be an app-specific child directory')
  const pending = path.join(process.env.LOCALAPPDATA, cacheName, 'pending')
  check(!fs.existsSync(pending), 'fresh update cache before the installed app starts')
  const config = await fetch(website + '/config', { signal: AbortSignal.timeout(20000) })
  assert.equal(config.status, 200)
  const meta = (await config.json()).platforms.windows
  check(meta.available && meta.filename === filename && meta.version === newVersion && meta.size === bytes && meta.sha512 === sha512, 'live website returns the exact target and its verified SHA-512')

  let app, win, settings, logging, runtime, statuses = [], updated
  const screenshot = (page, name) => page.screenshot({ path: path.join(out, name), timeout: 10000 })
  const status = () => settings.evaluate(() => window.tangu.getUpdaterStatus())
  try {
    app = await electron.launch({
      executablePath: exe,
      args: ['--lang=en-US'],
      env: { ...process.env, TANGU_HOME: home, FORSION_WORKSPACE_DIR: path.join(root, 'workspace') },
      timeout: 60000,
    })
    runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), exe: process.execPath, pid: process.pid }))
    check(runtime.packaged && runtime.version === oldVersion && path.resolve(runtime.exe).toLowerCase() === exe.toLowerCase(), '2.13.6 is running from the genuine NSIS installation')
    win = await app.firstWindow()
    check(await skipOnboarding(win, 45000), 'old installed app reaches the main UI')

    const opened = app.waitForEvent('window', { timeout: 15000 })
    await win.locator('.rb-btn[aria-label="Settings"],.rb-btn[aria-label="设置"]').first().click()
    settings = await opened
    await settings.getByText(/^(About|关于)$/).first().click()
    const source = settings.getByTestId('about-update-source')
    check(await source.getByRole('button', { name: /^(Auto|Automatic|自动)$/ }).getAttribute('aria-pressed') === 'true', 'fresh install defaults to automatic source')
    await source.getByRole('button', { name: /^(Website|官网)$/ }).click()
    await until('website source saved', async () => await settings.evaluate(() => window.tangu.getUpdateSource()) === 'website', 10000)
    await app.evaluate(({ netLog }, file) => netLog.startLogging(file), rawNetLog)
    logging = true
    await settings.evaluate(() => {
      window.__upgradeStatuses = []
      window.tangu.onUpdaterStatus(s => window.__upgradeStatuses.push({ phase: s.phase, source: s.source, version: s.version, transferred: s.transferred, fallbackFrom: s.fallbackFrom }))
      return window.tangu.checkForUpdates()
    })
    const download = settings.getByRole('button', { name: /^(Download update|下载更新)$/ })
    await download.waitFor({ timeout: 25000 })
    const offer = await status()
    check(offer.phase === 'available' && offer.source === 'website' && offer.version === newVersion && offer.size === bytes, 'installed updater offers 2.13.7 from forsion.net')
    const availableCaption = await settings.locator('.upd-src').filter({ hasText: 'forsion.net' }).first().innerText()
    await screenshot(settings, 'website-available.png')
    await download.click()
    const restart = settings.getByRole('button', { name: /^(Restart & install|重启并安装)$/ })
    await until('actual website download and validation', async () => {
      const current = await status()
      if (current.phase === 'error' || current.source === 'github') throw new Error('Website download failed or switched away: ' + JSON.stringify(current))
      return current.phase === 'downloaded' && current.source === 'website' && current.version === newVersion
    }, 480000)
    await restart.waitFor({ timeout: 10000 })
    const downloadedCaption = await settings.locator('.upd-src').filter({ hasText: 'forsion.net' }).first().innerText()
    check(/Downloaded from|校验通过/i.test(downloadedCaption), 'installed UI reports completed and verified website download')
    await screenshot(settings, 'website-downloaded.png')
    statuses = await settings.evaluate(() => window.__upgradeStatuses)
    await app.evaluate(({ netLog }) => netLog.stopLogging())
    logging = false
    // Chromium's private log may contain signed storage URLs. Export only the
    // exact public route and method, never the raw NetLog or redirect URLs.
    const requests = readJson(rawNetLog).events.filter(event =>
      event.params?.url === website + '/download/windows' && event.params?.method === 'GET')
    check(requests.length > 0, 'actual Electron GET used the public website download route')
    const cached = readJson(path.join(pending, 'update-info.json'))
    assert.equal(cached.sha512, sha512)
    assert.equal(cached.fileName, filename)
    const installer = path.join(pending, filename)
    const hash512 = createHash('sha512'), hash256 = createHash('sha256')
    assert.equal(fs.statSync(installer).size, bytes)
    for await (const chunk of fs.createReadStream(installer)) { hash512.update(chunk); hash256.update(chunk) }
    check(hash512.digest('base64') === sha512 && hash256.digest('hex') === sha256, 'real downloaded EXE matches the website SHA-512 and official release SHA-256')
    const receipt = { runtime, meta, availableCaption, downloadedCaption, statuses, download: { method: 'GET', url: website + '/download/windows', requests: requests.length, bytes, sha512, sha256 } }
    const write = extra => fs.writeFileSync(path.join(out, 'upgrade-receipt.json'), JSON.stringify({ ...receipt, ...extra }, null, 2))
    write({ phase: 'downloaded' })
    await restart.click()
    console.log('Clicked the real Restart & install button')
    await until('old app exits after requesting installation', () => app.process().exitCode !== null, 60000)
    updated = await until('the installer replaces app.asar and launches the new main window', () => {
      let version
      try { version = JSON.parse(extractFile(asar, 'package.json').toString('utf8')).version } catch { return null }
      if (version !== newVersion) return null
      const process = relaunchedProcess(exe, runtime.pid)
      return process && { ...process, version }
    }, 180000)
    check(updated.pid !== runtime.pid && updated.exe.toLowerCase() === exe.toLowerCase(), 'NSIS replaced the original installation and automatically relaunched 2.13.7')
    write({ phase: 'relaunched', updated })
  } catch (error) {
    const page = settings ?? win
    if (page && !page.isClosed()) {
      await screenshot(page, 'failure.png').catch(() => {})
      const current = settings && await status().catch(() => null)
      fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ runtime, current, error: String(error), statuses }, null, 2))
    }
    throw error
  } finally {
    if (logging) await app.evaluate(({ netLog }) => netLog.stopLogging()).catch(() => {})
    if (app && app.process().exitCode === null) await Promise.race([app.close().catch(() => {}), sleep(10000)])
  }
}

main().then(() => process.exit(0), error => { console.error(error); process.exit(1) })
