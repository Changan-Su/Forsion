/** Real electron-updater/NSIS download + SHA-512 verification against loopback fixtures.
 * The payload is inert text. Installation is disabled; cache/config live in a temporary directory.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const { createHash } = require('node:crypto')
const { buildSync } = require('esbuild')
const electron = require('./lib/launch-electron.cjs')
const ROOT = path.resolve(__dirname, '..')
async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-win-update-'))
  const output = path.join(ROOT, 'outputs/windows-issues/website-provider.cjs')
  buildSync({ entryPoints: [path.join(ROOT, 'electron/websiteUpdateProvider.ts')], bundle: true, packages: 'external', platform: 'node', format: 'cjs', outfile: output })
  const bytes = Buffer.from('Forsion updater integrity fixture. This file is not executable.\n')
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.url)
    if (req.url.startsWith('/download')) { res.writeHead(302, { Location: '/installer.exe' }); res.end(); return }
    if (req.url.startsWith('/latest.yml')) {
      res.end(`version: 99.0.0\nfiles:\n  - url: installer.exe\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: installer.exe\nsha512: ${sha512}\n`); return
    }
    if (req.url.startsWith('/installer.exe')) { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length }); res.end(bytes); return }
    res.writeHead(404); res.end()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, path.join(__dirname, 'fixtures/windows-contracts-main.cjs')], env: { ...process.env, TANGU_HOME: home } })
    await app.firstWindow()
    const results = await app.evaluate(async (_, input) => {
      const require = globalThis.__windowsProbeRequire
      const fs = require('node:fs/promises'), path = require('node:path')
      const { NsisUpdater } = require('electron-updater')
      const { WebsiteUpdateProvider } = require(input.provider)
      const checks = []
      const check = (ok, name) => { if (!ok) throw new Error(name); checks.push(name) }
      const make = async name => {
        const updater = new NsisUpdater()
        updater.autoDownload = false
        updater.autoInstallOnAppQuit = false
        updater.disableDifferentialDownload = true
        updater.disableWebInstaller = true
        updater.forceDevUpdateConfig = true
        updater.logger = { info() {}, warn() {}, error() {}, debug() {} }
        // A dedicated config/cache for each source avoids shared user update state.
        Object.defineProperty(updater.app, 'baseCachePath', { get: () => path.join(input.home, name) })
        const config = path.join(input.home, `${name}.yml`)
        await fs.writeFile(config, 'updaterCacheDirName: probe\n')
        updater.updateConfigPath = config
        updater.doInstall = () => { throw new Error('Installation must never be invoked by this probe') }
        return updater
      }
      const site = await make('website')
      const feed = sha => ({ provider: 'custom', updateProvider: WebsiteUpdateProvider,
        installer: { version: '99.0.0', filename: 'Forsion-99.0.0-x64.exe', size: input.size, sha512: sha }, downloadUrl: `${input.url}/download/windows` })
      site.setFeedURL(feed(input.sha512))
      check((await site.checkForUpdates()).updateInfo.version === '99.0.0', 'real NSIS updater accepts website provider metadata')
      const downloaded = await site.downloadUpdate()
      check(downloaded.length === 1 && (await fs.readFile(downloaded[0])).toString('base64') === input.bytes, 'website redirect downloads correct bytes with SHA-512 validation')
      const bad = await make('corrupted')
      bad.setFeedURL(feed(Buffer.alloc(64, 7).toString('base64')))
      await bad.checkForUpdates()
      let rejected = false
      try { await bad.downloadUpdate() } catch (e) { rejected = /sha512|checksum/i.test(e.message) }
      check(rejected, 'real downloader rejects a mismatched SHA-512')
      const generic = await make('generic')
      generic.setFeedURL({ provider: 'generic', url: input.url })
      check((await generic.checkForUpdates()).updateInfo.version === '99.0.0', 'generic GitHub-style feed parses latest.yml')
      const files = await generic.downloadUpdate()
      check(files.length === 1 && (await fs.readFile(files[0])).toString('base64') === input.bytes, 'generic feed downloads and verifies the same payload')
      return checks
    }, { provider: output, home, url, sha512, size: bytes.length, bytes: bytes.toString('base64') })
    for (const name of results) console.log(`PASS ${name}`)
    assert.ok(seen.some(p => p.startsWith('/download')) && seen.some(p => p.startsWith('/latest.yml')))
    console.log(`${results.length}/${results.length} passed`)
  } finally {
    if (app) await app.close().catch(() => {})
    await new Promise(r => server.close(r))
    fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
