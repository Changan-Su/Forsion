/**
 * P1-DL 移动端「存到下载」JS 半身(src/saveDownload.ts)单测 —— `npm run test:savedl`(mobile 目录,不用先 build)。
 * 原生半身(DownloadsPlugin.java)用假插件替身,只记账:分块顺序与内容、出错必 abort、上限在 begin 之前就拒。
 * 名字规整在 JVM 单测(android: ./gradlew :app:testDebugUnitTest --offline,DownloadNamesTest),真落盘在 scripts/save-download-emu.cjs。
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

/** 假原生:按 id 攒块;可在第 n 次 append / finish 时失败。 */
function fakePlugin({ failAppendAt = -1, finishName } = {}) {
  const log = []
  const files = new Map()
  let appends = 0
  return {
    log, files,
    begin: async (o) => { log.push(['begin', o]); files.set('id1', []); return { id: 'id1' } },
    append: async (o) => {
      appends += 1
      log.push(['append', o.id, o.data.length])
      if (appends === failAppendAt) throw Object.assign(new Error('IOException'), { code: 'io' })
      files.get(o.id).push(Buffer.from(o.data, 'base64'))
      return { written: Buffer.concat(files.get(o.id)).length }
    },
    finish: async (o) => { log.push(['finish', o.id]); return { name: finishName === undefined ? 'saved.bin' : finishName } },
    abort: async (o) => { log.push(['abort', o.id]); return { ok: true } },
  }
}

const results = []
const test = async (name, fn) => {
  try { await fn(); results.push([name, true]); console.log(`PASS  ${name}`) }
  catch (e) { results.push([name, false]); console.log(`FAIL  ${name}\n      ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e}`) }
}

;(async () => {
  const { createSaveDownload, bytesToBase64, DL_CHUNK_BYTES } = await load('../src/saveDownload.ts')
  const bytes = (n, seed = 7) => { const b = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24 } return b }

  await test('bytesToBase64 与 Buffer 逐字一致(含跨 32 KB 小段、空、非 3 倍数长度)', () => {
    for (const n of [0, 1, 2, 3, 4, 0x7fff, 0x8000, 0x8001, 100_003]) {
      const b = bytes(n, n + 1)
      assert.equal(bytesToBase64(b), Buffer.from(b).toString('base64'), `n=${n}`)
    }
  })

  await test('缺省块大小是 3 的倍数(每块 base64 不带中途填充)且 ≤ 2 MB base64', () => {
    assert.equal(DL_CHUNK_BYTES % 3, 0)
    assert.ok(Math.ceil(DL_CHUNK_BYTES / 3) * 4 <= 2 * 1024 * 1024)
  })

  await test('分块按序递给原生,拼回来与原字节逐字相等;回原生给的实际文件名', async () => {
    const p = fakePlugin({ finishName: 'report (1).bin' })
    const data = bytes(10_001)
    const save = createSaveDownload(p, { maxBytes: 1e6, chunkBytes: 3000 })
    const r = await save('report.bin', 'application/x-thing', new Blob([data]))
    assert.deepEqual(r, { name: 'report (1).bin' })
    assert.deepEqual(p.log[0], ['begin', { name: 'report.bin', mime: 'application/x-thing', size: 10_001 }])
    assert.equal(p.log.filter((e) => e[0] === 'append').length, 4) // 3000×3 + 1001
    assert.deepEqual(p.log.at(-1), ['finish', 'id1'])
    assert.ok(Buffer.concat(p.files.get('id1')).equals(Buffer.from(data)))
    assert.ok(!p.log.some((e) => e[0] === 'abort'))
  })

  await test('空文件:begin → finish,不 append', async () => {
    const p = fakePlugin()
    await createSaveDownload(p, { maxBytes: 10 })('empty.txt', '', new Blob([]))
    assert.deepEqual(p.log.map((e) => e[0]), ['begin', 'finish'])
  })

  await test('原生没回名字 → 退回请求的名字', async () => {
    const p = fakePlugin({ finishName: '' })
    assert.deepEqual(await createSaveDownload(p, { maxBytes: 100 })('a.txt', 'text/plain', new Blob(['x'])), { name: 'a.txt' })
  })

  await test('超上限:begin 之前就拒(code=too_large),原生一次都不调', async () => {
    const p = fakePlugin()
    await assert.rejects(createSaveDownload(p, { maxBytes: 10 })('big.bin', '', new Blob([bytes(11)])), (e) => e.code === 'too_large')
    assert.equal(p.log.length, 0)
  })

  await test('中途 append 失败:abort 同一个 id、原错误原样抛出、不再 finish', async () => {
    const p = fakePlugin({ failAppendAt: 2 })
    await assert.rejects(createSaveDownload(p, { maxBytes: 1e6, chunkBytes: 3000 })('x.bin', '', new Blob([bytes(9000)])), (e) => e.code === 'io')
    assert.deepEqual(p.log.map((e) => e[0]), ['begin', 'append', 'append', 'abort'])
    assert.deepEqual(p.log.at(-1), ['abort', 'id1'])
  })

  const failed = results.filter((r) => !r[1]).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
})()
