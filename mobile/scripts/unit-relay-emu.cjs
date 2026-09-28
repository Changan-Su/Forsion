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
 *
 * 覆盖:懒登记带 kind=phone、caller-secret 带 X-Unit-Secret、换票带 X-Unit-Caller-Secret;中继请求带 X-Forsion-Caller 且
 * Authorization 是原生 token 而不是 JS 递的诱饵(S3);非中继请求不带票;SSE 逐块到达;JS abort 后 hub 1s 内见到断开;
 * 403 UNIT_CALLER_INVALID 换票重发一次;PATCH 过得去;换票失败 → 合成 503 CALLER_UNAVAILABLE 且 hub 零匿名请求(S4);
 * 换号重登记、A 的条目仍在(S7);移除本机 → DELETE;shared_prefs / localStorage / Preferences / logcat 里扫不到任何 secret 与票(S1,先植入标记证明扫描器读得到)。
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
const hub = { tokenFail: false, invalidOnceHit: 0 }
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
    if (hub.tokenFail) return send(500, { detail: 'emu: mint down' })
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
    proxy.push({ t: Date.now(), method: req.method, path: sub + url.search, caller: caller || null, auth: req.headers.authorization || null })
    if (caller !== undefined) {
      const tk = issued.tokens.get(caller)
      if (!tk || tk.user !== user) return send(403, { code: 'UNIT_CALLER_INVALID', detail: 'emu: bad ticket' })
    }
    if (sub === '/engine/agent/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...cors })
      res.write('data: one\n\n')
      sse = res
      sseClosedAt = 0
      res.on('close', () => { if (sse === res) { sse = null; sseClosedAt = Date.now() } })
      return
    }
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
  const mint = ledger.filter((l) => /\/caller-token$/.test(l.path))
  check('换票带 X-Unit-Caller-Secret、不带设备密钥', mint.length === 1 && !!mint[0].headers['x-unit-caller-secret'] && !mint[0].headers['x-unit-secret'], mint.map((c) => Object.keys(c.headers)))
  const p1 = proxy.filter((x) => x.path === '/engine/agent/sessions')
  check('中继请求到 hub 带 X-Forsion-Caller(hub 签发过的那张)', r1.status === 200 && p1.length === 1 && issued.tokens.has(p1[0].caller), { r1, p1 })
  check('S3:Authorization 是原生 token,不是 JS 递的诱饵', p1[0]?.auth === `Bearer ${TOKEN_A}`, p1[0]?.auth)

  // ② 非中继:设备辅助面照旧匿名(不带票)
  const before = proxy.length
  await js(`await fetch(${JSON.stringify(`${API}/units/${TARGET}/proxy/unit/hostfile?path=x`)}, { headers: { Authorization: 'Bearer ${TOKEN_A}' } }); return 1`)
  const p2 = proxy.slice(before)
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

  // ⑥ 坏票重发一次(R-04)
  const mintsBefore = ledger.filter((l) => /\/caller-token$/.test(l.path)).length
  const r6 = await js(`const r = await fetch(${JSON.stringify(`${API}/units/${TARGET}/proxy/engine/agent/invalid-once`)}); return r.status`)
  const p6 = proxy.filter((x) => x.path === '/engine/agent/invalid-once')
  const mintsAfter = ledger.filter((l) => /\/caller-token$/.test(l.path)).length
  check('403 UNIT_CALLER_INVALID → 强制换票重发一次,JS 拿到 200', r6 === 200 && p6.length === 2 && p6[0].caller !== p6[1].caller && mintsAfter === mintsBefore + 1, { r6, p6: p6.length, mints: mintsAfter - mintsBefore })

  // ⑦ S4 失败关闭:缓存票被拒 → 强制换票 → 换票 500 → 合成 503 CALLER_UNAVAILABLE,hub 零匿名中继请求
  hub.tokenFail = true
  const anonBefore = proxy.filter((x) => x.caller === null && /^\/(engine|unit\/remote-access)/.test(x.path)).length
  const r7 = await js(`const r = await fetch(${JSON.stringify(`${API}/units/${TARGET}/proxy/engine/agent/always-invalid`)}); return { status: r.status, body: await r.text() }`)
  const anonAfter = proxy.filter((x) => x.caller === null && /^\/(engine|unit\/remote-access)/.test(x.path)).length
  let code7 = null
  try { code7 = JSON.parse(r7.body).code } catch { /* 非 JSON */ }
  check(`S4:换不到票 → 503 CALLER_UNAVAILABLE、hub 收到的匿名中继请求 = 0${NEGCTL === 'failclosed' ? '(NEGCTL:本条应红)' : ''}`, r7.status === 503 && code7 === 'CALLER_UNAVAILABLE' && anonAfter === anonBefore, { r7, anon: anonAfter - anonBefore })
  hub.tokenFail = false
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
  await evaluate(`Capacitor.Plugins.Preferences.set({ key: 'forsion_token', value: ${JSON.stringify(TOKEN_A)} }).then(() => 'ok')`)

  // ⑪ S1 扫描:先植入标记,证明扫描器读得到这几处;再扫 hub 签发过的全部 secret / 票
  const MARK_PREF = `k8probe-pref-${crypto.randomBytes(6).toString('hex')}`
  const MARK_LS = `k8probe-ls-${crypto.randomBytes(6).toString('hex')}`
  await evaluate(`Capacitor.Plugins.Preferences.set({ key: 'k8probe', value: ${JSON.stringify(MARK_PREF)} }).then(() => 'ok')`)
  await js(`localStorage.setItem('k8probe', ${JSON.stringify(MARK_LS)}); return 1`)
  // ⚠️ adb shell 把参数用空格拼成一条命令串:引号必须包在同一个参数里,否则 sh -c 只拿到 `cat`、glob 不展开 ——
  //    扫描器读了个空,下面的「一个都没有」就是假绿(本台架第一次跑就是被植入标记这条自检抓出来的)。
  const dumpPrefs = adb('shell', `run-as ${PKG} sh -c 'cat shared_prefs/*.xml'`)
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
  const opened = await js(`
    document.querySelector('.mb-topbar [aria-label="left panel"]')?.click()
    await new Promise((r) => setTimeout(r, 600))
    const btn = [...document.querySelectorAll('.mb-foot-row .mb-icon-btn')].find((b) => /Forsion Unit/.test(b.getAttribute('aria-label') || ''))
    btn?.click()
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
  check('真界面:UnitsSheet 点电脑 → 经中继 GET /unit/remote-access 与 GET /engine/agent/sessions,两条都带票 → 行状态 ready',
    opened && sub === 'ready' && byPath('/unit/remote-access').length === 1 && byPath('/engine/agent/sessions').length === 1 && sheetHits.every((x) => !!x.caller),
    { opened, sub, sheetHits })
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
