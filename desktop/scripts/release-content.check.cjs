#!/usr/bin/env node
/** Verify the packaged app, not the development output: v2.9.8 missed the CU/permission delivery chain. */
const fs = require('node:fs')
const path = require('node:path')
const asar = require('@electron/asar')
const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const os = require('node:os')

const desktop = path.resolve(__dirname, '..')
// Computer Use's release certificate (SHA-1), pinned here rather than read from the CU package: this check exists
// to stop a helper signed by another certificate from shipping, so a CU release that changed both its certificate
// and its own pin must still fail here. Changing this value costs every Mac user a new Accessibility and Screen
// Recording grant.
const CU_RELEASE_CERT_SHA1 = 'dab3a30e7568c7e2c021660b49398356a205a191'
// The bundled-plugin list (electron/builtinBundles.json) is the single source: every entry must be pinned, packaged,
// and (for packages with a main-process half) signed with the key pinned in that list. A package missing from
// extraResources used to ship silently; now it fails here.
const builtinBundles = require('../electron/builtinBundles.json')
const { bundleExtend } = require('../build/distribution.cjs')
const expectedVersion = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).version
const errors = []
function check(ok, message) {
  if (!ok) errors.push(message)
}
/** Same rules as electron/bundleSignature.ts (kept in sync by hand: this script is CJS and cannot import it). */
function verifyBundleSignature(dir, publicKeyPem, required) {
  let sig
  try { sig = JSON.parse(fs.readFileSync(path.join(dir, 'SIGNATURE'), 'utf8')) } catch (e) { return `no readable SIGNATURE: ${e.message}` }
  if (sig.alg !== 'ed25519' || typeof sig.sig !== 'string' || !sig.files || typeof sig.files !== 'object') return 'SIGNATURE is malformed'
  const entries = Object.entries(sig.files)
  if (entries.length === 0 || entries.length > 5000) return `SIGNATURE lists ${entries.length} files`
  for (const [rel, digest] of entries) {
    if (!/^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\0]+$/.test(rel) || rel === 'SIGNATURE' || !/^[0-9a-f]{64}$/.test(digest)) return `bad entry ${JSON.stringify(rel)}`
  }
  const canonical = JSON.stringify(Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
  let ok = false
  try { ok = crypto.verify(null, Buffer.from(canonical, 'utf8'), crypto.createPublicKey(publicKeyPem), Buffer.from(sig.sig, 'base64')) } catch (e) { return `signature check failed: ${e.message}` }
  if (!ok) return 'signature does not match the pinned public key'
  for (const rel of required) if (!(rel in sig.files)) return `${rel} is not covered by SIGNATURE`
  for (const [rel, digest] of Object.entries(sig.files)) {
    const file = path.join(dir, ...rel.split('/'))
    let stat
    try { stat = fs.lstatSync(file) } catch { return `${rel} is missing` }
    if (!stat.isFile()) return `${rel} is not a regular file`
    if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== digest) return `${rel} does not match its signed hash`
  }
  return null
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
    // asar 在 Windows 内部按 path.sep 分目录；只用 '/' 会把存在的文件误报为缺失。
    try { return asar.extractFile(archive, path.normalize(file)).toString('utf8') }
    catch { errors.push(`${dir}: missing ${file}`); return '' }
  }
  const readJson = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
    catch { errors.push(`Missing or invalid ${file}`); return {} }
  }
  let pkg = {}
  try { pkg = JSON.parse(readArchive('package.json')) } catch { errors.push(`${archive}: invalid package.json`) }
  check(pkg.version === expectedVersion, `App version ${pkg.version} != ${expectedVersion}`)
  check(pkg.forsionBundleExtend === bundleExtend, 'Packaged distribution metadata differs from FORSION_BUNDLE_EXTEND')
  if (!bundleExtend) {
    check(!fs.existsSync(path.join(dir, 'bundled-plugins', 'extend')), 'NoExtend package contains the Extend bundle')
    check(!asar.listPackage(archive).some((entry) => /(?:^|\/)node_modules\/@forsion\/extend(?:\/|$)/.test(entry.replace(/\\/g, '/'))), 'NoExtend asar contains Extend')
  }
  const engine = readJson(path.join(dir, 'tangu-server', 'package.json'))
  const extensionDir = path.join(dir, 'tangu-server', 'browser-extension')
  check(fs.existsSync(path.join(extensionDir, 'manifest.json')), 'Bundled Chrome extension manifest missing')
  check(fs.existsSync(path.join(extensionDir, 'background.js')), 'Bundled Chrome extension background script missing')
  check(engine.version === expectedVersion, `Engine version ${engine.version} != ${expectedVersion}`)

  const main = readArchive('out/main/main.js')
  check(main.includes('latest-no-extend') === !bundleExtend, 'Main process updater variant differs from FORSION_BUNDLE_EXTEND; rebuild the shell with the same value used for packaging')
  const preload = readArchive('out/preload/preload.mjs')
  for (const channel of ['permissions:status', 'permissions:request', 'permissions:verify', 'permissions:closeGuide']) {
    check(main.includes(channel) && preload.includes(channel), `Permission IPC missing from main/preload: ${channel}`)
  }
  check(main.includes('[builtin-plugins]'), 'Builtin plugin seeding missing from main')
  check(main.includes('[builtin-updates]'), 'Builtin plugin npm updater missing from main')
  check(main.includes('[cloud-host]') && preload.includes('cloud:present'), 'Builtin desktop-entry loader (cloudHost) missing from main/preload')
  check(preload.includes('desktopPermissionsStatus'), 'Permission status bridge missing')

  // 每个内置包:npm 上钉死的精确正式版(Dependabot 提 PR 升级;范围或本地 file: 依赖都会让安装包内容不可复现;
  // 刻意不收预发布版:播种按 cmpVersion 比版本,它把 0.5.9-rc.1 排在 0.5.9 之上,内置过预发布版,正式版就永远换不上去),
  // 随包那份的 id / 版本对得上,带主进程半身的还要过清单里钉的公钥。
  for (const bundle of builtinBundles) {
    if (!bundleExtend && bundle.id === 'forsion-extend') continue
    const pinned = pkg.dependencies?.[bundle.pkg] ?? ''
    check(/^\d+\.\d+\.\d+$/.test(pinned), `${bundle.pkg} dependency must be an exact release version, got "${pinned}"`)
    // 宿主删掉某块原生实现后要求的最低包版本(builtinBundles.json minVersion):钉着旧版 = 安装包静默少功能
    if (bundle.minVersion) {
      const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0 }
      check(cmp(pinned, bundle.minVersion) >= 0, `${bundle.pkg} pinned ${pinned} is below the ${bundle.minVersion} this desktop requires`)
    }
    const bundleDir = path.join(dir, 'bundled-plugins', bundle.pkg.replace(/^@[^/]+\//, ''))
    const manifest = readJson(path.join(bundleDir, 'manifest.json'))
    const bundlePkg = readJson(path.join(bundleDir, 'package.json'))
    check(manifest.id === bundle.id, `Packaged ${bundle.pkg} manifest id "${manifest.id}" != ${bundle.id}`)
    check(manifest.version === pinned && bundlePkg.version === pinned, `Packaged ${bundle.pkg} ${bundlePkg.version} (manifest ${manifest.version}) differs from the pinned dependency ${pinned}`)
    check(!fs.existsSync(path.join(bundleDir, 'node_modules')), `Packaged ${bundle.pkg} ships node_modules`)
    if (bundle.desktop) {
      check(fs.existsSync(path.join(bundleDir, ...bundle.desktop.entry.split('/'))), `${bundle.pkg} desktop entry ${bundle.desktop.entry} missing`)
      const reason = verifyBundleSignature(bundleDir, bundle.desktop.signingKey, [bundle.desktop.entry, 'manifest.json'])
      check(!reason, `Packaged ${bundle.pkg} is not signed with the pinned key: ${reason}`)
    }
  }
  let renderer = ''
  try {
    for (const entry of asar.listPackage(archive)) {
      const normalized = entry.replace(/\\/g, '/').replace(/^\//, '')
      if (normalized.startsWith('out/renderer/assets/') && normalized.endsWith('.js')) renderer += readArchive(normalized)
    }
  } catch { errors.push(`Cannot list ${archive}`) }
  check(renderer.includes('desktopPermissions.title'), 'Permission UI missing from renderer')

  const cu = path.join(dir, 'bundled-plugins', 'tangu-computer-use')
  check(fs.existsSync(path.join(cu, 'tangu-plugins', 'computer-use', 'dist', 'index.js')), 'CU engine bundle missing')
  check(fs.existsSync(path.join(cu, 'scripts', 'setup-helper.mjs')), 'CU setup script missing')
  // Verify sealed App ZIPs, not only loose bridge files. ZIP transport prevents
  // afterPack --deep signing from replacing the helper's original identity.
  try { execFileSync(process.execPath, [path.join(cu, 'scripts', 'verify-macos-bundles.mjs')], { stdio: 'pipe' }) }
  catch (error) { errors.push(`Invalid sealed CU app bundle: ${error.stderr?.toString() || error.message}`) }
  // The bundled helper must be signed by CU's release certificate (releaseCertSha1 in its macos-bundle.mjs).
  // An ad-hoc or differently signed helper changes the designated requirement, and every Mac user
  // would lose the Accessibility and Screen Recording grants. Never bundle a local `build:native` output.
  let packagePin
  try { packagePin = /releaseCertSha1 = '([0-9a-f]{40})'/.exec(fs.readFileSync(path.join(cu, 'scripts', 'macos-bundle.mjs'), 'utf8'))?.[1] } catch { /* reported below */ }
  check(packagePin === CU_RELEASE_CERT_SHA1, `CU package pins certificate ${packagePin ?? '(none)'}, Desktop expects ${CU_RELEASE_CERT_SHA1}`)
  if (process.platform === 'darwin') {
    const pin = CU_RELEASE_CERT_SHA1
    for (const arch of ['arm64', 'x64']) {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-signer-'))
      try {
        execFileSync('/usr/bin/ditto', ['-x', '-k', path.join(cu, 'prebuilt', 'macos', arch, 'tangu-computer-use.app.zip'), temp])
        execFileSync('/usr/bin/codesign', ['-d', `--extract-certificates=${path.join(temp, 'signer')}`, path.join(temp, 'tangu-computer-use.app')], { stdio: 'pipe' })
        const leaf = path.join(temp, 'signer0')
        const signer = fs.existsSync(leaf) ? crypto.createHash('sha1').update(fs.readFileSync(leaf)).digest('hex') : 'ad-hoc'
        check(signer === pin, `Bundled CU macOS ${arch} helper is signed by ${signer}, not the CU release certificate ${pin}`)
      } catch (error) {
        errors.push(`Cannot inspect bundled CU macOS ${arch} helper: ${error.message}`)
      } finally {
        fs.rmSync(temp, { recursive: true, force: true })
      }
    }
  }
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
      // 导入表里的 DLL 名是明文:出现 VC++ 运行库那一族即动态链接了它,没装 VC++ 运行库的机器上 helper 起不来。
      const vcRuntime = binary.toString('latin1').match(/\b(?:vcruntime|msvcr|msvcp|concrt|vccorlib|vcomp|vcamp)\d+(?:_\w+)?\.dll/i)
      check(!vcRuntime, `Windows native helper needs ${vcRuntime?.[0]} (build with +crt-static)`)
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
console.log(`Release content verified (${expectedVersion}, ${bundleExtend ? 'default' : 'NoExtend'}): permission UI/IPC, CU bundle, native helpers, engine version`)
