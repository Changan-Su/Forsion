/**
 * Android 插件体系端到端仪器(2026-10-02)—— `npm run build && npm run e2e:plugins`。
 *
 * 真把 mobile/dist 在手机视口的 headless Chromium 里跑:市场 / 下载地址由 page.route 扮演(假市场),
 * 插件存储走 @capacitor/filesystem 的 web 实现(IndexedDB),与真机同一条 PluginFs → pluginHost / mobileMarket 链路;
 * 不同的只有下载器(真机 = Filesystem.downloadFile,这里 = fetch)。
 *
 * 流程(锚点一律 data-* / id,不按文案找元素;语言钉 zh-CN):
 *   1. 「⋯」菜单 → 市场;只列 Forsion 插件(没请求过别的类型)、显示范围说明
 *   2. 安装示例插件 → 不刷新即启用:命令进命令面板、运行 → 打开插件视图(锚点)、saveData 落盘
 *      2b. 包里带的 Space(spaces/<slug>/space.json)不刷新就进 Space 条;切过去,主区是配方点名的插件视图
 *      2c. 云端库(手机的缺省库)下插件的旁挂文件:ctx.app.writeFile / readFile 读写点开头的 .json(索引 / 缓存 / 快照),
 *          读得到别的设备传上去的那份;云端由本脚本起的假云端库扮演(startFakeCloud,判据镜像 server 的 amadeus 模块)
 *   3. 刷新 → 插件仍在、仍启用;再运行一次 → loadData 读回上次写的计数(数据跨重载);插件 Space 仍在 Space 条
 *   4. 第二项声明 isDesktopOnly → 安装被拒,错误提示 = 本地化原因;什么都没落盘
 *   5. 设置 → 插件:关掉 → 命令、视图与它的 Space 消失;卸载 → 文件没了(listPlugins / marketInstalled 都看不到)
 *
 * 负对照:`npm run e2e:plugins -- --negative` 把页面 CSP 里的 'unsafe-eval' 去掉再跑 —— 插件代码求值被拦,
 * 第 2 步必须红(证明这台仪器真的在测「插件代码跑起来了」,不是只测到「文件写进去了」)。
 * 2c 的负对照(2026-10-09 实跑):修复前的云端桥 → 写旁挂 .json 抛 HTTP 400、读别的设备传上来的也抛 HTTP 400、readBytes 恒 null;
 * 云端桥取字节时不给 ref 加尾斜杠 → 「库根下不存在的文件」那条读成别的目录里的同名文件。
 * 截图写进 mobile/outputs/native-20261002/(已 gitignore)。
 */
const http = require('http')
const crypto = require('crypto')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const JSZip = require('jszip')
const { chromium } = (() => {
  try { return require('playwright-core') } catch { /* 落到 desktop */ }
  return require(path.resolve(__dirname, '../../desktop/node_modules/playwright-core'))
})()

const PORT = Number(process.env.E2E_PORT) || 5301 // 避开 dev 5274 / boot 5279 / unitsentry 5281 / settingscfg 5283 / … / runon 5299
const APP_URL = `http://localhost:${PORT}/`
const NEGATIVE = process.argv.includes('--negative')
const SHOTS = path.resolve(__dirname, '../outputs/native-20261002')
const CDN = 'https://market-cdn.e2e.test'
const PLUGIN_ID = 'e2e-hello'
const CMD_ID = `amadeus:${PLUGIN_ID}:open-panel`
const DESK_ID = 'e2e-desk'
/** 示例插件包里带的 Space(配方 id;目录名故意与 id 不同:宿主认的是 space.json 里的 id)。 */
const SPACE_ID = 'e2e-space'
const SPACE_JSON = JSON.stringify({
  id: SPACE_ID, name: { zh: 'E2E 空间', en: 'E2E Space' }, icon: 'boxes', version: '1.0.0',
  layout: { main: [{ type: `plugin:${PLUGIN_ID}:panel` }], left: [], right: [] },
})
/** 期望的本地化拒装原因(台架钉 zh-CN;与 installMobilePlugins.ts 的 mobilemarket.desktopOnlyPlugin 同文)。 */
const DESK_REASON_ZH = '这个插件声明了「仅支持桌面端」'

/** 「别的设备已经传上云」的旁挂文件(桌面同步引擎把这类文件按二进制传)。 */
const SEEDED_PATH = 'e2e-seeded/.from-desktop.json'
const SEEDED_TEXT = '{"from":"desktop"}'
/** 只在子目录里有的文件名:插件按库根去读它,必须读不到(服务端的资源端点会按文件名全库兜底)。 */
const BARE_NAME = 'e2e-bare.json'

