#!/usr/bin/env node
/** Isolated copy of the installed macOS app, public npm, production IPC and pinned signing key.
 * A bootstrap redirects storage paths and observes network calls; update responses and versions are not mocked.
 * npm run check:engine-update-live -- --app /Applications/Forsion.app/Contents/MacOS/Forsion --expect 2.13.6
 * Uses disposable app/engine/vault/profile directories and leaves a report + screenshots in outputs/.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const { execFileSync } = require('node:child_process')
const asar = require('@electron/asar')
const electron = require('./lib/launch-electron.cjs')

const option = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const sourceExecutable = option('--app')
const expected = option('--expect')
const currentOnly = process.argv.includes('--current-only')
assert.equal(process.platform, 'darwin', 'This installed-app probe currently covers macOS')
assert.ok(sourceExecutable && fs.existsSync(sourceExecutable), 'Pass --app <installed executable>')
assert.match(expected || '', /^\d+\.\d+\.\d+$/, 'Pass --expect <published version>')
const out = path.resolve(option('--out') || path.join(__dirname, '..', 'outputs', 'engine-update-live'))
fs.mkdirSync(out, { recursive: true })
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-engine-update-live-'))
const home = path.join(temp, 'forsion'), userData = path.join(temp, 'userdata'), profile = path.join(temp, 'profile'), vault = path.join(temp, 'vault')
const appData = path.join(temp, 'appdata')
for (const dir of [home, userData, profile, vault, appData]) fs.mkdirSync(dir, { recursive: true })
// Packaged Electron ignores -r, so preload flags cannot isolate its CLI installer. Clone the application,
// unpack its original ASAR, and prefix only the main entry with app.setPath('home') before product code runs.
const sourceApp = path.resolve(sourceExecutable, '../../..')
assert.ok(sourceApp.endsWith('.app'), 'Expected an executable under an installed .app/Contents/MacOS')
const copy = path.join(temp, 'ForsionVerify.app')
execFileSync('cp', ['-cR', sourceApp, copy])
const resources = path.join(copy, 'Contents', 'Resources'), appDir = path.join(resources, 'app')
asar.extractAll(path.join(resources, 'app.asar'), appDir)
const appPackage = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))
const mainFile = path.resolve(appDir, appPackage.main)
assert.ok(mainFile.startsWith(appDir + path.sep), 'Main entry stays inside the copied application')
const bootstrap = `${appPackage.type === 'module' ? "import { app as __verifyApp, net as __verifyNet } from 'electron';" : "const { app: __verifyApp, net: __verifyNet } = require('electron');"}
(function () {
  const app = __verifyApp, net = __verifyNet;
  app.setPath('home', ${JSON.stringify(profile)});
  app.setPath('appData', ${JSON.stringify(appData)});
  globalThis.__engineUpdateRequests = [];
  const original = net.fetch.bind(net);
  net.fetch = async (url, init) => {
    const response = await original(url, init);
    if (String(url).startsWith('https://registry.npmjs.org/@forsion')) globalThis.__engineUpdateRequests.push({ url: String(url), status: response.status });
    return response;
  };
})();\n`
fs.writeFileSync(mainFile, bootstrap + fs.readFileSync(mainFile, 'utf8'))
fs.rmSync(path.join(resources, 'app.asar'))
const executablePath = path.join(copy, 'Contents', 'MacOS', path.basename(sourceExecutable))
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ workspace: path.join(temp, 'workspace'), browser: { enabled: false } }))
fs.writeFileSync(path.join(userData, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed', unitHostEnabled: false, computerHistoryEnabled: false, activeWindowEnabled: false, disabledBundles: ['forsion-extend', 'tangu-computer-use'] }))
fs.writeFileSync(path.join(userData, 'amadeus-config.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
const env = { ...process.env, TANGU_HOME: path.join(home, 'tangu'), TANGU_PLUGINS: 'off' }
delete env.ELECTRON_RUN_AS_NODE
delete env.TANGU_BACKEND_URL
const report = { expected, sourceExecutable, mode: currentOnly ? 'current-version check only' : 'download, verify and restart', isolation: 'installed-app copy; bootstrap redirects home and observes unmodified npm responses before product startup', checks: [], snapshots: [], network: [], engineVersions: [] }
let app, win, panel, logs = ''
function check(ok, description) { assert.ok(ok, description); report.checks.push(description); console.log(`PASS ${description}`) }
async function until(read, description, timeout = 90000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 250)) }
  throw new Error(`Timed out: ${description}`)
}
async function launch() {
  app = await electron.launch({ executablePath, args: [`--user-data-dir=${userData}`, '--lang=en-US'], env, timeout: 60000 })
  app.process().stdout?.on('data', (data) => { logs += data })
  app.process().stderr?.on('data', (data) => { logs += data })
  const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, home: app.getPath('home'), appData: app.getPath('appData'), userData: app.getPath('userData'), resources: process.resourcesPath, version: app.getVersion() }))
  report.identity = identity
  check(identity.packaged && fs.realpathSync(identity.home) === fs.realpathSync(profile) && fs.realpathSync(identity.appData) === fs.realpathSync(appData) && fs.realpathSync(identity.userData) === fs.realpathSync(userData), `installed app uses isolated home, app data and user data: ${JSON.stringify(identity)}`)
  win = await app.firstWindow()
  win.setDefaultTimeout(20000)
  await win.waitForSelector('#root')
  for (const label of ['Skip', 'Skip onboarding', '跳过引导']) {
    const skip = win.getByRole('button', { name: label, exact: true })
    if (await skip.count()) { await skip.click(); break }
  }
  await until(async () => (await win.evaluate(() => window.tangu.backendStatus())).state === 'ready', 'real managed engine ready')
}
async function engineVersion() {
  const status = await win.evaluate(() => window.tangu.backendStatus())
  const response = await fetch(`${status.url}/health`, { signal: AbortSignal.timeout(5000) })
  assert.ok(response.ok)
  const version = (await response.json()).version
  report.engineVersions.push(version)
  return version
}
async function openSettings() {
  const opened = app.waitForEvent('window')
  await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'amadeus-plugins', nonce: Date.now() } }))
  panel = await opened
  await panel.locator('.core-plugin-updates').waitFor()
}
async function checkUpdates() {
  await panel.getByRole('button', { name: 'Check all updates', exact: true }).click()
  const state = await until(async () => {
    const state = await panel.evaluate(() => window.tangu.getCorePluginUpdates())
    const engine = state.items.find((item) => item.id === 'tangu-engine')
    return !state.checking && engine && ['current', 'staged', 'error', 'incompatible'].includes(engine.phase) ? state : null
  }, 'public npm update check completed')
  report.snapshots.push(state)
  report.network.push(...await app.evaluate(() => globalThis.__engineUpdateRequests))
  return state.items.find((item) => item.id === 'tangu-engine')
}
async function close() { if (app) await app.close(); app = win = panel = undefined }

;(async () => {
  try {
    await launch()
    const bundledVersion = await engineVersion()
    check(currentOnly || bundledVersion !== expected, 'full download verification requires a newer published engine; use --current-only to check an equal version')
    await openSettings()
    const update = await checkUpdates()
    check(update.installedVersion === bundledVersion && update.latestVersion === expected, 'IPC reports the actual running and public npm versions')
    check(['staged', 'current'].includes(update.phase), `update check succeeds (${update.phase})`)
    const needsRestart = bundledVersion !== expected
    if (needsRestart) {
      check(update.phase === 'staged' && update.pendingVersion === expected, 'new engine is downloaded and staged for the next launch')
      const root = path.join(home, 'engine', expected)
      const overlay = await import(pathToFileURL(path.join(report.identity.resources, 'tangu-server', 'dist', 'boot', 'overlay.js')).href)
      const verdict = overlay.checkOverlay(root, path.join(report.identity.resources, 'tangu-server'))
      check(verdict.ok && verdict.version === expected, 'downloaded engine passes the installed app signing key and compatibility checks')
      check(await engineVersion() === bundledVersion, 'downloading does not replace the running engine')
      check(report.network.some((request) => request.url.endsWith(`tangu-agent-${expected}.tgz`) && request.status === 200), 'production downloader fetched the real tarball from public npm')
    }
    await panel.screenshot({ path: path.join(out, 'downloaded.png') })
    await close()
    await launch()
    check(await engineVersion() === expected, 'next app launch runs the published engine')
    await openSettings()
    const current = await checkUpdates()
    check(current.phase === 'current' && current.installedVersion === expected && !current.pendingVersion, 'after restart the actual client reports up to date')
    await panel.screenshot({ path: path.join(out, 'current.png') })
    report.ok = true
  } catch (error) {
    report.ok = false; report.error = error.stack || String(error)
    if (panel) report.snapshots.push(await panel.evaluate(() => window.tangu.getCorePluginUpdates()).catch(() => null))
    await (panel || win)?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
    throw error
  } finally {
    await close()
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    fs.writeFileSync(path.join(out, 'app.log'), logs)
    fs.rmSync(temp, { recursive: true, force: true })
    console.log(`Report: ${out}`)
  }
})().catch((error) => { console.error(error); process.exitCode = 1 })
