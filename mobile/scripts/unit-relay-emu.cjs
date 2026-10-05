/**
 * 手机原生中继模拟器台架(P1-K8)—— 假 hub + CDP,直测「原生登记 → 换票 → 中继注头 → 流式 / 取消 / 坏票重发 / 失败关闭」这条链。
 * 判据只认假 hub 这一侧的账(收到了什么请求、带了什么头、连接何时断开),不认「调用没抛」。
 *
 * 前置(一次;真机或 AVD 都行,本台架只用 adb + CDP):
 *   AVD 已开机(emulator -avd Forsion_API_35 -no-window -no-snapshot-save),adb 在 $ANDROID_HOME/platform-tools
 *   cd mobile && rm -rf dist && VITE_API_ORIGIN=http://localhost:8788 npm run build && npx cap sync android \
 *     && (cd android && ./gradlew :app:assembleDebug) && adb install -r android/app/build/outputs/apk/debug/app-debug.apk
 *   (debug 包带 network_security_config,只对 localhost 放行明文;release 不受影响)
 *   ⚠️ cap sync 会把 android/capacitor.settings.gradle 改写成 node_modules 软链的真实路径 —— 别提交那份改动。
 *
 * 用法:
 *   ANDROID_SERIAL=emulator-5584 node scripts/unit-relay-emu.cjs
 *   NEGCTL=failclosed ...   负对照(配合临时去掉 UnitRelay 失败关闭分支的包):S4 那条必须红
 *   SKIP_RELOAD=1 ...       跳过 ⑤b 重载段(对修复前的包跑负对照时用:那段泄漏会占满 16 个名额,后面的用例全被 relay_busy 挡住)
 *
 * 覆盖:懒登记带 kind=phone(登记前先探 caller-token 路由)、caller-secret 带 X-Unit-Secret、换票带 X-Unit-Caller-Secret;
 * 中继请求带 X-Forsion-Caller 且 Authorization 是原生 token 而不是 JS 递的诱饵(S3);非中继请求不带票;SSE 逐块到达;
 * JS abort 后 hub 1s 内见到断开;**WebView 重载后 hub 1s 内见到在途中继断开、16 条流重载后名额全还回来**(评审 P1);
 * 403 UNIT_CALLER_INVALID 换票重发一次;PATCH 过得去;**中继不带、不存全局 cookie 罐里的 cookie**(评审 P2);
 * 换不到票三种原因(评审 P1):换票 500 → TypeError(network,不是终局)、换票 401 → 合成 401、明确拒绝 → 合成 503
 * CALLER_UNAVAILABLE,三种 hub 都零匿名请求(S4);换号重登记、A 的条目仍在(S7);移除本机 → DELETE,**之后中继请求不悄悄重新登记**
 * (评审 P2);**慢网登记途中 status() 与别的插件调用不被卡住**(评审 P2);shared_prefs / localStorage / Preferences / logcat
 * 里扫不到任何 secret 与票(S1,先植入标记证明扫描器读得到)。
 */
const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library/Android/sdk')
const SERIAL = process.env.ANDROID_SERIAL || ''
const adb = (...args) => execFileSync(path.join(sdk, 'platform-tools/adb'), [...(SERIAL ? ['-s', SERIAL] : []), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const PKG = 'com.forsion.tangu'
const PORT = Number(process.env.HUB_PORT || 8788)
const CDP_PORT = Number(process.env.CDP_PORT || 9352)
const API = `http://localhost:${PORT}/api`
const NEGCTL = process.env.NEGCTL || ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TARGET = '0f8fad5b-d9cb-469f-a165-70867728950e' // 「我的电脑」的 unit id(假 hub 不校验它是谁的)
const UNIT_RELAY_SLOTS = 16 // UnitRelay.MAX_CONCURRENT

const b64u = (s) => Buffer.from(s).toString('base64url')
const jwt = (userId) => `${b64u('{"alg":"HS256","typ":"JWT"}')}.${b64u(JSON.stringify({ userId, username: userId }))}.emu-sig`
const TOKEN_A = jwt('u_emu_a')
const TOKEN_B = jwt('u_emu_b')
const userOf = (auth) => {
  const m = /^Bearer (.+)$/.exec(auth || '')
  if (!m) return null
  try { return JSON.parse(Buffer.from(m[1].split('.')[1], 'base64url').toString()).userId || null } catch { return null }
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

// ───────────────────────────── 假 hub ─────────────────────────────
const rows = new Map() // id -> { user, secretHash, callerHash, kind, name }
const issued = { secrets: [], callerSecrets: [], tokens: new Map() } // token -> { unit, user }
const ledger = [] // { t, method, path, headers, body }
const proxy = [] // { t, method, path, caller, auth }
const hub = { mintFail: null, invalidOnceHit: 0, registerDelayMs: 0 }
const PROBE_UNIT = '00000000-0000-0000-0000-000000000000'
const openStreams = new Set() // 在途的中继 SSE(hub 侧的 res)
let sse = null
let sseClosedAt = 0

function readBody(req) {
  return new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c }); req.on('end', () => resolve(s)) })
}