// 示例插件:一条命令(计数 +1 → saveData → 打开视图)+ 一个视图(把 loadData 读到的计数挂在 data-* 锚点上)。
const PLUGIN_MAIN = `
ctx.registerView({
  id: 'panel',
  title: 'E2E plugin panel',
  async mount(el) {
    const d = (await ctx.loadData()) || { runs: 0 }
    const box = document.createElement('div')
    box.setAttribute('data-e2e-plugin-view', '')
    box.setAttribute('data-e2e-runs', String(d.runs))
    box.textContent = 'E2E plugin view, runs=' + d.runs
    el.appendChild(box)
    return () => box.remove()
  },
})
ctx.registerCommand({
  id: 'open-panel',
  title: 'E2E plugin: open panel',
  keywords: 'e2eplugin',
  async run() {
    const d = (await ctx.loadData()) || { runs: 0 }
    d.runs += 1
    await ctx.saveData(d)
    ctx.openView('panel')
  },
})
// 旁挂文件探针(第 2c 步由台架 page.evaluate 调用,结果原样带回):插件的索引 / 缓存就是这种点开头的 .json。
window.__e2eSidecar = async () => {
  const dir = ctx.app.workFolder()
  const idx = dir + '/.e2e-index.json'
  const got = async (fn) => { try { return { ok: true, v: await fn() } } catch (e) { return { ok: false, err: String((e && e.message) || e) } } }
  return {
    write: await got(() => ctx.app.writeFile(idx, '{"n":1}')),
    rewrite: await got(() => ctx.app.writeFile(idx, '{"n":2}')),
    read: await got(() => ctx.app.readFile(idx)),
    seeded: await got(() => ctx.app.readFile('${SEEDED_PATH}')),
    missing: await got(() => ctx.app.readFile(dir + '/.nope.json')),
    bare: await got(() => ctx.app.readFile('${BARE_NAME}')),
    bytes: await got(async () => { const b = await ctx.app.readBytes('${SEEDED_PATH}'); return b ? new TextDecoder().decode(b) : null }),
    note: await got(async () => { await ctx.app.writeFile(dir + '/e2e-note.md', '# e2e'); return ctx.app.readFile(dir + '/e2e-note.md') }),
  }
}
`
const card = (id, name) => ({ id, type: 'amadeus-plugin', source: 'zip', name, summary: `${name} (e2e)`, author: 'e2e', installSlug: id, downloads: id === PLUGIN_ID ? 10 : 1, latestVersion: '1.0.0', tags: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' })
// The Store says so itself (the reserved tag `desktop-only`): the phone marks the card and does not offer the install.
// E2E Desk above is the other half — a Store item nobody tagged: the install is tried and the host refuses it, by the
// package's own manifest.
const FLAGGED_ID = 'e2e-flagged'
const CARDS = [card(PLUGIN_ID, 'E2E Hello'), card(DESK_ID, 'E2E Desk'), { ...card(FLAGGED_ID, 'E2E Flagged'), tags: ['desktop-only', 'e2e-tag'] }]

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const roots = [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
    for (const d of dirs.reverse()) {
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
      ]) {
        const exe = path.join(root, d, rel)
        if (fs.existsSync(exe)) return exe
      }
    }
  }
  for (const exe of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(exe)) return exe
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

function ping() {
  return new Promise((res) => {
    const req = http.get(APP_URL, (r) => { res(r.statusCode === 200); r.resume() })
    req.on('error', () => res(false))
    req.setTimeout(1500, () => { req.destroy(); res(false) })
  })
}

/**
 * 假云端库(内存,本机 http)。判据逐条镜像 server/microserver/amadeus(改那边要改这里;2026-10-09 用那边的
 * 真路由 + PGlite 逐条对过):
 *   - lib/paths.ts kindForPath:只有 .md / .db 是文本,其余一律 binary
 *   - PUT /file 写 binary 路径 → 400 BINARY_PATH;GET /file 读 binary 行 → 400 BINARY;没有这一行 → 404
 *   - POST /binary(multipart: file, path, ifAbsent?, baseSeq?)写文本路径 → 400;带 baseSeq 时不符 → 409
 *   - GET /asset 只认 ref(没带 → 400 ref required);不带 '/' 的 ref 精确找不到时按文件名全库兜底(跳过点开头的路径);
 *     尾斜杠在归一时剥掉、但算「带 '/'」—— 所以 `ref=名字/` 只做精确匹配(云端桥靠这一点避开兜底)
 * 别的端点一律 404。要对着真服务端跑:E2E_AMADEUS_API=<源,如 http://127.0.0.1:4010>(其下挂 /api/amadeus)。
 */
