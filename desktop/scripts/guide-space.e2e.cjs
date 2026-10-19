/**
 * 使用指南 Space(Forsion Extend 0.9)× 真 Electron × 桩引擎:宿主那几条接缝和 Extend 的指南接在一起能不能用。
 *
 * 钉住:
 *  ① Extend 0.9 装在 <home>/plugins/forsion-extend/(比随包新、签名可信 → 播种不碰它),Ribbon 上出现「使用指南」,点开是
 *     只读阅读页(标题栏「只读」+「···」)、左栏章节树(锁住的章节有锁)、右栏「进度 / 问 Tangu」;
 *  ② 「带我去」(写下第一篇笔记 → 新建一篇笔记):切到笔记 Space、本章任务跟到右栏(伴读),**不替你按命令**,在真界面上圈住
 *     「新建笔记」(ctx.app.spotlight,2026-10-19);真点它 → 就地打勾,圈注自己挪到正文(本章下一条),「知道了」收起;
 *  ③ Lv.1 全做完(按成就计数)→ 重启后收件箱来一封升级信,阅读面板正文下挂着 Extend 画的任务卡;
 *  ④ 有「已达成未领取」的成就 → 奖杯(或收着它的「更多」)上有红点;
 *  ⑤ 页内 forsion:// 链接在应用内路由(不绕系统);
 *  ⑥ 锚点自检:Genesis guideSpotlight.ts 里 GUIDE_ANCHORS 的每一个名字,在真界面上都找得到(`--anchors` 只跑这一段,不要 Extend)。
 * 截图在 $SHOTS_DIR(缺省系统临时目录下 forsion-guide-space-shots/:阅读页亮 / 暗、伴读、收件箱信),交付前人眼看一遍。
 *
 * 需先 npm run build(读 out/)。用法:EXTEND_PKG=<已 build + sign 的 Forsion-Extend 检出> npm run e2e:guide;只查锚点:npm run check:guide-anchors
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.join(__dirname, '..')
const EXTEND = process.env.EXTEND_PKG
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'forsion-guide-space-shots')
const ANCHORS_ONLY = process.argv.includes('--anchors')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 按 Extend 的 package.json files 白名单把包拷进插件目录(同 npm 包的内容,含 SIGNATURE)。 */
function installExtend(home) {
  const pkg = JSON.parse(fs.readFileSync(path.join(EXTEND, 'package.json'), 'utf8'))
  const dest = path.join(home, 'plugins', 'forsion-extend')
  for (const f of ['package.json', ...pkg.files]) {
    fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true })
    fs.copyFileSync(path.join(EXTEND, f), path.join(dest, f))
  }
  return pkg.version
}

/** 有状态的收件箱桩:POST 进列表、PATCH 改已读 / 归档,GET 按 filter 回。 */
function inboxStub() {
  const msgs = []
  return {
    msgs,
    override: async ({ path: p, method, url, body }) => {
      if (p === '/agent/inbox' && method === 'POST') {
        const b = await body() // 桩引擎给的是读请求体的函数
        const m = { id: `ibx-${msgs.length + 1}`, title: b.title, body: b.body || '', sender_kind: 'system', sender_id: b.sender_id || 'desktop', origin_broadcast_id: null, thread: null, read_at: null, archived_at: null, created_at: new Date().toISOString().replace('T', ' ').slice(0, 19) }
        msgs.unshift(m)
        return { ok: true, id: m.id }
      }
      if (p === '/agent/inbox' && method === 'GET') {
        const filter = new URL(url, 'http://x').searchParams.get('filter') || 'all'
        return { messages: msgs.filter((m) => (filter === 'archived' ? m.archived_at : !m.archived_at) && (filter !== 'unread' || !m.read_at)) }
      }
      if (p === '/agent/inbox/unread-count') { const u = msgs.filter((m) => !m.read_at && !m.archived_at); return { count: u.length, latestId: u[0]?.id ?? null } }
      const hit = p.match(/^\/agent\/inbox\/([^/]+)$/)
      if (hit && method === 'PATCH') {
        const m = msgs.find((x) => x.id === decodeURIComponent(hit[1]))
        const b = await body() // 桩引擎给的是读请求体的函数
        if (m && typeof b.read === 'boolean') m.read_at = b.read ? 'now' : null
        if (m && typeof b.archived === 'boolean') m.archived_at = b.archived ? 'now' : null
        return { ok: !!m }
      }
      if (p.startsWith('/agent/inbox')) return { ok: true }
      return undefined
    },
  }
}

