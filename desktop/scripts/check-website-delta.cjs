/**
 * 官网下载源的差量更新,真跑一遍 electron-updater:证明带 blockmap 的官网记录走的是差量、量出实际下了多少字节。
 *
 * 被测的是真东西:装着的 electron-updater(NsisUpdater / MacUpdater,ElectronHttpExecutor 走 Electron net)
 * × 真的 WebsiteUpdateProvider × shared/updateSource.ts 的 websiteDownload × differentialCache.ts 的旧 blockmap 核对。
 * 假的只有两台本机服务器,形状照生产:
 *   - 「官网」口:`/api/website/download/<平台>/<版本>/<文件名>(.blockmap)` 和老的 `/api/website/download/<平台>`,一律 302 到「OSS」口;
 *   - 「OSS」口:带签名查询串才给;单 Range 回 206;多 Range 只回第一段、也不是 multipart —— dl.forsion.net 实测就是这样
 *     (2026-11-25 `curl -r 0-9,20-29`),electron-updater 若用多 Range 会每次差量失败。字节数在这个口自己数。
 * 两版「安装包」是随机字节 + 几处改动,blockmap 用 app-builder-lib 的 buildBlockMap 生成(发版时 electron-builder 用的同一个)。
 * 更新缓存(installer.exe / update.zip / current.blockmap)和 userData 全在临时目录,不碰本机真的 Forsion 更新缓存。
 *
 * 场景:
 *   W1 Windows,记录带 blockmap,缓存里只有 NSIS 装机时留下的 installer.exe → 差量,旧版 blockmap 按地址取
 *   W2 Windows,记录没有 blockmap(老 server)→ 老地址整包
 *   W3 Windows,带 blockmap 但官网没有当前版本的 blockmap(404)→ 回落整包,sha512 照样过
 *   W4 Windows,缓存里留着更早一版的 current.blockmap(整包更新 / 手动装过之后)、不做核对 → 白下一遍差量再整包(负对照)
 *   W5 同 W4,先跑 dropStaleCurrentBlockmap(updater.ts 开差量前做的)→ 差量
 *   M1 mac,带 blockmap,缓存里有上次应用内更新留下的 update.zip → 差量
 *   M2 mac,带 blockmap,没有 update.zip(手动装 dmg 之后第一次更新)→ 整包
 *
 * 用法:npm run check:websitedelta [-- --mb=48] [-- --json=<结果文件>]
 */
const { app } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const ROOT = path.join(__dirname, '..')
const arg = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || fallback
const MB = Number(arg('mb', '48'))
const JSON_OUT = arg('json', '')

app.disableHardwareAcceleration()
if (process.platform === 'darwin' && app.dock) app.dock.hide()

