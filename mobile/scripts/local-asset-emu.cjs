/**
 * 本地库资源地址的**原生层**探针 —— `PKG=com.forsion.tangu.nativepreview npm run emu:localasset`(一台已开机的
 * 模拟器 / 真机,装着可调试的包;只用 adb + CDP,不点界面、不用 uiautomator)。
 *
 * 手机本地库的图片地址(src/amadeus/localAssets.ts)= `<库根的可加载地址>/<库内路径,按段百分号编码>`,库根取自
 * fsAdapter.webUrl:`Capacitor.convertFileSrc((await Filesystem.getUri({ path: 'vault', directory: Data })).uri)`。
 * 页面这一层(地址拼得对不对、存盘换不换得回来)由 `npm run e2e:localasset` 和单测钉住;但浏览器里那个地址没人服务,
 * 台架是自己回填字节的。本探针补的是另一半:**安卓原生那一层真的照这个地址把文件送出来** ——
 *   · getUri + convertFileSrc 给出的库根是什么形态(与页面同源、无尾斜杠);
 *   · 名字里带空格 / 括号 / 中文 / 百分号的文件,按段编码之后取得到、字节一致;
 *   · 作为 <img> 加载得出来,不触发内容安全策略违规;
 *   · 带 Range 的请求怎么回(音视频拖动靠它):状态码、正文是不是从要的起点开始、有没有按终点截断;
 *   · 地址里原样带着 `..`(指到页目录之外的引用,localAssets 逐字保留)时取到的是折叠之后的那个文件。
 * 用的全是 Capacitor 自带的接口,与装的是哪一版我们的页面代码无关 —— 所以不必为它重新出包。
 * ⚠️ 探的是原生服务层,不是整条链路:真 App 里「打开一篇带图的本地笔记」没有被点过。
 *
 * 另记一条事实(不算通过 / 不通过):这个文件服务**没有库的边界**,同源页面本来就能按路径取应用私有目录下的任何文件
 * (Capacitor 自带,不是这次引入的)。所以「不给逃出库根的引用拼地址」是 localAssets 自己的事(单测钉着),
 * 页面的 frame-src 也必须保持只放同源。
 */
const assert = require('node:assert/strict')
const h = require('./lib/emu-cdp.cjs')

const PKG = process.env.PKG || 'com.forsion.tangu'
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4EIwDiqEF8hAN5vBf0dRNNOAAAAAElFTkSuQmCC' // 2×2,78 字节
const RUN = `forsion-e2e-probe-${Date.now().toString(36)}`

/** 在页面里跑。探针文件都落在 vault/<RUN>/ 与 <RUN>.txt,结束时删掉。 */
const PROBE = `(async () => {
  const { Filesystem } = Capacitor.Plugins
  const DIR = 'DATA'
  const run = ${JSON.stringify(RUN)}
  const rel = run + '/子夹/e2e probe (1) 笔记 100%.png'
  const csp = []
  const onCsp = (e) => csp.push(e.effectiveDirective + ' <- ' + String(e.blockedURI).slice(0, 80))
  document.addEventListener('securitypolicyviolation', onCsp)
  await Filesystem.writeFile({ path: 'vault/' + rel, directory: DIR, data: ${JSON.stringify(PNG_B64)}, recursive: true })
  await Filesystem.writeFile({ path: run + '.txt', directory: DIR, data: 'outside', encoding: 'utf8' })
  try {
    // 与 fsAdapter.webUrl 逐字同一个表达式
    const base = Capacitor.convertFileSrc((await Filesystem.getUri({ path: 'vault', directory: DIR })).uri).replace(/\\/+$/, '')
    // 与 localAssetUrl 同一种编码;括号由共享接缝的出口(toAssetUrl)补编
    const enc = (p) => p.split('/').map(encodeURIComponent).join('/').replace(/[()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    const url = base + '/' + enc(rel)
    const get = (u, headers) => fetch(u, { headers }).then(async (r) => {
      const body = new Uint8Array(await r.arrayBuffer())
      return { status: r.status, type: r.headers.get('content-type'), range: r.headers.get('content-range'), bytes: body.length, head: [...body.slice(0, 4)] }
    }, (e) => ({ error: String(e) }))
    const raw = Uint8Array.from(atob(${JSON.stringify(PNG_B64)}), (c) => c.charCodeAt(0))
    const img = await new Promise((res) => {
      const i = new Image()
      i.onload = () => res({ loaded: true, w: i.naturalWidth })
      i.onerror = () => res({ loaded: false, w: 0 })
      i.src = url
    })
    return {
      origin: location.origin, base, url, img,
      full: await get(url),
      range: await get(url, { Range: 'bytes=0-9' }),
      mid: await get(url, { Range: 'bytes=40-49' }),
      at40: [...raw.slice(40, 44)],
      dotdot: await get(base + '/' + enc(run + '/别处/../子夹/e2e probe (1) 笔记 100%.png')),
      outside: await get(base + '/../' + run + '.txt'),
      csp,
      imgSrc: (document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content.match(/img-src[^;]*/) || [''])[0],
    }
  } finally {
    document.removeEventListener('securitypolicyviolation', onCsp)
    await Filesystem.rmdir({ path: 'vault/' + run, directory: DIR, recursive: true }).catch(() => {})
    await Filesystem.deleteFile({ path: run + '.txt', directory: DIR }).catch(() => {})
  }
})()`

