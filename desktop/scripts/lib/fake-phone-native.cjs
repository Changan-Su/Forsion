/**
 * 手机原生层的 Node 替身(P1 · K9):模拟安卓 App 里的 `ForsionUnit` 插件 —— UnitPlugin.java / UnitRegistrar.java /
 * CallerTokens.java / UnitRelay.java 这一层(mobile/android/app/src/main/java/com/forsion/tangu/)。
 *
 * 浏览器里跑不了真原生,所以远程会话全链路台架(check:remotechain)在「手机形态页」这条路上**只替换这一层**:
 *   页面(真 mobile 构建,真 mobileShim / unitBridge / unitRelay / relayPaths / K6 targets / 渲染层)
 *     → window.Capacitor.nativeCallback / nativePromise(Capacitor 自定义平台钩子,台架注入)
 *     → Playwright exposeBinding → **本文件**(登记 / 换票 / 中继注头 / 流式回传,契约照原生)
 *     → 假 hub(真实 caller token 格式)→ 真 unitHost → 真 unitWeb → 真 standalone 引擎。
 * 凭据(设备密钥、caller secret、caller token、forsion_token)只活在本进程,和真 App 一样永不进页面 JS。
 *
 * 契约照抄原生(改原生时同步改这里):
 *   - 登记:先探 POST /units/00000000-…/caller-token(新 server 回 404 带 code;无 code = 老 server → caller_unsupported),
 *     再 POST /units/register {name, platform:'android', kind:'phone'} → POST /units/:id/caller-secret(X-Unit-Secret);
 *   - 换票:POST /units/:id/caller-token(X-Unit-Caller-Secret),缓存键 `*`,到期前 60s 刷新(R-02);
 *   - 中继:目的地只由这里拼 `${apiBase}/units/<id>/proxy<path>`,path 先过 mobile/src/relayPaths.ts 的 checkRelayPath(原生
 *     RelayPaths.check 的同一套规则);头从零重建 = Authorization(原生 token)+ X-Forsion-Caller + JS 的 content-type / accept;
 *     403 UNIT_CALLER_INVALID / EXPIRED 且还没交 head → 强制换票重发一次(R-04);换不到票不发匿名请求(S4)。
 *
 * 负对照开关 negctl.dropCallerHeader:中继照发但不带 X-Forsion-Caller —— 即「中继漏拦 / 头路径断了」,静默降级成账号级调用方。
 */
'use strict'
const path = require('node:path')
const { buildSync } = require('esbuild')

const PROBE_UNIT = '00000000-0000-0000-0000-000000000000'

function loadRelayPaths() {
  const src = buildSync({
    entryPoints: [path.resolve(__dirname, '../../../mobile/src/relayPaths.ts')],
    bundle: true, write: false, logLevel: 'silent', platform: 'node', format: 'cjs',
  }).outputFiles[0].text
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', src)(mod, mod.exports, require)
  return mod.exports
}

/**
 * @param {object} o
 * @param {string} o.apiBase         构建期烤进 APK 的 apiBase(台架从 dist/forsion-native.json 读,与 JS 的 cloudApiBase 逐字比)
 * @param {() => string|null} o.token 原生侧 forsion_token(每次现读)
 * @param {string} [o.deviceName]
 * @param {{ dropCallerHeader?: boolean }} [o.negctl]
 * @param {(m: string) => void} [o.log]
 */
