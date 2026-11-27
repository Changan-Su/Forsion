/**
 * 「这台手机」本机引擎的模拟器台架(第 1 期)。不经界面,直接调原生插件 + 原生中继,证明这条链在真 App 里通:
 *   读清单 → 下载(中途暂停、再续传:文件服务器那侧要看到 Range 请求)→ 解包 → 自检 → 起引擎 → 经 ForsionUnit 中继
 *   (保留 id)打本机引擎:令牌由原生注入、页面递的诱饵 Authorization 被丢 → 建会话、发一轮带工具调用的 run(假模型让引擎
 *   在 PRoot 里跑 run_bash),SSE 逐段收到回复 → 停引擎 → 进程确实没了。可选 L2S=1:同一环境里 --link2symlink 开 / 关
 *   各跑一遍 apt/dpkg、git、硬链接,逐步核文件完整性(不只看退出码:l2s 开着时 link 失败前已把源文件改了名)。
 *
 * 判据只认:文件服务器的访问记录、假模型收到的请求、引擎经中继回来的状态码 / 正文、logcat 里 LocalEngine 的行。
 *
 * 前置:
 *   AVD 已开机;APK = mobile 里 `VITE_API_ORIGIN=http://localhost:8788 npm run build && npm run sync:android` 后
 *   `cd android && ./gradlew :app:assembleDebug -PlocalEngine -PlocalEngineManifest=http://10.0.2.2:18900/manifest.json`
 *   环境包 = mobile/scripts/local-engine/build-env.sh <dir> 的产物目录
 * 用法:
 *   ANDROID_SERIAL=emulator-5584 ENV_DIR=<build-env 产物> [APK=<apk>] [L2S=1] [KEEP=1] node scripts/local-engine-emu.cjs
 *   KEEP=1:不删已装的环境(重跑只测起停与 run);THROTTLE=<字节/秒>:下载限速(缺省 8 MB/s,好让暂停落在下载中途)
 */
const fs = require('node:fs')
const path = require('node:path')
const { adb, connect, pause } = require('./lib/emu-cdp.cjs')

