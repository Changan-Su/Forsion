/**
 * 活动中心(Forsion Extend 0.9.6)× 真 Electron × 假云端:Ribbon 入口、浮窗面板、签到领取、跨窗跳转。
 *
 * 钉住:
 *  ① 有活动时 Ribbon 上出现「活动」(排在商店前)、带红点;主页入口排也有;点开是原生浮窗,不是主窗里的页;
 *  ② 浮窗里签到 / 领取走真 cloud:fetch,主窗红点跟着灭(跨渲染进程靠 localStorage 通知);
 *  ③ 「去完成」的 forsion:// 链接在浮窗里点,落到主窗(host openLink → open-link MainAction);
 *  ④ 小游戏没装 → 打开商店浮窗并带上搜索词;「查看背包」→ 设置浮窗落在背包页;
 *  ⑤ forsion://open?view=plugin:forsion-extend:events&id=… 打开面板并选中那一场;
 * 活动全结束后入口收掉、拉取失败留着上一份由 Extend 的 events.test.tsx 管,这里不重复。
 * 截图在 --out(缺省系统临时目录 forsion-events-center):亮 / 暗 / 主题色 / 窄窗,交付前和方案图 A 并排看一遍。
 *
 * --server=<server 检出>:活动接口换成真路由 × PGlite(server/scripts/events-local-cloud.ts),活动由后台接口发布,核对奖励真的进了账本。
 *
 * --hold=<秒>:摆台,实例停在主页不跑断言,留给人或 computer use 上手;--out 下出现 done 文件就提前退。CU 要配 STAGE_ELECTRON(独有 bundle id 的 Electron 拷贝,见 gui-verify §4.2)。
 *
 * 需先 npm run build(读 out/)。用法:node scripts/events-center.e2e.cjs --pkg=<已 build + sign 的 Extend 检出> [--server=<server 检出>]
 */
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), { spawn } = require('child_process')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { startFakeForsionCloud } = require('./lib/fake-forsion-cloud.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const arg = (key) => process.argv.find((x) => x.startsWith(`--${key}=`))?.slice(key.length + 3)
const ROOT = path.resolve(__dirname, '..'), PKG = arg('pkg'), SERVER = arg('server'), HOLD = Number(arg('hold') || 0)
const OUT = path.resolve(arg('out') || path.join(os.tmpdir(), 'forsion-events-center'))
const results = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`) }

// 真服务端给的是 /api/events/art/*.webp;台架走 http,CSP 只放行 data:
const art = (a, b) => 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="1600" height="1000" fill="url(#g)"/><circle cx="1180" cy="430" r="240" fill="#fff" opacity=".35"/></svg>`).toString('base64')
const t = (zh, en) => ({ zh, en })
const pts = (n) => ({ kind: 'points', amount: n, label: t(`积分 ×${n}`, `Points ×${n}`) })
const iso = (d) => new Date(Date.now() + d * 86400e3).toISOString()
const base = (id, kind, title, summary, a, b, sort) => ({ id, kind, state: 'live', title, summary, body: null, artUrl: art(a, b), focus: { x: 0.5, y: 0.5 }, startsAt: iso(-10), endsAt: iso(5.6), claimUntil: iso(8.6), sort, rewards: [pts(20), { kind: 'reset_card', label: t('重置卡 ×1', 'Reset card ×1') }], cta: null, claimable: 0 })

