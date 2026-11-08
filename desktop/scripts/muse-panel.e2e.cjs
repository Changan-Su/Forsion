/**
 * Muse 面板「叫醒」与「最近几轮」(2026-11-08,Muse Space 右栏方案 B 里不等主区模板先上的两件)的真 Electron 台架。
 * 桩引擎按新引擎的两条路由回(POST /agent/special/muse/wake、GET /agent/special/muse/rounds),量渲染与接线:
 *  A 状态行:空闲时右边出「叫醒」;点了 → 引擎收到 POST /muse/wake,下面写「叫醒了，马上开始」、按钮收起;
 *    被让位挡着 → 写「你那边有对话在跑，跑完它就醒」;起来了 → 「正在想」、不出叫醒;
 *  B 最近几轮:在跑的那轮不列;每行 时间 · 怎么醒的 · 用了多久 / 写了几个文件 · 提了几条待办;规则按名字、失败写原因;
 *    点一行 → 打开那一轮的会话(主区新标签显示它的内容);点回主区「Muse」标签 → 右栏回到面板;不设「全部」;
 *  C 旧引擎(status 没有 wakePending、rounds 404)→ 两块都不画;
 *  D 英文界面的文案。
 * 亮 / 暗各拍一张右栏(SHOT_DIR 指定出图目录;缺省系统临时目录)。
 *
 *   npx electron-vite build
 *   node <仓根>/.claude/hooks/devlock.cjs run --vehicle=e2e --what="Muse 面板台架" --eta=3 -- node scripts/muse-panel.e2e.cjs
 * 负对照:同一脚本对着没有这两块的构建跑(main 上 11-08 之前)→ A、B、D 全红,C 照绿。
 */
const path = require('path')
const { launch, boot, enterSpace, shotDir, makeReporter, sleep } = require('./lib/uiux-electron.cjs')

const OUT = shotDir('muse-panel')
const MIN = 60_000
const now = Date.now()
const st = {
  enabled: true, hasModel: true, running: false, restartsThisWindow: 1, maxRestartsPerWindow: 6, lastCycleAt: now - 38 * MIN, lastError: null,
  sessionId: 'mr-1', mode: 'ask', heartbeatMinutes: 120, pendingApprovals: 0, sleepUntil: null, sleepReason: null, spaceStamp: 0,
  wakePending: false, wakeBlocked: null,
}
const ROUNDS = [
  { runId: 'r0', sessionId: 'mr-0', status: 'running', trigger: 'heartbeat', startedAt: now - 1 * MIN, endedAt: null, files: 0, todos: 0, error: null },
  { runId: 'r1', sessionId: 'mr-1', status: 'done', trigger: 'manual', startedAt: now - 38 * MIN, endedAt: now - 37 * MIN, files: 2, todos: 1, error: null },
  { runId: 'r2', sessionId: 'mr-2', status: 'failed', trigger: 'rule:t1', startedAt: now - 3 * 60 * MIN, endedAt: now - 3 * 60 * MIN + 20_000, files: 0, todos: 0, error: 'upstream 529' },
  { runId: 'r3', sessionId: 'mr-3', status: 'done', trigger: 'heartbeat', startedAt: now - 5 * 60 * MIN, endedAt: now - 5 * 60 * MIN + 95_000, files: 0, todos: 0, error: null },
]
const ROUND2_TEXT = '规则那轮写到一半:上游 529,这轮先停在这里。'
const TRIGGERS = [{ id: 't1', desc: '打开 Figma 时提醒伸展', cond: { type: 'event_seen', match: 'Figma' }, enabled: true, cooldownHours: 1 }]

