/**
 * UnitsSheet「在哪运行」的纯模型单测 —— `npm run test:unitssheet`(mobile 目录,不用先 build)。
 * 钉三件:行模型(滤手机 / 本机、kind 缺席按电脑、状态与选中态)、runOn 流程(何时调 select、何时不调)、
 * 以及 UnitsSheet.tsx 里唯一的生效出口 selectRunLocation(= K6-S2 的 setFocusTarget)。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')

const src = buildSync({
  entryPoints: [path.resolve(__dirname, '../src/unitsSheetModel.ts')],
  bundle: true, write: false, logLevel: 'silent', platform: 'node', format: 'cjs',
  alias: { '@': path.resolve(__dirname, '../../desktop/frontend/src') },
}).outputFiles[0].text
const mod = { exports: {} }
new Function('module', 'exports', 'require', src)(mod, mod.exports, require)
const {
  runRows, statusKey, rowTone, runOn, isRunnableUnit, phoneIssueOfCode, removeThisPhone, rosterNameOf, REASON_STATUS_KEYS, CONFIRM_POLL_MS, CONFIRM_TIMEOUT_MS, CONFIRM_GRACE_MS,
  beginAttempt, noteAttempt, endAttempts, NO_MARKS,
} = mod.exports

/** 桌面那一侧(P1-KF 评审 P2 用):真 electron/remoteSessions.ts(零 electron 运行期依赖)与共享时序常量,同样现打包。 */
const bundle = (entry) => {
  const text = buildSync({ entryPoints: [entry], bundle: true, write: false, logLevel: 'silent', platform: 'node', format: 'cjs', external: ['electron'] }).outputFiles[0].text
  const m = { exports: {} }
  new Function('module', 'exports', 'require', text)(m, m.exports, require)
  return m.exports
}
const desk = bundle(path.resolve(__dirname, '../../desktop/electron/remoteSessions.ts'))
const shared = bundle(path.resolve(__dirname, '../../desktop/shared/remoteSessions.ts'))

