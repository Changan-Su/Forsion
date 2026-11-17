/**
 * 插件建 Agent / 导入会话(ctx.tangu.createAgent / importSessions,2026-11-16)的真机验证:
 * 真 Electron 壳 × **真 standalone 引擎**(本仓 tangu-agent/dist,临时家目录、真 SQLite)× 从磁盘装的 DeepSeek 导入插件。
 *
 * 壳在外部模式下拿不到引擎令牌(令牌在 deviceSecrets 里),中间放一个只补 Authorization 头的转发,别的原样透传(含 SSE)。
 *
 *  T1 插件被磁盘发现;详情页画出导入页,装好是空的(只有「选择导出文件」)
 *  T2 选一个自造的 DeepSeek 导出 zip(文件选择框)→ 读出 3 段对话
 *  T3 点「导入」→ 引擎里多了 deepseek Agent;3 个会话挂在它名下、带 imported 标记、原时间、手动标题
 *  T4 会话正文:重新生成掉的旧回答没进来;思考过程进了 reasoning;消息 origin = import
 *  T5 再导一次 → 「之前导过」3、会话数不变
 *  T6 「打开最近一段」→ 主窗打开那段会话、看得到原文
 *  截图:/tmp/deepseek-import-*.png(观感自己看)
 *
 * 需先:cd ../tangu-agent && npm run build;npm run build(本目录)。插件源默认 ../../Forsion-Instrumentality-Project/forsion-plugin-deepseek-import
 * (worktree 里用 DSI_PLUGIN=<路径> 指过去)。用法:node scripts/deepseek-import.e2e.cjs [--headed]
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const zlib = require('zlib')
const { spawn } = require('child_process')
const { randomUUID } = require('crypto')
const electron = require('./lib/launch-electron.cjs')

const ROOT = path.join(__dirname, '..')
const ENGINE = path.join(ROOT, '..', 'tangu-agent', 'dist', 'standalone', 'main.js')
const PLUGIN_SRC = process.env.DSI_PLUGIN || path.join(ROOT, '..', '..', 'Forsion-Instrumentality-Project', 'forsion-plugin-deepseek-import')
const SHOT = (n) => path.join(os.tmpdir(), `deepseek-import-${n}.png`)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// ── 夹具:自造的 DeepSeek 导出(不含任何真实聊天)──
const T = Date.UTC(2026, 9, 1, 8, 0, 0)
const iso = (ms) => new Date(ms).toISOString()
const EXPORT = [
  {
    id: 'e2e-conv-1', title: 'ZZ 秋天的诗', inserted_at: iso(T), updated_at: iso(T + 600_000), current_node: '4',
    mapping: {
      root: { id: 'root', parent: null, children: ['1'], message: null },
      1: { id: '1', parent: 'root', children: ['2', '3'], message: { inserted_at: iso(T), fragments: [{ type: 'REQUEST', content: '写一首关于秋天的诗' }] } },
      2: { id: '2', parent: '1', children: [], message: { inserted_at: iso(T + 10_000), fragments: [{ type: 'RESPONSE', content: 'OLD-REGENERATED-ANSWER' }] } },
      3: { id: '3', parent: '1', children: ['4'], message: { inserted_at: iso(T + 20_000), model: 'deepseek-reasoner', fragments: [{ type: 'THINK', content: '先想意象' }, { type: 'RESPONSE', content: '秋风起兮白云飞' }] } },
      4: { id: '4', parent: '3', children: [], message: { inserted_at: iso(T + 600_000), fragments: [{ type: 'REQUEST', content: '再短一点' }] } },
    },
  },
  {
    id: 'e2e-conv-2', title: 'ZZ Latest chat', inserted_at: iso(T + 86_400_000), updated_at: iso(T + 86_500_000),
    mapping: {
      a: { id: 'a', parent: null, children: ['b'], message: null },
      b: { id: 'b', parent: 'a', children: ['c'], message: { inserted_at: iso(T + 86_400_000), fragments: [{ type: 'REQUEST', content: 'hello there' }] } },
      c: { id: 'c', parent: 'b', children: [], message: { inserted_at: iso(T + 86_500_000), fragments: [{ type: 'RESPONSE', content: 'LATEST-ANSWER-MARKER' }] } },
    },
  },
  { id: 'e2e-conv-3', title: 'ZZ third', inserted_at: iso(T - 86_400_000), mapping: {
    r: { id: 'r', parent: null, children: ['q'], message: null },
    q: { id: 'q', parent: 'r', children: ['a'], message: { fragments: [{ type: 'REQUEST', content: 'q3' }] } },
    a: { id: 'a', parent: 'q', children: [], message: { fragments: [{ type: 'RESPONSE', content: 'a3' }] } },
  } },
]

function zip(name, data) {
  const nameBuf = Buffer.from(name)
  const body = zlib.deflateRawSync(data)
  const lh = Buffer.alloc(30)
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8)
  lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26)
  const ch = Buffer.alloc(46)
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10)
  ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28)
  const cd = Buffer.concat([ch, nameBuf])
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(30 + nameBuf.length + body.length, 16)
  return Buffer.concat([lh, nameBuf, body, cd, eocd])
}

async function freePort() {
  return new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
}

async function startEngine(home, token) {
  const port = await freePort()
  const sandbox = path.join(home, 'sandbox'); fs.mkdirSync(sandbox, { recursive: true })
  const log = fs.openSync(path.join(home, 'engine.log'), 'a')
  const child = spawn(process.execPath, [ENGINE, '--port', String(port), '--host', '127.0.0.1', '--data-dir', path.join(home, 'state.db'),
    '--sandbox', sandbox, '--cloud-url', 'http://127.0.0.1:9', '--token', token], {
    env: { ...process.env, TANGU_HOME: path.join(home, 'tangu') }, stdio: ['ignore', log, log],
  })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) return { child, base } } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  child.kill()
  throw new Error('引擎 60 秒没起来,看 ' + path.join(home, 'engine.log'))
}

/** 只补 Authorization 头的转发(外部模式下壳的令牌是空的) */
async function startAuthProxy(target, token) {
  const t = new URL(target)
  const server = http.createServer((req, res) => {
    const up = http.request({ host: t.hostname, port: t.port, path: req.url, method: req.method, headers: { ...req.headers, host: t.host, authorization: `Bearer ${token}` } }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers); r.pipe(res)
    })
    up.on('error', () => { try { res.writeHead(502); res.end() } catch { /* closed */ } })
    req.pipe(up)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}

