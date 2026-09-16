/** Team UI regression: Pin Summary member rows, independent Agent Desk, chronological public remarks,
 * forwarded approvals, optional Historian attachment and light/dark screenshots.
 * Run after npm run build: npm run check:teamdesk (isolated Electron user data).
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
class StopEarly extends Error {}

const AGENTS = [
  { slug: 'xyra', name: 'Xyra', description: 'General assistant', createdBy: 'user', libraryDir: '/tmp/teamdesk-lib/xyra/Library' },
  { slug: 'orbit-one', name: 'Orbit One', description: 'Team desk instrument agent', createdBy: 'user', libraryDir: '/tmp/teamdesk-lib/orbit-one/Library' },
]
const SESSION_ID = 'td-team'
const sessionFixtures = (projectDir) => {
  const base = { summary: '', archived: false, model_id: 'm1', created_at: '2026-09-16 09:00:00', updated_at: '2026-09-16 11:00:00' }
  return [
    { ...base, id: SESSION_ID, title: '团队模式会话', project_path: projectDir, project_name: 'Orbit Project', projectless: false,
      agent_config: { groupChat: true, groupAgents: ['xyra', 'orbit-one'], execMode: 'host', cwd: projectDir } },
  ]
}
/** 会话里已有两条消息:验证 Pin Summary 与 Agent Desk 同时可见。 */
const MESSAGES = [
  { id: 'td-m1', session_id: SESSION_ID, role: 'user', content: '先做接口和测试', timestamp: '2026-09-16 10:00:00' },
  { id: 'td-m2', session_id: SESSION_ID, role: 'model', content: '**🗣 Xyra**\n\n收到,先拆一下。', agent_slug: 'xyra', timestamp: '2026-09-16 10:00:05' },
]

/** 团队 run 的事件剧本(引擎 §6.4 事件面):两位成员同时起 → xyra 有工具活动并等审批 → 批准后两人先后发言 → 全员 DONE 收场。 */
const LONG_REPORT = '测试写好了\n\n' + Array.from({ length: 18 }, (_, i) => `第 ${i + 1} 项：接口响应、参数校验、异常处理和并发行为均已验证。`).join('\n\n') + '\n@Xyra 接口给你\nDONE'
const RUN_SCRIPT = [
  { type: 'team_member', payload: { slug: 'xyra', name: 'Xyra', phase: 'start', messageId: 'mid-x-1', cycle: 1, sessionId: 'ws-x', runId: 'child-x-1', task: '先做接口' } },
  { type: 'team_member', payload: { slug: 'orbit-one', name: 'Orbit One', phase: 'start', messageId: 'mid-o-1', cycle: 1, sessionId: 'ws-o', runId: 'child-o-1', task: '写测试' }, delay: 100 },
  { type: 'team_activity', payload: { slug: 'xyra', name: 'Xyra', messageId: 'mid-x-1', tool: 'edit_file', argsPreview: '{"path":"src/api.ts"}' }, delay: 300 },
  { type: 'approval_request', payload: { approvalId: 'ap1', runId: 'child-x-1', name: 'run_bash', arguments: '{"command":"npm test"}', preview: 'npm test', agentSlug: 'xyra', agentName: 'Xyra', messageId: 'mid-x-1' }, delay: 300 },
  // 给检查留 4s 去点「批准」(桩不会因 POST 放行,靠固定延时)
  { type: 'approval_result', payload: { approvalId: 'ap1', action: 'approve', runId: 'child-x-1', agentSlug: 'xyra', messageId: 'mid-x-1' }, delay: 4000 },
  { type: 'group_speaker', payload: { slug: 'orbit-one', name: 'Orbit One', round: 1, step: 1, phase: 'start', messageId: 'mid-o-1' }, delay: 400 },
  { type: 'group_speaker', payload: { slug: 'orbit-one', name: 'Orbit One', round: 1, step: 1, phase: 'end', messageId: 'mid-o-1', text: LONG_REPORT } },
  { type: 'team_member', payload: { slug: 'orbit-one', name: 'Orbit One', phase: 'end', reason: 'done', messageId: 'mid-o-1', sessionId: 'ws-o', runId: 'child-o-1' } },
  { type: 'group_speaker', payload: { slug: 'xyra', name: 'Xyra', round: 1, step: 2, phase: 'start', messageId: 'mid-x-1' }, delay: 1800 },
  { type: 'group_speaker', payload: { slug: 'xyra', name: 'Xyra', round: 1, step: 2, phase: 'end', messageId: 'mid-x-1', text: '接口完成:src/api.ts\nDONE' } },
  { type: 'team_member', payload: { slug: 'xyra', name: 'Xyra', phase: 'end', reason: 'done', messageId: 'mid-x-1', sessionId: 'ws-x', runId: 'child-x-1' } },
  { type: 'group_summary', payload: { messageId: 'summary-1', text: '接口与测试已完成,可以一起验收。' } },
  { type: 'group_ended', payload: { rounds: 1, reason: 'done', steps: 2, participants: [{ slug: 'xyra', name: 'Xyra' }, { slug: 'orbit-one', name: 'Orbit One' }] } },
  { type: 'done', payload: { content: '', group: true } },
]

