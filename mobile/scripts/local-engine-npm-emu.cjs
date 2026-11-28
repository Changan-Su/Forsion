/**
 * Emulator bench for the npm engine (mobile/android/local-engine/README.md): base from the APK, engine from a
 * registry-shaped local server (two registries on one port: /m = "npmmirror", /o = "registry.npmjs.org"), reached over
 * `adb reverse` at 127.0.0.1 (debug builds allow loopback http). Drives the native plugin directly; judges only by what
 * the servers saw, the plugin's state, files in the app's data and logcat.
 *
 *   mirror 404 → official answers · mirror 302 → "CDN" with Range on every hop · pause / resume with Range · base from the
 *   asset · signature check · self-test · start → running · stale mirror tag → official's newer version · tampered
 *   tarball refused, old engine untouched · a crash-looping engine marked bad after 3 failed starts · rollback refused
 *   for the account its newer schema touched, allowed for an account it never touched · history from a newer engine
 *   (device transfer) → needs_update, nothing spawned · unreadable history → refused · reset keeps a verified engine.
 *
 * Before: AVD booted (arm64); APK built with
 *   ./gradlew :app:assembleDebug -PlocalEngine -PlocalEngineTestKey=<bench test key hex>
 * packages from mobile/scripts/local-engine/make-bench-packages.mjs (PKGS = its out dir).
 *
 *   ANDROID_SERIAL=emulator-5584 PKGS=<dir> APK=<apk> node scripts/local-engine-npm-emu.cjs
 */
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { adb, connect, pause } = require('./lib/emu-cdp.cjs')
const { startFixtures, fakeJwt, accountDirs, accountKey } = require('./lib/local-engine-fixtures.cjs')

const APP = 'com.forsion.tangu'
const NAME = '@forsion/tangu-engine-android-arm64'
const BASENAME = 'tangu-engine-android-arm64'
const PKGS = process.env.PKGS
const PORT = 18910
const THROTTLE = Number(process.env.THROTTLE || 2 * 1024 * 1024)
if (!PKGS || !fs.existsSync(path.join(PKGS, '2.14.10.tgz'))) { console.error('PKGS must point at make-bench-packages.mjs output'); process.exit(2) }