async function api(base, token, p, init = {}) {
  const r = await fetch(base + p, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } })
  return r.json()
}

async function openPluginsTab(app, win) {
  const opened = app.waitForEvent('window', { timeout: 20000 }).catch(() => null)
  await win.keyboard.press('Meta+Comma')
  let sp = await opened
  if (!sp) {
    const retry = app.waitForEvent('window', { timeout: 20000 }).catch(() => null)
    await win.locator('#rb-settings, [data-ribbon-id="rb-settings"]').first().click({ timeout: 4000 }).catch(() => {})
    sp = await retry
  }
  if (!sp) throw new Error('设置浮窗没开出来')
  await sp.waitForSelector('.settings-main', { timeout: 20000 }).catch(() => {})
  const nav = sp.locator('.settings-nav')
  for (const label of ['插件', 'Plugins']) {
    const b = nav.getByRole('button', { name: label, exact: true }).first()
    if (await b.count().catch(() => 0)) { await b.scrollIntoViewIfNeeded().catch(() => {}); await b.click().catch(() => {}); break }
  }
  await sp.locator('.settings-nav-subitem', { hasText: /^(已安装插件|Installed plugins)$/ }).first().click().catch(() => {})
  await sp.waitForTimeout(900)
  return sp
}

async function main() {
  for (const f of [path.join(ROOT, 'out/main/main.js'), ENGINE, path.join(PLUGIN_SRC, 'main.js')]) {
    if (!fs.existsSync(f)) { console.error('缺 ' + f + '(先 build 引擎与桌面,或用 DSI_PLUGIN 指向插件目录)'); process.exit(1) }
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-dsi-'))
  const token = randomUUID()
  const engine = await startEngine(home, token)
  const proxy = await startAuthProxy(engine.base, token)
  const pdir = path.join(home, 'plugins', 'deepseek-import')
  fs.mkdirSync(pdir, { recursive: true })
  for (const f of ['main.js', 'manifest.json', 'README.md', 'CHANGELOG.md']) fs.copyFileSync(path.join(PLUGIN_SRC, f), path.join(pdir, f))
  // 插件要求的是带这组接口的那一版(发版后才有);台架跑的是本分支的开发版,版本号还没升 → 把门槛降到本机版本号
  const mf = JSON.parse(fs.readFileSync(path.join(pdir, 'manifest.json'), 'utf8'))
  mf.minAppVersion = require(path.join(ROOT, 'package.json')).version
  fs.writeFileSync(path.join(pdir, 'manifest.json'), JSON.stringify(mf, null, 2))
  const zipPath = path.join(home, 'deepseek_export.zip')
  fs.writeFileSync(zipPath, zip('conversations.json', Buffer.from(JSON.stringify(EXPORT))))

  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
      cwd: ROOT, headless: !process.argv.includes('--headed'),
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: proxy.url },
    })
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    await win.waitForTimeout(1500)

    const sp = await openPluginsTab(app, win)
    const card = sp.locator('.plugin-card--link', { hasText: 'DeepSeek' }).first()
    check('T1a 插件被磁盘发现', await card.count().catch(() => 0))
    await card.click().catch(() => {})
    await sp.waitForTimeout(900)
    const sw = sp.locator('[role="switch"]').first()
    if ((await sw.isChecked().catch(() => null)) === false) { await sw.click(); await sp.waitForTimeout(1500) }
    const pickBtn = sp.locator('button', { hasText: '选择导出文件' }).first()
    await pickBtn.waitFor({ timeout: 10_000 }).catch(() => {})
    check('T1b 详情页画出导入页,装好是空的(只给「选择导出文件」)', await pickBtn.count().catch(() => 0))
    check('T1c 能力行列出「新建 Agent、导入聊天记录」', await sp.locator('text=新建 Agent、导入聊天记录').count().catch(() => 0))
    await sp.screenshot({ path: SHOT('1-empty') }).catch(() => {})

    const chooser = sp.waitForEvent('filechooser', { timeout: 10_000 }).catch(() => null)
    await pickBtn.click()
    const fc = await chooser
    check('T2a 点按钮弹出文件选择', !!fc)
    if (fc) await fc.setFiles(zipPath)
    const startBtn = sp.locator('button', { hasText: '导入 3 段对话' }).first()
    await startBtn.waitFor({ timeout: 15_000 }).catch(() => {})
    check('T2b 读出 3 段对话', await startBtn.count().catch(() => 0))
    await sp.screenshot({ path: SHOT('2-ready') }).catch(() => {})

    await startBtn.click().catch(() => {})
    await sp.locator('text=导入完成').first().waitFor({ timeout: 30_000 }).catch(() => {})
    check('T3a 界面显示导入完成', await sp.locator('text=导入完成').count().catch(() => 0))
    await sp.screenshot({ path: SHOT('3-done') }).catch(() => {})

    const agents = (await api(engine.base, token, '/agent/agents')).agents || []
    const ds = agents.find((a) => a.slug === 'deepseek')
    check('T3b 引擎里多了 deepseek Agent(系统提示是英文)', ds && !/[一-鿿]/.test(ds.systemPrompt || ds.developerInstructions || 'x'), ds ? ds.slug : JSON.stringify(agents.map((a) => a.slug)))
    const sessions = (await api(engine.base, token, '/agent/sessions?app_id=tangu')).sessions || []
    const imported = sessions.filter((s) => s.agent_config && s.agent_config.imported && s.agent_config.imported.source === 'deepseek')
    check('T3c 3 个会话挂在 deepseek 名下、带 imported 标记', imported.length === 3 && imported.every((s) => s.agent_config.agentSlug === 'deepseek' && s.agent_config.preset === 'chat'), `imported=${imported.length}`)
    const s1 = imported.find((s) => s.title === 'ZZ 秋天的诗')
    check('T3d 标题与原时间照留', !!s1 && String(s1.updated_at).startsWith('2026-10-01'), s1 ? `${s1.title} ${s1.updated_at}` : '-')

    const msgs = s1 ? ((await api(engine.base, token, `/agent/sessions/${s1.id}/messages`)).messages || []) : []
    check('T4a 重新生成掉的旧回答没进来', msgs.length === 3 && !msgs.some((m) => String(m.content).includes('OLD-REGENERATED')), `n=${msgs.length}`)
    const ans = msgs.find((m) => m.role === 'assistant')
    check('T4b 思考过程进了 reasoning', ans && ans.reasoning === '先想意象')

    // T5 再导一次
    const repick = sp.locator('button', { hasText: '换一个文件' }).first()
    const chooser2 = sp.waitForEvent('filechooser', { timeout: 10_000 }).catch(() => null)
    await repick.click().catch(() => {})
    const fc2 = await chooser2
    if (fc2) await fc2.setFiles(zipPath)
    await startBtn.waitFor({ timeout: 15_000 }).catch(() => {})
    await sp.locator('button', { hasText: '导入 3 段对话' }).first().click().catch(() => {})
    await sp.locator('text=之前导过(没动)').first().waitFor({ timeout: 30_000 }).catch(() => {})
    const row = await sp.locator('text=之前导过(没动)').count().catch(() => 0)
    const after = ((await api(engine.base, token, '/agent/sessions?app_id=tangu')).sessions || []).filter((s) => s.agent_config && s.agent_config.imported)
    check('T5 再导一次:界面报「之前导过」、会话数不变', row && after.length === 3, `sessions=${after.length}`)
    const agents2 = ((await api(engine.base, token, '/agent/agents')).agents || []).filter((a) => /^deepseek/.test(a.slug))
    check('T5b 第二次没再建一个 Agent(记住了上次那个)', agents2.length === 1, agents2.map((a) => a.slug).join(','))

    // T6 打开最近一段
    await sp.locator('button', { hasText: '打开最近一段' }).first().click().catch(() => {})
    await win.waitForTimeout(3000)
    const seen = await win.locator('text=LATEST-ANSWER-MARKER').count().catch(() => 0)
    check('T6 「打开最近一段」在主窗打开那段会话', seen)
    // 导入发生在设置浮窗:主窗的会话列表 / Agent 名册要跟上(sessions-changed / agents-changed)
    check('T6b 主窗认得这个会话(标签用原标题,不是缺省名)', await win.locator('text=ZZ Latest chat').count().catch(() => 0))
    check('T6c 回答的说话人是 DeepSeek,不是 Tangu', await win.locator('text=/^DeepSeek$/i').count().catch(() => 0))
    await win.screenshot({ path: SHOT('4-session') }).catch(() => {})
  } catch (e) {
    console.error(e)
    check('脚本跑完', false, String(e && e.message))
  } finally {
    await app?.close().catch(() => {})
    proxy.close()
    engine.child.kill()
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed} passed / ${failed} failed;截图 ${SHOT('*')};引擎日志 ${path.join(home, 'engine.log')}`)
  process.exit(failed ? 1 : 0)
}

main()
