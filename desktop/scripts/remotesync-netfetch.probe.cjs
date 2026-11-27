#!/usr/bin/env node
/**
 * 远程同步走系统代理的探针(npm run check:remotesync-netfetch;不连外网,只用本机假服务与本机代理)。
 *
 * 钉三件事(升级 Electron 后重跑,net.fetch 的行为变了这里先红):
 *  1. Dropbox / Google Drive 后端注入 abortableFetch(net.fetch) 后,请求走默认会话的代理
 *     (默认会话设成本机假代理,模拟「系统代理」:安装版里是 Chromium 读系统设置得到的同一份);
 *     不注入(Node 全局 fetch)则绕过代理 —— 这正是 11-27 前国内用户连不上的原因。
 *  2. 读响应体途中 abort 会 reject(裸的、包过的都是);包装后不带 cookie、不走 HTTP 缓存。
 *     ⚠️ 假服务的响应要带 content-type 且超过 1KB:否则 Chromium 为嗅探类型压着响应头,看起来像「挂住」。
 *  3. 上传途中 abort:服务端收不到完整请求体(超时的上传不会在后台补完)。
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
setTimeout(() => { console.log('FAIL global timeout'); app.exit(2) }, 90_000)
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  // 本机假服务
  const seen = {}
  const srv = http.createServer((req, res) => {
    const rec = (seen[req.url] = { bytes: 0, ended: false, cookie: req.headers.cookie || '' })
    req.on('end', () => { rec.ended = true })
    if (req.url === '/slowup') {
      req.on('data', (c) => { rec.bytes += c.length; req.pause(); setTimeout(() => req.resume(), 50) })
      req.on('end', () => { res.writeHead(200); res.end('stored') })
      return
    }
    req.resume()
    if (req.url.startsWith('/cached')) { req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'private, max-age=3600' }); res.end('v' + (seen.count = (seen.count || 0) + 1)) }); return }
    if (req.url === '/hang') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.write('x'.repeat(64 * 1024)); return } // 回一半不收尾(带类型、超过 1KB:免得 Chromium 为嗅探类型压着响应头)
    req.on('end', () => { res.writeHead(200); res.end('ok') })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const proxied = rs.abortableFetch((i, init) => net.fetch(i, init))

  // 1. 读体途中 abort
  {
    const ac = new AbortController()
    const rsp = await net.fetch(`${base}/hang`, { signal: ac.signal })
    setTimeout(() => ac.abort(), 200)
    const raw = await within(rsp.arrayBuffer(), 2000)
    check('裸 net.fetch 读体途中 abort 也会 reject(带类型的响应)', !!raw.e, raw.timeout ? '挂住' : raw.e ? raw.e.name : '读完')
    const ac2 = new AbortController()
    const p = proxied(`${base}/hang`, { signal: ac2.signal })
    setTimeout(() => ac2.abort(), 200)
    const t0 = Date.now()
    const w = await within(p, 2000)
    check('包装后读体途中 abort 立刻 reject', !!w.e && w.e.name === 'AbortError', w.timeout ? '挂住' : `${w.e?.name} ${Date.now() - t0}ms`)
  }

  // 2. 上传途中 abort + cookie
  {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 400)
    const r = await within(proxied(`${base}/slowup`, { method: 'PUT', body: new Uint8Array(16 * 1024 * 1024), signal: ac.signal }), 3000)
    await wait(2500)
    const up = seen['/slowup']
    check('上传途中 abort:调用方 reject', !!r.e, r.timeout ? '挂住' : r.e?.name ?? 'resolved')
    check('上传途中 abort:服务端收不到完整请求体', !!up && !up.ended, up ? `收到 ${up.bytes} 字节,ended=${up.ended}` : '没收到请求')
    await session.defaultSession.cookies.set({ url: base, name: 'sid', value: 'leak' })
    await (await proxied(`${base}/cookie`)).text()
    check('不带默认会话的 cookie', seen['/cookie']?.cookie === '', JSON.stringify(seen['/cookie']?.cookie))
  }

  // HTTP 缓存:可缓存的 GET 响应,裸 net.fetch 第二次走缓存(文件内容会落进 Electron 缓存目录);包装一律 no-store
  {
    await (await net.fetch(`${base}/cached-raw`)).text()
    await (await net.fetch(`${base}/cached-raw`)).text()
    const rawCount = seen.count
    await (await proxied(`${base}/cached-wrapped`)).text()
    await (await proxied(`${base}/cached-wrapped`)).text()
    console.log(`info 裸 net.fetch 两次可缓存 GET → 服务端收到 ${rawCount} 次`)
    check('包装后不走 HTTP 缓存(两次都到服务端)', seen.count - rawCount === 2, `收到 ${seen.count - rawCount} 次`)
  }

  // 3. 走代理(放最后:之后默认会话一直指着假代理,别再发本机请求)
  const hits = []
  const proxy = http.createServer((req, res) => { hits.push(req.url); res.writeHead(502); res.end() })
  proxy.on('connect', (req, sock) => { hits.push(`CONNECT ${req.url}`); sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') })
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  await session.defaultSession.setProxy({ proxyRules: `127.0.0.1:${proxy.address().port}` })
  await rs.createDropboxRemote({ appKey: 'k', refreshToken: 'rt', fetch: proxied }).check()
  await rs.createGdriveRemote({ clientId: 'c', clientSecret: 's', refreshToken: 'rt', fetch: proxied }).check()
  check('Dropbox 经代理', hits.includes('CONNECT api.dropboxapi.com:443'), JSON.stringify(hits))
  check('Google Drive 经代理', hits.includes('CONNECT oauth2.googleapis.com:443'), JSON.stringify(hits))
  const n = hits.length
  await within(fetch('http://forsion-probe.invalid/x'), 8000) // Node 全局 fetch:只做一次 DNS,不出网
  check('对照:Node 全局 fetch 不经代理', hits.length === n, `新增代理请求 ${hits.length - n}`)

  console.log(fails.length ? `\n${fails.length} 项失败` : '\n全部通过')
  app.exit(fails.length ? 1 : 0)
})
