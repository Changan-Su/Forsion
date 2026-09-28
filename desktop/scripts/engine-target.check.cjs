/**
 * 整端切到一台电脑(P1-K6 S2 = 设计文档「最小切片」)的真浏览器台架 —— `npm run check:enginetarget`。
 *
 * 为什么要它:单测(appStore.target / agentRunService.target / backendService.target)各自钉住一段契约,
 * 但「手机渲染层 × 真 SSE 流 × hub 隧道前缀 × 离线续订 × 审批卡 × 切回本端」只有整条链一起跑才看得见;
 * 连接态提示 / 远端只读审批卡是观感类改动,DESIGN.md §8 要真实截图。
 *
 * 链路(全在本机,不碰生产):
 *   Playwright(390×844 触屏,zh-CN)→ mobile 的 dev 风味构建(vite preview,/api 代理到 ↓)
 *   → 假 hub(本文件):/api/auth/me、/api/units 名册、/api/units/<id>/proxy/engine/* 转给「那台电脑」的桩引擎,
 *      /api/units/<id>/proxy/unit/config|hostfile 给设备辅助面,/api/agent/* 转给「本端(云端)」的桩引擎;
 *      可切离线(断掉在途流 + 回 503 UNIT_OFFLINE)。两个桩引擎 = scripts/lib/stub-engine.cjs。
 *   焦点经 dev 构建的 window.__forsionEngineTargets 切(选择器 UI 归 K8);store 经 window.__forsionStore 读。
 *
 * 断言:切焦点 → 会话列表 / 目录换成那台的、家目录取那台的;新会话建在那台且是 host 执行、没有整对象 PUT;
 *      run 的 SSE 走隧道前缀;审批卡远端只读(无改命令框、无「总允许」)、批准打到那台;
 *      断线 → 连接态提示「不在线」、恢复后按 fromSeq 续订、不把消息标错;
 *      **空闲时**断线(没有在飞的 run,只有轮询撞上)→ 恢复后不点重试也回 ready、提示消失、带外消息照到(评审 F1);
 *      切回本端 → 列表回来;离开一台离线的电脑后不再经 hub 探它(评审 F2);
 *      调用方身份取不到(终局)→ 不自动重试,但提示条给「重试」,点了就连上(评审 F3);
 *      每条隧道请求都带 Bearer、不带 x-forsion-remote*、URL 不含 token=。
 * 截图(自己看):已切到那台电脑的对话 / 远端只读审批卡 / 不在线提示 / 终局态的「重试」,落 SHOT_DIR 或临时目录。
 *
 * 用法:cd desktop && npm run check:enginetarget
 *   ENGINE_TARGET_DIST=<目录>  复用已有的 dev 风味构建(缺省在临时目录现构建,约 1 分钟)
 *   CHROMIUM_EXE=<路径>        指定 chromium
 */
const http = require('http')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { chromium } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const GENESIS = path.resolve(__dirname, '../..')
const MOBILE = path.join(GENESIS, 'mobile')
// 避开 mobile 台架的 5274–5299;别的会话的 vite 可能占着 → ENGINE_TARGET_PORT 覆盖,占用时起跑前就报错(否则页面落到别人的服务上,只见 connState 等不到的假红)
const PORT = Number(process.env.ENGINE_TARGET_PORT) || 5303
const ORIGIN = `http://localhost:${PORT}`
const U = '7f0e8a52-1b2c-4d3e-8f40-5a6b7c8d9e0f'
const SHOT_DIR = process.env.SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-enginetarget-'))
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const TOKEN = `${b64({ alg: 'none' })}.${b64({ userId: 'e2e-user' })}.sig`
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  for (const root of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]) {
    if (!fs.existsSync(root)) continue
    for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
        'chrome-linux/chrome', 'chrome-linux64/chrome',
      ]) { const e = path.join(root, d, rel); if (fs.existsSync(e)) return e }
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE')
}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 两台桩引擎 + 假 hub ──
const now = new Date().toISOString()
const session = (id, title, extra = {}) => ({ id, title, created_at: now, updated_at: now, ...extra })

