/**
 * Android 插件宿主 + 应用市场数据层单测 —— `npm run test:plugins`(mobile 目录,不用先 build)。
 * 对象:src/plugins/pluginHost.ts(listPlugins / uninstallPlugin / 插件私有数据双槽写)与 src/plugins/mobileMarket.ts
 * (解析 → 下载 → 校验 → 解包 → 落盘)。文件系统用内存替身(PluginFs 接缝),下载 / 云端接口用假函数 —— 不碰 Capacitor。
 * 真浏览器里的整条链(市场 → 安装 → 插件跑起来 → 数据跨重载)在 scripts/plugin-install.e2e.cjs。
 */
const assert = require('node:assert/strict')
const path = require('node:path')
const { build } = require('esbuild')
const JSZip = require('jszip')

const load = async (entry) => {
  const out = (await build({
    entryPoints: [path.resolve(__dirname, entry)],
    bundle: true, write: false, logLevel: 'silent', platform: 'node', format: 'cjs',
  })).outputFiles[0].text
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', out)(mod, mod.exports, require)
  return mod.exports
}

/** 内存 PluginFs:路径 → 字节;目录由文件路径隐含(与 Capacitor 一样,列不存在的目录抛错)。
 *  failWriteAfter:第 n 次写只写进一半就「被杀」(抛错),模拟写到一半进程没了。 */
function memFs() {
  const files = new Map()
  let writes = 0
  const api = {
    files,
    failWriteAt: -1,
    async readBytes(p) { if (!files.has(p)) throw new Error(`File does not exist: ${p}`); return files.get(p) },
    async writeBytes(p, bytes) {
      writes += 1
      if (writes === api.failWriteAt) { files.set(p, bytes.subarray(0, Math.floor(bytes.length / 2))); throw new Error('killed') }
      files.set(p, new Uint8Array(bytes))
    },
    async list(dir) {
      const pre = `${dir}/`
      const out = new Map()
      for (const k of files.keys()) {
        if (!k.startsWith(pre)) continue
        const rest = k.slice(pre.length)
        const [head, ...tail] = rest.split('/')
        out.set(head, tail.length ? 'directory' : 'file')
      }
      if (!out.size) throw new Error('Folder does not exist.')
      return [...out].map(([name, type]) => ({ name, type }))
    },
    async stat(p) {
      if (files.has(p)) return { type: 'file', size: files.get(p).length }
      for (const k of files.keys()) if (k.startsWith(`${p}/`)) return { type: 'directory', size: 0 }
      return null
    },
    async removeDir(p) { for (const k of [...files.keys()]) if (k.startsWith(`${p}/`)) files.delete(k) },
  }
  return api
}
const enc = (s) => new TextEncoder().encode(s)
const dec = (b) => new TextDecoder().decode(b)
const put = (fs, p, text) => fs.files.set(p, enc(text))
const manifest = (o) => JSON.stringify({ apiVersion: 1, version: '1.0.0', name: 'Demo', ...o })
/** 合规 icon.png 的最小头:签名 + IHDR 宽高。 */
function png(w, h) {
  const b = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b)
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  return new Uint8Array(b)
}
async function zipOf(entries) {
  const z = new JSZip()
  for (const [n, c] of Object.entries(entries)) z.file(n, c)
  return new Uint8Array(await z.generateAsync({ type: 'uint8array' }))
}
/** jszip generate 会规整 `../`,造不出穿越条目 → 同长度换名:把字节里的占位名改成穿越名(CRC 只算内容,不算名)。 */
function renameInZip(bytes, from, to) {
  assert.equal(from.length, to.length)
  const b = Buffer.from(bytes)
  const f = Buffer.from(from), t = Buffer.from(to)
  let i = b.indexOf(f), n = 0
  while (i >= 0) { t.copy(b, i); n++; i = b.indexOf(f, i + 1) }
  assert.ok(n >= 2, 'local header + central directory')
  return new Uint8Array(b)
}

