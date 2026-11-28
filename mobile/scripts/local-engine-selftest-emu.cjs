/**
 * 「这台手机」更新时的真启动自检（#928 B3）：一个过不了自检的引擎层（不打机器可读就绪行）在更新时必须被拒，
 * 拒的理由是等不到就绪行（超时）而不是崩溃；旧环境原样留着、能照常拉起。好的引擎层照常更新上去。
 *
 * 前置：本分支的测试渠道包已装，本分支的环境已装（先跑 local-engine-emu.cjs）。
 * 用法（在 mobile/ 下）：
 *   ANDROID_SERIAL=emulator-5584 node scripts/local-engine-selftest-emu.cjs <好的环境包目录> <不打就绪行的旧引擎层 .tar.xz> <工作目录>
 *   好的环境包 = build-env.sh 用本分支的 tangu-agent 出的；旧引擎层 = 本分支之前的 build-env.sh 产物里的 engine-*.tar.xz
 */
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const LIB = path.join(__dirname, 'lib')
const [GOOD, OLD_ENGINE, WORK] = process.argv.slice(2)
const { adb, connect, pause } = require(path.join(LIB, 'emu-cdp.cjs'))
const { startFixtures, fakeJwt } = require(path.join(LIB, 'local-engine-fixtures.cjs'))
const PKG = 'com.forsion.tangu'
const PHONE_ID = '00000000-0000-4000-8000-000000000001'
const results = []
const ok = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`) }
const plug = (cdp, call, args = {}) => cdp.eval(`Capacitor.Plugins.ForsionLocalEngine.${call}(${JSON.stringify(args)}).then((r) => r, (e) => ({ rejected: e.code || e.message }))`)
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
async function waitState(cdp, pred, ms, label) {
  const end = Date.now() + ms; let s
  while (Date.now() < end) { s = await plug(cdp, 'state'); if (pred(s)) return s; await pause(1000) }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(s)}`)
}
const relayHealth = (cdp) => cdp.eval(`new Promise((resolve) => { const parts = []; let head = null
  Capacitor.Plugins.ForsionUnit.request({ id: 'b3' + Date.now(), unitId: '${PHONE_ID}', path: '/engine/health', method: 'GET', headers: {}, body: null }, (m, err) => {
    if (err) return resolve({ error: String(err.message || err) })
    if (m.type === 'head') head = m; else if (m.type === 'chunk') parts.push(atob(m.b64))
    else if (m.type === 'end') resolve({ status: head && head.status, text: parts.join('') }); else if (m.type === 'error') resolve({ error: m.code }) }) })`)

/** Serve WORK with the good base and the given engine file under a manifest version of our choosing. */
function stage(engineFile, version) {
  const m = JSON.parse(fs.readFileSync(path.join(GOOD, 'manifest.json'), 'utf8'))
  const name = `engine-${version}.tar.xz`
  if (!fs.existsSync(path.join(WORK, name))) fs.linkSync(engineFile, path.join(WORK, name))
  m.engine = { ...m.engine, version, url: name, sha256: sha(engineFile), size: fs.statSync(engineFile).size }
  fs.writeFileSync(path.join(WORK, 'manifest.json'), JSON.stringify(m, null, 2))
}

async function startAndCheck(cdp, label) {
  let starts = 0, r
  for (; starts < 3; ) { starts++; r = await plug(cdp, 'start'); if (r && r.engine === 'running') break }
  const h = r && r.engine === 'running' ? await relayHealth(cdp) : null
  ok(`${label}: the environment starts and answers /health`, !!h && h.status === 200, `start() calls=${starts} ${h ? h.status + ' ' + String(h.text).slice(0, 90) : JSON.stringify(r).slice(0, 160)}`)
  await plug(cdp, 'stop')
}

