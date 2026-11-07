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
const { startUpdateProxy } = require('./lib/windows-update-network.cjs')

const oldVersion = '2.13.6'
const newVersion = '2.13.7'
const standard = {
  filename: 'Forsion-2.13.7-x64.exe', bytes: 461841453,
  sha512: 'L6xNl/Mx7ZDlRElNMjM45n4XavlxJQNtZqeXAdcINguLVixsr6LOhBL2Sf68hqIDbEAvldhqCds4zd4BoT78HQ==',
  sha256: 'ee40d0c73b07ea0ea2a49675df979a2c7b1a764ed89f8e06c60e8b03871298b0',
}
const noExtend = {
  filename: 'Forsion-NoExtend-2.13.7-x64.exe', bytes: 461586927,
  sha512: 'mWNkAxI9LOXNf973gkS+2VxSWkehXWdA1xUXAgEmOB4xe6TMmBW/LJIOqWw0eWEa7KF2HG0dT55Wfbt7DiUrxg==',
  sha256: '52814c86bdc25264102153d3a5a9549888115d498d5b40b2495786c1dc8d37f6',
}
const website = 'https://forsion.net/api/website'
const releases = 'https://github.com/Changan-Su/Forsion/releases/download/v' + newVersion
const siteDownload = website + '/download/windows'
const scenario = process.env.FORSION_UPDATE_CASE
const scenarios = {
  'auto-overseas': { pref: 'auto', first: 'github', last: 'github', region: false },
  'auto-overseas-contract': { pref: 'auto', first: 'github', last: 'github', region: false, replayRegion: true },
  'auto-mainland': { pref: 'auto', first: 'website', last: 'website', region: true, replayRegion: true },
  'manual-website-github': { pref: 'website', first: 'website', last: 'github', action: 'throttle' },
  'manual-github-website': { pref: 'github', first: 'github', last: 'website', action: 'throttle' },
  'drop-website-github': { pref: 'website', first: 'website', last: 'github', action: 'drop' },
  'stall-github-website': { pref: 'github', first: 'github', last: 'website', action: 'stall' },
  'no-extend': { pref: 'website', first: 'github', last: 'github', noExtend: true },
  'offline-check': { pref: 'auto', offline: true },
}
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

function installerTransfer(file, startUrl, bytes, partial = false) {
  const { events, constants: { logEventTypes: types } } = readJson(file)
  const active = new Map()
  const legs = new Map()
  events.forEach((event, index) => {
    const id = event.source.id
    if (event.type === types.URL_REQUEST_START_JOB && event.params?.method === 'GET' && event.params.url) {
      const url = new URL(event.params.url).href
      const leg = { url, index, bytes: 0 }
      active.set(id, leg)
      if (!legs.has(url)) legs.set(url, [])
      legs.get(url).push(leg)
      return
    }
    const leg = active.get(id)
    if (!leg) return
    if (event.type === types.HTTP_TRANSACTION_READ_RESPONSE_HEADERS && !leg.headers) {
      leg.headers = event.params.headers
      leg.responseIndex = index
    }
    if (event.type === types.URL_REQUEST_JOB_FILTERED_BYTES_READ) leg.bytes += event.params.byte_count
  })
  function follow(leg, remaining) {
    const status = Number(leg.headers?.[0]?.match(/^HTTP\/\S+ (\d+)/)?.[1])
    const receipt = { host: new URL(leg.url).hostname, status, bytes: leg.bytes }
    if (partial ? (status === 200 || status === 206) && leg.bytes > 0 && leg.bytes < bytes : status === 200 && leg.bytes === bytes) return [receipt]
    if (!remaining || !(status >= 300 && status < 400)) return null
    const location = leg.headers.find(header => /^location:/i.test(header))?.slice('location:'.length).trim()
    if (!location) return null
    for (const next of legs.get(new URL(location, leg.url).href) ?? []) {
      if (next.index <= leg.responseIndex) continue
      const tail = follow(next, remaining - 1)
      if (tail) return [receipt, ...tail]
    }
    return null
  }
  const candidates = legs.get(startUrl) ?? []
  for (const leg of candidates) {
    const route = follow(leg, 7)
    if (route) return route
  }
  throw new Error(`No ${partial ? 'partial' : 'complete'} transfer followed the expected installer route (starts: ${candidates.map(l => l.headers?.[0] ?? 'no response').join(', ')})`)
}

async function deadline(task, label, timeout) {
  let timer
  try {
    return await Promise.race([task, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), timeout) })])
  } finally { clearTimeout(timer) }
}