function fixture() {
  const s = { signed: 3, signedToday: false, claimed: new Set() }
  const feed = () => {
    const events = [
      { ...base('sign', 'checkin', t('金秋七日签到', 'Seven-day check-in'), t('累计签到 7 天，领重置卡。', 'Check in for 7 days to earn a reset card.'), '#d9a441', '#8f4f1f', 1), claimable: s.signedToday ? 0 : 1, checkin: { days: 7, rewards: Array.from({ length: 7 }, (_, i) => (i === 6 ? [{ kind: 'reset_card', label: t('重置卡 ×1', 'Reset card ×1') }] : [pts(20)])), signed: s.signed, signedToday: s.signedToday } },
      { ...base('quests', 'tasks', t('创作者任务', 'Creator quests'), t('用 Tangu 做点东西，领积分。', 'Build something with Tangu and earn points.'), '#4f86c6', '#27406f', 2), claimable: ['publish', 'chat'].filter((x) => !s.claimed.has(x)).length, tasks: [
        { id: 'tokens', title: t('消耗 10k token', 'Use 10k tokens'), desc: t('活动期间托管模型的累计用量', 'Hosted model usage during the event'), metric: 'server:tokens_hosted', goal: 10000, progress: 8400, reward: [pts(200)], claimed: false, jump: 'forsion://space/tangu' },
        { id: 'publish', title: t('发布 1 个插件', 'Publish a plugin'), desc: t('审核通过后计入', 'Counts once approved'), metric: 'server:plugin_approved', goal: 1, progress: 1, reward: [pts(500)], claimed: s.claimed.has('publish'), jump: null },
        { id: 'chat', title: t('发 20 条消息', 'Send 20 messages'), desc: t('活动期间累计', 'During the event'), metric: 'chat.send', goal: 20, progress: 20, reward: [pts(50)], claimed: s.claimed.has('chat'), jump: null },
      ] },
      { ...base('pot', 'game', t('中秋投壶', 'Pitch-pot'), t('投中得分，赢月饼。', 'Score to win mooncakes.'), '#3e8e7e', '#1e4a45', 3), game: { pluginId: 'forsion-events', spaceId: 'forsion-events', marketSlug: 'forsion-events', leaderboard: [{ rank: 1, name: '小满', score: 980 }, { rank: 2, name: 'Mika', score: 860 }], me: { rank: 14, score: 320 } } },
      { ...base('n1', 'notice', t('11 月维护公告', 'November maintenance'), t('11 月 3 日凌晨维护两小时。', 'Two hours of maintenance on Nov 3.'), '#8a8f98', '#3c4048', 4), endsAt: null, rewards: [], body: t('## 维护时间\n\n11 月 3 日 02:00–04:00。', '## When\n\nNov 3, 02:00–04:00.'), cta: { url: 'https://forsion.net/', label: t('查看详情', 'Details') } },
      { ...base('next', 'tasks', t('新春活动', 'Lunar New Year'), t('敬请期待。', 'Stay tuned.'), '#c0504d', '#6b2422', 5), state: 'upcoming', startsAt: iso(30), endsAt: iso(44), tasks: [] },
    ]
    return { now: new Date().toISOString(), today: new Date().toISOString().slice(0, 10), events }
  }
  return { s, feed }
}

const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => ok(b ? JSON.parse(b) : {})) })

async function panelWindow(app, win, selector = '.ev-root') {
  for (let i = 0; i < 100; i++) {
    for (const w of app.windows()) if (w.url().includes('window=floating') && await w.locator(selector).count().catch(() => 0)) return w
    await win.waitForTimeout(150)
  }
  return null
}

function startLocalCloud(dir) {
  const child = spawn(path.join(dir, 'node_modules/.bin/tsx'), ['scripts/events-local-cloud.ts'], { cwd: dir, stdio: ['pipe', 'pipe', 'inherit'] })
  return new Promise((ok, no) => {
    let out = ''
    child.stdout.on('data', (d) => { out += d; const line = out.split('\n').find((x) => x.startsWith('{"url"')); if (line) ok(JSON.parse(line)) })
    child.on('exit', (code) => no(new Error(`本地后端退出 ${code}`)))
  })
}

