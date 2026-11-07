/** One-off production updater acceptance on a disposable GitHub-hosted Windows VM. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { extractFile, uncache } = require('@electron/asar')
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
const sanitized = error => String(error).replace(/https?:\/\/[^\s"'<>]+/g, '[URL redacted]')

async function until(label, read, timeout, interval = 300) {
  const end = Date.now() + timeout
  do {
    const value = await read()
    if (value) return value
    await sleep(interval)
  } while (Date.now() < end)
  throw new Error('Timed out: ' + label)
}

function installSnapshot(exe, installer, oldPid, readSetup) {
  const source = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $exe = $env:FORSION_UPDATE_TEST_EXE
    $installer = $env:FORSION_UPDATE_TEST_INSTALLER
    $installerName = [IO.Path]::GetFileName($installer)
    $observed = @(Get-CimInstance Win32_Process -Filter "Name = 'Forsion.exe' OR Name = '$installerName' OR Name = 'explorer.exe'")
    $processes = @($observed | Where-Object {
      $_.ExecutablePath -eq $installer -or ($_.ExecutablePath -eq $exe -and $_.CommandLine -notmatch '--type=')
    } | ForEach-Object {
      $win = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
      @{pid=$_.ProcessId; parentPid=$_.ParentProcessId; exe=$_.ExecutablePath; old=($_.ProcessId -eq ${oldPid});
        installer=($_.ExecutablePath -eq $installer); updatedFlag=($_.CommandLine -match '--updated'); forceRun=($_.CommandLine -match '--force-run');
        hasWindow=([long]$win.MainWindowHandle -ne 0); windowTitle=$win.MainWindowTitle; session=$_.SessionId;
        cpuSeconds=if ($_.ExecutablePath -eq $installer) {[Math]::Floor([double]$win.CPU)} else {$null}}
    })
    $explorerSessions = @($observed | Where-Object Name -eq 'explorer.exe' | Select-Object -ExpandProperty SessionId)
    $setup = @()
    if ($env:FORSION_UPDATE_READ_SETUP -eq '1') {
      $ownedSetup = $processes | Where-Object installer
      if ($ownedSetup) {
        Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
        $all = @(Get-CimInstance Win32_Process)
        $owners = [Collections.Generic.HashSet[int]]::new()
        $null = $owners.Add([int]$ownedSetup.pid)
        do {
          $previous = $owners.Count
          foreach ($child in $all) {
            if ($owners.Contains([int]$child.ParentProcessId)) { $null = $owners.Add([int]$child.ProcessId) }
          }
        } while ($owners.Count -ne $previous)
        foreach ($pidValue in $owners) {
          try {
            $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $pidValue)
            $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
            foreach ($window in $windows) {
              $nodes = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
              $text = @($window.Current.Name)
              foreach ($node in $nodes) {
                if ($node.Current.Name) { $text += $node.Current.Name }
                $pattern = $null
                if ($node.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$pattern)) {
                  $text += "Progress: $($pattern.Current.Value) / $($pattern.Current.Maximum)"
                }
              }
              $setup += @{pid=$pidValue; window=$window.Current.Name; text=@($text | Select-Object -Unique -Last 45)}
            }
          } catch { $setup += @{pid=$pidValue; error=$_.Exception.GetType().Name} }
        }
      }
    }
    @{processes=$processes; explorerSessions=$explorerSessions; setup=$setup} | ConvertTo-Json -Depth 7 -Compress
  `
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
    env: { ...process.env, FORSION_UPDATE_TEST_EXE: exe, FORSION_UPDATE_TEST_INSTALLER: installer, FORSION_UPDATE_READ_SETUP: readSetup ? '1' : '0' },
    windowsHide: true, encoding: 'utf8', timeout: 15000,
  }).trim()
  )
}

function startupReceipt(version) {
  const dir = path.join(os.homedir(), '.forsion', 'activity')
  if (!fs.existsSync(dir)) return null
  const suffix = ` app.start v=${version}`
  for (const file of fs.readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}\.log$/.test(name))) {
    const line = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/).find(row => row.endsWith(suffix))
    if (line) return line
  }
  return null
}

function websiteTransfer(file) {
  const { events, constants: { logEventTypes: types } } = readJson(file)
  const route = []
  let url = website + '/download/windows'
  for (let hop = 0; hop < 8; hop++) {
    const index = events.findIndex(event => event.type === types.URL_REQUEST_START_JOB && event.params?.method === 'GET' && event.params.url === url)
    assert.ok(index >= 0, 'No GET for a route or redirect issued by the website')
    const id = events[index].source.id
    const leg = []
    for (const event of events.slice(index + 1)) {
      if (event.source.id !== id) continue
      if (event.type === types.URL_REQUEST_START_JOB && event.params?.url) break
      leg.push(event)
    }
    const headers = leg.find(event => event.type === types.HTTP_TRANSACTION_READ_RESPONSE_HEADERS)?.params?.headers
    const status = Number(headers?.[0]?.match(/^HTTP\/\S+ (\d+)/)?.[1])
    const transferred = leg.filter(event => event.type === types.URL_REQUEST_JOB_FILTERED_BYTES_READ)
      .reduce((sum, event) => sum + event.params.byte_count, 0)
    route.push({ host: new URL(url).hostname, status, bytes: transferred })
    if (status === 200) {
      assert.equal(transferred, bytes, 'Website redirect chain must deliver the complete installer')
      return route
    }
    assert.ok(status >= 300 && status < 400, 'Website download leg must redirect or serve the installer')
    const location = headers.find(header => /^location:/i.test(header))?.slice('location:'.length).trim()
    assert.ok(location, 'Website redirect must identify the next request')
    url = new URL(location, url).href
  }
  throw new Error('Website installer redirected too many times')
}

async function main() {
  assert.ok(process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted')
  const root = path.join(process.env.RUNNER_TEMP, 'forsion-website-upgrade')
  const exe = path.join(root, 'application', 'Forsion.exe')
  assert.equal(process.env.FORSION_UPDATE_TEST_ROOT, root)
  assert.equal(process.env.FORSION_UPDATE_TEST_EXE, exe)
  const out = path.join(root, 'evidence')
  const rawNetLog = path.join(root, 'netlog-private.json')
  const asar = path.join(path.dirname(exe), 'resources', 'app.asar')
  const cacheName = /^updaterCacheDirName:\s*['"]?([\w.-]+)['"]?\s*$/m
    .exec(fs.readFileSync(path.join(path.dirname(asar), 'app-update.yml'), 'utf8'))?.[1]
  assert.ok(cacheName && cacheName !== '.' && cacheName !== '..', 'Updater cache must be an app-specific child directory')
  const pending = path.join(process.env.LOCALAPPDATA, cacheName, 'pending')
  check(!fs.existsSync(pending), 'fresh update cache before the installed app starts')
  const config = await fetch(website + '/config', { signal: AbortSignal.timeout(20000) })
  assert.equal(config.status, 200)
  const { available, filename: servedFile, version, size, sha512: checksum } = (await config.json()).platforms.windows
  const meta = { available, filename: servedFile, version, size, sha512: checksum }
  check(meta.available && meta.filename === filename && meta.version === newVersion && meta.size === bytes && meta.sha512 === sha512, 'live website returns the exact target and its verified SHA-512')
  check(!startupReceipt(newVersion) && !process.env.TANGU_HOME, 'disposable Windows user has no target-version startup receipt')

  let app, child, win, settings, logging, runtime, statuses = [], updated
  const screenshot = (page, name) => page.screenshot({ path: path.join(out, name), timeout: 10000 })
  const status = () => settings.evaluate(() => window.tangu.getUpdaterStatus())
  try {
    app = await electron.launch({
      executablePath: exe,
      args: ['--lang=en-US'],
      timeout: 60000,
    })
    child = app.process()
    runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), exe: process.execPath, pid: process.pid }))
    check(runtime.packaged && runtime.version === oldVersion && path.resolve(runtime.exe).toLowerCase() === exe.toLowerCase(), '2.13.6 is running from the genuine NSIS installation')
    win = await app.firstWindow()
    check(await skipOnboarding(win, 45000), 'old installed app reaches the main UI')

    await win.evaluate(() => window.tangu.openFloatingPanel({
      id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'about', nonce: Date.now() },
    }))
    settings = await until('Settings → About', async () => {
      for (const page of app.windows()) if (await page.getByTestId('about-update-source').isVisible().catch(() => false)) return page
      return null
    }, 25000)
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
      if (current.phase === 'error' || current.source === 'github') throw new Error('Website download failed or switched away: ' + sanitized(current.error ?? current.source))
      return current.phase === 'downloaded' && current.source === 'website' && current.version === newVersion
    }, 480000)
    await restart.waitFor({ timeout: 10000 })
    const downloadedCaption = await settings.locator('.upd-src').filter({ hasText: 'forsion.net' }).first().innerText()
    check(/Downloaded from|校验通过/i.test(downloadedCaption), 'installed UI reports completed and verified website download')
    await screenshot(settings, 'website-downloaded.png')
    statuses = await settings.evaluate(() => window.__upgradeStatuses)
    check(!statuses.some(s => s.fallbackFrom || (['downloading', 'downloaded'].includes(s.phase) && s.source !== 'website')), 'download history stays on the website source')
    await app.evaluate(({ netLog }) => netLog.stopLogging())
    logging = false
    // Chromium's private log may contain signed storage URLs. Export only the
    // exact public route and method, never the raw NetLog or redirect URLs.
    const route = websiteTransfer(rawNetLog)
    check(route.length > 0, 'the real website GET and its redirect chain delivered the entire installer')
    const cached = readJson(path.join(pending, 'update-info.json'))
    assert.equal(cached.sha512, sha512)
    assert.equal(cached.fileName, filename)
    const installer = path.join(pending, filename)
    const hash512 = createHash('sha512'), hash256 = createHash('sha256')
    assert.equal(fs.statSync(installer).size, bytes)
    for await (const chunk of fs.createReadStream(installer)) { hash512.update(chunk); hash256.update(chunk) }
    check(hash512.digest('base64') === sha512 && hash256.digest('hex') === sha256, 'real downloaded EXE matches the website SHA-512 and official release SHA-256')
    const receipt = { runtime, meta, availableCaption, downloadedCaption, statuses, download: { method: 'GET', url: website + '/download/windows', route, bytes, sha512, sha256 } }
    const write = extra => fs.writeFileSync(path.join(out, 'upgrade-receipt.json'), JSON.stringify({ ...receipt, ...extra }, null, 2))
    write({ phase: 'downloaded' })
    const snapshots = []
    let lastSetupRead = 0
    const diagnose = () => {
      let version = null
      try {
        // The NSIS updater overwrites the archive at the same path.
        uncache(asar)
        version = JSON.parse(extractFile(asar, 'package.json').toString('utf8')).version
      } catch { /* NSIS is still replacing the archive. */ }
      const activity = startupReceipt(newVersion)
      const readSetup = Date.now() - lastSetupRead >= 15000
      if (readSetup) lastSetupRead = Date.now()
      let observed
      try { observed = installSnapshot(exe, installer, runtime.pid, readSetup) } catch (error) {
        console.log('Restart observation unavailable:', sanitized(error.message))
        return null
      }
      const { processes, explorerSessions, setup } = observed
      for (const window of setup) if (window.text) window.text = window.text.map(sanitized)
      const state = { oldExit: child.exitCode, oldSignal: child.signalCode, version, activity, processes, explorerSessions, setup }
      const last = snapshots.at(-1)
      if (!last || JSON.stringify(last.state) !== JSON.stringify(state)) {
        snapshots.push({ at: new Date().toISOString(), state })
        fs.writeFileSync(path.join(out, 'restart-diagnostics.json'), JSON.stringify(snapshots, null, 2))
        console.log('Restart state:', JSON.stringify(state))
      }
      const relaunched = processes.find(p => !p.old && !p.installer && p.hasWindow && p.updatedFlag)
      return child.exitCode === 0 && !processes.some(p => p.installer) && version === newVersion && activity && relaunched && { ...relaunched, version, activity }
    }
    diagnose()
    await restart.click().catch(error => {
      if (!/closed/i.test(String(error))) throw error
    })
    console.log('Clicked the real Restart & install button')
    updated = await until('the installer replaces app.asar and launches the new main window', diagnose, 420000, 2000)
    check(updated.pid !== runtime.pid && updated.exe.toLowerCase() === exe.toLowerCase(), 'NSIS replaced the original installation and automatically relaunched 2.13.7')
    write({ phase: 'relaunched', updated })
  } catch (error) {
    const page = settings ?? win
    let current
    try {
      if (page && !page.isClosed()) {
        await screenshot(page, 'failure.png')
        current = settings && await status()
      }
    } catch { /* The old target is expected to disappear during restart. */ }
    const { phase, source, version, error: reason } = current ?? {}
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ runtime, current: { phase, source, version, reason: reason && sanitized(reason) }, error: sanitized(error.stack ?? error), statuses }, null, 2))
    throw error
  } finally {
    if (app && child?.exitCode === null && child.signalCode === null) {
      if (logging) await app.evaluate(({ netLog }) => netLog.stopLogging()).catch(() => {})
      await Promise.race([app.close().catch(() => {}), sleep(10000)])
    }
  }
}

main().then(() => process.exit(0), error => { console.error(sanitized(error)); process.exit(1) })
