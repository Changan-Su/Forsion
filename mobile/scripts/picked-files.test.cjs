/**
 * 系统文件选择器的 JS 半身(src/pickedFiles.ts)单测 —— `npm run test:pickedfiles`(mobile 目录,不用先 build)。
 * 原生只回 { uri, name, type, size };这里用假的 fetch(流式响应体)验证:字节不过桥、逐个流式取、上限按**实际到手**的字节卡、
 * 超限当场停读、被拒的都进 skipped。原生半身的筛选(按提供方报告的大小)在 JVM 单测 FilePickPlanTest。
 * 真机上「content:// 经 _capacitor_content_ 取回」这一段只能在设备上验,见 pickedFiles.ts 头注释与交付说明。
 */
const assert = require('node:assert/strict')
const path = require('node:path')
const { build } = require('esbuild')

const load = async (entry) => {
  const out = (await build({
    entryPoints: [path.resolve(__dirname, entry)],
    bundle: true, write: false, logLevel: 'silent', platform: 'node', format: 'cjs',
  })).outputFiles[0].text
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', out)(mod, mod.exports, require)
  return mod.exports
}

/** 假本地服务器:uri → 字节 / 'missing' / 'throw';响应体分 chunk 字节一块地流出,记下实际被读走了多少。 */
function fakeServer(docs, chunk = 1000) {
  const log = { urls: [], served: {}, cancelled: [], active: 0, maxActive: 0 }
  return {
    log,
    toUrl: (uri) => uri.replace('content:/', 'https://localhost/_capacitor_content_'),
    fetch: async (url) => {
      log.urls.push(url)
      const uri = url.replace('https://localhost/_capacitor_content_', 'content:/')
      const body = docs[uri]
      if (body === 'throw') throw new TypeError('Failed to fetch')
      if (body === undefined || body === 'missing') return new Response('', { status: 404 })
      let off = 0
      log.active += 1
      log.maxActive = Math.max(log.maxActive, log.active)
      log.served[uri] = 0
      return new Response(new ReadableStream({
        pull(c) {
          if (off >= body.length) { log.active -= 1; c.close(); return }
          const piece = body.subarray(off, off + chunk)
          off += piece.length
          log.served[uri] += piece.length
          c.enqueue(piece)
        },
        cancel() { log.active -= 1; log.cancelled.push(uri) },
      }, { highWaterMark: 0 }))
    },
  }
}
const bytes = (n, fill) => new Uint8Array(n).fill(fill)

const results = []
const test = async (name, fn) => {
  try { await fn(); results.push([name, true]); console.log(`PASS  ${name}`) }
  catch (e) { results.push([name, false]); console.log(`FAIL  ${name}\n      ${e && e.stack ? e.stack.split('\n').slice(0, 12).join('\n      ') : e}`) }
}

