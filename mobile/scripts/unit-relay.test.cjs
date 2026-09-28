/**
 * 手机原生中继 JS 适配(src/unitRelay.ts)单测 —— `npm run test:unitrelay`(mobile 目录,不用先 build)。
 *
 * 假原生 = 按 UnitRelay.java 的契约把请求真发到本进程起的假 hub(http://127.0.0.1:<port>/api),
 * 头**在假原生里从零重建**:Authorization = 原生 token、X-Forsion-Caller = 原生票,再加白名单里的 content-type / accept。
 * 于是「中继请求到 hub 时带着原生票、带的是原生 Authorization 而不是 JS 递来的那个」是在 hub 那一侧记账判的,不是看调用没抛。
 *
 * 负对照:`NEGCTL=1 node scripts/unit-relay.test.cjs` —— 把中继拿掉、同一请求走普通 fetch,第 1 条必须红
 * (hub 收到的是 JS 的 Authorization、没有 X-Forsion-Caller:就是「中继漏拦 = 静默降级成账号级」那种故障)。
 */
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const { buildSync } = require('esbuild')

const src = buildSync({
  entryPoints: [path.resolve(__dirname, '../src/unitRelay.ts')],
  bundle: true, write: false, logLevel: 'silent', platform: 'node', format: 'cjs',
}).outputFiles[0].text
const mod = { exports: {} }
new Function('module', 'exports', 'require', src)(mod, mod.exports, require)
const { createRelayFetch } = mod.exports

const NEGCTL = process.env.NEGCTL === '1'
const U = '0f8fad5b-d9cb-469f-a165-70867728950e'
const NATIVE_TOKEN = 'native-forsion-token'
const CALLER = 'fuc1.native-caller-ticket'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 假 hub:记账 + 几个端点 ──
const hits = []
let hubStreamRes = null
const hub = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    hits.push({ method: req.method, url: req.url, headers: req.headers, body })
    if (req.url.endsWith('/proxy/engine/agent/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Secret-Leak': 'nope' })
      res.write('data: one\n\n')
      hubStreamRes = res
      res.on('close', () => { if (hubStreamRes === res) hubStreamRes = null })
      return
    }
    if (req.url.endsWith('/proxy/engine/agent/nocontent')) { res.writeHead(204); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, echo: body || null }))
  })
})

/** 假原生:照 UnitRelay.java —— 目的地由「原生 apiBase」+ 固定前缀拼,头从零重建;逐块回调。 */
function makeNative(apiBase, over = {}) {
  const calls = []
  const cancels = []
  const live = new Map()
  const native = {
    calls, cancels,
    request(o, cb) {
      calls.push(o)
      if (over.request) return over.request(o, cb)
      const u = new URL(`${apiBase}/units/${o.unitId}/proxy${o.path}`)
      const headers = { Authorization: `Bearer ${NATIVE_TOKEN}`, 'X-Forsion-Caller': CALLER }
      for (const [k, v] of Object.entries(o.headers)) if (k === 'content-type' || k === 'accept') headers[k] = v
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: o.method, headers }, (res) => {
        const keep = {}
        for (const k of ['content-type', 'content-disposition', 'cache-control']) if (res.headers[k]) keep[k] = res.headers[k]
        cb({ type: 'head', status: res.statusCode, headers: keep })
        res.on('data', (d) => cb({ type: 'chunk', b64: Buffer.from(d).toString('base64') }))
        res.on('end', () => { live.delete(o.id); cb({ type: 'end' }) })
      })
      req.on('error', () => { if (live.has(o.id)) cb({ type: 'error', code: 'network' }); live.delete(o.id) })
      live.set(o.id, req)
      if (o.body !== undefined) req.write(o.body)
      req.end()
      return Promise.resolve(`cb-${o.id}`)
    },
    cancel(o) { cancels.push(o.id); const r = live.get(o.id); live.delete(o.id); if (r) r.destroy(); return Promise.resolve({ ok: true }) },
  }
  return native
}

