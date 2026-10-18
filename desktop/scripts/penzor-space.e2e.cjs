/**
 * 蓬洲云 Space(Forsion Extend 0.10)× 真 Electron × 桩引擎 × 本机假云端:宿主接缝与 Extend 的蓬洲云接在一起能不能用。
 * 假云端只回蓬洲云要的那几条接口(四本账 + 文件表 + 回收站,删除 / 恢复有状态),数字照方案页
 * (docs/ToBeImproved/蓬洲云Space方案_2026-10-18)。服务端自己的逻辑由 server 仓的 PGlite 测试钉,这里不重复。
 *
 * 钉住:
 *  ① Ribbon 上有「蓬洲云」,点开先是概览(总量 / 四张账卡 / 占用最多),右栏收起(closeView collapse 接缝);
 *  ② 左栏位置树点同步库 → 主区文件表 + 右栏详情,同步库只给下载、右栏写明为什么;
 *  ③ 应用文件右键 → 宿主 .ctx-menu「移到回收站」→ 不弹确认、吐司、回收站多一项;回收站里恢复;
 *  ④ 设置 › 同步 › 远程同步:下拉项叫「蓬洲云 Penzor Cloud(推荐)」,「在蓬洲云中查看 WMOSv11」把主窗切过来停在那个库;
 *  ⑤ 云端说 401 → 登录页。
 * 截图在 $SHOTS_DIR(缺省系统临时目录下 forsion-penzor-space-shots/),交付前人眼看一遍。
 *
 * 需先 npm run build(读 out/)。用法:EXTEND_PKG=<已 build + sign 的 Forsion-Extend 检出> npm run e2e:penzor
 * 走查用:PENZOR_HOLD=1 摆好(假云端 + 上传限速)就停住、不跑断言,窗口关掉 / 退出才收场;配 STAGE_ELECTRON=<单独一份 Electron.app>/Contents/MacOS/Electron,
 * computer use 按应用认窗口,别和正开着的 dev 混(见 gui-verify §4.2)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.join(__dirname, '..')
const EXTEND = process.env.EXTEND_PKG
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'forsion-penzor-space-shots')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

function installExtend(home) {
  const pkg = JSON.parse(fs.readFileSync(path.join(EXTEND, 'package.json'), 'utf8'))
  const dest = path.join(home, 'plugins', 'forsion-extend')
  for (const f of ['package.json', ...pkg.files]) {
    fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true })
    fs.copyFileSync(path.join(EXTEND, f), path.join(dest, f))
  }
  return pkg.version
}

// ── 本机假云端 ────────────────────────────────────────────────────────────────
const MB = 1024 * 1024
const now = Date.now()
const ago = (min) => now - min * 60_000
const day = (d, h = 12) => { const x = new Date(now); x.setDate(x.getDate() - d); x.setHours(h, 0, 0, 0); return x.getTime() }
function startFakeCloud() {
  const st = { signedOut: false, hits: [], quota: 10240 * MB, throttle: false, uploads: [], badLength: 0 }
  let seq = 0
  const appFiles = {
    'ai-studio': [
      { id: 'd-poster', name: '海报', fileType: 'directory', fileSize: 0, updatedAt: day(3), parentId: 'ROOT' },
      { id: 'd-char', name: '角色立绘', fileType: 'directory', fileSize: 0, updatedAt: day(5), parentId: 'ROOT' },
      { id: 'd-ref', name: '参考图', fileType: 'directory', fileSize: 0, updatedAt: day(16), parentId: 'ROOT' },
      { id: 'f-v3', name: '海报_v3_4k.png', fileType: 'file', fileSize: 31.2 * MB, updatedAt: day(3), parentId: 'ROOT' },
      { id: 'f-v2', name: '海报_v2.png', fileType: 'file', fileSize: 18.7 * MB, updatedAt: day(6), parentId: 'ROOT' },
      { id: 'f-logo', name: 'logo 草稿.svg', fileType: 'file', fileSize: 86 * 1024, updatedAt: day(9), parentId: 'ROOT' },
      { id: 'f-prompt', name: 'prompt 记录.txt', fileType: 'file', fileSize: 12 * 1024, updatedAt: day(9, 10), parentId: 'ROOT' },
    ],
    penzor: [], // 我的云盘:装好是空的,下面的场景往里传
  }
  const driveBytes = () => appFiles.penzor.filter((f) => f.fileType === 'file').reduce((n, f) => n + f.fileSize, 0)
  const trash = [
    { id: 't-avatar', appId: 'notebase', parentId: 'ROOT', parentName: null, name: '旧版头像.png', fileType: 'file', fileSize: 2.1 * MB, deletedAt: day(7) },
    { id: 't-sketch', appId: 'photo-studio', parentId: 'ROOT', parentName: null, name: '草图 第一版', fileType: 'directory', fileSize: 0, deletedAt: day(12) },
    { id: 't-sketch1', appId: 'photo-studio', parentId: 't-sketch', parentName: '草图 第一版', name: '1.png', fileType: 'file', fileSize: 64 * MB, deletedAt: day(12) },
    { id: 't-mood', appId: 'ai-studio', parentId: 'd-ref', parentName: '参考图', name: 'moodboard.png', fileType: 'file', fileSize: 9.4 * MB, deletedAt: day(18) },
  ]
  const wmos = [
    ...Array.from({ length: 38 }, (_, i) => ({ path: `论文/p${i}.pdf`, size: 8.2 * MB, mtimeMs: ago(30 + i), device: 'MacBook Pro' })),
    ...Array.from({ length: 24 }, (_, i) => ({ path: `附件/a${i}.png`, size: 21 * MB, mtimeMs: ago(60 + i), device: '公司 iMac' })),
    ...Array.from({ length: 12 }, (_, i) => ({ path: `日记/2026-10-${String(i + 1).padStart(2, '0')}.md`, size: 0.8 * MB, mtimeMs: day(1, 23), device: 'MacBook Pro' })),
    { path: '组会 10-16.pdf', size: 3.1 * MB, mtimeMs: ago(3), device: 'MacBook Pro' },
    { path: 'WMOS 架构图.png', size: 2.4 * MB, mtimeMs: ago(55), device: 'MacBook Pro' },
    { path: 'WMOS 演示录屏.mov', size: 48.6 * MB, mtimeMs: day(1, 21), device: '公司 iMac' },
    { path: 'Penzor 同步协议.md', size: 18 * 1024, mtimeMs: day(2), device: 'MacBook Pro' },
    { path: '读书清单.md', size: 4 * 1024, mtimeMs: day(3), device: '公司 iMac' },
  ].map((f, i) => ({ ...f, hash: `h${i}`, seq: 1 }))
  const exportsList = Array.from({ length: 18 }, (_, i) => ({ fileId: `e${i}`, fileName: i === 0 ? '周会纪要.pdf' : i === 1 ? '对话导出_2026-10.zip' : `导出 ${i}.md`, size: i === 1 ? 12 * MB : i === 0 ? 1.2 * MB : 1.8 * MB, createdAt: new Date(day(i + 1)).toISOString(), appId: 'chat' }))
  const appTotals = () => {
    const live = appFiles['ai-studio'].filter((f) => f.fileType === 'file').reduce((n, f) => n + f.fileSize, 0)
    return [
      { appId: 'ai-studio', bytes: 1160 * MB + live, files: 214, trashBytes: 9.4 * MB, trashFiles: 1 },
      { appId: 'photo-studio', bytes: 642 * MB, files: 88, trashBytes: 64 * MB, trashFiles: 2 },
      { appId: 'notebase', bytes: 34 * MB, files: 41, trashBytes: 2.1 * MB, trashFiles: 1 },
      { appId: 'penzor', bytes: driveBytes(), files: appFiles.penzor.filter((f) => f.fileType === 'file').length, trashBytes: 0, trashFiles: 0 },
    ]
  }
  // 上传那条要能「慢」下来(看卡片和进度环):throttle 开着时每块读完歇一下,靠 TCP 背压把客户端压慢
  const read = (req) => new Promise((resolve) => {
    const chunks = []
    req.on('data', (d) => { chunks.push(d); if (st.throttle) { req.pause(); setTimeout(() => req.resume(), 150) } })
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
  const server = http.createServer(async (req, res) => {
    const body = () => read(req)
    const u = new URL(req.url || '/', 'http://x')
    const p = u.pathname
    const src = String(req.headers['x-project-source'] || '')
    st.hits.push(`${req.method} ${p}${u.search}${src ? ` [${src}]` : ''}`)
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (st.signedOut) return json(401, { detail: 'Invalid or expired token' })
    if (p === '/api/brain/users/me') return json(200, { id: 'u1', username: 'demo', nickname: '演示' })
    if (p === '/api/remotesync/vaults') return json(200, {
      vaults: [
        { vault: 'WMOSv11', files: 4812, bytes: 1086 * MB, updatedAt: new Date(ago(3)).toISOString(), device: 'MacBook Pro', devices: ['MacBook Pro', '公司 iMac'] },
        { vault: 'default', files: 1204, bytes: 412 * MB, updatedAt: new Date(day(1)).toISOString(), device: '公司 iMac', devices: ['公司 iMac'] },
        { vault: 'papers', files: 96, bytes: 96 * MB, updatedAt: new Date(day(9)).toISOString(), device: null, devices: [] },
      ],
      usedBytes: 1594 * MB, diagnosticsBytes: 0, maxBytes: 2048 * MB, maxFileBytes: 50 * MB,
    })
    if (p === '/api/remotesync/vaults/WMOSv11/manifest') return json(200, { files: wmos })
    if (/^\/api\/remotesync\/vaults\/[^/]+\/manifest$/.test(p)) return json(200, { files: [] })
    if (p === '/api/amadeus/vaults') return json(200, { vaults: [{ id: 'a1', name: '我的云端笔记', sizeBytes: 718 * MB, role: 'owner' }] })
    if (p === '/api/amadeus/vaults/a1/tree') return json(200, { entries: [
      { path: '课题组/附件/课题组合影.heic', kind: 'binary', size: 22.4 * MB, updatedAt: new Date(day(1, 18)).toISOString() },
      { path: '课题组/10 月组会.md', kind: 'page', size: 12 * 1024, updatedAt: new Date(day(1, 18)).toISOString() },
      { path: '周计划.md', kind: 'page', size: 6 * 1024, updatedAt: new Date(ago(130)).toISOString() },
      { path: '读书笔记 · 原则.md', kind: 'page', size: 22 * 1024, updatedAt: new Date(day(4)).toISOString() },
    ] })
    if (p === '/api/amadeus/attachments') return json(200, { attachments: [{ vaultId: 'a1', vaultName: '我的云端笔记', path: '课题组/附件/课题组合影.heic', size: 22.4 * MB }], totalBytes: 22.4 * MB })
    if (p === '/api/storage/quota') return json(200, { used: 1916 * MB + driveBytes(), quota: st.quota, percentage: 18.7 })
    if (p === '/api/storage/files-by-app') return json(200, {
      apps: appTotals(),
      largest: [{ id: 'f-v3', appId: 'ai-studio', parentId: 'ROOT', name: '海报_v3_4k.png', size: 31.2 * MB }, { id: 'raw', appId: 'photo-studio', parentId: 'ROOT', name: '外景 RAW.dng', size: 24.8 * MB }].filter((f) => f.id !== 'f-v3' || appFiles['ai-studio'].some((x) => x.id === 'f-v3')),
    })
    if (p === '/api/files' && req.method === 'GET') {
      const pid = u.searchParams.get('parentId') || 'ROOT'
      return json(200, (appFiles[src] || []).filter((f) => f.parentId === pid).map((f) => ({ ...f, appId: src })))
    }
    if (p === '/api/files' && req.method === 'POST') { // 建文件夹:同名 409、不自动改名(同真 server)
      const b = JSON.parse(String(await body()) || '{}')
      const list = (appFiles[src] ||= [])
      const pid = b.parentId || 'ROOT'
      if (list.some((f) => f.parentId === pid && f.name === b.name && f.fileType === 'directory')) return json(409, { detail: 'Directory already exists', code: 'DIRECTORY_EXISTS' })
      const f = { id: `n${++seq}`, name: String(b.name), fileType: 'directory', fileSize: 0, updatedAt: Date.now(), parentId: pid }
      list.push(f)
      return json(201, { id: f.id })
    }
    if (p === '/api/files/upload' && req.method === 'POST') { // multipart:读 filename*(UTF-8)与 parentId;撞名按真 server 的「名 (1).扩展名」
      const raw = await body()
      if (Number(req.headers['content-length']) !== raw.length) st.badLength++
      const bd = String(req.headers['content-type'] || '').match(/boundary=(.+)$/)?.[1]
      const parts = raw.toString('latin1').split(`--${bd}`).slice(1, -1).map((x) => { const i = x.indexOf('\r\n\r\n'); return { h: x.slice(0, i), v: x.slice(i + 4, -2) } })
      const field = (n) => parts.find((x) => x.h.includes(`name="${n}"`) && !x.h.includes('filename'))?.v
      const file = parts.find((x) => /filename/.test(x.h))
      const star = file?.h.match(/filename\*=UTF-8''([^\r\n;]+)/)?.[1]
      let name = star ? decodeURIComponent(star) : 'unnamed'
      const size = file ? Buffer.byteLength(file.v, 'latin1') : 0
      const pid = field('parentId') || 'ROOT'
      if (1916 * MB + driveBytes() + size > st.quota) return json(400, { detail: 'Storage quota exceeded' })
      const list = (appFiles[src] ||= [])
      const taken = (n) => list.some((f) => f.parentId === pid && f.name === n)
      if (taken(name) && field('autoRename') !== 'false') {
        const dot = name.lastIndexOf('.'); const stem = dot > 0 ? name.slice(0, dot) : name; const ext = dot > 0 ? name.slice(dot) : ''
        let i = 1; while (taken(`${stem} (${i})${ext}`)) i++
        name = `${stem} (${i})${ext}`
      }
      const f = { id: `u${++seq}`, name, fileType: 'file', fileSize: size, updatedAt: Date.now(), parentId: pid }
      list.push(f)
      st.uploads.push({ name, size, parentId: pid, src })
      return json(201, { id: f.id, name })
    }
    if (p === '/api/files/batch/delete' && req.method === 'POST') {
      const { ids = [] } = JSON.parse(String(await body()) || '{}')
      const list = appFiles[src] || []
      return json(200, { results: ids.map((id) => {
        const i = list.findIndex((f) => f.id === id)
        if (i < 0) return { id, success: false }
        const [f] = list.splice(i, 1)
        trash.unshift({ id: f.id, appId: src, parentId: f.parentId, parentName: null, name: f.name, fileType: f.fileType, fileSize: f.fileSize, deletedAt: Date.now() })
        return { id, success: true }
      }) })
    }
    const fid = p.match(/^\/api\/files\/([^/]+)$/)
    if (fid && req.method === 'DELETE') {
      const list = appFiles[src] || []
      const i = list.findIndex((f) => f.id === decodeURIComponent(fid[1]))
      if (i < 0) return json(400, { detail: 'not found' })
      const [f] = list.splice(i, 1)
      trash.unshift({ id: f.id, appId: src, parentId: 'ROOT', parentName: null, name: f.name, fileType: f.fileType, fileSize: f.fileSize, deletedAt: Date.now() })
      return json(200, { success: true })
    }
    if (/^\/api\/files\/[^/]+\/versions$/.test(p)) return json(200, [3, 2, 1].map((n) => ({ versionNumber: n, fileSize: 30 * MB, createdAt: day(n * 2) })))
    if (p.startsWith('/api/exports/list')) return json(200, { files: exportsList, total: exportsList.length, totalBytes: 46 * MB, page: 1, pageSize: 500, totalPages: 1 })
    if (p === '/api/trash' && req.method === 'GET') return json(200, trash)
    const rest = p.match(/^\/api\/trash\/([^/]+)\/restore$/)
    if (rest && req.method === 'POST') {
      const i = trash.findIndex((t) => t.id === decodeURIComponent(rest[1]))
      if (i < 0) return json(400, { detail: 'not in trash' })
      const [t] = trash.splice(i, 1)
      if (t.appId === 'ai-studio') appFiles['ai-studio'].push({ id: t.id, name: t.name, fileType: t.fileType, fileSize: t.fileSize, updatedAt: Date.now(), parentId: 'ROOT' })
      return json(200, { id: t.id })
    }
    return json(404, { detail: 'not in fake cloud' })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ st, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })))
}

async function main() {
  if (!EXTEND || !fs.existsSync(path.join(EXTEND, 'spaces/penzor/space.json')) || !fs.existsSync(path.join(EXTEND, 'SIGNATURE'))) {
    console.error('EXTEND_PKG 要指向一份 build + sign 过的 Forsion-Extend 检出(带 spaces/penzor/space.json 和 SIGNATURE)')
    process.exit(2)
  }
  fs.mkdirSync(SHOTS, { recursive: true })
  const cloud = await startFakeCloud()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-penzor-e2e-'))
  const vault = path.join(home, 'Vault')
  fs.mkdirSync(vault, { recursive: true })
  fs.writeFileSync(path.join(vault, '欢迎.md'), '# 欢迎\n')
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ cloudUrl: cloud.url, token: 'fake-token' }))
  const userData = path.join(home, 'userdata')
  installExtend(home)
  const stub = await startStubEngine({ models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna', provider: 'stub', source: 'forsion' }] })
  for (const d of [userData, `${userData}-dev`]) {
    fs.mkdirSync(d, { recursive: true })
    for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) fs.writeFileSync(path.join(d, f), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2))
    for (const f of ['remotesync.json', 'remotesync.dev.json']) fs.writeFileSync(path.join(d, f), JSON.stringify({ backend: 'penzor', penzor: { vault: 'WMOSv11' } }, null, 2))
    fs.writeFileSync(path.join(d, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'mock', cloudUrl: cloud.url }))
  }
  const app = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
    ...(process.env.STAGE_ELECTRON ? { executablePath: process.env.STAGE_ELECTRON } : {}),
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1', PI_CU_SOCKET_PATH: path.join(home, 'bridge.sock') },
    timeout: 90_000,
  })
  const errors = []
  try {
    const win = await app.firstWindow({ timeout: 120_000 })
    win.on('console', (m) => { if (m.type() === 'error' && /penzor|pz-/i.test(m.text())) errors.push(m.text()) })
    win.on('pageerror', (e) => errors.push(String(e)))
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1512, 950) })
    await win.waitForSelector('#root', { timeout: 30_000 })
    check('首启引导点掉', await skipOnboarding(win))
    if (process.env.PENZOR_HOLD) {
      cloud.st.throttle = true
      // 「踢一下」:往 <home>/kick 写几行本机路径 = 在「上传」里选了它们(computer use 在后台点不动系统的选文件框)
      const kick = path.join(home, 'kick')
      const timer = setInterval(() => {
        if (!fs.existsSync(kick)) return
        const files = fs.readFileSync(kick, 'utf8').split('\n').filter(Boolean)
        fs.rmSync(kick)
        win.locator('.pz input[type=file][multiple]').setInputFiles(files).catch((e) => console.log('kick failed', e.message))
      }, 1000)
      console.log(`HOLD ready · kick=${kick} · 窗口关掉或退出就收场`)
      await new Promise((r) => { app.process().once('exit', r); setTimeout(r, 40 * 60_000) })
      clearInterval(timer)
      return
    }
    const shot = async (name, page = win) => { await page.mouse.move(1000, 5).catch(() => {}); await page.waitForTimeout(500); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); console.log('shot', name) }
    const setMode = (mode, skin) => win.evaluate(([m, s]) => { const r = document.documentElement; r.dataset.mode = m; r.classList.toggle('dark', m === 'dark'); if (s) r.dataset.skin = s; else delete r.dataset.skin }, [mode, skin || null])
    const sideWidth = () => win.evaluate(() => { const e = document.querySelector('.pz-side'); return e ? Math.round(e.getBoundingClientRect().width) : 0 })

    // ① Ribbon → 概览,右栏收起
    const btn = win.locator('.rb [aria-label="蓬洲云"]').first()
    await win.waitForTimeout(1500)
    if (!(await btn.count())) await win.locator('.rb-more[data-rb-more="top"]').click().catch(() => {})
    await btn.waitFor({ timeout: 20_000 }).catch(() => {})
    check('① Ribbon 上有「蓬洲云」', await btn.count() > 0)
    await btn.click().catch(() => {})
    await win.evaluate(() => document.querySelector('.rb-open-top .rb-more')?.click())
    await win.waitForSelector('.pz-total', { timeout: 20_000 }).catch(() => {})
    const total = await win.locator('.pz-total b').textContent().catch(() => '')
    check('① 打开就是概览:总量 4.17 GB(四本相加)', total === '4.17 GB', total)
    check('① 四张账卡', await win.locator('.pz-card').count() === 4)
    await win.waitForFunction(() => document.querySelectorAll('.pz-rows .row').length >= 6, null, { timeout: 10_000 }).catch(() => {})
    const top = await win.locator('.pz-rows .row .t').allTextContents()
    check('① 占用最多:四本账一起排,第一是 WMOS 演示录屏.mov', /^WMOS 演示录屏\.mov/.test(top[0] || ''), top.slice(0, 3).join(' | '))
    await win.waitForTimeout(900)
    check('① 概览时右栏收起(不是空占位)', (await sideWidth()) < 40 && !(await win.locator('.dv-groupview .sidebar-empty, [data-view-type="sidebar-empty"]').count()), `side=${await sideWidth()}`)
    await setMode('light'); await shot('overview')
    await setMode('dark'); await shot('overview-dark'); await setMode('light')

    // ② 同步库:展开组头 → 点 WMOSv11
    for (const [folder, child] of [['设备同步', 'WMOSv11'], ['应用文件', 'AI Studio'], ['Amadeus Cloud', '我的云端笔记']]) {
      const vis = await win.locator('.t2s-srow-title', { hasText: new RegExp(`^${child}$`) }).first().isVisible().catch(() => false)
      if (!vis) await win.locator('.t2s-folder-row', { hasText: folder }).first().click().catch(() => {})
      await win.waitForTimeout(300)
    }
    await win.locator('.t2s-srow-title', { hasText: /^WMOSv11$/ }).first().click()
    await win.waitForSelector('.pz-table tbody tr', { timeout: 10_000 }).catch(() => {})
    const names = await win.locator('.pz-table td.n b').allTextContents()
    check('② 同步库文件表:文件夹在前(论文 / 附件 / 日记)', names[0] && ['论文', '附件', '日记'].includes(names[0]) && names.includes('组会 10-16.pdf'), names.slice(0, 5).join(' | '))
    await win.waitForTimeout(900)
    check('② 进位置右栏展开出详情', (await sideWidth()) > 150, `side=${await sideWidth()}`)
    const sideActs = await win.locator('.pz-side .pz-acts button').allTextContents()
    check('② 同步库只给下载,右栏写明为什么', sideActs.join('|') === '下载' && /每台同步 WMOSv11 的设备/.test(await win.locator('.pz-side .pz-tip').textContent().catch(() => '')), sideActs.join('|'))
    await shot('sync')
    await setMode('light', 'teal'); await shot('sync-teal'); await setMode('light')

    // ③ 应用文件:右键移到回收站 → 吐司、回收站 +1 → 恢复
    await win.locator('.t2s-srow-title', { hasText: /^AI Studio$/ }).first().click()
    await win.waitForSelector('.pz-table tbody tr', { timeout: 10_000 }).catch(() => {})
    const trashHint = () => win.evaluate(() => { const r = [...document.querySelectorAll('.t2s-srow')].find((x) => /回收站/.test(x.textContent || '')); return r ? r.textContent : '' })
    const beforeHint = await trashHint()
    const row = win.locator('.pz-table tbody tr', { hasText: '海报_v3_4k.png' }).first()
    await row.click({ button: 'right' })
    await win.waitForSelector('.ctx-menu.pz-menu', { timeout: 5000 }).catch(() => {})
    const items = await win.locator('.ctx-menu.pz-menu button').allTextContents()
    check('③ 右键是宿主菜单:下载 / 重命名 / 移动到… / 移到回收站', items.join('|') === '下载|重命名|移动到…|移到回收站', items.join('|'))
    await shot('trash-menu')
    await win.locator('.ctx-menu.pz-menu button', { hasText: '移到回收站' }).click()
    await win.waitForFunction(() => /已把「海报_v3_4k\.png」移到回收站/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {})
    check('③ 不弹确认,吐司说一声', /已把「海报_v3_4k\.png」移到回收站/.test(await win.evaluate(() => document.body.innerText)))
    check('③ 服务端收到带应用来源的删除', cloud.st.hits.includes('DELETE /api/files/f-v3 [ai-studio]'))
    await win.waitForTimeout(800)
    const afterHint = await trashHint()
    check('③ 左栏回收站从 3 项变 4 项', /3 项/.test(beforeHint) && /4 项/.test(afterHint), `${beforeHint} → ${afterHint}`)
    check('③ 右栏换成下一个文件', /海报_v2\.png/.test(await win.locator('.pz-side .pz-fname').textContent().catch(() => '')))
    await shot('trash-done')
    await win.locator('.t2s-srow', { hasText: '回收站' }).first().click()
    await win.waitForSelector('.pz-table tbody tr', { timeout: 10_000 }).catch(() => {})
    await win.locator('.pz-table tbody tr', { hasText: '海报_v3_4k.png' }).first().click()
    await shot('trash')
    await win.locator('.pz-side .pz-btn', { hasText: '恢复' }).click()
    await win.waitForFunction(() => /已恢复「海报_v3_4k\.png」/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {})
    check('③ 回收站里恢复', cloud.st.hits.includes('POST /api/trash/f-v3/restore'))

    // Amadeus Cloud:只看和下载
    await win.locator('.t2s-srow-title', { hasText: /^我的云端笔记$/ }).first().click()
    await win.waitForSelector('.pz-table tbody tr', { timeout: 10_000 }).catch(() => {})
    await shot('ama')

    // ⑥ 我的云盘(方案 D):新建文件夹 → 上传(中文名 / 并发 3 / 超 50 MB 不发请求)→ 撞名 (1) → 文件夹上传 → 配额预检 → 多选批量删
    const upDir = path.join(home, 'up')
    fs.mkdirSync(path.join(upDir, '课题资料', '子目录'), { recursive: true })
    const mk = (rel, size) => { const f = path.join(upDir, rel); fs.writeFileSync(f, ''); fs.truncateSync(f, size); return f }
    // 顺序有讲究:前三个大的占满三条道,小的排在第四个(截图时还在排队),超 50 MB 的入队就失败
    const batch1 = [mk('WMOS 演示录屏.mov', 24 * MB), mk('封面.png', 6 * MB), mk('数据.csv', 3 * MB), mk('组会纪要.md', 40 * 1024), mk('超大.zip', 51 * MB)]
    mk('课题资料/提纲.md', 8 * 1024); mk('课题资料/子目录/附录.md', 4 * 1024); mk('课题资料/.DS_Store', 1024)
    const uploadsHit = () => cloud.st.hits.filter((h) => h.startsWith('POST /api/files/upload')).length
    const cardTitle = () => win.locator('.pz-txcard .pz-txhead b').textContent({ timeout: 1000 }).catch(() => '')
    const tableNames = () => win.locator('.pz-table td.n b').allTextContents()
    await win.locator('.t2s-srow-title', { hasText: /^我的云盘$/ }).first().click()
    await win.waitForSelector('text=这里还空着', { timeout: 10_000 }).catch(() => {})
    check('⑥ 我的云盘在概览下面,装好是空的', await win.getByText('这里还空着').count() > 0)
    await shot('drive-empty')
    await win.locator('.pz-top .pz-ibtn[title="新建文件夹"]').click()
    await win.waitForFunction(() => document.activeElement?.classList.contains('pz-newname'), null, { timeout: 5000 }).catch(() => {})
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)
    check('⑥ 新建文件夹:Esc 取消,不发请求', !(await win.locator('.pz-newname').count()) && !cloud.st.hits.some((h) => h.startsWith('POST /api/files [penzor]')))
    await win.locator('.pz-top .pz-ibtn[title="新建文件夹"]').click()
    await win.waitForFunction(() => document.activeElement?.classList.contains('pz-newname'), null, { timeout: 5000 }).catch(() => {})
    const nf = await win.evaluate(() => { const i = document.querySelector('.pz-newname'); const a = document.activeElement; return { has: !!i, focused: i === a, active: a ? `${a.tagName}.${a.className}` : '', sel: i ? [i.selectionStart, i.selectionEnd, i.value] : null } })
    check('⑥ 新建文件夹:行内一行,名字已选中', nf.has && nf.focused && nf.sel[0] === 0 && nf.sel[1] === nf.sel[2].length && nf.sel[2] === '新建文件夹', JSON.stringify(nf))
    await win.keyboard.type('资料')
    await win.keyboard.press('Enter')
    await win.waitForFunction(() => [...document.querySelectorAll('.pz-table td.n b')].some((b) => b.textContent === '资料'), null, { timeout: 8000 }).catch(() => {})
    check('⑥ 回车建好「资料」', cloud.st.hits.includes('POST /api/files [penzor]') && (await tableNames()).includes('资料'))

    cloud.st.throttle = true
    await win.locator('.pz input[type=file][multiple]').setInputFiles(batch1)
    await win.waitForSelector('.pz-txcard', { timeout: 8000 }).catch(() => {})
    await win.waitForFunction(() => document.querySelectorAll('.pz-txcard .pz-txrow2').length >= 5, null, { timeout: 8000 }).catch(() => {})
    check('⑥ 一开传卡片就打开:正在传输 4 项', /正在传输 4 项/.test(await cardTitle()), await cardTitle())
    await win.waitForTimeout(3500) // 速度是 3 秒均值,等它出来
    check('⑥ 超 50 MB 的当场失败、不发请求,其余照传', /单个文件超过 50 MB/.test(await win.locator('.pz-txcard').textContent().catch(() => '')) && !cloud.st.uploads.some((x) => x.name === '超大.zip'))
    const live = await win.evaluate(() => [...document.querySelectorAll('.pz-txcard .pz-txrow2')].map((r) => r.querySelector('.sub')?.textContent || ''))
    check('⑥ 并发 3:同时在传的不超过 3 个,其余排队', live.filter((x) => /\/s/.test(x)).length <= 3 && live.some((x) => /排队中/.test(x)), live.join(' | '))
    const ring = await win.evaluate(() => { const r = document.querySelector('.rb .rb-ring'); return r ? r.closest('[aria-label]')?.getAttribute('aria-label') || '?' : '' })
    check('⑥ Ribbon 上蓬洲云图标外有进度环', /^蓬洲云，进行中 \d+%$/.test(ring), ring)
    check('⑥ 表格里正在传进来的行带进度', await win.locator('.pz-table .pz-txrow').count() > 0)
    await shot('drive-uploading')
    await setMode('dark'); await shot('drive-uploading-dark')
    await setMode('light', 'teal'); await shot('drive-uploading-teal'); await setMode('light')
    cloud.st.throttle = false
    await win.waitForFunction(() => /没传完/.test(document.querySelector('.pz-txcard .pz-txhead b')?.textContent || ''), null, { timeout: 60_000 }).catch(() => {})
    const names1 = cloud.st.uploads.map((x) => x.name).sort()
    check('⑥ 四个都传上去了,中文名原样(filename* UTF-8)', JSON.stringify(names1) === JSON.stringify(['WMOS 演示录屏.mov', '封面.png', '数据.csv', '组会纪要.md'].sort()), names1.join(' | '))
    check('⑥ Content-Length 和实际字节一致', cloud.st.badLength === 0 && cloud.st.uploads.every((x) => x.src === 'penzor'))
    check('⑥ 有失败的卡片留着:1 项没传完', /1 项没传完/.test(await cardTitle()), await cardTitle())
    await win.waitForTimeout(800)
    check('⑥ 传完进度环收掉', !(await win.locator('.rb .rb-ring').count()))
    await win.waitForFunction(() => document.querySelectorAll('.pz-table td.n b').length >= 5, null, { timeout: 8000 }).catch(() => {})
    check('⑥ 传完表格刷新出四个文件', ['组会纪要.md', 'WMOS 演示录屏.mov', '封面.png', '数据.csv'].every((n) => names1.includes(n)) && (await tableNames()).includes('WMOS 演示录屏.mov'), (await tableNames()).join(' | '))
    await shot('drive-done-fail')
    await win.locator('.pz-txfoot button', { hasText: '清除' }).click().catch(() => {})
    await win.waitForTimeout(400)
    check('⑥ 清除后卡片收掉', !(await win.locator('.pz-txcard, .pz-txpill').count()))

    await win.locator('.pz input[type=file][multiple]').setInputFiles([batch1[3]])
    await win.waitForFunction(() => /全部传完/.test(document.querySelector('.pz-txcard .pz-txhead b')?.textContent || ''), null, { timeout: 15_000 }).catch(() => {})
    check('⑥ 撞名 → 「组会纪要 (1).md」,卡片说全部传完', cloud.st.uploads.some((x) => x.name === '组会纪要 (1).md') && /全部传完/.test(await cardTitle()))
    await win.mouse.move(200, 600)
    await win.waitForTimeout(5000)
    check('⑥ 全部传完 4 秒后卡片消失', !(await win.locator('.pz-txcard, .pz-txpill').count()))

    await win.locator('.pz input[type=file][webkitdirectory]').setInputFiles(path.join(upDir, '课题资料'))
    await win.waitForFunction(() => /全部传完/.test(document.querySelector('.pz-txcard .pz-txhead b')?.textContent || ''), null, { timeout: 15_000 }).catch(() => {})
    await win.waitForFunction(() => [...document.querySelectorAll('.pz-table td.n b')].some((b) => b.textContent === '课题资料'), null, { timeout: 5000 }).catch(() => {})
    const tops = await win.evaluate(() => [...document.querySelectorAll('.pz-table td.n b')].map((b) => b.textContent))
    const nested = cloud.st.uploads.filter((x) => x.name === '提纲.md' || x.name === '附录.md')
    check('⑥ 上传文件夹:保留目录结构,隐藏文件不传', tops.includes('课题资料') && nested.length === 2 && new Set(nested.map((x) => x.parentId)).size === 2 && !cloud.st.uploads.some((x) => x.name === '.DS_Store'), `${tops.join(' | ')} · ${JSON.stringify(nested)}`)
    await win.mouse.move(200, 600); await win.waitForTimeout(5000)

    const okQuota = cloud.st.quota
    cloud.st.quota = 1916 * MB + cloud.st.uploads.reduce((n, x) => n + x.size, 0) + 2 * MB // 只剩 2 MB,这批要 9 MB
    const before6 = uploadsHit()
    await win.locator('.pz input[type=file][multiple]').setInputFiles([batch1[1], batch1[2]])
    await win.waitForFunction(() => /空间不够/.test(document.querySelector('.pz-txcard')?.textContent || ''), null, { timeout: 8000 }).catch(() => {})
    const qtext = await win.locator('.pz-txcard').textContent().catch(() => '')
    check('⑥ 配额预检:放不下就一个都不传,卡片写还差 7 MB + 去回收站腾地方', /空间不够，还差 7(\.0+)? MB/.test(qtext) && /去回收站腾地方/.test(qtext) && uploadsHit() === before6, qtext.slice(0, 80))
    await shot('drive-quota')
    await win.locator('.pz-txcard .pz-txrow2.is-fail .pz-ib').first().click().catch(() => {})
    cloud.st.quota = okQuota

    await win.locator('.pz-table tbody tr', { hasText: '封面.png' }).first().click()
    await win.locator('.pz-table tbody tr', { hasText: '数据.csv' }).first().click({ modifiers: ['Meta'] })
    await win.waitForTimeout(400)
    const selbar = await win.locator('.pz-selbar').textContent().catch(() => '')
    const sideTitle = await win.locator('.pz-side .pz-fname').textContent().catch(() => '')
    check('⑥ ⌘ 点选两项:批量条 + 右栏「已选 2 项」', /^已选 2 项 · 9/.test(selbar) && sideTitle === '已选 2 项', `${selbar} / ${sideTitle}`)
    await shot('drive-multi')
    await win.locator('.pz-top .pz-btn.danger', { hasText: '移到回收站' }).click()
    await win.waitForFunction(() => /已把 2 项移到回收站/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {})
    check('⑥ 批量移到回收站:一次 batch/delete,吐司说 2 项', cloud.st.hits.includes('POST /api/files/batch/delete [penzor]') && /已把 2 项移到回收站/.test(await win.evaluate(() => document.body.innerText)))
    await win.locator('.pz-scroll').click({ position: { x: 600, y: 600 } }).catch(() => {})
    await win.keyboard.press('Meta+A')
    await win.waitForTimeout(300)
    const all = await win.locator('.pz-selbar').textContent().catch(() => '')
    check('⑥ ⌘A 全选', /^已选 \d+ 项/.test(all) && Number(all.match(/已选 (\d+)/)?.[1]) === (await win.locator('.pz-table tbody tr').count()), all)
    await win.keyboard.press('Escape')

    // 退出前确认:还有在传的,退出先问(主进程的对话框换成假的,答「取消」)→ 不退;取消那一项后照常退(收尾的 app.close 就是这条)
    cloud.st.throttle = true
    await win.locator('.pz input[type=file][multiple]').setInputFiles([batch1[0]])
    await win.waitForFunction(() => /正在传输/.test(document.querySelector('.pz-txcard .pz-txhead b')?.textContent || ''), null, { timeout: 8000 }).catch(() => {})
    await app.evaluate(({ dialog }) => { globalThis.__asked = []; dialog.showMessageBox = async (w, o) => { globalThis.__asked.push(String((o || w)?.message)); return { response: 1, checkboxChecked: false } } })
    await app.evaluate(({ app: a }) => { a.quit() })
    await win.waitForTimeout(1500)
    const asked = await app.evaluate(() => globalThis.__asked)
    const alive = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    check('⑥ 还有在传的时候退出:先问「还有 1 个文件没传完」,点取消就不退', alive > 0 && asked.length === 1 && asked[0] === '还有 1 个文件没传完', JSON.stringify(asked))
    await win.locator('.pz-txcard .pz-ib[title="取消"]').first().click().catch(() => {})
    cloud.st.throttle = false
    await win.waitForTimeout(600)

    // ④ 设置 › 同步 › 远程同步
    const before = app.windows().length
    await win.evaluate(() => window.dispatchEvent(new CustomEvent('forsion:open-settings', { detail: 'sync/s-remote' })))
    await win.waitForTimeout(2500)
    const sw = app.windows().length > before ? app.windows()[app.windows().length - 1] : null
    check('④ 设置浮窗开了', !!sw)
    if (sw) {
      await sw.waitForLoadState('domcontentloaded'); await sw.waitForTimeout(1500)
      const label = await sw.evaluate(() => [...document.querySelectorAll('option')].find((o) => o.value === 'penzor')?.textContent || '')
      check('④ 下拉项叫「蓬洲云 Penzor Cloud(推荐)」', label === '蓬洲云 Penzor Cloud（推荐）', label)
      const view = sw.getByRole('button', { name: '在蓬洲云中查看 WMOSv11' })
      check('④ 有「在蓬洲云中查看 WMOSv11」', await view.count() > 0)
      await shot('settings', sw)
      await win.locator('.t2s-srow-title', { hasText: /^AI Studio$/ }).first().click() // 先离开,看按钮能不能把主窗拉回 WMOSv11
      await win.waitForTimeout(500)
      await view.click().catch(() => {})
      await win.waitForFunction(() => /WMOSv11/.test(document.querySelector('.pz-h1')?.textContent || ''), null, { timeout: 8000 }).catch(() => {})
      check('④ 点了 → 主窗停在 WMOSv11', /WMOSv11/.test(await win.locator('.pz-h1').textContent().catch(() => '')))
    }

    // ⑤ 401 → 登录页
    cloud.st.signedOut = true
    await win.locator('.t2s-srow-title', { hasText: /^概览$/ }).first().click().catch(() => {})
    await win.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /^刷新$/.test(x.getAttribute('aria-label') || x.title || x.textContent || '')); b?.click() })
    await win.waitForSelector('text=登录后查看你的蓬洲云', { timeout: 10_000 }).catch(() => {})
    check('⑤ 云端 401 → 登录页', await win.getByText('登录后查看你的蓬洲云').count() > 0)
    await shot('signed-out')
    check('没有渲染层报错', errors.length === 0, errors.slice(0, 3).join(' || '))
  } finally {
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]) // 走查里应用已经自己退了,close 会一直等
    await stub.close?.()
    cloud.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed · shots in ${SHOTS}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