;(async () => {
  const { loadPickedFiles, staysInItsProvider, PICK_MAX_FILES, PICK_MAX_FILE_BYTES, PICK_MAX_TOTAL_BYTES } = await load('../src/pickedFiles.ts')

  await test('上限与原生 FilePickPlan.kt 同值(20 个 / 单个 25 MB / 合计 60 MB)', async () => {
    assert.deepEqual([PICK_MAX_FILES, PICK_MAX_FILE_BYTES, PICK_MAX_TOTAL_BYTES], [20, 25 * 1024 * 1024, 60 * 1024 * 1024])
  })

  await test('逐个流式取回:地址经 toUrl 换算,名字 / 类型用原生给的,字节完整,一次只开一个流', async () => {
    const s = fakeServer({ 'content://docs/document/a%3A1': bytes(2500, 1), 'content://docs/document/b': bytes(10, 2) })
    const out = await loadPickedFiles([
      { uri: 'content://docs/document/a%3A1', name: 'a.pdf', type: 'application/pdf', size: 2500 },
      { uri: 'content://docs/document/b', name: 'b.bin', type: '', size: -1 }, // 提供方没报大小
    ], s)
    assert.deepEqual(s.log.urls, ['https://localhost/_capacitor_content_/docs/document/a%3A1', 'https://localhost/_capacitor_content_/docs/document/b'])
    assert.deepEqual(out.files.map((f) => [f.name, f.type, f.size]), [['a.pdf', 'application/pdf', 2500], ['b.bin', '', 10]])
    assert.deepEqual([...new Uint8Array(await out.files[0].arrayBuffer())], [...bytes(2500, 1)])
    assert.deepEqual(out.skipped, [])
    assert.equal(s.log.maxActive, 1)
  })

  await test('报告的大小超限 → 不取就拒;报告值缺席 / 偏小 → 边读边数,超了当场停读(不是整个读进来再量)', async () => {
    const s = fakeServer({
      'content://p/huge-known': bytes(50_000, 1),
      'content://p/huge-unknown': bytes(50_000, 2),
      'content://p/liar': bytes(50_000, 3),
      'content://p/ok': bytes(4_000, 4),
    })
    const out = await loadPickedFiles([
      { uri: 'content://p/huge-known', name: 'known.bin', size: 50_000 },
      { uri: 'content://p/huge-unknown', name: 'unknown.bin' },
      { uri: 'content://p/liar', name: 'liar.bin', size: 100 }, // 报 100 字节,实际 5 万
      { uri: 'content://p/ok', name: 'ok.bin', size: 4_000 },
    ], { ...s, limits: { maxFileBytes: 5_000 } })
    assert.deepEqual(out.files.map((f) => [f.name, f.size]), [['ok.bin', 4_000]])
    assert.deepEqual(out.skipped, ['known.bin', 'unknown.bin', 'liar.bin'])
    assert.ok(!s.log.urls.some((u) => u.endsWith('huge-known')), 'a file over the cap by its reported size is never fetched')
    for (const uri of ['content://p/huge-unknown', 'content://p/liar']) {
      assert.ok(s.log.served[uri] <= 7_000, `${uri}: stopped reading at the cap (served ${s.log.served[uri]} of 50000)`)
      assert.ok(s.log.cancelled.includes(uri), `${uri}: stream cancelled`)
    }
  })

  await test('合计上限按实际字节累计(保持选择顺序);数量上限;恰好等于上限不算超', async () => {
    const docs = {}
    for (const n of ['a', 'b', 'c', 'd']) docs[`content://p/${n}`] = bytes(4_000, 1)
    docs['content://p/small'] = bytes(2_000, 1)
    const s = fakeServer(docs)
    const out = await loadPickedFiles([
      { uri: 'content://p/a', name: 'a', size: 4_000 }, { uri: 'content://p/b', name: 'b' },
      { uri: 'content://p/c', name: 'c' }, // 8000 + 4000 > 10000 → 拒(读到剩余额度即停)
      { uri: 'content://p/small', name: 'small', size: 2_000 }, // 恰好填满
      { uri: 'content://p/d', name: 'd', size: 1 }, // 额度已用完
    ], { ...s, limits: { maxFileBytes: 4_000, maxTotalBytes: 10_000 } })
    assert.deepEqual(out.files.map((f) => f.name), ['a', 'b', 'small'])
    assert.deepEqual(out.skipped, ['c', 'd'])
    assert.ok(s.log.served['content://p/c'] <= 3_000)
    const many = fakeServer(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`content://p/${i}`, bytes(1, 1)])))
    const capped = await loadPickedFiles(Array.from({ length: 5 }, (_, i) => ({ uri: `content://p/${i}`, name: `f${i}`, size: 1 })), { ...many, limits: { maxFiles: 3 } })
    assert.deepEqual([capped.files.map((f) => f.name), capped.skipped], [['f0', 'f1', 'f2'], ['f3', 'f4']])
    assert.equal(many.log.urls.length, 3)
  })

  await test('读不了的文件(404:授权失效 / 提供方打不开;fetch 抛错)→ 进 skipped,其余照常', async () => {
    const s = fakeServer({ 'content://p/gone': 'missing', 'content://p/boom': 'throw', 'content://p/ok': bytes(3, 9) })
    const out = await loadPickedFiles([
      { uri: 'content://p/gone', name: 'gone.txt', size: 3 }, { uri: 'content://p/boom', name: 'boom.txt' }, { uri: 'content://p/ok', name: 'ok.txt', type: 'text/plain' },
    ], s)
    assert.deepEqual([out.files.map((f) => f.name), out.skipped], [['ok.txt'], ['gone.txt', 'boom.txt']])
  })

  await test('原生回的值逐项校验:非 content:// 地址、缺字段、非数组 → 忽略,绝不拿去 fetch', async () => {
    const s = fakeServer({ 'content://p/ok': bytes(1, 1) })
    const out = await loadPickedFiles([
      { uri: 'file:///data/data/com.forsion.tangu/shared_prefs/x.xml', name: 'prefs' },
      { uri: 'https://evil.test/x', name: 'remote' },
      { uri: 'content://p/ok' }, { name: 'no-uri' }, null, 'content://p/ok', 7,
      { uri: 'content://p/ok', name: 'ok', type: 42 },
    ], s)
    assert.deepEqual(out.files.map((f) => [f.name, f.type]), [['ok', '']])
    assert.deepEqual(s.log.urls, ['https://localhost/_capacitor_content_/p/ok'])
    for (const junk of [undefined, null, {}, 'x']) assert.deepEqual(await loadPickedFiles(junk, s), { files: [], skipped: [] })
  })

  await test('规范化后会离开自己提供方的地址(.. / %2e%2e / 反斜杠 / authority 本身是 ..)→ 进 skipped,而且根本不发请求', async () => {
    // 这些地址来自别的 App(「分享到 Forsion」)。toUrl 只换协议头,浏览器发请求前会消掉点段:
    // 不拦的话前四条发出去就是本地服务器的裸文件路由 /_capacitor_file_/…(本应用的私有文件),第五条是别的提供方。
    const pkg = 'com.forsion.tangu'
    const prefs = `data/data/${pkg}/shared_prefs/CapacitorStorage.xml`
    const evil = [
      `content://x/../../_capacitor_file_/${prefs}`,
      `content://x/%2e%2e/%2E./_capacitor_file_/${prefs}`,
      `content://x/..\\..\\_capacitor_file_\\${prefs.replace(/\//g, '\\')}`,
      `content://../_capacitor_file_/${prefs}`,
      `content://x/../${pkg}.fileprovider/root/${prefs}`,
      'content://x', // 没有路径
      'content://x%/doc', `content://${pkg}%2Efileprovider/root/${prefs}`, // authority 里的转义(残缺的 / 完整的)
    ]
    const s = fakeServer({})
    s.fetch = async (url) => { s.log.urls.push(url); return new Response('SECRET') } // 什么都肯给的服务器:被拒的地址连请求都不该有
    const out = await loadPickedFiles(evil.map((uri, i) => ({ uri, name: `evil-${i}`, size: -1 })), s)
    assert.deepEqual([out.files.map((f) => f.name), out.skipped, s.log.urls], [[], evil.map((_, i) => `evil-${i}`), []])
    for (const uri of evil) assert.equal(staysInItsProvider(uri, s.toUrl(uri)), false, uri)
    // 正常文档不受影响:文档 id 里编码过的冒号 / 斜杠 / 空格,带用户前缀的 authority
    for (const uri of ['content://com.android.externalstorage.documents/document/primary%3ADownload%2Fa%20b.txt', 'content://10@media/external/file/42', 'content://p/a..b/c']) {
      assert.equal(staysInItsProvider(uri, s.toUrl(uri)), true, uri)
    }
  })

  await test('提供方报的名字只取末段、去掉控制字符(它往后会被当成文件名)', async () => {
    const s = fakeServer({ 'content://p/1': bytes(1, 1), 'content://p/2': bytes(1, 1), 'content://p/3': bytes(1, 1) })
    const out = await loadPickedFiles([
      { uri: 'content://p/1', name: '../../etc/passwd' }, { uri: 'content://p/2', name: 'C:\\Users\\x\\a\u0000b.txt' }, { uri: 'content://p/3', name: '/' },
    ], s)
    assert.deepEqual(out.files.map((f) => f.name), ['passwd', 'ab.txt', 'file'])
  })

  const failed = results.filter((r) => !r[1]).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
