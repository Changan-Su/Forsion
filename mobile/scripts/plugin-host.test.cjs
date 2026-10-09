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

/** 被测模块打成**一个**包(同一份模块图,与 App 里一样):pluginHost 与 mobileMarket 共用 pluginFs 里的目录锁、
 *  同一个 UnpackLimitError 类 —— 各打各的包就成了两份互不相识的副本。 */
const loadAll = async (entries) => {
  const out = (await build({
    stdin: { contents: entries.map((e) => `export * from ${JSON.stringify(e)}`).join('\n'), resolveDir: __dirname, loader: 'ts' },
    bundle: true, write: false, logLevel: 'silent', platform: 'node', format: 'cjs',
  })).outputFiles[0].text
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', out)(mod, mod.exports, require)
  return mod.exports
}

/** 内存 PluginFs:路径 → 字节;目录由文件路径隐含(与 Capacitor 一样,列不存在的目录抛错)。
 *  failWriteAt:第 n 次写只写进一半就「被杀」(抛错),模拟写到一半进程没了。
 *  failRenameAt:第 n 次改名什么都没动就抛错。rename 的语义同 Android:目标已存在 → 抛错,绝不覆盖。 */
function memFs() {
  const files = new Map()
  let writes = 0
  let renames = 0
  const api = {
    files,
    failWriteAt: -1,
    failRenameAt: -1,
    renamed: [],
    async rename(from, to) {
      renames += 1
      if (renames === api.failRenameAt) throw new Error('rename killed')
      const keys = [...files.keys()]
      if (keys.some((k) => k.startsWith(`${to}/`))) throw new Error(`Destination directory exists: ${to}`)
      const moving = keys.filter((k) => k.startsWith(`${from}/`))
      if (!moving.length) throw new Error(`Folder does not exist: ${from}`)
      for (const k of moving) { files.set(`${to}/${k.slice(from.length + 1)}`, files.get(k)); files.delete(k) }
      api.renamed.push([from, to])
    },
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
/** 把中央目录里某个条目「声明的解压大小」改成谎报值(jszip 读包只认中央目录这一份)。 */
function lieAboutSize(bytes, entryName, declared) {
  const b = Buffer.from(bytes)
  let at = b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])), n = 0
  while (at >= 0) {
    const nameLen = b.readUInt16LE(at + 28)
    if (b.subarray(at + 46, at + 46 + nameLen).toString() === entryName) { b.writeUInt32LE(declared, at + 24); n++ }
    at = b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), at + 46)
  }
  assert.equal(n, 1, `central directory entry for ${entryName}`)
  return new Uint8Array(b)
}
/** 同长度换名:把字节里的占位名改成别的名字(CRC 只算内容,不算名)—— 造「原名」带穿越 / 绝对路径的条目。 */
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
  const {
    createPluginHost,
    createMobileMarket, createFetchDownload, createNativeDownload, isAllowedDownloadUrl, matchesIntegrity, MOBILE_MARKET_TYPES,
    countCentralHeaders, checkDeclaredSizes, declaredUnpackedSize, inflateCapped, unpackCapped, UnpackLimitError,
  } = await loadAll(['../src/plugins/pluginHost.ts', '../src/plugins/mobileMarket.ts', '../src/plugins/zipUnpack.ts'])
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

  // ── listSpaces(插件包里带的 Space 配方)─────────────────────────────────────
  await test('listSpaces:各插件 spaces/<slug>/space.json 原样给出,归属 = 插件的生效 id(目录名 ≠ id 也认);没带 Space 的插件不出条目', async () => {
    const fs = memFs()
    assert.deepEqual(await host(fs).listSpaces(), []) // 插件根还不存在
    put(fs, 'plugins/market-slug/manifest.json', manifest({ id: 'real-id' })); put(fs, 'plugins/market-slug/main.js', '')
    put(fs, 'plugins/market-slug/spaces/desk/space.json', '{"id":"desk"}')
    put(fs, 'plugins/market-slug/spaces/b-second/space.json', '{"id":"second"}')
    put(fs, 'plugins/market-slug/spaces/empty/readme.txt', 'no space.json here')
    put(fs, 'plugins/market-slug/spaces/.hidden/space.json', '{"id":"hidden"}')
    put(fs, 'plugins/market-slug/spaces/loose.json', '{"id":"not-in-a-folder"}')
    put(fs, 'plugins/plain/manifest.json', manifest({ id: 'plain' })); put(fs, 'plugins/plain/main.js', '')
    assert.deepEqual(await host(fs).listSpaces(), [
      { slug: 'b-second', json: '{"id":"second"}', plugin: 'real-id' },
      { slug: 'desk', json: '{"id":"desk"}', plugin: 'real-id' },
    ])
  })

  await test('listSpaces 图标:iconFile 先找 Space 自己的目录、再找插件包根;不合规 / 越界的名字 / 没写 → 没有 iconUrl,配方照给', async () => {
    const fs = memFs()
    const spec = (iconFile) => JSON.stringify({ id: 'x', icon: 'video', iconFile })
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>'
    put(fs, 'plugins/p/manifest.json', manifest({ id: 'p' })); put(fs, 'plugins/p/main.js', '')
    fs.files.set('plugins/p/icon.png', png(128, 128)) // 插件图标
    put(fs, 'plugins/p/spaces/root/space.json', spec('icon.png')) // 自己目录里没放图 → 用插件图标
    put(fs, 'plugins/p/spaces/own/space.json', spec('icon.png'))
    fs.files.set('plugins/p/spaces/own/icon.png', png(64, 64)) // 自己放了一枚 → 用自己的
    put(fs, 'plugins/p/spaces/vector/space.json', spec('mark.svg')); put(fs, 'plugins/p/spaces/vector/mark.svg', svg)
    put(fs, 'plugins/p/spaces/badown/space.json', spec('icon.png'))
    fs.files.set('plugins/p/spaces/badown/icon.png', png(128, 64)) // 自己那枚不合规 → 退到包根的
    put(fs, 'plugins/p/spaces/escape/space.json', spec('../../icon.png'))
    put(fs, 'plugins/p/spaces/notsvg/space.json', spec('fake.svg')); put(fs, 'plugins/p/spaces/notsvg/fake.svg', 'plain text')
    put(fs, 'plugins/p/spaces/none/space.json', '{"id":"none","icon":"video"}')
    const by = Object.fromEntries((await host(fs).listSpaces()).map((s) => [s.slug, s.iconUrl]))
    const url = (bytes) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
    assert.equal(by.root, url(png(128, 128)))
    assert.equal(by.own, url(png(64, 64)))
    assert.equal(by.badown, url(png(128, 128)))
    assert.equal(by.vector, `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
    assert.deepEqual([by.escape, by.notsvg, by.none], [undefined, undefined, undefined])
    assert.equal(Object.keys(by).length, 7)
  })

  await test('listSpaces:装不起来的插件(仅桌面 / apiVersion 不符 / 应用太旧)与坏 manifest 的目录不贡献 Space', async () => {
    const fs = memFs()
    const space = (dir) => put(fs, `plugins/${dir}/spaces/s/space.json`, `{"id":"${dir}-space"}`)
    put(fs, 'plugins/ok/manifest.json', manifest({ id: 'ok' })); space('ok')
    put(fs, 'plugins/desk/manifest.json', manifest({ id: 'desk', isDesktopOnly: true })); space('desk')
    put(fs, 'plugins/api2/manifest.json', manifest({ id: 'api2', apiVersion: 2 })); space('api2')
    put(fs, 'plugins/newer/manifest.json', manifest({ id: 'newer', minAppVersion: '99.0.0' })); space('newer')
    put(fs, 'plugins/broken/manifest.json', '{oops'); space('broken')
    put(fs, 'plugins/Bad_Dir/manifest.json', manifest({ id: 'NOPE' })); space('Bad_Dir')
    assert.deepEqual((await host(fs).listSpaces()).map((s) => s.plugin), ['ok'])
    // 宿主版本未知(Unreleased)时不按 0.0.0 误杀声明了 minAppVersion 的插件 —— 与 listPlugins 同口径
    assert.deepEqual((await host(fs, null).listSpaces()).map((s) => s.plugin), ['newer', 'ok'])
  })

  await test('listSpaces 坏包:超重的 space.json 不读、一个插件最多 16 个;同 id 两份只认前一份(它被拦下,后一份也不顶上来)', async () => {
    const fs = memFs()
    put(fs, 'plugins/big/manifest.json', manifest({ id: 'big' }))
    put(fs, 'plugins/big/spaces/fat/space.json', `{"id":"fat","pad":"${'x'.repeat(64 * 1024)}"}`) // > 64KB
    put(fs, 'plugins/big/spaces/slim/space.json', '{"id":"slim"}')
    put(fs, 'plugins/many/manifest.json', manifest({ id: 'many' }))
    for (let i = 0; i < 20; i++) put(fs, `plugins/many/spaces/s${String(i).padStart(2, '0')}/space.json`, `{"id":"s${i}"}`)
    // 目录按名排序:a-desk 在前。它声明仅桌面 → 整个 id 不贡献 Space,哪怕 b-phone 那份装得起来。
    put(fs, 'plugins/a-desk/manifest.json', manifest({ id: 'twin', isDesktopOnly: true })); put(fs, 'plugins/a-desk/spaces/s/space.json', '{"id":"from-a"}')
    put(fs, 'plugins/b-phone/manifest.json', manifest({ id: 'twin' })); put(fs, 'plugins/b-phone/spaces/s/space.json', '{"id":"from-b"}')
    // 两份都装得起来:只出前一份的
    put(fs, 'plugins/c-one/manifest.json', manifest({ id: 'pair' })); put(fs, 'plugins/c-one/spaces/s/space.json', '{"id":"from-c"}')
    put(fs, 'plugins/d-two/manifest.json', manifest({ id: 'pair' })); put(fs, 'plugins/d-two/spaces/s/space.json', '{"id":"from-d"}')
    const list = await host(fs).listSpaces()
    assert.deepEqual(list.filter((s) => s.plugin === 'big').map((s) => s.slug), ['slim'])
    assert.equal(list.filter((s) => s.plugin === 'many').length, 16)
    assert.deepEqual(list.filter((s) => s.plugin === 'twin'), [])
    assert.deepEqual(list.filter((s) => s.plugin === 'pair').map((s) => s.json), ['{"id":"from-c"}'])
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

  // ── fileExtensions(库这一层据此把插件文件排出笔记列表;真浏览器里的整条链在 scripts/plugin-filetypes.e2e.cjs) ──
  await test('fileExtensions:只读 manifest、不过任何闸 —— 被门禁拦下的 / 仅桌面的 / main.js 读不出来的插件照样算', async () => {
    const fs = memFs()
    put(fs, 'plugins/ok/manifest.json', manifest({ id: 'ok', fileExtensions: ['.Deck.MD'] })); put(fs, 'plugins/ok/main.js', '')
    put(fs, 'plugins/gated/manifest.json', manifest({ id: 'gated', apiVersion: 99, fileExtensions: ['.gated.md'] })); put(fs, 'plugins/gated/main.js', '')
    put(fs, 'plugins/old/manifest.json', manifest({ id: 'old', minAppVersion: '99.0.0', fileExtensions: ['.old.md'] })); put(fs, 'plugins/old/main.js', '')
    put(fs, 'plugins/desk/manifest.json', manifest({ id: 'desk', isDesktopOnly: true, fileExtensions: ['.desk.md'] }))
    put(fs, 'plugins/nomain/manifest.json', manifest({ id: 'nomain', fileExtensions: ['.nomain.md', '.bin'] }))
    const h = host(fs)
    assert.deepEqual(await h.fileExtensions(), ['.bin', '.deck.md', '.desk.md', '.gated.md', '.nomain.md', '.old.md'])
    // 防空过:这几个确实没在跑(listPlugins 把它们列成 blocked,或干脆不列)
    const listed = Object.fromEntries((await h.listPlugins()).map((p) => [p.id, p.blocked ?? 'ok']))
    assert.deepEqual(listed, { ok: 'ok', gated: 'api', old: 'minApp', desk: 'desktopOnly' })
  })

  await test('fileExtensions:只认专属后缀 —— 裸 .md / .txt、漏点的、非字符串一律不认(否则所有笔记都被排出列表)', async () => {
    const fs = memFs()
    put(fs, 'plugins/greedy/manifest.json', manifest({ id: 'greedy', fileExtensions: ['.md', '.markdown', '.txt', 'md', 'deck.md', '', 7, null, '.a b.md', '.fine.md'] }))
    put(fs, 'plugins/broken/manifest.json', '{not json')
    put(fs, 'plugins/none/manifest.json', manifest({ id: 'none', fileExtensions: 'x.md' }))
    assert.deepEqual(await host(fs).fileExtensions(), ['.fine.md'])
    assert.deepEqual(await host(memFs()).fileExtensions(), [])
  })

  await test('卸载之后后缀留下来(墓碑):两条卸载路径都记,重装再卸不丢别人的,墓碑不撞插件私有数据', async () => {
    const fs = memFs()
    const mk = createMobileMarket({ fs, cloudApiBase: () => 'https://c/api', fetch: async () => new Response('{}'), download: async () => enc(''), t: T })
    put(fs, 'plugins/a/manifest.json', manifest({ id: 'a', fileExtensions: ['.a.md'] })); put(fs, 'plugins/a/main.js', '')
    put(fs, 'plugins/b/manifest.json', manifest({ id: 'b', fileExtensions: ['.b.md'] })); put(fs, 'plugins/b/main.js', '')
    put(fs, 'plugins/c/manifest.json', manifest({ id: 'c' })); put(fs, 'plugins/c/main.js', '')
    const h = host(fs)
    await h.writePluginData('a', '{"keep":1}')
    await h.uninstallPlugin('a')                       // 设置页的卸载
    await mk.marketUninstall('amadeus-plugin', 'b')    // 商店的卸载
    await h.uninstallPlugin('c')                       // 没声明后缀的:不写墓碑
    assert.deepEqual(await h.listPlugins(), [])
    assert.deepEqual(await h.fileExtensions(), ['.a.md', '.b.md'])
    assert.equal(await h.readPluginData('a'), '{"keep":1}')
    // 进程重启(新建宿主)后还在;墓碑槽名不是合法插件 id,公开的读写接口够不着它
    assert.deepEqual(await host(fs).fileExtensions(), ['.a.md', '.b.md'])
    await assert.rejects(h.writePluginData('.ext-tombstones', '[]'), /invalid-plugin-id/)
  })

  await test('墓碑记不下来 → 不删插件(抛出去):宁可卸载失败,也不让它的文件掉回笔记列表', async () => {
    const fs = memFs()
    put(fs, 'plugins/a/manifest.json', manifest({ id: 'a', fileExtensions: ['.a.md'] })); put(fs, 'plugins/a/main.js', '')
    const h = host(fs)
    fs.failWriteAt = 1
    await assert.rejects(h.uninstallPlugin('a'), /killed/)
    assert.ok(fs.files.has('plugins/a/manifest.json'))
    assert.deepEqual(await h.fileExtensions(), ['.a.md'])
    // 写到一半的那一槽是坏的:下一次卸载照样记得下来(双槽,读取方跳过坏槽)
    await h.uninstallPlugin('a')
    assert.deepEqual(await h.fileExtensions(), ['.a.md'])
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
    // 新版先完整写进暂存目录(manifest 最后),再一次改名就位;正式目录里从不出现半截。
    assert.ok(order.every((p) => p.startsWith('plugins/.staging-hello-slug/')), `writes go to staging: ${order}`)
    assert.equal(order.at(-1), 'plugins/.staging-hello-slug/manifest.json')
    assert.deepEqual(fs.renamed, [['plugins/.staging-hello-slug', 'plugins/hello-slug']])
    assert.deepEqual([...new Set(progress.map((p) => p.phase))], ['resolve', 'download', 'install'])
    const [p] = await host(fs).listPlugins()
    assert.deepEqual([p.id, p.version, p.code], ['hello-mobile', '1.2.0', 'ctx'])
    assert.deepEqual((await mk.marketInstalled())['amadeus-plugin'], [{ slug: 'hello-slug', version: '1.2.0' }])
  })

  await test('覆盖安装 / 更新:旧 → 备份、暂存 → 正式、删备份;旧版多出来的文件不残留,暂存 / 备份目录不留', async () => {
    const { mk, fs } = market({ install: { m1: { type: 'amadeus-plugin', installSlug: 's', downloadUrl: 'https://oss.test/p.zip' } }, blobs: { 'https://oss.test/p.zip': await zipOf(PKG) } })
    put(fs, 'plugins/s/manifest.json', manifest({ id: 's', version: '0.9.0' })); put(fs, 'plugins/s/main.js', 'old'); put(fs, 'plugins/s/old-only.js', 'stale')
    await mk.marketInstall('m1')
    assert.deepEqual(fs.renamed, [['plugins/s', 'plugins/.backup-s'], ['plugins/.staging-s', 'plugins/s']])
    assert.deepEqual([...fs.files.keys()].sort(), ['plugins/s/README.md', 'plugins/s/main.js', 'plugins/s/manifest.json'])
    assert.equal(dec(fs.files.get('plugins/s/main.js')), 'ctx')
  })

  // ── 更新不毁旧版(评审 2026-10-02:此前是「先删旧目录再逐个写」,写到一半失败 = 能用的插件没了)────────────
  const V1 = { 'manifest.json': manifest({ id: 'keep', version: '1.0.0' }), 'main.js': 'v1', 'lib/a.js': 'a1' }
  const V2 = { 'manifest.json': manifest({ id: 'keep', version: '2.0.0' }), 'main.js': 'v2', 'lib/a.js': 'a2', 'lib/b.js': 'b2' }
  const keepMarket = async (extra = {}) => market({ install: {
    v1: { type: 'amadeus-plugin', installSlug: 'keep', downloadUrl: 'https://oss.test/v1' },
    v2: { type: 'amadeus-plugin', installSlug: 'keep', downloadUrl: 'https://oss.test/v2' },
  }, blobs: { 'https://oss.test/v1': await zipOf(V1), 'https://oss.test/v2': await zipOf(V2), ...extra } })
  const loaded = async (fs) => (await host(fs).listPlugins()).map((p) => [p.id, p.version, p.code])
  const strays = (fs) => [...fs.files.keys()].filter((k) => /^plugins\/\.(staging|backup)-/.test(k))

  await test('更新写到一半失败(磁盘满 / 被杀):旧版一个字节没动、照常加载;暂存目录被清掉;之后重装成功', async () => {
    const { mk, fs } = await keepMarket()
    await mk.marketInstall('v1')
    const before = new Map(fs.files)
    fs.failWriteAt = 3 + 2 // v1 写了 3 次;v2 的第 2 次写只写进一半就抛
    await assert.rejects(mk.marketInstall('v2'), /killed/)
    assert.deepEqual([...fs.files], [...before], 'old version untouched, nothing left behind')
    assert.deepEqual(await loaded(fs), [['keep', '1.0.0', 'v1']])
    await mk.marketInstall('v2')
    assert.deepEqual(await loaded(fs), [['keep', '2.0.0', 'v2']])
    assert.deepEqual(strays(fs), [])
  })

  await test('更新写到一半进程被杀(连清理都没跑):残留的暂存目录不被当成插件,下次清点时删掉,旧版照常加载', async () => {
    const { mk, fs } = await keepMarket()
    await mk.marketInstall('v1')
    put(fs, 'plugins/.staging-keep/main.js', 'v2-half') // 被杀时暂存目录里只有半截(manifest 还没写)
    put(fs, 'plugins/.staging-keep/lib/a.js', 'a2')
    assert.deepEqual((await mk.marketInstalled())['amadeus-plugin'], [{ slug: 'keep', version: '1.0.0' }])
    assert.deepEqual(await loaded(fs), [['keep', '1.0.0', 'v1']])
    assert.deepEqual(strays(fs), [])
  })

  await test('切换时改名失败:当场把旧版挪回去,旧版照常加载(两处改名各试一次)', async () => {
    for (const failAt of [1, 2]) { // 1 = 旧 → 备份 失败;2 = 暂存 → 正式 失败(此刻旧版已在备份里)
      const { mk, fs } = await keepMarket()
      await mk.marketInstall('v1') // 全新安装只改名一次(暂存 → 正式)
      fs.failRenameAt = 1 + failAt
      await assert.rejects(mk.marketInstall('v2'), /rename killed/)
      assert.deepEqual(await loaded(fs), [['keep', '1.0.0', 'v1']], `failAt=${failAt}`)
      assert.equal(dec(fs.files.get('plugins/keep/lib/a.js')), 'a1')
      assert.deepEqual(strays(fs), [], `failAt=${failAt}`)
    }
  })

  await test('切换中途进程被杀 → 下次清点 / 安装时恢复:备份在而正式目录不在 = 旧版挪回;暂存 / 备份目录从不被列成插件', async () => {
    // 现场 A:旧版刚挪进备份就被杀(新版还在暂存里,正式目录不存在)。
    const a = memFs()
    for (const [rel, text] of Object.entries(V1)) put(a, `plugins/.backup-keep/${rel}`, text)
    for (const [rel, text] of Object.entries(V2)) put(a, `plugins/.staging-keep/${rel}`, text)
    assert.deepEqual(await loaded(a), [['keep', '1.0.0', 'v1']])
    assert.deepEqual([...a.files.keys()].sort(), ['plugins/keep/lib/a.js', 'plugins/keep/main.js', 'plugins/keep/manifest.json'])
    // 现场 B:「暂存 → 正式」走的是复制 + 删源的非原子分支且没走完(正式目录半截、暂存还在)→ 丢掉半截,旧版挪回。
    const b = memFs()
    for (const [rel, text] of Object.entries(V1)) put(b, `plugins/.backup-keep/${rel}`, text)
    put(b, 'plugins/keep/manifest.json', V2['manifest.json']) // 半截新版:有 manifest、没有 main
    put(b, 'plugins/.staging-keep/main.js', 'v2'); put(b, 'plugins/.staging-keep/lib/a.js', 'a2')
    assert.deepEqual(await loaded(b), [['keep', '1.0.0', 'v1']])
    assert.deepEqual(strays(b), [])
    // 现场 C:切换已完成,只差删备份(暂存已不在)→ 保留新版,删掉备份。
    const c = memFs()
    for (const [rel, text] of Object.entries(V1)) put(c, `plugins/.backup-keep/${rel}`, text)
    for (const [rel, text] of Object.entries(V2)) put(c, `plugins/keep/${rel}`, text)
    assert.deepEqual(await loaded(c), [['keep', '2.0.0', 'v2']])
    assert.deepEqual(strays(c), [])
    // 恢复也发生在「安装」入口(不只清点):现场 A 上直接装别的插件,旧版同样被挪回。
    const d = memFs()
    for (const [rel, text] of Object.entries(V1)) put(d, `plugins/.backup-keep/${rel}`, text)
    const other = market({ fs: d, install: { o: { type: 'amadeus-plugin', installSlug: 'other', downloadUrl: 'https://oss.test/o' } }, blobs: { 'https://oss.test/o': await zipOf({ 'manifest.json': manifest({ id: 'other' }), 'main.js': 'o' }) } })
    await other.mk.marketInstall('o')
    assert.deepEqual((await loaded(d)).map((p) => p[0]), ['keep', 'other'])
    // 名字不是「前缀 + 合法 slug」的点目录不是我们的,不动。
    const e = memFs()
    put(e, 'plugins/.backup-Not A Slug/x', '1'); put(e, 'plugins/.keepme/x', '1')
    assert.deepEqual(await loaded(e), [])
    assert.equal(e.files.size, 2)
  })

  await test('入口文件不在包里(缺 main.js / manifest.main 指向不存在的文件 / main 越界)→ 拒装,一个字节不写,旧版原样', async () => {
    const { mk, fs } = await keepMarket()
    const target = (name) => ({ type: 'amadeus-plugin', installSlug: 'keep', downloadUrl: `https://oss.test/${name}` })
    const bad = market({ fs, install: { nomain: target('nomain'), wrongmain: target('wrongmain'), escape: target('escape') }, blobs: {
      'https://oss.test/nomain': await zipOf({ 'manifest.json': manifest({ id: 'keep', version: '3.0.0' }), 'README.md': '# no code' }),
      'https://oss.test/wrongmain': await zipOf({ 'manifest.json': manifest({ id: 'keep', version: '3.0.0', main: 'dist/index.js' }), 'main.js': 'x' }),
      'https://oss.test/escape': await zipOf({ 'manifest.json': manifest({ id: 'keep', version: '3.0.0', main: '../keep/main.js' }), 'main.js': 'x' }),
    } })
    // 全新安装:什么都不写。
    await assert.rejects(bad.mk.marketInstall('nomain'), (e) => e.message === 'mobilemarket.noMain:{"path":"main.js"}')
    assert.equal(fs.files.size, 0)
    // 已装旧版:旧版原样。
    await mk.marketInstall('v1')
    const before = new Map(fs.files)
    await assert.rejects(bad.mk.marketInstall('nomain'), /mobilemarket\.noMain/)
    await assert.rejects(bad.mk.marketInstall('wrongmain'), (e) => e.message === 'mobilemarket.noMain:{"path":"dist/index.js"}')
    await assert.rejects(bad.mk.marketInstall('escape'), /mobilemarket\.noMain/)
    assert.deepEqual([...fs.files], [...before])
    assert.deepEqual(await loaded(fs), [['keep', '1.0.0', 'v1']])
  })

  await test('清点 / 卸载与进行中的安装不交错:安装落盘期间发起的 listPlugins 等它切换完,看到的是完整的新版', async () => {
    const { mk, fs } = await keepMarket()
    await mk.marketInstall('v1')
    const w = fs.writeBytes
    let listing
    fs.writeBytes = async (p, b) => {
      if (!listing && p.startsWith('plugins/.staging-keep/')) listing = host(fs).listPlugins() // 落盘刚开始就来清点
      await new Promise((r) => setTimeout(r, 1))
      return w(p, b)
    }
    await mk.marketInstall('v2')
    assert.deepEqual((await listing).map((p) => [p.id, p.version, p.code]), [['keep', '2.0.0', 'v2']])
    assert.deepEqual(strays(fs), [])
  })

  await test('穿越条目 → 整包拒、一个字节都不落盘', async () => {
    const zip = renameInZip(await zipOf({ 'manifest.json': manifest({ id: 'evil' }), 'zz/evil.js': 'x' }), 'zz/evil.js', '../evil.js')
    const { mk, fs } = market({ install: { m1: { type: 'amadeus-plugin', installSlug: 'evil', downloadUrl: 'https://oss.test/e.zip' } }, blobs: { 'https://oss.test/e.zip': zip } })
    await assert.rejects(mk.marketInstall('m1'), (e) => e.message.startsWith('mobilemarket.unsafePath') && e.message.includes('../evil.js'))
    assert.equal(fs.files.size, 0)
  })

  await test('绝对路径条目(/main.js、\\\\host\\share、盘符)→ 整包拒,不剥成相对路径照装(否则能顶替包里真正的入口文件)', async () => {
    const base = { 'manifest.json': manifest({ id: 'abs' }), 'main.js': 'real' }
    const cases = [
      ['qmain.js', '/main.js'],
      ['qq/zz/aa/main.js', '\\\\h\\s\\main.js'.padEnd(16, '!').slice(0, 16)],
      ['q/x/main.js', 'C:\\x\\main.j'],
    ]
    for (const [placeholder, evil] of cases) {
      const zip = renameInZip(await zipOf({ ...base, [placeholder]: 'evil' }), placeholder, evil)
      const { mk, fs } = market({ install: { m1: { type: 'amadeus-plugin', installSlug: 'abs', downloadUrl: 'https://oss.test/a.zip' } }, blobs: { 'https://oss.test/a.zip': zip } })
      await assert.rejects(mk.marketInstall('m1'), (e) => e.message.startsWith('mobilemarket.unsafePath') && e.message.includes(JSON.stringify(evil).slice(1, -1)), evil)
      assert.equal(fs.files.size, 0, evil)
    }
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

  // ── 解压容量闸(zipUnpack.ts;评审 2026-10-02:此前 async('uint8array') 把整条解进内存之后才量)──────────────
  const deflated = async (entries) => { const z = new JSZip(); for (const [n, c] of Object.entries(entries)) z.file(n, c); return new Uint8Array(await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 } })) }
  /** 流式解压实际吐了多少字节(包住条目的 internalStream 计数)。 */
  const meter = (file) => {
    const real = file.internalStream.bind(file)
    const m = { bytes: 0 }
    file.internalStream = (type) => { const st = real(type); const on = st.on.bind(st); st.on = (ev, cb) => on(ev, ev === 'data' ? (chunk, meta) => { m.bytes += chunk.length; cb(chunk, meta) } : cb); return st }
    return m
  }

  await test('声明大小闸:单条 / 累计超限在**解压之前**就拒(一个字节都没解)', async () => {
    const zip = await JSZip.loadAsync(await deflated({ 'a.bin': new Uint8Array(40_000), 'b.bin': new Uint8Array(40_000), 'c.txt': 'tiny' }))
    assert.equal(declaredUnpackedSize(zip.files['a.bin']), 40_000)
    const files = ['a.bin', 'b.bin', 'c.txt'].map((n) => zip.files[n])
    const meters = files.map(meter)
    assert.throws(() => checkDeclaredSizes([zip.files['a.bin']], 39_999), UnpackLimitError) // 单条
    assert.throws(() => checkDeclaredSizes(files, 79_999), UnpackLimitError) // 累计
    checkDeclaredSizes(files, 80_004) // 恰好够
    await assert.rejects(unpackCapped(zip, files.map((f) => ({ name: f.name })), 79_999), UnpackLimitError)
    assert.deepEqual(meters.map((m) => m.bytes), [0, 0, 0], 'rejected on declared sizes: nothing was inflated')
  })

  // 64 MB 的零压成 ~64 KB。jszip 每拍喂 16 KB 压缩数据(≈ 16 MB 解压量,分 16 KB 小块同步吐出):超限后那一拍剩下的
  // 小块被丢弃、下一拍不再排 —— 所以「停得早」= 实际流过的字节远小于整条,且任何时刻持有的都不超过上限。
  const BOMB = 64 * 1024 * 1024
  const bombZip = await deflated({ 'manifest.json': manifest({ id: 'liar' }), 'main.js': 'ctx', 'bomb.bin': new Uint8Array(BOMB) })

  await test('流式封顶:高压缩比的大条目读到上限就停(不是整条解完再量);上限内的照常解出完整字节', async () => {
    assert.ok(bombZip.length < 200_000, `64 MB of zeros compresses to ${bombZip.length} bytes`)
    const zip = await JSZip.loadAsync(bombZip)
    const m = meter(zip.files['bomb.bin'])
    await assert.rejects(inflateCapped(zip.files['bomb.bin'], 100_000), UnpackLimitError)
    await new Promise((r) => setTimeout(r, 50)) // 给「下一拍」留出时间:暂停后它不该再来
    assert.ok(m.bytes > 100_000 && m.bytes < BOMB / 2, `stopped early: ${m.bytes} of ${BOMB} bytes went through the inflater`)
    const small = await JSZip.loadAsync(await deflated({ 'ok.bin': new Uint8Array(300_000).fill(7) }))
    const whole = await inflateCapped(small.files['ok.bin'], 300_000) // 恰好等于上限 = 不超
    assert.equal(whole.length, 300_000)
    assert.ok(whole.every((x) => x === 7))
    await assert.rejects(inflateCapped(small.files['ok.bin'], 299_999), UnpackLimitError)
  })

  await test('声明大小撒谎(中央目录写 12 字节、实际解出 64 MB)→ 过得了声明闸,被流式封顶拦下;安装拒收、不落盘', async () => {
    const lying = lieAboutSize(bombZip, 'bomb.bin', 12)
    const zip = await JSZip.loadAsync(lying)
    assert.equal(declaredUnpackedSize(zip.files['bomb.bin']), 12)
    const plan = Object.keys(zip.files).map((name) => ({ name }))
    checkDeclaredSizes(plan.map((p) => zip.files[p.name]), 1_000_000) // 声明值骗过了前置闸
    const m = meter(zip.files['bomb.bin'])
    await assert.rejects(unpackCapped(zip, plan, 1_000_000), UnpackLimitError)
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(m.bytes < BOMB / 2, `stopped early: ${m.bytes} of ${BOMB} bytes went through the inflater`)
    const install = { b: { type: 'amadeus-plugin', installSlug: 'liar', downloadUrl: 'https://oss.test/b' } }
    const a = market({ install, blobs: { 'https://oss.test/b': lying }, maxUnpackedBytes: 1_000_000 })
    await assert.rejects(a.mk.marketInstall('b'), /mobilemarket\.tooLarge/)
    assert.equal(a.fs.files.size, 0)
    // 没撒谎的同一个包:声明闸直接拒(缺省上限 64 MB,包里一共 64 MB + 两个小文件)。
    const honest = market({ install, blobs: { 'https://oss.test/b': bombZip } })
    await assert.rejects(honest.mk.marketInstall('b'), /mobilemarket\.tooLarge/)
    // 谎报但没超限(写 12、实际 5000):大小对不上 = 包坏了,同样不装。
    const small = lieAboutSize(await deflated({ 'manifest.json': manifest({ id: 'liar' }), 'main.js': 'ctx', 'x.bin': new Uint8Array(5000) }), 'x.bin', 12)
    const c = market({ install, blobs: { 'https://oss.test/b': small } })
    await assert.rejects(c.mk.marketInstall('b'), /mobilemarket\.badArchive/)
    assert.equal(c.fs.files.size, 0)
  })

  await test('条目数在解析之前就数(中央目录文件头签名):超限的包不交给 jszip 解析', async () => {
    const entries = { 'manifest.json': manifest({ id: 'many' }), 'main.js': '' }
    for (let i = 0; i < 40; i++) entries[`f/${i}.txt`] = String(i)
    const zip = await zipOf(entries)
    assert.equal(countCentralHeaders(zip, 1000), 43) // 42 个文件 + jszip 生成的目录条目 f/
    assert.equal(countCentralHeaders(zip, 10), 11, 'stops counting at limit + 1')
    assert.equal(countCentralHeaders(enc('not a zip'), 10), 0)
    const loads = []
    const realLoad = JSZip.loadAsync
    JSZip.loadAsync = function (...a) { loads.push(1); return realLoad.apply(this, a) }
    try {
      const { mk } = market({ install: { m: { type: 'amadeus-plugin', installSlug: 'many', downloadUrl: 'https://oss.test/m' } }, blobs: { 'https://oss.test/m': zip }, maxEntries: 20 })
      await assert.rejects(mk.marketInstall('m'), /mobilemarket\.tooManyFiles/)
    } finally { JSZip.loadAsync = realLoad }
  })

  await test('非法 slug / 未知 type / 非 https 下载地址(file: / http: / content: …)→ resolve: invalid target(不下载)', async () => {
    const urls = { u1: 'file:///etc/passwd', u2: 'http://oss.test/a.zip', u3: 'content://media/external/file/1', u4: 'http://localhost:5317/a.zip', u5: 'https://user:pw@oss.test/a.zip', u6: 'ftp://oss.test/a.zip', u7: '//oss.test/a.zip', u8: 'javascript:alert(1)' }
    const { mk, downloaded } = market({ install: {
      s: { type: 'amadeus-plugin', installSlug: '../x', downloadUrl: 'https://oss.test/a' },
      t: { type: 'webapp', installSlug: 'ok', downloadUrl: 'https://oss.test/a' },
      ...Object.fromEntries(Object.entries(urls).map(([id, downloadUrl]) => [id, { type: 'amadeus-plugin', installSlug: 'ok', downloadUrl }])),
    }, blobs: Object.fromEntries(Object.values(urls).map((u) => [u, new Uint8Array(8)])) })
    for (const id of ['s', 't', ...Object.keys(urls)]) await assert.rejects(mk.marketInstall(id), /^Error: resolve: invalid target$/, id)
    await assert.rejects(mk.marketInstall('missing'), /^Error: resolve: HTTP 404$/)
    assert.equal(downloaded.length, 0)
    for (const u of Object.values(urls)) assert.equal(isAllowedDownloadUrl(u), false, u)
    assert.equal(isAllowedDownloadUrl('https://oss.test/a.zip'), true)
    assert.equal(isAllowedDownloadUrl('HTTPS://OSS.test/a.zip'), true)
  })

  await test('debug 包的回环明文放行:只有 localhost / 127.0.0.1 / 10.0.2.2 的 http,其余照拒;缺省不放行', async () => {
    for (const ok of ['http://localhost:5317/p.zip', 'http://127.0.0.1:5317/p.zip', 'http://10.0.2.2/p.zip', 'https://oss.test/p.zip']) assert.equal(isAllowedDownloadUrl(ok, true), true, ok)
    for (const bad of ['http://oss.test/p.zip', 'http://192.168.1.2/p.zip', 'http://localhost.evil.test/p.zip', 'file:///x', 'content://x/y']) assert.equal(isAllowedDownloadUrl(bad, true), false, bad)
    const zip = await zipOf({ 'manifest.json': manifest({ id: 'dbg' }), 'main.js': '' })
    const install = { d: { type: 'amadeus-plugin', installSlug: 'dbg', downloadUrl: 'http://localhost:5317/p.zip' } }
    const blobs = { 'http://localhost:5317/p.zip': zip }
    await assert.rejects(market({ install, blobs }).mk.marketInstall('d'), /^Error: resolve: invalid target$/)
    assert.equal((await market({ install, blobs, allowLoopbackHttp: true }).mk.marketInstall('d')).ok, true)
  })

  await test('原生封顶下载的 JS 半身:进度只认自己的 id;成功 / 读失败都删临时文件;原生拒了就原样报原因码', async () => {
    const calls = []
    let listener
    const io = (over = {}) => ({
      download: async (o) => { calls.push(['download', o.url, o.maxBytes]); listener({ id: 'someone-else', received: 1, total: 9 }); listener({ id: o.id, received: 4, total: -1 }); listener({ id: o.id, received: 6, total: 6 }); return { name: 'forsion-market-x.zip', size: 6 } },
      onProgress: async (cb) => { listener = cb; return () => calls.push(['unsubscribe']) },
      read: async (name) => { calls.push(['read', name]); return enc('PK\x03\x04ab') },
      discard: async (name) => { calls.push(['discard', name]) },
      ...over,
    })
    const seen = []
    const opts = { maxBytes: 100, onProgress: (r, t) => seen.push([r, t]) }
    assert.equal(dec(await createNativeDownload(io())('https://h/p.zip', opts)), 'PK\x03\x04ab')
    assert.deepEqual(seen, [[4, null], [6, 6]])
    assert.deepEqual(calls, [['download', 'https://h/p.zip', 100], ['read', 'forsion-market-x.zip'], ['unsubscribe'], ['discard', 'forsion-market-x.zip']])
    calls.length = 0
    await assert.rejects(createNativeDownload(io({ read: async () => { throw new Error('read failed') } }))('https://h/p.zip', opts), /^Error: read failed$/)
    assert.deepEqual(calls, [['download', 'https://h/p.zip', 100], ['unsubscribe'], ['discard', 'forsion-market-x.zip']])
    calls.length = 0
    for (const [native, shown] of [['too large', 'too large'], ['HTTP 404', 'HTTP 404'], ['stalled', 'stalled'], ['insecure redirect', 'insecure redirect'], ['Read timed out', 'timeout']]) {
      await assert.rejects(createNativeDownload(io({ download: async () => { throw new Error(native) } }))('https://h/p.zip', opts), new RegExp(`^Error: ${shown}$`))
    }
    assert.ok(!calls.some((c) => c[0] === 'discard' || c[0] === 'read'), 'native side already deleted the partial file')
    // 原生层报的大小超限(不该发生)也不读进内存。
    calls.length = 0
    await assert.rejects(createNativeDownload(io({ download: async () => ({ name: 'forsion-market-y.zip', size: 101 }) }))('https://h/p.zip', opts), /^Error: too large$/)
    assert.deepEqual(calls, [['unsubscribe'], ['discard', 'forsion-market-y.zip']])
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