function startFakeCloud() {
  const rows = new Map() // path → { kind, body: Buffer, seq }
  let changeSeq = 0
  const kindOf = (p) => (/\.md$/i.test(p) ? 'page' : /\.db$/i.test(p) ? 'db' : 'binary')
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
  const put = (p, body, kind) => { const seq = (rows.get(p)?.seq ?? 0) + 1; rows.set(p, { kind, body, seq }); changeSeq++; return seq }
  /** 与服务端 CAS 同契约:0 = 仅创建,>0 = 必须等于现 seq;不符回 409 的 body,符合回 null。 */
  const casFail = (cur, baseSeq, extra) => {
    if (baseSeq === 0 && cur) return { code: 'EXISTS', seq: cur.seq, ...extra(cur) }
    if (baseSeq > 0 && (!cur || cur.seq !== baseSeq)) return { code: 'CONFLICT', seq: cur ? cur.seq : 0, ...(cur ? extra(cur) : {}) }
    return null
  }
  const srv = http.createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    try {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const raw = Buffer.concat(chunks)
      const u = new URL(req.url, 'http://fake')
      if (u.pathname === '/api/amadeus/vaults') return json(200, { vaults: [{ id: 'default', name: 'default', lastChangeSeq: changeSeq, sizeBytes: 0, createdAt: '2026-10-01T00:00:00Z' }] })
      const m = /^\/api\/amadeus\/vaults\/default\/([a-z-]+)$/.exec(u.pathname)
      const q = (k) => u.searchParams.get(k) || ''
      switch (m ? `${req.method} ${m[1]}` : '') {
        case 'GET tree': {
          const entries = [...rows].map(([path, r]) => ({ path, kind: r.kind, seq: r.seq, hash: sha(r.body), size: r.body.length }))
          const folders = new Set()
          for (const e of entries) for (let d = path.posix.dirname(e.path); d !== '.'; d = path.posix.dirname(d)) folders.add(d)
          return json(200, {
            pages: entries.filter((e) => e.kind === 'page').map((e) => e.path),
            files: entries.filter((e) => e.kind !== 'page').map((e) => ({ path: e.path, size: e.size })),
            folders: [...folders], entries, seq: changeSeq, maxFileBytes: 5 * 1024 * 1024,
          })
        }
        case 'GET file': {
          const r = rows.get(q('path'))
          if (!r) return json(404, { detail: 'file not found' })
          if (r.kind === 'binary') return json(400, { code: 'BINARY', detail: 'binary file: use GET /vaults/:v/asset' })
          return json(200, { path: q('path'), kind: r.kind, content: r.body.toString('utf8'), seq: r.seq, hash: sha(r.body), updatedAt: '2026-10-01T00:00:00Z' })
        }
        case 'PUT file': {
          const b = JSON.parse(raw.toString('utf8') || '{}')
          if (kindOf(String(b.path)) === 'binary') return json(400, { code: 'BINARY_PATH', detail: 'binary path: use POST /vaults/:v/binary' })
          const bad = b.force === true ? null : casFail(rows.get(b.path), Number(b.baseSeq), (cur) => ({ content: cur.body.toString('utf8') }))
          if (bad) return json(409, bad)
          const body = Buffer.from(String(b.content ?? ''), 'utf8')
          return json(200, { seq: put(b.path, body, kindOf(b.path)), hash: sha(body) })
        }
        case 'POST binary': {
          const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData()
          const p = String(form.get('path') ?? '')
          const file = form.get('file')
          if (!file || typeof file === 'string') return json(400, { detail: 'no file uploaded' })
          if (kindOf(p) !== 'binary') return json(400, { detail: 'text path (.md/.db): use PUT /vaults/:v/file' })
          const cur = rows.get(p)
          if (cur && !['', '0', 'false'].includes(String(form.get('ifAbsent') ?? '').toLowerCase())) return json(409, { code: 'EXISTS' })
          const base = String(form.get('baseSeq') ?? '').trim()
          const bad = base === '' ? null : casFail(cur, Number(base), (c) => ({ hash: sha(c.body) }))
          if (bad) return json(409, bad)
          const body = Buffer.from(await file.arrayBuffer())
          return json(200, { path: p, size: body.length, seq: put(p, body, 'binary') })
        }
        case 'GET asset': {
          const rawRef = q('ref')
          if (!rawRef) return json(400, { detail: 'ref required' })
          const ref = rawRef.replace(/\/+$/, '')
          let r = rows.get(ref)
          if (!r && !rawRef.includes('/')) {
            const hit = [...rows.keys()].sort().find((k) => !k.split('/').some((s) => s.startsWith('.')) && k.split('/').pop().toLowerCase() === ref.toLowerCase())
            r = hit && rows.get(hit)
          }
          if (!r) return json(404, { detail: 'asset not found' })
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(r.body.length) })
          return res.end(r.body)
        }
        default:
          return json(404, { detail: 'not found' })
      }
    } catch (e) {
      json(500, { detail: String(e && e.message ? e.message : e) })
    }
  })
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections(); srv.close() } })))
}

