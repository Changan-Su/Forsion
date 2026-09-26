/**
 * 手机操控(T1 + T2)模拟器台架 —— 假引擎 + CDP,直测「原生 claim → 执行 → result」这条链。
 * 契约:tangu-agent/docs/phone-control.md。渲染层的 G2/G3 早筛由 desktop vitest 覆盖,这里只测原生侧。
 *
 * 前置(一次):
 *   AVD 已开机(emulator -avd Forsion_API_35),adb 在 $ANDROID_HOME/platform-tools
 *   cd mobile && rm -rf dist && VITE_API_ORIGIN=http://localhost:8787 npm run build && npx cap sync android \
 *     && (cd android && ./gradlew :app:assembleDebug :hands:assembleDebug) \
 *     && adb install -r android/app/build/outputs/apk/debug/app-debug.apk \
 *     && adb install -r android/hands/build/outputs/apk/debug/hands-debug.apk
 *   (debug 包带 network_security_config,只对 localhost 放行明文;release 不受影响)
 *
 * ⚠️ T2 的屏幕操作用例需要**用户手动**启用伴随包的无障碍服务(改系统安全设置,台架不代劳):
 *      adb shell settings put secure enabled_accessibility_services com.forsion.tangu.hands/com.forsion.tangu.hands.HandsAccessibilityService
 *      adb shell settings put secure accessibility_enabled 1
 *    没启用时,这些用例记为 SKIP(不算失败),台架会把这两条命令打出来。安装 / 签名 / hands 状态类用例不需要它,照常跑。
 *
 * 用法:
 *   node scripts/phone-control-emu.cjs           全部用例(T1 + 可跑的 T2 + 需服务的 T2 视启用与否跑或跳)
 *   node scripts/phone-control-emu.cjs soak 300  中继存活:Clock 在前台 300 秒,WebView 里的 SSE 循环每 10s 转交一条 volume 指令
 *
 * 判据只认假引擎这一侧的账(收到几次 claim / result / abort、结果码),辅以 logcat 的 START 与顶层 Activity ——
 * 「调用没抛」不算数(见 memory:浏览器台架打返回键那一课)。
 */
const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library/Android/sdk')
const adb = (...args) => execFileSync(path.join(sdk, 'platform-tools/adb'), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const PKG = process.env.PKG || 'com.forsion.tangu'
const HANDS_PKG = 'com.forsion.tangu.hands'
const HANDS_A11Y = `${HANDS_PKG}/${HANDS_PKG}.HandsAccessibilityService`
const ANDROID_DIR = path.join(__dirname, '..', 'android')
const HANDS_APK = path.join(ANDROID_DIR, 'hands/build/outputs/apk/debug/hands-debug.apk')
const BUILD_TOOLS = path.join(sdk, 'build-tools/34.0.0')
const ENGINE_PORT = 8787
const CDP_PORT = 9341
const TOKEN = 'phone-emu-token'
// 第二个账号的 token(T2 换号用例):假引擎两个都认,原生据此算出不同的租约账号键(契约 §9.5)
const TOKEN2 = 'phone-emu-token-2'
const TOKENS = new Set([`Bearer ${TOKEN}`, `Bearer ${TOKEN2}`])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ───────────────────────────── 假引擎 ─────────────────────────────
const pending = new Map() // ackId -> { runId, body, digest, state, nonce, claims, results, t0 }
const ledger = [] // { t, ackId, phase, status, body }
const aborts = [] // { t, runId } —— T2 急停(Stop 药丸 → 主包 POST /abort)
let seq = 0
const RUN = 'run_emu_1'

function issue(op, args, opts = {}) {
  const ackId = `cc_${Date.now().toString(36)}_${++seq}_${crypto.randomBytes(9).toString('base64url')}`
  const body = JSON.stringify({ v: 1, runId: RUN, sessionId: 'sess_emu', ackId, ns: 'phone', op, args, iat: Date.now(), target: { kind: 'origin' } })
  const digest = crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex')
  pending.set(ackId, { runId: RUN, body, digest, state: 'pending', nonce: null, claims: 0, commits: 0, results: [], t0: Date.now(), execMs: opts.execMs || 20000 })
  return { runId: RUN, ackId, body }
}

function readJson(req) {
  return new Promise((resolve) => {
    let s = ''
    req.on('data', (c) => { s += c })
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')) } catch { resolve({}) } })
  })
}

const sseClients = new Set()
const server = http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Private-Network': 'true' }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(obj)) }
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/api/auth/me') return send(200, { id: 'u_emu', username: 'emu', email: 'emu@example.com' })
  if (url.pathname === '/emu/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...cors })
    res.write(': hi\n\n')
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }
  // 手机操控 T2 急停(契约 §9.5):药丸「停止」→ 主包用自持 token 直接 POST /abort。
  const ab = url.pathname.match(/^\/api\/agent\/runs\/([^/]+)\/abort$/)
  if (ab && req.method === 'POST') {
    const [, runId] = ab.map(decodeURIComponent)
    await readJson(req)
    const authed = TOKENS.has(req.headers.authorization)
    ledger.push({ t: Date.now(), ackId: '(abort)', phase: 'abort', status: authed ? 200 : 401, body: { runId } })
    if (!authed) return send(401, { detail: 'bad token' })
    if (runId !== RUN) return send(404, { detail: 'Run not found' })
    aborts.push({ t: Date.now(), runId })
    return send(200, { ok: true })
  }
  const m = url.pathname.match(/^\/api\/agent\/runs\/([^/]+)\/inquiries\/([^/]+)$/)
  if (m && req.method === 'POST') {
    const [, runId, ackId] = m.map(decodeURIComponent)
    const b = await readJson(req)
    const p = pending.get(ackId)
    const log = (status) => ledger.push({ t: Date.now(), ackId, phase: b.phase, status, body: b })
    if (!TOKENS.has(req.headers.authorization)) { log(401); return send(401, { detail: 'bad token' }) }
    if (runId !== RUN) { log(404); return send(404, { detail: 'Run not found' }) }
    // LAX=1:负对照 —— 假装引擎对没签发过的 ackId 也放行 claim,伪造用例必须因此变红
    if (!p && process.env.LAX === '1' && b.phase === 'claim') { log(200); return send(200, { ok: true, nonce: 'lax', execMs: 20000 }) }
    if (!p) { log(410); return send(410, { detail: 'gone' }) }
    if (b.phase === 'claim') {
      p.claims++
      if (b.digest !== p.digest) { log(410); return send(410, { detail: 'gone' }) }
      // 与真引擎同口径(契约 §3.2):重领只认首次的 claimant,回**剩余**时长、不重置计时
      if (p.state === 'claimed') {
        if (!p.claimant || b.claimant !== p.claimant) { log(410); return send(410, { detail: 'gone' }) }
        log(200); return send(200, { ok: true, nonce: p.nonce, execMs: Math.max(0, p.claimedAt + p.execMs - Date.now()) })
      }
      if (p.state !== 'pending') { log(410); return send(410, { detail: 'gone' }) }
      p.state = 'claimed'; p.nonce = crypto.randomBytes(12).toString('hex'); p.claimedAt = Date.now(); p.claimant = b.claimant
      log(200)
      // 模拟网关丢响应:首次 claim 已生效,响应拖过原生的 15s 读超时 → 原生带同一 claimant 重领
      if (p.stallFirstClaimMs) { await sleep(p.stallFirstClaimMs); try { send(200, { ok: true, nonce: p.nonce, execMs: p.execMs }) } catch { /* 原生早已断开 */ } return }
      return send(200, { ok: true, nonce: p.nonce, execMs: p.execMs })
    }
    if (b.phase === 'commit') {
      p.commits++
      if (p.state !== 'claimed' || b.nonce !== p.nonce || p.aborted) { log(410); return send(410, { detail: 'gone' }) }
      log(200)
      // 模拟 commit 慢回(网关抖动):响应拖到原生本地期限之后。假引擎刻意不按 execMs 判超时 ——
      // 真引擎这时多半已兑现 no_report 并 410,这里放行 200 专测「原生在 commit 返回后自己再查期限 / 前台」。
      if (p.commitDelayMs) { await sleep(p.commitDelayMs); try { send(200, { ok: true }) } catch { /* 原生已断开 */ } return }
      return send(200, { ok: true })
    }
    if (b.phase === 'result') {
      if (p.state !== 'claimed' || b.nonce !== p.nonce) { log(410); return send(410, { detail: 'gone' }) }
      p.state = 'done'; p.results.push({ ...b, dt: Date.now() - p.t0 })
      log(200); return send(200, { ok: true })
    }
    log(400); return send(400, { detail: 'bad phase' })
  }
  send(503, { detail: 'emu engine: not implemented' })
})