/** 把 TS 源码(真的 provider / 地址规则 / 缓存核对)现编出来,按 desktop/electron 下的模块解析依赖,不落盘。 */
function loadSources() {
  const esbuild = require('esbuild')
  const out = esbuild.buildSync({
    stdin: {
      contents: `export { WebsiteUpdateProvider } from './electron/websiteUpdateProvider'
export { websiteDownload } from './shared/updateSource'
export { dropStaleCurrentBlockmap } from './electron/differentialCache'`,
      resolveDir: ROOT, loader: 'ts', sourcefile: 'website-delta-entry.ts',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['electron', 'electron-updater', 'builder-util-runtime'],
  })
  const filename = path.join(ROOT, 'electron', '__website-delta-check.cjs')
  const m = new Module(filename, module)
  m.filename = filename
  m.paths = Module._nodeModulePaths(path.dirname(filename))
  m._compile(out.outputFiles[0].text, filename)
  return m.exports
}

// ── 两版「安装包」+ blockmap ────────────────────────────────────────────────────────────────
function rand(n, seed) {
  // 可复现:同一个 seed 同样的字节(sha256 计数器流)
  const out = Buffer.alloc(n)
  for (let off = 0, i = 0; off < n; i++) {
    const block = crypto.createHash('sha256').update(`${seed}:${i}`).digest()
    off += block.copy(out, off)
  }
  return out
}
/** v1 随机;v2 = v1 改 1 MB、插 256 KB、尾部改 512 KB;v0 = v1 开头多 100 KB(同样的块、错开的偏移,用来造过期的 blockmap) */
function makeVersions() {
  const v1 = rand(MB * 1024 * 1024, 'v1')
  const v2 = Buffer.concat([
    v1.subarray(0, 8 << 20), rand(1 << 20, 'v2-a'), v1.subarray(9 << 20, 20 << 20),
    rand(256 << 10, 'v2-b'), v1.subarray(20 << 20, v1.length - (512 << 10)), rand(512 << 10, 'v2-c'),
  ])
  const v0 = Buffer.concat([rand(100 << 10, 'v0'), v1])
  return { v0, v1, v2 }
}
const sha512 = (buf) => crypto.createHash('sha512').update(buf).digest('base64')

async function blockmapOf(dir, name, content) {
  const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap')
  const file = path.join(dir, name)
  fs.writeFileSync(file, content)
  await buildBlockMap(file, 'gzip', `${file}.blockmap`)
  return fs.readFileSync(`${file}.blockmap`)
}

// ── 假「官网」+ 假「OSS」───────────────────────────────────────────────────────────────────
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}
async function startServers(objects) {
  const stats = { installerBytes: 0, blockmapBytes: 0, rangeRequests: 0, multiRange: 0, fullGets: 0, apiInstallerHits: 0, blockmapUrls: [], notFound: [] }
  const oss = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://oss')
    const body = objects.get(url.pathname)
    if (!url.searchParams.get('Signature')) { res.writeHead(403); return res.end('AccessDenied') }
    if (!body) { res.writeHead(404); return res.end('NoSuchKey') }
    const isMap = url.pathname.endsWith('.blockmap')
    const count = (n) => { if (isMap) stats.blockmapBytes += n; else stats.installerBytes += n }
    const range = req.headers.range
    if (range) {
      const parts = String(range).replace(/^bytes=/, '').split(',').map((s) => s.trim())
      if (parts.length > 1) stats.multiRange++
      stats.rangeRequests++
      const [a, b] = parts[0].split('-').map(Number)
      const slice = body.subarray(a, Math.min(b + 1, body.length))
      // 和 dl.forsion.net 一样:多 Range 也只回第一段,Content-Type 不是 multipart
      res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Length': slice.length, 'Content-Range': `bytes ${a}-${a + slice.length - 1}/${body.length}`, 'Accept-Ranges': 'bytes' })
      count(slice.length)
      return res.end(slice)
    }
    if (!isMap) stats.fullGets++
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, 'Accept-Ranges': 'bytes' })
    count(body.length)
    res.end(body)
  })
  const ossPort = await listen(oss)
  const signed = (key) => `http://127.0.0.1:${ossPort}/${key}?Expires=${Math.floor(Date.now() / 1000) + 3600}&OSSAccessKeyId=test&Signature=sig`
  const routes = new Map() // '/api/website/download/...' → 对象键
  const api = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://api')
    const key = routes.get(decodeURIComponent(pathname))
    if (!key) { stats.notFound.push(pathname); res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"detail":"Installer not found"}') }
    if (key.endsWith('.blockmap')) stats.blockmapUrls.push(pathname)
    else stats.apiInstallerHits++
    res.writeHead(302, { Location: signed(key) })
    res.end()
  })
  const apiPort = await listen(api)
  return { stats, routes, api: `http://127.0.0.1:${apiPort}/api`, close: () => { oss.close(); api.close() } }
}

