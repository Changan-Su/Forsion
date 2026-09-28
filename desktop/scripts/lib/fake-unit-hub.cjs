/**
 * 假 unit-hub(P1 · K9 仪器包,INTEGRATION §4 G1):远程会话全链路台架(check:remotechain)与流续订台架(check:streamrenew)共用。
 *
 * 照着 server `microserver/unit-hub/{routes/user.ts, services/hub.ts, services/callerToken.ts}`(2.3.24,feat/p1-k3-attention)写:
 *   - 名册:register(kind / registered_name)· GET /units(registeredName / kind / caps / capsLive / online)· caller-secret(X-Unit-Secret)
 *     · caller-token(X-Unit-Caller-Secret)· caps;
 *   - 通道:GET /units/:id/channel(SSE,`: connected` + `event: ready {caps}` + 15s `: hb`)· POST resp/:did(整包)· POST stream/:did(流式 pipe);
 *   - 隧道:ALL /units/:id/proxy/* —— 属主校验 → X-Forsion-Caller 验票(**与 server 同一格式 / 同一派生**:
 *     `fuc1.<b64url(claims)>.<b64url(HMAC-SHA256(HKDF(JWT_SECRET,'forsion/unit-hub','unit-caller-token/v1'), 'fuc1.'+body))>`)
 *     → 查库 → 信封 proxyCaller;头在场却验不过 = 403 且不派发、不降级。
 *   - 断流:真 hub 的两道时限都以 `abortClient → client.destroy()` 收场(Node requestTimeout 1h 掐设备的 POST /stream;
 *     socket.setTimeout 15min 空闲),客户端看到的是**半截断开**,不是干净收尾。这里按 streamCut {totalMs, idleMs} 同样 destroy 两侧,
 *     另给 cutStreams() 手动掐(不依赖引擎心跳节奏)。
 *   - 云端大脑:/api/brain/models、/api/brain/llm/resolve、/api/brain/llm/build-and-stream —— **可编剧的假模型**(同一个进程里就是
 *     「Forsion 云端」),顺带记下每次 LLM 调用的 Authorization 账号与请求体 client(= 生产 api_usage_logs 的「端」列,G7)。
 *   - 其余:/api/auth/me、手机「本端(云端)」引擎 /api/agent/* 转给 homeEngineUrl(可缺省),非 /api 路径按 staticDir 出静态页
 *     (Playwright 以 HTTP 代理方式把 http://phone-hub.test 指到这里 —— 手机页与 API 同源)。CONNECT(https 外站)一律快速 502。
 *
 * 它**不是** server 的替身:没有限流、cookie 直开、PG;只覆盖台架要走的面。与 server 不一致的地方写在对应分支的注释里。
 */
'use strict'
const http = require('node:http')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

// ── 调用方票(与 server services/callerToken.ts 逐字同口径;parity 由 callerTokenParity() 对真模块交叉验证)──────────
const CALLER_TOKEN_TTL_SEC = 600
const SKEW_SEC = 30
const PREFIX = 'fuc1.'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CH_RE = /^[0-9a-f]{16}$/
const KINDS = new Set(['phone', 'desktop'])
const b64url = (b) => Buffer.from(b).toString('base64url')
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')

function callerKey(jwtSecret) {
  if (!jwtSecret) throw new Error('JWT_SECRET 未设置')
  return Buffer.from(crypto.hkdfSync('sha256', jwtSecret, 'forsion/unit-hub', 'unit-caller-token/v1', 32))
}
const mac = (key, body) => crypto.createHmac('sha256', key).update(PREFIX + body).digest()

function mintCallerToken(jwtSecret, c, nowSec = Math.floor(Date.now() / 1000)) {
  if (!KINDS.has(c.kind)) throw new Error(`unknown unit kind: ${c.kind}`)
  const ch = String(c.callerSecretHash || '').slice(0, 16)
  if (!CH_RE.test(ch)) throw new Error('caller secret hash missing')
  const claims = { typ: 'unit-caller', v: 1, uid: c.uid, unit: c.unit, kind: c.kind, ch, iat: nowSec, exp: nowSec + CALLER_TOKEN_TTL_SEC, jti: crypto.randomUUID() }
  const body = b64url(JSON.stringify(claims))
  return { token: `${PREFIX}${body}.${b64url(mac(callerKey(jwtSecret), body))}`, expiresAt: claims.exp }
}

