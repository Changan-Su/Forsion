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
const { runRows, statusKey, rowTone, runOn, isRunnableUnit, phoneIssueOfCode, removeThisPhone, REASON_STATUS_KEYS, CONFIRM_POLL_MS, CONFIRM_TIMEOUT_MS } = mod.exports

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

  await check('10 runOn:一直 pending → 120s 超时,停在「请允许」,不生效', async () => {
    const d = deps({ 'GET /unit/remote-access': access('pending') })
    const out = await runOn(API, DESK, d)
    assert.equal(out.kind, 'device')
    assert.equal(out.sticky.state, 'pending')
    assert.equal(d.selected.length, 0)
    assert.ok(d.slept.reduce((a, b) => a + b, 0) >= CONFIRM_TIMEOUT_MS)
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

  await check('16 UnitsSheet.tsx:唯一的生效出口 selectRunLocation(ref: TargetRef) = return setFocusTarget(ref)(K6-S2 整端切换);runOn 与移除本机只注入它', async () => {
    const tsx = fs.readFileSync(path.resolve(__dirname, '../src/UnitsSheet.tsx'), 'utf8')
    const defs = tsx.match(/function selectRunLocation\(ref: TargetRef\): Promise<void> \{([\s\S]*?)\n\}/g) || []
    assert.equal(defs.length, 1, '必须恰好一个 selectRunLocation 定义')
    assert.match(defs[0], /\{\s*return setFocusTarget\(ref\)\s*\}/, '生效 = 返回 setFocusTarget 的 Promise(移除本机要等它)')
    assert.equal((tsx.match(/select: selectRunLocation,/g) || []).length, 2, 'runOn 与 removeThisPhone 各注入一次')
    assert.match(tsx, /removeThisPhone\(\{/)
    assert.doesNotMatch(tsx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''), /unitForgetSelf\?\.\(\)[^\n]*\.then\(/, '移除不许绕过 removeThisPhone 直接调 unitForgetSelf')
    // 不许绕过出口自己切位置(K8 的整端切换兜底已被 R-21 删除):setFocusTarget 只在出口里出现一次;注释里提到的不算
    const code = tsx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.equal((code.match(/setFocusTarget\(/g) || []).length, 1, 'setFocusTarget 只许在 selectRunLocation 里调')
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
  const accessR = (caller, reason) => ok({ remoteSessions: true, principal: 'unit', caller, reason, maxApprovalMode: 'auto-edit' })
  const rowOf = (out, now) => runRows([U(DESK)], null, HOME, {}, { [DESK]: out.sticky }, now)[0]

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

  console.log(fails.length ? `\n${fails.length} failed` : '\nall passed')
  process.exit(fails.length ? 1 : 0)
})()
