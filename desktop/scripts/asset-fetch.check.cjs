/**
 * `amadeus-asset://` 能不能被 **fetch/XHR** 读成 ArrayBuffer —— 插件加载库内二进制资源
 * (3D 模型 .glb、字体、任意 blob)的地基。
 *
 * 为什么必须真跑:自定义协议就算登记了 `supportFetchAPI + corsEnabled`,页面 CSP 的
 * **connect-src** 仍然管得着它。`amadeus-asset:` 一直只写在 img-src / media-src / frame-src 里,
 * 于是症状是「<img> 能显示、GLTFLoader 一律失败」—— 只读代码推不出来,浏览器台架也照不到
 * (普通 Chromium 里根本没有这个 scheme)。2026-08-29 为此把 `amadeus-asset:` 加进了
 * connect-src,本脚本就是那条改动的看门狗。
 *
 * 2026-09-19 同理补了 `blob: data:`:three 的 GLTFLoader 在 Chromium 上用 ImageBitmapLoader,它对
 * `URL.createObjectURL(blob)` 出来的内嵌贴图走 **fetch(blob:)**;`.gltf` 里 base64 的 buffer 走 fetch(data:)。
 * connect-src 不放行这两个 scheme 时,贴图加载失败被 GLTFLoader 吞掉 → 模型**无贴图**只留一行 console.error。
 * T5–T7 守这条(含把两个 scheme 从 connect-src 抠掉必须变红的负对照)。
 *
 * 不依赖 app 构建产物,裸 Electron + 内存夹具,几秒出结果。
 * 用法:npm run check:assetfetch
 */
const { app, protocol, BrowserWindow } = require('electron')
const http = require('http')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SCHEME = 'amadeus-asset'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

// ── 静态闸:两份真源必须还长着本脚本假设的样子 ────────────────────────────────────
const indexHtml = readFileSync(path.join(ROOT, 'frontend/index.html'), 'utf8')
const CSP = (/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(indexHtml) || [])[1] || ''
const connectSrc = (/connect-src ([^;]+)/.exec(CSP) || [])[1] || ''
check('S1 frontend/index.html 的 connect-src 放行 amadeus-asset:(插件读二进制资源的唯一闸)',
  connectSrc.includes(`${SCHEME}:`), `connect-src ${connectSrc.trim()}`)
check('S1b connect-src 放行 blob: 与 data:(GLTFLoader 内嵌贴图 / base64 buffer 走 fetch)',
  /(^|\s)blob:(\s|$)/.test(connectSrc) && /(^|\s)data:(\s|$)/.test(connectSrc), `connect-src ${connectSrc.trim()}`)

const protoSrc = readFileSync(path.join(ROOT, 'electron/amadeus/assetProtocol.ts'), 'utf8')
const privLine = (/privileges:\s*\{([^}]+)\}/.exec(protoSrc) || [])[1] || ''
check('S2 协议仍登记 supportFetchAPI + corsEnabled(少一个 fetch 就通不了)',
  /supportFetchAPI:\s*true/.test(privLine) && /corsEnabled:\s*true/.test(privLine), privLine.trim())

// ── 内存夹具 vault ─────────────────────────────────────────────────────────────
// 12 字节假 .glb(magic 'glTF' + 版本 + 长度),只用来验字节数与内容原样往返。
const GLB = Buffer.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 12, 0, 0, 0])
// 1×1 透明 PNG —— <img> 那条路的对照。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const VAULT = { 'skins/knife.glb': GLB, 'skins/icon.png': PNG }

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
])

/** 两份页面:A = 线上真 CSP;B = 把 amadeus-asset: 从 connect-src 抠掉的「改动前」CSP(负对照)。 */
const page = (csp) =>
  `<!doctype html><meta charset=utf-8><meta http-equiv="Content-Security-Policy" content="${csp}"><body>ok`
const CSP_WITHOUT = CSP.replace(`connect-src 'self' ${SCHEME}:`, "connect-src 'self'")
/** C = 只从 **connect-src** 里抠掉 blob: / data: 的「改动前」CSP(img-src / media-src 里的 blob: data: 原样保留,
 *  否则负对照证明的就是别的指令)。 */
const CSP_WITHOUT_BLOB = CSP.replace(/connect-src [^;]+/, (d) => d.replace(/\s(?:blob|data):(?=\s|$)/g, ''))

const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page(req.url.startsWith('/noblob') ? CSP_WITHOUT_BLOB : req.url.startsWith('/without') ? CSP_WITHOUT : CSP))
})

/** 页内:fetch 一段内存 blob: 与一段 data: URL,读回 ArrayBuffer(8 字节假 glTF 头)。 */
const FETCH_BLOB_DATA = `(async () => {
  const head = (b) => ({ ok: true, n: b.byteLength, magic: new TextDecoder().decode(new Uint8Array(b, 0, 4)) })
  const out = {}
  try {
    const u = URL.createObjectURL(new Blob([new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0])]))
    out.blob = head(await fetch(u).then((r) => r.arrayBuffer()))
    URL.revokeObjectURL(u)
  } catch (e) { out.blob = { ok: false, err: String(e) } }
  try {
    out.data = head(await fetch('data:application/octet-stream;base64,Z2xURgIAAAA=').then((r) => r.arrayBuffer()))
  } catch (e) { out.data = { ok: false, err: String(e) } }
  return out
})()`