const results = []
const test = async (name, fn) => {
  try { await fn(); results.push([name, true]); console.log(`PASS  ${name}`) }
  catch (e) { results.push([name, false]); console.log(`FAIL  ${name}\n      ${e && e.stack ? e.stack.split("\n").slice(0, 14).join('\n      ') : e}`) }
}

;(async () => {
  const { createPluginHost } = await load('../src/plugins/pluginHost.ts')
  const { createMobileMarket, createFetchDownload, matchesIntegrity, MOBILE_MARKET_TYPES } = await load('../src/plugins/mobileMarket.ts')
  const T = (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k) // 文案替身:断言看键
  const host = (fs, appVersion = '2.11.4') => createPluginHost(fs, { appVersion: () => appVersion })

  // ── listPlugins ───────────────────────────────────────────────────────────
  await test('空目录 → [](插件根还不存在 = 一个都没装)', async () => {
    assert.deepEqual(await host(memFs()).listPlugins(), [])
  })

  await test('合法插件:manifest 映射与桌面同一份(名称 / 英文镜像 / 能力白名单)、读 main / README / CHANGELOG / 图标', async () => {
    const fs = memFs()
    put(fs, 'plugins/hello/manifest.json', manifest({ id: 'hello', nameEn: 'Hello', capabilities: ['activeWindow', 'bogus'], fileExtensions: ['.x.md', 3] }))
    put(fs, 'plugins/hello/main.js', 'ctx.x=1')
    put(fs, 'plugins/hello/README.md', '# hi')
    put(fs, 'plugins/hello/CHANGELOG.md', '## 1.0.0')
    fs.files.set('plugins/hello/icon.png', png(64, 64))
    const [p] = await host(fs).listPlugins()
    assert.equal(p.id, 'hello'); assert.equal(p.code, 'ctx.x=1'); assert.equal(p.nameEn, 'Hello')
    assert.deepEqual(p.capabilities, ['activeWindow']); assert.deepEqual(p.fileExtensions, ['.x.md'])
    assert.equal(p.readme, '# hi'); assert.equal(p.changelog, '## 1.0.0')
    assert.match(p.iconUrl, /^data:image\/png;base64,/)
    assert.equal(p.blocked, undefined); assert.equal(p.bundle, undefined); assert.equal(p.isDesktopOnly, undefined)
  })

  await test('图标不合规(非正方形 / 太大)→ 没有 iconUrl,插件照常列出', async () => {
    const fs = memFs()
    put(fs, 'plugins/a/manifest.json', manifest({ id: 'a' })); put(fs, 'plugins/a/main.js', '')
    fs.files.set('plugins/a/icon.png', png(128, 64))
    put(fs, 'plugins/b/manifest.json', manifest({ id: 'b' })); put(fs, 'plugins/b/main.js', '')
    fs.files.set('plugins/b/icon.png', new Uint8Array(300 * 1024))
    const list = await host(fs).listPlugins()
    assert.deepEqual(list.map((p) => [p.id, p.iconUrl]), [['a', undefined], ['b', undefined]])
  })

  await test('id 规则 = effectivePluginId:manifest id 非法回落目录名;两者皆非法拒载;同 id 先到先得(按目录名排序)', async () => {
    const fs = memFs()
    put(fs, 'plugins/dir-ok/manifest.json', manifest({ id: 'Bad.Id' })); put(fs, 'plugins/dir-ok/main.js', '1')
    put(fs, 'plugins/Bad_Dir/manifest.json', manifest({ id: 'NOPE' })); put(fs, 'plugins/Bad_Dir/main.js', '2')
    put(fs, 'plugins/a-first/manifest.json', manifest({ id: 'dup' })); put(fs, 'plugins/a-first/main.js', 'first')
    put(fs, 'plugins/b-second/manifest.json', manifest({ id: 'dup' })); put(fs, 'plugins/b-second/main.js', 'second')
    put(fs, 'plugins/.hidden/manifest.json', manifest({ id: 'hidden' })); put(fs, 'plugins/.hidden/main.js', '')
    const list = await host(fs).listPlugins()
    assert.deepEqual(list.map((p) => [p.id, p.code]), [['dup', 'first'], ['dir-ok', '1']])
  })

  await test('门禁:apiVersion 不符 → api;应用太旧 → minApp;宿主版本未知(Unreleased)不误杀;被闸的代码不读不发', async () => {
    const fs = memFs()
    put(fs, 'plugins/api2/manifest.json', manifest({ id: 'api2', apiVersion: 2 })); put(fs, 'plugins/api2/main.js', 'x')
    put(fs, 'plugins/newer/manifest.json', manifest({ id: 'newer', minAppVersion: '99.0.0' })); put(fs, 'plugins/newer/main.js', 'y')
    const list = await host(fs).listPlugins()
    assert.deepEqual(list.map((p) => [p.id, p.blocked, p.code]), [['api2', 'api', ''], ['newer', 'minApp', '']])
    const unknownVer = await host(fs, null).listPlugins()
    assert.deepEqual(unknownVer.map((p) => [p.id, p.blocked ?? null]), [['api2', 'api'], ['newer', null]])
  })

  await test('isDesktopOnly:true → 列出为 blocked:desktopOnly、代码不读(没有 main.js 也照样列出);"true" 字符串不算声明', async () => {
    const fs = memFs()
    put(fs, 'plugins/desk/manifest.json', manifest({ id: 'desk', isDesktopOnly: true }))
    put(fs, 'plugins/loose/manifest.json', manifest({ id: 'loose', isDesktopOnly: 'true' })); put(fs, 'plugins/loose/main.js', 'z')
    const list = await host(fs).listPlugins()
    assert.deepEqual(list.map((p) => [p.id, p.blocked ?? null, p.code, p.isDesktopOnly ?? null]), [['desk', 'desktopOnly', '', true], ['loose', null, 'z', null]])
  })

  await test('main 读不到 / main 越界(../)/ manifest 坏 → 整个跳过(不伪装成已启用的空壳)', async () => {
    const fs = memFs()
    put(fs, 'plugins/nomain/manifest.json', manifest({ id: 'nomain' }))
    put(fs, 'plugins/escape/manifest.json', manifest({ id: 'escape', main: '../nomain/x.js' })); put(fs, 'plugins/nomain/x.js', 'evil')
    put(fs, 'plugins/broken/manifest.json', '{oops'); put(fs, 'plugins/broken/main.js', '')
    put(fs, 'plugins/arr/manifest.json', '[1]'); put(fs, 'plugins/arr/main.js', '')
    put(fs, 'plugins/sub/manifest.json', manifest({ id: 'sub', main: 'dist/index.js' })); put(fs, 'plugins/sub/dist/index.js', 'ok')
    const list = await host(fs).listPlugins()
    assert.deepEqual(list.map((p) => [p.id, p.code]), [['sub', 'ok']])
  })

  // ── uninstallPlugin ───────────────────────────────────────────────────────
  await test('uninstallPlugin 按生效 id 定位目录(slug ≠ id)、整目录删;插件私有数据保留(同桌面)', async () => {
    const fs = memFs()
    put(fs, 'plugins/market-slug/manifest.json', manifest({ id: 'real-id' })); put(fs, 'plugins/market-slug/main.js', '')
    put(fs, 'plugins/other/manifest.json', manifest({ id: 'other' })); put(fs, 'plugins/other/main.js', '')
    const h = host(fs)
    await h.writePluginData('real-id', '{"k":1}')
    await h.uninstallPlugin('real-id')
    assert.ok(![...fs.files.keys()].some((k) => k.startsWith('plugins/market-slug/')))
    assert.ok(fs.files.has('plugins/other/manifest.json'))
    assert.equal(await h.readPluginData('real-id'), '{"k":1}')
  })

  await test('uninstallPlugin:非法 id → invalid-plugin-id;没装 → plugin-not-found(原因码给 ipcErrorText 译)', async () => {
    const h = host(memFs())
    await assert.rejects(h.uninstallPlugin('../x'), /^Error: invalid-plugin-id$/)
    await assert.rejects(h.uninstallPlugin('ghost'), /^Error: plugin-not-found$/)
  })

  // ── 插件私有数据 ─────────────────────────────────────────────────────────
  await test('readPluginData / writePluginData 往返;没写过 = null;非法 id 读 null、写拒', async () => {
    const h = host(memFs())
    assert.equal(await h.readPluginData('p'), null)
    await h.writePluginData('p', '{"a":1}')
    assert.equal(await h.readPluginData('p'), '{"a":1}')
    await h.writePluginData('p', '"second"')
    assert.equal(await h.readPluginData('p'), '"second"')
    assert.equal(await h.readPluginData('../etc'), null)
    await assert.rejects(h.writePluginData('../etc', 'x'), /invalid-plugin-id/)
  })

  await test('双槽交替写:每次写较旧的那一槽,最新有效槽永远不碰', async () => {
    const fs = memFs()
    const h = host(fs)
    await h.writePluginData('p', 'v1')
    await h.writePluginData('p', 'v2')
    await h.writePluginData('p', 'v3')
    const a = JSON.parse(dec(fs.files.get('plugins-data/p.json')))
    const b = JSON.parse(dec(fs.files.get('plugins-data/p.json.alt')))
    assert.deepEqual([a.seq, a.text, b.seq, b.text], [3, 'v3', 2, 'v2'])
  })

  await test('写到一半被杀:半截槽不被当成数据,读回上一次成功写入的版本;之后的写照常落在坏槽上', async () => {
    const fs = memFs()
    const h = host(fs)
    await h.writePluginData('p', '{"n":1}') // 写 #1 → 槽 0
    await h.writePluginData('p', '{"n":2}') // 写 #2 → 槽 1
    fs.failWriteAt = 3 // 写 #3(→ 槽 0)只写进一半就「被杀」
    await assert.rejects(h.writePluginData('p', '{"n":3}'), /killed/)
    assert.equal(await h.readPluginData('p'), '{"n":2}')
    await h.writePluginData('p', '{"n":4}')
    assert.equal(await host(fs).readPluginData('p'), '{"n":4}') // 新宿主实例(= 重启)读盘
  })

  await test('信封的任何真前缀都不是合法数据(JSON 对象截断必不合法 —— 数字 / 字符串载荷也被信封兜住)', async () => {
    const fs = memFs()
    const h = host(fs)
    await h.writePluginData('p', '12345')
    const full = dec(fs.files.get('plugins-data/p.json'))
    for (let n = 0; n < full.length; n++) {
      fs.files.set('plugins-data/p.json', enc(full.slice(0, n)))
      assert.equal(await host(fs).readPluginData('p'), null, `prefix ${n}`)
    }
  })

  await test('并发写串行化:十次并发写,最后一次胜出', async () => {
    const h = host(memFs())
    await Promise.all(Array.from({ length: 10 }, (_, i) => h.writePluginData('p', String(i))))
    assert.equal(await h.readPluginData('p'), '9')
  })

  // ── 市场 ────────────────────────────────────────────────────────────────
  const API = 'https://cloud.test/api'
  /** 假云端 + 假下载。install = 每个市场 id 的解析结果;blobs = 下载地址 → 字节 / Error。 */
  function market({ install = {}, blobs = {}, items = [], reserved = [], fs = memFs(), mirror = 'default', ...limits } = {}) {
    const fetched = []
    const downloaded = []
    const progress = []
    const fetch = async (url) => {
      fetched.push(url)
      const u = new URL(url)
      const json = (status, body) => ({ ok: status < 300, status, json: async () => body })
      let m
      if (u.pathname === '/api/market/items') return json(200, { items: items.filter((it) => !u.searchParams.get('type') || it.type === u.searchParams.get('type')).map((x) => ({ ...x })) })
      if ((m = /^\/api\/market\/items\/([^/]+)\/install$/.exec(u.pathname))) return install[m[1]] ? json(200, install[m[1]]) : json(404, {})
      if ((m = /^\/api\/market\/items\/([^/]+)$/.exec(u.pathname))) return json(200, { ...items.find((x) => x.id === m[1]) })
      return json(404, {})
    }
    const download = async (url, { maxBytes, onProgress }) => {
      downloaded.push(url)
      const v = blobs[url]
      if (!v) throw new Error('HTTP 404')
      if (v instanceof Error) throw v
      if (v.length > maxBytes) throw new Error('too large')
      onProgress(v.length, v.length)
      return v
    }
    const mk = createMobileMarket({ fs, cloudApiBase: () => API, fetch, download, mirror: () => mirror, reservedIds: () => reserved, t: T, ...limits })
    mk.onMarketInstallProgress((p) => progress.push(p))
    return { mk, fs, fetched, downloaded, progress }
  }
  const PKG = { 'pkg-abc/manifest.json': manifest({ id: 'hello-mobile', version: '1.2.0' }), 'pkg-abc/main.js': 'ctx', 'pkg-abc/README.md': '# r', '__MACOSX/pkg-abc/._main.js': 'junk' }

  await test('marketTypes = 只有 Forsion 插件', async () => {
    assert.deepEqual([...MOBILE_MARKET_TYPES], ['amadeus-plugin'])
    assert.deepEqual([...market().mk.marketTypes], ['amadeus-plugin'])
  })

  await test('marketList / marketDetail:路径对齐桌面(含 /api 的基址 + /market/...),相对 iconUrl 拼成云端源的绝对地址', async () => {
    const { mk, fetched } = market({ items: [{ id: 'a', type: 'amadeus-plugin', iconUrl: '/api/market/items/a/icon?v=1' }, { id: 'b', type: 'skill', iconUrl: 'https://cdn/x.png' }] })
    const r = await mk.marketList('amadeus-plugin')
    assert.deepEqual(r.items.map((x) => x.iconUrl), ['https://cloud.test/api/market/items/a/icon?v=1'])
    assert.equal(fetched[0], 'https://cloud.test/api/market/items?type=amadeus-plugin')
    const d = await mk.marketDetail('b')
    assert.equal(d.iconUrl, 'https://cdn/x.png')
  })

  await test('安装正常包:重定根 + 丢垃圾 + manifest 最后落盘;返回形状同桌面(含插件 id);进度三阶段', async () => {
    const zip = await zipOf(PKG)
    const { mk, fs, progress } = market({ install: { m1: { type: 'amadeus-plugin', installSlug: 'hello-slug', downloadUrl: 'https://oss.test/p.zip', source: 'zip' } }, blobs: { 'https://oss.test/p.zip': zip } })
    const order = []
    const w = fs.writeBytes
    fs.writeBytes = async (p, b) => { order.push(p); return w(p, b) }
    const r = await mk.marketInstall('m1')
    assert.deepEqual(r, { ok: true, path: 'plugins/hello-slug', files: 3, type: 'amadeus-plugin', slug: 'hello-slug', id: 'hello-mobile' })
    assert.deepEqual([...fs.files.keys()].sort(), ['plugins/hello-slug/README.md', 'plugins/hello-slug/main.js', 'plugins/hello-slug/manifest.json'])
    assert.equal(order.at(-1), 'plugins/hello-slug/manifest.json')
    assert.deepEqual([...new Set(progress.map((p) => p.phase))], ['resolve', 'download', 'install'])
    const [p] = await host(fs).listPlugins()
    assert.deepEqual([p.id, p.version, p.code], ['hello-mobile', '1.2.0', 'ctx'])
    assert.deepEqual((await mk.marketInstalled())['amadeus-plugin'], [{ slug: 'hello-slug', version: '1.2.0' }])
  })

  await test('覆盖安装 / 更新:旧版目录先整个清掉(旧版多出来的文件不残留)', async () => {
    const { mk, fs } = market({ install: { m1: { type: 'amadeus-plugin', installSlug: 's', downloadUrl: 'https://oss.test/p.zip' } }, blobs: { 'https://oss.test/p.zip': await zipOf(PKG) } })
    put(fs, 'plugins/s/old-only.js', 'stale')
    await mk.marketInstall('m1')
    assert.ok(!fs.files.has('plugins/s/old-only.js'))
  })

  await test('穿越条目 → 整包拒、一个字节都不落盘', async () => {
    const zip = renameInZip(await zipOf({ 'manifest.json': manifest({ id: 'evil' }), 'zz/evil.js': 'x' }), 'zz/evil.js', '../evil.js')
    const { mk, fs } = market({ install: { m1: { type: 'amadeus-plugin', installSlug: 'evil', downloadUrl: 'https://oss.test/e.zip' } }, blobs: { 'https://oss.test/e.zip': zip } })
    await assert.rejects(mk.marketInstall('m1'), (e) => e.message.startsWith('mobilemarket.unsafePath') && e.message.includes('../evil.js'))
    assert.equal(fs.files.size, 0)
  })

  await test('不是 zip(代理站回的 HTML)/ 超过下载上限 → 拒,原因按「主机: 原因」列出', async () => {
    const { mk } = market({ install: { h: { type: 'amadeus-plugin', installSlug: 'h', downloadUrl: 'https://oss.test/h' }, big: { type: 'amadeus-plugin', installSlug: 'big', downloadUrl: 'https://oss.test/big' } }, blobs: { 'https://oss.test/h': enc('<html>rate limited</html>'), 'https://oss.test/big': new Uint8Array(2048) }, maxZipBytes: 1024 })
    await assert.rejects(mk.marketInstall('h'), /^Error: oss\.test: not a zip$/)
    await assert.rejects(mk.marketInstall('big'), /^Error: oss\.test: too large$/)
  })

  await test('解压总量 / 条目数超上限(zip 炸弹)→ 拒,不落盘', async () => {
    const zip = await zipOf({ 'manifest.json': manifest({ id: 'bomb' }), 'big.txt': 'a'.repeat(50_000) })
    const a = market({ install: { b: { type: 'amadeus-plugin', installSlug: 'bomb', downloadUrl: 'https://oss.test/b' } }, blobs: { 'https://oss.test/b': zip }, maxUnpackedBytes: 10_000 })
    await assert.rejects(a.mk.marketInstall('b'), /mobilemarket\.tooLarge/)
    assert.equal(a.fs.files.size, 0)
    const b = market({ install: { b: { type: 'amadeus-plugin', installSlug: 'bomb', downloadUrl: 'https://oss.test/b' } }, blobs: { 'https://oss.test/b': zip }, maxEntries: 1 })
    await assert.rejects(b.mk.marketInstall('b'), /mobilemarket\.tooManyFiles/)
  })

  await test('非法 slug / 未知 type / 非 http 下载地址 → resolve: invalid target(不下载)', async () => {
    const { mk, downloaded } = market({ install: {
      s: { type: 'amadeus-plugin', installSlug: '../x', downloadUrl: 'https://oss.test/a' },
      t: { type: 'webapp', installSlug: 'ok', downloadUrl: 'https://oss.test/a' },
      u: { type: 'amadeus-plugin', installSlug: 'ok', downloadUrl: 'file:///etc/passwd' },
    } })
    for (const id of ['s', 't', 'u']) await assert.rejects(mk.marketInstall(id), /^Error: resolve: invalid target$/)
    await assert.rejects(mk.marketInstall('missing'), /^Error: resolve: HTTP 404$/)
    assert.equal(downloaded.length, 0)
  })

  await test('技能 / Agent / 主题 / Space:不下载就拒(手机装不了);引擎插件包(tangu-plugin.json)下载后纠偏出来也拒', async () => {
    const eng = await zipOf({ 'tangu-plugin.json': '{"id":"eng"}', 'dist/index.js': '' })
    const { mk, downloaded, fs } = market({ install: {
      sk: { type: 'skill', installSlug: 'sk', downloadUrl: 'https://oss.test/sk' },
      en: { type: 'amadeus-plugin', installSlug: 'en', downloadUrl: 'https://oss.test/en' },
    }, blobs: { 'https://oss.test/en': eng } })
    await assert.rejects(mk.marketInstall('sk'), /^Error: mobilemarket\.desktopOnlyType$/)
    assert.equal(downloaded.length, 0)
    await assert.rejects(mk.marketInstall('en'), /^Error: mobilemarket\.desktopOnlyType$/)
    assert.equal(fs.files.size, 0)
  })

  await test('isDesktopOnly:true → 拒装,且在动磁盘之前:已装的旧版原样保留', async () => {
    const { mk, fs } = market({ install: {
      v1: { type: 'amadeus-plugin', installSlug: 'same', downloadUrl: 'https://oss.test/v1' },
      v2: { type: 'amadeus-plugin', installSlug: 'same', downloadUrl: 'https://oss.test/v2' },
    }, blobs: {
      'https://oss.test/v1': await zipOf({ 'manifest.json': manifest({ id: 'same', version: '1.0.0' }), 'main.js': 'v1' }),
      'https://oss.test/v2': await zipOf({ 'manifest.json': manifest({ id: 'same', version: '2.0.0', isDesktopOnly: true }), 'main.js': 'v2' }),
    } })
    await mk.marketInstall('v1')
    await assert.rejects(mk.marketInstall('v2'), /^Error: mobilemarket\.desktopOnlyPlugin$/)
    assert.equal(dec(fs.files.get('plugins/same/main.js')), 'v1')
    assert.match(dec(fs.files.get('plugins/same/manifest.json')), /"1\.0\.0"/)
  })

  await test('manifest 缺 / 坏 / id 与 slug 皆非法 → badManifest;与内置插件同 id → builtin', async () => {
    const { mk } = market({ reserved: ['word-count'], install: {
      none: { type: 'amadeus-plugin', installSlug: 'none', downloadUrl: 'https://oss.test/none' },
      bad: { type: 'amadeus-plugin', installSlug: 'bad', downloadUrl: 'https://oss.test/bad' },
      wc: { type: 'amadeus-plugin', installSlug: 'my-wc', downloadUrl: 'https://oss.test/wc' },
    }, blobs: {
      'https://oss.test/none': await zipOf({ 'main.js': '' }),
      'https://oss.test/bad': await zipOf({ 'manifest.json': '[]', 'main.js': '' }),
      'https://oss.test/wc': await zipOf({ 'manifest.json': manifest({ id: 'word-count' }), 'main.js': '' }),
    } })
    await assert.rejects(mk.marketInstall('none'), /mobilemarket\.badManifest/)
    await assert.rejects(mk.marketInstall('bad'), /mobilemarket\.badManifest/)
    await assert.rejects(mk.marketInstall('wc'), /mobilemarket\.builtin/)
  })

  await test('integrity(SRI):对上 → 装;对不上 → 换下一个候选,全不对 = 拒;不认识的算法不当作通过', async () => {
    const zip = await zipOf({ 'manifest.json': manifest({ id: 'npm-ok' }), 'main.js': '' })
    const good = `sha512-${require('node:crypto').createHash('sha512').update(zip).digest('base64')}`
    assert.equal(await matchesIntegrity(zip, good), true)
    assert.equal(await matchesIntegrity(zip, 'sha1-AAAA'), false)
    const { mk } = market({ install: {
      ok: { type: 'amadeus-plugin', installSlug: 'npm-ok', downloadUrl: 'https://oss.test/z', integrity: good },
      bad: { type: 'amadeus-plugin', installSlug: 'npm-bad', downloadUrl: 'https://oss.test/z', integrity: `sha512-${Buffer.alloc(64).toString('base64')}` },
    }, blobs: { 'https://oss.test/z': zip } })
    assert.equal((await mk.marketInstall('ok')).ok, true)
    await assert.rejects(mk.marketInstall('bad'), /^Error: oss\.test: integrity mismatch$/)
  })

  await test('github 源 + 中国大陆镜像:按候选序逐个试(代理站在前、直连兜底),进度报出第几个', async () => {
    const zip = await zipOf({ 'manifest.json': manifest({ id: 'gh' }), 'main.js': '' })
    const direct = 'https://github.com/o/r/archive/HEAD.zip'
    const { mk, downloaded, progress } = market({ mirror: 'china', install: { g: { type: 'amadeus-plugin', installSlug: 'gh', downloadUrl: 'https://api.github.com/repos/o/r/zipball', source: 'github' } }, blobs: { [`https://ghproxy.net/${direct}`]: zip } })
    await mk.marketInstall('g')
    assert.deepEqual(downloaded, [`https://ghfast.top/${direct}`, `https://ghproxy.net/${direct}`])
    assert.deepEqual(progress.filter((p) => p.phase === 'download' && p.received === 0).map((p) => [p.attempt, p.attempts, p.host]), [[1, 4, 'ghfast.top'], [2, 4, 'ghproxy.net']])
  })

  await test('marketInstalled 形状同桌面(六类都有键)、marketUninstall:非法 type/slug 拒、没装报错、装了整目录删', async () => {
    const { mk, fs } = market()
    put(fs, 'plugins/x/manifest.json', manifest({ id: 'x', version: 'v3.1.0' })); put(fs, 'plugins/x/main.js', '')
    const inst = await mk.marketInstalled()
    assert.deepEqual(Object.keys(inst).sort(), ['agent', 'amadeus-plugin', 'plugin', 'skill', 'space', 'theme'])
    assert.deepEqual(inst['amadeus-plugin'], [{ slug: 'x', version: '3.1.0' }])
    await assert.rejects(mk.marketUninstall('skill', 'x'), /mobilemarket\.invalidTarget/)
    await assert.rejects(mk.marketUninstall('amadeus-plugin', '../x'), /mobilemarket\.invalidTarget/)
    await assert.rejects(mk.marketUninstall('amadeus-plugin', 'y'), /mobilemarket\.notInstalled/)
    assert.deepEqual(await mk.marketUninstall('amadeus-plugin', 'x'), { ok: true, path: 'plugins/x', type: 'amadeus-plugin' })
    assert.equal(fs.files.size, 0)
  })

  await test('浏览器 fetch 下载:HTTP 错误 / content-length 超限 / 流式超限 → 原因码;正常 → 完整字节', async () => {
    const body = (chunks) => new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(x); c.close() } })
    const dl = createFetchDownload(async (u) => {
      if (u.endsWith('/404')) return new Response('no', { status: 404 })
      if (u.endsWith('/cl')) return new Response(body([new Uint8Array(10)]), { headers: { 'content-length': '5000' } })
      if (u.endsWith('/stream')) return new Response(body([new Uint8Array(600), new Uint8Array(600)]))
      return new Response(body([enc('PK'), enc('\x03\x04rest')]))
    }, { connectMs: 200, stallMs: 200 })
    const opts = { maxBytes: 1000, onProgress: () => {} }
    await assert.rejects(dl('https://h/404', opts), /^Error: HTTP 404$/)
    await assert.rejects(dl('https://h/cl', opts), /^Error: too large$/)
    await assert.rejects(dl('https://h/stream', opts), /^Error: too large$/)
    assert.equal(dec(await dl('https://h/ok', opts)), 'PK\x03\x04rest')
  })

  const failed = results.filter((r) => !r[1]).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