const PROBE = `(() => {
  const q = (s, r = document) => Array.from(r.querySelectorAll(s))
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' }
  const card = document.querySelector('[data-team-desk="status"]')
  const rows = card ? q('.t2o-desk-row', card).map((r) => ({ slug: r.dataset.slug, status: r.dataset.status, activity: (r.querySelector('.t2o-desk-activity') || {}).textContent || '' })) : null
  const panel = document.querySelector('[data-team-desk="panel"]')
  return {
    statusInSummary: !!document.querySelector('.t2-tsum [data-team-desk="status"]'),
    summaryCards: q('[data-team-summary]').length,
    hasTeamCard: !!card, cardGone: !!(card && card.classList.contains('gone')), cardVisible: !!(card && vis(card)),
    plainDeskCards: q('.agent-desk-card:not([data-team-desk])').length,
    rows,
    workBubbles: q('[data-team-work]').map((e) => e.dataset.teamWork),
    approvalCards: q('.approval-card').length,
    thinking: q('.chat-thinking-live').length,
    doneMarks: q('[data-team-done]').length,
    rawDone: (document.querySelector('.t2-stream') || document.body).innerText.split(String.fromCharCode(10)).filter((l) => /(^|[^A-Za-z])DONE([^A-Za-z]|$)/.test(l)).length,
    barOrbit: (document.querySelector('.t2o-bar') || {}).dataset ? document.querySelector('.t2o-bar').dataset.orbit : null,
    barSub: (document.querySelector('.t2o-bar-sub') || {}).textContent || '',
    barWork: q('.t2o-bar .t2o-bar-avatar[data-work]').map((e) => e.dataset.work),
    panelOpen: !!(panel && panel.classList.contains('open')),
    tabs: panel ? q('.t2o-desk-tab', panel).map((b) => ({ slug: b.dataset.slug, status: b.dataset.status, selected: b.getAttribute('aria-selected') === 'true' })) : null,
    taskLine: (document.querySelector('[data-team-desk="work"] .t2o-desk-task') || {}).textContent || '',
    bodyText: (document.querySelector('.t2-stream') || document.body).innerText.slice(0, 8000),
  }
})()`

/** 桩引擎没有 /agent/runs?sessionId 路由 → 每次开会话都会弹「历史加载失败」toast(与 orbitside.check 同款噪音),截图前关掉。 */
async function dismissToasts(win) {
  for (let i = 0; i < 6; i += 1) {
    const btn = win.locator('.ntf-close').first()
    if (!(await btn.count().catch(() => 0))) break
    await btn.click({ timeout: 2_000 }).catch(() => {})
    await sleep(200)
  }
}

