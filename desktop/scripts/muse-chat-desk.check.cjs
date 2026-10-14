/**
 * Muse 私聊 × Agent Desk 空闲面 —— 真 Electron × 真组件 / store × 可编剧假引擎(2026-10-13)。
 *
 * 用户定的形态:点 Muse 行进的是和它的私聊(推翻 09-16 轨道方案 D18「Muse 行只进 Space」);聊天右侧的 Agent Desk
 * 空闲时演 Muse Space(缺省是右侧一张小卡,点开才是侧板),Agent 往 Desk 上放东西才让位。
 * 实现 = AgentDesk.useDeskHome(渲染期合成一格 `muse-library` 视图)。
 *
 * 钉住:
 *  M1 点 Muse 行 → 聊天面换到它的私聊会话,停在 Tangu Space(没有被带去 Muse Space)
 *  M2 一条消息都没发,右侧车道已有一张小卡,里面是 Muse Space;侧板不自己展开(用户 10-14 定「缺省小卡」)
 *  M2b 小卡里文件库视图只留文件列表(预览栏挤不下,会把标题挤成一字一行);展开成侧板后预览栏回来(M6)
 *  M3 负对照:别的 Agent 的私聊没发消息时没有 Desk(卡片与侧板都不挂)
 *  M4 Agent 往 Desk 上放文件(desk_present,不带 size)→ 小卡换成那份文件,Muse Space 让位,仍是小卡
 *  M5 小卡上的「清空 Desk」→ Muse Space 回来
 *  M6 点小卡 → 展开成侧板,里面是 Muse Space(Library 里的 Home.md 看得到);切到别的会话再回来仍展开;「收起为卡片」→ 回到小卡
 *  M7 行菜单有「新会话(先总结记忆)」和「打开 Muse Space」;后者照旧切到整页的 Muse Space
 *  M8 截图(亮 = 小卡 / 暗 = 展开)
 *  M9 全程没有渲染进程异常
 *
 * 负对照:`--nc=nohome` 把 Muse 的会话夹具换成没有 soloAgentSlug 的普通会话 → M2 / M2b / M5 / M6 必须转红。
 *
 * 需先 npm run build(跑的是 out/;隔离 --user-data-dir 不抢单实例锁)。
 * 用法:npm run check:musechat [-- --shots <dir>] [-- --nc=nohome]
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const argv = process.argv.slice(2)
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
const SHOT_DIR = path.resolve(argOf('--shots') || path.join(os.tmpdir(), 'forsion-musechat-shots'))
const NC = (argv.find((a) => a.startsWith('--nc=')) || '').split('=')[1] || ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const MUSE_ID = 'mc-muse'
const NOVA_ID = 'mc-nova'
const T = { clear: ['清空 Desk', 'Clear Desk'], collapse: ['收起为卡片', 'Collapse to card'] }
const btnSel = (scope, labels) => labels.map((l) => `${scope} button[title="${l}"]`).join(', ')

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-musechat-'))
  const userData = path.join(home, 'userdata')
  const lib = path.join(home, 'agents', 'muse', 'Library')
  const novaLib = path.join(home, 'agents', 'nova', 'Library')
  fs.mkdirSync(path.join(lib, 'Journal'), { recursive: true })
  fs.mkdirSync(novaLib, { recursive: true })
  fs.writeFileSync(path.join(lib, 'Home.md'), '# Muse\n\n这里是 Muse 的工作区。\n', 'utf8')
  fs.writeFileSync(path.join(lib, 'Journal', '2026-10-13.md'), '# 2026-10-13\n\n- 20:03 · ask · heartbeat · tokens 1234 · files 1 · done · 整理了本周的读书笔记\n', 'utf8')
  const presented = path.join(lib, 'draft-plan.md')
  fs.writeFileSync(presented, '# 草稿:本周计划\n\n- 周三前把路线图发给团队\n', 'utf8')

  const AGENTS = [
    { slug: 'xyra', name: 'Xyra', description: 'General assistant', createdBy: 'user', libraryDir: path.join(home, 'agents', 'xyra', 'Library') },
    { slug: 'muse', name: 'Muse', description: 'Background agent', createdBy: 'system', libraryDir: lib },
    { slug: 'nova', name: 'Nova', description: 'Another agent', createdBy: 'user', libraryDir: novaLib },
  ]
  const session = (id, title, cfg) => ({
    id, title, summary: '', model_id: 'm1', archived: false, emoji: null, agent_config: cfg, project_path: null, project_name: null,
    created_at: '2026-10-13 21:00:00', updated_at: '2026-10-13 21:00:00',
  })
  const museCfg = NC === 'nohome'
    ? { agentSlug: 'muse', execMode: 'host', cwd: lib, preset: null } // 负对照:不是私聊身份 → 没有空闲面
    : { soloAgentSlug: 'muse', agentSlug: 'muse', execMode: 'host', cwd: lib, preset: null }
  const MUSE = session(MUSE_ID, 'Muse', museCfg)
  const NOVA = session(NOVA_ID, 'Nova', { soloAgentSlug: 'nova', agentSlug: 'nova', execMode: 'host', cwd: novaLib, preset: null })

  const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) return [{ path: r, size: 0, mtime: 0, dir: true }, ...walk(path.join(dir, e.name), r)]
    const st = fs.statSync(path.join(dir, e.name))
    return [{ path: r, size: st.size, mtime: st.mtimeMs, dir: false }]
  })
  const stub = await startStubEngine({
    agents: AGENTS, sessions: [], messages: [],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000, thinkingLevels: ['off', 'low'] }],
    override: ({ path: route, method }) => {
      if (route === '/agent/runs' && method === 'GET') return { runs: [] }
      if (route === `/agent/sessions/${MUSE_ID}/config` && method === 'GET') return { agent_config: MUSE.agent_config }
      if (route === `/agent/sessions/${NOVA_ID}/config` && method === 'GET') return { agent_config: NOVA.agent_config }
    },
    handle: ({ path: p, url }) => {
      if (p === '/agent/special/config') return { config: { historian: { enabled: false }, muse: { enabled: true, mode: 'ask' } } }
      if (p === '/agent/special/muse/status') return { status: { enabled: true, hasModel: true, running: false, restartsThisWindow: 0, maxRestartsPerWindow: 3, lastCycleAt: null, lastError: null, sessionId: null, mode: 'ask', heartbeatMinutes: 120, pendingApprovals: 0, libraryDir: lib, spaceDir: path.join(home, 'agents', 'muse', 'Space'), spaceStamp: 0, sleepUntil: null, sleepReason: null } }
      if (p === '/agent/special/muse/library') return { root: lib, files: walk(lib) }
      if (p === '/agent/special/approvals') return { approvals: [] }
      if (p === '/agent/special/muse/todos') return { todos: [] }
      if (p === '/agent/special/muse/triggers') return { triggers: [] }
      if (p === '/agent/special/schedule') return { schedules: [] }
      if (p === '/agent/runs' && url.searchParams.has('sessionId')) return { runs: [] }
      if (p === '/agent/solo/agent/muse/open') return { session: MUSE, created: true }
      if (p === '/agent/solo/agent/nova/open') return { session: NOVA, created: true }
      return undefined
    },
  })
  for (const dir of [userData, `${userData}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }), 'utf8')
  }
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
  const pageErrors = []
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => pageErrors.push(String((e && e.stack) || e).slice(0, 400)))
    await win.setViewportSize({ width: 1600, height: 900 })
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.waitForTimeout(1000)
    // 进 Tangu Space,左栏没开就点开
    await win.evaluate((names) => {
      const button = [...document.querySelectorAll('button.rb-space')]
        .find((item) => names.some((name) => (item.getAttribute('aria-label') || item.getAttribute('title') || item.textContent || '').includes(name)))
      if (button) button.click()
    }, ['Agent', 'Tangu'])
    await win.waitForTimeout(1500)
    if (!(await win.locator('.t2o-row').first().count().catch(() => 0))) {
      await win.click('.dv-edge-left').catch(() => {})
      await win.waitForTimeout(700)
    }
    const chat = (id) => `[data-chat-surface="chat"][data-session-id="${id}"]`
    const activeSpace = () => win.evaluate(() => document.querySelector('button.rb-space.active, button.rb-space[aria-current="page"], button.rb-space[aria-pressed="true"]')?.getAttribute('data-id') || '')
    const desk = (id) => win.evaluate((sid) => {
      const panel = document.querySelector(`.agent-desk[data-desk-session="${sid}"]`)
      const card = document.querySelector(`.agent-desk-card[data-desk-session="${sid}"]`)
      const r = panel?.getBoundingClientRect()
      const shown = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0
      return {
        panel: !!panel, open: !!panel?.classList.contains('open'), panelW: r ? Math.round(r.width) : 0,
        panelMuse: !!panel?.querySelector('[data-muse-space]'), panelText: (panel?.textContent || '').slice(0, 400),
        card: !!card, cardGone: !!card?.classList.contains('gone'), cardMuse: !!card?.querySelector('[data-muse-space]'),
        cardTitle: card?.querySelector('.agent-desk-card-title')?.textContent || '',
        // 文件库视图的预览栏:小卡里藏起来(挤不下,标题会一字一行),侧板里显示
        cardPreview: shown(card?.querySelector('.muse-lib-preview')), panelPreview: shown(panel?.querySelector('.muse-lib-preview')),
        cardListW: Math.round(card?.querySelector('.muse-lib-list')?.getBoundingClientRect().width || 0), cardW: Math.round(card?.getBoundingClientRect().width || 0),
      }
    }, id)

    // ── M1 / M2 ──
    await win.locator('.t2o-row', { hasText: 'Muse' }).first().click()
    const entered = await win.waitForSelector(chat(MUSE_ID), { timeout: 8000 }).then(() => true).catch(() => false)
    await sleep(1500)
    const spaceAfterClick = await activeSpace()
    check('M1 点 Muse 行 → 聊天面换到它的私聊,没有被带去 Muse Space', entered && !/muse/.test(spaceAfterClick), JSON.stringify({ entered, spaceAfterClick }))
    let d = await desk(MUSE_ID)
    const msgCount = await win.locator(`${chat(MUSE_ID)} .t2-stream [data-message-id], ${chat(MUSE_ID)} .t2-msg`).count().catch(() => 0)
    const isHomeCard = (x) => !x.open && x.card && !x.cardGone && x.cardMuse && x.cardTitle === 'Muse Space'
    check('M2 没发消息,右侧已有一张小卡,里面是 Muse Space;侧板没有自己展开',
      msgCount === 0 && isHomeCard(d), JSON.stringify({ msgCount, ...d, panelText: d.panelText.slice(0, 60) }))
    check('M2b 小卡里文件库只留文件列表(预览栏不挤进来),列表占满卡宽', !d.cardPreview && d.cardListW > d.cardW * 0.7, JSON.stringify({ cardPreview: d.cardPreview, cardListW: d.cardListW, cardW: d.cardW }))
    await win.screenshot({ path: path.join(SHOT_DIR, 'musechat-light.png') })

    // ── M3 负对照:别的 Agent 的私聊 ──
    await win.locator('.t2o-row', { hasText: 'Nova' }).first().click()
    await win.waitForSelector(chat(NOVA_ID), { timeout: 8000 }).catch(() => {})
    await sleep(900)
    const nd = await desk(NOVA_ID)
    check('M3 负对照:别的 Agent 的私聊没发消息时没有 Desk', !nd.panel && !nd.card, JSON.stringify({ panel: nd.panel, card: nd.card }))

    // ── M4 Agent 往 Desk 上放文件(不带 size = 不改形态)──
    await win.locator('.t2o-row', { hasText: 'Muse' }).first().click()
    await win.waitForSelector(chat(MUSE_ID), { timeout: 8000 }).catch(() => {})
    await sleep(900)
    stub.script([
      { type: 'token', payload: { delta: '我把本周计划的草稿放到右边了。' }, delay: 100 },
      { type: 'desk_present', payload: { views: [{ type: 'file', path: presented, name: 'draft-plan.md' }] }, delay: 300 },
      { type: 'done', payload: { content: '我把本周计划的草稿放到右边了。' }, delay: 200 },
    ])
    const ta = win.locator(`${chat(MUSE_ID)} .t2c-ta`).first()
    for (let i = 0; i < 40 && !(await ta.isEnabled().catch(() => false)); i++) await sleep(250)
    await ta.click(); await ta.fill('把本周计划的草稿给我看看'); await ta.press('Enter')
    await sleep(2500)
    d = await desk(MUSE_ID)
    check('M4 Agent 往 Desk 上放文件 → 小卡换成那份文件,Muse Space 让位,仍是小卡',
      !d.open && d.card && !d.cardGone && !d.cardMuse && d.cardTitle === 'draft-plan.md', JSON.stringify({ open: d.open, card: d.card, cardGone: d.cardGone, cardMuse: d.cardMuse, cardTitle: d.cardTitle }))

    // ── M5 清空 Desk(小卡上的那颗)──
    const clear = win.locator(btnSel(`.agent-desk-card[data-desk-session="${MUSE_ID}"]`, T.clear)).first()
    const hadClear = await clear.count().catch(() => 0)
    if (hadClear) await clear.click({ force: true })
    await sleep(900)
    d = await desk(MUSE_ID)
    check('M5 「清空 Desk」→ 小卡里 Muse Space 回来', !!hadClear && isHomeCard(d), JSON.stringify({ hadClear, open: d.open, cardMuse: d.cardMuse, cardTitle: d.cardTitle }))

    // ── M6 点小卡展开 → 侧板是 Muse Space;切走再回来仍展开(用户自己展开的要记住);收起 → 回到小卡 ──
    await win.locator(`.agent-desk-card[data-desk-session="${MUSE_ID}"]`).first().click().catch(() => {})
    await sleep(900)
    d = await desk(MUSE_ID)
    const expanded = d.open && d.panelW > 300 && d.panelMuse && /Home/.test(d.panelText) && d.panelPreview // 侧板够宽:预览栏在
    await win.locator('.t2o-row', { hasText: 'Nova' }).first().click()
    await sleep(900)
    await win.locator('.t2o-row', { hasText: 'Muse' }).first().click()
    await win.waitForSelector(chat(MUSE_ID), { timeout: 8000 }).catch(() => {})
    await sleep(1200)
    const back = await desk(MUSE_ID)
    // 暗色截图:展开态。暗色 token 挂在 `:root.dark`(base.css),data-mode 只管 color-scheme:两样一起翻,拍完翻回去
    const wasMode = await win.evaluate(() => { const r = document.documentElement; const m = r.getAttribute('data-mode'); r.classList.add('dark'); r.setAttribute('data-mode', 'dark'); return m })
    await sleep(600)
    await win.screenshot({ path: path.join(SHOT_DIR, 'musechat-dark.png') })
    await win.evaluate((m) => { const r = document.documentElement; r.classList.remove('dark'); if (m) r.setAttribute('data-mode', m); else r.removeAttribute('data-mode') }, wasMode)
    await win.locator(btnSel(`.agent-desk[data-desk-session="${MUSE_ID}"]`, T.collapse)).first().click().catch(() => {})
    await sleep(900)
    const folded = await desk(MUSE_ID)
    check('M6 点小卡 → 展开成侧板,里面是 Muse Space;切走再回来仍展开;收起 → 回到小卡',
      expanded && back.open && back.panelMuse && isHomeCard(folded),
      JSON.stringify({ expanded, panelW: d.panelW, backOpen: back.open, backPanelMuse: back.panelMuse, foldedCard: isHomeCard(folded) }))
    check('M8 截图已存(亮 = 小卡 / 暗 = 展开)', fs.existsSync(path.join(SHOT_DIR, 'musechat-light.png')) && fs.existsSync(path.join(SHOT_DIR, 'musechat-dark.png')), SHOT_DIR)

    // ── M7 行菜单 ──
    const row = win.locator('.t2o-row', { hasText: 'Muse' }).first()
    await row.click({ button: 'right' })
    await sleep(600)
    const menuText = await win.evaluate(() => [...document.querySelectorAll('[role="menu"], .sheet-menu, .ctx-menu')].map((m) => m.textContent || '').join(' | '))
    const hasRotate = (await win.locator('text=先总结记忆').count().catch(() => 0)) > 0 // 按文案找,不依赖菜单容器的类名
    const openSpace = win.locator('text=打开 Muse Space').first()
    const hasOpen = await openSpace.count().catch(() => 0)
    if (hasOpen) await openSpace.click()
    await sleep(1200)
    const museSpaceMain = await win.locator('[data-muse-space]').count().catch(() => 0)
    const chatStillVisible = await win.locator(chat(MUSE_ID)).isVisible().catch(() => false)
    check('M7 行菜单有「新会话(先总结记忆)」与「打开 Muse Space」,后者切到整页 Muse Space', hasRotate && !!hasOpen && museSpaceMain > 0 && !chatStillVisible,
      JSON.stringify({ hasRotate, hasOpen, museSpaceMain, chatStillVisible, menuText: menuText.slice(0, 120) }))

    check('M9 全程没有渲染进程异常', pageErrors.length === 0, pageErrors.join(' ⏎ ').slice(0, 400))
  } finally {
    await app.close().catch(() => {})
    try { stub.close() } catch { /* ignore */ }
    fs.rmSync(home, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} PASS${failed.length ? `(FAIL:${failed.map((f) => f.name.split(' ')[0]).join(', ')})` : ''};截图 ${SHOT_DIR}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
