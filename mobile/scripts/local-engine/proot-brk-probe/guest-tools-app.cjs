// #928 B1: run guest-tools.sh's checks in the app's own context (the debug `shell` call: same launcher, same binds,
// and the app's network, which run-as does not have, so apt can reach the archive).
// Usage (in mobile/): ANDROID_SERIAL=emulator-5584 node scripts/local-engine/proot-brk-probe/guest-tools-app.cjs <out.txt>
// Debug build only. The call is fired and its result polled: one CDP evaluation waits 20 s at most, apt takes longer.
const path = require('node:path')
const fs = require('node:fs')
const LIB = path.join(__dirname, '../../lib')
const { adb, connect, pause } = require(path.join(LIB, 'emu-cdp.cjs'))
const PKG = 'com.forsion.tangu'

const script = [
  'echo "== bash"; echo $BASH_VERSION; for i in $(seq 1 2000); do a[$i]=$(printf %05d $i); done; echo ${#a[@]}',
  'echo "== apt-update"; apt-get update -qq 2>&1 | tail -3; echo "update exit=${PIPESTATUS[0]}"',
  'echo "== apt-install"; apt-get install -y -qq --no-install-recommends jq >/tmp/apt.log 2>&1; echo "install exit=$?"; tail -3 /tmp/apt.log; jq --version 2>&1; echo \'{"a":[1,2]}\' | jq -c .a 2>&1',
  'echo "== dpkg"; dpkg -s jq 2>&1 | grep -E "^Status"; dpkg --audit 2>&1 | head -3',
  'echo "== apt-remove"; apt-get remove -y -qq jq >/tmp/apt2.log 2>&1; echo "remove exit=$?"; tail -2 /tmp/apt2.log',
  'echo "== git"; rm -rf /tmp/r && git init -q /tmp/r && cd /tmp/r && echo hi > a && git add a && git -c user.email=b1@example.invalid -c user.name=b1 commit -qm one && git gc -q && git fsck --strict 2>&1 | tail -1; echo "log=$(git log --oneline | wc -l)"; cd /',
  'echo "== node-heap"; node -e "const a=[];for(let i=0;i<200;i++)a.push(Buffer.alloc(1<<20,i));let s=0;for(const b of a)s+=b[0];console.log(\'heap-ok\',s,process.memoryUsage().rss>>20)"',
  'echo "== npm"; cd /tmp && rm -rf np && mkdir np && cd np && npm init -y >/dev/null 2>&1 && npm install --no-audit --no-fund ms@2.1.3 2>&1 | tail -2; node -e "console.log(\'ms\', require(\'ms\')(60000))"; cd /',
].join('\n')

async function main() {
  adb('shell', 'am', 'force-stop', PKG)
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`)
  const cdp = await connect(PKG, 9351, 40000)
  await pause(2500)
  adb('logcat', '-c')
  await cdp.eval(`(window.__b1 = null, Capacitor.Plugins.ForsionLocalEngine.shell(${JSON.stringify({ cmd: script, timeout: 900 })}).then((r) => { window.__b1 = r }, (e) => { window.__b1 = { rejected: e.code || e.message } }), true)`)
  let r = null
  for (const end = Date.now() + 960000; !r && Date.now() < end; ) { await pause(3000); r = await cdp.eval('window.__b1') }
  const log = adb('logcat', '-d', '-v', 'time')
  const df = (log.match(/[^\n]*double free[^\n]*/g) || [])
  const out = `${r ? (r.out || JSON.stringify(r)) : 'NO RESULT'}\n== logcat double free lines: ${df.length}\n${df.join('\n')}\n`
  fs.writeFileSync(process.argv[2], out)
  console.log(out)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