// ── 一次更新 ──────────────────────────────────────────────────────────────────────────────
async function runScenario(src, data, s) {
  const { NsisUpdater, MacUpdater } = require('electron-updater')
  const mac = s.platform === 'mac'
  const ext = mac ? 'zip' : 'exe'
  const arch = mac ? 'arm64' : 'x64'
  const platform = mac ? 'macos-update' : 'windows'
  const name = (v) => `Forsion-${v}-${arch}.${ext}`
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `forsion-delta-${s.id}-`))
  const maps = path.join(tmp, 'maps')
  fs.mkdirSync(maps)

  // 对象存储:两版安装包 + blockmap
  const objects = new Map()
  const key = (v, file) => `installers/forsion/${platform}/${v}/${file}`
  objects.set(`/${key('1.0.0', name('1.0.0'))}`, data.v1)
  objects.set(`/${key('1.0.1', name('1.0.1'))}`, data.v2)
  objects.set(`/${key('1.0.0', name('1.0.0'))}.blockmap`, await blockmapOf(maps, name('1.0.0'), data.v1))
  objects.set(`/${key('1.0.1', name('1.0.1'))}.blockmap`, await blockmapOf(maps, name('1.0.1'), data.v2))
  const srv = await startServers(objects)
  // 官网路由:老地址 = 当前发布版;带版本号的地址(同 server 的可见范围:两版都在历史里)
  srv.routes.set(`/api/website/download/${platform}`, key('1.0.1', name('1.0.1')))
  for (const v of ['1.0.0', '1.0.1']) {
    if (v === '1.0.0' && s.noOldBlockmap) {
      srv.routes.set(`/api/website/download/${platform}/${v}/${name(v)}`, key(v, name(v)))
      continue
    }
    srv.routes.set(`/api/website/download/${platform}/${v}/${name(v)}`, key(v, name(v)))
    srv.routes.set(`/api/website/download/${platform}/${v}/${name(v)}.blockmap`, `${key(v, name(v))}.blockmap`)
  }

  // 本机:装着 1.0.0;更新缓存目录里有 NSIS 装机时留下的 installer.exe / 上次应用内更新留下的 update.zip
  const cacheRoot = path.join(tmp, 'cache')
  const cacheDir = path.join(cacheRoot, 'forsion-delta-check-updater')
  fs.mkdirSync(cacheDir, { recursive: true })
  if (s.oldFile) fs.writeFileSync(path.join(cacheDir, mac ? 'update.zip' : 'installer.exe'), data.v1)
  if (s.staleBlockmap) fs.writeFileSync(path.join(cacheDir, 'current.blockmap'), await blockmapOf(maps, 'v0.bin', data.v0))
  const configPath = path.join(tmp, 'app-update.yml')
  fs.writeFileSync(configPath, 'provider: generic\nurl: http://127.0.0.1:1/unused\nupdaterCacheDirName: forsion-delta-check-updater\n') // 没有 publisherName:不验 Windows 签名
  const adapter = {
    version: '1.0.0', name: 'forsion-delta-check', isPackaged: true, appUpdateConfigPath: configPath,
    userDataPath: path.join(tmp, 'userData'), baseCachePath: cacheRoot,
    whenReady: () => Promise.resolve(), relaunch() {}, quit() {}, onQuit() {},
  }
  fs.mkdirSync(adapter.userDataPath)
  const updater = mac ? new MacUpdater(null, adapter) : new NsisUpdater(null, adapter)
  // 传了自己的 AppAdapter 时 electron-updater 不建 http 执行器(给它的单测用的):补上真的那个,走 Electron net,和装好的应用一样
  const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor')
  updater.httpExecutor = new ElectronHttpExecutor()
  if (mac) {
    // 只测下载这一段:Squirrel.Mac 的交接(没签名的 Electron 里 setFeedURL 会抛)换成空壳
    updater.nativeUpdater = { setFeedURL() {}, on() {}, once() {}, removeListener() {}, checkForUpdates() {} }
  }
  const logs = []
  updater.logger = { info: (m) => logs.push(String(m)), warn: (m) => logs.push(`WARN ${m}`), error: (m) => logs.push(`ERROR ${m}`), debug: () => {} }
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  let downloaded = null
  updater.on('update-downloaded', (info) => { downloaded = info })
  updater.on('error', () => {})

  // 和 updater.ts 的 feedFor / useSource 一样钉源
  const installer = { version: '1.0.1', filename: name('1.0.1'), size: data.v2.length, sha512: sha512(data.v2), ...(s.blockmap ? { blockmap: true } : {}) }
  const { url, differential } = src.websiteDownload(srv.api, platform, installer)
  updater.disableDifferentialDownload = !differential
  if (s.guard) s.dropped = await src.dropStaleCurrentBlockmap(cacheDir, mac ? 'update.zip' : 'installer.exe')
  updater.setFeedURL({ provider: 'custom', updateProvider: src.WebsiteUpdateProvider, installer, downloadUrl: url, differential })

  const started = Date.now()
  let error = null
  try {
    const check = await updater.checkForUpdates()
    if (check?.updateInfo?.version !== '1.0.1') throw new Error(`check answered ${check?.updateInfo?.version}`)
    await updater.downloadUpdate()
  } catch (e) { error = e }
  const file = downloaded?.downloadedFile
  const ok = !!file && fs.existsSync(file) && sha512(fs.readFileSync(file)) === installer.sha512
  srv.close()
  const result = {
    id: s.id, what: s.what, url, differential,
    downloadedOk: ok, error: error ? String(error.message || error) : null,
    installerBytes: srv.stats.installerBytes, blockmapBytes: srv.stats.blockmapBytes, full: data.v2.length,
    rangeRequests: srv.stats.rangeRequests, multiRange: srv.stats.multiRange, fullGets: srv.stats.fullGets,
    apiInstallerHits: srv.stats.apiInstallerHits, blockmapUrls: srv.stats.blockmapUrls, notFound: srv.stats.notFound,
    droppedStaleBlockmap: s.dropped ?? null, ms: Date.now() - started,
    log: logs.filter((l) => /block map|Download block maps|differential|Differential|To download|fallback|Cannot/i.test(l)).map((l) => l.slice(0, 220)),
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  return result
}