async function startWorld() {
  const archivedEmpty = ({ path: p, method, url }) => (p === '/agent/sessions' && method === 'GET' && url.searchParams.get('archived') === 'true' ? { sessions: [] } : undefined)
  const home = await startStubEngine({
    sessions: [session('home-1', '手机本端的会话')],
    models: [{ id: 'cloud-model', name: 'Cloud Model', provider: 'forsion', contextWindow: 128000 }],
    agents: [{ slug: 'xyra', name: 'Tangu' }],
    override: archivedEmpty,
  })
  const mac = await startStubEngine({
    sessions: [session('mac-1', 'Mac 上的会话', { project_path: '/Users/studio/Forsion/demo', project_name: 'demo' })],
    messages: [],
    models: [{ id: 'mac-model', name: 'Mac Model', provider: 'stub', contextWindow: 200000 }],
    agents: [{ slug: 'xyra', name: 'Tangu' }, { slug: 'mac-only', name: 'Mac Agent' }],
    sessionConfigs: { 'mac-1': { execMode: 'host', approvalMode: 'auto-edit', cwd: '/Users/studio/Forsion/demo' } },
    override: archivedEmpty,
  })

  // callerDown:模拟 K8 中继换不到调用方票(合成 503 CALLER_UNAVAILABLE,请求没到那台);终局态,渲染层不得自动重试
  const hub = { offline: false, callerDown: false, seen: [], streams: new Set() }
  const unitPrefix = `/api/units/${U}/proxy`
  const forward = (req, res, base, subPath) => {
    const target = new URL(subPath, base)
    const up = http.request(target, { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json', accept: req.headers.accept || '*/*', authorization: 'Bearer stub' } }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers)
      if (!String(r.headers['content-type'] || '').includes('event-stream')) { r.pipe(res); return }
      // 事件流:桩引擎续订时不管 fromSeq 一律从头回放,这里按真引擎语义滤掉 seq ≤ fromSeq 的帧
      const fromSeq = Number(target.searchParams.get('fromSeq') || 0)
      let buf = ''
      r.on('data', (chunk) => {
        buf += String(chunk)
        const frames = buf.split('\n\n')
        buf = frames.pop() || ''
        for (const f of frames) {
          const m = /^data: (.*)$/m.exec(f)
          let seq = 0
          try { seq = m ? JSON.parse(m[1]).seq || 0 : 0 } catch { /* 心跳 */ }
          if (!seq || seq > fromSeq) res.write(`${f}\n\n`)
        }
      })
      r.on('end', () => res.end())
      const entry = { res, up: r }
      hub.streams.add(entry)
      res.on('close', () => { hub.streams.delete(entry); r.destroy() })
    })
    up.on('error', () => { try { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'UNIT_DISCONNECTED' })) } catch { /* 已开写 */ } })
    req.pipe(up)
  }
  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://hub')
    const p = u.pathname
    if (p.startsWith('/api/units/')) hub.seen.push({ method: req.method, url: req.url, headers: { ...req.headers }, at: Date.now(), offline: hub.offline })
    if (p === '/api/auth/me') return json(res, 200, { id: 'e2e-user', username: 'e2e', nickname: 'E2E' })
    if (p === '/api/units') return json(res, 200, { units: [{ id: U, name: 'Studio Mac', kind: 'desktop', platform: 'darwin', online: !hub.offline, capsLive: true, caps: { engine: 'ready' } }] })
    if (p.startsWith('/api/units/') && !p.startsWith(`/api/units/${U}/`)) return json(res, 404, { code: 'UNIT_NOT_FOUND', detail: 'Unit not found' })
    if (p.startsWith(unitPrefix)) {
      if (hub.offline) return json(res, 503, { code: 'UNIT_OFFLINE', detail: 'Unit offline' })
      if (hub.callerDown && p.startsWith(`${unitPrefix}/engine`)) return json(res, 503, { code: 'CALLER_UNAVAILABLE', detail: 'Caller token unavailable' })
      const rest = p.slice(unitPrefix.length)
      if (rest === '/unit/config') return json(res, 200, { config: { homeDir: '/Users/studio', defaultWorkspaceDir: '/Users/studio/Forsion' } })
      if (rest === '/unit/hostfile') return json(res, 200, { mimeType: 'image/png', content: PNG_B64, size: 68 })
      if (rest === '/engine' || rest.startsWith('/engine/')) return forward(req, res, mac.url, (rest.slice('/engine'.length) || '/') + u.search)
      return json(res, 403, { code: 'LOCAL_ONLY' })
    }
    if (p === '/api/brain/inbox/broadcasts') return json(res, 200, { broadcasts: [] })
    if (p === '/api/token-quota/my') return json(res, 404, { detail: 'n/a' })
    if (p.startsWith('/api/agent/') || p === '/api/health') return forward(req, res, home.url, p.slice('/api'.length) + u.search)
    return json(res, 200, {})
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    home, mac, hub,
    url: `http://127.0.0.1:${server.address().port}`,
    setOffline(on) {
      hub.offline = on
      // 隧道断:hub 收掉在途的流(客户端看到的是非终态的断流 → 800ms 后续订 → 503 UNIT_OFFLINE → 暂停等恢复)
      if (on) for (const s of hub.streams) { try { s.res.end(); s.up.destroy() } catch { /* ignore */ } }
    },
    close() { server.close(); home.close(); mac.close() },
  }
}