function verifyCallerToken(jwtSecret, token, nowSec = Math.floor(Date.now() / 1000)) {
  const bad = { ok: false, code: 'UNIT_CALLER_INVALID' }
  if (typeof token !== 'string' || token.length > 2048 || !token.startsWith(PREFIX)) return bad
  const parts = token.slice(PREFIX.length).split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return bad
  const [body, sig] = parts
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(sig)) return bad
  const given = Buffer.from(sig, 'base64url')
  const want = mac(callerKey(jwtSecret), body)
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return bad
  let c
  try { c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return bad }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return bad
  if (c.typ !== 'unit-caller' || c.v !== 1) return bad
  if (typeof c.uid !== 'string' || !c.uid || c.uid.length > 64) return bad
  if (typeof c.unit !== 'string' || !UUID_RE.test(c.unit)) return bad
  if (typeof c.kind !== 'string' || !KINDS.has(c.kind)) return bad
  if (typeof c.ch !== 'string' || !CH_RE.test(c.ch)) return bad
  if (typeof c.jti !== 'string' || c.jti.length > 64) return bad
  if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp)) return bad
  if (c.exp - c.iat > CALLER_TOKEN_TTL_SEC || c.exp <= c.iat) return bad
  if (c.iat > nowSec + SKEW_SEC) return bad
  if (nowSec > c.exp + SKEW_SEC) return { ok: false, code: 'UNIT_CALLER_EXPIRED' }
  return { ok: true, claims: { typ: 'unit-caller', v: 1, uid: c.uid, unit: c.unit, kind: c.kind, ch: c.ch, iat: c.iat, exp: c.exp, jti: c.jti } }
}

/**
 * 与 server 的真模块交叉验证(同一个 JWT_SECRET):server 铸的票本 hub 验得过、本 hub 铸的票 server 验得过,坏签名两边都拒。
 * serverDir = server 仓(或 worktree)根;缺席 → { skipped }。esbuild 打包 services/callerToken.ts(只依赖 node:crypto)。
 */
