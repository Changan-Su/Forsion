#!/usr/bin/env node
/** Real packaged app + real signed Extend upgrade + local-only cloud protocol fixture.
 * Run after electron-builder on each native runner. No production account/key is used.
 * This proves the delivered host/plugin/UI seam; it is not a backend load or live-sync test.
 * Local GUI runs must use the repository devlock. Linux requires xvfb-run.
 * Usage: node scripts/penzor-packaged.check.cjs (installs/extracts the final DMG/NSIS/AppImage)
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const desktop = path.resolve(__dirname, '..')
function findResources(dir, depth = 0) {
  if (fs.existsSync(path.join(dir, 'app.asar'))) return [dir]
  if (depth > 5 || !fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() && !['node_modules', 'app.asar.unpacked', 'tangu-server', 'bundled-plugins'].includes(e.name)
      ? findResources(path.join(dir, e.name), depth + 1) : [])
}
function digest(file) {
  const hash = createHash('sha256'), fd = fs.openSync(file, 'r'), buffer = Buffer.allocUnsafe(1024 * 1024)
  try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, n)) }
  finally { fs.closeSync(fd) }
  return hash.digest('hex')
}
function resourceManifest(root, relative = '') {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const rel = path.join(relative, entry.name), file = path.join(root, rel)
    if (entry.isSymbolicLink()) return [[rel, 'link:' + fs.readlinkSync(file)]]
    return entry.isDirectory() ? resourceManifest(root, rel) : [[rel, digest(file)]]
  })
}
function run(command, args, opts = {}) {
  const r = spawnSync(command, args, { stdio: 'inherit', timeout: 180000, ...opts })
  if (r.error) throw r.error
  assert.equal(r.status, 0, `${command} failed (${r.status})`)
}
function finalInstaller(dist, temp) {
  const ext = process.platform === 'darwin' ? '.dmg' : process.platform === 'win32' ? '.exe' : '.AppImage'
  const candidates = fs.readdirSync(dist).filter(name => name.endsWith(ext))
  assert.equal(candidates.length, 1, `Expected one final ${ext} installer, got ${candidates}`)
  const installer = path.join(dist, candidates[0])
  const installed = path.join(temp, 'installed'); fs.mkdirSync(installed)
  if (process.platform === 'darwin') {
    const mount = path.join(temp, 'mount'); fs.mkdirSync(mount)
    run('hdiutil', ['attach', installer, '-readonly', '-nobrowse', '-mountpoint', mount])
    try {
      const apps = fs.readdirSync(mount).filter(name => name.endsWith('.app'))
      assert.equal(apps.length, 1, 'DMG must contain one application')
      run('ditto', [path.join(mount, apps[0]), path.join(installed, apps[0])])
    } finally { run('hdiutil', ['detach', mount]) }
  } else if (process.platform === 'win32') {
    // /D is NSIS's final unquoted argument. Avoid shell interpretation entirely.
    run(installer, ['/S', `/D=${installed}`], { env: { ...process.env, HOME: temp, USERPROFILE: temp, APPDATA: path.join(temp, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(temp, 'AppData', 'Local') } })
  } else {
    fs.chmodSync(installer, 0o755)
    run(installer, ['--appimage-extract'], { cwd: installed, stdio: 'ignore' })
  }
  const resources = findResources(installed)[0]
  assert.ok(resources, 'Final installer did not contain/install a usable app.asar')
  return { installer, resources }
}
async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Packaged startup registers OS protocols/CLI: use a dedicated CI runner, not a personal desktop')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-final-installer-'))
  const { installer, resources } = finalInstaller(path.join(desktop, 'dist'), temp)
  const unpacked = findResources(path.join(desktop, 'dist'))[0]
  assert.ok(unpacked, 'Original packaging output is absent')
  const installedFiles = resourceManifest(resources)
  assert.deepEqual(installedFiles, resourceManifest(unpacked), 'Final installer resources differ from the verified packaging output')
  const output = path.join(desktop, 'outputs', 'penzor-packaged'); fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(output, 'installer.json'), JSON.stringify({ installer, sha256: digest(installer), installedResources: resources, appAsarSha256: digest(path.join(resources, 'app.asar')), comparedResources: installedFiles.length }, null, 2))
  const extend = path.join(resources, 'bundled-plugins', 'extend')
  if (process.env.FORSION_BUNDLE_EXTEND === '0') {
    assert.ok(!fs.existsSync(extend), 'NoExtend distribution must not include Extend')
    console.log('NoExtend: final installer extracted/installed; all resource files match verified output and Extend is absent')
    fs.rmSync(temp, { recursive: true, force: true })
    return
  }
  assert.ok(fs.existsSync(path.join(extend, 'SIGNATURE')), 'Packaged Extend must carry its real signature')
  const bundledVersion = JSON.parse(fs.readFileSync(path.join(extend, 'package.json'), 'utf8')).version
  assert.ok(require('semver').gt(bundledVersion, '0.9.1'), 'Upgrade acceptance requires a bundled Extend newer than 0.9.1')
  const exeDir = path.basename(resources) === 'Resources' ? path.join(resources, '..', 'MacOS') : path.dirname(resources)
  const exe = fs.readdirSync(exeDir, { withFileTypes: true }).filter(e => e.isFile() && (process.platform !== 'win32' || /\.exe$/i.test(e.name)))
    .map(e => ({ path: path.join(exeDir, e.name), size: fs.statSync(path.join(exeDir, e.name)).size })).sort((a, b) => b.size - a.size)[0]?.path
  assert.ok(exe, 'Packaged executable is absent')
  // Fetch the immutable previous public package and check npm's SHA-512 before extraction.
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-extend-upgrade-'))
  try {
    const response = await fetch('https://registry.npmjs.org/@forsion%2fextend/0.9.1', { signal: AbortSignal.timeout(30000) })
    assert.ok(response.ok, `Previous package metadata: HTTP ${response.status}`)
    const meta = await response.json()
    assert.equal(meta.version, '0.9.1')
    const url = new URL(meta.dist.tarball)
    assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, 'registry.npmjs.org')
    const download = await fetch(url, { signal: AbortSignal.timeout(60000) }); assert.ok(download.ok)
    const bytes = Buffer.from(await download.arrayBuffer())
    assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), meta.dist.integrity)
    const archive = path.join(old, 'extend.tgz'); fs.writeFileSync(archive, bytes)
    const unpack = spawnSync('tar', ['-xzf', archive, '-C', old], { stdio: 'inherit' }); assert.equal(unpack.status, 0)
    assert.equal(JSON.parse(fs.readFileSync(path.join(old, 'package', 'manifest.json'), 'utf8')).version, '0.9.1')
    assert.notEqual(digest(path.join(old, 'package', 'SIGNATURE')), digest(path.join(extend, 'SIGNATURE')), 'Previous signed package must differ from the candidate')
    const version = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).version
    fs.writeFileSync(path.join(output, 'provenance.json'), JSON.stringify({ desktop: version, previousExtend: meta.version, previousIntegrity: meta.dist.integrity, bundledExtend: JSON.parse(fs.readFileSync(path.join(extend, 'package.json'), 'utf8')).version, resources, exe, commit: process.env.GITHUB_SHA || null }, null, 2))
    const r = spawnSync(process.execPath, [path.join(__dirname, 'penzor-space.e2e.cjs')], {
      stdio: 'inherit', timeout: 12 * 60 * 1000,
      env: { ...process.env, EXTEND_PKG: extend, PENZOR_PACKAGED_EXE: exe, PENZOR_PREVIOUS_EXTEND: path.join(old, 'package'), PENZOR_EXPECT_VERSION: version, PENZOR_FIXTURE_SIGNING: '0', PENZOR_HOLD: '', PENZOR_VISUAL_ONLY: '', SHOTS_DIR: output },
    })
    if (r.error) throw r.error
    assert.equal(r.status, 0, 'Packaged cloud acceptance failed; see outputs/penzor-packaged')
  } finally {
    fs.rmSync(old, { recursive: true, force: true })
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