/** 真后端:后台接口发布的活动 → 真面板签到、领取 → 账本里真有这几笔。 */
async function realFlow(sp, local) {
  const state = async () => (await fetch(`${local.url}/__e2e/state`)).json()
  const until = async (fn) => { for (let i = 0; i < 40; i++) { const s = await state(); if (fn(s)) return s; await sp.waitForTimeout(150) } return state() }
  await sp.locator('.ev-rail').waitFor()
  const rail = await sp.locator('.ev-rail').innerText()
  check('真后端:左栏是后台发布的四场', ['金秋七日签到', '创作者任务', '中秋投壶', '11 月维护公告'].every((x) => rail.includes(x)), rail.replace(/\n/g, ' / '))
  // 台架走 http,CSP 拦图 → 面板退回占位;生产是 https。这里直接核接口
  const feed = await (await fetch(`${local.url}/api/events/feed`, { headers: { authorization: `Bearer ${local.token}` } })).json()
  const artPath = feed.events.find((e) => e.artUrl)?.artUrl ?? ''
  const art = await fetch(local.url + artPath).catch(() => null)
  check('真后端:主视觉走公开地址,长缓存', /^\/api\/events\/art\/[a-f0-9]{64}\.png$/.test(artPath) && art?.status === 200 && /immutable/.test(art.headers.get('cache-control')), artPath)

  await sp.locator('.ev-ri', { hasText: '金秋七日签到' }).click()
  await sp.getByRole('button', { name: '今日签到' }).click()
  let s = await until((x) => x.balance === 20)
  check('真后端:签到的积分进了账本', s.balance === 20 && s.ledger.length === 1, JSON.stringify(s.ledger))
  await sp.getByRole('button', { name: '今日已签' }).waitFor().catch(() => {})
  check('真后端:按钮变成今日已签,1/7 → 已签 1', await sp.getByRole('button', { name: '今日已签' }).count() === 1 && /已签 1\/7/.test(await sp.locator('.ev-stage').innerText()))

  await sp.locator('.ev-ri', { hasText: '创作者任务' }).click()
  const stage = sp.locator('.ev-stage')
  check('真后端:托管用量和插件过审算出进度', /10k\/10k/.test(await stage.innerText()) && /1\/1/.test(await stage.innerText()) && /0\/3/.test(await stage.innerText()))
  await sp.getByRole('button', { name: '全部领取 (2)' }).click()
  s = await until((x) => x.balance === 720)
  check('真后端:全部领取两笔都到账', s.balance === 720 && s.ledger.length === 3, `balance=${s.balance}`)
  await sp.waitForTimeout(400)
  check('真后端:领完没有可领的了', await sp.getByRole('button', { name: '领取' }).count() === 0)
  check('真后端:奖励不重发(重开面板状态还在)', await sp.reload().then(() => sp.locator('.ev-rail').waitFor()).then(() => sp.locator('.ev-ri', { hasText: '创作者任务' }).click()).then(() => sp.getByRole('button', { name: '领取' }).count()) === 0)

  await sp.locator('.ev-ri', { hasText: '中秋投壶' }).click()
  await sp.getByText('还没有人上榜').waitFor().catch(() => {})
  check('真后端:小游戏榜单为空时的样子', await sp.getByText('还没有人上榜').count() === 1)
  await sp.locator('.ev-ri', { hasText: '11 月维护公告' }).click()
  await sp.waitForTimeout(500)
  check('真后端:公告正文渲染,并写了一条弹窗公告', /维护时间/.test(await sp.locator('.ev-stage').first().evaluate((el) => [...el.querySelectorAll('*')].map((e) => e.shadowRoot?.textContent ?? '').join(''))) && (await state()).announcements.length === 1)
  await sp.locator('.ev-foot button, .ev-rail button').filter({ hasText: '已结束的活动' }).click()
  await sp.waitForTimeout(300)
  const ended = sp.locator('.ev-ri').first()
  check('真后端:旧的中秋活动在已结束里', await ended.count() === 1, await ended.innerText().catch(() => ''))
  await ended.click()
  await sp.waitForTimeout(400)
  check('真后端:点开旧活动不崩', await sp.locator('.ev-stage').count() === 1)
  await sp.screenshot({ path: path.join(OUT, 'real-ended.png') })
}