function callerTokenParity(serverDir) {
  const file = serverDir && path.join(serverDir, 'microserver/unit-hub/services/callerToken.ts')
  if (!file || !fs.existsSync(file)) return { skipped: `找不到 ${file || '(未指定 server 目录)'}` }
  const { buildSync } = require('esbuild')
  const src = buildSync({ entryPoints: [file], bundle: true, write: false, logLevel: 'silent', platform: 'node', format: 'cjs' }).outputFiles[0].text
  const mod = { exports: {} }
  const prev = process.env.JWT_SECRET
  const secret = `k9-parity-${crypto.randomBytes(8).toString('hex')}`
  process.env.JWT_SECRET = secret
  try {
    new Function('module', 'exports', 'require', src)(mod, mod.exports, require)
    const server = mod.exports
    const c = { uid: 'u-parity', unit: crypto.randomUUID(), kind: 'phone', callerSecretHash: sha256('cs') }
    const fromServer = server.mintCallerToken(c).token
    const fromFake = mintCallerToken(secret, c).token
    const a = verifyCallerToken(secret, fromServer)
    const b = server.verifyCallerToken(fromFake)
    const tampered = fromFake.slice(0, -2) + (fromFake.endsWith('A') ? 'BB' : 'AA')
    const c1 = verifyCallerToken(secret, tampered).ok === false && server.verifyCallerToken(tampered).ok === false
    const otherKey = mintCallerToken(`${secret}-other`, c).token
    const c2 = server.verifyCallerToken(otherKey).ok === false
    const same = (x) => JSON.stringify({ ...x, jti: 0, iat: 0, exp: 0 })
    const ok = a.ok && b.ok && c1 && c2 && same(a.claims) === same(b.claims)
    return { ok, detail: `server→fake ${a.ok ? 'ok' : a.code};fake→server ${b.ok ? 'ok' : b.code};篡改两边拒 ${c1};换钥 server 拒 ${c2}` }
  } finally {
    if (prev === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = prev
  }
}

// ── 账号 token(形同 JWT 的 alg:none 串;hub 只解 userId 作识别,同 engine-target / unit-relay-emu 台架)──────────────
const accountToken = (userId) => `${b64url('{"alg":"none","typ":"JWT"}')}.${b64url(JSON.stringify({ userId, username: userId }))}.k9sig`
function userOf(auth) {
  const m = /^Bearer (.+)$/.exec(String(auth || ''))
  if (!m) return null
  try { return JSON.parse(Buffer.from(m[1].split('.')[1], 'base64url').toString()).userId || null } catch { return null }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.map': 'application/json', '.txt': 'text/plain' }

/**
 * @param {object} o
 * @param {string} o.jwtSecret
 * @param {string} [o.staticDir]         非 /api 路径的静态根(SPA 回落 index.html)
 * @param {string} [o.homeEngineUrl]     手机「本端(云端)」引擎:/api/agent/* 与 /api/health 转过去;缺省回空列表
 * @param {(call: object) => Array<object>} [o.llm]  可编剧模型:给一次 build-and-stream 的请求体,回 SSE 帧数组(见 brainFrames)
 * @param {{ totalMs?: number, idleMs?: number }} [o.streamCut]  流式回包的总时长 / 空闲上限(缺省 1h / 15min,同生产)
 * @param {{ omitProxyCaller?: boolean, dropReplayFrame?: number, rewriteFromSeq0?: boolean | number, noRegisteredSnapshot?: boolean }} [o.negctl]  负对照开关:
 *        omitProxyCaller = 信封不写 proxyCaller(断 hub → 设备那一跳);dropReplayFrame = N → 第 N 次带 fromSeq>0 的事件流续订丢掉头一帧(丢事件);
 *        rewriteFromSeq0 = 续订时把 fromSeq 改回 0(引擎从头回放,客户端会收到重复事件):true = 每次续订;数字 N = 只改第 N 次续订
 *        (fromSeq>0 的事件流)。改过的那条流里 seq ≤ 客户端 fromSeq 的帧(= 重复事件)记进 ledger.replayDups —— 客户端按 seq 去重(M1B)后
 *        这是正向场景,不再是负对照;

 *        noRegisteredSnapshot = 不留登记名快照(名册的 registeredName 与信封 proxyCaller.name 都取**当前**名 —— R-25 失守的样子)
 * @param {(row: object) => void} [o.onRegister]  POST /units/register 建完行之后调(台架在这里模拟「用户随后在名册里改了名」)
 */
async function startFakeUnitHub(o) {
  const jwtSecret = o.jwtSecret
  const units = new Map() // id → row
  const channels = new Map() // unitId → res
  const pending = new Map() // did → { unitId, res, path, timer, at }
  const streams = new Set() // 在途流式回包 { did, path, client, up, startedAt, cut(reason) }
  const ledger = { proxy: [], brain: [], cuts: [], requests: [], memoryWrites: [], unknown: [], attention: [], unitLists: [], replayDups: [] }
  const cfg = {
    streamCut: { totalMs: 60 * 60_000, idleMs: 15 * 60_000, ...(o.streamCut || {}) },
    negctl: { ...(o.negctl || {}) },
    llm: o.llm || null,
    /** 名册里额外的行(台架可以塞「不属于本账号」的设备做反例) */
    extraUnits: [],
    /** GET /units 里这些行不带 kind(server 2.3.23 之前的名册形状;K8 的 isRunnableUnit 对缺席 kind 按 desktop) */
    listOmitKindFor: new Set(),
  }

  const json = (res, code, body, extra = {}) => {
    if (res.headersSent) { try { res.end() } catch { /* 已断 */ } return }
    res.writeHead(code, { 'Content-Type': 'application/json', ...extra })
    res.end(JSON.stringify(body))
  }
  const readRaw = (req) => new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(Buffer.concat(chunks)))
  })
  const readJson = async (req) => { const raw = await readRaw(req); try { return JSON.parse(raw.toString('utf8') || '{}') } catch { return null } }

  function ownUnit(req, res, id, user) {
    const u = units.get(id)
    if (!u || u.user !== user) { json(res, 404, { detail: '设备不存在', code: 'UNIT_NOT_FOUND' }); return null }
    return u
  }
  function ownUnitWithSecret(req, res, id, user) {
    const u = ownUnit(req, res, id, user)
    if (!u) return null
    const secret = String(req.headers['x-unit-secret'] || '')
    if (!secret || sha256(secret) !== u.secretHash) { json(res, 403, { detail: 'unit secret 不匹配', code: 'UNIT_SECRET_MISMATCH' }); return null }
    return u
  }

  function failPending(unitId) {
    for (const [id, p] of pending) {
      if (p.unitId !== unitId) continue
      pending.delete(id)
      clearTimeout(p.timer)
      if (!p.res.headersSent) json(p.res, 502, { detail: '设备连接中断', code: 'UNIT_DISCONNECTED' })
      else try { p.res.end() } catch { /* 已断 */ }
    }
  }

  function dispatch(unitId, env, clientRes, timeoutMs = 30_000, meta = {}) {
    const ch = channels.get(unitId)
    if (!ch) return false
    const id = crypto.randomUUID()
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return
      if (!clientRes.headersSent) json(clientRes, 504, { detail: '设备超时未响应', code: 'UNIT_TIMEOUT' })
      else try { clientRes.end() } catch { /* 已断 */ }
    }, timeoutMs)
    pending.set(id, { unitId, res: clientRes, timer, path: env.path, at: Date.now(), meta })
    clientRes.on('close', () => { const p = pending.get(id); if (p && p.res === clientRes) { pending.delete(id); clearTimeout(p.timer) } })
    try { ch.write(`event: dispatch\ndata: ${JSON.stringify({ ...env, id })}\n\n`) } catch { pending.delete(id); clearTimeout(timer); return false }
    return true
  }
  const take = (did, unitId) => {
    const p = pending.get(did)
    if (!p || p.unitId !== unitId) return null
    pending.delete(did)
    clearTimeout(p.timer)
    return p
  }

  function resolveProxyCaller(req, res, user) {
    const raw = req.headers['x-forsion-caller']
    if (raw === undefined) return { caller: null }
    const reject = (code) => { json(res, 403, { detail: code === 'UNIT_CALLER_EXPIRED' ? '调用方票已过期' : '调用方票无效', code }); return { rejected: code } }
    if (typeof raw !== 'string') return reject('UNIT_CALLER_INVALID')
    const v = verifyCallerToken(jwtSecret, raw)
    if (!v.ok) return reject(v.code)
    const c = units.get(v.claims.unit)
    if (!c || c.user !== v.claims.uid || v.claims.uid !== user || !c.callerHash || !c.callerHash.startsWith(v.claims.ch) || !KINDS.has(c.kind)) return reject('UNIT_CALLER_INVALID')
    // server hub.ts:信封里的名字 = registered_name ?? name(R-25:登记时的快照,名册里改名不改它)
    const shownName = cfg.negctl.noRegisteredSnapshot ? c.name : (c.registeredName ?? c.name)
    return {
      caller: { unit: c.id, kind: c.kind, name: String(shownName ?? '').slice(0, 120), platform: c.platform ? String(c.platform).slice(0, 40) : null, registeredAt: new Date(c.createdAt).toISOString() },
      claims: v.claims,
    }
  }

  // ── 云端大脑(假模型)──
  function brainFrames(call) {
    if (!cfg.llm) return [{ t: 'token', d: 'ok' }, { t: 'done', content: 'ok', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }]
    return cfg.llm(call) || []
  }
  async function brain(req, res, p, user) {
    if (p === '/api/brain/models') {
      return json(res, 200, { models: [{ id: 'k9-model', name: 'K9 Scripted', provider: 'forsion', contextWindow: 128_000 }], defaultModelId: 'k9-model', backgroundModelId: 'k9-model' })
    }
    if (p === '/api/brain/users/me') return json(res, 200, { id: user, username: user })
    if (p === '/api/brain/llm/resolve') {
      const b = await readJson(req)
      return json(res, 200, { model: { id: b?.modelId || 'k9-model', name: 'K9 Scripted', provider: 'forsion', apiModelId: 'k9-model' }, apiModelId: 'k9-model' })
    }
    if (p === '/api/brain/llm/build-and-stream') {
      const b = (await readJson(req)) || {}
      const call = { at: Date.now(), user, auth: String(req.headers.authorization || ''), client: b.client ?? null, projectSource: b.projectSource ?? b.usageSource ?? null, cacheKey: b.cacheKey ?? null, modelId: b.modelId, messages: b.messages || [], tools: (b.tools || []).map((t) => t?.function?.name || t?.name), body: b }
      ledger.brain.push(call)
      const frames = brainFrames(call)
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      for (const f of frames) {
        if (f.delay) await new Promise((r) => setTimeout(r, f.delay))
        if (res.destroyed) return
        const { delay: _d, ...frame } = f
        res.write(`data: ${JSON.stringify(frame)}\n\n`)
      }
      res.end()
      return
    }
    if (p === '/api/brain/memory' || p === '/api/brain/log') {
      // G7:standalone 的记忆是本机优先(localMemoryBrain);远程 run 任何写进云端记忆的请求都要记下来断言为零
      if (req.method !== 'GET') ledger.memoryWrites.push({ at: Date.now(), path: p, method: req.method, user, body: (await readRaw(req)).toString('utf8').slice(0, 500) })
      return json(res, 404, { detail: 'k9 hub: memory lives on the device' })
    }
    ledger.unknown.push({ method: req.method, path: p })
    return json(res, 404, { detail: `k9 hub: ${p} not implemented` })
  }

  // ── 手机本端(云端)引擎 ──
  function forwardHome(req, res, sub) {
    if (!o.homeEngineUrl) {
      if (sub.startsWith('/agent/sessions') && req.method === 'GET') return json(res, 200, { sessions: [] })
      if (sub === '/health') return json(res, 200, { ok: true })
      return json(res, 404, { detail: 'k9 hub: no home engine' })
    }
    const target = new URL(sub, o.homeEngineUrl)
    const up = http.request(target, { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json', accept: req.headers.accept || '*/*', authorization: 'Bearer home' } }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers)
      r.pipe(res)
    })
    up.on('error', () => json(res, 502, { detail: 'home engine down' }))
    req.pipe(up)
  }

  function serveStatic(res, pathname) {
    if (!o.staticDir) return json(res, 404, { detail: 'no static' })
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '')
    let file = path.join(o.staticDir, rel)
    if (!file.startsWith(o.staticDir) || !rel || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(o.staticDir, 'index.html')
    const ext = path.extname(file).toLowerCase()
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    fs.createReadStream(file).pipe(res)
  }

  const server = http.createServer(async (req, res) => {
    // 以 HTTP 代理身份收到的是绝对形式的请求行(http://phone-hub.test/...),直连则是相对路径 —— 两种都认。
    let u
    try { u = new URL(req.url, `http://${req.headers.host || 'hub'}`) } catch { return json(res, 400, { detail: 'bad url' }) }
    if (/^https?:\/\//i.test(req.url) && u.hostname !== 'phone-hub.test') { res.writeHead(502); return res.end() } // 代理模式下的外站:快速失败
    const p = u.pathname
    const user = userOf(req.headers.authorization)
    ledger.requests.push({ at: Date.now(), method: req.method, path: p, host: u.host })
    try {
      if (!p.startsWith('/api/')) return serveStatic(res, p)
      if (p === '/api/auth/me') return user ? json(res, 200, { id: user, userId: user, username: user, nickname: user }) : json(res, 401, { detail: 'Invalid or expired token' })
      if (p.startsWith('/api/auth/')) return json(res, 404, { detail: 'k9 hub: auth route not implemented' })
      if (p === '/api/health') return json(res, 200, { ok: true })
      if (p.startsWith('/api/brain/')) {
        if (!user) return json(res, 401, { detail: 'no token' })
        return brain(req, res, p, user)
      }
      if (p === '/api/brain' || p.startsWith('/api/agent/')) return forwardHome(req, res, p.slice('/api'.length) + u.search)
      if (p.startsWith('/api/token-quota') || p.startsWith('/api/website') || p.startsWith('/api/brain/inbox')) return json(res, 404, { detail: 'n/a' })
      if (!p.startsWith('/api/units')) { ledger.unknown.push({ method: req.method, path: p }); return json(res, 404, { detail: 'k9 hub: not implemented' }) }
      if (!user) return json(res, 401, { detail: 'Invalid or expired token' })

      // ── 名册面 ──
      if (p === '/api/units/register' && req.method === 'POST') {
        const b = (await readJson(req)) || {}
        const given = String(b.name || '').trim().slice(0, 120)
        const name = given || '未命名设备'
        const kind = b.kind == null || b.kind === '' ? 'desktop' : b.kind
        if (!KINDS.has(kind)) return json(res, 400, { code: 'UNIT_KIND_INVALID' })
        const id = crypto.randomUUID()
        const secret = crypto.randomBytes(32).toString('hex')
        const row = { id, user, name, registeredName: name, platform: String(b.platform || '').slice(0, 40) || null, kind, secretHash: sha256(secret), callerHash: null, createdAt: Date.now(), caps: null, capsAt: null, alias: null }
        units.set(id, row)
        if (o.onRegister) o.onRegister(row)
        return json(res, 200, { unitId: id, secret })
      }
      if (p === '/api/units' && req.method === 'GET') {
        const rows = [...units.values(), ...cfg.extraUnits].filter((r) => r.user === user)
        const out = rows.map((r) => {
          const row = {
            id: r.id, name: r.name, platform: r.platform, icon: null, online: channels.has(r.id), createdAt: new Date(r.createdAt).toISOString(), lastSeenAt: null, lanUrl: null,
            kind: r.kind || 'desktop', registeredName: cfg.negctl.noRegisteredSnapshot ? r.name : (r.registeredName ?? r.name), alias: r.alias ?? null, caps: r.caps ?? null, capsAt: r.capsAt ?? null, capsLive: !!(r.caps && channels.has(r.id)),
          }
          if (cfg.listOmitKindFor.has(r.id)) delete row.kind
          return row
        })
        ledger.unitLists.push({ at: Date.now(), rows: out.map((r) => ({ id: r.id, kind: r.kind ?? null })) })
        return json(res, 200, { units: out })
      }
      let m
      if ((m = /^\/api\/units\/([^/]+)\/caller-secret$/.exec(p)) && req.method === 'POST') {
        const u2 = ownUnitWithSecret(req, res, m[1], user); if (!u2) return
        const cs = crypto.randomBytes(32).toString('hex')
        u2.callerHash = sha256(cs)
        return json(res, 200, { unitId: u2.id, callerSecret: cs })
      }
      if ((m = /^\/api\/units\/([^/]+)\/caller-token$/.exec(p)) && req.method === 'POST') {
        const u2 = ownUnit(req, res, m[1], user); if (!u2) return
        const given = String(req.headers['x-unit-caller-secret'] || '')
        if (!given || !u2.callerHash || sha256(given) !== u2.callerHash) return json(res, 403, { detail: '调用方凭据不匹配', code: 'UNIT_CALLER_SECRET_MISMATCH' })
        const { token, expiresAt } = mintCallerToken(jwtSecret, { uid: user, unit: u2.id, kind: u2.kind, callerSecretHash: u2.callerHash })
        return json(res, 200, { unitId: u2.id, token, expiresAt })
      }
      if ((m = /^\/api\/units\/([^/]+)\/caps$/.exec(p)) && req.method === 'POST') {
        const u2 = ownUnitWithSecret(req, res, m[1], user); if (!u2) return
        const b = (await readJson(req)) || {}
        u2.caps = { engine: b.engine ?? null, tools: Array.isArray(b.tools) ? b.tools : [] }
        u2.capsAt = new Date().toISOString()
        return json(res, 200, { ok: true, caps: u2.caps, capsAt: u2.capsAt, capsLive: channels.has(u2.id) })
      }
      // 待批提醒(K3,server routes/user.ts 末段):双闸 + 仅 desktop;这里只记账(原样请求体键),不投收件箱
      if ((m = /^\/api\/units\/([^/]+)\/attention$/.exec(p)) && req.method === 'POST') {
        const u2 = ownUnitWithSecret(req, res, m[1], user); if (!u2) return
        if ((u2.kind || 'desktop') !== 'desktop') return json(res, 403, { code: 'UNIT_KIND_NOT_ALLOWED' })
        const raw = (await readRaw(req)).toString('utf8')
        let b = null
        try { b = JSON.parse(raw) } catch { /* 记坏体 */ }
        ledger.attention.push({ at: Date.now(), unit: u2.id, raw, body: b })
        return json(res, 200, { ok: true })
      }
      if ((m = /^\/api\/units\/([^/]+)$/.exec(p)) && req.method === 'DELETE') {
        const u2 = ownUnit(req, res, m[1], user); if (!u2) return
        units.delete(u2.id)
        const ch = channels.get(u2.id); if (ch) { channels.delete(u2.id); try { ch.end() } catch { /* 已断 */ } }
        failPending(u2.id)
        return json(res, 200, { ok: true })
      }

      // ── 通道面 ──
      if ((m = /^\/api\/units\/([^/]+)\/channel$/.exec(p)) && req.method === 'GET') {
        const u2 = ownUnitWithSecret(req, res, m[1], user); if (!u2) return
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' })
        res.write(': connected\n\n')
        res.write(`event: ready\ndata: ${JSON.stringify({ caps: ['stream-sec-headers'] })}\n\n`)
        const old = channels.get(u2.id); if (old && old !== res) try { old.end() } catch { /* 已断 */ }
        channels.set(u2.id, res)
        const hb = setInterval(() => { try { res.write(': hb\n\n') } catch { /* close 收尾 */ } }, 15_000)
        req.on('close', () => { clearInterval(hb); if (channels.get(u2.id) === res) { channels.delete(u2.id); failPending(u2.id) } })
        return
      }
      if ((m = /^\/api\/units\/([^/]+)\/resp\/([^/]+)$/.exec(p)) && req.method === 'POST') {
        const u2 = ownUnitWithSecret(req, res, m[1], user); if (!u2) return
        const b = (await readJson(req)) || {}
        const got = take(m[2], u2.id)
        if (!got) return json(res, 404, { code: 'DISPATCH_GONE' })
        const client = got.res
        client.statusCode = Number(b.status) || 200
        if (b.headers?.['content-type']) client.setHeader('Content-Type', String(b.headers['content-type']))
        for (const k of ['content-security-policy', 'x-content-type-options']) if (b.headers?.[k]) client.setHeader(k, String(b.headers[k]))
        if (b.bodyB64) client.end(Buffer.from(String(b.bodyB64), 'base64'))
        else client.end()
        return json(res, 200, { ok: true })
      }
      if ((m = /^\/api\/units\/([^/]+)\/stream\/([^/]+)$/.exec(p)) && req.method === 'POST') {
        const u2 = ownUnitWithSecret(req, res, m[1], user); if (!u2) return
        const got = take(m[2], u2.id)
        if (!got) { json(res, 404, { code: 'DISPATCH_GONE' }); req.destroy(); return }
        const client = got.res
        client.statusCode = Number(u.searchParams.get('status')) || 200
        client.setHeader('Content-Type', String(u.searchParams.get('ct') || 'application/octet-stream'))
        client.setHeader('Cache-Control', 'no-cache, no-transform')
        if (u.searchParams.get('csp')) client.setHeader('Content-Security-Policy', String(u.searchParams.get('csp')))
        if (u.searchParams.get('xcto')) client.setHeader('X-Content-Type-Options', String(u.searchParams.get('xcto')))
        client.flushHeaders()
        const entry = { did: m[2], path: got.path, startedAt: Date.now(), bytes: 0, cut: null }
        // 负对照:第 N 次续订(fromSeq>0 的事件流)丢掉回放的头一帧
        let dropFrame = false
        if (cfg.negctl.dropReplayFrame && /\/events\?(?:.*&)?fromSeq=[1-9]/.test(got.path || '')) {
          cfg.replays = (cfg.replays || 0) + 1
          dropFrame = cfg.replays === cfg.negctl.dropReplayFrame
        }
        let pend = ''
        // rewriteFromSeq0 改过的续订:数一数送给客户端的重复帧(seq ≤ 客户端 fromSeq),证明「重复事件确实到了客户端」
        const replayFrom = got.meta?.replayFrom || 0
        const dupRec = replayFrom ? { did: entry.did, clientFromSeq: replayFrom, dupFrames: 0 } : null
        if (dupRec) ledger.replayDups.push(dupRec)
        let scan = ''
        // 真 hub:Node requestTimeout(1h)/ socket 空闲(15min)→ 设备上行 aborted → abortClient → client.destroy()(半截断开)
        const cut = (reason) => {
          if (entry.cut) return
          entry.cut = reason
          ledger.cuts.push({ at: Date.now(), reason, did: entry.did, path: entry.path, bytes: entry.bytes, afterMs: Date.now() - entry.startedAt })
          try { client.destroy() } catch { /* 已断 */ }
          try { req.destroy() } catch { /* 已断 */ }
        }
        entry.cutNow = cut
        streams.add(entry)
        const total = setTimeout(() => cut('total'), cfg.streamCut.totalMs)
        let idle = setTimeout(() => cut('idle'), cfg.streamCut.idleMs)
        req.on('data', (c) => {
          entry.bytes += c.length
          clearTimeout(idle)
          idle = setTimeout(() => cut('idle'), cfg.streamCut.idleMs)
          if (client.destroyed) return
          if (dupRec) {
            scan += c.toString('utf8')
            let j
            while ((j = scan.indexOf('\n\n')) >= 0) {
              const fr = scan.slice(0, j)
              scan = scan.slice(j + 2)
              const d = /^data: ?(.*)$/m.exec(fr)
              if (!d) continue
              try { if (Number(JSON.parse(d[1]).seq) <= replayFrom) dupRec.dupFrames++ } catch { /* 非 JSON 帧 */ }
            }
          }
          if (!dropFrame) { client.write(c); return }
          pend += c.toString('utf8')
          let i
          while (dropFrame && (i = pend.indexOf('\n\n')) >= 0) {
            const frame = pend.slice(0, i + 2)
            pend = pend.slice(i + 2)
            if (/^data:/m.test(frame)) { dropFrame = false; ledger.cuts.push({ at: Date.now(), reason: 'negctl-drop', did: entry.did, path: entry.path, frame: frame.slice(0, 120) }); continue }
            client.write(frame)
          }
          if (!dropFrame && pend) { client.write(pend); pend = '' }
        })
        const done = () => { clearTimeout(total); clearTimeout(idle); streams.delete(entry) }
        req.on('end', () => { done(); if (!entry.cut) { try { client.end() } catch { /* 已断 */ } } if (!res.headersSent) json(res, 200, { ok: true }) })
        req.on('aborted', () => { done(); try { client.destroy() } catch { /* 已断 */ } })
        req.on('close', done)
        client.on('close', () => { done(); try { req.destroy() } catch { /* 已断 */ } })
        return
      }

      // ── 隧道面 ──
      if ((m = /^\/api\/units\/([^/]+)\/proxy(\/.*)$/.exec(p))) {
        const target = ownUnit(req, res, m[1], user); if (!target) return
        const rc = resolveProxyCaller(req, res, user)
        const entry = { at: Date.now(), method: req.method, path: m[2] + u.search, unit: target.id, callerHeader: req.headers['x-forsion-caller'] ?? null, callerUnit: rc.caller?.unit ?? null, rejected: rc.rejected || null, auth: userOf(req.headers.authorization) }
        ledger.proxy.push(entry)
        if (rc.rejected) return
        const bodyless = req.method === 'GET' || req.method === 'HEAD'
        let bodyStr = null
        if (!bodyless) {
          const raw = await readRaw(req)
          const isJson = String(req.headers['content-type'] || '').includes('application/json')
          // 真 hub:全局 express.json() 解析后 JSON.stringify(req.body ?? {}) —— 非 JSON 体进不来(→ '{}')
          try { bodyStr = JSON.stringify(isJson && raw.length ? JSON.parse(raw.toString('utf8')) : {}) } catch { return json(res, 400, { detail: 'bad json' }) }
          if (bodyStr.length > 10 * 1024 * 1024) return json(res, 413, { code: 'UNIT_BODY_TOO_LARGE' })
        }
        const withCaller = rc.caller && !cfg.negctl.omitProxyCaller
        let envPath = m[2] + u.search
        let replayFrom = 0
        const rw = cfg.negctl.rewriteFromSeq0
        const renew = /\/events\?(?:.*&)?fromSeq=([1-9]\d*)/.exec(envPath)
        if (rw && renew) {
          cfg.renewals = (cfg.renewals || 0) + 1
          if (rw === true || cfg.renewals === rw) { replayFrom = Number(renew[1]); envPath = envPath.replace(/([?&]fromSeq=)\d+/, '$10') }
        }
        const ok = dispatch(target.id, {
          method: req.method, path: envPath,
          ct: bodyless ? undefined : String(req.headers['content-type'] || 'application/json'),
          accept: req.headers.accept ? String(req.headers.accept) : undefined,
          body: bodyStr,
          ...(withCaller ? { proxyCaller: rc.caller } : {}),
        }, res, undefined, replayFrom ? { replayFrom } : {})
        entry.dispatched = ok
        if (!ok) json(res, 503, { detail: '设备不在线', code: 'UNIT_OFFLINE' })
        return
      }
      ledger.unknown.push({ method: req.method, path: p })
      return json(res, 404, { detail: 'k9 hub: not implemented' })
    } catch (e) {
      json(res, 500, { detail: `k9 hub: ${e?.message || e}` })
    }
  })
  // 代理模式下浏览器对 https 外站(mobileShim 的 GitHub 版本检查等)发 CONNECT:快速失败,别让 6s 超时叠起来
  server.on('connect', (_req, socket) => { socket.on('error', () => {}); try { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') } catch { /* 已断 */ } })
  server.on('clientError', (_e, socket) => { try { socket.destroy() } catch { /* 已断 */ } })
  server.keepAliveTimeout = 5_000
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    units, channels, ledger, cfg, streams,
    online: (id) => channels.has(id),
    /** 手动掐掉在途的流式回包(filter(entry) 为真者);返回掐掉的条数。 */
    cutStreams(filter = () => true, reason = 'manual') {
      let n = 0
      for (const s of [...streams]) if (!s.cut && filter(s)) { s.cutNow(reason); n++ }
      return n
    },
    close() {
      for (const [, ch] of channels) try { ch.end() } catch { /* 已断 */ }
      for (const s of streams) try { s.cutNow('close') } catch { /* 已断 */ }
      server.closeAllConnections?.()
      server.close()
    },
  }
}

module.exports = { startFakeUnitHub, mintCallerToken, verifyCallerToken, callerKey, callerTokenParity, accountToken, userOf, CALLER_TOKEN_TTL_SEC }
