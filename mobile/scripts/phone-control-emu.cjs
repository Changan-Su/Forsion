/**
 * 手机操控(T1)模拟器台架 —— 假引擎 + CDP,直测「原生 claim → 执行 → result」这条链。
 * 契约:tangu-agent/docs/phone-control.md。渲染层的 G2/G3 早筛由 desktop vitest 覆盖,这里只测原生侧。
 *
 * 前置(一次):
 *   AVD 已开机(emulator -avd Forsion_API_35),adb 在 $ANDROID_HOME/platform-tools
 *   cd mobile && rm -rf dist && VITE_API_ORIGIN=http://localhost:8787 npm run build && npx cap sync android \
 *     && (cd android && ./gradlew assembleDebug) && adb install -r android/app/build/outputs/apk/debug/app-debug.apk
 *   (debug 包带 network_security_config,只对 localhost 放行明文;release 不受影响)
 *
 * 用法:
 *   node scripts/phone-control-emu.cjs           全部用例
 *   node scripts/phone-control-emu.cjs soak 300  中继存活:Clock 在前台 300 秒,WebView 里的 SSE 循环每 10s 转交一条 volume 指令
 *
 * 判据只认假引擎这一侧的账(收到几次 claim / result、结果码),辅以 logcat 的 START 与顶层 Activity ——
 * 「调用没抛」不算数(见 memory:浏览器台架打返回键那一课)。
 */
const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library/Android/sdk')
const adb = (...args) => execFileSync(path.join(sdk, 'platform-tools/adb'), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const PKG = process.env.PKG || 'com.forsion.tangu'
const ENGINE_PORT = 8787
const CDP_PORT = 9341
const TOKEN = 'phone-emu-token'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ───────────────────────────── 假引擎 ─────────────────────────────
const pending = new Map() // ackId -> { runId, body, digest, state, nonce, claims, results, t0 }
const ledger = [] // { t, ackId, phase, status, body }
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
  const m = url.pathname.match(/^\/api\/agent\/runs\/([^/]+)\/inquiries\/([^/]+)$/)
  if (m && req.method === 'POST') {
    const [, runId, ackId] = m.map(decodeURIComponent)
    const b = await readJson(req)
    const p = pending.get(ackId)
    const log = (status) => ledger.push({ t: Date.now(), ackId, phase: b.phase, status, body: b })
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { log(401); return send(401, { detail: 'bad token' }) }
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

  launchForsion()
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
    else await runCases()
  } catch (e) {
    check('harness', false, e.message)
  }
  server.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})()