const server = http.createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-Forsion-Client',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
  const body = await readBody(req)
  const url = new URL(req.url, 'http://x')
  const p = url.pathname
  ledger.push({ t: Date.now(), method: req.method, path: req.url, headers: { ...req.headers }, body })
  const send = (code, obj, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', Date: new Date().toUTCString(), ...cors, ...extra }); res.end(JSON.stringify(obj)) }
  const user = userOf(req.headers.authorization)
  if (p === '/api/auth/me') return user ? send(200, { id: user, username: user }) : send(401, { detail: 'no' })
  if (p === '/api/auth/refresh') return send(401, { detail: 'emu: no refresh' })
  if (p === '/api/agent/sessions') return send(200, { sessions: [] }) // 云端 home 引擎的会话列表(截图里别挂加载失败的 toast)
  if (!user) return send(401, { detail: 'no token' })
  if (p === '/api/units' && req.method === 'GET') {
    return send(200, { units: [{ id: TARGET, name: 'Emu Mac', platform: 'darwin', icon: null, online: true, kind: 'desktop', capsLive: true, caps: { engine: 'ready', tools: [] } }] })
  }
  if (p === '/api/units/register' && req.method === 'POST') {
    if (hub.registerDelayMs) await sleep(hub.registerDelayMs)
    let b = {}
    try { b = JSON.parse(body || '{}') } catch { /* ignore */ }
    const id = crypto.randomUUID()
    const secret = crypto.randomBytes(32).toString('hex')
    issued.secrets.push(secret)
    rows.set(id, { user, secretHash: sha(secret), callerHash: null, kind: b.kind || 'desktop', name: b.name })
    return send(200, { unitId: id, secret })
  }
  let m
  if ((m = /^\/api\/units\/([^/]+)\/caller-secret$/.exec(p)) && req.method === 'POST') {
    const r = rows.get(m[1])
    if (!r || r.user !== user) return send(404, { code: 'UNIT_NOT_FOUND' })
    if (sha(String(req.headers['x-unit-secret'] || '')) !== r.secretHash) return send(403, { code: 'UNIT_SECRET_MISMATCH' })
    const cs = crypto.randomBytes(32).toString('hex')
    issued.callerSecrets.push(cs)
    r.callerHash = sha(cs)
    return send(200, { unitId: m[1], callerSecret: cs })
  }
  if ((m = /^\/api\/units\/([^/]+)\/caller-token$/.exec(p)) && req.method === 'POST') {
    const r = rows.get(m[1])
    if (!r || r.user !== user) return send(404, { code: 'UNIT_NOT_FOUND' })
    if (!r.callerHash || sha(String(req.headers['x-unit-caller-secret'] || '')) !== r.callerHash) return send(403, { code: 'UNIT_CALLER_SECRET_MISMATCH' })
    if (hub.mintFail) return send(hub.mintFail.status, hub.mintFail.body)
    const token = `fuc1.${crypto.randomBytes(18).toString('base64url')}.${crypto.randomBytes(8).toString('base64url')}`
    issued.tokens.set(token, { unit: m[1], user })
    return send(200, { unitId: m[1], token, expiresAt: Math.floor(Date.now() / 1000) + 600 })
  }
  if ((m = /^\/api\/units\/([^/]+)$/.exec(p)) && req.method === 'DELETE') {
    const r = rows.get(m[1])
    if (!r || r.user !== user) return send(404, { code: 'UNIT_NOT_FOUND' })
    rows.delete(m[1])
    return send(200, { ok: true })
  }
  if ((m = /^\/api\/units\/([^/]+)\/proxy(\/.*)$/.exec(p))) {
    const sub = m[2]
    const caller = req.headers['x-forsion-caller']
    proxy.push({ t: Date.now(), method: req.method, path: sub + url.search, caller: caller || null, auth: req.headers.authorization || null, cookie: req.headers.cookie || null })
    if (caller !== undefined) {
      const tk = issued.tokens.get(caller)
      if (!tk || tk.user !== user) return send(403, { code: 'UNIT_CALLER_INVALID', detail: 'emu: bad ticket' })
    }
    if (sub === '/engine/agent/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...cors })
      res.write('data: one\n\n')
      sse = res
      sseClosedAt = 0
      openStreams.add(res)
      res.on('close', () => { openStreams.delete(res); if (sse === res) { sse = null; sseClosedAt = Date.now() } })
      return
    }
    if (sub === '/engine/agent/set-cookie') return send(200, { ok: true }, { 'Set-Cookie': 'k8relay=from-relay; Path=/' })
    if (sub === '/engine/agent/invalid-once' && hub.invalidOnceHit++ === 0) return send(403, { code: 'UNIT_CALLER_INVALID', detail: 'emu: first ticket refused' })
    if (sub === '/engine/agent/always-invalid') return send(403, { code: 'UNIT_CALLER_INVALID', detail: 'emu: always' })
    if (sub === '/unit/remote-access') return send(200, { remoteSessions: true, principal: 'unit', caller: 'trusted', maxApprovalMode: 'auto-edit' })
    return send(200, { ok: true, method: req.method, sub, body: body || null })
  }
  send(200, {})
})