const world = { legacy: false, wakes: 0, reads: new Set() }
const override = async ({ path: p, method, url }) => {
  if (/\/agent\/sessions\/mr-\d/.test(p) || /session_id=mr-\d/.test(url.search)) world.reads.add((p.match(/mr-\d/) || url.search.match(/mr-\d/))[0])
  if (p === '/agent/sessions/mr-2/messages') return { messages: [{ id: 'm-r2', role: 'assistant', content: ROUND2_TEXT, timestamp: now - 3 * 60 * MIN + 15_000 }] }
  if (p === '/agent/special/muse/status') {
    if (!world.legacy) return { status: st }
    const { wakePending, wakeBlocked, ...old } = st // 旧引擎:没有这两个字段
    return { status: old }
  }
  if (p === '/agent/special/muse/wake' && method === 'POST') {
    if (world.legacy) return { __code: 404, body: { detail: 'Not found' } }
    world.wakes++
    st.wakePending = true
    return { status: st }
  }
  if (p === '/agent/special/muse/rounds') return world.legacy ? { __code: 404, body: { detail: 'Not found' } } : { rounds: ROUNDS }
  if (p === '/agent/special/muse/triggers') return { triggers: TRIGGERS }
  if (p === '/agent/special/muse/todos') return { todos: [] }
  if (p === '/agent/special/approvals') return { approvals: [] }
  if (p === '/agent/special/schedule' && method === 'GET') return { schedules: [] }
  if (p === '/agent/special/muse/library') return { root: '/tmp/muse-lib', files: [] }
  return undefined
}

