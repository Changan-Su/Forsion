#!/usr/bin/env node
/** Verify the packaged app, not the development output: v2.9.8 missed the CU/permission delivery chain. */
const fs = require('node:fs')
const path = require('node:path')
const asar = require('@electron/asar')

const desktop = path.resolve(__dirname, '..')
const expectedVersion = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).version
const errors = []
function check(ok, message) {
  if (!ok) errors.push(message)
}
function findResources(dir, depth = 0) {
  if (fs.existsSync(path.join(dir, 'app.asar'))) return [dir]
  if (depth > 5 || !fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() && !['node_modules', 'app.asar.unpacked', 'tangu-server', 'bundled-plugins'].includes(e.name)
      ? findResources(path.join(dir, e.name), depth + 1) : [])
}
const resources = process.argv[2] ? [path.resolve(process.argv[2])] : findResources(path.join(desktop, 'dist'))
check(resources.length > 0, 'No packaged app.asar found')
for (const dir of resources) {
  const archive = path.join(dir, 'app.asar')
  const readArchive = (file) => {
    try { return asar.extractFile(archive, file).toString('utf8') }
    catch { errors.push(`${dir}: missing ${file}`); return '' }
  }
  const readJson = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
    catch { errors.push(`Missing or invalid ${file}`); return {} }
  }
  let pkg = {}
  try { pkg = JSON.parse(readArchive('package.json')) } catch { errors.push(`${archive}: invalid package.json`) }
  check(pkg.version === expectedVersion, `App version ${pkg.version} != ${expectedVersion}`)
  check(pkg.dependencies?.['@forsion/tangu-computer-use'] === 'file:vendor/tangu-computer-use.tgz', 'CU dependency missing from packaged app')
  const engine = readJson(path.join(dir, 'tangu-server', 'package.json'))
  check(engine.version === expectedVersion, `Engine version ${engine.version} != ${expectedVersion}`)

  const main = readArchive('out/main/main.js')
  const preload = readArchive('out/preload/preload.mjs')
  for (const channel of ['permissions:status', 'permissions:request', 'permissions:verify', 'permissions:closeGuide']) {
    check(main.includes(channel) && preload.includes(channel), `Permission IPC missing from main/preload: ${channel}`)
  }
  check(main.includes('[builtin-plugins]'), 'Builtin plugin seeding missing from main')
  check(preload.includes('desktopPermissionsStatus'), 'Permission status bridge missing')
  let renderer = ''
  try {
    for (const entry of asar.listPackage(archive)) {
      const normalized = entry.replace(/\\/g, '/').replace(/^\//, '')
      if (normalized.startsWith('out/renderer/assets/') && normalized.endsWith('.js')) renderer += readArchive(normalized)
    }
  } catch { errors.push(`Cannot list ${archive}`) }
  check(renderer.includes('desktopPermissions.title'), 'Permission UI missing from renderer')

  const cu = path.join(dir, 'bundled-plugins', 'tangu-computer-use')
  const manifest = readJson(path.join(cu, 'manifest.json'))
  const cuPkg = readJson(path.join(cu, 'package.json'))
  const installed = readJson(path.join(desktop, 'node_modules', '@forsion', 'tangu-computer-use', 'package.json'))
  check(manifest.version === installed.version && cuPkg.version === installed.version, 'Packaged CU version differs from build dependency')
  check(fs.existsSync(path.join(cu, 'tangu-plugins', 'computer-use', 'dist', 'index.js')), 'CU engine bundle missing')
  check(fs.existsSync(path.join(cu, 'scripts', 'setup-helper.mjs')), 'CU setup script missing')
  for (const platform of ['windows', 'linux']) {
    check(!fs.existsSync(path.join(cu, 'native', platform, 'bridge-rs', 'target')), `Rust build cache leaked into packaged CU (${platform})`)
  }
  for (const arch of ['arm64', 'x64']) {
    const file = path.join(cu, 'prebuilt', 'macos', arch, 'bridge')
    try {
      const binary = fs.readFileSync(file)
      check(binary.length > 100_000 && binary.includes(Buffer.from('permissionStatus')), `macOS ${arch} helper missing permission protocol`)
      if (process.platform !== 'win32') check((fs.statSync(file).mode & 0o111) !== 0, `macOS ${arch} helper is not executable`)
    } catch { errors.push(`Missing ${file}`) }
  }
  if (process.platform === 'win32') {
    const file = path.join(cu, 'prebuilt', 'windows', 'windows-bridge.exe')
    try {
      const binary = fs.readFileSync(file)
      check(binary.length > 100_000 && binary.subarray(0, 2).toString() === 'MZ', 'Windows native helper missing/invalid')
    } catch { errors.push(`Missing ${file}`) }
  }
  if (process.platform === 'linux') {
    const file = path.join(cu, 'prebuilt', 'linux', process.arch, 'linux-bridge')
    try {
      const binary = fs.readFileSync(file)
      check(binary.length > 100_000 && binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'Linux native helper missing/invalid')
      check((fs.statSync(file).mode & 0o111) !== 0, 'Linux native helper is not executable')
    } catch { errors.push(`Missing ${file}`) }
  }
  console.log(`Checked packaged content: ${dir}`)
}
if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join('\n'))
  process.exit(1)
}
console.log(`Release content verified (${expectedVersion}): permission UI/IPC, CU bundle, native helpers, engine version`)