async function zipOf(entries) {
  const z = new JSZip()
  for (const [n, c] of Object.entries(entries)) z.file(n, c)
  return Buffer.from(await z.generateAsync({ type: 'uint8array' }))
}

async function main() {
  const root = path.resolve(__dirname, '..')
  if (!fs.existsSync(path.join(root, 'dist/index.html'))) {
    console.error('✗ 没有 dist/,先跑 npm run build')
    process.exit(1)
  }
  // 端口上已经有服务 = 同机另一个检出正在跑这台架:接上去测到的是那边的构建(2026-10-09 实遇:修好的桥测出一片 400)。
  if (await ping()) {
    console.error(`✗ ${PORT} 已有服务在听(别的会话在跑同一台架?)。换一个端口:E2E_PORT=<端口> npm run e2e:plugins`)
    process.exit(1)
  }
  fs.mkdirSync(SHOTS, { recursive: true })
  const zips = {
    [PLUGIN_ID]: await zipOf({
      // 包一层目录 + macOS 垃圾:顺带验重定根(真实 GitHub archive 就长这样)
      [`${PLUGIN_ID}-main/manifest.json`]: JSON.stringify({ id: PLUGIN_ID, name: 'E2E Hello', version: '1.0.0', apiVersion: 1 }),
      [`${PLUGIN_ID}-main/main.js`]: PLUGIN_MAIN,
      [`${PLUGIN_ID}-main/spaces/desk/space.json`]: SPACE_JSON,
      '__MACOSX/._main.js': 'junk',
    }),
    [DESK_ID]: await zipOf({
      'manifest.json': JSON.stringify({ id: DESK_ID, name: 'E2E Desk', version: '1.0.0', apiVersion: 1, isDesktopOnly: true }),
      'main.js': 'ctx.registerCommand({ id: "x", title: "x", run() {} })',
    }),
  }

  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: root, stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  })
  let previewErr = ''
  preview.stderr.on('data', (d) => { previewErr += String(d) })
  const killPreview = () => {
    try { process.kill(-preview.pid, 'SIGTERM') } catch { try { preview.kill() } catch { /* 已退出 */ } }
  }

  // 云端库:缺省 = 本脚本的假云端库;E2E_AMADEUS_API 指到真服务端时不起假的(那边的库 id 现问)。
  const fake = process.env.E2E_AMADEUS_API ? null : await startFakeCloud()
  const cloudApi = `${(process.env.E2E_AMADEUS_API || fake.origin).replace(/\/+$/, '')}/api/amadeus`
  let cloudVault = 'default'
  const cloudTree = async () => (await fetch(`${cloudApi}/vaults/${cloudVault}/tree`)).json()
  /** 「别的设备传上来的」文件:走二进制端点(桌面同步引擎对非 .md / .db 就是这么传的)。 */
  const cloudSeed = async (p, text) => {
    const form = new FormData()
    form.set('path', p)
    form.set('file', new Blob([Buffer.from(text)]), path.basename(p))
    const r = await fetch(`${cloudApi}/vaults/${cloudVault}/binary`, { method: 'POST', body: form })
    if (!r.ok) throw new Error(`种子文件没写进云端库: ${p} → ${r.status} ${await r.text()}`)
  }

  let browser = null
  let page = null
  const fails = []
  const pageErrors = []
  const marketQueries = []
  const installAsked = []
  const pass = (name, extra) => console.log(`PASS  ${name}${extra ? `  | ${extra}` : ''}`)
  const fail = (name, extra) => { fails.push(name); console.log(`FAIL  ${name}${extra ? `  | ${extra}` : ''}`) }
  const check = (ok, name, extra) => (ok ? pass(name, extra) : fail(name, extra))
  try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await ping()
    }
    if (!up) throw new Error(`vite preview 没起来(${PORT} 被占?)\n${previewErr.slice(-800) || '(无 stderr)'}`)

    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })
    // ⚠️ 语言钉 zh-CN 必须走 context/page 的 locale(chromium --lang 对浏览器台架无效)
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'zh-CN' })
    await ctx.addInitScript(() => { try { localStorage.setItem('forsion_tangu_onboarding_done', '1') } catch { /* ignore */ } })
    await ctx.addInitScript(() => { try { localStorage.setItem('forsion_token', 'e2e-plugins') } catch { /* ignore */ } })
    page = await ctx.newPage()
    page.on('pageerror', (e) => pageErrors.push(e.message))
    // 配方被渲染层拒收时只有一行控制台警告(`[spaces] 跳过 <slug>: 原因`)—— Space 没出现时把它打出来。
    const spaceWarnings = []
    page.on('console', (m) => { if (/^\[spaces\]/.test(m.text())) spaceWarnings.push(m.text()) })
    page.on('dialog', (d) => { void d.accept() }) // 卸载确认
    await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"e2e"}' }))
    await page.route('**/api/**', (r) => r.abort())
    // ⚠️ 后注册先匹配:假市场必须写在 abort 之后。
    await page.route('**/api/market/**', (r) => {
      const u = new URL(r.request().url())
      const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      let m
      if (u.pathname === '/api/market/items') {
        const type = u.searchParams.get('type')
        marketQueries.push(type || '(all)')
        return json({ items: CARDS.filter((c) => !type || c.type === type) })
      }
      if ((m = /^\/api\/market\/items\/([^/]+)\/install$/.exec(u.pathname))) {
        installAsked.push(m[1])
        return json({ type: 'amadeus-plugin', installSlug: m[1], downloadUrl: `${CDN}/${m[1]}.zip`, source: 'zip' })
      }
      if ((m = /^\/api\/market\/items\/([^/]+)$/.exec(u.pathname))) {
        const c = CARDS.find((x) => x.id === m[1])
        return c ? json({ ...c, readme: `# ${c.name}` }) : json({}, 404)
      }
      return json({}, 404)
    })
    // 云端库:/api/amadeus/** 原样转给假云端库(或 E2E_AMADEUS_API)。用 continue 改地址而不是在这里应答 ——
    // 二进制上传是带 Blob 的 multipart,Playwright 的路由回调拿不到那种请求体。
    cloudVault = (await (await fetch(`${cloudApi}/vaults`)).json()).vaults[0].id
    await cloudSeed(SEEDED_PATH, SEEDED_TEXT)
    await cloudSeed(`e2e-seeded/${BARE_NAME}`, 'OTHER')
    await page.route('**/api/amadeus/**', (r) => {
      const u = new URL(r.request().url())
      return r.continue({ url: `${cloudApi}${u.pathname.replace(/^.*?\/api\/amadeus/, '')}${u.search}` })
    })
    await page.route(`${CDN}/**`, (r) => {
      const id = path.basename(new URL(r.request().url()).pathname, '.zip')
      const body = zips[id]
      return body
        ? r.fulfill({ status: 200, body, headers: { 'content-type': 'application/zip', 'access-control-allow-origin': '*', 'content-length': String(body.length) } })
        : r.fulfill({ status: 404, body: 'no' })
    })
    if (NEGATIVE) {
      // 负对照:CSP 去掉 'unsafe-eval' —— 插件求值(new Function)必须被拦下。
      await page.route(APP_URL, async (r) => {
        const res = await r.fetch()
        const raw = await res.text()
        // 只改 meta 里 script-src 那一段(index.html 的注释里也写着 'unsafe-eval',全局替换第一处会改错地方)
        const html = raw.replace(/(script-src[^;"]*?) 'unsafe-eval'/, '$1')
        await r.fulfill({ response: res, body: html })
      })
    }

    // body zoom:1.15 下 Playwright 的可点性判定失真 → 套件口径:CDP 触摸打 boundingBox 中心。
    const cdp = await ctx.newCDPSession(page)
    const tap = async (locator, what) => {
      await locator.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
      await locator.first().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {}) // 折叠线以下的目标:触摸打不到视口外
      await page.waitForTimeout(150)
      const b = await locator.first().boundingBox({ timeout: 5000 })
      if (!b) throw new Error(`目标不可见: ${what}`)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] })
      await new Promise((r) => setTimeout(r, 60))
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(500)
    }
    const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${NEGATIVE ? 'neg-' : ''}${name}.png`) })
    const boot = async () => {
      await page.waitForSelector('.mb-topbar [aria-label="more"]', { timeout: 30_000 })
      await page.waitForTimeout(2500)
    }
    const openMore = async (ribbonId) => {
      // 从左抽屉底部进的设置,关掉后回到的还是开着的抽屉,它盖住顶栏的「⋯」—— 先收起(被推到右边的那颗左栏钮还点得到)。
      if (await page.locator('.mb-drawer--left.open').count()) await tap(page.locator('.mb-topbar [aria-label="left panel"]'), '收起左抽屉')
      await tap(page.locator('.mb-topbar [aria-label="more"]'), '「⋯」')
      await tap(page.locator(`.mb-sheet [data-ribbon-id="${ribbonId}"]`), ribbonId)
    }
    /** 命令面板里有没有插件命令(不运行)。 */
    const commandListed = async () => {
      await openMore('rb-cmd')
      await page.locator('.cmd-panel input').fill('e2eplugin')
      await page.waitForTimeout(300)
      const n = await page.locator(`.cmd-panel [data-command-id="${CMD_ID}"]`).count()
      return n > 0
    }
    const runCommand = async () => {
      if (!(await commandListed())) return false
      await tap(page.locator(`.cmd-panel [data-command-id="${CMD_ID}"]`), '插件命令')
      return true
    }
    const closePalette = async () => { if (await page.locator('.cmd-panel').count()) await page.keyboard.press('Escape'); await page.waitForTimeout(300) }
    const viewRuns = async () => {
      const el = page.locator('[data-e2e-plugin-view]').first()
      try { await el.waitFor({ state: 'visible', timeout: 6000 }) } catch { return null }
      return el.getAttribute('data-e2e-runs')
    }
    /** Space 条(左抽屉底部)里有没有这个 Space。抽屉合着时 Space 条不在 DOM 里 → 先把抽屉打开
     *  (盖在上面的设置页不碍事:抽屉在它底下照样挂着)。防空过:条上至少得有内置的那几个。 */
    const spaceTab = page.locator(`.mb-spacebar [data-space="${SPACE_ID}"]`)
    const spaceListed = async () => {
      if (!(await page.locator('.mb-drawer--left.open').count())) await tap(page.locator('.mb-topbar [aria-label="left panel"]'), '左抽屉')
      const builtin = await page.locator('.mb-spacebar [data-space]').count()
      if (builtin < 2) throw new Error(`Space 条不在 DOM 里(只数到 ${builtin} 格),这一问答不了`)
      return (await spaceTab.count()) > 0
    }
    const hostState = () => page.evaluate(async (id) => ({
      listed: (await window.amadeus.listPlugins()).filter((p) => p.id === id).length,
      installed: (await window.tangu.marketInstalled())['amadeus-plugin'].map((x) => x.slug),
    }), PLUGIN_ID)

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await boot()
    // 页面实际生效的 script-src(负对照下必须没有 'unsafe-eval',否则「红」不成立)。
    // ⚠️ 别在 page.evaluate 里试 new Function 判断:CDP 求值不受页面 CSP 约束,恒为放行。
    const scriptSrc = await page.evaluate(() => (/script-src[^;]*/.exec(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') || '') || [''])[0])
    console.log(`      CSP: ${scriptSrc}`)
    if (NEGATIVE && scriptSrc.includes('unsafe-eval')) fail('负对照未生效(CSP 仍含 unsafe-eval)')

    // 1. 市场入口与范围
    await openMore('rb-market')
    const marketOpen = await page.locator('[data-mobile-market]').waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false)
    check(marketOpen, '「⋯」→ 市场 全屏打开')
    await page.locator(`[data-market-install="${PLUGIN_ID}"]`).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
    check(marketQueries.length > 0 && marketQueries.every((q) => q === 'amadeus-plugin'), '市场只请求可装类型(amadeus-plugin)', marketQueries.join(','))
    check(await page.locator('[data-market-scope-hint]').count() > 0, '市场显示「只列本机可装」说明')
    await shot('market-discover')

    // 2. 安装 → 不刷新即启用 → 命令 / 视图 / saveData
    await tap(page.locator(`[data-market-install="${PLUGIN_ID}"]`), '安装 E2E Hello')
    await page.locator(`[data-market-notice]`).waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
    const notice1 = await page.locator('[data-market-notice]').getAttribute('data-market-notice').catch(() => null)
    check(notice1 === 'ok', '安装成功提示', `${notice1}: ${(await page.locator('[data-market-notice]').innerText().catch(() => '')).trim()}`)
    await shot('market-installed')
    const s1 = await hostState()
    check(s1.listed === 1 && s1.installed.includes(PLUGIN_ID), '插件已落盘并被宿主列出', JSON.stringify(s1))
    await tap(page.locator('[data-mobile-market] .settings-back').first(), '关闭市场')
    await page.waitForTimeout(600)
    const ran1 = await runCommand()
    check(ran1, '不刷新:插件命令已进命令面板')
    const runs1 = ran1 ? await viewRuns() : null
    check(runs1 === '1', '运行命令 → 打开插件视图(锚点在、saveData 写入 runs=1)', `runs=${runs1}`)
    if (!ran1) await closePalette()
    await shot('plugin-view')

    // 2b. 包里带的 Space:宿主读得出配方 → 不刷新就进 Space 条 → 切过去,主区是配方点名的插件视图
    const recipes = await page.evaluate(async () => {
      const list = await window.tangu.spacesList?.()
      return Array.isArray(list) ? list.map((s) => `${s.plugin}/${s.slug}`) : null
    })
    check(Array.isArray(recipes) && recipes.includes(`${PLUGIN_ID}/desk`), '宿主列出插件包里的 Space 配方', JSON.stringify(recipes))
    const listed1 = await spaceListed()
    check(listed1, '不刷新:插件带的 Space 进了 Space 条', spaceWarnings.join(' | '))
    if (listed1) {
      await tap(spaceTab, '插件 Space')
      const active = await page.locator('.mb-shell').getAttribute('data-space')
      const mainView = await page.locator('.mb-main [data-e2e-plugin-view]').count()
      check(active === SPACE_ID && mainView > 0, '切到插件 Space:主区是配方点名的插件视图', `data-space=${active} 视图 ${mainView}`)
      await shot('plugin-space')
    }

    // 2c. 云端库下的旁挂文件(插件的索引 / 缓存 / 快照:点开头的 .json)。防空过:探针是插件代码自己挂的,没跑就没有。
    const vaultSide = await page.evaluate(() => window.amadeusVaultMode && window.amadeusVaultMode.side)
    check(vaultSide === 'cloud', '手机缺省用的是云端库', String(vaultSide))
    const sc = await page.evaluate(() => (window.__e2eSidecar ? window.__e2eSidecar() : null))
    if (!sc) fail('旁挂文件探针没挂上(插件代码没跑起来)')
    else {
      const J = JSON.stringify
      const entries = (await cloudTree()).entries
      const idxRow = entries.find((e) => e.path.endsWith('/.e2e-index.json'))
      const noteRow = entries.find((e) => e.path.endsWith('/e2e-note.md'))
      check(sc.write.ok && sc.rewrite.ok, '云端库:插件 writeFile 写旁挂 .json(新建 + 覆盖)', J([sc.write, sc.rewrite]))
      check(sc.read.v === '{"n":2}', '云端库:readFile 读回最后一次写的内容', J(sc.read))
      check(!!idxRow && idxRow.kind === 'binary' && idxRow.seq === 2, '云端那一行是二进制行、写了两版(桌面同步引擎传上去的也是这种行)', J(idxRow))
      check(sc.seeded.v === SEEDED_TEXT, '云端库:读得到别的设备传上去的旁挂文件', J(sc.seeded))
      check(sc.missing.ok && sc.missing.v === null, '云端库:文件不存在 → readFile 给 null(不抛)', J(sc.missing))
      check(sc.bare.ok && sc.bare.v === null, '云端库:库根下不存在的文件,不会读成别的目录里的同名文件', J(sc.bare))
      check(sc.bytes.v === SEEDED_TEXT, '云端库:readBytes 读得到字节', J(sc.bytes))
      check(sc.note.v === '# e2e' && !!noteRow && noteRow.kind === 'page', '云端库:.md 照旧走文本端点(文本行)', J([sc.note, noteRow]))
    }

    // 3. 刷新:插件仍启用;数据跨重载
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    await boot()
    const ran2 = await runCommand()
    check(ran2, '刷新后插件仍启用(命令仍在)')
    const runs2 = ran2 ? await viewRuns() : null
    check(runs2 === '2', '刷新后 loadData 读回上次写的数据(runs=2)', `runs=${runs2}`)
    if (!ran2) await closePalette()
    check(await spaceListed(), '刷新后插件带的 Space 仍在 Space 条')

    // 4. isDesktopOnly → 拒装,本地化原因,不落盘
    await openMore('rb-market')
    await page.locator(`[data-market-install="${DESK_ID}"]`).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
    await tap(page.locator(`[data-market-install="${DESK_ID}"]`), '安装 E2E Desk')
    await page.locator('[data-market-notice="error"]').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
    const deskText = (await page.locator('[data-market-notice="error"]').innerText().catch(() => '')).trim()
    check(deskText.includes(DESK_REASON_ZH), '仅桌面插件被拒,提示本地化原因', deskText.replace(/\s+/g, ' '))
    const deskState = await page.evaluate(async (id) => (await window.tangu.marketInstalled())['amadeus-plugin'].map((x) => x.slug).includes(id), DESK_ID)
    check(!deskState, '仅桌面插件没有落盘')
    await shot('market-desktop-only')
    // 4b. 商店自己就标了「仅桌面」的:卡片带标记,安装键置灰并写明原因,点了也不去要下载地址
    const flagged = page.locator(`[data-market-install="${FLAGGED_ID}"]`).first()
    await flagged.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
    const flaggedState = await flagged.evaluate((b) => ({ disabled: b.disabled, state: b.dataset.installState, text: b.textContent.trim() })).catch(() => null)
    check(flaggedState && flaggedState.disabled && flaggedState.state === 'desktop-only' && flaggedState.text === '仅桌面可用', '商店标了仅桌面的插件:安装键置灰并写明', JSON.stringify(flaggedState))
    check(await page.locator(`[data-market-desktop-only="${FLAGGED_ID}"]`).first().isVisible().catch(() => false), '商店标了仅桌面的插件:卡片带「仅桌面」标记')
    // 首页会把同一项在不止一个分区里各画一张卡片:数的是「标记都在谁身上」,不是标记有几枚
    const badged = await page.locator('[data-market-desktop-only]').evaluateAll((els) => els.map((e) => e.dataset.marketDesktopOnly))
    check(badged.length > 0 && badged.every((id) => id === FLAGGED_ID), '没标的插件不带这枚标记', badged.join(','))
    const chips = await page.locator('.mk-card', { has: flagged }).first().locator('.mk-tags span').allInnerTexts().catch(() => null)
    check(Array.isArray(chips) && chips.includes('e2e-tag') && !chips.includes('desktop-only'), '保留标签不当普通标签再显示一遍,别的标签照常', JSON.stringify(chips))
    await flagged.click({ force: true, timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(600)
    check(!installAsked.includes(FLAGGED_ID), '置灰的安装键点了不发请求', installAsked.join(','))
    await shot('market-desktop-only-flagged')
    await tap(page.locator('[data-mobile-market] .settings-back').first(), '关闭市场')

    // 5. 设置 → 插件:关掉 → 贡献撤下;卸载 → 文件没了
    const row = page.locator(`[data-plugin-id="${PLUGIN_ID}"]`)
    /** 抽屉 → 设置 → 插件 → Forsion 插件(设置会记住上次的页 / 展开态:已在目标页就不再点)。 */
    const openPluginSettings = async () => {
      await tap(page.locator('.mb-topbar [aria-label="left panel"]'), '左抽屉')
      await tap(page.locator('.mb-drawer--left.open .mb-foot-row .mb-icon-btn[aria-label="settings"]'), '设置钮')
      if (await row.first().isVisible().catch(() => false)) return
      if (!(await page.locator('[data-settings-sub="pl-forsion"]').first().isVisible().catch(() => false))) {
        await tap(page.locator('[data-settings-tab="amadeus-plugins"]'), '插件 一级项')
      }
      await tap(page.locator('[data-settings-sub="pl-forsion"]'), 'Forsion 插件 子项')
      await row.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
    }
    await openPluginSettings()
    await shot('settings-plugins')
    // 防空过:关之前插件视图必须在(设置盖在上面,视图仍挂在 DOM 里),否则下面的「被撤下」恒绿。
    const viewBefore = await page.locator('[data-e2e-plugin-view]').count()
    check(viewBefore > 0, '关之前插件视图仍挂着(防空过)', `有 ${viewBefore}`)
    const spaceBefore = await spaceListed() // 防空过:关之前它得在条上
    await tap(row.locator('input[type="checkbox"]'), '插件开关')
    const offChecked = await row.locator('input[type="checkbox"]').first().isChecked().catch(() => null)
    check(offChecked === false, '设置里关掉插件')
    const stillView = await page.locator('[data-e2e-plugin-view]').count()
    check(stillView === 0, '关掉后插件视图被撤下', `剩 ${stillView}`)
    check(spaceBefore && !(await spaceListed()), '关掉后它的 Space 从 Space 条撤下', `关之前在条上:${spaceBefore}`)
    await tap(page.locator('.settings-mobile-detail-head button').last(), '关闭设置')
    const listedOff = await commandListed()
    check(!listedOff, '关掉后命令从命令面板撤下(不刷新)')
    await closePalette()
    await openPluginSettings()
    await tap(row, '插件详情')
    await tap(page.locator('[data-plugin-uninstall]'), '卸载')
    await page.waitForTimeout(800)
    const s2 = await hostState()
    check(s2.listed === 0 && !s2.installed.includes(PLUGIN_ID), '卸载后文件没了(listPlugins / marketInstalled 都看不到)', JSON.stringify(s2))
    await page.keyboard.press('Escape').catch(() => {})
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    await boot()
    const listedAfter = await commandListed()
    check(!listedAfter, '卸载并刷新后命令不再出现')
    await closePalette()

    const evalErr = pageErrors.filter((m) => /unsafe-eval|EvalError|Content Security Policy/i.test(m))
    if (evalErr.length) console.log(`      页面错误(CSP): ${evalErr[0].slice(0, 200)}`)
  } catch (e) {
    fail('台架异常', String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e))
    if (page) await page.screenshot({ path: path.join(SHOTS, 'exception.png') }).catch(() => {}) // 抛错那一刻页面长什么样
  } finally {
    if (browser) await browser.close().catch(() => {})
    killPreview()
    if (fake) fake.close()
  }
  console.log(`\n${fails.length ? `✗ ${fails.length} 项失败` : '✓ 全部通过'}${NEGATIVE ? '(负对照模式:期望红)' : ''}`)
  process.exit(fails.length ? 1 : 0)
}

main()
