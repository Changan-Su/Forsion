/**
 * 手机原生中继的 URL 语法单测 —— `npm run test:relaypaths`(mobile 目录,不用先 build)。
 * 用例表与 JVM 的 RelayPathsTest 共用:mobile/android/app/src/test/resources/relay-paths.json(两侧同一口径,INTEGRATION R-06)。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild') // ponytail: 借 vite 的传递依赖(同 live-island.test.cjs)

const src = buildSync({
  entryPoints: [path.resolve(__dirname, '../src/relayPaths.ts')],
  bundle: true, write: false, logLevel: 'silent', platform: 'node', format: 'cjs',
}).outputFiles[0].text
const mod = { exports: {} }
new Function('module', 'exports', src)(mod, mod.exports)
const { parseRelayUrl, checkRelayPath } = mod.exports

const table = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../android/app/src/test/resources/relay-paths.json'), 'utf8'))
const API = table.apiBase

const fails = []
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`) } catch (e) { console.log(`FAIL  ${name}\n      ${e.message.split('\n')[0]}`); fails.push(name) }
}

const kindOf = (r) => (r === null ? 'pass' : r.kind)

check('0 仪器自检:用例表三类都有、native 列不少于 30 条', () => {
  const js = table.cases.filter((c) => c.url)
  for (const k of ['relay', 'reject', 'pass']) assert.ok(js.filter((c) => c.js === k).length >= 5, `js=${k} 用例太少`)
  assert.ok(table.cases.filter((c) => typeof c.native === 'boolean').length >= 30)
})

for (const c of table.cases) {
  if (c.url) {
    check(`js  ${c.name} → ${c.js}`, () => {
      const r = parseRelayUrl(API, c.url)
      assert.equal(kindOf(r), c.js, JSON.stringify(r))
      if (c.js === 'relay') {
        assert.equal(r.unitId, c.id)
        assert.equal(r.path, c.path)
      }
    })
  }
  if (typeof c.native === 'boolean') {
    // 原生只看 (id, path):JS 这侧的 checkRelayPath 必须与 RelayPaths.check 的 path 半边同判(id 半边由 UNIT_UUID_RE 管)。
    check(`path ${c.name} → ${c.native}`, () => {
      const idOk = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(c.id)
      assert.equal(idOk && checkRelayPath(c.path), c.native)
    })
  }
}

check('相对 URL 按 origin 拼成绝对再判(不经 URL 规范化)', () => {
  const API2 = 'https://m.test/api'
  const rel = '/api/units/0f8fad5b-d9cb-469f-a165-70867728950e/proxy/engine/agent/sessions'
  assert.deepEqual(parseRelayUrl(API2, rel, 'https://m.test'), { kind: 'relay', unitId: '0f8fad5b-d9cb-469f-a165-70867728950e', path: '/engine/agent/sessions' })
  assert.equal(parseRelayUrl(API2, '/api/units/0f8fad5b-d9cb-469f-a165-70867728950e/proxy/engine/../x', 'https://m.test').kind, 'reject')
  // 协议相对不算相对路径:不拼 origin
  assert.equal(parseRelayUrl(API2, '//m.test/api/units/0f8fad5b-d9cb-469f-a165-70867728950e/proxy/engine/x', 'https://m.test'), null)
})

check('apiBase 为空 / url 非字符串 → null(未就绪不拦,也不误判)', () => {
  assert.equal(parseRelayUrl('', table.cases[0].url), null)
  assert.equal(parseRelayUrl(API, undefined), null)
})

console.log(fails.length ? `\n${fails.length} failed` : '\nall passed')
process.exit(fails.length ? 1 : 0)