const load = (win, url) => win.loadURL(url)

app.whenReady().then(() => {
  protocol.handle(SCHEME, async (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ''))
    // 夹紧闸的同形复刻(真实现按 vault 根 path.relative 判);越界一律 403。
    if (rel.includes('..')) return new Response('forbidden', { status: 403 })
    const buf = VAULT[rel]
    if (!buf) return new Response('not found', { status: 404 })
    return new Response(buf, { headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/octet-stream' } })
  })

  srv.listen(0, '127.0.0.1', async () => {
    const port = srv.address().port
    const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { contextIsolation: true } })

    // ── A:线上 CSP 下 fetch 二进制 ──────────────────────────────────────────────
    await load(win, `http://127.0.0.1:${port}/with`)
    const a = await win.webContents.executeJavaScript(`
      fetch('${SCHEME}://v/' + encodeURIComponent('skins/knife.glb'))
        .then(r => r.arrayBuffer())
        .then(b => ({ ok: true, n: b.byteLength, magic: new TextDecoder().decode(new Uint8Array(b, 0, 4)) }))
        .catch(e => ({ ok: false, err: String(e) }))`)
    check('T1 线上 CSP 下 fetch(amadeus-asset://…) 拿得到 ArrayBuffer(GLTFLoader 走的就是这条)',
      a.ok && a.n === GLB.length && a.magic === 'glTF', JSON.stringify(a))

    // ── B:负对照。抠掉 connect-src 里的 amadeus-asset: 必须当场变红 ──────────────
    // 没有这一条,T1 只能证明「现在能跑」,证明不了「是那行 CSP 在起作用」。
    await load(win, `http://127.0.0.1:${port}/without`)
    const b = await win.webContents.executeJavaScript(`
      fetch('${SCHEME}://v/' + encodeURIComponent('skins/knife.glb'))
        .then(() => ({ blocked: false }))
        .catch(e => ({ blocked: true, err: String(e) }))`)
    check('T2 负对照:connect-src 去掉 amadeus-asset: 后 fetch 必须失败(证明 T1 不是恒绿)',
      b.blocked === true, JSON.stringify(b))

    // ── C:原有的 <img> 路没被这次改动弄坏 ───────────────────────────────────────
    await load(win, `http://127.0.0.1:${port}/with`)
    const c = await win.webContents.executeJavaScript(`
      new Promise(res => {
        const i = new Image()
        i.onload = () => res({ ok: true, w: i.naturalWidth })
        i.onerror = () => res({ ok: false })
        i.src = '${SCHEME}://v/' + encodeURIComponent('skins/icon.png')
      })`)
    check('T3 <img src="amadeus-asset://…"> 照旧能加载(img-src 那条路没被改坏)', c.ok && c.w === 1, JSON.stringify(c))

    // ── D:夹紧闸仍在(放开 connect-src 不等于放开路径) ──────────────────────────
    const d = await win.webContents.executeJavaScript(`
      fetch('${SCHEME}://v/' + encodeURIComponent('../../etc/passwd'))
        .then(r => ({ status: r.status }))
        .catch(e => ({ status: 'throw', err: String(e) }))`)
    check('T4 越界路径仍 403(connect-src 放行的是 scheme,不是路径)', d.status === 403, JSON.stringify(d))

    // ── E:线上 CSP 下 fetch(blob:) / fetch(data:) —— three 的贴图与 base64 buffer 走的就是这两条 ──────
    const e = await win.webContents.executeJavaScript(FETCH_BLOB_DATA)
    check('T5 线上 CSP 下 fetch(blob:) 读得回 ArrayBuffer(GLB/VRM 内嵌贴图 → ImageBitmapLoader)',
      e.blob.ok && e.blob.n === 8 && e.blob.magic === 'glTF', JSON.stringify(e.blob))
    check('T6 线上 CSP 下 fetch(data:) 读得回 ArrayBuffer(.gltf 里 base64 的 buffer)',
      e.data.ok && e.data.n === 8 && e.data.magic === 'glTF', JSON.stringify(e.data))

    // ── F:负对照。只从 connect-src 抠掉 blob: data:,两条都必须当场失败 ─────────────────────────
    await load(win, `http://127.0.0.1:${port}/noblob`)
    const f = await win.webContents.executeJavaScript(FETCH_BLOB_DATA)
    check('T7 负对照:connect-src 去掉 blob: data: 后两条 fetch 都失败(证明 T5/T6 不是恒绿)',
      CSP_WITHOUT_BLOB !== CSP && !f.blob.ok && !f.data.ok, JSON.stringify(f))

    finish()
  })
})

function finish() {
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  if (bad.length) console.log('未通过:' + bad.map((r) => r.name).join(' / '))
  app.exit(bad.length ? 1 : 0)
}
