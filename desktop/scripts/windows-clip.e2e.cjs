/** Published Clip files copied through real IPC into an isolated Windows profile.
 * Does not install an extension, open the user's browser/Explorer, or modify the OS clipboard.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-win-clip-'))
  const source = path.join(ROOT, 'node_modules/@forsion/clip/chrome-mv3')
  const bundled = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'))
  const stub = await startStubEngine()
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'ud')}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
    const win = await app.firstWindow()
    await skipOnboarding(win)
    const prepare = update => win.evaluate(update => window.tangu.clipExtension.prepare(update), update)
    const copy = await prepare(false)
    assert.ok(!copy.error && copy.dir.startsWith(home + path.sep) && copy.version === bundled.version)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(copy.dir, 'manifest.json'), 'utf8')), bundled)
    console.log('PASS real Clip prepare IPC copies the bundled manifest into the isolated profile')
    const icons = Object.values(bundled.icons || {})
    assert.ok(icons.length && icons.every(p => fs.existsSync(path.join(copy.dir, p))))
    console.log('PASS extension icons referenced by the manifest exist in the copy')
    fs.writeFileSync(path.join(copy.dir, 'manifest.json'), JSON.stringify({ ...bundled, version: '0.0.1' }))
    fs.writeFileSync(path.join(copy.dir, 'probe-marker'), 'old')
    assert.equal((await prepare(false)).version, '0.0.1')
    assert.ok(fs.existsSync(path.join(copy.dir, 'probe-marker')))
    console.log('PASS opening settings preserves an existing loaded extension copy')
    assert.equal((await prepare(true)).version, bundled.version)
    assert.ok(!fs.existsSync(path.join(copy.dir, 'probe-marker')) && !fs.existsSync(`${copy.dir}.old`) && !fs.existsSync(`${copy.dir}.tmp`))
    console.log('PASS explicit refresh replaces the copy and removes staging folders')
    console.log('4/4 passed')
  } finally { if (app) await app.close().catch(() => {}); await stub.close() }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
