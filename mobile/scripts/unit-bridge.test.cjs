/**
 * 手机 Unit 桥(src/unitBridge.ts)与 API 基址规则单测 —— `npm run test:unitbridge`(mobile 目录,不用先 build)。评审 P2 补的仪器:
 *
 * A. 启动握手(INTEGRATION §4.2):原生 attach() 回的 apiBase 与 JS 的 cloudApiBase 逐字相等才 ready;不等 / 缺席 / 抛错
 *    → 中继面一律合成 503 CALLER_UNSUPPORTED、原生 request 一次都不调、ensureRegistered 也不调。首个中继请求等握手。
 *    web 路径(plugin = null)不装中继:中继面 URL 交回原 fetch(K8 §3.4;否则 K6-S2 的 check:enginetarget 全红)。
 * B. 两份「native 分支 API 基址」产出逐字相等:vite.config.ts 的 nativeConfig()(烤进 APK 给原生)与 capacitorAuth.ts 的
 *    apiBase()(isNative 为真时),按一张 VITE_API_ORIGIN 表比 —— 都是真代码路径(esbuild 打包、只桩掉 vite / capacitor)。
 *
 * 负对照(实跑为红,见 CHANGELOG / 评审回复):把 unitBridge 的 `c.apiBase === apiBase` 改成 true → A2 红;
 * 把 nativeConfig 的规则改成不去尾斜杠 → B 红;把 web 路径的 relay 换回失败关闭 → A6 红。
 */
const assert = require('node:assert/strict')
const path = require('node:path')
const { build } = require('esbuild') // 异步 API:桩用插件(buildSync 不支持插件)

const load = async (entry, opts = {}) => {
  const out = (await build({
    entryPoints: [path.resolve(__dirname, entry)],
    bundle: true, write: false, logLevel: 'silent', platform: 'node', format: 'cjs', ...opts,
  })).outputFiles[0].text
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', '__dirname', out)(mod, mod.exports, require, path.resolve(__dirname, '..'))
  return mod.exports
}

/** 把若干包名换成给定源码的 esbuild 插件(桩)。 */
const stubs = (map) => ({
  name: 'stubs',
  setup(b) {
    const filter = new RegExp(`^(${Object.keys(map).map((k) => k.replace(/[/.@-]/g, '\\$&')).join('|')})$`)
    b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: map[a.path], loader: 'js' }))
  },
})


const API = 'https://api.forsion.net/api'
const U = '0f8fad5b-d9cb-469f-a165-70867728950e'
const RELAY_URL = `${API}/units/${U}/proxy/engine/agent/sessions`

/** 假原生插件:记账;attach 的结果可配(值 / reject / 手动放行)。 */
function fakePlugin(attach) {
  const p = {
    calls: { attach: 0, request: [], ensure: 0, status: 0 },
    attach: () => { p.calls.attach++; return typeof attach === 'function' ? attach() : Promise.resolve(attach) },
    status: async () => { p.calls.status++; return { registered: true, unitId: 'self', name: 'Pixel' } },
    ensureRegistered: async () => { p.calls.ensure++; return { unitId: 'self', name: 'Pixel', created: false } },
    forget: async () => ({ ok: true }),
    request: (o, cb) => {
      p.calls.request.push(o)
      setTimeout(() => { cb({ type: 'head', status: 200, headers: { 'content-type': 'application/json' } }); cb({ type: 'chunk', b64: Buffer.from('{"ok":true}').toString('base64') }); cb({ type: 'end' }) }, 1)
      return Promise.resolve('cb')
    },
    cancel: async () => ({ ok: true }),
  }
  return p
}

