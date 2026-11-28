// #928 B1 app-level: start() / stop() the installed local engine N times through the native plugin and record, per
// cycle, how many spawn attempts it took and what each failed attempt printed (logcat tag LocalEngine).
// Usage (in mobile/): ANDROID_SERIAL=emulator-5584 N=30 GAP=0 node scripts/local-engine/proot-brk-probe/app-loop.cjs <out.json>
// Needs the environment installed (local-engine-emu.cjs with KEEP=1, or the UI bench) and the APK under test installed.
// Emulator test installs only: it signs the app in with a bench token for the run (the previous one is put back after).
// Each start() is fired and its own result polled (one CDP evaluation waits 20 s at most, a start can take longer):
// the call resolves only after the native side has logged which attempt got healthy, so every cycle counts its own
// spawns, never the previous cycle's state. Exit code 1 when a cycle did not start or its log is missing.
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
const P = 'Capacitor.Plugins.ForsionLocalEngine'

const plug = (cdp, call, args = {}) => cdp.eval(`${P}.${call}(${JSON.stringify(args)}).then((r) => r, (e) => ({ rejected: e.code || e.message }))`)
// fire a call, then poll its own result
async function call(cdp, name, ms) {
  await cdp.eval(`(window.__b1c = null, ${P}.${name}().then((r) => { window.__b1c = { ok: r } }, (e) => { window.__b1c = { rejected: e.code || e.message } }), true)`)
  for (const end = Date.now() + ms; Date.now() < end; await pause(500)) {
    const r = await cdp.eval('window.__b1c')
    if (r) return r
  }
  return { timeout: true }
}

async function main() {
  if (!(N > 0)) throw new Error('N must be > 0')
  adb('shell', 'am', 'force-stop', PKG)
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`)
  const cdp = await connect(PKG, 9351, 40000)
  await pause(2500)
  const s0 = await plug(cdp, 'state')
  if (!s0.installed) throw new Error('environment not installed: ' + JSON.stringify(s0))
  const prevToken = await cdp.eval(`Capacitor.Plugins.Preferences.get({ key: 'forsion_token' }).then((r) => r.value)`)
  await cdp.eval(`Capacitor.Plugins.Preferences.set({ key: 'forsion_token', value: '${fakeJwt(USER)}' }).then(() => true)`)
  const cycles = []
  try {
    await call(cdp, 'stop', 60000)
    for (let i = 0; i < N; i++) {
      adb('logcat', '-c')
      const t0 = Date.now()
      const r = await call(cdp, 'start', 300000)
      const ms = Date.now() - t0
      const log = adb('logcat', '-d', '-v', 'time', '-s', 'LocalEngine:*')
      const fails = log.split('\n').filter((l) => /engine start attempt \d+ failed/.test(l))
      const ready = (log.match(/engine ready on attempt (\d+) in (\d+)ms/) || [])
      // one line per crashed spawn: the engine's own output (the failure summary repeats only its last lines)
      const df = log.split('\n').filter((l) => /engine> .*double free/.test(l)).length
      const started = !!(r.ok && r.ok.engine === 'running' && ready[1])
      const c = { i, ok: started, ms, readyAttempt: ready[1] ? Number(ready[1]) : null, readyMs: ready[2] ? Number(ready[2]) : null,
        failedAttempts: fails.length, doubleFreeSpawns: df, failLines: fails.map((l) => l.slice(0, 600)), result: r.ok ? r.ok.engine : (r.rejected || 'timeout') }
      cycles.push(c)
      console.log(`#${i} ok=${c.ok} attempts=${c.readyAttempt ?? '-'} failed=${c.failedAttempts} df=${c.doubleFreeSpawns} ${ms}ms ${c.ok ? '' : c.result}`)
      await call(cdp, 'stop', 60000)
      if (GAP) await pause(GAP)
      fs.writeFileSync(OUT, JSON.stringify({ N, GAP, cycles }, null, 1))
    }
  } finally {
    await call(cdp, 'stop', 60000)
    await cdp.eval(prevToken == null
      ? `Capacitor.Plugins.Preferences.remove({ key: 'forsion_token' }).then(() => true)`
      : `Capacitor.Plugins.Preferences.set({ key: 'forsion_token', value: ${JSON.stringify(prevToken)} }).then(() => true)`)
  }
  const spawns = cycles.reduce((a, c) => a + c.failedAttempts + (c.readyAttempt ? 1 : 0), 0)
  const crashed = cycles.reduce((a, c) => a + c.failedAttempts, 0)
  const df = cycles.reduce((a, c) => a + c.doubleFreeSpawns, 0)
  const ok = cycles.filter((c) => c.ok).length
  console.log(`cycles=${N} gap=${GAP}ms started=${ok}/${N} spawns=${spawns} failedSpawns=${crashed} doubleFreeSpawns=${df}`)
  process.exit(ok === N ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