const fails = []
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`) } catch (e) { console.log(`FAIL  ${name}\n      ${String(e.message).split('\n')[0]}`); fails.push(name) }
}

;(async () => {
  await new Promise((r) => hub.listen(0, '127.0.0.1', r))
  const API = `http://127.0.0.1:${hub.address().port}/api`
  const ready = { state: async () => 'ready' }
  const native = makeNative(API)
  const relay = createRelayFetch(native, API, ready)
  // 被测的「窗口 fetch」:中继先判,不是中继面的交给原 fetch(mobileShim 的包装同一形状)。NEGCTL 下拿掉中继。
  const wfetch = (input, init) => (NEGCTL ? null : relay(input, init)) ?? fetch(input, init)

  await check('1 中继请求到 hub:带原生票 X-Forsion-Caller,Authorization 是原生的、不是 JS 递来的;x-forsion-* 自报头被丢', async () => {
    hits.length = 0
    const r = await wfetch(`${API}/units/${U}/proxy/engine/agent/sessions`, {
      headers: { Authorization: 'Bearer js-decoy', 'X-Forsion-Caller': 'js-forged', 'x-forsion-remote-caller': 'forged', Accept: 'application/json' },
    })
    assert.equal(r.status, 200)
    const h = hits.at(-1).headers
    assert.equal(h['x-forsion-caller'], CALLER, 'hub 没收到原生票')
    assert.equal(h.authorization, `Bearer ${NATIVE_TOKEN}`, 'Authorization 不是原生 token')
    assert.equal(h['x-forsion-remote-caller'], undefined)
    assert.equal(h.accept, 'application/json')
  })

  if (NEGCTL) { console.log('\n(NEGCTL=1:只跑第 1 条)'); hub.close(); process.exit(fails.length ? 1 : 0) }

  await check('2 非中继 URL → null(交回原 fetch,不带任何原生头)', async () => {
    assert.equal(relay(`${API}/token-quota/my`), null)
    assert.equal(relay(`${API}/units/${U}/proxy/unit/hostfile?path=/x`), null)
    assert.equal(relay(`${API}/units/${U}/proxy/unit/mcp`), null)
    hits.length = 0
    await wfetch(`${API}/units/${U}/proxy/unit/hostfile?path=/x`, { headers: { Authorization: 'Bearer js' } })
    assert.equal(hits.at(-1).headers['x-forsion-caller'], undefined, '非中继请求带上了调用方票')
  })

  await check('3 原生只收到 content-type / accept 两个头', async () => {
    const before = native.calls.length
    await relay(`${API}/units/${U}/proxy/engine/agent/runs`, {
      method: 'POST', body: '{"a":1}',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: 'Bearer js', 'X-Forsion-Caller': 'x', Cookie: 'c=1' },
    })
    const o = native.calls[before]
    assert.deepEqual(Object.keys(o.headers).sort(), ['accept', 'content-type'])
    assert.equal(o.method, 'POST')
    assert.equal(o.body, '{"a":1}')
    assert.equal(o.path, '/engine/agent/runs')
  })

  await check('4 SSE 逐块可读:第一块在 hub 写第二块之前就读到(不攒包)', async () => {
    const r = await relay(`${API}/units/${U}/proxy/engine/agent/events`, { headers: { Accept: 'text/event-stream' } })
    assert.equal(r.headers.get('content-type'), 'text/event-stream')
    assert.equal(r.headers.get('x-secret-leak'), null)
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    const first = dec.decode((await reader.read()).value)
    assert.match(first, /data: one/)
    assert.ok(hubStreamRes, 'hub 流已断')
    hubStreamRes.write('data: two\n\n')
    const second = dec.decode((await reader.read()).value)
    assert.match(second, /data: two/)
    hubStreamRes.end()
    assert.equal((await reader.read()).done, true)
  })

  await check('5 流中途 abort → 原生 cancel 被调、hub 一秒内见到断开、reader 以 AbortError 结束', async () => {
    const ac = new AbortController()
    const r = await relay(`${API}/units/${U}/proxy/engine/agent/events`, { signal: ac.signal })
    const reader = r.body.getReader()
    await reader.read()
    const n = native.cancels.length
    ac.abort()
    await assert.rejects(reader.read(), (e) => e.name === 'AbortError')
    assert.equal(native.cancels.length, n + 1)
    for (let i = 0; i < 20 && hubStreamRes; i++) await sleep(50)
    assert.equal(hubStreamRes, null, 'hub 那侧的连接没断')
  })

  await check('6 reader.cancel() 同样传给原生', async () => {
    const r = await relay(`${API}/units/${U}/proxy/engine/agent/events`)
    const reader = r.body.getReader()
    await reader.read()
    const n = native.cancels.length
    await reader.cancel()
    assert.equal(native.cancels.length, n + 1)
    for (let i = 0; i < 20 && hubStreamRes; i++) await sleep(50)
  })

  await check('7 已 abort 的 signal → 立即 AbortError,原生一次都没被调', async () => {
    const ac = new AbortController(); ac.abort()
    const n = native.calls.length
    await assert.rejects(relay(`${API}/units/${U}/proxy/engine/agent/sessions`, { signal: ac.signal }), (e) => e.name === 'AbortError')
    assert.equal(native.calls.length, n)
  })

  await check('8 非字符串 body 显式抛 TypeError(不静默丢体);GET 带体同样拒', async () => {
    await assert.rejects(relay(`${API}/units/${U}/proxy/engine/agent/upload`, { method: 'POST', body: new Uint8Array([1]) }), /body must be a string/)
    await assert.rejects(relay(`${API}/units/${U}/proxy/engine/agent/x`, { method: 'GET', body: 'x' }), /GET\/HEAD/)
  })

  await check('9 204 → 空体 Response', async () => {
    const r = await relay(`${API}/units/${U}/proxy/engine/agent/nocontent`, { method: 'DELETE' })
    assert.equal(r.status, 204)
    assert.equal(r.body, null)
  })

  await check('10 head 前 error → TypeError(Failed to fetch,cause.code);head 后 error → 流报错', async () => {
    const n1 = createRelayFetch(makeNative(API, { request: (o, cb) => { setTimeout(() => cb({ type: 'error', code: 'network', message: 'boom' }), 5); return Promise.resolve('x') } }), API, ready)
    await assert.rejects(n1(`${API}/units/${U}/proxy/engine/x`), (e) => e instanceof TypeError && e.cause?.code === 'network')
    const n2 = createRelayFetch(makeNative(API, { request: (o, cb) => { cb({ type: 'head', status: 200, headers: {} }); setTimeout(() => cb({ type: 'error', code: 'too_large' }), 5); return Promise.resolve('x') } }), API, ready)
    const r = await n2(`${API}/units/${U}/proxy/engine/x`)
    await assert.rejects(r.text(), (e) => e instanceof TypeError && e.cause?.code === 'too_large')
  })

  await check('11 S4 失败关闭:caller_unavailable / caller_unsupported 在 head 前 → 合成 503 JSON,不当网络错', async () => {
    for (const [code, want] of [['caller_unavailable', 'CALLER_UNAVAILABLE'], ['caller_unsupported', 'CALLER_UNSUPPORTED']]) {
      const f = createRelayFetch(makeNative(API, { request: (o, cb) => { cb({ type: 'error', code }); return Promise.resolve('x') } }), API, ready)
      const r = await f(`${API}/units/${U}/proxy/engine/agent/sessions`)
      assert.equal(r.status, 503)
      assert.equal((await r.json()).code, want)
    }
  })

  await check('12 中继不可用(apiBase 断言失败 / web 路径)→ 503 CALLER_UNSUPPORTED,原生与 hub 都零请求', async () => {
    hits.length = 0
    const nat = makeNative(API)
    const f = createRelayFetch(nat, API, { state: async () => 'unsupported' })
    const r = await f(`${API}/units/${U}/proxy/engine/agent/sessions`)
    assert.equal(r.status, 503)
    assert.equal((await r.json()).code, 'CALLER_UNSUPPORTED')
    assert.equal(nat.calls.length, 0)
    const web = createRelayFetch(null, API, ready)
    assert.equal((await (await web(`${API}/units/${U}/proxy/unit/remote-access`)).json()).code, 'CALLER_UNSUPPORTED')
    assert.equal(hits.length, 0)
  })

  await check('13 语法不过的中继面 URL 失败关闭:TypeError、原生零调用、hub 零请求', async () => {
    hits.length = 0
    const n = native.calls.length
    for (const u of [`${API}/units/${U}/proxy/engine/../unit/mcp`, `${API}/units/${U.toUpperCase()}/proxy/engine/x`, `${API}/units/${U}/proxy/unit/../engine/x`]) {
      const p = relay(u)
      assert.ok(p, `没被当成中继面: ${u}`)
      await assert.rejects(p, TypeError)
    }
    assert.equal(native.calls.length, n)
    assert.equal(hits.length, 0)
  })

  await check('14 Request 对象入参:取它的 method / 头 / 体', async () => {
    const before = native.calls.length
    const req = new Request(`${API}/units/${U}/proxy/engine/agent/runs`, { method: 'POST', body: '{"r":1}', headers: { 'Content-Type': 'application/json' } })
    const r = await relay(req)
    assert.equal(r.status, 200)
    const o = native.calls[before]
    assert.equal(o.method, 'POST')
    assert.equal(o.body, '{"r":1}')
    assert.equal(o.headers['content-type'], 'application/json')
  })

  await check('15 越界状态码(1xx)不造 Response,按网络错拒', async () => {
    const f = createRelayFetch(makeNative(API, { request: (o, cb) => { cb({ type: 'head', status: 101, headers: {} }); return Promise.resolve('x') } }), API, ready)
    await assert.rejects(f(`${API}/units/${U}/proxy/engine/x`), TypeError)
  })

  hub.close()
  console.log(fails.length ? `\n${fails.length} failed` : '\nall passed')
  process.exit(fails.length ? 1 : 0)
})()
