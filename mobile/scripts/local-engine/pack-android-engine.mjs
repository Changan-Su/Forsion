#!/usr/bin/env node
// Builds the "This phone" engine npm package (mobile/android/local-engine/README.md). Runs INSIDE an arm64 Ubuntu 24.04
// container with Node 24 (build-android-engine.sh starts it, once per phase): the dependencies are installed and packed
// on a Linux file system, so native modules are built for linux-arm64 glibc and case-distinct names survive.
//
//   --phase stage --tangu <dir> --lock <lock.json> --out <dir> [--version x.y.z]
//       no key in this container: stage the engine (.js only, skills) → npm ci --omit=dev of the engine's own lock (runs
//       dependency install scripts) → bundle node_modules → drop native binaries for other platforms → refuse DDL outside
//       the schema files → list exactly what `npm pack` will ship → <out>/.stage/{stage.tar,files.json}
//   --phase sign --lock <lock.json> --out <dir> --expect-key <hex>
//       ANDROID_ENGINE_SIGNING_KEY (PEM) present, and no package code runs: sign that list → npm pack --ignore-scripts →
//       unpack the tarball and verify it with the Node mirror of the phone's verifier against the key the APK pins
//       (--expect-key), so a wrong secret fails here, not on every phone. Prints the JSON summary on its last line.
//   --phase boot --out <dir>
//       no key: start the engine from the unpacked tarball (ready line + an authed call).
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import { CONTEXT, SIGNED_FILE, SIG_FILE, ddlOutsideSchema, rawPublicHex, signTable, verifyDir } from './android-engine-format.mjs'

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined }
const fail = (m) => { console.error(`::error::${m}`); process.exit(1) }
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 1 << 28, ...opts })

if (process.platform !== 'linux' || process.arch !== 'arm64') fail('run this inside the linux/arm64 container (build-android-engine.sh)')
const phase = arg('--phase')
const out = path.resolve(arg('--out') || fail('--out'))
const work = '/tmp/android-engine'
const stage = path.join(work, 'package')
const stageDir = path.join(out, '.stage')
if (phase === 'stage') runStage()
else if (phase === 'sign') runSign()
else if (phase === 'boot') await runBoot()
else fail('--phase stage | sign | boot')

function runStage() {
if (process.env.ANDROID_ENGINE_SIGNING_KEY) fail('the stage phase runs dependency install scripts: it must not see the signing key')
const tangu = path.resolve(arg('--tangu') || fail('--tangu'))
const lock = JSON.parse(readFileSync(arg('--lock') || fail('--lock'), 'utf8'))
const src = JSON.parse(readFileSync(path.join(tangu, 'package.json'), 'utf8'))
const version = arg('--version') || src.version
if (!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version)) fail(`version ${version} is not a release version (x.y.z)`)
if (version !== src.version) fail(`--version ${version} differs from tangu-agent/package.json ${src.version}: the engine package version is the engine's version`)
if (!existsSync(path.join(tangu, 'dist/standalone/main.js'))) fail('tangu-agent/dist is missing: run npm run build in tangu-agent first')

rmSync(work, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

// 1. engine code: runtime .js only (same filter as tangu-agent/scripts/pack-engine.mjs), skills, licence
cpSync(path.join(tangu, 'dist'), path.join(stage, 'dist'), { recursive: true, filter: (f) => !path.basename(f).includes('.') || /\.m?js$/.test(f) })
for (const d of ['skills', 'agent-skills']) if (existsSync(path.join(tangu, d))) cpSync(path.join(tangu, d), path.join(stage, d), { recursive: true })
const licence = [path.join(tangu, 'LICENSE'), path.join(tangu, '..', 'LICENSE')].find(existsSync)
if (!licence) fail('LICENSE not found')
cpSync(licence, path.join(stage, 'LICENSE'))

// 2. dependencies: the engine's own lock, production only, install scripts on (better-sqlite3 builds / fetches its binary)
const deps = path.join(work, 'deps')
mkdirSync(deps)
cpSync(path.join(tangu, 'package.json'), path.join(deps, 'package.json'))
cpSync(path.join(tangu, 'package-lock.json'), path.join(deps, 'package-lock.json'))
console.error('npm ci --omit=dev …')
sh('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts=false'], { cwd: deps, stdio: ['ignore', 'ignore', 'inherit'] })
renameSync(path.join(deps, 'node_modules'), path.join(stage, 'node_modules'))
execFileSync('node', ['-e', "const D=require('better-sqlite3');new D(':memory:').prepare('select 1').get()"], { cwd: stage, stdio: 'inherit' })

// 3. native binaries for other platforms never load on the phone: drop them (liteparse ships an x64 one in its main package)
const pruned = []
const prune = (rel) => {
  for (const e of readdirSync(path.join(stage, rel), { withFileTypes: true })) {
    const r = `${rel}/${e.name}`
    if (e.isDirectory()) prune(r)
    else if (e.isFile() && /\.node$/.test(e.name) && /(x64|x86_64|ia32|musl|darwin|win32|android)/i.test(r)) { unlinkSync(path.join(stage, r)); pruned.push(r) }
  }
}
prune('node_modules')
console.error(`pruned ${pruned.length} foreign native binaries: ${pruned.join(', ')}`)

