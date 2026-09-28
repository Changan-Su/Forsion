/**
 * UnitsSheet「在哪运行」的纯模型单测 —— `npm run test:unitssheet`(mobile 目录,不用先 build)。
 * 钉三件:行模型(滤手机 / 本机、kind 缺席按电脑、状态与选中态)、runOn 流程(何时调 select、何时不调)、
 * 以及 UnitsSheet.tsx 里唯一的生效出口 selectRunLocation(今天空操作,TODO(K6-S2))。
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
const { runRows, statusKey, runOn, isRunnableUnit, phoneIssueOfCode, CONFIRM_POLL_MS, CONFIRM_TIMEOUT_MS } = mod.exports

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
    assert.equal(phoneIssueOfCode('network'), 'callerUnavailable')
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

  await check('16 UnitsSheet.tsx:唯一的生效出口 selectRunLocation(ref: TargetRef),今天空操作并标 TODO(K6-S2);runOn 只注入它', async () => {
    const tsx = fs.readFileSync(path.resolve(__dirname, '../src/UnitsSheet.tsx'), 'utf8')
    const defs = tsx.match(/function selectRunLocation\(ref: TargetRef\): void \{([\s\S]*?)\n\}/g) || []
    assert.equal(defs.length, 1, '必须恰好一个 selectRunLocation 定义')
    assert.match(defs[0], /\{\s*void ref\s*\}/, '今天必须是空操作(K6-S2 并行,集成时才接 setFocusTarget)')
    const before = tsx.slice(Math.max(0, tsx.indexOf('function selectRunLocation') - 600), tsx.indexOf('function selectRunLocation'))
    assert.match(before, /TODO\(K6-S2\)/)
    assert.match(tsx, /select: selectRunLocation,/)
    // 不许绕过出口自己切位置(K8 的整端切换兜底已被 R-21 删除);注释里提到的不算
    const code = tsx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const banned of [/setFocusTarget\(/, /setRunTarget\(/, /location\.reload\(/, /remoteCaller\s*=/]) assert.doesNotMatch(code, banned)
    // 不许 import capacitor(web 手机形态复用本组件)
    assert.doesNotMatch(tsx, /from '@capacitor\//)
  })

  console.log(fails.length ? `\n${fails.length} failed` : '\nall passed')
  process.exit(fails.length ? 1 : 0)
})()