const fails = []
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`) } catch (e) { console.log(`FAIL  ${name}\n      ${String(e.message).split('\n')[0]}`); fails.push(name) }
}

;(async () => {
  const { createUnitBridge } = await load('../src/unitBridge.ts')

  await check('A1 握手成立(原生 apiBase === cloudApiBase)→ ready;中继面请求交给原生;握手只调一次', async () => {
    const p = fakePlugin({ apiBase: API })
    const b = createUnitBridge(API, p, 'https://localhost')
    assert.equal((await b.unitSelf()).relay, 'ready')
    const r = await b.relay(RELAY_URL)
    assert.equal(r.status, 200)
    assert.equal(p.calls.request.length, 1)
    assert.equal(p.calls.attach, 1)
    assert.equal(b.relay(`${API}/token-quota/my`), null, '非中继面照旧交回原 fetch')
  })

  await check('A2 原生 apiBase 与 cloudApiBase 不等 → unsupported:中继面合成 503 CALLER_UNSUPPORTED,原生 request / ensureRegistered 零调用', async () => {
    const p = fakePlugin({ apiBase: 'https://staging.forsion.net/api' })
    const b = createUnitBridge(API, p, 'https://localhost')
    assert.equal((await b.unitSelf()).relay, 'unsupported')
    const r = await b.relay(RELAY_URL)
    assert.equal(r.status, 503)
    assert.equal((await r.json()).code, 'CALLER_UNSUPPORTED')
    assert.deepEqual(await b.unitEnsureSelf(), { ok: false, code: 'caller_unsupported' })
    assert.equal(p.calls.request.length, 0, '票会被原生发往另一台主机')
    assert.equal(p.calls.ensure, 0)
  })

  await check('A3 逐字比较:只差一个尾斜杠也不成立', async () => {
    const p = fakePlugin({ apiBase: `${API}/` })
    const b = createUnitBridge(API, p, 'https://localhost')
    assert.equal((await b.unitSelf()).relay, 'unsupported')
    assert.equal((await b.relay(RELAY_URL)).status, 503)
    assert.equal(p.calls.request.length, 0)
  })

  await check('A4 原生没有 apiBase(forsion-native.json 缺席)/ 插件抛错 → unsupported', async () => {
    for (const attach of [{ apiBase: null }, () => Promise.reject(new Error('not implemented'))]) {
      const p = fakePlugin(attach)
      const b = createUnitBridge(API, p, 'https://localhost')
      assert.equal((await b.unitSelf()).relay, 'unsupported')
      assert.equal((await (await b.relay(RELAY_URL)).json()).code, 'CALLER_UNSUPPORTED')
      assert.equal(p.calls.request.length, 0)
    }
  })

  await check('A5 首个中继请求等握手返回才发(握手同时让原生收掉上一页遗留的中继:本页请求必须排在它后面)', async () => {
    let release
    const p = fakePlugin(() => new Promise((r) => { release = r }))
    const b = createUnitBridge(API, p, 'https://localhost')
    const pending = b.relay(RELAY_URL)
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(p.calls.request.length, 0, '握手还没回,请求就发出去了')
    release({ apiBase: API })
    assert.equal((await pending).status, 200)
    assert.equal(p.calls.request.length, 1)
  })

  await check('A6 web 路径(plugin = null)不装中继:中继面 URL 交回原 fetch;身份三件回「仅安卓 App」', async () => {
    const b = createUnitBridge(`http://localhost:5303/api`, null, 'http://localhost:5303')
    assert.equal(b.relay(`http://localhost:5303/api/units/${U}/proxy/engine/agent/sessions`), null)
    assert.equal(b.relay(`http://localhost:5303/api/units/${U}/proxy/unit/remote-access`), null)
    assert.equal((await b.unitSelf()).relay, 'native_only')
    assert.deepEqual(await b.unitEnsureSelf(), { ok: false, code: 'native_only' })
  })

  await check('A7 ensureRegistered 的 reject code 原样交给弹层(network / server_503 / caller_unsupported…)', async () => {
    const p = fakePlugin({ apiBase: API })
    p.ensureRegistered = async () => { const e = new Error('x'); e.code = 'server_503'; throw e }
    const b = createUnitBridge(API, p, 'https://localhost')
    assert.deepEqual(await b.unitEnsureSelf(), { ok: false, code: 'server_503' })
  })

  // ── B. nativeConfig ↔ apiBase(native)──
  const capStub = {
    '@capacitor/core': 'exports.Capacitor = { isNativePlatform: () => true }; exports.registerPlugin = () => ({})',
    '@capacitor/app': 'exports.App = {}',
    '@capacitor/browser': 'exports.Browser = {}',
    '@capacitor/preferences': 'exports.Preferences = {}',
  }
  const viteStub = {
    vite: 'exports.defineConfig = (f) => f; exports.loadEnv = () => ({})',
    '@vitejs/plugin-react': 'module.exports = () => ({ name: "react" }); module.exports.default = module.exports',
  }
  const { nativeConfig } = await load('../vite.config.ts', { plugins: [stubs(viteStub)] })
  const baked = (v) => {
    let emitted = null
    nativeConfig(v).generateBundle.call({ emitFile: (o) => { emitted = o } })
    assert.equal(emitted.fileName, 'forsion-native.json')
    return JSON.parse(emitted.source).apiBase
  }
  const jsNative = async (v) => {
    const env = v === undefined ? {} : { VITE_API_ORIGIN: v }
    return (await load('../src/capacitorAuth.ts', { plugins: [stubs(capStub)], define: { 'import.meta.env': JSON.stringify(env) } })).apiBase()
  }
  const TABLE = [undefined, '', 'https://api.forsion.net', 'https://api.forsion.net/', 'http://localhost:8788', 'http://10.0.2.2:3001/', 'https://self.example.com:8443']

  await check('B0 仪器自检:缺省烤的是生产网关,VITE_API_ORIGIN 覆盖生效', async () => {
    assert.equal(baked(undefined), 'https://api.forsion.net/api')
    assert.equal(await jsNative(undefined), 'https://api.forsion.net/api')
    assert.equal(baked('http://localhost:8788'), 'http://localhost:8788/api')
  })

  await check(`B1 ${TABLE.length} 个 VITE_API_ORIGIN 取值下,烤进 APK 的 apiBase 与 JS(native)的 apiBase() 逐字相等`, async () => {
    const diff = []
    for (const v of TABLE) {
      const a = baked(v)
      const b = await jsNative(v)
      if (a !== b) diff.push(`${JSON.stringify(v)}: native=${a} js=${b}`)
    }
    assert.deepEqual(diff, [])
  })

  console.log(fails.length ? `\n${fails.length} failed` : '\nall passed')
  process.exit(fails.length ? 1 : 0)
})()