async function main() {
  assert.ok(process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted')
  const spec = scenarios[scenario]
  assert.ok(spec, 'Select an installed-app matrix scenario')
  const regionFile = path.join(process.env.RUNNER_TEMP, 'forsion-update-region.json')
  const regionReceipt = fs.existsSync(regionFile) ? readJson(regionFile) : null
  const regionResponse = spec.replayRegion ? (spec.region ? { country: 'CN', mainland_china: true }
    : { country: regionReceipt?.backend?.mainland_china === false && regionReceipt.backend.country || 'US', mainland_china: false }) : null
  const { filename, bytes, sha512, sha256 } = spec.noExtend ? noExtend : standard
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
  check(meta.available && meta.filename === standard.filename && meta.version === newVersion && meta.size === standard.bytes && meta.sha512 === standard.sha512, 'live website publishes the standard installer and its verified SHA-512')
  check(!startupReceipt(newVersion) && !process.env.TANGU_HOME, 'disposable Windows user has no target-version startup receipt')
  const manifest = () => {
    uncache(asar)
    return JSON.parse(extractFile(asar, 'package.json').toString('utf8'))
  }

  let app, child, win, settings, logging, runtime, proxy, statuses = [], updated
  const screenshot = (page, name) => page.screenshot({ path: path.join(out, name), timeout: 10000 })
  const status = () => settings.evaluate(() => window.tangu.getUpdaterStatus())
  try {
    app = await electron.launch({
      executablePath: exe,
      args: ['--lang=en-US'],
      timeout: 60000,
    })
    child = app.process()
    if (regionResponse || spec.offline) await app.evaluate((_, options) => {
      const realFetch = globalThis.fetch
      const network = globalThis.__upgradeNetwork = { offline: options.offline, attempted: [], regionResponses: 0 }
      globalThis.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : String(input?.url ?? input)
        if (options.regionResponse && url === 'https://forsion.net/api/auth/region') {
          network.regionResponses++
          return Promise.resolve(Response.json(options.regionResponse))
        }
        if (network.offline && [options.siteConfig, options.githubLatest].includes(url)) {
          network.attempted.push(url)
          return Promise.reject(new TypeError('Simulated update endpoint unreachable'))
        }
        return realFetch(input, init)
      }
    }, {
      regionResponse, offline: spec.offline === true, siteConfig: website + '/config',
      githubLatest: 'https://api.github.com/repos/Changan-Su/Forsion/releases/latest',
    })
    runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), exe: process.execPath, pid: process.pid }))
    check(runtime.packaged && runtime.version === oldVersion && path.resolve(runtime.exe).toLowerCase() === exe.toLowerCase(), '2.13.6 is running from the genuine NSIS installation')
    check(manifest().forsionBundleExtend === !spec.noExtend, 'installed app manifest confirms the expected distribution')
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
    let region
    if (typeof spec.region === 'boolean') {
      region = await settings.evaluate(() => window.tangu.getUpdateRegion())
      assert.equal(region, spec.region, 'installed app classified the expected region')
      const regionText = region ? /currently detected in mainland China|识别为中国大陆/ : /currently detected outside mainland China|识别为海外/
      await source.getByText(regionText).waitFor({ timeout: 15000 })
      check(true, 'About shows the detected region while Auto is selected')
      if (regionResponse) check(await app.evaluate(() => globalThis.__upgradeNetwork.regionResponses) > 0, 'only the region response was replayed')
    }
    if (spec.pref !== 'auto') {
      await source.getByRole('button', { name: spec.pref === 'website' ? /^(Website|官网)$/ : /^GitHub$/ }).click()
      await until('source preference saved', async () => await settings.evaluate(() => window.tangu.getUpdateSource()) === spec.pref, 10000)
    }
    if (spec.action) {
      proxy = await startUpdateProxy(spec.first, spec.action)
      await app.evaluate(async ({ session }, url) => {
        const updater = session.fromPartition('electron-updater', { cache: false })
        await updater.setProxy({ mode: 'fixed_servers', proxyRules: url, proxyBypassRules: '<-loopback>' })
        await updater.closeAllConnections()
      }, proxy.url)
    }
    await app.evaluate(({ netLog }, file) => netLog.startLogging(file), rawNetLog)
    logging = true
    const checkUpdates = () => settings.evaluate(() => window.tangu.checkForUpdates())
    await settings.evaluate(() => {
      window.__upgradeStatuses = []
      window.tangu.onUpdaterStatus(s => window.__upgradeStatuses.push({ at: Date.now(), phase: s.phase, source: s.source, version: s.version, transferred: s.transferred, fallbackFrom: s.fallbackFrom }))
    })
    const checkStarted = Date.now()
    await deadline(checkUpdates(), 'check for updates', 25000)
    if (spec.offline) {
      const state = await status()
      check(state.phase === 'error' && state.error === 'unreachable' && Date.now() - checkStarted < 25000, 'both update checks unavailable gives a bounded error')
      await settings.getByText(/Could not reach the update server|连不上更新服务器/).first().waitFor({ timeout: 10000 })
      await screenshot(settings, 'offline-error.png')
      const attempted = await app.evaluate(() => {
        globalThis.__upgradeNetwork.offline = false
        return [...new Set(globalThis.__upgradeNetwork.attempted)]
      })
      check(attempted.length === 2, 'real updater tried website metadata and GitHub release metadata')
      await deadline(checkUpdates(), 'recover update check', 25000)
      const recovered = await status()
      check(recovered.phase === 'available' && recovered.version === newVersion, 'installed updater recovers after network restoration')
      fs.writeFileSync(path.join(out, 'upgrade-receipt.json'), JSON.stringify({ scenario, phase: 'recovered', runtime, attempted, recovered: { phase: recovered.phase, source: recovered.source, version: recovered.version } }, null, 2))
      return
    }
    const download = settings.getByRole('button', { name: /^(Download update|下载更新)$/ })
    await download.waitFor({ timeout: 25000 })
    const offer = await status()
    check(offer.phase === 'available' && offer.source === spec.first && offer.version === newVersion && offer.size === bytes, `installed updater offers 2.13.7 from ${spec.first}`)
    const display = src => src === 'website' ? 'forsion.net' : 'GitHub'
    const availableCaption = await settings.locator('.upd-src').filter({ hasText: display(spec.first) }).first().innerText()
    await screenshot(settings, 'available.png')
    await download.click()
    const history = () => settings.evaluate(() => window.__upgradeStatuses)
    let switchedAt, fallbackCaption
    if (spec.action) {
      await until('primary really transfers installer bytes', async () =>
        (await history()).some(s => s.phase === 'downloading' && s.source === spec.first && s.transferred > 0), 60000)
      if (spec.action === 'throttle') {
        const popup = win.locator('.wn-modal')
        if (!await popup.isVisible()) await settings.getByTestId('about-whats-new').click()
        const switchButton = popup.getByRole('button', { name: spec.last === 'github' ? /Use GitHub instead|换 GitHub/ : /Use the website instead|换官网/ })
        await switchButton.waitFor({ timeout: 10000 })
        await screenshot(win, 'manual-switch.png')
        switchedAt = Date.now()
        await switchButton.click()
      } else {
        const fallback = spec.last === 'github' ? /stalled, so it restarted from GitHub|已改从 GitHub/ : /stalled, so it restarted from the website|已改从官网/
        const banner = settings.locator('.upd-src').filter({ hasText: fallback }).first()
        await banner.waitFor({ timeout: 80000 })
        fallbackCaption = await banner.innerText()
        await screenshot(settings, 'automatic-fallback.png')
      }
    }
    const restart = settings.getByRole('button', { name: /^(Restart & install|重启并安装)$/ })
    await until('actual download and validation of the selected source', async () => {
      const current = await status()
      if (current.phase === 'error') throw new Error('Installed download failed: ' + sanitized(current.error))
      if (current.phase === 'downloaded') {
        check(current.source === spec.last && current.version === newVersion, `download completes from ${spec.last}`)
        return true
      }
      return false
    }, 480000)
    await restart.waitFor({ timeout: 10000 })
    const downloadedCaption = await settings.locator('.upd-src').filter({ hasText: display(spec.last) }).first().innerText()
    check(/Downloaded from|校验通过/i.test(downloadedCaption), 'installed UI reports completed and verified download')
    await screenshot(settings, 'downloaded.png')
    statuses = await history()
    const progress = statuses.filter(s => s.phase === 'downloading' || s.phase === 'downloaded')
    const sourceSequence = progress.map(s => s.source).filter((value, i, all) => i === 0 || value !== all[i - 1])
    assert.deepEqual(sourceSequence, spec.action ? [spec.first, spec.last] : [spec.last], 'exactly the expected download source sequence')
    const from = progress.find(s => s.source === spec.last && s.phase === 'downloading')
    const fault = proxy?.events.find(event => event.action === spec.action)
    if (spec.action === 'drop' || spec.action === 'stall') {
      check(fault && from?.fallbackFrom === spec.first && from.transferred === 0 && from.at >= fault.at, 'fault caused one automatic switch that restarted at zero')
      if (spec.action === 'stall') {
        const close = proxy.events.find(event => event.action === 'stalled-client-closed' && event.tunnel === fault.tunnel)
        check(close && close.at - fault.at >= 28000 && close.at <= from.at + 5000 && from.at - fault.at <= 60000, 'the updater canceled the held-open tunnel after about 30 seconds')
      }
    } else {
      check(!progress.some(s => s.fallbackFrom), 'no automatic fallback in this scenario')
      if (spec.action) check(from?.at >= switchedAt && from.transferred === 0, 'switch button restarts the alternate source at zero')
    }
    await app.evaluate(({ netLog }) => netLog.stopLogging())
    logging = false
    // Chromium's private log may contain signed storage URLs. Export only the
    // exact public route and method, never the raw NetLog or redirect URLs.
    const startUrl = spec.last === 'website' ? siteDownload : releases + '/' + filename
    const route = installerTransfer(rawNetLog, startUrl, bytes)
    check(route.length > 0, 'the real selected-source GET and its redirect chain delivered the entire installer')
    let partialRoute
    if (spec.action) {
      const primaryUrl = spec.first === 'website' ? siteDownload : releases + '/' + filename
      partialRoute = installerTransfer(rawNetLog, primaryUrl, bytes, true)
      check(proxy.events.some(event => event.action === 'throttled' && (!switchedAt || event.at < switchedAt)), 'the primary installer route was paced and transferred real bytes before switching')
    }
    if (spec.noExtend) {
      const urls = readJson(rawNetLog).events.map(e => e.params?.url).filter(url => typeof url === 'string')
      check(urls.some(url => url.startsWith(releases + '/latest-no-extend.yml')) &&
        !urls.some(url => url.startsWith(siteDownload) || url.startsWith(releases + '/latest.yml') || url.startsWith(releases + '/' + standard.filename)),
      'NoExtend uses the GitHub NoExtend feed and never requests the standard installer')
    }
    const cached = readJson(path.join(pending, 'update-info.json'))
    assert.equal(cached.sha512, sha512)
    assert.equal(cached.fileName, filename)
    const installer = path.join(pending, filename)
    const hash512 = createHash('sha512'), hash256 = createHash('sha256')
    assert.equal(fs.statSync(installer).size, bytes)
    for await (const chunk of fs.createReadStream(installer)) { hash512.update(chunk); hash256.update(chunk) }
    check(hash512.digest('base64') === sha512 && hash256.digest('hex') === sha256, 'downloaded EXE matches the selected official artifact digests')
    const receipt = { scenario, runtime, meta, region, regionResponse, regionReceipt, availableCaption, downloadedCaption, fallbackCaption, statuses, sourceSequence, fault, partialRoute, download: { method: 'GET', url: startUrl, route, bytes, sha512, sha256 } }
    const write = extra => fs.writeFileSync(path.join(out, 'upgrade-receipt.json'), JSON.stringify({ ...receipt, ...extra }, null, 2))
    write({ phase: 'downloaded' })
    const snapshots = []
    let lastSetupRead = 0
    const diagnose = () => {
      let version = null
      try {
        version = manifest().version
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
    check(manifest().forsionBundleExtend === !spec.noExtend, 'upgrade preserves the installed distribution')
    write({ phase: 'relaunched', updated })
  } catch (error) {
    const page = settings ?? win
    let current
    try {
      if (page && !page.isClosed()) {
        await screenshot(page, 'failure.png')
        current = settings && await status()
        statuses = settings && await settings.evaluate(() => window.__upgradeStatuses ?? []) || []
      }
    } catch { /* The old target is expected to disappear during restart. */ }
    const { phase, source, version, error: reason } = current ?? {}
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ runtime, current: { phase, source, version, reason: reason && sanitized(reason) }, error: sanitized(error.stack ?? error), statuses, proxy: proxy?.events }, null, 2))
    throw error
  } finally {
    proxy?.close()
    if (app && child?.exitCode === null && child.signalCode === null) {
      if (logging) await app.evaluate(({ netLog }) => netLog.stopLogging()).catch(() => {})
      await Promise.race([app.close().catch(() => {}), sleep(10000)])
    }
  }
}

main().then(() => process.exit(0), error => { console.error(sanitized(error)); process.exit(1) })