function buildDist() {
  const out = process.env.ENGINE_TARGET_DIST || path.join(os.tmpdir(), 'forsion-enginetarget-dist')
  if (process.env.ENGINE_TARGET_DIST && fs.existsSync(path.join(out, 'index.html'))) return out
  console.log(`… 构建 mobile(dev 风味,带 __forsionStore / __forsionEngineTargets)→ ${out}`)
  const r = spawnSync('npx', ['vite', 'build', '--mode', 'development', '--outDir', out, '--emptyOutDir'], {
    cwd: MOBILE, env: { ...process.env, NODE_ENV: 'development' }, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`mobile 构建失败:\n${String(r.stderr).slice(-1500)}`)
  return out
}

const ping = () => new Promise((res) => {
  const req = http.get(`${ORIGIN}/`, (r) => { res(r.statusCode === 200); r.resume() })
  req.on('error', () => res(false)); req.setTimeout(1500, () => { req.destroy(); res(false) })
})

async function main() {
  if (await ping()) throw new Error(`端口 ${PORT} 已有服务在应答(多半是别的会话的 vite)—— 换一个:ENGINE_TARGET_PORT=<空闲端口> npm run check:enginetarget`)
  const dist = buildDist()
  const world = await startWorld()
  const preview = spawn('npx', ['vite', 'preview', '--outDir', dist, '--port', String(PORT), '--strictPort'], {
    cwd: MOBILE, env: { ...process.env, BACKEND_URL: world.url }, stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  })
  let previewErr = ''
  preview.stderr.on('data', (d) => { previewErr += String(d) })
  const killPreview = () => { try { process.kill(-preview.pid, 'SIGTERM') } catch { try { preview.kill() } catch { /* 已退出 */ } } }
  let browser = null
  try {
    let up = false
    for (let i = 0; i < 60 && !up; i++) { await sleep(500); up = await ping() }
    if (!up) throw new Error(`vite preview 没起来(${PORT} 被占?)\n${previewErr.slice(-800)}`)

    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale: 'zh-CN' })
    await ctx.addInitScript((token) => {
      try {
        localStorage.setItem('forsion_token', token)
        localStorage.setItem('forsion_tangu_onboarding_done', '1')
        localStorage.setItem('forsion_tangu_onboarding_dismissed', '1')
        localStorage.setItem('tangu-locale', 'zh')
      } catch { /* ignore */ }
    }, TOKEN)
    const page = await ctx.newPage({ locale: 'zh-CN' })
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForSelector('.mb-shell', { timeout: 60_000 })
    await page.waitForFunction(() => window.__forsionStore?.getState().connState === 'ok', null, { timeout: 30_000 })
    const st = (fn) => page.evaluate(fn)

    // ── A. 起点:本端(云端)──
    const homeIds = await st(() => window.__forsionStore.getState().sessions.map((s) => s.id))
    check('起点:会话列表是本端的', JSON.stringify(homeIds) === '["home-1"]', JSON.stringify(homeIds))

    // ── B. 切到那台电脑 ──
    await page.evaluate((u) => window.__forsionEngineTargets.setFocusTarget({ kind: 'unit', unitId: u }, { name: 'Studio Mac' }), U)
    await page.waitForFunction(() => window.__forsionStore.getState().sessions.some((s) => s.id === 'mac-1'), null, { timeout: 20_000 })
    await page.waitForFunction(() => window.__forsionStore.getState().agentDefs.length > 0, null, { timeout: 10_000 }).catch(() => {})
    const b = await st(() => {
      const s = window.__forsionStore.getState()
      return { ids: s.sessions.map((x) => x.id), conn: s.connState, models: s.modelsResp?.models?.map((m) => m.id), agents: s.agentDefs.map((a) => a.slug), homeDir: s.homeDir, ws: s.defaultWsDir, health: window.__forsionEngineTargets.health() }
    })
    check('切焦点:会话列表换成那台电脑的', JSON.stringify(b.ids) === '["mac-1"]', JSON.stringify(b.ids))
    check('切焦点:连上了,健康 ready', b.conn === 'ok' && b.health[`unit:${U}`]?.state === 'ready', `${b.conn} ${JSON.stringify(b.health)}`)
    check('切焦点:目录(模型 / Agent)是那台的', JSON.stringify(b.models) === '["mac-model"]' && b.agents.includes('mac-only'), `${JSON.stringify(b.models)} ${JSON.stringify(b.agents)}`)
    await page.waitForFunction(() => window.__forsionStore.getState().defaultWsDir === '/Users/studio/Forsion', null, { timeout: 10_000 }).catch(() => {})
    const prof = await st(() => ({ h: window.__forsionStore.getState().homeDir, w: window.__forsionStore.getState().defaultWsDir }))
    check('切焦点:家目录 / 默认工作区取那台的(/unit/config)', prof.h === '/Users/studio' && prof.w === '/Users/studio/Forsion', JSON.stringify(prof))

    // ── C. 新会话 + run + 审批(远端只读卡)──
    world.mac.script([
      { type: 'token', payload: { delta: '我先看一下目录。' } },
      { type: 'approval_request', payload: { approvalId: 'ap1', name: 'run_bash', arguments: JSON.stringify({ command: 'ls -la' }), preview: '$ ls -la', reason: { kind: 'mode', mode: 'auto-edit' }, remote: { via: 'tunnel' } } },
      { type: 'approval_result', payload: { approvalId: 'ap1', decision: 'approved' }, delay: 7000 },
      { type: 'token', payload: { delta: '\n目录里有 demo/。' }, delay: 400 },
      { type: 'done', payload: {} },
    ])
    const beforeRuns = world.mac.seen.runs.length
    // 真 UI 路径:主页输入框打字 + 回车 → 主页把整段动作交给 Tangu Space 的对话视图(setActiveSpace → openView('chat') → send)
    const ta = page.locator('.t2c-ta').first()
    await ta.click()
    await ta.fill('看看我的项目目录')
    await page.keyboard.press('Enter')
    const sent = Promise.resolve()
    await page.waitForFunction(() => document.querySelector('.approval-card'), null, { timeout: 20_000 }).catch(() => {})
    const newSid = await st(() => window.__forsionStore.getState().activeId)
    const created = world.mac.seen.runs.length > beforeRuns ? world.mac.seen.runs[world.mac.seen.runs.length - 1] : null
    check('新会话建在那台电脑、run 打到那台', !!created && created.sessionId === newSid, JSON.stringify(created && { sid: created.sessionId, newSid }))
    check('那台电脑的新会话 = host 执行,工作目录 = 那台的默认工作区', created?.agentConfig?.execMode === 'host' && created?.agentConfig?.cwd === '/Users/studio/Forsion', JSON.stringify(created?.agentConfig && { e: created.agentConfig.execMode, c: created.agentConfig.cwd }))
    check('建会话没有整对象 PUT(远端 deny-remote)', !world.hub.seen.some((r) => r.method === 'PUT'), world.hub.seen.filter((r) => r.method === 'PUT').map((r) => r.url).join(','))
    check('本端桩没收到 run(没有打错引擎)', world.home.seen.runs.length === 0, String(world.home.seen.runs.length))
    const card = await page.evaluate(() => {
      const c = document.querySelector('.approval-card')
      if (!c) return null
      return { edit: !!c.querySelector('textarea.approval-edit'), buttons: [...c.querySelectorAll('.approval-actions button')].map((x) => (x.textContent || '').trim()), readonly: !!c.querySelector('[data-remote-readonly]') }
    })
    check('审批卡远端只读:没有改命令框、没有「总允许」', !!card && !card.edit && card.buttons.length === 2 && card.readonly, JSON.stringify(card))
    await page.screenshot({ path: path.join(SHOT_DIR, 'enginetarget-approval.png') })
    await sleep(600) // 托盘换卡冷却(ApprovalTray ARM_MS = 350ms):冷却里的点击按设计不送
    const approveBtn = page.locator('.approval-card .approval-actions .btn.primary').first()
    if (await approveBtn.count()) await approveBtn.click()
    for (let i = 0; i < 30 && !world.mac.seen.approvals.length; i++) await sleep(100)
    const appr = world.mac.seen.approvals[0]
    check('批准打到那台电脑(不改参数)', !!appr && appr.approvalId === 'ap1' && appr.action === 'approve' && !appr.argsOverride, JSON.stringify(appr))
    await sent.catch(() => {})
    await page.waitForFunction((sid) => (window.__forsionStore.getState().messagesBySession[sid] || []).some((m) => m.role === 'assistant' && m.status === 'done'), newSid, { timeout: 20_000 }).catch(() => {})
    const done = await st(() => { const s = window.__forsionStore.getState(); return (s.messagesBySession[s.activeId] || []).filter((m) => m.role === 'assistant').map((m) => ({ st: m.status, c: m.content })) })
    check('run 在那台电脑上跑完(SSE 走隧道前缀)', done.some((m) => m.st === 'done' && /demo/.test(m.c)), JSON.stringify(done))
    await page.screenshot({ path: path.join(SHOT_DIR, 'enginetarget-chat.png') })

    // ── D. 断线 → 暂停 → 恢复续订 ──
    world.mac.script([
      { type: 'token', payload: { delta: '第一段。' } },
      { type: 'token', payload: { delta: '断线之后才到的第二段。' }, delay: 6000 },
      { type: 'done', payload: {} },
    ])
    const ta2 = page.locator('.t2c-ta').first()
    await ta2.click()
    await ta2.fill('再跑一个长任务')
    await page.keyboard.press('Enter')
    const sent2 = Promise.resolve()
    await page.waitForFunction(() => { const s = window.__forsionStore.getState(); return (s.messagesBySession[s.activeId] || []).some((m) => m.role === 'assistant' && /第一段/.test(m.content)) }, null, { timeout: 15_000 }).catch(() => {})
    world.setOffline(true)
    await page.waitForSelector('.t2-target-health[data-target-health="offline"]', { timeout: 15_000 }).catch(() => {})
    const notice = await page.evaluate(() => { const n = document.querySelector('.t2-target-health'); return n ? { state: n.getAttribute('data-target-health'), text: n.textContent } : null })
    check('断线:输入框顶上出「不在线,恢复后自动继续」提示', notice?.state === 'offline' && /Studio Mac/.test(notice.text || '') && /不在线/.test(notice.text || ''), JSON.stringify(notice))
    const midStatus = await st(() => { const s = window.__forsionStore.getState(); return (s.messagesBySession[s.activeId] || []).filter((m) => m.role === 'assistant').pop()?.status })
    check('断线期间消息不被标错(仍在 streaming)', midStatus === 'streaming', String(midStatus))
    // 首次对话的「成就达成」吐司恰好盖在输入框上沿:截图前藏掉它(只影响截图,不影响断言)
    await page.addStyleTag({ content: '.ach-toast{display:none!important}' })
    await page.screenshot({ path: path.join(SHOT_DIR, 'enginetarget-offline.png') })
    const box = await page.locator('.t2c-card').last().boundingBox().catch(() => null)
    if (box) await page.screenshot({ path: path.join(SHOT_DIR, 'enginetarget-offline-composer.png'), clip: { x: 0, y: Math.max(0, box.y - 12), width: 390, height: Math.min(844 - Math.max(0, box.y - 12), box.height + 24) } })

    await sleep(4000)
    world.setOffline(false)
    await page.waitForFunction(() => { const s = window.__forsionStore.getState(); return (s.messagesBySession[s.activeId] || []).some((m) => m.role === 'assistant' && /第二段/.test(m.content) && m.status === 'done') }, null, { timeout: 45_000 }).catch(() => {})
    await sent2.catch(() => {})
    const resumed = await st(() => { const s = window.__forsionStore.getState(); return (s.messagesBySession[s.activeId] || []).filter((m) => m.role === 'assistant').pop() })
    check('恢复后按 fromSeq 续订、跑完', resumed?.status === 'done' && /第一段/.test(resumed.content) && /第二段/.test(resumed.content), JSON.stringify(resumed && { st: resumed.status, c: resumed.content }))
    const evUrls = world.hub.seen.filter((r) => r.url.includes('/events?')).map((r) => r.url.replace(/^.*\/runs\//, ''))
    check('续订没有从 0 重来(fromSeq 前进)', evUrls.some((x) => /fromSeq=[1-9]/.test(x)), evUrls.join(' '))
    await page.waitForFunction(() => !document.querySelector('.t2-target-health'), null, { timeout: 10_000 }).catch(() => {})
    check('恢复后连接态提示消失', !(await page.$('.t2-target-health')))

    // ── D2. 空闲时断线(评审 F1)──
    // 上面那段恢复靠的是 SSE 暂停时挂着的等待者;这里没有在飞的 run,只有 12s 一次的轮询撞上 503 —— 原先健康写成离线后
    // 再没人探,轮询(不健康时暂停)永久停摆,「恢复后会自动继续」是假的,那台本机新打的消息也再不会到手机。
    await page.waitForFunction(() => { const s = window.__forsionStore.getState(); return !s.runningBySession[s.activeId] }, null, { timeout: 10_000 }).catch(() => {})
    world.setOffline(true)
    await page.waitForSelector('.t2-target-health[data-target-health="offline"]', { timeout: 35_000 }).catch(() => {})
    const idleOff = await st(() => ({ h: window.__forsionEngineTargets.health(), run: (() => { const s = window.__forsionStore.getState(); return !!s.runningBySession[s.activeId] })() }))
    check('空闲断线:没有在飞的 run,轮询撞上 → 出「不在线」提示', !idleOff.run && idleOff.h[`unit:${U}`]?.state === 'offline' && !!(await page.$('.t2-target-health[data-target-health="offline"]')), JSON.stringify(idleOff))
    world.setOffline(false)
    const idleBackAt = Date.now()
    await page.waitForFunction(() => !document.querySelector('.t2-target-health'), null, { timeout: 45_000 }).catch(() => {})
    const idleHealth = await st(() => window.__forsionEngineTargets.health())
    check('空闲断线恢复:不点重试、不发消息,健康自己回 ready、提示消失', !(await page.$('.t2-target-health')) && idleHealth[`unit:${U}`]?.state === 'ready', `${Math.round((Date.now() - idleBackAt) / 1000)}s ${JSON.stringify(idleHealth)}`)
    world.mac.state.messages.push({ id: 'oob-1', role: 'user', content: '在 Mac 本机打的一句', created_at: new Date().toISOString() })
    await page.waitForFunction(() => { const s = window.__forsionStore.getState(); return (s.messagesBySession[s.activeId] || []).some((m) => m.id === 'oob-1') }, null, { timeout: 30_000 }).catch(() => {})
    const oob = await st(() => { const s = window.__forsionStore.getState(); return (s.messagesBySession[s.activeId] || []).some((m) => m.id === 'oob-1') })
    const idlePolls = world.hub.seen.filter((r) => r.at > idleBackAt && /\/messages\?/.test(r.url)).length
    check('空闲断线恢复:轮询续上,那台本机新打的消息自己到手机', oob && idlePolls > 0, `oob=${oob} polls=${idlePolls}`)

    // ── E. 切回本端 ──
    await page.evaluate(() => window.__forsionEngineTargets.setFocusTarget({ kind: 'home' }))
    await page.waitForFunction(() => window.__forsionStore.getState().sessions.some((s) => s.id === 'home-1'), null, { timeout: 20_000 }).catch(() => {})
    const back = await st(() => ({ ids: window.__forsionStore.getState().sessions.map((s) => s.id), models: window.__forsionStore.getState().modelsResp?.models?.map((m) => m.id), focus: window.__forsionEngineTargets.focusRef() }))
    check('切回本端:列表 / 目录回到本端', JSON.stringify(back.ids) === '["home-1"]' && JSON.stringify(back.models) === '["cloud-model"]' && back.focus.kind === 'home', JSON.stringify(back))

    // ── E2. 重启恢复焦点 + 开机时那台就不在线(深色主题截图)──
    // 焦点按账号落盘:切回本端前再切一次过去,然后重载 —— 应恢复到那台电脑;那台此刻离线 → 连接失败 + 不在线提示。
    await page.evaluate((u) => window.__forsionEngineTargets.setFocusTarget({ kind: 'unit', unitId: u }, { name: 'Studio Mac' }), U)
    await page.waitForFunction(() => window.__forsionStore.getState().sessions.some((s) => s.id === 'mac-1'), null, { timeout: 20_000 }).catch(() => {})
    world.setOffline(true)
    await page.evaluate(() => { try { localStorage.setItem('forsion_theme', 'dark') } catch { /* ignore */ } })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.mb-shell', { timeout: 60_000 })
    await page.waitForFunction(() => window.__forsionEngineTargets?.focusRef().kind === 'unit', null, { timeout: 15_000 }).catch(() => {})
    const restored = await st(() => window.__forsionEngineTargets.focusRef())
    check('重载后焦点从落盘恢复到那台电脑', restored.kind === 'unit' && restored.unitId === U, JSON.stringify(restored))
    await page.waitForFunction(() => window.__forsionStore.getState().connState === 'err', null, { timeout: 30_000 }).catch(() => {})
    const bootOffline = await st(() => ({ conn: window.__forsionStore.getState().connState, msg: window.__forsionStore.getState().connMessage, h: window.__forsionEngineTargets.health() }))
    check('开机时那台就不在线:连接失败、健康 offline、给人话', bootOffline.conn === 'err' && /不在线/.test(bootOffline.msg) && Object.values(bootOffline.h).some((x) => x.state === 'offline'), JSON.stringify(bootOffline))
    // 主页 → Tangu 对话视图看输入框顶上的提示(新对话空态也挂着同一个输入框)
    const ta3 = page.locator('.t2c-ta').first()
    if (await ta3.count()) { await ta3.click().catch(() => {}); await ta3.fill('离线时打的字').catch(() => {}); await page.keyboard.press('Enter').catch(() => {}) }
    await page.waitForSelector('.t2-target-health', { timeout: 10_000 }).catch(() => {})
    await page.addStyleTag({ content: '.ach-toast{display:none!important}' })
    await page.screenshot({ path: path.join(SHOT_DIR, 'enginetarget-offline-dark.png') })
    check('深色主题下同样出提示', !!(await page.$('.t2-target-health[data-target-health="offline"]')))
    const ph = await page.locator('.t2c-ta').first().getAttribute('placeholder').catch(() => null)
    check('没连上时输入框占位说「等那台连上」(不是本端的「先在设置里连接后端」)', /Studio Mac/.test(ph || ''), String(ph))
    // 提示说了「恢复连接后会自动继续」:那台回来后必须**不点重试**就自己连上(健康探针退避 ≤ 30s)
    world.setOffline(false)
    await page.waitForFunction(() => { const s = window.__forsionStore.getState(); return s.connState === 'ok' && s.sessions.some((x) => x.id === 'mac-1') }, null, { timeout: 45_000 }).catch(() => {})
    const healed = await st(() => ({ conn: window.__forsionStore.getState().connState, ids: window.__forsionStore.getState().sessions.map((s) => s.id) }))
    check('那台回来后不点重试也自己连上(开机离线 → 自动恢复)', healed.conn === 'ok' && healed.ids.includes('mac-1'), JSON.stringify(healed))
    await page.waitForFunction(() => !document.querySelector('.t2-target-health'), null, { timeout: 5_000 }).catch(() => {})
    check('自动恢复后连接态提示消失', !(await page.$('.t2-target-health')))
    await page.evaluate(() => { try { localStorage.setItem('forsion_theme', 'light') } catch { /* ignore */ } })
    await page.evaluate(() => window.__forsionEngineTargets.setFocusTarget({ kind: 'home' }))

    // ── E3. 离开一台离线的电脑后不再经 hub 探它(评审 F2)──
    // connect 失败时挂的等待者原先不带中止信号:切回本端后探针环照转(退避封顶 30s,回前台 / 联网再加探),手机开一夜 = 一夜空探。
    world.setOffline(true)
    await page.evaluate((u) => window.__forsionEngineTargets.setFocusTarget({ kind: 'unit', unitId: u }, { name: 'Studio Mac' }), U)
    await page.waitForFunction(() => window.__forsionStore.getState().connState === 'err', null, { timeout: 20_000 }).catch(() => {})
    await page.evaluate(() => window.__forsionEngineTargets.setFocusTarget({ kind: 'home' }))
    const leftAt = Date.now()
    await sleep(6500) // 越过 2s + 4s 两档退避
    const stray = world.hub.seen.filter((r) => r.at > leftAt && r.url.startsWith(`/api/units/${U}/`))
    const leftHealth = await st(() => window.__forsionEngineTargets.health())
    check('离开离线的那台:不再经 hub 探它,健康表不留旧的离线格', stray.length === 0 && !leftHealth[`unit:${U}`], `${stray.map((r) => r.url.replace(`/api/units/${U}/proxy`, '')).join(',')} ${JSON.stringify(leftHealth)}`)
    world.setOffline(false)

    // ── E4. 终局态(调用方身份取不到)不自动重试,但提示条给「重试」(评审 F3)──
    world.hub.callerDown = true
    await page.evaluate((u) => window.__forsionEngineTargets.setFocusTarget({ kind: 'unit', unitId: u }, { name: 'Studio Mac' }), U)
    await page.waitForFunction(() => window.__forsionStore.getState().connState === 'err', null, { timeout: 20_000 }).catch(() => {})
    await page.waitForSelector('.t2-target-health[data-target-health="caller-unavailable"]', { timeout: 8_000 }).catch(() => {})
    if (!(await page.$('.t2-target-health'))) {
      // 换焦点清了 activeId,移动端可能停在主页:同 E2,从主页输入框进对话视图(输入框禁用,不会真发出去)
      const ta4 = page.locator('.t2c-ta').first()
      if (await ta4.count()) { await ta4.click().catch(() => {}); await ta4.fill('身份取不到时打的字').catch(() => {}); await page.keyboard.press('Enter').catch(() => {}) }
      await page.waitForSelector('.t2-target-health[data-target-health="caller-unavailable"]', { timeout: 10_000 }).catch(() => {})
    }
    const callerNotice = await page.evaluate(() => { const n = document.querySelector('.t2-target-health'); return n ? { state: n.getAttribute('data-target-health'), text: n.textContent, retry: !!n.querySelector('button') } : null })
    check('身份取不到:提示条说清楚、给「重试」', callerNotice?.state === 'caller-unavailable' && callerNotice.retry, JSON.stringify(callerNotice))
    await page.addStyleTag({ content: '.ach-toast{display:none!important}' })
    await page.screenshot({ path: path.join(SHOT_DIR, 'enginetarget-caller-retry.png') })
    const cbox = await page.locator('.t2c-card').last().boundingBox().catch(() => null)
    if (cbox) await page.screenshot({ path: path.join(SHOT_DIR, 'enginetarget-caller-retry-composer.png'), clip: { x: 0, y: Math.max(0, cbox.y - 12), width: 390, height: Math.min(844 - Math.max(0, cbox.y - 12), cbox.height + 24) } })
    world.hub.callerDown = false // 换票的抖动过去了
    const callerOkAt = Date.now()
    await sleep(4500)
    const autoTried = world.hub.seen.filter((r) => r.at > callerOkAt && r.url.startsWith(`/api/units/${U}/proxy/engine`)).length
    const stillErr = await st(() => window.__forsionStore.getState().connState)
    check('终局态不自动重试(R-32):恢复了也不自己打那台', autoTried === 0 && stillErr === 'err', `requests=${autoTried} conn=${stillErr}`)
    const retryBtn = page.locator('.t2-target-health button').first()
    if (await retryBtn.count()) await retryBtn.click()
    await page.waitForFunction(() => window.__forsionStore.getState().connState === 'ok', null, { timeout: 15_000 }).catch(() => {})
    await page.waitForFunction(() => !document.querySelector('.t2-target-health'), null, { timeout: 5_000 }).catch(() => {})
    const retried = await page.evaluate((u) => ({ conn: window.__forsionStore.getState().connState, h: window.__forsionEngineTargets.health()[`unit:${u}`]?.state }), U)
    check('点「重试」→ 连上、健康 ready、提示消失', retried.conn === 'ok' && retried.h === 'ready' && !(await page.$('.t2-target-health')), JSON.stringify(retried))
    await page.evaluate(() => window.__forsionEngineTargets.setFocusTarget({ kind: 'home' }))

    // ── F. 隧道请求的不变量 ──
    const tunnel = world.hub.seen.filter((r) => r.url.startsWith(`/api/units/${U}/proxy/`))
    check('有隧道请求', tunnel.length > 10, String(tunnel.length))
    check('每条隧道请求都带 Bearer(forsion_token)', tunnel.every((r) => r.headers.authorization === `Bearer ${TOKEN}`), tunnel.filter((r) => r.headers.authorization !== `Bearer ${TOKEN}`).map((r) => r.url).slice(0, 3).join(','))
    check('不带 x-forsion-remote*(来源标记只许 unitWeb 盖,C1)', tunnel.every((r) => !Object.keys(r.headers).some((k) => k.startsWith('x-forsion-remote'))))
    check('URL 不含 token=(凭据只走头)', tunnel.every((r) => !/token=/.test(r.url)))
    check('设置 / 收件箱类没有进隧道', !tunnel.some((r) => /\/agent\/(inbox|channels|providers|hooks|approval-rules|plugins)/.test(r.url)), tunnel.filter((r) => /\/agent\/(inbox|channels|providers|hooks|approval-rules|plugins)/.test(r.url)).map((r) => r.url).join(','))
    check('页面无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
    if (process.env.ENGINE_TARGET_DEBUG) for (const r of world.hub.seen) console.log(`  [hub] ${new Date(r.at).toISOString().slice(11, 23)} ${r.offline ? 'OFF' : 'on '} ${r.method} ${r.url.replace(`/api/units/${U}/proxy`, '')}`)
    console.log(`screenshots → ${SHOT_DIR}`)
  } finally {
    if (browser) await browser.close().catch(() => {})
    killPreview()
    world.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error('✗', e?.stack || e); process.exit(1) })
