// #928 B1: run guest-tools.sh's checks in the app's own context (the debug `shell` call: same launcher, same binds,
// and the app's network, which run-as does not have, so apt can reach the archive).
// Usage (in mobile/): ANDROID_SERIAL=emulator-5584 node scripts/local-engine/proot-brk-probe/guest-tools-app.cjs <out.txt>
// Debug build, emulator test environment only: it installs and removes jq (skipped when jq is already installed)
// and works in fresh directories under /tmp. Prints PASS / FAIL per check; exit code 1 when any check failed or
// the call returned nothing. The call is fired and its result polled: one CDP evaluation waits 20 s at most.
const path = require('node:path')
const fs = require('node:fs')
const LIB = path.join(__dirname, '../../lib')
const { adb, connect, pause } = require(path.join(LIB, 'emu-cdp.cjs'))
const PKG = 'com.forsion.tangu'

const script = [
  'chk() { if [ "$1" = 0 ]; then echo "PASS $2"; else echo "FAIL $2 ($1)"; fi; }',
  'W=$(mktemp -d /tmp/b1.XXXXXX)',
  'echo "== bash"; n=$(bash -c \'for i in $(seq 1 2000); do a[$i]=$(printf %05d $i); done; echo ${#a[@]}\'); [ "$n" = 2000 ]; chk $? "bash $BASH_VERSION"',
  'echo "== apt"; apt-get update -qq >$W/up.log 2>&1; chk $? apt-update; tail -2 $W/up.log',
  'if dpkg -s jq >/dev/null 2>&1; then echo "SKIP apt-install (jq already installed)"; else',
  '  apt-get install -y -qq --no-install-recommends jq >$W/apt.log 2>&1; echo "install exit=$?"; tail -3 $W/apt.log',
  '  [ "$(echo \'{"a":[1,2]}\' | jq -c .a 2>&1)" = "[1,2]" ]; chk $? "jq runs after install"',
  '  dpkg -s jq 2>&1 | grep -E "^Status"',
  '  apt-get remove -y -qq jq >$W/apt2.log 2>&1; echo "remove exit=$?"; tail -2 $W/apt2.log',
  'fi',
  'echo "== git"; ( set -e; git init -q $W/r; cd $W/r; echo hi > a; git add a; git -c user.email=b1@example.invalid -c user.name=b1 commit -qm one; git gc -q; git fsck --strict; [ "$(git log --oneline | wc -l)" = 1 ] ); chk $? "git init/commit/gc/fsck --strict"',
  'echo "== node"; node -e "const a=[];for(let i=0;i<200;i++)a.push(Buffer.alloc(1<<20,i));let s=0;for(const b of a)s+=b[0];if(s!==19900)process.exit(1);console.log(\'rss MB\',process.memoryUsage().rss>>20)"; chk $? "node 200 MB of buffers"',
  'echo "== npm"; ( set -e; mkdir $W/np; cd $W/np; npm init -y >/dev/null; npm install --no-audit --no-fund ms@2.1.3 >$W/npm.log 2>&1; [ "$(node -e "console.log(require(\'ms\')(60000))")" = 1m ] ); chk $? "npm install + require"',
  'rm -rf $W',
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
  const text = r && r.out ? r.out : `NO RESULT ${JSON.stringify(r)}`
  const out = `${text}\n== logcat double free lines: ${df.length}\n${df.join('\n')}\n`
  fs.writeFileSync(process.argv[2], out)
  console.log(out)
  const good = !!(r && r.out) && /^exit=0/.test(r.out) && !/^FAIL /m.test(r.out) && df.length === 0
  process.exit(good ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