const fails = []
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`) } catch (e) { console.log(`FAIL  ${name}\n      ${String(e.message).split('\n')[0]}`); fails.push(name) }
}

const HOME = { kind: 'home' }
const U = (id, extra = {}) => ({ id, name: `N-${id}`, platform: 'darwin', icon: null, online: true, ...extra })
const API = 'https://api.forsion.net/api'
const DESK = '0f8fad5b-d9cb-469f-a165-70867728950e'

/** 假依赖:路由表 → {status, json};记账 fetch / select / sleep。时钟由 sleep 推进。 */
function deps(routes, over = {}) {
  const d = {
    fetched: [], selected: [], slept: [], progressed: [], t: 1_000_000,
    ensureSelf: async () => ({ ok: true, unitId: 'self-id', name: 'Pixel' }),
    fetchJson: async (url, init) => {
      d.fetched.push(`${(init && init.method) || 'GET'} ${url.slice(`${API}/units/${DESK}/proxy`.length)}`)
      const key = `${(init && init.method) || 'GET'} ${url.slice(`${API}/units/${DESK}/proxy`.length)}`
      const r = routes[key]
      if (r === 'throw') throw new TypeError('Failed to fetch')
      const v = typeof r === 'function' ? r(d) : r
      if (!v) return { status: 404, json: { detail: 'not found' } }
      return v
    },
    select: (ref) => d.selected.push(ref),
    sleep: async (ms) => { d.slept.push(ms); d.t += ms },
    now: () => d.t,
    progress: (p) => d.progressed.push(p),
    ...over,
  }
  return d
}
const ok = (json = {}) => ({ status: 200, json })
const access = (caller, remoteSessions = true) => ok({ remoteSessions, principal: 'unit', caller, maxApprovalMode: 'auto-edit' })
const accessR = (caller, reason) => ok({ remoteSessions: true, principal: 'unit', caller, reason, maxApprovalMode: 'auto-edit' })
const rowOf = (out, now) => runRows([U(DESK)], null, HOME, {}, { [DESK]: out.sticky }, now)[0]

;(async () => {
  await check('1 行模型:滤掉手机与本机;kind 缺席(老名册)按电脑', async () => {
    const units = [U('a'), U('b', { kind: 'phone' }), U('self', { kind: 'phone' }), U('c', { kind: 'desktop' }), U('me')]
    const rows = runRows(units, 'me', HOME)
    assert.deepEqual(rows.map((r) => r.id), ['a', 'c'])
    assert.equal(isRunnableUnit({ id: 'x' }, null), true)
    assert.equal(isRunnableUnit({ id: 'x', kind: 'phone' }, null), false)
  })

  await check('2 行状态:离线 / caps 自报 / 探针 / 粘滞拒绝;选中态跟 current', async () => {
    const now = 5_000_000
    const units = [
      U('off', { online: false }),
      U('stop', { capsLive: true, caps: { engine: 'stopped' } }),
      U('fresh', { capsLive: true, caps: { engine: 'ready' } }),
      U('probed'),
      U('refused'),
    ]
    const rows = runRows(units, null, { kind: 'unit', unitId: 'probed' }, { probed: { ok: true } }, { refused: { code: 'REMOTE_SESSIONS_OFF', at: now } }, now)
    const by = Object.fromEntries(rows.map((r) => [r.id, r]))
    assert.equal(by.off.status, 'offline')
    assert.equal(by.stop.status, 'engineStopped')
    assert.equal(by.fresh.status, 'checking')
    assert.equal(by.fresh.capsReady, true)
    assert.equal(by.probed.status, 'ready')
    assert.equal(by.probed.selected, true)
    assert.equal(by.fresh.selected, false)
    assert.equal(by.refused.status, 'remoteOff')
  })

  await check('3 statusKey:没探过时按设备自报提示(可用 / 状态未知),探着的时候是「正在连接」', async () => {
    assert.equal(statusKey({ status: 'checking', capsReady: true }, false), 'unitm.ready')
    assert.equal(statusKey({ status: 'checking', capsReady: false }, false), 'unitm.unknown')
    assert.equal(statusKey({ status: 'checking', capsReady: true }, true), 'unitm.checking')
    assert.equal(statusKey({ status: 'engineStopped' }, false), 'unitm.engineOff')
    assert.equal(statusKey({ status: 'awaitingConfirm' }, false), 'unitm.confirmPending')
    assert.equal(statusKey({ status: 'denied' }, false), 'unitm.confirmDenied')
    for (const s of ['ready', 'starting', 'noEngine', 'offline', 'unreachable', 'remoteOff']) assert.match(statusKey({ status: s }, false), /^unitm\./)
  })

  await check('4 runOn:本机不是安卓 App → 手机级横幅 nativeOnly,一个请求都不发、不生效', async () => {
    const d = deps({}, { ensureSelf: async () => ({ ok: false, code: 'native_only' }) })
    assert.deepEqual(await runOn(API, DESK, d), { kind: 'phone', issue: 'nativeOnly' })
    assert.equal(d.fetched.length, 0)
    assert.equal(d.selected.length, 0)
    assert.equal(phoneIssueOfCode('caller_unsupported'), 'callerUnsupported')
  })

  await check('4b 评审 P1:本机登记失败按原因分横幅 —— 断网 / 5xx / 限流是 network,token 被拒是 signedOut,只有明确拒绝才是 callerUnavailable', async () => {
    for (const c of ['network', 'server_500', 'server_502', 'server_503', 'server_429']) assert.equal(phoneIssueOfCode(c), 'network', c)
    for (const c of ['server_401', 'auth_expired', 'not_signed_in']) assert.equal(phoneIssueOfCode(c), 'signedOut', c)
    for (const c of ['caller_unavailable', 'CALLER_UNAVAILABLE', 'storage', 'server_403', 'no_api_base']) assert.equal(phoneIssueOfCode(c), 'callerUnavailable', c)
    assert.equal(phoneIssueOfCode('server_5000'), 'callerUnavailable', '只认三位状态码')
    const d = deps({}, { ensureSelf: async () => ({ ok: false, code: 'network' }) })
    assert.deepEqual(await runOn(API, DESK, d), { kind: 'phone', issue: 'network' })
    assert.equal(d.fetched.length, 0)
  })

  await check('5 runOn:老桌面(remote-access 404)→ 探引擎 200 → 生效一次,ref = {kind:unit, unitId}', async () => {
    const d = deps({ 'GET /engine/agent/sessions': ok({ sessions: [] }) })
    assert.deepEqual(await runOn(API, DESK, d), { kind: 'selected' })
    assert.deepEqual(d.fetched, ['GET /unit/remote-access', 'GET /engine/agent/sessions'])
    assert.deepEqual(d.selected, [{ kind: 'unit', unitId: DESK }])
  })

  await check('6 runOn:已受信 → 探引擎 → 生效', async () => {
    const d = deps({ 'GET /unit/remote-access': access('trusted'), 'GET /engine/agent/sessions': ok() })
    assert.equal((await runOn(API, DESK, d)).kind, 'selected')
    assert.equal(d.selected.length, 1)
  })

  await check('7 runOn:开关关着 → 粘滞 REMOTE_SESSIONS_OFF,不探引擎、不生效', async () => {
    const d = deps({ 'GET /unit/remote-access': access('trusted', false), 'GET /engine/agent/sessions': ok() })
    const out = await runOn(API, DESK, d)
    assert.equal(out.kind, 'device')
    assert.equal(out.sticky.code, 'REMOTE_SESSIONS_OFF')
    assert.deepEqual(d.fetched, ['GET /unit/remote-access'])
    assert.equal(d.selected.length, 0)
  })

  await check('8 runOn:被拒(denied)→ 粘滞 denied,不生效', async () => {
    const d = deps({ 'GET /unit/remote-access': access('denied') })
    const out = await runOn(API, DESK, d)
    assert.deepEqual([out.kind, out.sticky.code, out.sticky.state], ['device', 'REMOTE_CALLER_UNCONFIRMED', 'denied'])
    assert.equal(d.selected.length, 0)
  })

  await check('9 runOn:未确认 → POST request → pending 每 2s 轮询 → trusted → 探引擎 → 生效;期间报「请允许」', async () => {
    let polls = 0
    const d = deps({
      'GET /unit/remote-access': () => (polls++ === 0 ? access('unconfirmed') : polls < 4 ? access('pending') : access('trusted')),
      'POST /unit/remote-access/request': access('pending'),
      'GET /engine/agent/sessions': ok(),
    })
    assert.equal((await runOn(API, DESK, d)).kind, 'selected')
    assert.ok(d.fetched.includes('POST /unit/remote-access/request'))
    assert.ok(d.slept.length >= 2 && d.slept.every((ms) => ms === CONFIRM_POLL_MS))
    assert.equal(d.progressed[0].sticky.state, 'pending')
    assert.deepEqual(d.selected, [{ kind: 'unit', unitId: DESK }])
  })

  await check('10 KF 评审 P2 runOn:一直 pending → 截止后宽限一拍再核一次 → 仍 pending(排在别的框后面)→ 「点按再次请求」,**不停在「请允许」**,不生效', async () => {
    const d = deps({ 'GET /unit/remote-access': access('pending') })
    const out = await runOn(API, DESK, d)
    assert.equal(out.kind, 'device')
    assert.deepEqual([out.sticky.state, out.sticky.reason], ['unconfirmed', undefined])
    assert.equal(d.selected.length, 0)
    const total = d.slept.reduce((a, b) => a + b, 0)
    assert.ok(total >= CONFIRM_TIMEOUT_MS + CONFIRM_GRACE_MS, `等得不够久:${total}ms`)
    assert.equal(d.slept[d.slept.length - 1], CONFIRM_GRACE_MS, '最后一拍是宽限')
    assert.equal(statusKey(rowOf(out, d.t), false), 'unitm.confirmNotAsked')
  })

  await check('10b KF 评审 P2 runOn:桌面的框在手机截止之后才到点(no-answer)→ 宽限后的最后一次核对拿到它 → 「没人回应」callerBlocked,不是「请允许」', async () => {
    let t0 = null
    const d = deps({ 'GET /unit/remote-access': (dd) => {
      t0 ??= dd.t
      return dd.t - t0 >= CONFIRM_TIMEOUT_MS + CONFIRM_GRACE_MS ? accessR('unconfirmed', 'no-answer') : access('pending')
    } })
    const out = await runOn(API, DESK, d)
    assert.deepEqual([out.sticky.state, out.sticky.reason], ['unconfirmed', 'no-answer'])
    assert.equal(d.slept[d.slept.length - 1], CONFIRM_GRACE_MS, '是宽限后的那次核对拿到的')
    const row = rowOf(out, d.t)
    assert.deepEqual([row.status, statusKey(row, false)], ['callerBlocked', 'unitm.reason.noAnswer'])
  })

  await check('10c KF 评审 P2 截止与桌面同源:CONFIRM_TIMEOUT_MS > 查名册上限 + 弹框时限(shared/remoteSessions.ts)', async () => {
    assert.equal(typeof shared.REMOTE_PROMPT_TTL_MS, 'number')
    assert.equal(typeof shared.ROSTER_LOOKUP_TIMEOUT_MS, 'number')
    assert.ok(CONFIRM_TIMEOUT_MS > shared.ROSTER_LOOKUP_TIMEOUT_MS + shared.REMOTE_PROMPT_TTL_MS, `${CONFIRM_TIMEOUT_MS} 不晚于桌面的 ${shared.ROSTER_LOOKUP_TIMEOUT_MS} + ${shared.REMOTE_PROMPT_TTL_MS}`)
    const src = fs.readFileSync(path.resolve(__dirname, '../../desktop/electron/remoteSessions.ts'), 'utf8')
    assert.match(src, /const PROMPT_TTL_MS = REMOTE_PROMPT_TTL_MS\b/, '桌面弹框时限得用共享常量')
    assert.match(src, /timeoutMs \?\? ROSTER_LOOKUP_TIMEOUT_MS\b/, '桌面查名册超时得用共享常量')
  })

  await check('10d KF 评审 P2 真桌面确认状态机 × 真 runOn(虚拟时钟):那台查名册 10s 才弹框、2 分钟没人答 → 手机落「没人回应」;全程从没停在「请允许」', async () => {
    const PHONE = '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e6f'
    const ACC = 'https://cloud.test::u1'
    const vt = { now: 1_790_000_000_000, timers: [], seq: 0 }
    const realST = global.setTimeout
    const realCT = global.clearTimeout
    const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)) }
    const advance = async (ms) => {
      const end = vt.now + ms
      for (;;) {
        await flush()
        vt.timers.sort((a, b) => a.at - b.at || a.id - b.id)
        const t = vt.timers[0]
        if (!t || t.at > end) break
        vt.timers.shift()
        vt.now = t.at
        t.fn()
      }
      vt.now = end
      await flush()
    }
    global.setTimeout = (fn, ms) => { const t = { at: vt.now + (ms || 0), fn, id: ++vt.seq }; vt.timers.push(t); return t }
    global.clearTimeout = (t) => { vt.timers = vt.timers.filter((x) => x !== t) }
    try {
      const prompts = []
      const rs = desk.createRemoteSessions({
        file: () => '/userData/remote-sessions.json',
        unitHostEnabled: async () => true,
        readCap: async () => 'auto-edit',
        writeCap: async () => {},
        accountId: () => ACC,
        // 最坏情况:名册查询吃满超时才回来(真 lookupRosterUnit 的上限)
        lookupUnit: () => new Promise((res) => setTimeout(() => res({ name: 'Pixel 9', registeredName: 'Pixel 9', kind: 'phone', platform: 'android', createdAt: null }), shared.ROSTER_LOOKUP_TIMEOUT_MS)),
        confirm: (_opts, signal) => new Promise((res) => { prompts.push({ at: vt.now, signal }); signal.addEventListener('abort', () => res(null)) }), // 没人答
        permitted: () => true,
        isLocked: () => false,
        onChanged: () => {},
        log: () => {},
        now: () => vt.now,
        readFile: async () => JSON.stringify({ v: 1, enabled: true, migratedFromUnitHost: true, trusted: [], accountStrict: [] }),
        writeFile: async () => {},
      })
      await rs.init()
      const caller = { kind: 'unit', caller: { unit: PHONE, kind: 'phone', name: 'Pixel 9', platform: 'android', registeredAt: null } }
      const d = deps({
        'GET /unit/remote-access': () => ok(rs.gate.status(caller)),
        'POST /unit/remote-access/request': async () => ok(await rs.gate.request(caller)),
      }, { sleep: async (ms) => { d.slept.push(ms); await advance(ms) }, now: () => vt.now })
      d.fetchJson = async (url, init) => {
        const key = `${(init && init.method) || 'GET'} ${url.slice(`${API}/units/${DESK}/proxy`.length)}`
        d.fetched.push(key)
        if (key === 'GET /unit/remote-access') return ok(rs.gate.status(caller))
        if (key === 'POST /unit/remote-access/request') return ok(await rs.gate.request(caller))
        return { status: 404, json: {} }
      }
      const out = await runOn(API, DESK, d)
      assert.equal(out.kind, 'device')
      assert.notEqual(out.sticky.state, 'pending', `手机在 ${(vt.now - prompts[0]?.at) / 1000}s(框弹出后)就放弃、停在「请允许」—— 桌面的框还要开到 ${shared.REMOTE_PROMPT_TTL_MS / 1000}s`)
      assert.deepEqual([out.sticky.state, out.sticky.reason], ['unconfirmed', 'no-answer'], JSON.stringify(out))
      assert.equal(prompts.length, 1, '那台电脑弹过一次框')
      assert.ok(prompts[0].signal.aborted, '框到点收掉了')
      const row = rowOf(out, vt.now)
      assert.deepEqual([row.status, statusKey(row, false)], ['callerBlocked', 'unitm.reason.noAnswer'])
      assert.equal(d.selected.length, 0)
    } finally {
      global.setTimeout = realST
      global.clearTimeout = realCT
    }
  })

  await check('11 runOn:pending 之后被拒 → denied', async () => {
    let n = 0
    const d = deps({ 'GET /unit/remote-access': () => (n++ < 2 ? access('pending') : access('denied')) })
    const out = await runOn(API, DESK, d)
    assert.equal(out.sticky.state, 'denied')
    assert.equal(d.selected.length, 0)
  })

  await check('12 runOn:引擎没起(503 ENGINE_NOT_READY)→ 设备探针失败带码,不生效', async () => {
    const d = deps({ 'GET /unit/remote-access': access('trusted'), 'GET /engine/agent/sessions': { status: 503, json: { code: 'ENGINE_NOT_READY' } } })
    const out = await runOn(API, DESK, d)
    assert.deepEqual(out, { kind: 'device', probe: { ok: false, status: 503, code: 'ENGINE_NOT_READY' } })
    assert.equal(d.selected.length, 0)
  })

  await check('13 runOn:中继合成 503 CALLER_UNAVAILABLE → 手机级横幅(不记到这台电脑头上)', async () => {
    const d = deps({ 'GET /unit/remote-access': { status: 503, json: { code: 'CALLER_UNAVAILABLE' } } })
    assert.deepEqual(await runOn(API, DESK, d), { kind: 'phone', issue: 'callerUnavailable' })
    const d2 = deps({ 'GET /unit/remote-access': access('trusted'), 'GET /engine/agent/sessions': { status: 503, json: { code: 'CALLER_UNSUPPORTED' } } })
    assert.deepEqual(await runOn(API, DESK, d2), { kind: 'phone', issue: 'callerUnsupported' })
    assert.equal(d.selected.length + d2.selected.length, 0)
  })

  await check('13b runOn:中继合成的 401(换票撞 401 = forsion_token 被拒)→ 手机级 signedOut 横幅,不记到这台电脑头上', async () => {
    const d = deps({ 'GET /unit/remote-access': { status: 401, json: { detail: 'Invalid or expired token' } } })
    assert.deepEqual(await runOn(API, DESK, d), { kind: 'phone', issue: 'signedOut' })
    const d2 = deps({ 'GET /unit/remote-access': access('trusted'), 'GET /engine/agent/sessions': { status: 401, json: null } })
    assert.deepEqual(await runOn(API, DESK, d2), { kind: 'phone', issue: 'signedOut' })
    assert.equal(d.selected.length + d2.selected.length, 0)
  })

  await check('14 runOn:网络错 → 设备探针 status 0(unreachable),不生效', async () => {
    const d = deps({ 'GET /unit/remote-access': 'throw' })
    assert.deepEqual(await runOn(API, DESK, d), { kind: 'device', probe: { ok: false, status: 0 } })
  })

  await check('15 runOn:等待确认时弹层关了(abort)→ cancelled,不生效、不再轮询', async () => {
    const ac = new AbortController()
    let n = 0
    const d = deps({ 'GET /unit/remote-access': () => { if (++n === 2) ac.abort(); return access('pending') } })
    assert.deepEqual(await runOn(API, DESK, d, ac.signal), { kind: 'cancelled' })
    assert.equal(d.selected.length, 0)
    assert.ok(n <= 2)
  })

  await check('15b 评审 P2:移除本机 —— 当前在某台电脑上时先切回云端并**等它生效**,再移除;在云端时不多切一次', async () => {
    const order = []
    let release
    const pending = removeThisPhone({
      current: () => ({ kind: 'unit', unitId: DESK }),
      select: (ref) => { order.push(`select:${ref.kind}`); return new Promise((r) => { release = r }) },
      forget: async () => { order.push('forget'); return { ok: true } },
    })
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(order, ['select:home'], '切换还没生效就移除了(移除途中的轮询 / SSE 重连会撞 403 → 悄悄重新登记)')
    release()
    assert.deepEqual(await pending, { ok: true })
    assert.deepEqual(order, ['select:home', 'forget'])
    const order2 = []
    await removeThisPhone({ current: () => HOME, select: () => { order2.push('select') }, forget: async () => { order2.push('forget'); return { ok: true } } })
    assert.deepEqual(order2, ['forget'])
  })

  await check('16b rosterNameOf:切到电脑时的焦点展示名 = 名册里那台的名字(id 不分大小写);home / 不在名册 / 名字空 → null(M1B)', async () => {
    const units = [U('AAAA-1'), U('b-2', { name: '  ' })]
    assert.equal(rosterNameOf(units, { kind: 'unit', unitId: 'aaaa-1' }), 'N-AAAA-1')
    assert.equal(rosterNameOf(units, { kind: 'unit', unitId: 'b-2' }), null)
    assert.equal(rosterNameOf(units, { kind: 'unit', unitId: 'zzz' }), null)
    assert.equal(rosterNameOf(units, HOME), null)
  })

  await check('16 UnitsSheet.tsx:唯一的生效出口 selectRunLocation(ref: TargetRef) = return setDraftLocation(ref, {explicit:true, name})(R-21,K7 之后);runOn 与移除本机只注入它', async () => {
    const tsx = fs.readFileSync(path.resolve(__dirname, '../src/UnitsSheet.tsx'), 'utf8')
    const defs = tsx.match(/function selectRunLocation\(ref: TargetRef\): Promise<void> \{([\s\S]*?)\n\}/g) || []
    assert.equal(defs.length, 1, '必须恰好一个 selectRunLocation 定义')
    assert.match(defs[0], /\{\s*return setDraftLocation\(ref, \{ explicit: true, name: rosterNameOf\(lastRoster, ref\) \}\)\s*\}/, '生效 = 返回 setDraftLocation(亲手选的)的 Promise(移除本机要等它);展示名取名册(M1B)')
    assert.equal((tsx.match(/select: selectRunLocation,/g) || []).length, 2, 'runOn 与 removeThisPhone 各注入一次')
    assert.match(tsx, /removeThisPhone\(\{/)
    assert.doesNotMatch(tsx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''), /unitForgetSelf\?\.\(\)[^\n]*\.then\(/, '移除不许绕过 removeThisPhone 直接调 unitForgetSelf')
    // 不许绕过出口自己切位置(K8 的整端切换兜底已被 R-21 删除):setFocusTarget 只在出口里出现一次;注释里提到的不算
    const code = tsx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.equal((code.match(/setFocusTarget\(/g) || []).length, 0, '不许绕过 setDraftLocation 直接 setFocusTarget(K7 之后,R-21)')
    assert.equal((code.match(/setDraftLocation\(/g) || []).length, 1, 'setDraftLocation 只许在 selectRunLocation 里调')
    for (const banned of [/setRunTarget\(/, /location\.reload\(/, /remoteCaller\s*=/]) assert.doesNotMatch(code, banned)
    // 当前位置读整端焦点,不是写死云端
    assert.match(code, /function currentRunLocation\(\): TargetRef \{\s*return focusRef\(\)\s*\}/)
    // 不许 import capacitor(web 手机形态复用本组件)
    assert.doesNotMatch(tsx, /from '@capacitor\//)
  })

  // ── P1-KF:拒绝按 reason 先、state 后 —— 带 reason = 那台电脑上不会弹框:不发起确认、不进「请允许」的轮询 ──
  const REASONS = [
    ['strict', 'denied'], ['never-prompts', 'unconfirmed'], ['not-signed-in', 'unconfirmed'], ['roster-miss', 'denied'],
    ['roster-unreachable', 'unconfirmed'], ['no-answer', 'unconfirmed'], ['busy', 'unconfirmed'],
  ]

  await check('17 KF runOn:问状态就带 reason(7 种)→ 不 POST、不报「请允许」、不轮询、不生效;行 = callerBlocked + 按 reason 的文案', async () => {
    assert.equal(Object.keys(REASON_STATUS_KEYS).length, REASONS.length)
    for (const [reason, state] of REASONS) {
      const d = deps({ 'GET /unit/remote-access': accessR(state, reason), 'POST /unit/remote-access/request': accessR('pending') })
      const out = await runOn(API, DESK, d)
      assert.equal(out.kind, 'device', reason)
      assert.deepEqual([out.sticky.code, out.sticky.state, out.sticky.reason], ['REMOTE_CALLER_UNCONFIRMED', state, reason], reason)
      assert.deepEqual(d.fetched, ['GET /unit/remote-access'], `${reason}:不许发起确认 / 探引擎`)
      assert.equal(d.progressed.length, 0, `${reason}:不许报「请在 X 上允许」`)
      assert.equal(d.slept.length, 0, `${reason}:不许轮询`)
      assert.equal(d.selected.length, 0)
      const row = rowOf(out, d.t)
      assert.equal(row.status, 'callerBlocked', reason)
      assert.equal(statusKey(row, false), REASON_STATUS_KEYS[reason], reason)
      assert.notEqual(statusKey(row, false), 'unitm.confirmPending')
      assert.notEqual(statusKey(row, false), 'unitm.confirmDenied', `${reason}:denied 的「10 分钟后可再请求」不适用`)
      assert.equal(rowTone(row, false), ['roster-unreachable', 'no-answer', 'busy'].includes(reason) ? 'warn' : 'err', reason)
    }
  })

  await check('18 KF runOn:发起确认那一拍才知道排满(busy)→ 不报「请允许」、不轮询', async () => {
    const d = deps({ 'GET /unit/remote-access': access('unconfirmed'), 'POST /unit/remote-access/request': accessR('unconfirmed', 'busy') })
    const out = await runOn(API, DESK, d)
    assert.deepEqual([out.sticky.state, out.sticky.reason], ['unconfirmed', 'busy'])
    assert.deepEqual(d.fetched, ['GET /unit/remote-access', 'POST /unit/remote-access/request'])
    assert.equal(d.progressed.length, 0)
    assert.equal(d.slept.length, 0)
  })

  await check('19 KF runOn:轮询中那台查完名册 → denied + roster-miss:立刻停,行文案是名册缺失(不说「10 分钟后可再请求」)', async () => {
    let n = 0
    const d = deps({
      'GET /unit/remote-access': () => (n++ === 0 ? access('unconfirmed') : n < 3 ? access('pending') : accessR('denied', 'roster-miss')),
      'POST /unit/remote-access/request': access('pending'),
    })
    const out = await runOn(API, DESK, d)
    assert.deepEqual([out.sticky.state, out.sticky.reason], ['denied', 'roster-miss'])
    assert.equal(d.progressed.length, 1)
    assert.equal(d.progressed[0].sticky.state, 'pending')
    assert.ok(d.slept.length <= 3, `停得不够快:${d.slept.length} 次轮询`)
    assert.equal(statusKey(rowOf(out, d.t), false), 'unitm.reason.rosterMiss')
    // 弹框 2 分钟没人答(no-answer):同样立刻停
    let m = 0
    const d2 = deps({ 'GET /unit/remote-access': () => (m++ === 0 ? access('pending') : accessR('unconfirmed', 'no-answer')) })
    const out2 = await runOn(API, DESK, d2)
    assert.deepEqual([out2.sticky.state, out2.sticky.reason], ['unconfirmed', 'no-answer'])
    assert.equal(d2.slept.length, 1)
  })

  await check('20 KF runOn:轮询中弹框收了、没有回答(回 unconfirmed 无 reason)→ 立刻停,不空转到 120s;行说「点按再次请求」', async () => {
    let n = 0
    const d = deps({ 'GET /unit/remote-access': () => (n++ < 2 ? access('pending') : access('unconfirmed')) })
    const out = await runOn(API, DESK, d)
    assert.deepEqual([out.kind, out.sticky.state, out.sticky.reason], ['device', 'unconfirmed', undefined])
    assert.equal(d.slept.length, 2)
    const row = rowOf(out, d.t)
    assert.equal(row.status, 'awaitingConfirm')
    assert.equal(statusKey(row, false), 'unitm.confirmNotAsked')
    // 发起了确认也没排上(那台开关刚关 / 锁定):同样不进轮询
    const d2 = deps({ 'GET /unit/remote-access': access('unconfirmed'), 'POST /unit/remote-access/request': access('unconfirmed') })
    const out2 = await runOn(API, DESK, d2)
    assert.equal(out2.sticky.state, 'unconfirmed')
    assert.equal(d2.progressed.length + d2.slept.length, 0)
  })

  await check('21 KF runOn:发起确认的请求失败 → 不进「请允许」的轮询(原先会空等 120s)', async () => {
    const d = deps({ 'GET /unit/remote-access': access('unconfirmed'), 'POST /unit/remote-access/request': 'throw' })
    assert.deepEqual(await runOn(API, DESK, d), { kind: 'device', probe: { ok: false, status: 0 } })
    assert.equal(d.progressed.length + d.slept.length, 0)
    const d2 = deps({ 'GET /unit/remote-access': access('unconfirmed'), 'POST /unit/remote-access/request': { status: 500, json: {} } })
    assert.deepEqual(await runOn(API, DESK, d2), { kind: 'device', probe: { ok: false, status: 500 } })
  })

  await check('22 KF 行状态:探针 / 粘滞里的 reason 先于 state;没有 reason 的 denied 才是「拒绝了、10 分钟后可再请求」;pending 仍是「请允许」', async () => {
    const now = 7_000_000
    const probe = { ok: false, status: 403, code: 'REMOTE_CALLER_UNCONFIRMED', state: 'denied', reason: 'strict' }
    const [a] = runRows([U('a')], null, HOME, { a: probe }, {}, now)
    assert.deepEqual([a.status, a.refusal], ['callerBlocked', { state: 'denied', reason: 'strict' }])
    assert.equal(statusKey(a, false), 'unitm.reason.strict')
    const [b] = runRows([U('b')], null, HOME, {}, { b: { code: 'REMOTE_CALLER_UNCONFIRMED', state: 'denied', at: now } }, now)
    assert.deepEqual([b.status, statusKey(b, false), rowTone(b, false)], ['denied', 'unitm.confirmDenied', 'err'])
    const [c] = runRows([U('c')], null, HOME, {}, { c: { code: 'REMOTE_CALLER_UNCONFIRMED', state: 'pending', at: now } }, now)
    assert.deepEqual([c.status, statusKey(c, false), rowTone(c, false)], ['awaitingConfirm', 'unitm.confirmPending', 'warn'])
    // 不认得的 reason(更新的桌面)= 按 state
    const [x] = runRows([U('x')], null, HOME, {}, { x: { code: 'REMOTE_CALLER_UNCONFIRMED', state: 'pending', reason: 'from-the-future', at: now } }, now)
    assert.deepEqual([x.status, statusKey(x, false)], ['awaitingConfirm', 'unitm.confirmPending'])
  })

  await check('23 KF 文案(zh / en):每个 reason 键两种语言都在、en 无汉字、{name} 两侧一致;严格档 / 名册缺失不许诺「10 分钟后可再请求」,denied 才说', async () => {
    const tsx = fs.readFileSync(path.resolve(__dirname, '../src/UnitsSheet.tsx'), 'utf8')
    const blocks = [...tsx.matchAll(/registerMessages\((\{[\s\S]*?\n\})\)/g)].map((m) => new Function(`return (${m[1]})`)())
    const msgs = Object.assign({}, ...blocks)
    const keys = [...Object.values(REASON_STATUS_KEYS), 'unitm.confirmDenied', 'unitm.confirmNotAsked', 'unitm.confirmPending']
    for (const k of keys) {
      const m = msgs[k]
      assert.ok(m && m.zh && m.en, `${k} 缺 zh / en`)
      assert.doesNotMatch(m.en, /[一-鿿]/, `${k} 的 en 含汉字`)
      assert.deepEqual((m.zh.match(/\{\w+\}/g) || []).sort(), (m.en.match(/\{\w+\}/g) || []).sort(), `${k} 占位符不一致`)
      assert.match(m.zh, /\{name\}/, k)
    }
    for (const k of ['unitm.reason.strict', 'unitm.reason.rosterMiss', 'unitm.reason.neverPrompts', 'unitm.reason.notSignedIn']) {
      assert.doesNotMatch(msgs[k].zh, /10\s*分钟|再次请求/, `${k}(zh)不许许诺 10 分钟后可再请求`)
      assert.doesNotMatch(msgs[k].en, /10 minutes|ask again in/i, `${k}(en)不许许诺 10 分钟后可再请求`)
    }
    assert.match(msgs['unitm.confirmDenied'].zh, /10 分钟/)
    assert.match(msgs['unitm.confirmDenied'].en, /10 minutes/)
    for (const k of Object.values(REASON_STATUS_KEYS)) {
      assert.doesNotMatch(msgs[k].zh, /请在「\{name\}」上允许/, `${k} 不是「等确认」`)
      assert.doesNotMatch(msgs[k].en, /^Allow this phone/, `${k} 不是「等确认」`)
    }
  })

  await check('24 KF 评审 P2 行表:上一轮的「连不上」(status 0 探针)不许盖住这一轮的回答 —— reason 文案、「请允许」都照出;没人轮询时不留「请允许」', async () => {
    const now = 9_000_000
    const row = (m) => runRows([U(DESK)], null, HOME, m.probes, m.sticky, now)[0]
    const blip = noteAttempt(NO_MARKS, DESK, { probe: { ok: false, status: 0 } })
    assert.deepEqual([row(blip).status, statusKey(row(blip), false)], ['unreachable', 'unitm.unreachable'])
    // 评审原场景:再点一次 → 那台回 roster-miss(问状态就知道)
    const again = beginAttempt(blip, DESK)
    assert.equal(row(again).status, 'checking', '新一轮从零开始(行上「正在连接…」)')
    assert.equal(statusKey(row(again), true), 'unitm.checking')
    const miss = noteAttempt(again, DESK, { sticky: { code: 'REMOTE_CALLER_UNCONFIRMED', state: 'denied', reason: 'roster-miss', at: now } })
    assert.deepEqual([row(miss).status, statusKey(row(miss), false)], ['callerBlocked', 'unitm.reason.rosterMiss'])
    // 就算没经过 beginAttempt(别的入口直接落结果):那台电脑的回答照样顶掉旧探针
    const direct = noteAttempt(blip, DESK, { sticky: { code: 'REMOTE_CALLER_UNCONFIRMED', state: 'unconfirmed', reason: 'no-answer', at: now } })
    assert.deepEqual([row(direct).status, statusKey(row(direct), false)], ['callerBlocked', 'unitm.reason.noAnswer'])
    // 轮询中的「请允许」:旧探针不许把它藏起来
    const pend = noteAttempt(beginAttempt(blip, DESK), DESK, { sticky: { code: 'REMOTE_CALLER_UNCONFIRMED', state: 'pending', at: now } })
    assert.deepEqual([row(pend).status, statusKey(row(pend), false)], ['awaitingConfirm', 'unitm.confirmPending'])
    assert.deepEqual([row(noteAttempt(blip, DESK, { sticky: { code: 'REMOTE_CALLER_UNCONFIRMED', state: 'pending', at: now } })).status], ['awaitingConfirm'])
    // 探针成功 → 清粘滞;探针失败 → 也顶掉旧粘滞(谁新听谁)
    assert.equal(row(noteAttempt(miss, DESK, { probe: { ok: true } })).status, 'ready')
    assert.deepEqual(noteAttempt(miss, DESK, { probe: { ok: false, status: 0 } }).sticky, {})
    // 弹层关了 / 选了云端:「请允许」收掉(没人轮询了),拒绝与探针照留
    const other = '11111111-2222-4333-8444-555555555555'
    const mixed = noteAttempt(pend, other, { sticky: { code: 'REMOTE_CALLER_UNCONFIRMED', state: 'denied', at: now } })
    const closed = endAttempts(mixed)
    assert.equal(closed.sticky[DESK], undefined, '「请允许」没收掉')
    assert.equal(closed.sticky[other].state, 'denied', '拒绝不该被收掉')
    assert.equal(endAttempts(NO_MARKS), NO_MARKS)
    // 点另一行:上一行的「请允许」也收掉(那一轮已中止),拒绝照留
    const switched = beginAttempt(noteAttempt(mixed, DESK, { sticky: { code: 'REMOTE_CALLER_UNCONFIRMED', state: 'pending', at: now } }), other)
    assert.equal(switched.sticky[DESK], undefined)
    assert.equal(switched.sticky[other], undefined, '点的这一行从零开始')
  })

  await check('25 KF 评审 P2 UnitsSheet.tsx:每行两张表只经 beginAttempt / noteAttempt / endAttempts 改(不许再直接 setProbes / setSticky)', async () => {
    const tsx = fs.readFileSync(path.resolve(__dirname, '../src/UnitsSheet.tsx'), 'utf8')
    assert.doesNotMatch(tsx, /setProbes|setSticky/, '还有直接改探针 / 粘滞表的地方')
    assert.match(tsx, /setMarks\(\(m\) => beginAttempt\(m, row\.id\)\)/, 'pick() 没从零开始')
    assert.match(tsx, /setMarks\(\(m\) => noteAttempt\(m, row\.id, p\)\)/, 'note() 没走 noteAttempt')
    assert.match(tsx, /setMarks\(endAttempts\)/, '关弹层 / 选云端没收「请允许」')
  })

  console.log(fails.length ? `\n${fails.length} failed` : '\nall passed')
  process.exit(fails.length ? 1 : 0)
})()