async function main() {
  if (!h.adb('shell', 'pidof', PKG).trim()) {
    h.adb('shell', 'am', 'start', '-n', `${PKG}/com.forsion.tangu.MainActivity`)
    await h.pause(4000)
  }
  const cdp = await h.connect(PKG, Number(process.env.CDP_PORT || 9361))
  let failed = 0
  const check = (name, fn) => {
    try { fn(); console.log(`PASS  ${name}`) } catch (e) { failed += 1; console.log(`FAIL  ${name}\n      ${String(e.message).split('\n')[0]}`) }
  }
  try {
    assert.ok(await h.waitPage(cdp, '!!window.Capacitor?.Plugins?.Filesystem', 20000), '页面里没有 Capacitor.Plugins.Filesystem')
    const r = await cdp.eval(PROBE)
    console.log(`      库根 = ${r.base}\n      地址 = ${r.url}\n      页面的 ${r.imgSrc}`)
    check('库根与页面同源、走 Capacitor 本地文件服务、无尾斜杠', () => {
      assert.ok(r.base.startsWith(`${r.origin}/_capacitor_file_/`), `origin = ${r.origin}`)
      assert.match(r.base, /\/files\/vault$/)
    })
    check('带空格 / 括号 / 中文 / 百分号的文件名按段编码后取得到,字节一致(78)', () => assert.deepEqual([r.full.status, r.full.bytes], [200, 78], JSON.stringify(r.full)))
    check('作为 <img> 加载得出来(naturalWidth = 2),不触发内容安全策略违规', () => {
      assert.deepEqual(r.img, { loaded: true, w: 2 })
      assert.deepEqual(r.csp, [])
    })
    // Range:音视频拖动靠它。量三件事 —— 状态码、正文是不是从要的起点开始、有没有按终点截断。只有前两件算通过 / 不通过。
    check('带 Range 的请求回 206,正文从要的起点开始(音视频拖动的前提)', () => {
      assert.equal(r.range.status, 206, JSON.stringify(r.range))
      assert.deepEqual([r.mid.status, r.mid.head], [206, r.at40], `bytes=40-49 → ${JSON.stringify(r.mid)},文件第 40 字节起是 ${JSON.stringify(r.at40)}`)
    })
    console.log(`INFO  bytes=0-9 → ${r.range.bytes} 字节(Content-Range: ${r.range.range});bytes=40-49 → ${r.mid.bytes} 字节(Content-Range: ${r.mid.range})${r.range.bytes === 10 ? '' : ' —— 正文没有按终点截断'}`)
    check('地址里原样带着 `..` 时取到折叠之后的那个文件', () => assert.deepEqual([r.dotdot.status, r.dotdot.bytes], [200, 78], JSON.stringify(r.dotdot)))
    console.log(`INFO  库之外的应用私有文件按路径${r.outside.status === 200 ? '取得到(这个文件服务没有库的边界 —— 见头注)' : `取不到:${JSON.stringify(r.outside)}`}`)
  } finally {
    cdp.close()
  }
  console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(`✗ 探针异常: ${e.stack || e}`); process.exit(1) })