async function openTeamSession(win) {
  await win.waitForSelector('.t2sw, .t2s-side', { timeout: 30_000 })
  await sleep(1500)
  for (let i = 0; i < 20; i++) {
    const row = win.locator('.t2s-srow, .t2o-row').filter({ hasText: '团队模式会话' }).first()
    if (await row.count().catch(() => 0)) { await row.click().catch(() => {}); break }
    await sleep(500)
  }
  await win.waitForSelector(`[data-chat-surface="chat"][data-session-id="${SESSION_ID}"]`, { timeout: 20_000 })
  await win.waitForSelector('.t2c-ta', { timeout: 20_000 })
  await sleep(800)
}

async function run(app, win, stub) {
  win.setDefaultTimeout(20_000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 960))
  await win.waitForSelector('#root', { timeout: 30_000 })
  await win.waitForTimeout(2500)
  for (const label of ['跳过引导', 'Skip']) {
    const b = win.locator(`text=${label}`).first()
    if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
  }
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  // 钉住启动 Space = Tangu(缺省是主页 Space,没有侧栏);清掉 Chat/Work 偏好(与 orbitside.check 同款)。
  await win.evaluate(`localStorage.setItem('forsion_default_space', 'tangu'); localStorage.removeItem('forsion_tangu_session_mode')`)
  await win.reload({ waitUntil: 'domcontentloaded' })
  await win.waitForSelector('#root', { timeout: 30_000 })
  await openTeamSession(win)
  const shots = { team: path.join(os.tmpdir(), `forsion-teamdesk-team-${process.pid}.png`), light: path.join(os.tmpdir(), `forsion-teamdesk-light-${process.pid}.png`), dark: path.join(os.tmpdir(), `forsion-teamdesk-dark-${process.pid}.png`) }

  // ── 1 成员状态进入 Pin Summary,Agent Desk 保留 ─────────────────────
  await win.waitForSelector('[data-team-desk="status"]', { timeout: 15_000 }).catch(() => {})
  let st = await win.evaluate(PROBE)
  check('1 团队成员列表在 Pin Summary 中,Agent Desk 卡保留', st.hasTeamCard && st.statusInSummary && st.plainDeskCards === 1, JSON.stringify({ hasTeamCard: st.hasTeamCard, plain: st.plainDeskCards }))
  if (!st.hasTeamCard) { console.error('PROBE ' + JSON.stringify({ ...st, bodyText: st.bodyText.slice(0, 200) })); throw new StopEarly('Pin Summary 成员列表未渲染') }
  check('1a 卡片在场(会话有消息 → 不 gone)且成员行 = 2、都是空闲', st.cardVisible && !st.cardGone && Array.isArray(st.rows) && st.rows.length === 2 && st.rows.every((r) => r.status === 'idle'), JSON.stringify(st.rows))
  check('1b 顶部团队状态条已移除', st.barOrbit === null, JSON.stringify({ barOrbit: st.barOrbit }))

  // ── 2/3 起一次 run:两位成员同时起 → xyra 等审批 ───────────────────────
  stub.script(RUN_SCRIPT)
  await win.locator('.t2c-ta').fill('开始')
  await win.locator('.t2c-ta').press('Enter')
  await win.waitForSelector('[data-team-work="waiting"]', { timeout: 15_000 }).catch(() => {})
  st = await win.evaluate(PROBE)
  const xy = (st.rows || []).find((r) => r.slug === 'xyra') || {}
  const ob = (st.rows || []).find((r) => r.slug === 'orbit-one') || {}
  check('2 仅需要审批的成员在主聊天露出卡片,其他运行占位不显示', st.workBubbles.length === 1 && st.workBubbles.includes('waiting'), JSON.stringify(st.workBubbles))
  check('2a Team Desk 行状态跟着走:xyra=waiting(此前 team_activity 的工具名已进动态)、orbit-one=working', xy.status === 'waiting' && ob.status === 'working', JSON.stringify(st.rows))

  check('3 转发的审批落在主聊天(审批卡 1 张),不必点开 Team Desk', st.approvalCards === 1, JSON.stringify({ approvalCards: st.approvalCards }))
  if (st.approvalCards === 1) {
    await win.locator('.approval-card .btn.primary').first().click()
    await sleep(400)
    const ap = stub.seen.approvals[0]
    check('3a 点「批准」→ POST 到子 run(/agent/runs/child-x-1/approvals/ap1),不是团队 run', !!ap && ap.approvalId === 'ap1' && ap.runId === 'child-x-1' && ap.action === 'approve', JSON.stringify(stub.seen.approvals))
  } else {
    check('3a 点「批准」→ POST 到子 run', false, '没有审批卡可点')
  }

  await win.waitForFunction(() => !!document.querySelector('#tocmsg-mid-o-1 .t2-content'))
  const earlyLength = await win.locator('#tocmsg-mid-o-1 .t2-content').innerText().then((s) => s.length)
  check('3b 新团队发言有逐字展示的中间帧', earlyLength > 0 && earlyLength < LONG_REPORT.length - 40, String(earlyLength))
  await sleep(1000)
  const gap = await win.locator('.t2-stream').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
  check('3c 另一成员仍在运行时,长发言动画结束后自动吸底', gap < 8, String(gap))
  await win.locator('.t2-stream').hover()
  await win.mouse.wheel(0, -650)
  await sleep(150)
  const readingTop = await win.locator('.t2-stream').evaluate((el) => el.scrollTop)
  // ── 4 发言到达 → 正文落进气泡;收场 → 成员回到完成态、不再有 streaming 气泡 ─
  await win.getByText('接口完成', { exact: false }).first().waitFor({ timeout: 20_000 }).catch(() => {})
  await sleep(600)
  st = await win.evaluate(PROBE)
  check('4 group_speaker end 带 text → 两位成员的发言正文都在主聊天里(不靠 token 流)', /测试写好了/.test(st.bodyText) && /接口完成/.test(st.bodyText), st.bodyText.slice(0, 300).replace(/\n/g, ' '))
  const retainedTop = await win.locator('.t2-stream').evaluate((el) => el.scrollTop)
  check('3d 向上阅读时,后续消息不抢滚动位置', Math.abs(retainedTop - readingTop) < 8, `${readingTop} → ${retainedTop}`)
  await win.locator('.t2-jump').click()
  await sleep(350)
  check('4a 收场后没有 streaming 占位(data-team-work 0、思考中 0),没有重复气泡', st.workBubbles.length === 0 && st.thinking === 0, JSON.stringify({ workBubbles: st.workBubbles, thinking: st.thinking }))
  check('4b group_ended → Team Desk 行回到非忙碌态、状态条头像不再高亮', Array.isArray(st.rows) && st.rows.every((r) => r.status !== 'working' && r.status !== 'waiting') && st.barWork.length === 0, JSON.stringify({ rows: st.rows, barWork: st.barWork }))
  check('4c 收场系统行出现「全员表示已完成」', /全员表示已完成/.test(st.bodyText), '')
  check('4d 发言末尾的 DONE 剥成「已完成」小标记(两条),正文里不再裸露 DONE', st.doneMarks === 2 && st.rawDone === 0, JSON.stringify({ doneMarks: st.doneMarks, rawDone: st.rawDone }))

  check('4e 公开发言按到达顺序排列', st.bodyText.indexOf('测试写好了') < st.bodyText.indexOf('接口完成'), '')
  check('4f Historian 摘要附着于底部,不要求回答询问', st.summaryCards === 1 && !/需要主持人总结/.test(st.bodyText), '')
  await win.locator('[data-team-summary] summary').click()
  check('4g 摘要可展开阅读', await win.locator('[data-team-summary]').innerText().then((s) => s.includes('一起验收')), '')
  await dismissToasts(win)
  for (const slug of ['xyra', 'orbit-one']) {
    await win.locator(`[data-team-desk="status"] button[data-slug="${slug}"]`).click()
    check(`5 点击 ${slug} 打开成员工作记录`, await win.locator(`[data-team-desk="status"] button[data-slug="${slug}"]`).getAttribute('aria-expanded') === 'true' && await win.locator('[data-team-desk="work"]').count() === 1, '')
  }
  await win.locator('[data-historian-status] > button').click()
  await win.getByText('已保存该会话的工作约定', { exact: false }).first().waitFor()
  check('6 Historian 有独立可展开的状态行', await win.locator('.t2-tsum [data-historian-work]').count() === 1, '')
  await win.screenshot({ path: shots.team })
  await win.locator('.add-pill-btn').click()
  await win.locator('[data-add-agent]').click()
  check('6a 加号菜单可打开添加 Agent', await win.getByText('群聊模式', { exact: true }).count() === 1, '')
  await win.locator('button[title="关闭"]').last().click()
  await win.locator('.mode-pill-btn').click()
  await win.locator('[data-normal-work]').click()
  await sleep(300)
  const normal = stub.seen.configs.at(-1)?.config
  check('6b 普通模式关闭团队和计划,恢复 auto-edit', normal?.groupChat === false && normal?.planMode === false && normal?.approvalMode === 'auto-edit', JSON.stringify(normal))
  check('6c 普通模式仍保留 Historian,团队成员表退出', await win.locator('[data-historian-status]').count() === 1 && await win.locator('[data-team-desk="status"]').count() === 0, '')
  await dismissToasts(win)
  await win.mouse.move(640, 900)
  await sleep(300)
  await win.screenshot({ path: shots.light })

  // ── 6 暗色截图(重载后由 /background 复原成员表:桩回空 → 全员空闲,看的是配色) ─
  await sleep(500)
  await win.evaluate(`localStorage.setItem('forsion_theme_pref', 'dark')`)
  await win.reload({ waitUntil: 'domcontentloaded' })
  await openTeamSession(win).catch(() => {})
  await win.waitForSelector('[data-team-desk="status"]', { timeout: 15_000 }).catch(() => {})
  await sleep(800)
  await dismissToasts(win)
  await sleep(300)
  await win.screenshot({ path: shots.dark })
  return shots
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-teamdesk-'))
  const userData = path.join(home, 'userData')
  const vault = path.join(home, 'vault')
  const projectDir = path.join(home, 'Orbit Project')
  for (const dir of [userData, `${userData}-dev`, vault, projectDir]) fs.mkdirSync(dir, { recursive: true })
  const stub = await startStubEngine({ agents: AGENTS, sessions: sessionFixtures(projectDir), messages: MESSAGES, handle: ({ path: route, url }) => {
    if (route === '/agent/special/config') return { config: { historian: { enabled: true }, muse: { enabled: false } } }
    if (route === '/agent/special/historian/activity') return { running: false, activity: [{ id: 'hist-action', detail: '已保存该会话的工作约定', session_ref: SESSION_ID }], records: url.searchParams.get('detail') === '1' ? [{ id: 'hist-record', content: '团队接口与测试的分工已记录。' }] : [] }
    if (route === '/agent/runs' && url.searchParams.has('sessionId')) return { runs: [] }
  } })
  for (const dir of [userData, `${userData}-dev`]) {
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }), 'utf8')
    fs.writeFileSync(path.join(dir, 'amadeus-config.dev.json'), JSON.stringify({ localVault: vault, lastVault: vault }), 'utf8')
  }
  let app
  let shots = null
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
  } catch (e) {
    console.error('隔离 Electron 启动失败;保留现有应用实例。')
    try { stub.close() } catch { /* ignore */ }
    throw e
  }
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => console.error('[renderer pageerror]', String(e && e.stack || e).slice(0, 600)))
    win.on('console', (m) => { if (m.type() === 'error') console.error('[renderer console.error]', m.text().slice(0, 600)) })
    shots = await run(app, win, stub)
  } catch (e) {
    if (e instanceof StopEarly) console.error(`STOP  ${e.message}`)
    else { console.error(e); check('runner 未捕获异常', false, String((e && e.message) || e)) }
  } finally {
    await app.close().catch(() => {})
    try { stub.close() } catch { /* ignore */ }
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (shots) console.log('SHOTS ' + JSON.stringify(shots))
  process.exit(failed.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