const results = []
const ok = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`) }

// ── the registries ──
const reg = {
  m: { tags: null, files: {}, redirect: true, withSize: true }, // null tags = package not synced yet (404)
  o: { tags: null, files: {}, redirect: false, withSize: false },
}
const served = []
const tgz = (v) => path.join(PKGS, `${v}.tgz`)
function sendFile(req, res, file) {
  const size = fs.statSync(file).size
  let start = 0, end = size - 1, status = 200
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
  if (m) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1); status = 206 }
  if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end() }
  res.writeHead(status, { 'Content-Length': end - start + 1, 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) })
  const s = fs.createReadStream(file, { start, end, highWaterMark: 64 * 1024 })
  // resume only when neither the rate limit nor the socket holds it back (a 'drain' alone must not skip the limit)
  let sent = 0, waitRate = false, waitDrain = false
  const t0 = Date.now()
  const go = () => { if (!waitRate && !waitDrain) s.resume() }
  s.on('data', (chunk) => {
    sent += chunk.length
    if (!res.write(chunk)) { waitDrain = true; s.pause(); res.once('drain', () => { waitDrain = false; go() }) }
    const ahead = sent / THROTTLE * 1000 - (Date.now() - t0)
    if (ahead > 0) { waitRate = true; s.pause(); setTimeout(() => { waitRate = false; go() }, ahead) }
  })
  s.on('end', () => res.end())
  req.on('close', () => s.destroy())
}
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0])
  served.push({ t: Date.now(), url, range: req.headers.range || null })
  let m
  if ((m = /^\/cdn\/(.+\.tgz)$/.exec(url))) { // the mirror's CDN hop
    const f = reg.m.files[m[1]]
    if (!f) { res.writeHead(404); return res.end() }
    return sendFile(req, res, f)
  }
  if (!(m = /^\/(m|o)(\/.*)$/.exec(url))) { res.writeHead(404); return res.end() }
  const r = reg[m[1]], rest = m[2]
  if (rest === `/${NAME.replace('/', '%2f')}` || rest === `/${NAME}`) {
    if (!r.tags) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"not_found"}') }
    const versions = {}
    for (const v of Object.values(r.tags)) {
      const dist = { fileCount: 10449, unpackedSize: 129408211, integrity: 'sha512-ignored' }
      if (r.withSize && r.files[`${BASENAME}-${v}.tgz`]) dist.size = fs.statSync(r.files[`${BASENAME}-${v}.tgz`]).size
      versions[v] = { name: NAME, version: v, dist }
    }
    res.writeHead(200, { 'content-type': 'application/vnd.npm.install-v1+json' })
    return res.end(JSON.stringify({ name: NAME, 'dist-tags': r.tags, versions }))
  }
  if ((m = new RegExp(`^/${NAME}/-/(${BASENAME}-[0-9.]+\\.tgz)$`).exec(rest))) {
    const f = r.files[m[1]]
    if (!f) { res.writeHead(404); return res.end() }
    if (r.redirect) { res.writeHead(302, { Location: `/cdn/${m[1]}` }); return res.end() }
    return sendFile(req, res, f)
  }
  res.writeHead(404); res.end()
})
const publish = (side, version, file = tgz(version), tag = 'android-1') => {
  reg[side].files[`${BASENAME}-${version}.tgz`] = file
  reg[side].tags = { ...(reg[side].tags || {}), [tag]: version }
}

// ── app helpers ──
const plug = (cdp, call, args = {}) => cdp.eval(`Capacitor.Plugins.ForsionLocalEngine.${call}(${JSON.stringify(args)}).then((r) => r, (e) => ({ rejected: e.code || e.message }))`)
const signIn = (cdp, userId) => cdp.eval(`Capacitor.Plugins.Preferences.set({ key: 'forsion_token', value: '${fakeJwt(userId)}' }).then(() => true)`)
async function waitState(cdp, pred, timeoutMs, label) {
  const end = Date.now() + timeoutMs
  let s
  while (Date.now() < end) {
    s = await plug(cdp, 'state')
    if (pred(s)) return s
    await pause(1000)
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(s)}`)
}
const startAndWait = async (cdp) => {
  await cdp.eval(`(Capacitor.Plugins.ForsionLocalEngine.start().catch(() => {}), true)`)
  await pause(1500)
  return waitState(cdp, (x) => x.engine === 'running' || x.engine === 'failed', 240000, 'engine settled')
}
const runAs = (...args) => adb('shell', 'run-as', APP, ...args)
const sh = (cmd) => adb('shell', 'run-as', APP, 'sh', '-c', `'${cmd}'`)
const installed = () => { try { return JSON.parse(runAs('cat', 'files/local-engine/installed.json')) } catch { return null } }
const spawnCount = () => adb('logcat', '-d', '-s', 'LocalEngineProcess', 'LocalEngine').split('\n').filter((l) => /spawned proot/.test(l)).length
const logMark = () => spawnCount()
const spawnsSince = (mark) => spawnCount() - mark

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
  const fx = await startFixtures({ envDir: PKGS, throttle: THROTTLE }) // only its fake model (18901) is used; its file server (18900) is idle
  adb('reverse', `tcp:${PORT}`, `tcp:${PORT}`)
  if (process.env.APK) { console.log('installing', process.env.APK); adb('install', '-r', '-t', process.env.APK) }
  adb('shell', 'pm', 'grant', APP, 'android.permission.POST_NOTIFICATIONS')
  adb('shell', 'am', 'force-stop', APP)
  adb('logcat', '-c')
  adb('shell', 'am', 'start', '-n', `${APP}/.MainActivity`)
  let cdp = await connect(APP, 9351, 40000)
  await pause(2500)
  await signIn(cdp, 'npm-bench-a')
  const A = accountDirs('npm-bench-a'), B = accountDirs('npm-bench-b'), C = accountDirs('npm-bench-c')
  // a fresh environment and fresh accounts (the emulator may carry a half-configured dpkg from earlier runs)
  await plug(cdp, 'remove')
  await waitState(cdp, (x) => !x.installed && x.phase === 'idle', 60000, 'removed')
  runAs('rm', '-rf', 'files/local-engine', 'cache/local-engine')
  cdp.close()
  adb('shell', 'am', 'force-stop', APP)
  adb('shell', 'am', 'start', '-n', `${APP}/.MainActivity`)
  cdp = await connect(APP, 9351, 40000)
  await pause(2500)
  await signIn(cdp, 'npm-bench-a')
  const set = await plug(cdp, 'setRegistry', { url: `http://127.0.0.1:${PORT}/m,http://127.0.0.1:${PORT}/o` })
  let s = await plug(cdp, 'state')
  ok('test-channel APK: launcher + base asset → configured; nothing installed', s.available === true && s.configured === true && !s.installed && s.bundledBaseVersion, JSON.stringify({ set: !set.rejected, available: s.available, configured: s.configured, base: s.bundledBaseVersion }))

  // 1. the mirror has not synced yet (404): the official registry answers; npmjs sends no size → Range probe
  publish('o', '2.14.10')
  s = await plug(cdp, 'check')
  const goodSize = fs.statSync(tgz('2.14.10')).size
  ok('mirror 404 → official answers; size from a Range probe', s.availableEngineVersion === '2.14.10' && s.downloadBytes === goodSize, JSON.stringify({ v: s.availableEngineVersion, dl: s.downloadBytes, want: goodSize, unpacked: s.unpackedBytes }))

  // 2. the mirror catches up and redirects to its CDN; install from it with a pause in the middle
  publish('m', '2.14.10')
  s = await plug(cdp, 'check')
  ok('mirror answers first once synced (its packument carries the size)', s.availableEngineVersion === '2.14.10' && s.downloadBytes === goodSize, `dl ${s.downloadBytes}`)
  const mark0 = served.length
  const t0 = Date.now()
  await plug(cdp, 'install')
  await waitState(cdp, (x) => x.phase === 'downloading' && x.done > 4 * 1024 * 1024, 180000, 'download progress')
  await plug(cdp, 'pause')
  const paused = await waitState(cdp, (x) => x.phase === 'paused', 30000, 'paused')
  ok('pause keeps the partial download', paused.resumeBytes > 0 && /\.part/.test(runAs('ls', 'cache/local-engine/downloads')), `resumeBytes=${paused.resumeBytes}`)
  const mark1 = served.length
  await plug(cdp, 'resume')
  const done = await waitState(cdp, (x) => (x.installed && x.phase === 'idle') || x.phase === 'failed', 900000, 'installed')
  const first = served.slice(mark0, mark1)
  const after = served.slice(mark1)
  const hop = after.find((r) => r.url.startsWith('/m/') && /\.tgz$/.test(r.url) && r.range)
  const cdn = after.find((r) => r.url.startsWith('/cdn/') && r.range && /^bytes=[1-9]/.test(r.range))
  ok('mirror tarball: 302 → CDN, Range sent again on the CDN hop', first.some((r) => r.url.startsWith('/m/') && /\.tgz$/.test(r.url)) && first.some((r) => r.url.startsWith('/cdn/')) && !!hop && !!cdn && hop.range === cdn.range, `${hop && hop.range} → ${cdn && cdn.range}`)
  ok('install: base from the APK + engine from npm, verified, self-tested', done.installed === true && done.phase === 'idle' && done.engineVersion === '2.14.10', `${Math.round((Date.now() - t0) / 1000)}s ${JSON.stringify({ phase: done.phase, error: done.error, engine: done.engineVersion, base: done.baseVersion })}`)
  const log = adb('logcat', '-d', '-s', 'LocalEngine')
  ok('the base came from the asset (no base download), the extractor refused nothing', /unpacked base files=/.test(log) && !served.some((r) => /base/.test(r.url)) && !/skippedUnsafe=[1-9]|errors=[1-9]/.test(log), (log.match(/unpacked (base|engine)[^\n]{0,90}/g) || []).join(' | '))
  const inst = installed()
  ok('installed.json schema 2: engine in engines/<version>, outside the rootfs', inst && inst.schema === 2 && inst.engine.version === '2.14.10' && /main\.js/.test(runAs('ls', 'files/local-engine/engines/2.14.10/dist/standalone/main.js')) && runAs('ls', '-A', 'files/local-engine/rootfs/opt/tangu').trim() === '', JSON.stringify(inst && inst.engine))
  ok('self-test ran on the throwaway data (passed)', /self-test passed/.test(log), (log.match(/self-test passed[^\n]*/) || [''])[0])

  // 3. a real start; the account's history gets the engine before it runs
  const cfg = JSON.stringify({ providers: [{ providerId: 'emu', baseUrl: 'http://10.0.2.2:18901/v1', apiKey: 'x', modelIds: ['echo'] }] })
  for (const d of [A, B]) sh(`mkdir -p ${d.home} && echo ${Buffer.from(cfg).toString('base64')} | base64 -d > ${d.home}/config.json`)
  let st = await startAndWait(cdp)
  const floorA = () => { try { return JSON.parse(runAs('cat', `files/local-engine/accounts/${accountKey('npm-bench-a')}/engine-floor.json`)) } catch (e) { return null } }
  ok('start → running; the account history records 2.14.10 (outside home)', st.engine === 'running' && floorA() && floorA().engines.map((e) => e.version).join() === '2.14.10', `${st.engineError || ''} ${JSON.stringify(floorA())}`)
  ok('/opt/tangu inside the environment is the bound engine tree', /2\.14\.10/.test((await plug(cdp, 'shell', { cmd: 'node -p "require(\'/opt/tangu/package.json\').version"', timeout: 60 })).out || ''))
  await plug(cdp, 'stop')

  // 4. a stale mirror (tag → 2.14.9, below the APK minimum) while the official registry has 2.14.11
  publish('m', '2.14.9')
  publish('o', '2.14.11')
  s = await plug(cdp, 'check')
  ok('stale mirror tag (2.14.9 < minimum) → the official 2.14.11 is offered', s.updateAvailable === true && s.availableEngineVersion === '2.14.11', JSON.stringify({ v: s.availableEngineVersion, up: s.updateAvailable }))

  // 5. a mirror that serves tampered bytes for 2.14.11: refused, the official copy is good → installed from there
  publish('m', '2.14.11', tgz('2.14.11-tampered'))
  s = await plug(cdp, 'check')
  const mark2 = served.length
  await plug(cdp, 'update')
  let u = await waitState(cdp, (x) => (x.phase === 'idle' && x.engineVersion === '2.14.11') || x.phase === 'failed', 600000, 'updated')
  const l2 = adb('logcat', '-d', '-s', 'LocalEngine')
  ok('tampered tarball from the mirror refused; the official one installs', u.engineVersion === '2.14.11' && /refused: hash node_modules\/better-sqlite3\/lib\/database\.js/.test(l2) && served.slice(mark2).some((r) => r.url.startsWith('/o/') && /2\.14\.11\.tgz$/.test(r.url)), (l2.match(/refused: [^\n]*/) || [''])[0])
  const inst2 = installed()
  ok('previous engine kept for rollback; nothing else', inst2.previous && inst2.previous.version === '2.14.10' && runAs('ls', 'files/local-engine/engines').trim().split(/\s+/).sort().join() === '2.14.10,2.14.11', runAs('ls', 'files/local-engine/engines').replace(/\s+/g, ' '))

  // 6. tampered everywhere: refused, the installed engine is untouched and still starts
  publish('m', '2.14.13', tgz('2.14.11-tampered'))
  publish('o', '2.14.13', tgz('2.14.11-tampered'))
  await plug(cdp, 'check')
  await plug(cdp, 'update')
  u = await waitState(cdp, (x) => x.phase === 'failed' || (x.phase === 'idle' && x.engineVersion !== '2.14.11'), 600000, 'refused')
  ok('a tarball for another version on every registry → refused (error "signature"), engine unchanged', u.phase === 'failed' && u.error === 'signature' && u.engineVersion === '2.14.11', JSON.stringify({ phase: u.phase, error: u.error, engine: u.engineVersion }))
  st = await startAndWait(cdp)
  ok('…and the installed engine still starts', st.engine === 'running', st.engineError || '')
  await plug(cdp, 'stop')

  // 6b. a symlink entry in the tarball: refused while unpacking (strict extractor), nothing written through it
  publish('m', '2.14.12', tgz('2.14.12-linked'))
  publish('o', '2.14.12', tgz('2.14.12-linked'))
  await plug(cdp, 'check')
  await plug(cdp, 'update')
  u = await waitState(cdp, (x) => x.phase === 'failed' || (x.phase === 'idle' && x.engineVersion !== '2.14.11'), 600000, 'refused link')
  const l6 = adb('logcat', '-d', '-s', 'LocalEngine')
  ok('a tarball with a link entry is refused while unpacking; engine unchanged', u.phase === 'failed' && u.error === 'unpack' && u.engineVersion === '2.14.11' && /link or special entry/.test(l6), (l6.match(/does not unpack[^\n]*|link or special entry[^\n]*/) || [''])[0].slice(0, 160))

  // 7. 2.14.13: other schema code and it crashes on real starts (not in the self-test) → bad after 3 failed starts
  publish('m', '2.14.13', tgz('2.14.13'))
  publish('o', '2.14.13', tgz('2.14.13'))
  await plug(cdp, 'check')
  await plug(cdp, 'update')
  u = await waitState(cdp, (x) => (x.phase === 'idle' && x.engineVersion === '2.14.13') || x.phase === 'failed', 600000, 'updated to 2.14.13')
  ok('2.14.13 passes the self-test and installs', u.engineVersion === '2.14.13' && u.phase === 'idle', JSON.stringify({ phase: u.phase, error: u.error }))
  sh(`touch ${A.home}/.crash-me && touch ${B.home}/.crash-me`)
  const fails = []
  for (let i = 0; i < 3; i++) { const r = await startAndWait(cdp); fails.push(r.engineError || r.engine) }
  const bad = await plug(cdp, 'state')
  ok('three failed starts mark 2.14.13 bad', bad.engineBad === true && (installed().bad || []).includes('2.14.13') && fails[2] === 'engine_bad', `${fails.join(' / ')} health=${runAs('cat', 'files/local-engine/engine-health.json 2>/dev/null || true').trim()}`)
  ok('the history of account A records 2.14.13 (before its first spawn)', floorA().engines.map((e) => e.version).join() === '2.14.10,2.14.11,2.14.13', JSON.stringify(floorA().engines.map((e) => e.version)))

  // 8. rollback for A: 2.14.11 has other schema code than 2.14.13, which ran on A's data → refused, nothing spawned
  const markA = logMark()
  await pause(1100)
  let r = await startAndWait(cdp)
  ok('account A: rollback to 2.14.11 refused (a newer engine with other schema code touched its data); nothing spawned', r.engine === 'failed' && r.engineError === 'engine_bad' && r.needsUpdate === true && spawnsSince(markA) === 0, `${r.engineError} spawns=${spawnsSince(markA)}`)

  // 9. account B never ran 2.14.13 (its marker only makes 2.14.13 crash): rollback to 2.14.11 allowed, per account
  sh(`rm -f ${B.home}/.crash-me`)
  await signIn(cdp, 'npm-bench-b')
  await pause(1500)
  r = await startAndWait(cdp)
  const lb = adb('logcat', '-d', '-s', 'LocalEngine')
  ok('account B: the previous engine starts (its history never saw 2.14.13)', r.engine === 'running' && /starting the previous 2\.14\.11/.test(lb), r.engineError || '')
  await plug(cdp, 'stop')

  // 10. data from a newer engine (device transfer): history says 9.9.9 with other schema code → needs_update, nothing spawned
  const kc = accountKey('npm-bench-c')
  const hist = JSON.stringify({ schema: 1, engines: [{ version: '9.9.9', fingerprint: 'f'.repeat(64) }] })
  sh(`mkdir -p files/local-engine/accounts/${kc} && echo ${Buffer.from(hist).toString('base64')} | base64 -d > files/local-engine/accounts/${kc}/engine-floor.json`)
  await signIn(cdp, 'npm-bench-c')
  await pause(1500)
  const markC = logMark()
  await pause(1100)
  r = await startAndWait(cdp)
  ok('account C (history from a newer engine): engine_bad / needs update, nothing spawned', r.engine === 'failed' && r.needsUpdate === true && spawnsSince(markC) === 0, `${r.engineError} spawns=${spawnsSince(markC)}`)

  // 11. an unreadable history refuses (unknown is not empty) and is not overwritten
  sh(`echo "{not json" > files/local-engine/accounts/${kc}/engine-floor.json`)
  r = await startAndWait(cdp)
  ok('unreadable history → refused, left as it was', r.engine === 'failed' && /bad, needs|history|engine_bad/.test(r.engineError) && runAs('cat', `files/local-engine/accounts/${kc}/engine-floor.json`).trim() === '{not json', r.engineError)

  // 12. reset: rebuilds the base from the APK, keeps the engine that still verifies (no download)
  await signIn(cdp, 'npm-bench-b')
  const mark3 = served.length
  await plug(cdp, 'install', { reset: true })
  u = await waitState(cdp, (x) => (x.phase === 'idle' && x.installed) || x.phase === 'failed', 600000, 'reset')
  ok('reset rebuilds the base and keeps the verified engine (no tarball fetched)', u.phase === 'idle' && u.engineVersion === '2.14.13' && !served.slice(mark3).some((x) => /\.tgz$/.test(x.url)), JSON.stringify({ phase: u.phase, error: u.error, engine: u.engineVersion }))
  ok('a base swap clears the bad marks (the crash may have been the base)', (installed().bad || []).length === 0, JSON.stringify(installed().bad))

  // 13. the current engine is good again (base swap cleared the marks); account C's history is from a newer engine → needs_update
  sh(`echo ${Buffer.from(hist).toString('base64')} | base64 -d > files/local-engine/accounts/${kc}/engine-floor.json`)
  await signIn(cdp, 'npm-bench-c')
  await pause(1500)
  const markD = logMark()
  r = await startAndWait(cdp)
  ok('history from a newer engine (device transfer), current engine good → needs_update, nothing spawned', r.engine === 'failed' && r.engineError === 'needs_update' && r.needsUpdate === true && spawnsSince(markD) === 0, `${r.engineError} spawns=${spawnsSince(markD)}`)

  cdp.close()
  fx.close()
  server.close()
  const failed = results.filter((x) => !x.pass)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
