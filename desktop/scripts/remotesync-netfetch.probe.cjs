#!/usr/bin/env node
/**
 * 远程同步走系统代理的探针(npm run check:remotesync-netfetch;不连外网,只用本机假服务与本机代理)。
 *
 * 钉这些(升级 Electron 后重跑,net.fetch 的行为变了这里先红;abortableFetch 不缓冲正文,abort 全靠 net.fetch 自己):
 *  1. abort:读响应体途中 reject;上传途中 abort → 连接被关、服务端永远收不到完整请求体
 *     (对照:同样的上传不 abort 能收齐 —— 证明假服务真能收完,不是假绿)。
 *     ⚠️ 假服务的响应要带 content-type 且超过 1KB:否则 Chromium 为嗅探类型压着响应头,看起来像「挂住」。
 *  2. 包装后不带默认会话的 cookie;不读也不写 HTTP 缓存(对照:裸 net.fetch 确实会命中缓存)。
 *  3. 代理:默认会话设成本机假代理(模拟「系统代理」:安装版里是 Chromium 读系统设置得到的同一份),
 *     Dropbox / Google Drive 后端注入后换令牌走代理,内容 / 上传域名也走代理;
 *     对照:Node 全局 fetch 不认它、自己去解析 DNS —— 这正是 11-27 前国内用户连不上的原因。
 * 做法:esbuild 现打包 remotesync 三个文件 → 用本仓的 Electron 跑。
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const RS = path.join(ROOT, 'electron/remotesync')

if (!process.versions.electron) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-netfetch-'))
  const entry = path.join(dir, 'entry.ts')
  fs.writeFileSync(entry, ['abortableFetch', 'fsDropbox', 'fsGdrive'].map((m) => `export * from ${JSON.stringify(path.join(RS, m))}`).join('\n'))
  require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(dir, 'rs.cjs'), logLevel: 'warning' })
  const electron = require(path.join(ROOT, 'node_modules/electron'))
  const env = { ...process.env, RS_BUNDLE: path.join(dir, 'rs.cjs') }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    execFileSync(electron, [__filename], { env, stdio: 'inherit', timeout: 120_000 })
  } catch (e) {
    process.exitCode = e.status || 1
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return
}

// ── 以下在 Electron 主进程里跑 ──
const { app, net, session } = require('electron')
const http = require('node:http')
const rs = require(process.env.RS_BUNDLE)
const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fails.push(name)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const within = (p, ms) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), wait(ms).then(() => ({ timeout: true }))])
const until = async (fn, ms) => { const t = Date.now() + ms; while (!fn() && Date.now() < t) await wait(50); return fn() }
setTimeout(() => { console.log('FAIL global timeout'); app.exit(2) }, 120_000)
app.on('window-all-closed', () => {})

const UP = 8 * 1024 * 1024

app.whenReady().then(async () => {
  // 本机假服务
  const seen = {}
  let cacheHits = 0
  const srv = http.createServer((req, res) => {
    const rec = (seen[req.url] = { bytes: 0, complete: false, closed: false, cookie: req.headers.cookie || '' })
    req.on('close', () => { rec.closed = true; rec.complete = req.complete })
    if (req.url.startsWith('/up')) {
      req.on('data', (c) => { rec.bytes += c.length; req.pause(); setTimeout(() => req.resume(), 5) })
      req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('stored') })
      return
    }
    req.resume()
    if (req.url.startsWith('/cached')) { req.on('end', () => { cacheHits++; res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'private, max-age=3600' }); res.end('v' + cacheHits) }); return }
    if (req.url === '/hang') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.write('x'.repeat(64 * 1024)); return } // 回一半不收尾(带类型、超过 1KB:免得 Chromium 为嗅探类型压着响应头)
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok') })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const proxied = rs.abortableFetch((i, init) => net.fetch(i, init))

  // 1a. 读响应体途中 abort
  {
    const ac = new AbortController()
    const rsp = await proxied(`${base}/hang`, { signal: ac.signal })
    setTimeout(() => ac.abort(), 200)
    const t0 = Date.now()
    const r = await within(rsp.arrayBuffer(), 3000)
    check('读响应体途中 abort → reject', !!r.e && r.e.name === 'AbortError', r.timeout ? '挂住' : `${r.e?.name ?? '读完'} ${Date.now() - t0}ms`)
  }
  // 1b. 上传:对照(不 abort 能收齐)→ 途中 abort(收到首块之后)连接被关、永远收不齐
  {
    const ok = await within(proxied(`${base}/up-full`, { method: 'PUT', body: new Uint8Array(UP) }).then((x) => x.text()), 60_000)
    check('对照:同样的上传不 abort 能收齐', ok.v === 'stored' && seen['/up-full']?.complete === true, ok.timeout ? '超时' : `收到 ${seen['/up-full']?.bytes} / ${UP}`)
    const ac = new AbortController()
    const p = within(proxied(`${base}/up-abort`, { method: 'PUT', body: new Uint8Array(UP), signal: ac.signal }), 10_000)
    await until(() => (seen['/up-abort']?.bytes ?? 0) > 0, 5000)
    ac.abort()
    const r = await p
    const closed = await until(() => seen['/up-abort']?.closed, 5000)
    await wait(1000)
    const up = seen['/up-abort']
    check('上传途中 abort → 调用方 reject', !!r.e, r.timeout ? '挂住' : r.e?.name ?? 'resolved')
    check('上传途中 abort → 连接被关且请求体不完整', !!closed && up.complete === false && up.bytes < UP, up ? `收到 ${up.bytes} / ${UP},closed=${up.closed},complete=${up.complete}` : '没收到请求')
  }
  // 2a. cookie
  {
    await session.defaultSession.cookies.set({ url: base, name: 'sid', value: 'leak' })
    await (await proxied(`${base}/cookie`)).text()
    check('不带默认会话的 cookie', seen['/cookie']?.cookie === '', JSON.stringify(seen['/cookie']?.cookie))
  }
  // 2b. HTTP 缓存:裸的会命中(对照);包装的不读缓存,也不写 —— 包装取过之后,裸 GET 同一 URL 仍要到服务端
  {
    const h0 = cacheHits
    await (await net.fetch(`${base}/cached-raw`)).text()
    await (await net.fetch(`${base}/cached-raw`)).text()
    check('对照:裸 net.fetch 第二次命中缓存', cacheHits - h0 === 1, `服务端收到 ${cacheHits - h0} 次`)
    await (await net.fetch(`${base}/cached-read`)).text() // 预热
    const h1 = cacheHits
    await (await proxied(`${base}/cached-read`)).text()
    check('包装不读缓存(预热过的也到服务端)', cacheHits - h1 === 1, `服务端收到 ${cacheHits - h1} 次`)
    const h2 = cacheHits
    await (await proxied(`${base}/cached-write`)).text()
    await (await net.fetch(`${base}/cached-write`)).text()
    check('包装不写缓存(之后的裸 GET 仍到服务端)', cacheHits - h2 === 2, `服务端收到 ${cacheHits - h2} 次`)
  }

  // 3. 走代理(放最后:之后默认会话一直指着假代理,别再发本机请求)
  {
    const hits = []
    const proxy = http.createServer((req, res) => { hits.push(req.url); res.writeHead(502); res.end() })
    proxy.on('connect', (req, sock) => { hits.push(`CONNECT ${req.url}`); sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') })
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
    await session.defaultSession.setProxy({ proxyRules: `127.0.0.1:${proxy.address().port}` })
    await rs.createDropboxRemote({ appKey: 'k', refreshToken: 'rt', fetch: proxied }).check()
    await rs.createGdriveRemote({ clientId: 'c', clientSecret: 's', refreshToken: 'rt', fetch: proxied }).check()
    check('Dropbox 后端换令牌经代理', hits.includes('CONNECT api.dropboxapi.com:443'), JSON.stringify(hits))
    check('Google Drive 后端换令牌经代理', hits.includes('CONNECT oauth2.googleapis.com:443'), JSON.stringify(hits))
    // 后端的读写与换令牌用的是同一个注入的 fetch;这里再直接打内容 / 上传域名,确认这些主机也不被绕开
    for (const u of ['https://content.dropboxapi.com/2/files/download', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable']) await within(proxied(u, { method: 'POST' }), 8000)
    check('内容 / 上传域名经代理', hits.includes('CONNECT content.dropboxapi.com:443') && hits.includes('CONNECT www.googleapis.com:443'), JSON.stringify(hits))
    const n = hits.length
    const nodeRes = await within(fetch('http://forsion-probe.invalid/x'), 8000) // Node 全局 fetch:只做一次 DNS,不出网
    const code = nodeRes.e?.cause?.code
    check('对照:Node 全局 fetch 不认这个代理,自己解析 DNS', hits.length === n && code === 'ENOTFOUND', `新增代理请求 ${hits.length - n},错误 ${code ?? JSON.stringify(nodeRes).slice(0, 80)}`)
  }

  console.log(fails.length ? `\n${fails.length} 项失败` : '\n全部通过')
  app.exit(fails.length ? 1 : 0)
})