async function waitResult(ackId, ms = 15000) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    const p = pending.get(ackId)
    if (p?.results.length) return p.results[0]
    await sleep(150)
  }
  return null
}

// ───────────────────────────── CDP ─────────────────────────────
async function evaluate(expr) {
  const pid = adb('shell', 'pidof', PKG).trim()
  if (!pid) throw new Error('app 没在跑')
  adb('forward', `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`)
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && JSON.parse(t.description || '{}').attached) || list.find((t) => t.type === 'page')
  if (!page) throw new Error('找不到 WebView 页')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  const res = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('求值超时')), 20000)
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { clearTimeout(t); resolve(d.result) } }
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
  })
  ws.close()
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text)
  return res.result.value
}
const PC = 'Capacitor.Plugins.PhoneControl'
const exec = (c) => evaluate(`${PC}.exec(${JSON.stringify(c)})`)

// ───────────────────────────── 设备工具 ─────────────────────────────
const topActivity = () => (adb('shell', 'dumpsys', 'activity', 'activities').match(/topResumedActivity=.*?\{[^}]*\s(\S+\/\S+)/) || [])[1] || ''
function launchForsion() {
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`)
}
/** 只看不点:uiautomator dump 里出现匹配的 text 就返回 true(等浮层出现 / 确认它已消失)。 */
async function screenHasText(re, ms = 8000) {
  const t = Date.now()
  do {
    try {
      adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml')
      const xml = adb('shell', 'cat', '/sdcard/ui.xml')
      for (const m of xml.matchAll(/<node [^>]*text="([^"]*)"/g)) if (re.test(m[1])) return true
    } catch { /* dump 偶发失败,重试 */ }
    if (ms > 0) await sleep(400)
  } while (Date.now() - t < ms)
  return false
}
const setToken = (tok) => evaluate(`Capacitor.Plugins.Preferences.set({ key: 'forsion_token', value: ${JSON.stringify(tok)} })`)

async function tapButtonWithText(re, ms = 8000) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    try {
      adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml')
      const xml = adb('shell', 'cat', '/sdcard/ui.xml')
      for (const m of xml.matchAll(/<node [^>]*text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)) {
        if (re.test(m[1])) {
          const x = (Number(m[2]) + Number(m[4])) >> 1, y = (Number(m[3]) + Number(m[5])) >> 1
          adb('shell', 'input', 'tap', String(x), String(y))
          return m[1]
        }
      }
    } catch { /* dump 偶发失败,重试 */ }
    await sleep(400)
  }
  return null
}

// ───────────────────────────── 用例 ─────────────────────────────
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
const skipped = []
function skip(name, detail) {
  skipped.push({ name, detail })
  console.log(`SKIP  ${name}${detail ? `  — ${detail}` : ''}`)
}

// ── 伴随包 / 无障碍(T2)设备工具 ──
function handsA11yEnabled() {
  try {
    if (adb('shell', 'settings', 'get', 'secure', 'accessibility_enabled').trim() !== '1') return false
    const svcs = adb('shell', 'settings', 'get', 'secure', 'enabled_accessibility_services').trim()
    return svcs.split(':').some((s) => s.toLowerCase() === HANDS_A11Y.toLowerCase())
  } catch {
    return false
  }
}
function handsInstalled() {
  try {
    return adb('shell', 'pm', 'list', 'packages', HANDS_PKG).includes(HANDS_PKG)
  } catch {
    return false
  }
}
function installHands() {
  adb('install', '-r', HANDS_APK)
}
function uninstallHands() {
  try { adb('uninstall', HANDS_PKG) } catch { /* 已不在 */ }
}
/** 用一把一次性钥匙重签 hands 的副本(异签名),供签名不符用例。返回副本路径。 */
function buildSignatureVariant(scratch) {
  const ks = path.join(scratch, 'throwaway.ks')
  const out = path.join(scratch, 'hands-variant.apk')
  const keytool = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/keytool') : 'keytool'
  if (!fs.existsSync(ks)) {
    execFileSync(keytool, ['-genkeypair', '-keystore', ks, '-storepass', 'test123', '-keypass', 'test123',
      '-alias', 't', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '30', '-dname', 'CN=throwaway'], { stdio: 'ignore' })
  }
  fs.copyFileSync(HANDS_APK, out)
  execFileSync(path.join(BUILD_TOOLS, 'apksigner'), ['sign', '--ks', ks, '--ks-pass', 'pass:test123',
    '--key-pass', 'pass:test123', '--ks-key-alias', 't', out], { stdio: 'ignore' })
  return out
}

async function runCases() {
  adb('reverse', `tcp:${ENGINE_PORT}`, `tcp:${ENGINE_PORT}`)
  adb('shell', 'am', 'force-stop', PKG)
  launchForsion()
  await sleep(6000)
  await evaluate(`Capacitor.Plugins.Preferences.set({ key: 'forsion_token', value: ${JSON.stringify(TOKEN)} })`)

  // 0 · 关着:exec 只能回 disabled(先 claim 再 result),绝不执行
  await evaluate(`${PC}.setEnabled({ enabled: false }).catch(() => null)`)
  let c = issue('media', { key: 'play_pause' })
  await exec(c)
  let r = await waitResult(c.ackId)
  check('disabled → result code disabled', r && r.ok === false && r.code === 'disabled', r)

  // 1 · 开启:原生确认框,由台架点「确认」
  const enabling = evaluate(`${PC}.setEnabled({ enabled: true })`)
  const tapped = await tapButtonWithText(/允许|开启|Allow|Enable|Turn on|OK|确定/i)
  const en = await enabling.catch((e) => ({ error: e.message }))
  check('setEnabled(true) via native dialog', en && en.enabled === true, { tapped, en })
  const st = await evaluate(`${PC}.status()`)
  check('status reports phone.intents', st && st.enabled && (st.capabilities || []).includes('phone.intents'), st)

  // 2 · 后台可用的 op:volume
  c = issue('volume', { dir: 'up' })
  await exec(c)
  r = await waitResult(c.ackId)
  check('volume up → ok', r && r.ok === true, r)

  // 3 · 伪造 body(引擎没签发)→ claim 410 → 不执行、不回 result
  const forged = { runId: RUN, ackId: 'cc_forged_1_xxxxxxxxxxxx', body: JSON.stringify({ v: 1, runId: RUN, sessionId: 'x', ackId: 'cc_forged_1_xxxxxxxxxxxx', ns: 'phone', op: 'alarm', args: { hour: 6, minute: 1 }, iat: Date.now(), target: { kind: 'origin' } }) }
  const before = topActivity()
  await exec(forged)
  await sleep(2500)
  const fl = ledger.filter((l) => l.ackId === forged.ackId)
  check('forged body → one claim 410, no result, no launch', fl.length === 1 && fl[0].phase === 'claim' && fl[0].status === 410 && topActivity() === before, { fl: fl.map((l) => `${l.phase}:${l.status}`), top: topActivity() })

  // 4 · 同一条指令转交两次(模拟 JS 重放)→ 原生 LRU 只 claim 一次
  c = issue('volume', { dir: 'down' })
  await exec(c); await exec(c)
  r = await waitResult(c.ackId)
  await sleep(1500)
  check('replayed exec → exactly one claim', pending.get(c.ackId).claims === 1 && r?.ok === true, { claims: pending.get(c.ackId).claims })

  // 5 · 篡改 body(ackId 对,内容被改)→ digest 不符 410
  c = issue('volume', { dir: 'up' })
  const tampered = { ...c, body: c.body.replace('"up"', '"down"') }
  await exec(tampered)
  await sleep(2500)
  check('tampered body → claim 410, no result', pending.get(c.ackId).claims === 1 && !pending.get(c.ackId).results.length, { claims: pending.get(c.ackId).claims })

  // 6 · 危险 scheme → refused
  c = issue('view', { candidates: ['intent://evil#Intent;scheme=http;end'] })
  await exec(c)
  r = await waitResult(c.ackId)
  check('intent: scheme → refused', r && r.ok === false && r.code === 'refused', r)

  // 6b · 自家 scheme:登录回跳会吃下别人的 token(登录 CSRF)→ refused,且没弹确认框、没换号
  c = issue('view', { candidates: ['tangu://auth-callback?token=ATTACKER'] })
  await exec(c)
  r = await waitResult(c.ackId)
  const tokNow = await evaluate(`Capacitor.Plugins.Preferences.get({ key: 'forsion_token' }).then((x) => x.value)`)
  check('own tangu: scheme → refused, token untouched', r && r.ok === false && r.code === 'refused' && tokNow === TOKEN, { r, tokenChanged: tokNow !== TOKEN })

  // 6c · 首次 claim 的响应丢了(拖过 15s 读超时)→ 重领拿到剩余 ~5s → 仍然执行并回执(本地期限锚在响应到达时刻)
  c = issue('volume', { dir: 'up' })
  pending.get(c.ackId).stallFirstClaimMs = 16000
  await exec(c)
  r = await waitResult(c.ackId, 30000)
  check('lost claim response → re-claim (remaining execMs) still executes', r && r.ok === true && pending.get(c.ackId).claims === 2, { r, claims: pending.get(c.ackId).claims })

  // 7 · 前台启动 Activity:闹钟 → deskclock 置顶
  launchForsion(); await sleep(2000)
  adb('logcat', '-c')
  c = issue('alarm', { hour: 7, minute: 5, label: 'emu' })
  await exec(c)
  r = await waitResult(c.ackId)
  await sleep(1500)
  // ⚠️ 不断言「时钟置顶」:SKIP_UI 被 DeskClock 尊重时它设完就 finish,Forsion 立刻回到前台。认 START 行。
  const logAlarm = adb('logcat', '-d', '-t', '600')
  check('alarm (foreground) → ok, SET_ALARM started', r && r.ok === true && /act=android\.intent\.action\.SET_ALARM/.test(logAlarm), { r, top: topActivity() })

  // 8 · 后台时要启动 Activity → needs_foreground
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'); await sleep(1500)
  c = issue('settings', { page: 'wifi' })
  await exec(c)
  r = await waitResult(c.ackId)
  check('settings while backgrounded → needs_foreground', r && r.ok === false && r.code === 'needs_foreground', r)

  // 9 · 拨号只开拨号盘(ACTION_DIAL),号码被清洗
  launchForsion(); await sleep(2000)
  adb('logcat', '-c')
  c = issue('dial', { number: '+86 138-0000-0000;rm' })
  await exec(c)
  r = await waitResult(c.ackId)
  await sleep(1000)
  const logDial = adb('logcat', '-d')
  // 系统把 tel: 号码打码成等长的 x:清洗后 '+8613800000000' = 14 位;绝不能出现 ACTION_CALL 的 START
  const dialStart = (logDial.match(/START u0 \{act=android\.intent\.action\.DIAL dat=tel:(\S+)/) || [])[1] || ''
  check('dial → ACTION_DIAL, sanitized number', r && r.ok === true && dialStart.length === 14 && !/START u0 \{act=android\.intent\.action\.CALL\b/.test(logDial), { r, dialStart })

  // 10–13 · R3:非地图白名单 scheme(google.navigation 落到 Maps,但 scheme 不在 MAP_SCHEMES)→ 原生确认框
  const NAV = ['google.navigation:q=Beijing+South+Railway+Station']
  const mapsStarted = () => /START u0 \{[^}]*cmp=com\.google\.android\.apps\.maps\//.test(adb('logcat', '-d'))
  const r3 = async (act, opts = {}) => {
    launchForsion(); await sleep(2000)
    adb('shell', 'am', 'force-stop', 'com.google.android.apps.maps')
    adb('logcat', '-c')
    const cc = issue('view', { candidates: NAV }, opts)
    await exec(cc)
    const dlg = await tapButtonWithText(/^(Open another app\?|打开其他 App？)$/, 8000).then((t) => !!t).catch(() => false)
    await act(cc)
    const rr = await waitResult(cc.ackId, (opts.execMs || 20000) + 5000)
    await sleep(2000)
    return { cc, rr, dlg, started: mapsStarted(), p: pending.get(cc.ackId) }
  }
  let o = await r3(async () => { await tapButtonWithText(/^(OPEN|Open|打开)$/) })
  check('R3 allow → commit 200 → Maps started, ok', o.dlg && o.rr?.ok === true && o.p.commits === 1 && o.started, { rr: o.rr, commits: o.p.commits, started: o.started })
  o = await r3(async () => { await tapButtonWithText(/^(DENY|Deny|拒绝)$/) })
  check('R3 deny → declined, no commit, nothing started', o.dlg && o.rr?.code === 'declined' && o.p.commits === 0 && !o.started, { rr: o.rr, commits: o.p.commits, started: o.started })
  o = await r3(async (cc) => { pending.get(cc.ackId).aborted = true; await tapButtonWithText(/^(OPEN|Open|打开)$/) })
  check('R3 aborted before confirm → commit 410 → nothing started', o.p.commits === 1 && !o.started && !o.rr, { rr: o.rr, commits: o.p.commits, started: o.started })
  o = await r3(async () => { await sleep(9000); await tapButtonWithText(/^(OPEN|Open|打开)$/, 1500) }, { execMs: 6000 })
  check('R3 not confirmed before local deadline → auto-dismissed, never started', !o.started && o.p.commits === 0 && (!o.rr || o.rr.code === 'declined'), { rr: o.rr, commits: o.p.commits, started: o.started })

  // 14 · 期限在 commit 之后复查:确认及时,但 commit 响应拖到本地期限(claim+12s−1.5s)之后才回 → 不启动、不回执
  o = await r3(async (cc) => { pending.get(cc.ackId).commitDelayMs = 10000; await tapButtonWithText(/^(OPEN|Open|打开)$/) }, { execMs: 12000 })
  check('R3 commit answered after local deadline → nothing started, no result', o.dlg && o.p.commits === 1 && !o.started && !o.rr, { rr: o.rr, commits: o.p.commits, started: o.started })

  // 15 · 前台在主线程 startActivity 前复查:确认之后、commit 回来之前按 Home → needs_foreground,不在后台硬起 Activity
  o = await r3(async (cc) => {
    pending.get(cc.ackId).commitDelayMs = 4000
    await tapButtonWithText(/^(OPEN|Open|打开)$/)
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
  })
  check('R3 confirmed, then Home before launch → needs_foreground, nothing started', o.dlg && o.rr?.code === 'needs_foreground' && o.p.commits === 1 && !o.started, { rr: o.rr, commits: o.p.commits, started: o.started })

  // 16–17 · claim 并发、执行串行:一条 R3 确认框挂着时,另一条指令照样在 claim 窗口内被领走,但要等确认框了结才执行
  const DIALOG = /^(Open another app\?|打开其他 App？)$/
  const claimOk = (ackId) => ledger.find((l) => l.ackId === ackId && l.phase === 'claim' && l.status === 200)
  launchForsion(); await sleep(2000)
  let first = issue('view', { candidates: NAV }, { execMs: 30000 })
  await exec(first)
  let dlgUp = !!(await tapButtonWithText(DIALOG, 8000))
  let second = issue('volume', { dir: 'up' })
  const tIssued = Date.now()
  await exec(second)
  let t = Date.now()
  while (!claimOk(second.ackId) && Date.now() - t < 8000) await sleep(150)
  const claimed = claimOk(second.ackId)
  await sleep(2000) // 给它「错误地并发执行」的机会
  const ranEarly = pending.get(second.ackId).results.length > 0
  const tDeny = Date.now()
  await tapButtonWithText(/^(DENY|Deny|拒绝)$/)
  const rFirst = await waitResult(first.ackId)
  const rSecond = await waitResult(second.ackId)
  const secondAt = ledger.find((l) => l.ackId === second.ackId && l.phase === 'result')?.t || 0
  check('claim not blocked by a pending R3 dialog; execution waits for it', dlgUp && claimed && claimed.t - tIssued < 8000 && !ranEarly && rFirst?.code === 'declined' && rSecond?.ok === true && secondAt >= tDeny,
    { dlgUp, claimMs: claimed ? claimed.t - tIssued : null, ranEarly, rFirst: rFirst?.code, rSecond, afterDeny: secondAt >= tDeny })

  // 排执行道排到本地期限(claim+6s−1.5s)还没轮到 → 什么都没做,在引擎期限内如实回 error(不是沉默 → no_report)
  launchForsion(); await sleep(2000)
  first = issue('view', { candidates: NAV }, { execMs: 30000 })
  await exec(first)
  dlgUp = !!(await tapButtonWithText(DIALOG, 8000))
  second = issue('volume', { dir: 'up' }, { execMs: 6000 })
  await exec(second)
  const rBusy = await waitResult(second.ackId, 12000)
  await tapButtonWithText(/^(DENY|Deny|拒绝)$/)
  await waitResult(first.ackId)
  check('queued behind a dialog past its deadline → busy "Nothing was done" before engine timeout', dlgUp && rBusy && rBusy.ok === false && rBusy.code === 'busy' && /Nothing was done/.test(rBusy.error || '') && rBusy.dt < 6000,
    { dlgUp, rBusy })

  // ═══════════════════════ T2:屏幕操作(phone.ui,伴随包无障碍) ═══════════════════════
  await runT2()

  launchForsion()
}

/** T2 用例。安装 / 签名 / hands 状态类不需要无障碍服务;真正的屏幕操作类需要,未启用则 SKIP。 */
async function runT2() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-emu-'))

  // ⚠️ 无障碍开着时先跑真屏幕块,且默认不跑卸载 / 换签名:系统卸载伴随包时会把它从 enabled_accessibility_services
  //    里摘掉 —— 台架一卸载就把用户亲手开的无障碍关了,之后的真屏幕块永远 SKIP(09-26 实翻)。
  //    开无障碍 / 关无障碍都是改系统安全设置,台架两个方向都不代劳;要跑破坏性用例显式加 DESTRUCTIVE=1。
  if (handsA11yEnabled()) {
    if (!handsInstalled()) installHands()
    launchForsion(); await sleep(2500)
    await runT2Gated()
    skip('a11y-off cases (status.hands=disabled / observe → hands_disabled / backgrounded launch without hands)',
      'accessibility service is on; turning it off is a system security setting the harness does not change')
    if (process.env.DESTRUCTIVE !== '1') {
      skip('uninstall / different-signature cases', 'uninstalling hands revokes its accessibility grant; re-run with DESTRUCTIVE=1 to include them')
      return
    }
    await runT2Install(scratch)
    return
  }

  // 18 · 伴随包已装、无障碍未开 → status.hands=disabled、不声明 phone.ui;observe → hands_disabled
  if (!handsInstalled()) installHands()
  launchForsion(); await sleep(2500)
  let st = await evaluate(`${PC}.status()`)
  check('hands installed + a11y off → status.hands=disabled, no phone.ui',
    st && st.hands === 'disabled' && !(st.capabilities || []).includes('phone.ui'), st)
  let c = issue('observe', {})
  await exec(c)
  let r = await waitResult(c.ackId)
  check('observe while a11y off → hands_disabled', r && r.ok === false && r.code === 'hands_disabled', r)

  await runT2Install(scratch)

  // 20b · §9.2 后台委托只在伴随包就绪时才有:这里无障碍没开 → 后台 launch 仍回 needs_foreground,且什么都没启动
  //(就绪时的正向用例在 runT2Gated 的 T-bg-launch)
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'); await sleep(1500)
  adb('logcat', '-c')
  c = issue('launch', { pkg: 'com.android.settings' })
  await exec(c)
  r = await waitResult(c.ackId)
  await sleep(800)
  const bgStarted = /START u0 \{[^}]*cmp=com\.android\.settings\//.test(adb('logcat', '-d'))
  check('launch while backgrounded, hands not ready → needs_foreground, nothing started', r && r.code === 'needs_foreground' && !bgStarted, { r, bgStarted })
  launchForsion(); await sleep(2000)

  skip('T2 screen ops (lease/observe-tree/screenshot/tap/type/type-without-focus/scroll/key/stale/commit_target by handle+coords/protected_app/account-change re-ask/cancel-during-consent/stop→abort/locked)',
    'accessibility service not enabled. Enable it (system security setting — do it yourself), then re-run:\n' +
    `    adb shell settings put secure enabled_accessibility_services ${HANDS_A11Y}\n` +
    '    adb shell settings put secure accessibility_enabled 1')
}

/** 卸载 / 异签名 / 恢复:会摘掉伴随包的无障碍授权,无障碍开着时只在 DESTRUCTIVE=1 下跑。 */
async function runT2Install(scratch) {
  let st, c, r
  // 19 · 伴随包未装 → status.hands=missing;observe → hands_missing
  uninstallHands()
  await sleep(1000)
  st = await evaluate(`${PC}.status()`)
  check('hands uninstalled → status.hands=missing, no phone.ui',
    st && st.hands === 'missing' && !(st.capabilities || []).includes('phone.ui'), st)
  c = issue('observe', {})
  await exec(c)
  r = await waitResult(c.ackId)
  check('observe while hands missing → hands_missing', r && r.ok === false && r.code === 'hands_missing', r)

  // 20 · 异签名伴随包:安装被拒(重复权限)或装上后 status.hands=signature_mismatch —— 两者都合规,记录实际
  try {
    const variant = buildSignatureVariant(scratch)
    let installErr = ''
    try { adb('install', '-r', variant) } catch (e) { installErr = String((e && e.stderr) || (e && e.message) || '') }
    if (!handsInstalled()) {
      const why = (installErr.match(/INSTALL_FAILED_[A-Z_]+/) || ['refused'])[0]
      check('different-signature hands → install refused, no phone.ui', /DUPLICATE_PERMISSION|SIGNATURE|refused/i.test(installErr) || why !== 'refused', { outcome: 'install refused', why })
    } else {
      st = await evaluate(`${PC}.status()`)
      check('different-signature hands → status.hands=signature_mismatch, no phone.ui',
        st && st.hands === 'signature_mismatch' && !(st.capabilities || []).includes('phone.ui'), st)
      c = issue('observe', {})
      await exec(c)
      r = await waitResult(c.ackId)
      check('observe with mismatched signature → hands_signature_mismatch', r && r.code === 'hands_signature_mismatch', r)
    }
  } catch (e) {
    check('signature-variant test setup (keytool/apksigner)', false, e.message)
  } finally {
    uninstallHands()
    installHands() // 恢复正牌同签名 hands
    await sleep(1000)
  }
  st = await evaluate(`${PC}.status()`)
  check('after restoring proper hands → status.hands back to not-ready (reinstall drops the a11y grant)', st && st.hands === 'disabled', st)
}

/** 需无障碍服务的 T2 用例(未启用时被 runT2 跳过)。断言只认假引擎的 result / abort 与 observation 内容。 */
async function runT2Gated() {
  // ⚠️ 伴随包的租约浮层 / 停止药丸是给**人**的同意与急停:台架不代点,走到这里打印提示、等人在模拟器窗口里点。
  //    (另:uiautomator 一连接系统就挂起其他无障碍服务,伴随包当场被销毁 —— T2 块里一律不用 uiautomator。)
  //    人点完,结果由伴随包经主包回到假引擎,下面的 waitResult 用长等待接住。
  const HUMAN_MS = 85000
  const askHuman = async (label) => {
    console.log(`\n>>> 请在模拟器窗口里点「${label}」(最多等 ${HUMAN_MS / 1000} 秒)\n`)
    // 留证:浮层到底弹没弹(screencap 不走 UiAutomation,不会挂起伴随包)
    setTimeout(() => { try { fs.writeFileSync(path.join(os.tmpdir(), `phone-emu-consent-${label}-${Date.now()}.png`), execFileSync(path.join(sdk, 'platform-tools/adb'), ['exec-out', 'screencap', '-p'])) } catch { /* 留证失败不影响用例 */ } }, 4000)
    return true
  }
  const acceptLease = () => askHuman('允许')
  const denyLease = () => askHuman('暂不')
  // 授权行为用例(拒绝 / 换号重问 / 停止 / 同意中撤销)要人多点几次,逻辑已由 JUnit 覆盖:只在 CONSENT_TESTS=1 时跑
  const consentTests = process.env.CONSENT_TESTS === '1'
  // NEW_TASK|CLEAR_TASK:每次都回「设置」首页 —— 不清的话 intent 投给栈顶已有实例,停在上一条用例进过的子页
  //(09-26 实测:搜索框用例因此一直找不到搜索框而 SKIP)
  const openSettings = () => { adb('shell', 'am', 'start', '-a', 'android.settings.SETTINGS', '-f', '0x10008000'); }

  // L1 · 首条 T2 指令弹租约浮层,拒绝 → lease_declined,什么都没做
  openSettings(); await sleep(2000)
  let c, r
  if (consentTests) {
    c = issue('observe', {}, { execMs: 90000 })
    await exec(c)
    const declined = !!(await denyLease())
    r = await waitResult(c.ackId, HUMAN_MS)
    check('T2 first op → lease overlay; deny → lease_declined', declined && r && r.code === 'lease_declined', { declined, r })
  }

  // L2 · 再来一条,允许 → observe 回一棵带句柄的树
  openSettings(); await sleep(1500)
  c = issue('observe', {}, { execMs: 90000 })
  await exec(c)
  const allowed = !!(await acceptLease())
  r = await waitResult(c.ackId, HUMAN_MS)
  const hasHandles = !!(r && r.ok && /\[\d+\]/.test(r.text || '') && /^app: /.test(r.text || ''))
  check('lease allow → observe returns a tree with handles', allowed && hasHandles, { allowed, head: (r && r.text || '').split('\n')[0] })

  // P-modal · 租约期间药丸不能是模态窗口(09-26 评审 P1):药丸之外的点按与返回键必须到达下面的 App。
  // flags=0 时药丸拿走整屏触摸与按键焦点 —— 下面这一点、一按都被它吞掉,Settings 纹丝不动。放在所有屏幕操作用例之前。
  {
    const top0 = topActivity()
    // 行坐标取自刚才 observe 的树(不用 uiautomator,见上)
    const row = ((r && r.text) || '').match(/"(Network & internet|网络和互联网|Display|显示)"[^\n]*\((\d+),(\d+)\)/)
    if (row) adb('shell', 'input', 'tap', row[2], row[3])
    const tappedRow = row ? row[1] : null
    await sleep(1500)
    const top1 = topActivity()
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); await sleep(1500)
    const top2 = topActivity()
    check('lease pill is not modal: a tap outside it and Back both reach the app underneath',
      !!tappedRow && top1 !== top0 && /SubSettings/.test(top1) && top2 !== top1, { tappedRow, top0, top1, top2 })
  }
  // G-shot · observe 带截图:稳定的设置页必须真回一张图(09-26 二轮评审 P1 #1 加了截前 / 截后两道窗口核对,
  // 这条防它把正常截图也一律丢掉 —— 丢图不报错,只看文本树的用例抓不到)
  openSettings(); await sleep(1500)
  c = issue('observe', { screenshot: true })
  await exec(c); r = await waitResult(c.ackId, 15000)
  check('observe {screenshot} on a stable screen → image attached', r && r.ok === true && /^data:image\/jpeg;base64,/.test(r.image || ''),
    { code: r && r.code, image: r && r.image ? `${r.image.length} chars` : null })

  openSettings(); await sleep(1500)
  c = issue('observe', {})
  await exec(c); r = await waitResult(c.ackId, 12000)

  // T-tap · 点第一个可点句柄 → 界面变化,回新 observation(租约期内不再弹浮层)
  const firstHandle = (r && (r.text.match(/\[(\d+)\][^\n]*\{[^}]*clk/) || [])[1]) || '1'
  c = issue('tap', { node: Number(firstHandle) })
  await exec(c)
  r = await waitResult(c.ackId, 15000)
  check('tap a handle → ok, fresh observation', r && r.ok === true && /obs \d+/.test(r.text || ''), { code: r && r.code })

  // T-type · 打开搜索并输入(靠系统设置的搜索框)
  openSettings(); await sleep(1500)
  c = issue('observe', {})
  await exec(c); r = await waitResult(c.ackId, 12000)
  const searchNode = (r && (r.text.match(/\[(\d+)\][^\n]*\{[^}]*edit/) || r.text.match(/\[(\d+)\][^\n]*[Ss]earch/) || [])[1])
  if (searchNode) {
    c = issue('tap', { node: Number(searchNode) }); await exec(c); await waitResult(c.ackId, 10000)
    // 模型的走法:点完先 observe,再带句柄打字 —— 紧跟着无句柄 type 会赶在新页面给输入框焦点之前,
    // 伴随包按契约回 invalid_args(09-26 实测;不是缺陷)。
    await sleep(800)
    c = issue('observe', {}); await exec(c); r = await waitResult(c.ackId, 12000)
    const obsNo = Number((((r && r.text) || '').split('\n')[0].match(/· obs (\d+)$/) || [])[1])
    const field = ((r && r.text) || '').match(/\[(\d+)\][^\n]*\{[^}]*\bedit\b/)
    if (field && obsNo) {
      c = issue('type', { text: 'wifi', node: Number(field[1]), obs: obsNo }); await exec(c); r = await waitResult(c.ackId, 12000)
      check('type into Settings search (by handle) → ok, text lands in the field', r && r.ok === true && /EditText "wifi"/.test(r.text || ''), { code: r && r.code, error: r && r.error })
    } else {
      check('type into Settings search → search page shows an editable field', false, { head: ((r && r.text) || '').split('\n')[0] })
    }
  } else {
    skip('type into Settings search', 'no editable search field found in observation')
  }

  // T-scroll · 下滑
  c = issue('scroll', { direction: 'down' })
  await exec(c); r = await waitResult(c.ackId, 12000)
  check('scroll down → ok', r && r.ok === true, { code: r && r.code })

  // T-key · 返回键
  c = issue('key', { key: 'back' })
  await exec(c); r = await waitResult(c.ackId, 12000)
  check('key back → ok', r && r.ok === true, { code: r && r.code })

  // T-type-button · 往非输入框(按钮 / 可点行)里 type → invalid_args,什么都不点(09-26 评审 P1:setText 会先 ACTION_CLICK,
  // 指向「支付」的 type 等于绕过提交词表的一次点击)
  openSettings(); await sleep(1500)
  c = issue('observe', {}); await exec(c); r = await waitResult(c.ackId, 12000)
  {
    const obsNo = Number(((r && r.text) || '').split('\n')[0].match(/· obs (\d+)$/)?.[1])
    const btn = ((r && r.text) || '').split('\n').map((l) => l.match(/^\[(\d+)\][^\n]*\{[^}]*clk[^}]*\}/)).find((m) => m && !/\bedit\b/.test(m[0]))
    if (btn && obsNo) {
      const top0 = topActivity()
      c = issue('type', { node: Number(btn[1]), obs: obsNo, text: 'x' }); await exec(c); r = await waitResult(c.ackId, 12000)
      await sleep(800)
      check('type into a non-editable target → invalid_args, nothing tapped', r && r.code === 'invalid_args' && topActivity() === top0, { code: r && r.code, line: btn[0] })
    } else {
      skip('type into a non-editable target', 'no clickable non-editable handle in the Settings observation')
    }
  }

  // G-type-nofocus · 无句柄 type、屏上没有获得焦点的输入框 → invalid_args(要句柄),不往「第一个输入框」里打(09-26 二轮评审 P2 #8)
  openSettings(); await sleep(1500)
  c = issue('observe', {}); await exec(c); r = await waitResult(c.ackId, 12000)
  if (r && r.ok && !/\{[^}]*focused[^}]*\}/.test(r.text || '')) {
    const top0 = topActivity()
    c = issue('type', { text: 'x' }); await exec(c); r = await waitResult(c.ackId, 12000)
    check('type without a node while nothing is focused → invalid_args, nothing typed', r && r.code === 'invalid_args' && topActivity() === top0, { code: r && r.code, error: r && r.error })
  } else {
    skip('type without a node while nothing is focused', 'something on the Settings home screen already has focus')
  }

  // T-stale · 用一个明显过期/越界的 obs+node → stale_handle,并附新树
  c = issue('tap', { node: 240, obs: 1 })
  await exec(c); r = await waitResult(c.ackId, 12000)
  check('stale handle → stale_handle with fresh tree', r && (r.code === 'stale_handle') && /\[\d+\]/.test(r.text || ''), { code: r && r.code })

  // T-commit · 命中提交词的目标(Messages 撰写页的「发送 / Send」)→ commit_target,交还用户
  adb('shell', 'am', 'start', '-a', 'android.intent.action.SENDTO', '-d', 'smsto:10086'); await sleep(2500)
  c = issue('observe', {}); await exec(c); r = await waitResult(c.ackId, 12000)
  const sendLine = r && (r.text.match(/\[(\d+)\][^\n]*(发送|Send)[^\n]*\((\d+),(\d+)\)/) || null)
  const sendNode = sendLine && sendLine[1]
  if (sendNode) {
    c = issue('tap', { node: Number(sendNode) }); await exec(c); r = await waitResult(c.ackId, 12000)
    check('tap a Send/发送 target → commit_target (handed back)', r && r.code === 'commit_target', { code: r && r.code })
    // G-coord-commit · 同一颗按钮按坐标点:在接住触摸的窗口的整棵树里命中测试(09-26 二轮评审 P1 #2),同样交还用户
    c = issue('tap', { x: Number(sendLine[3]), y: Number(sendLine[4]) }); await exec(c); r = await waitResult(c.ackId, 12000)
    check('tap the Send/发送 target by coordinates → commit_target', r && r.code === 'commit_target', { code: r && r.code, at: [sendLine[3], sendLine[4]] })
  } else {
    skip('commit_target refusal', 'no Send/发送 target visible in the SMS compose screen')
  }

  // T-protected · 在 Forsion 自己里操作 → protected_app
  launchForsion(); await sleep(2000)
  c = issue('observe', {}); await exec(c); r = await waitResult(c.ackId, 12000)
  // observe 在保护包上仍允许;变更类才拒。取任一句柄尝试 tap。
  const anyHandle = r && r.ok && (r.text.match(/\[(\d+)\]/) || [])[1]
  if (anyHandle) {
    c = issue('tap', { node: Number(anyHandle) }); await exec(c); r = await waitResult(c.ackId, 12000)
    check('tap inside Forsion itself → protected_app', r && r.code === 'protected_app', { code: r && r.code })
  } else {
    skip('protected_app (acting inside Forsion)', 'no handle observed inside Forsion')
  }

  // T-bg-launch · §9.2 后台委托:Forsion 不在前台、伴随包就绪 → launch 由伴随包启动,回 ok + handoff,目标真到前台
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'); await sleep(1500)
  c = issue('launch', { pkg: 'com.android.settings' }); await exec(c); r = await waitResult(c.ackId, 12000)
  await sleep(1000)
  check('launch while backgrounded + hands ready → delegated, ok handoff, Settings in front',
    r && r.ok === true && r.handoff === true && /com\.android\.settings\//.test(topActivity()), { r, top: topActivity() })

  if (!consentTests) {
    skip('consent behaviour (deny / re-ask after account change / Stop → abort / re-ask after Stop)', 'needs extra human taps; covered by JUnit (LeaseState / ConsentWait / HandsClient). Run with CONSENT_TESTS=1 to include')
  } else {
    // G-account · 换号(forsion_token 变了)之后的第一条 T2 op 必须重新弹同意,不沿用上一个账号的租约(09-26 二轮评审 P1 #5)。
    // 两道防线:主包 cancelAll(没绑上时记账、绑上先还)+ 伴随包租约认账号键(token 摘要)。这里走真链路,断言只认「又弹了浮层」。
    await setToken(TOKEN2); await sleep(800)
    openSettings(); await sleep(1500)
    c = issue('observe', {}, { execMs: 90000 }); await exec(c)
    const reaskedAcct = !!(await denyLease())
    r = await waitResult(c.ackId, HUMAN_MS)
    check('account change → next T2 op asks again (deny → lease_declined)', reaskedAcct && r && r.code === 'lease_declined', { reaskedAcct, r })
    await setToken(TOKEN); await sleep(800)
    // 重新拿到租约,给下面的急停用例用
    c = issue('observe', {}, { execMs: 90000 }); await exec(c)
    const regranted = !!(await acceptLease())
    r = await waitResult(c.ackId, HUMAN_MS)
    check('re-grant after account switch-back → observe ok', regranted && r && r.ok === true, { regranted, code: r && r.code })

    // T-stop · 药丸「停止」→ 撤租约 + 主包 POST /abort 到达假引擎。
    // ⚠️ 这里的停止是在两条 op **之间**点的(observe 已回执):旧实现只在 op 执行中记 run,这时 abort 根本不发(09-26 评审 P1)。
    openSettings(); await sleep(1500)
    c = issue('observe', {}); await exec(c); await waitResult(c.ackId, 12000)
    const before = aborts.length
    const stopped = !!(await askHuman('停止'))
    for (const t0 = Date.now(); aborts.length === before && Date.now() - t0 < HUMAN_MS;) await sleep(500)
    check('Stop pill between ops → abort POST reaches engine', stopped && aborts.length > before && aborts[aborts.length - 1].runId === RUN, { stopped, aborts: aborts.length })
    // 停止即撤租约:下一条 T2 op 重新弹同意浮层(拒绝 → lease_declined),不沿用
    c = issue('observe', {}, { execMs: 90000 }); await exec(c)
    const reasked = !!(await denyLease())
    r = await waitResult(c.ackId, HUMAN_MS)
    check('after Stop the lease is gone → next op asks again (deny → lease_declined)', reasked && r && r.code === 'lease_declined', { reasked, r })
  }
  skip('cancel while the lease consent is up', 'checking the overlay needs uiautomator, which suspends the companion service; covered by JUnit ConsentWaitTest')
  await setToken(TOKEN); await sleep(800)

  // T-locked · 熄屏 → locked(随后唤醒复位)
  adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP'); await sleep(1500)
  c = issue('observe', {}); await exec(c); r = await waitResult(c.ackId, 12000)
  check('screen off → locked', r && r.code === 'locked', { code: r && r.code })
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'); await sleep(800)
}

async function soak(seconds, island) {
  adb('reverse', `tcp:${ENGINE_PORT}`, `tcp:${ENGINE_PORT}`)
  launchForsion(); await sleep(4000)
  await evaluate(`Capacitor.Plugins.Preferences.set({ key: 'forsion_token', value: ${JSON.stringify(TOKEN)} })`)
  // WebView 里装一个最小 SSE 循环:收到就转交原生(模拟 appStore → surface.exec 这一段)
  await evaluate(`(() => { if (window.__emuSoak) return 'already'; window.__emuSoak = new EventSource('http://localhost:${ENGINE_PORT}/emu/events');
    window.__emuSoak.onmessage = (e) => { try { ${PC}.exec(JSON.parse(e.data)) } catch (err) {} }; return 'ok' })()`)
  // island:模拟真实 run 期间灵动岛的 dataSync 前台服务(真 run 里由 liveIsland.ts 驱动),对照有/无前台服务的冻结行为
  if (island) await evaluate(`Capacitor.Plugins.LiveIsland.show({ title: 'soak', text: 'x', chip: '', since: Date.now(), sessionId: 's', channelName: 'c', more: 0 })`)
  adb('shell', 'am', 'start', '-a', 'android.intent.action.SHOW_ALARMS')
  await sleep(2000)
  const issued = []
  const t0 = Date.now()
  while (Date.now() - t0 < seconds * 1000) {
    const c = issue('volume', { dir: issued.length % 2 ? 'down' : 'up' })
    issued.push(c.ackId)
    for (const s of sseClients) s.write(`data: ${JSON.stringify(c)}\n\n`)
    await sleep(10000)
  }
  await sleep(5000)
  const lat = issued.map((a) => pending.get(a)?.results[0]?.dt).filter((x) => x != null).sort((a, b) => a - b)
  const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]
  if (island) await evaluate(`Capacitor.Plugins.LiveIsland.reset()`).catch(() => null)
  check(`soak ${seconds}s${island ? ' +island FGS' : ''} with Clock in front: delivered ${lat.length}/${issued.length}`, lat.length === issued.length, { p50: q(0.5), p95: q(0.95), sseClients: sseClients.size, top: topActivity() })
}

;(async () => {
  await new Promise((r) => server.listen(ENGINE_PORT, '127.0.0.1', r))
  const [cmd, arg] = process.argv.slice(2)
  try {
    if (cmd === 'soak') await soak(Number(arg) || 120, process.argv[4] === 'island')
    else if (cmd === 'probe') {
      // 单条探测:node scripts/phone-control-emu.cjs probe <op> '<args JSON>' —— 打印完整回执(排查用;需已有租约,否则会弹同意)
      adb('reverse', `tcp:${ENGINE_PORT}`, `tcp:${ENGINE_PORT}`)
      // ⚠️ 前台服务只能在前台起(Android 12+):先切回 Forsion 起灵动岛,再切到要操作的 App(PROBE_ACTION,缺省「设置」)
      launchForsion(); await sleep(2500)
      await evaluate(`Capacitor.Plugins.LiveIsland.show({ title: 'emu probe', text: 'x', chip: '', since: Date.now(), sessionId: 's', channelName: 'c', more: 0 })`)
      adb('shell', 'am', 'start', '-a', process.env.PROBE_ACTION || 'android.settings.SETTINGS'); await sleep(2500)
      const pc = issue(arg, JSON.parse(process.argv[4] || '{}'), { execMs: 30000 })
      await exec(pc)
      const pr = await waitResult(pc.ackId, 35000)
      console.log(JSON.stringify(pr && { ...pr, image: pr.image ? `${pr.image.length} chars` : undefined }, null, 1))
      await evaluate(`Capacitor.Plugins.LiveIsland.reset()`).catch(() => null)
    }
    else if (cmd === 't2') {
      // 只跑 T2 屏幕块(T1 用例已多次全绿;T1 里的 uiautomator 每调一次都会让伴随包服务重连一次)
      adb('reverse', `tcp:${ENGINE_PORT}`, `tcp:${ENGINE_PORT}`)
      launchForsion(); await sleep(5000)
      await setToken(TOKEN); await sleep(800)
      // ⚠️ 模拟真实 run:灵动岛 dataSync 前台服务在,Forsion 退到后台(台架去开「设置」)才不被冻结 / 断网。
      //    09-26 实测没有它:后台 ~1 分钟后 claim / result 全是 UnknownHostException(进程网络被系统掐了),T2 全线无回执。契约 §7。
      await evaluate(`Capacitor.Plugins.LiveIsland.show({ title: 'emu t2', text: 'x', chip: '', since: Date.now(), sessionId: 's', channelName: 'c', more: 0 })`)
      // 预热:模拟器冷启动后网络栈要一两分钟才就绪(09-26 实测前 ~90s claim 全是 UnknownHostException,浮层根本不会弹)。
      // 先用一条 T1 volume 往返确认 claim 链路通了,再进要人点的 T2 块。
      let warm = null
      for (const t0 = Date.now(); !warm && Date.now() - t0 < 180000;) {
        const w = issue('volume', { dir: 'up' }); await exec(w)
        const wr = await waitResult(w.ackId, 8000)
        if (wr && wr.ok) warm = wr; else await sleep(3000)
      }
      check('warm-up: claim path reachable (T1 volume round-trip)', !!warm, warm)
      const st = await evaluate(`${PC}.status()`)
      check('precondition: phone control on, hands ready, phone.ui declared', st && st.enabled && st.hands === 'ready' && (st.capabilities || []).includes('phone.ui'), st)
      if (st && st.hands === 'ready') await runT2()
      await evaluate(`Capacitor.Plugins.LiveIsland.reset()`).catch(() => null)
    }
    else await runCases()
  } catch (e) {
    check('harness', false, e.message)
  }
  server.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed${skipped.length ? `, ${skipped.length} skipped` : ''}`)
  if (skipped.length) console.log('(SKIP = precondition not met on this device; see the note printed above each)')
  process.exit(failed.length ? 1 : 0)
})()
