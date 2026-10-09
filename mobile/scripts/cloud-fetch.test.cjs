/**
 * 手机的 window.tangu.cloudFetch 单测 —— `npm run test:cloudfetch`(mobile 目录,不用先 build)。
 * 对象:src/cloudFetch.ts。契约照桌面的 cloud:fetch(Forsion Extend);路径闸的向量照抄 Extend 的 test/cloudApiPath.test.ts 那一族。
 * 真浏览器里「插件调得到、带着令牌打到云端」在 scripts/plugin-install.e2e.cjs 的 2c。
 */
const assert = require('node:assert/strict')
const { build } = require('esbuild')

const load = async () => {
  const out = (await build({ entryPoints: [require('node:path').resolve(__dirname, '../src/cloudFetch.ts')], bundle: true, write: false, logLevel: 'silent', platform: 'node', format: 'cjs' })).outputFiles[0].text
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', out)(mod, mod.exports, require)
  return mod.exports
}
const results = []
const test = async (name, fn) => {
  try { await fn(); results.push(true); console.log(`PASS  ${name}`) }
  catch (e) { results.push(false); console.log(`FAIL  ${name}\n      ${e && e.stack ? e.stack.split('\n').slice(0, 8).join('\n      ') : e}`) }
}

;(async () => {
  const { createCloudFetch, resolveCloudApiUrl } = await load()
  /** 假 fetch:记下每一次调用;reply 可以是 Response、函数或要抛的 Error。 */
  const rig = (over = {}) => {
    const calls = []
    const state = { base: 'https://cloud.test/api', token: 'tok', reply: () => new Response('{"ok":1}', { status: 200 }), ...over }
    const cf = createCloudFetch({
      cloudApiBase: () => state.base,
      token: () => state.token,
      fetch: async (input, init) => { calls.push({ input, init }); const r = state.reply(input, init); if (r instanceof Error) throw r; return r },
    })
    return { cf, calls, state }
  }

  await test('路径闸:相对路径拼到 /api 之下;基址含不含 /api、带不带尾斜杠都一样', async () => {
    assert.equal(resolveCloudApiUrl('https://c.test/api', '/meeting/rooms'), 'https://c.test/api/meeting/rooms')
    assert.equal(resolveCloudApiUrl('https://c.test/api/', '/x?y=1'), 'https://c.test/api/x?y=1')
    assert.equal(resolveCloudApiUrl('https://c.test', '/x'), 'https://c.test/api/x')
    assert.equal(resolveCloudApiUrl('http://10.0.2.2:3001/api', '/x'), 'http://10.0.2.2:3001/api/x')
  })

  await test('路径闸:绝对地址 / 不以斜杠开头 / 逃出 /api 前缀 / 非 http 基址 → null', async () => {
    for (const p of ['https://evil.com/x', 'evil.com/x', '', 'x', null, undefined, 7, '/../units', '/../../etc', '/a/../../b', '/%2e%2e/units']) {
      assert.equal(resolveCloudApiUrl('https://c.test/api', p), null, `path=${String(p)}`)
    }
    assert.equal(resolveCloudApiUrl('', '/x'), null)
    assert.equal(resolveCloudApiUrl('file:///etc', '/x'), null)
    assert.equal(resolveCloudApiUrl('not a url', '/x'), null)
    // 协议相对那一族不改 origin:落在自家服务器的一个怪路径上,不是外泄
    assert.equal(new URL(resolveCloudApiUrl('https://c.test/api', '//evil.com/x')).origin, 'https://c.test')
  })

  await test('GET:带账号令牌、不带请求体;回 { status, json }', async () => {
    const { cf, calls } = rig()
    assert.deepEqual(await cf({ path: '/events/current', body: { ignored: 1 } }), { status: 200, json: { ok: 1 } })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].input, 'https://cloud.test/api/events/current')
    assert.equal(calls[0].init.method, 'GET')
    assert.deepEqual(calls[0].init.headers, { Authorization: 'Bearer tok' })
    assert.equal(calls[0].init.body, undefined)
  })

  await test('POST:请求体按 JSON 发;方法名大小写不敏感;DELETE 不带体', async () => {
    const { cf, calls } = rig()
    await cf({ path: '/meeting/rooms', method: 'post', body: { a: 1 } })
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.body, '{"a":1}')
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
    await cf({ path: '/meeting/rooms/1', method: 'DELETE', body: { a: 1 } })
    assert.equal(calls[1].init.body, undefined)
  })

  await test('没发出去的几种:坏方法 / 坏路径 / 没有云端地址 → status 0 + 原因码,一次网络都不出', async () => {
    const { cf, calls, state } = rig()
    assert.deepEqual(await cf({ path: '/x', method: 'TRACE' }), { status: 0, error: 'bad_method' })
    assert.deepEqual(await cf({ path: 'https://evil.com/x' }), { status: 0, error: 'bad_path' })
    assert.deepEqual(await cf({ path: '/../units' }), { status: 0, error: 'bad_path' })
    assert.deepEqual(await cf({}), { status: 0, error: 'bad_path' })
    assert.deepEqual(await cf(null), { status: 0, error: 'bad_path' })
    state.base = ''
    assert.deepEqual(await cf({ path: '/x' }), { status: 0, error: 'no_cloud_url' })
    assert.equal(calls.length, 0)
  })

  await test('没登录 → { status: 401, error: not_signed_in },不出网;令牌每次现取(登出后不拿旧的)', async () => {
    const { cf, calls, state } = rig()
    await cf({ path: '/x' })
    state.token = ''
    assert.deepEqual(await cf({ path: '/x' }), { status: 401, error: 'not_signed_in' })
    assert.equal(calls.length, 1)
    state.token = 'tok2'
    await cf({ path: '/x' })
    assert.equal(calls[1].init.headers.Authorization, 'Bearer tok2')
  })

  await test('HTTP 错误照实回状态与 JSON;回的不是 JSON → json:null;网络异常 → status 0 + 原文;永不抛', async () => {
    const { cf, state } = rig()
    state.reply = () => new Response('{"error":"room_not_found"}', { status: 404 })
    assert.deepEqual(await cf({ path: '/x' }), { status: 404, json: { error: 'room_not_found' } })
    state.reply = () => new Response('<html>502</html>', { status: 502 })
    assert.deepEqual(await cf({ path: '/x' }), { status: 502, json: null })
    state.reply = () => new Error('Failed to fetch')
    assert.deepEqual(await cf({ path: '/x' }), { status: 0, error: 'Failed to fetch' })
  })

  await test('超时:到点中止,回 status 0;timeoutMs 下限 1s(给 1 也不会立刻中止)', async () => {
    const { cf, state } = rig()
    state.reply = (_i, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))
    const t0 = Date.now()
    assert.deepEqual(await cf({ path: '/x', timeoutMs: 1 }), { status: 0, error: 'aborted' })
    const dt = Date.now() - t0
    assert.ok(dt >= 950 && dt < 3000, `中止用时 ${dt}ms`)
  })

  const failed = results.filter((r) => !r).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