async function main() {
  fs.mkdirSync(WORK, { recursive: true })
  const base = JSON.parse(fs.readFileSync(path.join(GOOD, 'manifest.json'), 'utf8')).base.url
  if (!fs.existsSync(path.join(WORK, base))) fs.linkSync(path.join(GOOD, base), path.join(WORK, base))
  const goodEngine = path.join(GOOD, JSON.parse(fs.readFileSync(path.join(GOOD, 'manifest.json'), 'utf8')).engine.url)
  stage(goodEngine, 'staging')
  const fx = await startFixtures({ envDir: WORK, throttle: 64 * 1024 * 1024 })
  adb('shell', 'am', 'force-stop', PKG)
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`)
  const cdp = await connect(PKG, 9351, 40000)
  await pause(2500)
  await cdp.eval(`Capacitor.Plugins.Preferences.set({ key: 'forsion_token', value: '${fakeJwt('emu-bench-a')}' }).then(() => true)`)
  const s0 = await plug(cdp, 'state')
  ok('precondition: #930 environment installed', s0.installed === true, `engine=${s0.engineVersion}`)
  const before = s0.engineVersion

  // ① bad layer: the #921 engine prints no TANGU_READY line → the real-start self-test must refuse it
  stage(OLD_ENGINE, '2.14.10-noready')
  let s = await plug(cdp, 'check')
  ok('bad layer is offered as an update', s.updateAvailable === true, `available=${s.availableEngineVersion}`)
  adb('logcat', '-c')
  const t1 = Date.now()
  await plug(cdp, 'update')
  s = await waitState(cdp, (x) => x.phase === 'idle' || x.phase === 'failed', 600000, 'bad update finished')
  const log1 = adb('logcat', '-d', '-v', 'time', '-s', 'LocalEngine:*')
  const why = (log1.match(/update failed[^\n]*/) || [''])[0]
  const st1 = (log1.match(/self-test (attempt \d+ failed|passed)[^\n]*/g) || []).map((l) => l.slice(0, 160))
  const df1 = (log1.match(/double free/g) || []).length
  // the refusal must come from the missing ready line (a timeout), not from a B1 crash
  ok('bad layer: update refused by the self-test for want of a ready line', s.phase === 'failed' && /self-test attempt 1 failed: timeout/.test(log1) && df1 === 0,
    `${Math.round((Date.now() - t1) / 1000)}s phase=${s.phase} error=${s.error || ''} doubleFree=${df1} | ${st1.join(' | ')} | ${why.slice(0, 200)}`)
  ok('bad layer: the previous engine is still installed', s.installed === true && s.engineVersion === before, `engine=${s.engineVersion}`)
  const ls1 = adb('shell', 'run-as', PKG, 'ls', 'files/local-engine')
  ok('bad layer: no self-test leftovers, no pending swap', !/selftest|pending\.json/.test(ls1), ls1.replace(/\s+/g, ' '))
  await startAndCheck(cdp, 'after the refused update')

  // ② good layer: the #930 engine under a new version → update goes through
  stage(goodEngine, '2.14.10-good')
  s = await plug(cdp, 'check')
  adb('logcat', '-c')
  const t2 = Date.now()
  await plug(cdp, 'update')
  s = await waitState(cdp, (x) => x.phase === 'idle' || x.phase === 'failed', 600000, 'good update finished')
  const log2 = adb('logcat', '-d', '-v', 'time', '-s', 'LocalEngine:*')
  const att = (log2.match(/engine start attempt \d+ failed[^\n]*/g) || []).map((l) => l.slice(0, 160))
  const st2 = (log2.match(/self-test (attempt \d+ failed|passed)[^\n]*/g) || []).map((l) => l.slice(0, 160))
  ok('good layer: update goes through (real-start self-test passes)', s.phase === 'idle' && s.engineVersion === '2.14.10-good', `${Math.round((Date.now() - t2) / 1000)}s engine=${s.engineVersion} error=${s.error || ''} | ${st2.join(' | ')} ${att.join(' | ')}`)
  await startAndCheck(cdp, 'after the good update')

  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed`)
  fx.close && fx.close()
  process.exit(results.every((r) => r.pass) ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