async function launch(home, stubUrl) {
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stubUrl, TANGU_HARNESS_QUIET: '1', PI_CU_SOCKET_PATH: path.join(home, 'bridge.sock') },
    timeout: 90_000,
  })
  const win = await app.firstWindow({ timeout: 120_000 })
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1512, 950) })
  await win.waitForSelector('#root', { timeout: 30_000 })
  return { app, win }
}

/** ⑥ 锚点名单直接从宿主源码读(GUIDE_ANCHORS),新加的锚点没进这里的路线 → 红,不会静默漏查。 */
async function checkAnchors(win) {
  const src = fs.readFileSync(path.join(ROOT, 'frontend/src/amadeus/plugins/guideSpotlight.ts'), 'utf8')
  const at = src.indexOf('export const GUIDE_ANCHORS')
  const block = src.slice(at, src.indexOf('\n}', at))
  const names = [...block.matchAll(/'([a-z][a-z-]+)': \{/g)].map((m) => m[1])
  const has = (n) => win.waitForFunction((x) => [...document.querySelectorAll(`[data-guide-anchor="${x}"]`)].some((e) => e.getBoundingClientRect().width > 0), n, { timeout: 8000 }).then(() => true, () => false)
  const space = async (label) => { await win.locator(`.rb-space[aria-label^="${label}"]`).first().click().catch(() => {}); await win.waitForTimeout(1200) }
  const seen = new Set()
  const look = async (n) => { if (!names.includes(n)) return; seen.add(n); check(`⑥ 锚点 ${n} 在真界面上`, await has(n)) }
  await look('ribbon-spaces')
  await space('Tangu'); await look('chat-composer')
  await space('笔记'); await look('note-new')
  await win.locator('.t2s-srow').filter({ hasText: '欢迎' }).first().click().catch(() => {}); await win.waitForTimeout(1500)
  await look('note-body'); await look('note-canvas')
  await space('Agents'); await look('agent-new')
  const missed = names.filter((n) => !seen.has(n))
  check('⑥ GUIDE_ANCHORS 每个名字都在自检路线上', names.length > 0 && !missed.length, `names=${names.join(',')}${missed.length ? ` 漏查=${missed.join(',')}` : ''}`)
}

async function main() {
  if (ANCHORS_ONLY) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-guide-anchors-'))
    const vault = path.join(home, 'Vault'); fs.mkdirSync(vault, { recursive: true })
    fs.writeFileSync(path.join(vault, '欢迎.md'), '# 欢迎\n\n这是隔离台架的笔记库。\n')
    const userData = path.join(home, 'userdata')
    for (const d of [userData, `${userData}-dev`]) {
      fs.mkdirSync(d, { recursive: true })
      for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) fs.writeFileSync(path.join(d, f), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2))
    }
    const stub = await startStubEngine({ models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna', provider: 'stub', source: 'forsion' }] })
    for (const d of [userData, `${userData}-dev`]) fs.writeFileSync(path.join(d, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'mock' }))
    const { app, win } = await launch(home, stub.url)
    try { check('首启引导点掉', await skipOnboarding(win)); await win.waitForTimeout(1500); await checkAnchors(win) } finally { await app.close().catch(() => {}); stub.close?.() }
    const failed = results.filter((r) => !r.ok)
    console.log(`\n${results.length - failed.length}/${results.length} passed`)
    process.exit(failed.length ? 1 : 0)
  }
  if (!EXTEND || !fs.existsSync(path.join(EXTEND, 'spaces/guide/space.json')) || !fs.existsSync(path.join(EXTEND, 'SIGNATURE'))) {
    console.error('EXTEND_PKG 要指向一份 build + sign 过的 Forsion-Extend 检出(带 spaces/guide/space.json 和 SIGNATURE)')
    process.exit(2)
  }
  fs.mkdirSync(SHOTS, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-guide-e2e-'))
  const vault = path.join(home, 'Vault')
  fs.mkdirSync(vault, { recursive: true })
  fs.writeFileSync(path.join(vault, '欢迎.md'), '# 欢迎\n\n这是隔离台架的笔记库。\n')
  const userData = path.join(home, 'userdata')
  for (const d of [userData, `${userData}-dev`]) {
    fs.mkdirSync(d, { recursive: true })
    for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) fs.writeFileSync(path.join(d, f), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2))
  }
  const version = installExtend(home)
  const inbox = inboxStub()
  const stub = await startStubEngine({ models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna', provider: 'stub', source: 'forsion' }], override: inbox.override })
  for (const d of [userData, `${userData}-dev`]) fs.writeFileSync(path.join(d, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'mock' }))

  let { app, win } = await launch(home, stub.url)
  try {
    check('首启引导点掉', await skipOnboarding(win))
    const installed = JSON.parse(fs.readFileSync(path.join(home, 'plugins/forsion-extend/manifest.json'), 'utf8')).version
    check('① 播种保留已装的 Extend 0.9(没被随包旧版换掉)', installed === version, `installed=${installed}`)
    // 指南排在 Space 列表末尾,Space 一多就收进上区的「…」:先展开再找
    const guideBtn = win.locator('.rb [aria-label="使用指南"]').first()
    await win.waitForTimeout(1500)
    if (!(await guideBtn.count())) await win.locator('.rb-more[data-rb-more="top"]').click().catch(() => {})
    await guideBtn.waitFor({ timeout: 20_000 }).catch(() => {})
    check('① Ribbon 上有「使用指南」', await guideBtn.count() > 0)
    await guideBtn.click().catch(() => {})
    const reader = win.locator('.fxg-reader')
    await reader.waitFor({ timeout: 15_000 }).catch(() => {})
    check('① 主区是指南阅读页,标题栏有「只读」', (await win.locator('.fxg-reader .fxg-ro').textContent().catch(() => '')) === '只读')
    await win.waitForFunction(() => !!document.querySelector('.fxg-reader .ProseMirror h1'), null, { timeout: 15_000 }).catch(() => {})
    check('① 正文是只读 Amadeus 页(认识 Forsion)', /认识 Forsion/.test(await win.locator('.fxg-reader .ProseMirror h1').first().textContent().catch(() => '')))
    check('① 正文不可编辑', await win.locator('.fxg-reader .ProseMirror').first().getAttribute('contenteditable').catch(() => null) === 'false')
    check('① 右栏是进度', await win.locator('.fxg-side .fxg-h').count() > 0)
    const agentRow = win.getByText('创建你的 Agent', { exact: true }).first()
    check('① 左栏章节树列到 Lv.3', await agentRow.count() > 0)
    await win.waitForTimeout(600)
    await win.screenshot({ path: path.join(SHOTS, 'reader.png') })

    // ② 带我去:写下第一篇笔记 → 新建一篇笔记
    await win.getByText('写下第一篇笔记', { exact: true }).first().click()
    await win.waitForFunction(() => /写下第一篇笔记/.test(document.querySelector('.fxg-reader .ProseMirror h1')?.textContent || ''), null, { timeout: 10_000 }).catch(() => {})
    check('A2 阅读页导语下有示意图(三处编号)', await win.locator('.fxg-reader .fxg-figure-cap b').count() === 3)
    await win.screenshot({ path: path.join(SHOTS, 'reader-figure.png') })
    await win.locator('.fxg-task[data-task="note-create"] .fxg-go').click()
    const companion = win.locator('.fxg-companion')
    await companion.waitFor({ timeout: 15_000 }).catch(() => {})
    check('② 伴读挂到目标 Space 的右栏', await companion.count() > 0 && await win.locator('.fxg-reader').count() === 0)
    // 圈注:圈套住「新建笔记」(界面缩放下也对齐),卡说点它;命令没替你按
    const ringOn = (anchor) => win.waitForFunction((a) => {
      const ring = document.querySelector('.guide-spot-ring'), el = [...document.querySelectorAll(`[data-guide-anchor="${a}"]`)].find((e) => e.getBoundingClientRect().width > 0)
      if (!ring || !el) return false
      const r = ring.getBoundingClientRect(), b = el.getBoundingClientRect()
      return r.left <= b.left && r.top <= b.top && r.right >= b.left + Math.min(b.width, 40) && r.bottom >= b.top + Math.min(b.height, 30)
    }, anchor, { timeout: 10_000 }).then(() => true, () => false)
    check('② 圈住了「新建笔记」', await ringOn('note-new'))
    check('② 小卡写着第几步和要点什么', /第 1 步/.test(await win.locator('.guide-spot-step').textContent().catch(() => '')) && /新建笔记/.test(await win.locator('.guide-spot-title').textContent().catch(() => '')))
    check('② 伴读标出正在做的这一条', await win.locator('.fxg-companion .fxg-task[data-task="note-create"].is-current').count() > 0)
    check('② 「带我去」没替你按(笔记还没建)', await win.locator('.fxg-companion .fxg-task[data-task="note-create"].is-done').count() === 0)
    await win.waitForTimeout(400)
    await win.screenshot({ path: path.join(SHOTS, 'spot-new-note.png') })
    await win.locator('[data-guide-anchor="note-new"]').first().click()
    await win.waitForFunction(() => !!document.querySelector('.fxg-companion .fxg-task[data-task="note-create"].is-done'), null, { timeout: 15_000 }).catch(() => {})
    check('② 真点了「新建笔记」→ 伴读就地打勾', await win.locator('.fxg-companion .fxg-task[data-task="note-create"].is-done').count() > 0)
    check('② 圈注自己挪到正文(本章下一条)', await ringOn('note-body') && /\[\[/.test(await win.locator('.guide-spot-title').textContent().catch(() => '')))
    await win.waitForTimeout(600)
    await win.screenshot({ path: path.join(SHOTS, 'companion.png') })
    await win.locator('.guide-spot-card .btn').click().catch(() => {})
    check('② 「知道了」收起圈注', await win.waitForFunction(() => !document.querySelector('.guide-spot-ring'), null, { timeout: 3000 }).then(() => true, () => false))

    // ⑤ 页内 forsion:// 链接:插一条链接点一下,应用内切到指南 Space(不绕系统)
    const routed = await win.evaluate(async () => {
      const a = document.createElement('a'); a.href = 'forsion://space/forsion-guide'; a.textContent = 'x'; document.body.appendChild(a)
      a.click(); a.remove()
      for (let i = 0; i < 40; i++) { if (document.querySelector('.fxg-reader')) return true; await new Promise((r) => setTimeout(r, 100)) }
      return false
    })
    check('⑤ 页内 forsion:// 链接在应用内路由', routed)

    // ③ Lv.1 全做完 → 重启 → 升级信 + 卡
    await win.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('forsion_tangu_achievements') || '{"v":1,"counters":{},"claimed":[]}')
      Object.assign(raw.counters, { 'plugin:forsion-extend:guide.open': 1, 'space.switch': 1, 'chat.send': 5, 'note.create': 1, 'note.wikilink': 1, 'note.canvas': 1, 'theme.change': 1 })
      localStorage.setItem('forsion_tangu_achievements', JSON.stringify(raw))
    })
    await app.close()
    ;({ app, win } = await launch(home, stub.url))
    await win.waitForFunction(() => !!document.querySelector('.shell-host'), null, { timeout: 30_000 }).catch(() => {})
    for (let i = 0; i < 40 && !inbox.msgs.length; i++) await win.waitForTimeout(250)
    const letter = inbox.msgs.find((m) => m.sender_id === 'plugin:forsion-extend')
    check('③ 升级发了一封指南信(发件人 plugin:forsion-extend)', !!letter && /Lv\.2/.test(letter.title), letter?.title || JSON.stringify(inbox.msgs.map((m) => [m.sender_id, m.title])))
    const dot = await win.waitForFunction(() => !!document.querySelector('.rb .rb-dot'), null, { timeout: 10_000 }).then(() => true, () => false)
    check('④ 有可领成就 → Ribbon 上有红点', dot)
    await win.locator('.rb [aria-label^="收件箱"], .rb [data-rb-tip^="收件箱"]').first().click().catch(() => {})
    await win.getByText(letter?.title || '—', { exact: true }).first().click({ timeout: 10_000 }).catch(() => {})
    const card = win.locator('[data-inbox-plugin-card] .fxg-letter')
    await card.waitFor({ timeout: 10_000 }).catch(() => {})
    check('③ 收件箱阅读面板挂着 Extend 的任务卡', await card.count() > 0 && /数据库/.test(await card.textContent().catch(() => '')))
    check('③ 发件人显示「使用指南」', await win.getByText('使用指南').count() > 0)
    await win.waitForTimeout(600)
    await win.screenshot({ path: path.join(SHOTS, 'inbox-letter.png') })

    // 暗色下的阅读页
    await win.evaluate(() => { const a = document.createElement('a'); a.href = 'forsion://space/forsion-guide'; document.body.appendChild(a); a.click(); a.remove() })
    await win.locator('.fxg-reader').waitFor({ timeout: 10_000 }).catch(() => {})
    await win.evaluate(() => { const r = document.documentElement; r.dataset.mode = 'dark'; r.classList.add('dark') })
    await win.waitForTimeout(800)
    await win.screenshot({ path: path.join(SHOTS, 'reader-dark.png') })
    await win.evaluate(() => { const r = document.documentElement; r.dataset.mode = 'light'; r.classList.remove('dark') })
    await checkAnchors(win)
  } finally {
    await app.close().catch(() => {})
    stub.close?.()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed · 截图 ${SHOTS}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
