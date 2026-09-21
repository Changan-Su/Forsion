/**
 * 市场下载探针:在真 Electron 主进程里,用与 market:install 相同的 net.fetch + downloadZip,逐个试下载候选地址并报告通断与耗时。
 * 2026-09-21 用户实报「中国用户点 GitHub 插件安装只转圈」后留下 —— 下次先在出问题的那台机器 / 那张网络上跑这个,别从头推演。
 *
 *   npm run probe:marketdl                          # 默认:Live3D v0.1.0 的 zipball(线上服务端对无资产 release 的真实返回形状)
 *   npm run probe:marketdl -- --mirror china <url>  # 按开了「中国大陆镜像」的候选试(代理站 → 直连);默认只直连。地址可换:api zipball / archive / release 资产 / OSS 签名地址
 *   npm run probe:marketdl -- --selftest            # 本地挂起 / 断流服务,验超时机制(不需要外网)
 *
 * FORSION_MARKET_CONNECT_TIMEOUT_MS / FORSION_MARKET_STALL_TIMEOUT_MS 与主进程同名同义,可调。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')

if (!process.versions.electron) {
  // 外层(node):把 marketInstall.ts 打成 CJS,再用 electron 跑本文件自己。
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'marketdl-'))
  execFileSync(path.join(ROOT, 'node_modules/.bin/esbuild'), [path.join(ROOT, 'electron/marketInstall.ts'), '--bundle', '--platform=node', '--format=cjs', '--log-level=warning', `--outfile=${path.join(out, 'marketInstall.cjs')}`], { stdio: 'inherit' })
  const r = spawnSync(path.join(ROOT, 'node_modules/.bin/electron'), [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, MARKETDL_MODULE: path.join(out, 'marketInstall.cjs') } })
  fs.rmSync(out, { recursive: true, force: true })
  process.exit(r.status ?? 1)
}

const { app, net } = require('electron')
const http = require('http')
const { downloadZip, downloadCandidates } = require(process.env.MARKETDL_MODULE)

const args = process.argv.slice(2).filter((a) => a !== '--')
const mirror = args.includes('--mirror') ? args[args.indexOf('--mirror') + 1] : 'default'
const selftest = args.includes('--selftest')
const url = args.find((a) => /^https?:\/\//.test(a)) || 'https://api.github.com/repos/Changan-Su/forsion-plugin-live3d/zipball/v0.1.0'
const fetchFn = (u, init) => net.fetch(u, init)

async function attempt(label, urls) {
  const t0 = Date.now()
  try {
    const buf = await downloadZip(urls, fetchFn)
    console.log(`  OK    ${label}  ${(buf.length / 1024).toFixed(0)} KB  ${Date.now() - t0} ms`)
    return true
  } catch (e) {
    console.log(`  FAIL  ${label}  ${e.message}  ${Date.now() - t0} ms`)
    return false
  }
}

app.whenReady().then(async () => {
  let ok = true
  if (selftest) {
    process.env.FORSION_MARKET_CONNECT_TIMEOUT_MS ||= '2000'
    process.env.FORSION_MARKET_STALL_TIMEOUT_MS ||= '1500'
    // 必须带 Content-Type:没有它 Chromium 先憋 512 字节做 MIME 嗅探,响应头迟迟不交付,「断流」就被测成了「连接超时」。
    const ZIP = { 'content-type': 'application/zip' }
    const stall = http.createServer((_req, res) => { res.writeHead(200, ZIP); res.write('PK') }).listen(0, '127.0.0.1')
    const hang = http.createServer(() => {}).listen(0, '127.0.0.1')
    const ok200 = http.createServer((_req, res) => { res.writeHead(200, ZIP); res.end(Buffer.from('PK\x03\x04selftest')) }).listen(0, '127.0.0.1')
    await new Promise((r) => setTimeout(r, 200))
    const at = (s) => `http://127.0.0.1:${s.address().port}/x.zip`
    console.log('selftest(挂起 → 超时换下一个;断流 → stalled 换下一个;全失败逐个列原因):')
    ok = (await attempt('hang → ok', [at(hang), at(ok200)])) && ok
    ok = (await attempt('stall → ok', [at(stall), at(ok200)])) && ok
    ok = !(await attempt('hang + stall(应失败)', [at(hang), at(stall)])) && ok
    for (const s of [stall, hang, ok200]) s.close()
  } else {
    const candidates = downloadCandidates(url, mirror, process.env.TANGU_GITHUB_PROXY || '')
    console.log(`mirror=${mirror}  逐个候选(与安装时同序;安装时第一个成功即停):`)
    for (const c of candidates) await attempt(c, [c])
    console.log('整体(带回退,= 用户点「安装」时的结果):')
    ok = await attempt(`${candidates.length} 个候选`, candidates)
  }
  app.exit(ok ? 0 : 1)
})
