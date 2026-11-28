// #928 B1 app-level: start() / stop() the installed local engine N times through the native plugin and record, per
// cycle, how many spawn attempts it took and what each failed attempt printed (logcat tag LocalEngine).
// Usage (in mobile/): ANDROID_SERIAL=emulator-5584 N=30 GAP=0 node scripts/local-engine/proot-brk-probe/app-loop.cjs <out.json>
// Needs the environment installed (local-engine-emu.cjs with KEEP=1, or the UI bench) and the APK under test installed.
// Calls are fired and the state polled: a start can take longer than one CDP evaluation may wait.
const path = require('node:path')
const fs = require('node:fs')
const LIB = path.join(__dirname, '../../lib')
const OUT = process.argv[2]
const { adb, connect, pause } = require(path.join(LIB, 'emu-cdp.cjs'))
const { fakeJwt } = require(path.join(LIB, 'local-engine-fixtures.cjs'))
const PKG = 'com.forsion.tangu'
const N = Number(process.env.N || 30)
const GAP = Number(process.env.GAP || 0) // ms between stop and the next start
const USER = process.env.USER_ID || 'emu-bench-a'

const plug = (cdp, call, args = {}) => cdp.eval(`Capacitor.Plugins.ForsionLocalEngine.${call}(${JSON.stringify(args)}).then((r) => r, (e) => ({ rejected: e.code || e.message }))`)
const fire = (cdp, call) => cdp.eval(`(Capacitor.Plugins.ForsionLocalEngine.${call}().catch(() => {}), true)`)
async function waitState(cdp, pred, ms) {
  const end = Date.now() + ms; let s
  while (Date.now() < end) { s = await plug(cdp, 'state'); if (pred(s)) return s; await pause(500) }
  return s
}

async function main() {
  adb('shell', 'am', 'force-stop', PKG)
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`)
  const cdp = await connect(PKG, 9351, 40000)
  await pause(2500)
  await cdp.eval(`Capacitor.Plugins.Preferences.set({ key: 'forsion_token', value: '${fakeJwt(USER)}' }).then(() => true)`)
  const s0 = await plug(cdp, 'state')
  if (!s0.installed) throw new Error('environment not installed: ' + JSON.stringify(s0))
  await fire(cdp, 'stop')
  await waitState(cdp, (x) => x.engine !== 'running', 60000)
  const cycles = []
  for (let i = 0; i < N; i++) {
    adb('logcat', '-c')
    const t0 = Date.now()
    await fire(cdp, 'start')
    const r = await waitState(cdp, (x) => x.engine === 'running' || x.engine === 'failed', 240000)
    const ms = Date.now() - t0
    const log = adb('logcat', '-d', '-v', 'time', '-s', 'LocalEngine:*')
    const fails = log.split('\n').filter((l) => /engine start attempt \d+ failed/.test(l))
    const ready = (log.match(/engine ready on attempt (\d+) in (\d+)ms/) || [])
    const df = (log.match(/double free[^\n]*/g) || [])
    const c = { i, ok: r && r.engine === 'running', ms, readyAttempt: ready[1] ? Number(ready[1]) : null, readyMs: ready[2] ? Number(ready[2]) : null,
      failedAttempts: fails.length, doubleFree: df.length, failLines: fails.map((l) => l.slice(0, 600)), result: r && r.engine, engineError: r && r.engineError }
    cycles.push(c)
    console.log(`#${i} ok=${c.ok} attempts=${c.readyAttempt ?? '-'} failed=${c.failedAttempts} df=${c.doubleFree} ${ms}ms ${c.ok ? '' : JSON.stringify(r).slice(0, 200)}`)
    await fire(cdp, 'stop')
    await waitState(cdp, (x) => x.engine !== 'running', 60000)
    if (GAP) await pause(GAP)
    fs.writeFileSync(OUT, JSON.stringify({ N, GAP, cycles }, null, 1))
  }
  const spawns = cycles.reduce((a, c) => a + c.failedAttempts + (c.readyAttempt ? 1 : 0), 0)
  const crashed = cycles.reduce((a, c) => a + c.failedAttempts, 0)
  const df = cycles.reduce((a, c) => a + c.doubleFree, 0)
  console.log(`cycles=${N} gap=${GAP}ms started=${cycles.filter((c) => c.ok).length}/${N} spawns=${spawns} failedSpawns=${crashed} doubleFreeLines=${df}`)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