// ───────────────────────────── CDP ─────────────────────────────
async function evaluate(expr, timeoutMs = 30000) {
  const pid = adb('shell', 'pidof', PKG).trim()
  if (!pid) throw new Error('app 没在跑')
  adb('forward', `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`)
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && /localhost/.test(t.url)) || list.find((t) => t.type === 'page')
  if (!page) throw new Error('找不到 WebView 页')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  const res = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('求值超时')), timeoutMs)
    ws.onmessage = (msg) => { const d = JSON.parse(msg.data); if (d.id === 1) { clearTimeout(t); resolve(d.result) } }
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
  })
  ws.close()
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text)
  return res.result.value
}
const js = (body) => evaluate(`(async () => { ${body} })()`)

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${JSON.stringify(detail).slice(0, 600)}`}`)
}

async function boot() {
  adb('reverse', `tcp:${PORT}`, `tcp:${PORT}`)
  adb('shell', 'am', 'force-stop', PKG)
  adb('shell', 'pm', 'clear', PKG) // 每次从「从没登记过」起跑(上一轮的身份条目与 token 都清掉)
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`)
  await sleep(4000)
  // 没 token 时垫片会去开登录页:先把 token 放进 Preferences(= 登录回跳存进来的那一处),再冷启一次。
  // ⚠️ Preferences.set 走的是 SharedPreferences.apply()(异步落盘):立刻 force-stop 会把这次写整个丢掉,
  //    所以读回 CapacitorStorage.xml 确认落了盘再杀。
  for (let i = 0; i < 30; i++) {
    try {
      await evaluate(`Capacitor.Plugins.Preferences.set({ key: 'forsion_token', value: ${JSON.stringify(TOKEN_A)} }).then(() => 'ok')`)
      // 首启引导是全屏覆盖层,台架一律当老用户(截图里别盖着它)
      await evaluate(`localStorage.setItem('forsion_tangu_onboarding_done', '1'), 'ok'`)
      await sleep(1500)
      if (adb('shell', `run-as ${PKG} cat shared_prefs/CapacitorStorage.xml`).includes('forsion_token')) break
    } catch (e) { if (process.env.EMU_DEBUG) console.log('  boot: token step', String(e.message || e).slice(0, 160)) }
    await sleep(1000)
  }
  if (!adb('shell', `run-as ${PKG} cat shared_prefs/CapacitorStorage.xml`).includes('forsion_token')) throw new Error('token 没落进 CapacitorStorage')
  adb('shell', 'am', 'force-stop', PKG)
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`)
  let last = null
  for (let i = 0; i < 90; i++) {
    try { last = await evaluate('JSON.stringify({ url: location.href, unit: !!(window.tangu && window.tangu.unitSelf) })'); if (JSON.parse(last).unit) return } catch (e) { last = String(e.message || e) }
    await sleep(1000)
  }
  throw new Error(`垫片没装上(window.tangu.unitSelf 缺席):${last}`)
}