const PKG = 'com.forsion.tangu'
const ENV_DIR = process.env.ENV_DIR
const PHONE_ID = '00000000-0000-4000-8000-000000000001' // = UnitRelay.PHONE_ENGINE_ID / phoneEngine.ts
const THROTTLE = Number(process.env.THROTTLE || 8 * 1024 * 1024)
const results = []
const ok = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`) }
if (!ENV_DIR || !fs.existsSync(path.join(ENV_DIR, 'manifest.json'))) { console.error('ENV_DIR must point at a build-env.sh output (manifest.json)'); process.exit(2) }

const { startFixtures } = require('./lib/local-engine-fixtures.cjs')
let served = []
let modelCalls = []

/** ForsionUnit.request through the native relay; collects the whole response (stream chunks timed). */
const relayJs = (opts) => `new Promise((resolve) => {
  const P = Capacitor.Plugins.ForsionUnit; const t0 = Date.now(); const parts = []; let head = null
  P.request(${JSON.stringify(opts)}, (m, err) => {
    if (err) return resolve({ error: String(err.message || err) })
    if (m.type === 'head') head = m
    else if (m.type === 'chunk') parts.push({ t: Date.now() - t0, s: atob(m.b64) })
    else if (m.type === 'end') resolve({ status: head && head.status, parts, text: parts.map((p) => p.s).join('') })
    else if (m.type === 'error') resolve({ error: m.code, message: m.message, status: head && head.status, text: parts.map((p) => p.s).join('') })
  })
})`
const relay = async (cdp, method, p, body, extra = {}) => {
  const opts = { id: `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`, unitId: PHONE_ID, path: p, method, headers: { 'content-type': 'application/json', Authorization: 'Bearer decoy-from-page', ...extra }, body: body == null ? null : JSON.stringify(body) }
  return cdp.eval(relayJs(opts))
}
const plug = (cdp, call, args = {}) => cdp.eval(`Capacitor.Plugins.ForsionLocalEngine.${call}(${JSON.stringify(args)}).then((r) => r, (e) => ({ rejected: e.code || e.message }))`)

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

async function main() {
  const fx = await startFixtures({ envDir: ENV_DIR, throttle: THROTTLE })
  served = fx.served
  modelCalls = fx.modelCalls
  if (process.env.APK) { console.log('installing', process.env.APK); adb('install', '-r', '-t', process.env.APK) }
  adb('shell', 'pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS')
  adb('shell', 'am', 'force-stop', PKG)
  adb('logcat', '-c')
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`)
  const cdp = await connect(PKG, 9351, 40000)
  await pause(2500)

  let s = await plug(cdp, 'state')
  ok('launcher bundled + manifest configured', s.available === true && s.configured === true, JSON.stringify({ available: s.available, configured: s.configured }))

  if (!process.env.KEEP) {
    await plug(cdp, 'remove')
    await waitState(cdp, (x) => !x.installed && x.phase === 'idle', 60000, 'removed')
    adb('shell', 'run-as', PKG, 'rm', '-rf', 'cache/local-engine/downloads')
    s = await plug(cdp, 'check')
    const man = JSON.parse(fs.readFileSync(path.join(ENV_DIR, 'manifest.json'), 'utf8'))
    ok('check() reads the manifest sizes', s.downloadBytes === man.base.size + man.engine.size, `download ${s.downloadBytes} unpacked ${s.unpackedBytes}`)

    // download, pause mid-way, resume
    const t0 = Date.now()
    await plug(cdp, 'install')
    await waitState(cdp, (x) => x.phase === 'downloading' && x.done > 10 * 1024 * 1024, 120000, 'download progress')
    await plug(cdp, 'pause')
    const paused = await waitState(cdp, (x) => x.phase === 'paused', 30000, 'paused')
    const partLs = adb('shell', 'run-as', PKG, 'ls', '-l', 'cache/local-engine/downloads')
    ok('pause keeps the partial download', /\.part/.test(partLs) && paused.resumeBytes > 0, `resumeBytes=${paused.resumeBytes}`)
    const before = served.length
    await plug(cdp, 'install')
    const done = await waitState(cdp, (x) => x.installed && x.phase === 'idle' || x.phase === 'failed', 900000, 'installed')
    const resumed = served.slice(before).find((r) => r.range && /^bytes=[1-9]/.test(r.range))
    ok('resume asks for the rest with Range', !!resumed, resumed ? resumed.range : JSON.stringify(served.slice(before)))
    ok('install completes (download + sha256 + unpack + self-test)', done.installed === true && done.phase === 'idle', `${Math.round((Date.now() - t0) / 1000)}s ${JSON.stringify({ phase: done.phase, error: done.error, engine: done.engineVersion })}`)
    const log = adb('logcat', '-d', '-s', 'LocalEngine')
    const unpacked = log.split('\n').filter((l) => /unpacked/.test(l)).map((l) => l.replace(/.*unpacked/, 'unpacked')).join(' | ')
    ok('extractor: no refused or failed entries', /errors=0/.test(unpacked) && !/skippedUnsafe=[1-9]/.test(unpacked), unpacked.slice(0, 400))
  }

  // KEEP=1 against an environment whose engine layer is older than ENV_DIR's: update() replaces only /opt/tangu, home survives
  s = await plug(cdp, 'check')
  if (s.installed && s.updateAvailable) {
    adb('shell', 'run-as', PKG, 'sh', '-c', `'mkdir -p files/local-engine/home && echo keep > files/local-engine/home/.update-marker'`)
    const man = JSON.parse(fs.readFileSync(path.join(ENV_DIR, 'manifest.json'), 'utf8'))
    const t0 = Date.now()
    await plug(cdp, 'update')
    const u = await waitState(cdp, (x) => (x.phase === 'idle' && !x.updateAvailable) || x.phase === 'failed', 600000, 'updated')
    const inst = adb('shell', 'run-as', PKG, 'cat', 'files/local-engine/installed.json')
    const marker = adb('shell', 'run-as', PKG, 'cat', 'files/local-engine/home/.update-marker').trim()
    ok('update() swaps the engine layer and keeps home', u.phase === 'idle' && inst.includes(man.engine.sha256) && marker === 'keep', `${Math.round((Date.now() - t0) / 1000)}s ${JSON.stringify({ phase: u.phase, error: u.error, engine: u.engineVersion })}`)
  }

  // engine: point a direct provider at the fake model (config.json in the engine's home, read at boot)
  const cfg = JSON.stringify({ providers: [{ providerId: 'emu', baseUrl: 'http://10.0.2.2:18901/v1', apiKey: 'x', modelIds: ['echo'] }] })
  adb('shell', 'run-as', PKG, 'sh', '-c', `'mkdir -p files/local-engine/home && echo ${Buffer.from(cfg).toString('base64')} | base64 -d > files/local-engine/home/config.json'`)

  // passive GET before anything wanted the engine: must fail fast, not start it
  await plug(cdp, 'stop')
  const passive = await relay(cdp, 'GET', '/engine/health')
  s = await plug(cdp, 'state')
  ok('a GET poll does not start a stopped engine', passive.error === 'network' && s.engine === 'stopped', JSON.stringify(passive).slice(0, 160))

  const tStart = Date.now()
  await cdp.eval(`(Capacitor.Plugins.ForsionLocalEngine.start().catch(() => {}), true)`) // resolves when healthy; may outlast one CDP call
  const st = await waitState(cdp, (x) => x.engine === 'running' || x.engine === 'failed', 200000, 'engine running')
  ok('start() → engine running (health + own-token check)', st.engine === 'running', `${Date.now() - tStart}ms ${st.engineError || ''}`)
  const ps = adb('shell', 'ps', '-A', '-o', 'PID,PPID,NAME')
  ok('proot + node run as children of the app', /libproot\.so/.test(ps) && /\bnode\b/.test(ps))

  const health = await relay(cdp, 'GET', '/engine/health')
  let hj = {}; try { hj = JSON.parse(health.text) } catch {}
  ok('relay → /health (phone mode on)', health.status === 200 && hj.phone === true && typeof hj.activeRuns === 'number', health.text && health.text.slice(0, 200))
  const sess = await relay(cdp, 'GET', '/engine/agent/sessions?limit=5')
  ok('relay injects the local token (page decoy dropped)', sess.status === 200, `status ${sess.status}`)
  const bad = await relay(cdp, 'GET', '/unit/remote-access')
  ok('relay refuses non-engine paths for this phone', bad.error === 'bad_path', JSON.stringify(bad))

  // a real turn: session → run with a tool call → SSE
  const created = await relay(cdp, 'POST', '/engine/agent/sessions', { title: 'emu', app_id: 'tangu', model_id: 'emu/echo' })
  let sid = null; try { const cj = JSON.parse(created.text); sid = cj.id || cj.sessionId || cj.session?.id } catch {}
  ok('create a session', created.status === 200 || created.status === 201, `${created.status} ${String(created.text).slice(0, 120)}`)
  const run = await relay(cdp, 'POST', '/engine/agent/runs', { session_id: sid, model_id: 'emu/echo', message: 'TOOLTEST say hi', agent_config: { execMode: 'host', cwd: '/root/workspace', approvalMode: 'full-auto' } })
  let rid = null; try { rid = JSON.parse(run.text).run_id || JSON.parse(run.text).id || JSON.parse(run.text).runId } catch {}
  ok('start a run', !!rid, `${run.status} ${String(run.text).slice(0, 160)}`)
  const events = await relay(cdp, 'GET', `/engine/agent/runs/${rid}/events`, null, { accept: 'text/event-stream' })
  const text = events.text || ''
  ok('SSE: the reply carries the tool output (run_bash ran under PRoot)', /PHONE-OK/.test(text) && /marker-42/.test(text) && /aarch64/.test(text), `${events.parts ? events.parts.length : 0} chunks; ${(text.match(/PHONE-OK[^"]{0,120}/) || [''])[0]}`)
  ok('SSE arrived in pieces, not one lump', (events.parts || []).length > 3, `chunks at ${(events.parts || []).slice(0, 6).map((p) => p.t).join(',')}ms`)
  ok('the model was asked twice (tool call → final)', modelCalls.length >= 2, `calls=${modelCalls.length}`)
  const ws = adb('shell', 'run-as', PKG, 'cat', 'files/local-engine/workspace/probe.txt').trim()
  ok('the tool wrote into the workspace (outside the environment)', ws === 'marker-42', ws)

  if (process.env.L2S) {
    const script = [
      'set -u; cd /root/workspace; rm -rf l2s && mkdir l2s && cd l2s',
      'echo "== ln"; echo data > a; if ln a b 2>/tmp/ln.err; then echo "ln: ok"; else echo "ln: FAIL $(cat /tmp/ln.err)"; fi; echo "a=[$(cat a 2>&1)] b=[$(cat b 2>&1)]"; ls -la',
      'echo "== link then unlink tmp (image delivery order)"; echo img > t.tmp; ln t.tmp final.png 2>/dev/null && rm -f t.tmp; echo "final=[$(cat final.png 2>&1)]"',
      'echo "== git"; git init -q repo && cd repo && git config user.email e@x && git config user.name e && for i in 1 2 3; do echo $i > f$i; git add f$i; git commit -qm c$i; done; git gc -q 2>&1 | tail -1; git fsck 2>&1 | tail -2; echo "log=$(git log --oneline | wc -l)"; cd ..',
      'git clone -q --local repo clone 2>&1 | tail -1; echo "clone log=$(cd clone && git log --oneline | wc -l) fsck=$(cd clone && git fsck 2>&1 | tail -1)"',
      'echo "== apt/dpkg"; apt-get update -qq 2>&1 | tail -2; apt-get install -y -qq --no-install-recommends jq >/tmp/apt.log 2>&1; echo "install exit=$?"; tail -3 /tmp/apt.log; jq --version 2>&1',
      'apt-get install -y -qq --reinstall jq >/tmp/apt2.log 2>&1; echo "reinstall exit=$?"; tail -3 /tmp/apt2.log; dpkg --verify jq 2>&1 | head -5; echo "verify exit=$?"; jq --version 2>&1',
      'ls -la /var/lib/dpkg/info/ | grep -c l2s || true; find / -xdev -name ".l2s.*" 2>/dev/null | head -5',
      // the decisive check: what Node (libuv uses statx) sees for a file that went through a hard link
      'echo "== node stat of a linked file"; echo z > n1; ln n1 n2 2>/dev/null; node -e "const f=require(\'fs\');for(const p of [\'n1\',\'/var/lib/dpkg/status\']){try{const s=f.statSync(p);console.log(p,\'isFile=\'+s.isFile(),\'size=\'+s.size,\'mode=\'+s.mode.toString(8))}catch(e){console.log(p,e.code)}}"',
    ].join('\n')
    for (const on of [true, false]) {
      await plug(cdp, 'setLink2symlink', { on })
      const r = await plug(cdp, 'shell', { cmd: script, timeout: 900 })
      console.log(`\n────── l2s ${on ? 1 : 0} ──────\n${r.out || JSON.stringify(r)}\n`)
      fs.writeFileSync(path.join(process.env.OUT_DIR || '.', `l2s-${on ? 1 : 0}.txt`), r.out || JSON.stringify(r))
    }
    await plug(cdp, 'setLink2symlink', { on: false }) // back to the shipped default (LocalEnginePaths.link2symlink)
  }

  const stopped = await plug(cdp, 'stop')
  await pause(1500)
  const ps2 = adb('shell', 'ps', '-A', '-o', 'PID,NAME')
  ok('stop() → engine and launcher gone', stopped.engine === 'stopped' && !/libproot\.so/.test(ps2) && !/\bnode\b/.test(ps2))

  cdp.close()
  fx.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