const pct = (a, b) => `${(a / b * 100).toFixed(1)}%`
const mib = (n) => `${(n / 1048576).toFixed(2)} MB`

app.whenReady().then(async () => {
  let failed = 0
  const check = (name, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`); if (!cond) failed++ }
  try {
    const src = loadSources()
    const data = makeVersions()
    const full = data.v2.length
    const scenarios = [
      { id: 'W1', platform: 'win', blockmap: true, oldFile: true, what: 'Windows 带 blockmap、缓存只有 installer.exe' },
      { id: 'W2', platform: 'win', blockmap: false, oldFile: true, what: 'Windows 记录没有 blockmap(老 server)' },
      { id: 'W3', platform: 'win', blockmap: true, oldFile: true, noOldBlockmap: true, what: 'Windows 带 blockmap、官网没有当前版本的 blockmap' },
      { id: 'W4', platform: 'win', blockmap: true, oldFile: true, staleBlockmap: true, what: 'Windows 缓存里是过期 blockmap、不核对(负对照)' },
      { id: 'W5', platform: 'win', blockmap: true, oldFile: true, staleBlockmap: true, guard: true, what: 'Windows 缓存里是过期 blockmap、先核对' },
      ...(process.platform === 'darwin' ? [
        { id: 'M1', platform: 'mac', blockmap: true, oldFile: true, what: 'mac 带 blockmap、有上次留下的 update.zip' },
        { id: 'M2', platform: 'mac', blockmap: true, oldFile: false, what: 'mac 带 blockmap、没有 update.zip(手动装之后)' },
      ] : []),
    ]
    const results = []
    for (const s of scenarios) {
      const r = await runScenario(src, data, s)
      results.push(r)
      console.log(`\n[${r.id}] ${r.what}\n  ${r.url}\n  安装包下了 ${mib(r.installerBytes)} / 整包 ${mib(full)} (${pct(r.installerBytes, full)}),blockmap ${mib(r.blockmapBytes)};Range 请求 ${r.rangeRequests}(多 Range ${r.multiRange}),整包 GET ${r.fullGets};经官网接口 ${r.apiInstallerHits} 次;${(r.ms / 1000).toFixed(1)}s`)
      for (const l of r.log) console.log(`    · ${l}`)
      if (r.error) console.log(`    ! ${r.error}`)
    }
    const by = Object.fromEntries(results.map((r) => [r.id, r]))
    console.log('')
    const deltaOk = (r) => r.downloadedOk && r.installerBytes < full * 0.15 && r.fullGets === 0 && r.multiRange === 0
    check('W1 差量:sha512 对,安装包只下了一小部分,没有整包 GET,也没发多 Range', deltaOk(by.W1), `${pct(by.W1.installerBytes, full)}`)
    check('W1 新旧两版 blockmap 都按带版本号的地址取到', by.W1.blockmapUrls.some((u) => u.includes('/1.0.1/')) && by.W1.blockmapUrls.some((u) => u.includes('/1.0.0/')), by.W1.blockmapUrls.join(' , '))
    check('W1 Range 只有第一次经过官网接口,之后直接打签名链接', by.W1.apiInstallerHits === 1, `${by.W1.apiInstallerHits}`)
    check('W2 没有 blockmap:老地址整包,不碰 blockmap', by.W2.downloadedOk && by.W2.installerBytes === full && by.W2.blockmapBytes === 0 && /\/windows$/.test(by.W2.url))
    check('W3 当前版本 blockmap 404:回落整包,sha512 照样过', by.W3.downloadedOk && by.W3.fullGets === 1 && by.W3.notFound.some((u) => u.endsWith('.blockmap')), `${pct(by.W3.installerBytes, full)}`)
    check('W4 负对照:过期的 blockmap 不核对 → 白下一遍差量再整包(下得比整包还多)', by.W4.downloadedOk && by.W4.installerBytes > full && by.W4.fullGets === 1, `${pct(by.W4.installerBytes, full)}`)
    check('W5 先核对:删掉过期的 blockmap,按地址取当前版本的 → 差量', by.W5.droppedStaleBlockmap === true && deltaOk(by.W5), `${pct(by.W5.installerBytes, full)}`)
    if (by.M1) {
      check('M1 mac 差量:sha512 对,只下了一小部分', deltaOk(by.M1), `${pct(by.M1.installerBytes, full)}`)
      check('M2 mac 没有 update.zip:整包,也不去取 blockmap', by.M2.downloadedOk && by.M2.installerBytes === full && by.M2.blockmapBytes === 0)
    }
    if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ mb: MB, full, results }, null, 2))
  } catch (e) {
    console.error(e)
    failed++
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS')
  app.exit(failed ? 1 : 0)
})