async function run() {
  // 预热:模拟器冷启动后网络栈要一会儿才就绪(reference 台架实测),先确认 WebView 能打到假 hub。
  for (let i = 0; i < 60; i++) {
    const ok = await js(`try { const r = await fetch(${JSON.stringify(API + '/auth/me')}, { headers: { Authorization: 'Bearer ${TOKEN_A}' } }); return r.status } catch (e) { return String(e) }`).catch(() => 0)
    if (ok === 200) break
    await sleep(2000)
  }

  const self0 = await js('return await window.tangu.unitSelf()')
  check('懒登记:启动后还没登记;中继可用(启动断言 cloudApiBase === 原生 apiBase 成立)', self0 && self0.registered === false && self0.relay === 'ready', self0)
  check('懒登记:没用这功能之前 hub 一次 register 都没收到', !ledger.some((l) => l.path === '/api/units/register'), ledger.map((l) => l.path))

  // ① 中继请求:JS 递诱饵 Authorization + 伪造的 X-Forsion-Caller
  const r1 = await js(`const r = await fetch(${JSON.stringify(`${API}/units/${TARGET}/proxy/engine/agent/sessions`)}, { headers: { Authorization: 'Bearer js-decoy', 'X-Forsion-Caller': 'js-forged', Accept: 'application/json' } }); return { status: r.status, body: await r.text() }`)
  const reg = ledger.filter((l) => l.path === '/api/units/register')
  const regBody = reg[0] ? JSON.parse(reg[0].body || '{}') : {}
  check('首个中继请求触发登记,kind=phone / platform=android', reg.length === 1 && regBody.kind === 'phone' && regBody.platform === 'android', regBody)
  const cs = ledger.filter((l) => /\/caller-secret$/.test(l.path))
  check('caller-secret 带 X-Unit-Secret(设备密钥)', cs.length === 1 && !!cs[0].headers['x-unit-secret'], cs.map((c) => Object.keys(c.headers)))
  const probeAt = ledger.findIndex((l) => l.path === `/api/units/${PROBE_UNIT}/caller-token`)
  const regAt = ledger.findIndex((l) => l.path === '/api/units/register')
  const probe = ledger.filter((l) => l.path === `/api/units/${PROBE_UNIT}/caller-token`)
  check('评审 P2:登记前先探一次 caller-token 路由(老 server 一行不建);探测不带任何 secret', probe.length === 1 && probeAt >= 0 && probeAt < regAt && !probe[0].headers['x-unit-secret'] && !probe[0].headers['x-unit-caller-secret'], { probeAt, regAt, probe: probe.map((c) => Object.keys(c.headers)) })
  const isMint = (l) => /\/caller-token$/.test(l.path) && !l.path.includes(PROBE_UNIT)
  const mint = ledger.filter(isMint)
  check('换票带 X-Unit-Caller-Secret、不带设备密钥', mint.length === 1 && !!mint[0].headers['x-unit-caller-secret'] && !mint[0].headers['x-unit-secret'], mint.map((c) => Object.keys(c.headers)))
  const p1 = proxy.filter((x) => x.path === '/engine/agent/sessions')
  check('中继请求到 hub 带 X-Forsion-Caller(hub 签发过的那张)', r1.status === 200 && p1.length === 1 && issued.tokens.has(p1[0].caller), { r1, p1 })
  check('S3:Authorization 是原生 token,不是 JS 递的诱饵', p1[0]?.auth === `Bearer ${TOKEN_A}`, p1[0]?.auth)

  // ② 非中继:设备辅助面照旧匿名(不带票)
  const before = proxy.length
  await js(`await fetch(${JSON.stringify(`${API}/units/${TARGET}/proxy/unit/hostfile?path=x`)}, { headers: { Authorization: 'Bearer ${TOKEN_A}' } }); return 1`)
  // 窗口里只认本步自己发的那条:应用的跨设备会话聚合(deviceSessionsStore)登记后会定时经中继拉那台的会话列表,
  // 落进这个窗口不算数(2026-10-05 连红两次才看出来;之前一直是时序上碰巧错开)。
  const p2 = proxy.slice(before).filter((x) => x.path.startsWith('/unit/hostfile'))
  check('非中继请求(unit/hostfile)不带 X-Forsion-Caller', p2.length === 1 && p2[0].caller === null, p2)

  // ③ remote-access 也经中继(R-06)
  const ra = await js(`const r = await fetch(${JSON.stringify(`${API}/units/${TARGET}/proxy/unit/remote-access`)}); return await r.json()`)
  const p3 = proxy.filter((x) => x.path === '/unit/remote-access')
  check('GET /unit/remote-access 经中继、带票', ra && ra.caller === 'trusted' && p3.length === 1 && !!p3[0].caller, { ra, p3 })

  // ④ PATCH(会话改名 / 会话配置 PATCH)
  const pa = await js(`const r = await fetch(${JSON.stringify(`${API}/units/${TARGET}/proxy/engine/agent/sessions/s1`)}, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"title":"x"}' }); return await r.json()`)
  check('PATCH 经中继原样到 hub(方法与体)', pa && pa.method === 'PATCH' && pa.body === '{"title":"x"}', pa)

  // ⑤ SSE 逐块 + abort 传播
  await js(`window.__sse = { chunks: [] }; window.__sseAc = new AbortController();
    fetch(${JSON.stringify(`${API}/units/${TARGET}/proxy/engine/agent/events`)}, { headers: { Accept: 'text/event-stream' }, signal: window.__sseAc.signal })
      .then(async (r) => { const rd = r.body.getReader(); const dec = new TextDecoder(); for (;;) { const { value, done } = await rd.read(); if (done) break; window.__sse.chunks.push(dec.decode(value)) } window.__sse.done = true })
      .catch((e) => { window.__sse.err = e.name }); return 1`)
  let firstSeen = false
  for (let i = 0; i < 50 && !firstSeen; i++) { firstSeen = await js('return window.__sse.chunks.join("").includes("one")'); if (!firstSeen) await sleep(100) }
  check('SSE 第一块在 hub 写第二块之前就到了(不攒包)', firstSeen && !!sse, { firstSeen, sseOpen: !!sse })
  const lat = []
  for (let k = 0; k < 5 && sse; k++) {
    const tag = `tick${k}`
    const t0 = Date.now()
    sse.write(`data: ${tag}\n\n`)
    for (let i = 0; i < 100; i++) { if (await js(`return window.__sse.chunks.join("").includes(${JSON.stringify(tag)})`)) { lat.push(Date.now() - t0); break } await sleep(20) }
  }
  check(`SSE 后续块逐条到达(5 条,含 CDP 轮询开销的上界 ${JSON.stringify(lat)}ms)`, lat.length === 5, lat)
  const tAbort = Date.now()
  await js('window.__sseAc.abort(); return 1')
  for (let i = 0; i < 40 && sse; i++) await sleep(50)
  const errName = await js('return window.__sse.err || null')
  check('JS abort → hub 1s 内见到断开;reader 以 AbortError 结束', !sse && sseClosedAt > 0 && sseClosedAt - tAbort < 1000 && errName === 'AbortError', { closedIn: sseClosedAt - tAbort, errName })

  // ⑤b 评审 P1:WebView 重载(深链重登 / 切界面模式 / ErrorBoundary 都会 reload)→ 旧页面的在途中继必须收掉:
  //     不收的话长连 SSE 一直读、一直占着 16 个名额,几次重载后手机再也连不上任何电脑(relay_busy)。
  const waitShim = async () => { for (let i = 0; i < 60; i++) { try { if (await evaluate('!!(window.tangu && window.tangu.unitSelf)')) return true } catch { /* 重载中 */ } await sleep(500) } return false }
  const openSse = (n) => js(`for (let k = 0; k < ${n}; k++) fetch(${JSON.stringify(`${API}/units/${TARGET}/proxy/engine/agent/events`)}, { headers: { Accept: 'text/event-stream' } }).then(async (r) => { const rd = r.body.getReader(); for (;;) { const { done } = await rd.read(); if (done) break } }).catch(() => {}); return 1`)
  const reloadPage = async () => {
    const t0 = Date.now()
    await evaluate('setTimeout(() => location.reload(), 50), 1').catch(() => 0)
    for (let i = 0; i < 150 && openStreams.size > 0; i++) await sleep(20)
    const ms = Date.now() - t0
    await waitShim()
    return ms
  }
  if (!process.env.SKIP_RELOAD) {
  await openSse(1)
  for (let i = 0; i < 100 && openStreams.size < 1; i++) await sleep(50)
  const opened1 = openStreams.size
  const closeMs = await reloadPage()
  check(`评审 P1:WebView 重载 → 在途中继 SSE 在 hub 侧 1s 内断开(实测 ${closeMs}ms,含 50ms 触发延迟)`, opened1 === 1 && openStreams.size === 0 && closeMs < 1100, { opened1, stillOpen: openStreams.size, closeMs })
  await openSse(UNIT_RELAY_SLOTS)
  for (let i = 0; i < 200 && openStreams.size < UNIT_RELAY_SLOTS; i++) await sleep(50)
  const openedAll = openStreams.size
  const closeMsAll = await reloadPage()
  await sleep(300)
  const afterReload = await js(`try { const r = await fetch(${JSON.stringify(`${API}/units/${TARGET}/proxy/engine/agent/sessions`)}); return 'status ' + r.status } catch (e) { return 'threw ' + e.name + ' ' + JSON.stringify(e.cause || null) }`)
  check(`评审 P1:${UNIT_RELAY_SLOTS} 条中继 SSE 占满名额 → 重载 → 全部断开,新页面的中继请求照常 200(不是 relay_busy)`, openedAll === UNIT_RELAY_SLOTS && openStreams.size === 0 && afterReload === 'status 200', { openedAll, stillOpen: openStreams.size, closeMsAll, afterReload })
  } // SKIP_RELOAD=1:跳过重载这段(负对照:老包在这里泄漏占满名额,后面的用例就全被 relay_busy 挡住,跳过才看得到它们各自的红)

  // ⑥ 坏票重发一次(R-04)
  const mintsBefore = ledger.filter(isMint).length
  const r6 = await js(`const r = await fetch(${JSON.stringify(`${API}/units/${TARGET}/proxy/engine/agent/invalid-once`)}); return r.status`)
  const p6 = proxy.filter((x) => x.path === '/engine/agent/invalid-once')
  const mintsAfter = ledger.filter(isMint).length
  check('403 UNIT_CALLER_INVALID → 强制换票重发一次,JS 拿到 200', r6 === 200 && p6.length === 2 && p6[0].caller !== p6[1].caller && mintsAfter === mintsBefore + 1, { r6, p6: p6.length, mints: mintsAfter - mintsBefore })

  // ⑥b 评审 P2:中继不碰进程全局 cookie 罐 —— CapacitorCookies 在 load() 里无条件把 WebView 的罐装成全局 CookieHandler,
  //     不挡的话中继请求会带上 apiBase 主机的 cookie(设备页种下的 forsion_unit_session 可能是上一个账号的 token)、还把 Set-Cookie 存回去。
  await evaluate(`Capacitor.Plugins.CapacitorCookies.setCookie({ url: 'http://localhost:${PORT}', key: 'forsion_unit_session', value: 'k8stale' }).then(() => 'ok')`)
  const jar0 = await js('return document.cookie')
  const ck0 = proxy.length
  await js(`const r = await fetch(${JSON.stringify(`${API}/units/${TARGET}/proxy/engine/agent/set-cookie`)}); return r.status`)
  await js(`const r = await fetch(${JSON.stringify(`${API}/units/${TARGET}/proxy/engine/agent/sessions`)}); return r.status`)
  const ck = proxy.slice(ck0)
  const jar1 = await js('return document.cookie')
  check('评审 P2 仪器自检:植入的 cookie 真在 WebView 罐里(document.cookie 读得到 k8stale)', /k8stale/.test(jar0), jar0)
  check('评审 P2:中继请求不带全局罐里的 cookie;中继响应的 Set-Cookie 不进罐', ck.filter((x) => x.path === '/engine/agent/set-cookie' || x.path === '/engine/agent/sessions').length === 2 && ck.every((x) => !x.cookie) && !/k8relay/.test(jar1), { cookies: ck.map((x) => x.cookie), jar1 })
  await evaluate(`Capacitor.Plugins.CapacitorCookies.deleteCookie({ url: 'http://localhost:${PORT}', key: 'forsion_unit_session' }).then(() => 'ok')`).catch(() => 0)

  // ⑦ S4 失败关闭 × 三种原因(评审 P1):缓存票被拒 → 强制换票 → 换票失败。三种都不发匿名请求,但交给渲染层的不一样:
  //     短暂失败(500)→ TypeError(network,K6 当离线、网络回来就续);token 被拒(401)→ 合成 401(复检账号);
  //     明确拒绝(400 UNIT_KIND_INVALID)→ 合成 503 CALLER_UNAVAILABLE(终局)。原先三种都是终局的 503 —— 一次断网永久判死。
  const anonCount = () => proxy.filter((x) => x.caller === null && /^\/(engine|unit\/remote-access)/.test(x.path)).length
  const anonBefore = anonCount()
  const hitInvalid = () => js(`try { const r = await fetch(${JSON.stringify(`${API}/units/${TARGET}/proxy/engine/agent/always-invalid`)}); return { status: r.status, body: await r.text() } } catch (e) { return { threw: e.name, cause: e.cause || null } }`)
  const jsonCode = (r) => { try { return JSON.parse(r.body).code ?? null } catch { return 'not-json' } }
  hub.mintFail = { status: 500, body: { detail: 'emu: mint down' } }
  const r7a = await hitInvalid()
  hub.mintFail = { status: 401, body: { detail: 'Invalid or expired token' } }
  const r7b = await hitInvalid()
  hub.mintFail = { status: 400, body: { detail: 'emu', code: 'UNIT_KIND_INVALID' } }
  const r7c = await hitInvalid()
  hub.mintFail = null
  const anonAfter = anonCount()
  const neg = NEGCTL === 'failclosed' ? '(NEGCTL:本条应红)' : ''
  check('S4 / 评审 P1:换票 500(短暂)→ TypeError(cause.code = network),不合成终局的 503', r7a.threw === 'TypeError' && r7a.cause?.code === 'network', r7a)
  check('S4 / 评审 P1:换票 401(forsion_token 被拒)→ 合成 401、不带码(K6 判 account-auth?,复检账号)', r7b.status === 401 && jsonCode(r7b) === null, r7b)
  check('S4:明确拒绝(400 UNIT_KIND_INVALID)→ 合成 503 CALLER_UNAVAILABLE', r7c.status === 503 && jsonCode(r7c) === 'CALLER_UNAVAILABLE', r7c)
  check(`S4:三种原因下 hub 收到的匿名中继请求都 = 0${neg}`, anonAfter === anonBefore, { anon: anonAfter - anonBefore })
  if (NEGCTL === 'failclosed') return

  // ⑧ unitSelf / unitEnsureSelf
  const self1 = await js('return await window.tangu.unitSelf()')
  const ens = await js('return await window.tangu.unitEnsureSelf()')
  const regA = [...rows.entries()].find(([, r]) => r.user === 'u_emu_a')
  check('unitSelf / unitEnsureSelf 报的是 hub 里那行;结果里没有任何凭据字段', self1.registered && regA && self1.unitId === regA[0] && ens.ok && ens.unitId === regA[0] && !JSON.stringify([self1, ens]).match(/secret|token|fuc1/i), { self1, ens })

  // ⑨ S7 换号:B 账号重新登记,A 的条目仍在
  await evaluate(`Capacitor.Plugins.Preferences.set({ key: 'forsion_token', value: ${JSON.stringify(TOKEN_B)} }).then(() => 'ok')`)
  const r9 = await js(`const r = await fetch(${JSON.stringify(`${API}/units/${TARGET}/proxy/engine/agent/sessions`)}); return r.status`)
  const regs = ledger.filter((l) => l.path === '/api/units/register')
  const p9 = proxy.filter((x) => x.path === '/engine/agent/sessions').at(-1)
  const tk9 = p9 && issued.tokens.get(p9.caller)
  const prefs = adb('shell', `run-as ${PKG} cat shared_prefs/forsion_unit.xml`)
  const entries = (prefs.match(/name="acct\.[0-9a-f]{64}"/g) || []).length
  check('S7:换号后 B 重新登记、用 B 的票与 B 的 token;A 的条目仍在(2 条)', r9 === 200 && regs.length === 2 && tk9 && tk9.user === 'u_emu_b' && p9.auth === `Bearer ${TOKEN_B}` && entries === 2, { r9, regs: regs.length, tk9, entries })

  // ⑩ 移除本机登记 → DELETE B 那行
  const regB = [...rows.entries()].find(([, r]) => r.user === 'u_emu_b')
  const fg = await js('return await window.tangu.unitForgetSelf()')
  const del = ledger.filter((l) => l.method === 'DELETE' && regB && l.path === `/api/units/${regB[0]}`)
  const self2 = await js('return await window.tangu.unitSelf()')
  check('unitForgetSelf → DELETE /units/:id,本地条目没了', fg.ok && del.length === 1 && self2.registered === false, { fg, del: del.length, self2 })

  // ⑩b 评审 P2:移除之后到达的中继请求(集成后 = 那台电脑的轮询 / SSE 重连)不许借懒登记悄悄登记出新身份
  const regCount = () => ledger.filter((l) => l.path === '/api/units/register').length
  const regs10 = regCount()
  const r10 = await js(`const r = await fetch(${JSON.stringify(`${API}/units/${TARGET}/proxy/engine/agent/sessions`)}); return { status: r.status, body: await r.text() }`)
  check('评审 P2:移除本机后的中继请求 → 503 CALLER_UNAVAILABLE,不悄悄重新登记(名册零新行)', r10.status === 503 && jsonCode(r10) === 'CALLER_UNAVAILABLE' && regCount() === regs10, { r10, regs: regCount() - regs10 })

  // ⑩c 评审 P2:慢网登记(hub 让 register 慢 6s)途中,status() 与别的插件调用不排在它后面(Capacitor 所有插件共用一条线程)
  //     先确保从「未登记」起步(修复前的包在 ⑩b 已经悄悄重登过,不移除的话 ensureRegistered 不走网络、测不到卡顿)
  await js('return await window.tangu.unitForgetSelf()')
  const regs10c = regCount()
  hub.registerDelayMs = 6000
  const blk = await js(`const P = Capacitor.Plugins; const t0 = performance.now();
    const reg = P.ForsionUnit.ensureRegistered().then(() => Math.round(performance.now() - t0), (e) => 'rej ' + e.code);
    await new Promise((r) => setTimeout(r, 400));
    const t1 = performance.now();
    const st = P.ForsionUnit.status().then(() => Math.round(performance.now() - t1));
    const pf = P.Preferences.get({ key: 'forsion_token' }).then(() => Math.round(performance.now() - t1)); // 同时发:别的插件排不排在后面
    return { statusMs: await st, prefMs: await pf, regAt: await reg }`)
  hub.registerDelayMs = 0
  check(`评审 P2:慢网登记途中 status() / Preferences.get 不被卡住(${blk && blk.statusMs}ms / ${blk && blk.prefMs}ms,登记本身 ${blk && blk.regAt}ms)`, blk && blk.statusMs < 1000 && blk.prefMs < 1000 && typeof blk.regAt === 'number' && blk.regAt >= 5500, blk)
  check('评审 P2:用户显式登记(ensureRegistered)解闩 → 重新登记一次', regCount() === regs10c + 1, { regs: regCount() - regs10c })
  await evaluate(`Capacitor.Plugins.Preferences.set({ key: 'forsion_token', value: ${JSON.stringify(TOKEN_A)} }).then(() => 'ok')`)

  // ⑪ S1 扫描:先植入标记,证明扫描器读得到这几处;再扫 hub 签发过的全部 secret / 票
  const MARK_PREF = `k8probe-pref-${crypto.randomBytes(6).toString('hex')}`
  const MARK_LS = `k8probe-ls-${crypto.randomBytes(6).toString('hex')}`
  await evaluate(`Capacitor.Plugins.Preferences.set({ key: 'k8probe', value: ${JSON.stringify(MARK_PREF)} }).then(() => 'ok')`)
  await js(`localStorage.setItem('k8probe', ${JSON.stringify(MARK_LS)}); return 1`)
  // ⚠️ adb shell 把参数用空格拼成一条命令串:引号必须包在同一个参数里,否则 sh -c 只拿到 `cat`、glob 不展开 ——
  //    扫描器读了个空,下面的「一个都没有」就是假绿(本台架第一次跑就是被植入标记这条自检抓出来的)。
  //    Preferences.set 走 SharedPreferences.apply():内存立刻生效、落盘是异步的 —— 紧跟着 cat 可能还读不到标记,等它落盘(封顶 2 秒)。
  let dumpPrefs = ''
  for (let i = 0; i < 10 && !dumpPrefs.includes(MARK_PREF); i++) {
    if (i) await sleep(200)
    dumpPrefs = adb('shell', `run-as ${PKG} sh -c 'cat shared_prefs/*.xml'`)
  }
  const dumpLs = await js('return JSON.stringify(Object.entries(localStorage))')
  const dumpCap = await js('const k = (await Capacitor.Plugins.Preferences.keys()).keys; const o = {}; for (const key of k) o[key] = (await Capacitor.Plugins.Preferences.get({ key })).value; return JSON.stringify(o)')
  const dumpLog = adb('logcat', '-d')
  const scanner = { prefs: dumpPrefs.includes(MARK_PREF), ls: dumpLs.includes(MARK_LS), cap: dumpCap.includes(MARK_PREF), unitFile: /acct\.[0-9a-f]{64}/.test(dumpPrefs) }
  check('S1 仪器自检:植入的标记在 shared_prefs / localStorage / Preferences 里都扫得到,forsion_unit.xml 被读到', Object.values(scanner).every(Boolean), scanner)
  const secrets = [...issued.secrets, ...issued.callerSecrets, ...issued.tokens.keys()]
  const leaks = []
  for (const s of secrets) {
    for (const [where, text] of [['shared_prefs', dumpPrefs], ['localStorage', dumpLs], ['Preferences', dumpCap], ['logcat', dumpLog]]) if (text.includes(s)) leaks.push(`${where}: ${s.slice(0, 12)}…`)
  }
  check(`S1:${secrets.length} 个 secret / 票在 shared_prefs、localStorage、Preferences、logcat 里一个都没有`, secrets.length >= 5 && leaks.length === 0, leaks)
  check('S1:logcat 里没有任何 fuc1. 票形串', !/fuc1\.[A-Za-z0-9_-]{8,}/.test(dumpLog), (dumpLog.match(/.{0,60}fuc1\..{0,20}/) || [])[0])
  await evaluate(`Capacitor.Plugins.Preferences.remove({ key: 'k8probe' }).then(() => 'ok')`)

  // ⑫ 真界面走一遍:UnitsSheet 点「Emu Mac」→ runOn 经原生中继问信任、探引擎(两条都该带票)→ 行变「可用」
  const hitsBefore = proxy.length
  // 入口在顶栏头像的菜单里(2026-10-05;原生外壳下左栏底部那一排已撤,此前一天在「⋯」最前):原生节点得按 uiautomator 的坐标点。
  // 头像只在每个 Space 的第一层页面上:停在主区时先点返回箭头回列表。
  const tapNative = async (id, tries = 20) => {
    const at = new RegExp(`resource-id="${id.replace(/\./g, '\\.')}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`)
    for (let i = 0; i < tries; i++) {
      adb('shell', 'uiautomator', 'dump', '/sdcard/forsion-ui.xml')
      const m = at.exec(adb('shell', 'cat', '/sdcard/forsion-ui.xml'))
      if (m) { adb('shell', 'input', 'tap', String((+m[1] + +m[3]) >> 1), String((+m[2] + +m[4]) >> 1)); return true }
      await sleep(400)
    }
    return false
  }
  const avatar = (await tapNative('nativeChrome.account', 6)) || ((await tapNative('nativeChrome.left', 6)) && (await tapNative('nativeChrome.account')))
  const reached = avatar && (await tapNative('nativeSheet.item.rb-units-mobile'))
  const opened = reached && await js(`
    for (let i = 0; i < 30 && !document.querySelector('[data-run-row="${TARGET}"]'); i++) await new Promise((r) => setTimeout(r, 200))
    const row = document.querySelector('[data-run-row="${TARGET}"]')
    row?.click()
    return !!row`)
  let sub = ''
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    sub = await js(`return document.querySelector('[data-run-row="${TARGET}"]')?.getAttribute('data-status') || ''`)
    if (sub === 'ready') break
  }
  const sheetHits = proxy.slice(hitsBefore)
  const byPath = (p) => sheetHits.filter((x) => x.path === p)
  // 选中电脑后焦点切过去,窗口里还会有后续请求(引擎探活、设备辅助面的 /unit/config …):票只随中继路径走(R-06),
  // 所以判的是「中继路径都带票、设备辅助面都不带」,不是「窗口里每条都带」。
  const relayed = (x) => x.path === '/engine' || x.path.startsWith('/engine/') || x.path.startsWith('/unit/remote-access')
  check('真界面:UnitsSheet 点电脑 → 经中继 GET /unit/remote-access 与 GET /engine/agent/sessions,中继路径都带票、设备辅助面不带 → 行状态 ready',
    opened && sub === 'ready' && byPath('/unit/remote-access').length === 1 && byPath('/engine/agent/sessions').length === 1 && sheetHits.every((x) => relayed(x) === !!x.caller),
    { opened, sub, hits: sheetHits.map((x) => `${x.method} ${x.path}${x.caller ? '' : ' (no ticket)'}`) })
  if (process.env.SHOT_DIR) {
    const shot = path.join(process.env.SHOT_DIR, 'units-runon-emulator.png')
    require('node:fs').writeFileSync(shot, execFileSync(path.join(sdk, 'platform-tools/adb'), [...(SERIAL ? ['-s', SERIAL] : []), 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 }))
    console.log(`screenshot → ${shot}`)
  }
}

;(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
  try {
    adb('logcat', '-c')
    await boot()
    await run()
  } catch (e) {
    check('harness', false, e.message)
  }
  server.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})()