async function main() {
  if (!PKG || !fs.existsSync(path.join(PKG, 'SIGNATURE'))) { console.error('要传 --pkg=<build + sign 过的 Extend 检出>'); process.exit(2) }
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-events-'))
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'))
  for (const f of ['package.json', ...pkg.files]) {
    const dest = path.join(home, 'plugins/forsion-extend', f)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.cpSync(path.join(PKG, f), dest, { recursive: true })
  }
  const stub = await startStubEngine(), cloud = await startFakeForsionCloud({ scenario: 'both' })
  const { s, feed } = fixture()
  const posts = []
  const local = SERVER ? await startLocalCloud(SERVER) : null
  const json = (res, code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)) }
  const front = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0]
    if (local && url.startsWith('/api/events')) {
      const { host: _host, ...headers } = req.headers
      const up = http.request(local.url + req.url, { method: req.method, headers: { ...headers, authorization: `Bearer ${local.token}` } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res) })
      up.on('error', () => json(res, 502, {})); return req.pipe(up)
    }
    if (url === '/api/events/feed') return json(res, 200, feed())
    if (url === '/api/events/sign/checkin' && req.method === 'POST') {
      posts.push(url); s.signedToday = true; s.signed += 1
      return json(res, 200, { ok: true, alreadySigned: false, day: s.signed, reward: [pts(20)], feed: feed() })
    }
    if (url === '/api/events/quests/tasks/claim' && req.method === 'POST') {
      const { ids } = await readBody(req)
      posts.push(`${url} ${[...ids].sort()}`); ids.forEach((id) => s.claimed.add(id))
      return json(res, 200, { results: ids.map((id) => ({ id, ok: true, reward: [pts(500)] })), feed: feed() })
    }
    const up = http.request(cloud.url + req.url, { method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res) })
    up.on('error', () => json(res, 502, {})); req.pipe(up)
  })
  await new Promise((r) => front.listen(0, '127.0.0.1', r))
  const cloudUrl = `http://127.0.0.1:${front.address().port}`
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const creds = { cloudUrl, token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ userId: 'u1', username: 'demo_user' })}.fixture` }
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(creds))
  fs.writeFileSync(path.join(home, 'auth-accounts.json'), JSON.stringify({ version: 1, accounts: [{ id: `${cloudUrl}::u1`, ...creds, username: 'demo_user' }] }))

  const errors = []
  let app
  try {
    app = await electron.launch({ ...(process.env.STAGE_ELECTRON ? { executablePath: process.env.STAGE_ELECTRON } : {}), args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1' }, timeout: 90000 })
    const win = await app.firstWindow()
    await win.waitForSelector('#root')
    await skipOnboarding(win)
    await win.addStyleTag({ content: '.sync-setup-backdrop { display: none !important; }' }) // 登录后首次同步卡,这里不测它
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1512, 950) })

    if (HOLD) {
      console.log('HOLD ready')
      const until = Date.now() + HOLD * 1000
      while (Date.now() < until && !fs.existsSync(path.join(OUT, 'done'))) await new Promise((r) => setTimeout(r, 500))
      await app.close().catch(() => {})
      process.exit(0)
    }

    // ① 入口
    const entry = win.locator('.rb [aria-label="活动"]').first()
    await entry.waitFor({ timeout: 20000 }).catch(() => {})
    check('① Ribbon 上有「活动」', await entry.count() > 0)
    const order = await win.evaluate(() => [...document.querySelectorAll('.rb [aria-label]')].map((e) => e.getAttribute('aria-label')))
    check('① 排在商店前', order.indexOf('活动') >= 0 && order.indexOf('活动') < order.indexOf('商店'), order.join(' / '))
    check('① 有红点', await entry.locator('.rb-dot').count() > 0)
    await win.screenshot({ path: path.join(OUT, 'main-ribbon.png') })

    await entry.click()
    const sp = await panelWindow(app, win)
    check('① 点开是独立浮窗', !!sp)
    if (!sp) throw new Error('面板没开')
    sp.on('pageerror', (e) => errors.push(String(e)))
    sp.setDefaultTimeout(12000)
    if (local) await realFlow(sp, local)
    else await fixtureFlow()
    async function fixtureFlow() {
    await sp.locator('.ev-rail').waitFor()
    const rail = await sp.locator('.ev-rail').innerText()
    check('① 左栏列出四场和预告', ['金秋七日签到', '创作者任务', '中秋投壶', '11 月维护公告', '新春活动'].every((x) => rail.includes(x)))
    const geo = await sp.evaluate(() => { const a = document.querySelector('.ev-rail').getBoundingClientRect(), b = document.querySelector('.ev-main').getBoundingClientRect(); return { rail: a.width, mainLeft: b.left, overflow: document.documentElement.scrollWidth > innerWidth } })
    check('① 左右布局,无横向溢出', geo.rail > 150 && geo.mainLeft >= geo.rail && !geo.overflow, JSON.stringify(geo))
    await sp.waitForTimeout(500)
    await sp.screenshot({ path: path.join(OUT, 'panel-checkin-light.png') })

    // ② 签到
    await sp.getByRole('button', { name: '今日签到' }).click()
    await sp.getByText('已签到，积分 ×20').waitFor().catch(() => {})
    check('② 签到发到云端,提示条有奖励', posts.includes('/api/events/sign/checkin') && await sp.getByText('已签到，积分 ×20').count() > 0)
    check('② 按钮变成今日已签', await sp.getByRole('button', { name: '今日已签' }).isDisabled().catch(() => false))

    // ④ 背包
    const backpack = sp.getByRole('button', { name: '查看背包' })
    await backpack.click().catch(() => {})
    const st = await panelWindow(app, win, '.settings-page')
    check('④ 「查看背包」打开设置浮窗', !!st)
    if (st) {
      await st.waitForTimeout(1200)
      check('④ 设置落在背包页', /背包/.test(await st.locator('.settings-page').innerText().catch(() => '')))
      await st.close().catch(() => {})
    }

    // ② 领取
    await sp.locator('.ev-ri', { hasText: '创作者任务' }).click()
    await sp.getByRole('button', { name: '全部领取 (2)' }).waitFor()
    await sp.waitForTimeout(300)
    await sp.screenshot({ path: path.join(OUT, 'panel-tasks-light.png') })
    await sp.getByRole('button', { name: '全部领取 (2)' }).click()
    await sp.getByText(/已领取/).first().waitFor().catch(() => {})
    check('② 全部领取把两条一起发给云端', posts.includes('/api/events/quests/tasks/claim chat,publish'), posts.join(' ; '))
    await win.waitForTimeout(900)

    // 其余两种舞台和暗色 / 主题色
    await sp.locator('.ev-ri', { hasText: '中秋投壶' }).click()
    await sp.getByRole('button', { name: '去商店安装' }).waitFor().catch(() => {})
    check('④ 没装插件时按钮是去商店安装', await sp.getByRole('button', { name: '去商店安装' }).count() > 0)
    await sp.waitForTimeout(300)
    await sp.screenshot({ path: path.join(OUT, 'panel-game-light.png') })
    await sp.locator('.ev-ri', { hasText: '11 月维护公告' }).click()
    await sp.waitForTimeout(400)
    await sp.screenshot({ path: path.join(OUT, 'panel-notice-light.png') })
    await win.waitForFunction(() => !document.querySelector('.rb [aria-label="活动"] .rb-dot'), null, { timeout: 5000 }).catch(() => {})
    check('② 都看过、领完后主窗红点灭', await entry.locator('.rb-dot').count() === 0)
    await sp.locator('.ev-ri', { hasText: '创作者任务' }).click()
    const mode = (m) => sp.evaluate((v) => { const r = document.documentElement; r.dataset.mode = v; r.classList.toggle('dark', v === 'dark') }, m)
    const skin = (v) => sp.evaluate((x) => { const r = document.documentElement; r.dataset.skin = x; r.dataset.bg = x }, v)
    await mode('dark')
    await sp.waitForTimeout(300)
    await sp.screenshot({ path: path.join(OUT, 'panel-tasks-dark.png') })
    await mode('light')
    await skin('teal')
    await sp.waitForTimeout(300)
    await sp.screenshot({ path: path.join(OUT, 'panel-tasks-teal.png') })
    await skin('')
    await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)?.setContentSize(760, 620), sp.url())
    await sp.waitForTimeout(500)
    await sp.screenshot({ path: path.join(OUT, 'panel-tasks-narrow.png') })
    await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)?.setContentSize(1040, 720), sp.url())

    // ④ 商店
    await sp.locator('.ev-ri', { hasText: '中秋投壶' }).click()
    await sp.getByRole('button', { name: '去商店安装' }).click()
    await win.waitForTimeout(1500)
    const marketWin = app.windows().find((w) => /window=floating/.test(w.url()) && w !== sp)
    check('④ 打开了商店浮窗', !!marketWin, app.windows().map((w) => w.url().slice(-40)).join(' , '))
    await marketWin?.close().catch(() => {})

    // ③ 浮窗里点 forsion:// 落到主窗
    const activeSpace = () => win.evaluate(() => document.querySelector('.rb-space.on')?.getAttribute('aria-label') ?? '')
    await win.locator('.rb-space[aria-label="笔记"]').click()
    await win.waitForFunction(() => document.querySelector('.rb-space.on')?.getAttribute('aria-label') === '笔记').catch(() => {})
    check('③ 前置:主窗在笔记', await activeSpace() === '笔记', await activeSpace())
    await sp.locator('.ev-ri', { hasText: '创作者任务' }).click()
    const mainUrl = win.url()
    await app.evaluate(({ BrowserWindow }, u) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === u)?.hide(), mainUrl)
    await sp.getByRole('button', { name: '去完成' }).click()
    await win.waitForTimeout(800)
    check('③ 主窗藏着时跳转会把它叫回来', await app.evaluate(({ BrowserWindow }, u) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === u)?.isVisible(), mainUrl))
    await win.waitForFunction(() => document.querySelector('.rb-space.on')?.getAttribute('aria-label') === 'Tangu', null, { timeout: 8000 }).catch(() => {})
    check('③ 「去完成」让主窗切到 Tangu', await activeSpace() === 'Tangu', await activeSpace())
    await win.waitForTimeout(600)
    check('③ 跳走后面板自己关了', sp.isClosed())

    // ⑤ 深链
    await app.evaluate(({ app }) => { app.emit('open-url', { preventDefault() {} }, 'forsion://open?view=plugin:forsion-extend:events&id=pot') })
    await win.waitForTimeout(1500)
    check('⑤ 深链打开面板并选中那一场', /中秋投壶/.test(await win.locator('.ev-stage').first().innerText().catch(() => '')), 'main view')

    // ⑥ 手机宽度(浮窗有最小宽,借主窗这份整页把面板收窄):详情 ↔ 列表两级
    await win.evaluate(() => { const r = document.querySelector('.ev-root'); r.style.width = '390px'; r.style.height = '800px' })
    await win.waitForTimeout(500)
    check('⑥ 手机宽度是单列详情', await win.locator('.ev-body.phone .ev-stage').count() === 1 && await win.locator('.ev-rail').count() === 0)
    await win.locator('.ev-root').screenshot({ path: path.join(OUT, 'phone-detail.png') })
    await win.locator('.ev-phone-back').click()
    await win.waitForTimeout(300)
    check('⑥ 返回是活动列表', await win.locator('.ev-rail').count() === 1 && await win.locator('.ev-stage').count() === 0)
    await win.locator('.ev-root').screenshot({ path: path.join(OUT, 'phone-list.png') })
    }

  } finally {
    await app?.close().catch(() => {})
    await new Promise((r) => front.close(r))
    await cloud.close?.().catch?.(() => {})
    await stub.close?.()
  }
  check('页面没有未捕获错误', errors.length === 0, errors.slice(0, 2).join(' ; '))
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed;截图在 ${OUT}`)
  process.exit(failed.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