function createFakePhoneNative(o) {
  const { checkRelayPath } = loadRelayPaths()
  const negctl = { ...(o.negctl || {}) }
  const log = o.log || (() => {})
  let identity = null // { unitId, secret, callerSecret, name }
  let forgotten = false
  let ticket = null // { token, refreshAt }
  const active = new Map() // id → AbortController
  const stats = { registers: 0, callerSecrets: 0, mints: 0, relayed: 0, retriedBadTicket: 0, failClosed: 0 }

  const auth = () => { const t = o.token(); return t ? { Authorization: `Bearer ${t}` } : null }
  const codeOf = async (r) => { try { return (await r.clone().json())?.code ?? null } catch { return null } }

  async function register() {
    const a = auth()
    if (!a) throw Object.assign(new Error('not signed in'), { code: 'caller_unavailable' })
    const probe = await fetch(`${o.apiBase}/units/${PROBE_UNIT}/caller-token`, { method: 'POST', headers: a })
    if (probe.status === 404 && !(await codeOf(probe))) throw Object.assign(new Error('server has no caller-token route'), { code: 'caller_unsupported' })
    const r = await fetch(`${o.apiBase}/units/register`, { method: 'POST', headers: { ...a, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: o.deviceName || 'Android', platform: 'android', kind: 'phone' }) })
    if (r.status === 401) throw Object.assign(new Error('auth expired'), { code: 'auth_expired' })
    if (r.status !== 200) throw Object.assign(new Error(`register ${r.status}`), { code: r.status >= 500 ? 'network' : 'caller_unavailable' })
    const j = await r.json()
    stats.registers++
    const r2 = await fetch(`${o.apiBase}/units/${j.unitId}/caller-secret`, { method: 'POST', headers: { ...a, 'X-Unit-Secret': j.secret } })
    if (r2.status !== 200) throw Object.assign(new Error(`caller-secret ${r2.status}`), { code: 'caller_unavailable' })
    const j2 = await r2.json()
    stats.callerSecrets++
    identity = { unitId: j.unitId, secret: j.secret, callerSecret: j2.callerSecret, name: o.deviceName || 'Android' }
    forgotten = false
    ticket = null
    log(`[fake-native] 已登记为 ${identity.unitId}`)
    return identity
  }

  async function ensure(lazy) {
    if (identity) return identity
    if (lazy && forgotten) throw Object.assign(new Error('this phone was removed'), { code: 'caller_unavailable' })
    return register()
  }

  async function getTicket(force) {
    const id = await ensure(true)
    if (!force && ticket && Date.now() < ticket.refreshAt) return ticket.token
    ticket = null
    const a = auth()
    if (!a) throw Object.assign(new Error('not signed in'), { code: 'caller_unavailable' })
    const r = await fetch(`${o.apiBase}/units/${id.unitId}/caller-token`, { method: 'POST', headers: { ...a, 'X-Unit-Caller-Secret': id.callerSecret } })
    if (r.status === 401) throw Object.assign(new Error('auth expired'), { code: 'auth_expired' })
    if (r.status >= 500 || r.status === 429) throw Object.assign(new Error(`caller-token ${r.status}`), { code: 'network' })
    if (r.status !== 200) throw Object.assign(new Error(`caller-token ${r.status}`), { code: 'caller_unavailable' })
    const j = await r.json()
    stats.mints++
    const ttlMs = Math.min(600_000, Math.max(0, j.expiresAt * 1000 - Date.now()))
    ticket = { token: j.token, refreshAt: Date.now() + ttlMs - 60_000 }
    return ticket.token
  }

  /** UnitPlugin.request:msg 逐条回调(head / chunk / end / error)。 */
  async function request(req, onMsg) {
    const ac = new AbortController()
    if (active.has(req.id)) { onMsg({ type: 'error', code: 'bad_path', message: 'bad request id' }); return }
    active.set(req.id, ac)
    try {
      const method = String(req.method || 'GET').toUpperCase()
      if (!/^[0-9a-f-]{36}$/.test(String(req.unitId)) || !checkRelayPath(String(req.path))) { onMsg({ type: 'error', code: 'bad_path', message: 'outside the relay grammar' }); return }
      const url = `${o.apiBase}/units/${req.unitId}/proxy${req.path}`
      const pass = {}
      for (const [k, v] of Object.entries(req.headers || {})) if (k === 'content-type' || k === 'accept') pass[k] = String(v)
      for (let attempt = 0; attempt < 2; attempt++) {
        if (ac.signal.aborted) return
        let tk
        try { tk = await getTicket(attempt > 0) } catch (e) {
          stats.failClosed++
          onMsg({ type: 'error', code: e.code || 'network', message: e.message })
          return
        }
        const a = auth()
        if (!a) { onMsg({ type: 'error', code: 'caller_unavailable', message: 'not signed in' }); return }
        const headers = { ...pass, ...a, ...(negctl.dropCallerHeader ? {} : { 'X-Forsion-Caller': tk }) }
        let r
        try {
          r = await fetch(url, { method, headers, body: req.body ?? undefined, signal: ac.signal, redirect: 'manual' })
        } catch (e) {
          if (ac.signal.aborted) return
          onMsg({ type: 'error', code: 'network', message: String(e?.message || e) })
          return
        }
        if (r.status === 403 && attempt === 0) {
          const code = await codeOf(r)
          if (code === 'UNIT_CALLER_INVALID' || code === 'UNIT_CALLER_EXPIRED') { stats.retriedBadTicket++; ticket = null; continue }
        }
        stats.relayed++
        const h = {}
        for (const k of ['content-type', 'content-disposition', 'cache-control']) { const v = r.headers.get(k); if (v) h[k] = v }
        onMsg({ type: 'head', status: r.status, headers: h })
        if (r.body) {
          try {
            for await (const chunk of r.body) {
              if (ac.signal.aborted) return
              onMsg({ type: 'chunk', b64: Buffer.from(chunk).toString('base64') })
            }
          } catch (e) {
            if (ac.signal.aborted) return
            onMsg({ type: 'error', code: 'network', message: String(e?.message || e) })
            return
          }
        }
        onMsg({ type: 'end' })
        return
      }
    } finally {
      active.delete(req.id)
    }
  }

  return {
    stats,
    negctl,
    get identity() { return identity },
    attach: async () => { for (const [, ac] of active) ac.abort(); active.clear(); return { apiBase: o.apiBase } },
    status: async () => ({ registered: !!identity, unitId: identity?.unitId ?? null, name: identity?.name ?? null }),
    ensureRegistered: async () => {
      const had = !!identity
      try {
        const id = await ensure(false)
        return { unitId: id.unitId, name: id.name, created: !had }
      } catch (e) {
        throw Object.assign(new Error(e.message), { code: e.code || 'network' })
      }
    },
    forget: async ({ remote } = {}) => {
      const id = identity
      identity = null
      ticket = null
      forgotten = true
      if (id && remote) {
        const a = auth()
        if (a) await fetch(`${o.apiBase}/units/${id.unitId}`, { method: 'DELETE', headers: { ...a, 'X-Unit-Secret': id.secret } }).catch(() => {})
      }
      return { ok: true }
    },
    request,
    cancel: async ({ id }) => { const ac = active.get(id); if (ac) ac.abort(); return { ok: true } },
  }
}

module.exports = { createFakePhoneNative, loadRelayPaths }