// 4. no DDL outside the fingerprinted schema files
const ddl = ddlOutsideSchema(stage)
if (ddl.length) fail(`DDL outside the schema files (add them to SCHEMA_FILES in android-engine-format.mjs and EngineSignature's docs): ${ddl.join(', ')}`)

// 5. the package manifest: a real npm package for linux-arm64 glibc with everything bundled
const pkg = {
  name: lock.package,
  version,
  license: src.license,
  description: 'Tangu engine for Forsion on Android (linux-arm64, glibc), with its dependencies; runs inside the app\'s local environment.',
  repository: { type: 'git', url: 'git+https://github.com/Changan-Su/Forsion.git', directory: 'tangu-agent' },
  type: src.type,
  main: src.main,
  dependencies: src.dependencies,
  bundleDependencies: Object.keys(src.dependencies),
  os: ['linux'],
  cpu: ['arm64'],
  libc: ['glibc'],
  engines: { node: '>=24 <25' },
  files: ['dist', 'skills', 'agent-skills', SIGNED_FILE, SIG_FILE],
  forsion: { line: lock.line, platform: 'android-arm64' },
  publishConfig: { access: 'public' },
}
writeFileSync(path.join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

// 6. exactly what npm pack ships (placeholders for the two signature files so they are listed too)
writeFileSync(path.join(stage, SIGNED_FILE), '{}')
writeFileSync(path.join(stage, SIG_FILE), '')
const packList = () => new Set(JSON.parse(sh('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: stage }))[0].files.map((f) => f.path))
// npm honours each bundled dependency's own `files`, which leaves out what its install script built (better-sqlite3's
// build/Release/*.node). Every file on disk of a dependency that npm does ship must ship: such files are added to that
// dependency's `files`. Packages npm does not consider part of the bundle at all are left out (reported).
const onDisk = []
const walkDisk = (rel) => {
  for (const e of readdirSync(path.join(stage, rel), { withFileTypes: true })) {
    const r = `${rel}/${e.name}`
    if (e.isDirectory()) walkDisk(r)
    else if (e.isFile()) onDisk.push(r)
  }
}
walkDisk('node_modules')
let listed = packList()
const pkgRoot = (r) => {
  for (let d = path.posix.dirname(r); d.startsWith('node_modules/'); d = path.posix.dirname(d)) {
    if (existsSync(path.join(stage, d, 'package.json')) && /node_modules\/(@[^/]+\/)?[^/]+$/.test(d)) return d
  }
  return null
}
const addTo = new Map()
const outside = new Set()
for (const r of onDisk) {
  if (listed.has(r) || path.posix.basename(r) === '.package-lock.json') continue
  const root = pkgRoot(r)
  if (!root || !listed.has(`${root}/package.json`)) { outside.add(root || r); continue }
  if (!addTo.has(root)) addTo.set(root, [])
  addTo.get(root).push(path.posix.relative(root, r))
}
for (const [root, add] of addTo) {
  const f = path.join(stage, root, 'package.json')
  const pj = JSON.parse(readFileSync(f, 'utf8'))
  if (!Array.isArray(pj.files)) fail(`${root}: files missing from the pack although it has no files list: ${add.slice(0, 5).join(', ')}`)
  pj.files = [...pj.files, ...add]
  writeFileSync(f, JSON.stringify(pj, null, 2) + '\n')
  console.error(`${root}: shipping ${add.length} install-time file(s) its files list leaves out: ${add.slice(0, 5).join(', ')}`)
}
if (outside.size) console.error(`not part of the bundle (npm leaves them out; not shipped): ${[...outside].join(', ')}`)
listed = packList()
const stillMissing = onDisk.filter((r) => !listed.has(r) && path.posix.basename(r) !== '.package-lock.json' && !outside.has(pkgRoot(r) || r))
if (stillMissing.length) fail(`files npm would still leave out: ${stillMissing.slice(0, 10).join(', ')}`)
const rels = [...listed].filter((p) => p !== SIGNED_FILE && p !== SIG_FILE)
rmSync(stageDir, { recursive: true, force: true })
mkdirSync(stageDir, { recursive: true })
writeFileSync(path.join(stageDir, 'files.json'), JSON.stringify({ name: pkg.name, version, line: lock.line, files: rels }))
sh('tar', ['-cf', path.join(stageDir, 'stage.tar'), '-C', work, 'package'])
console.error(`staged ${rels.length} files`)
}

function runSign() {
const lock = JSON.parse(readFileSync(arg('--lock') || fail('--lock'), 'utf8'))
const expect = arg('--expect-key') || fail('--expect-key <hex>: the public key the APK pins')
const pem = process.env.ANDROID_ENGINE_SIGNING_KEY
if (!pem || !pem.trim()) fail('no signing key (ANDROID_ENGINE_SIGNING_KEY): an unsigned engine is refused by every phone')
const key = createPrivateKey(pem)
const pub = createPublicKey(key)
if (rawPublicHex(pub) !== expect) fail(`the signing key's public half is ${rawPublicHex(pub)}, but the APK pins ${expect}: every phone would refuse this package`)
const meta = JSON.parse(readFileSync(path.join(stageDir, 'files.json'), 'utf8'))
if (meta.name !== lock.package || meta.line !== lock.line) fail('stage was made for another package / line')
const version = meta.version
const rels = meta.files
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
sh('tar', ['-xf', path.join(stageDir, 'stage.tar'), '-C', work])
// the stage was made where dependency scripts ran: its root may hold only what the packer put there (no .npmrc & co.)
const allowed = new Set(['dist', 'skills', 'agent-skills', 'node_modules', 'package.json', 'LICENSE', SIGNED_FILE, SIG_FILE])
const strays = readdirSync(stage).filter((f) => !allowed.has(f))
if (strays.length || readdirSync(work).join() !== 'package') fail(`unexpected entries in the stage: ${strays.join(', ') || readdirSync(work).join()}`)
const pkg = JSON.parse(readFileSync(path.join(stage, 'package.json'), 'utf8'))
const { bytes, sig, table } = signTable(stage, rels, { name: pkg.name, version, line: lock.line }, key)
writeFileSync(path.join(stage, SIGNED_FILE), bytes)
writeFileSync(path.join(stage, SIG_FILE), sig + '\n')

// 7. pack, then check the tarball itself (no package code runs: --ignore-scripts, and the tree has no scripts of its own)
mkdirSync(out, { recursive: true })
for (const f of readdirSync(out)) if (f.endsWith('.tgz')) unlinkSync(path.join(out, f))
const packed = JSON.parse(sh('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', out], { cwd: stage }))[0]
const tgz = path.join(out, packed.filename)
const check = path.join(work, 'check')
mkdirSync(check)
sh('tar', ['-xzf', tgz, '-C', check])
if (readdirSync(check).join() !== 'package') fail('tarball root is not package/')
const bad = verifyDir(path.join(check, 'package'), pub, { name: pkg.name, version, line: lock.line })
if (bad) fail(`the packed tarball does not verify: ${bad}`)

const summary = {
  tgz, name: pkg.name, version, line: lock.line, distTag: `android-${lock.line}`, files: Object.keys(table.files).length,
  size: statSync(tgz).size, unpackedSize: Object.values(table.files).reduce((a, [, n]) => a + n, 0),
  schemaFingerprint: table.schemaFingerprint, publicKey: rawPublicHex(pub), context: JSON.stringify(CONTEXT),
}
console.log(JSON.stringify(summary))
}

async function runBoot() {
const tgz = readdirSync(out).filter((f) => f.endsWith('.tgz'))
if (tgz.length !== 1) fail(`expected one tarball in ${out}, found ${tgz.length}`)
const check = path.join(work, 'boot')
rmSync(check, { recursive: true, force: true })
mkdirSync(check, { recursive: true })
sh('tar', ['-xzf', path.join(out, tgz[0]), '-C', check])
await bootCheck(path.join(check, 'package'))
}

async function bootCheck(dir) {
  const home = path.join(work, 'boot-home')
  mkdirSync(path.join(home, '.tangu'), { recursive: true })
  const child = spawn('node', ['dist/standalone/main.js', '--port', '0', '--host', '127.0.0.1'], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: home, TANGU_HOME: path.join(home, '.tangu'), TANGU_LOCAL_TOKEN: 'boot-check', TANGU_SANDBOX: 'none',
      TANGU_PHONE: '1', TANGU_BROWSER_EXTENSION: '0', NODE_ENV: 'production', TANGU_READY_LINE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let buf = ''
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no TANGU_READY line in 90 s:\n${buf.slice(-2000)}`)), 90_000)
    const on = (d) => {
      buf += d
      const m = buf.match(/^TANGU_READY (\{.*\})$/m)
      if (m) { clearTimeout(t); resolve(JSON.parse(m[1]).port) }
    }
    child.stdout.on('data', on)
    child.stderr.on('data', on)
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`engine exited ${c} before ready:\n${buf.slice(-2000)}`)) })
  }).catch((e) => { child.kill('SIGKILL'); fail(e.message) })
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/agent/sessions?limit=1', headers: { authorization: 'Bearer boot-check' } }, (r) => { r.resume(); resolve(r.statusCode) }).on('error', () => resolve(-1))
  })
  child.kill('SIGTERM')
  if (status !== 200) fail(`engine from the tarball answered ${status} on an authed call`)
  console.error(`boot check: ready on ${port}, authed call 200`)
}