async function main() {
  const r = makeReporter()
  const ctx = await launch({ tag: 'muse-panel', fixtures: { agents: [{ slug: 'muse', name: 'Muse', nameZh: '卜算子', nameEn: 'Muse', description: 'Muse', createdBy: 'system' }], sessions: [] }, stubOverride: override })
  const { app, win } = ctx
  const panel = win.locator('[data-muse-panel]').first()
  const text = () => panel.innerText().catch(() => '')
  const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(250) } return false }
  const shot = async (name) => { await sleep(400); const f = path.join(OUT, `${name}.png`); await panel.screenshot({ path: f }); r.note('shot', f) }
  // 回到面板:点开一轮后那个会话开在 Muse Space 主区的新标签里,右栏按「主视图规则」换成它的伴随面板(Muse 面板还在,压在后面)。
  // 用户回来 = 点主区的「Muse」标签;再点一次 Ribbon 上的 Muse(已是当前 Space)不会把它翻回来。
  const backToPanel = async () => {
    if ((await win.evaluate(() => localStorage.getItem('forsion_tangu_active_space'))) !== 'muse') await enterSpace(win, 'muse')
    if (!(await panel.isVisible().catch(() => false))) await win.locator('.dv-tab', { hasText: 'Muse' }).first().click().catch(() => {})
    await panel.waitFor({ timeout: 15000 })
  }
  const reload = async () => { await win.reload(); await win.waitForSelector('.dv-groupview', { timeout: 30000 }); await backToPanel() }
  const theme = async (mode) => {
    await win.evaluate((m) => { localStorage.setItem('forsion_theme_pref', m); localStorage.setItem('forsion_theme', m) }, mode)
    await reload()
  }
  try {
    await boot(app, win, { space: null, width: 1512, height: 950 })
    r.check('进 Muse Space', await enterSpace(win, 'muse'))
    await panel.waitFor({ timeout: 15000 })
    await until(async () => (await win.locator('[data-section="rounds"] .mv-round').count()) > 0)

    // ── B 最近几轮 ──
    const rows = win.locator('[data-section="rounds"] .mv-round')
    const ids = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-round-id')))
    r.check('B1 最近几轮三行,在跑的那轮不列', JSON.stringify(ids) === JSON.stringify(['r1', 'r2', 'r3']), JSON.stringify(ids))
    const [t1, t2, t3] = await rows.evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ')))
    r.check('B2 叫醒那轮:你叫醒的 · 1 分钟 / 写了 2 个文件 · 提了 1 条待办', /你叫醒的 · 1 分钟/.test(t1) && /写了 2 个文件 · 提了 1 条待办/.test(t1), t1)
    r.check('B3 规则那轮写规则名,失败写原因', /规则「打开 Figma 时提醒伸展」 · 20 秒/.test(t2) && /没跑完：upstream 529/.test(t2), t2)
    r.check('B4 心跳那轮:心跳 · 2 分钟 / 没写文件，也没提待办', /心跳 · 2 分钟/.test(t3) && /没写文件，也没提待办/.test(t3), t3)

    // ── A 叫醒 ──
    const wakeBtn = win.locator('[data-action="muse-wake"]')
    r.check('A1 空闲时状态行右边出「叫醒」', (await wakeBtn.count()) === 1 && (await wakeBtn.innerText()) === '叫醒')
    await shot('p-idle-light')
    await wakeBtn.click()
    r.check('A2 点了 → 引擎收到 POST /agent/special/muse/wake', await until(async () => world.wakes === 1), `wakes=${world.wakes}`)
    r.check('A3 下面写「叫醒了，马上开始」,按钮收起', await until(async () => /叫醒了，马上开始/.test(await text()) && (await wakeBtn.count()) === 0), await text())
    st.wakeBlocked = 'userActive'
    r.check('A4 被让位挡着 → 写「你那边有对话在跑，跑完它就醒」', await until(async () => /你那边有对话在跑，跑完它就醒/.test(await text())), await text())
    st.wakePending = false; st.wakeBlocked = null; st.running = true
    r.check('A5 起来了 → 状态「正在想」,不出叫醒、不留提示', await until(async () => /正在想/.test(await text()) && (await wakeBtn.count()) === 0 && (await win.locator('[data-wake-note]').count()) === 0), await text())
    st.running = false

    // ── B 点一行 / 全部 ──
    await win.locator('[data-round-id="r2"]').click()
    r.check('B5 点一行 → 打开那一轮的会话,主区显示它的内容', await until(async () => world.reads.has('mr-2') && /上游 529,这轮先停在这里/.test(await win.locator('.dv-groupview').first().innerText().catch(() => ''))), JSON.stringify([...world.reads]))
    await backToPanel()
    r.check('B5b 点回主区「Muse」标签 → 右栏回到 Muse 面板', await panel.isVisible())
    r.check('B6 「最近几轮」不带「全部」链接(自动化里只看得到最新一轮,链过去名不副实)', (await win.locator('[data-section="rounds"] .mv-link').count()) === 0)

    // ── 暗色 ──
    await theme('dark')
    await until(async () => (await win.locator('[data-section="rounds"] .mv-round').count()) === 3)
    await shot('p-idle-dark')
    await theme('light')

    // ── D 英文 ──
    await win.evaluate(() => localStorage.setItem('tangu_locale', 'en'))
    await reload()
    const en = await until(async () => { const s = await text(); return /Wake/.test(s) && /Recent rounds/.test(s) && /You woke it · 1 min/.test(s) && /Wrote 2 files · Added 1 to-do/.test(s) }, 10000)
    r.check('D1 英文:Wake / Recent rounds / You woke it · 1 min / Wrote 2 files · Added 1 to-do', en, (await text()).replace(/\s+/g, ' ').slice(0, 400))
    await shot('p-idle-en')
    // ── C 旧引擎 ──(切回中文的同时换成旧引擎:面板按状态签名才重拉「最近几轮」,重载后第一次就该看到 404)
    world.legacy = true
    await win.evaluate(() => localStorage.setItem('tangu_locale', 'zh'))
    await reload()
    r.check('C1 旧引擎(没有 wakePending、rounds 404)→ 不出叫醒、不出最近几轮',
      await until(async () => (await wakeBtn.count()) === 0 && (await win.locator('[data-section="rounds"]').count()) === 0, 10000), await text())
  } catch (e) {
    r.check('台架跑完', false, String((e && e.stack) || e).slice(0, 600))
    const f = path.join(OUT, 'fail.png')
    await win.screenshot({ path: f }).then(() => r.note('fail shot', f), () => {})
    r.note('active space', String(await win.evaluate(() => localStorage.getItem('forsion_tangu_active_space')).catch(() => '?')))
    r.note('dom', JSON.stringify(await win.evaluate(() => ({
      panels: document.querySelectorAll('[data-muse-panel]').length,
      panelRects: [...document.querySelectorAll('[data-muse-panel]')].map((e) => e.getClientRects().length),
      tabs: [...document.querySelectorAll('.dv-tab')].map((e) => `${e.classList.contains('dv-active-tab') ? '*' : ''}${(e.textContent || '').trim()}`),
    })).catch(() => null)))
  } finally {
    await ctx.close()
  }
  process.exit(r.summary() ? 1 : 0)
}

main()
