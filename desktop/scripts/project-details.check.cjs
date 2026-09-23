/** PROJECT 详情(Tangu Space 右栏,项目会话时顶替 Agent 详情)的真 Electron 仪器:
 *  入口闸(项目会话 → 项目页;无根会话 → 仍是 Agent 详情)、Agents 页(按会话推导的执行者、当前会话置顶、点开成员详情、
 *  用它开新会话、设为项目默认)、配置页(指令文件空态 → 创建 → 编辑 → 保存的 wire 约定、项目技能与旧位置标记、已批准计划、
 *  本机默认项)、Git 页(分支 / 上游 / 改动 / 提交 / 远端 + 动作行)、中英 × 亮暗不横向溢出 + 截图(观感自查,DESIGN §8)。
 *  引擎那半(project-context 的读写与安全边界)由 tangu-agent 的 projectContext.test.ts 覆盖;这里的假引擎只回放形状、记录请求。
 *  先 npm run build,再 npm run check:projectdetails(隔离 user data,不碰 ~/.forsion-dev)。 */
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

// 完整的 Agent 定义形状(紧凑详情会渲染 systemPrompt / tools 等字段;缺字段 = 夹具问题,不是产品问题)
const agentDef = (slug, name, description) => ({ slug, name, description, tools: [], model: '', thinkingLevel: '', maxIterations: null, approvalMode: '', createdBy: 'user', createdAt: '2026-09-01', systemPrompt: `You are ${name}.`, soul: '', libraryDir: `/tmp/pd-lib/${slug}/Library` })
const AGENTS = [agentDef('xyra', 'Xyra', 'General assistant'), agentDef('coder', 'Coder', 'Writes code')]
const TEMPLATE = '# Project instructions\n\n## What this project is\n'
const sessionFixtures = (projectDir, defaultDir, aliasDir) => {
  const base = { summary: '', archived: false, model_id: 'm1', created_at: '2026-09-20 09:00:00', projectless: false, project_path: projectDir, project_name: 'Demo Project' }
  return [
    { ...base, id: 'pd-main', title: 'Demo main', updated_at: '2026-09-22 11:00:00', agent_config: { agentSlug: 'xyra', execMode: 'host', cwd: projectDir } },
    { ...base, id: 'pd-coder', title: 'Coder work', updated_at: '2026-09-22 10:00:00', agent_config: { agentSlug: 'coder', execMode: 'host', cwd: projectDir } },
    { ...base, id: 'pd-team', title: 'Demo party', updated_at: '2026-09-21 10:00:00', agent_config: { groupChat: true, groupAgents: ['xyra', 'coder'], execMode: 'host', cwd: projectDir } },
    // 默认工作区的会话(09-23 用户:「默认文件夹也是 Project」):harness 种了 localVault,默认目录 = <vault>/Sessions
    { ...base, id: 'pd-default', title: 'Default chat', updated_at: '2026-09-18 10:00:00', project_path: defaultDir, project_name: '默认工作区', agent_config: { agentSlug: 'xyra', execMode: 'host', cwd: defaultDir } },
    // 默认目录换过位置:旧会话按 project_name(各语言的「默认工作区」)归入默认组,但它们的真实目录是别名 —— 面板必须跟会话自己的目录走;
    // 别名恰好是家目录时引擎拒收,照旧 Agent 详情(codex 评审 09-23 的两条 P2)
    { ...base, id: 'pd-alias', title: 'Old default chat', updated_at: '2026-09-17 10:00:00', project_path: aliasDir, project_name: 'Tangu 默认工作区', agent_config: { agentSlug: 'xyra', execMode: 'host', cwd: aliasDir } },
    { ...base, id: 'pd-homealias', title: 'Home default chat', updated_at: '2026-09-16 10:00:00', project_path: os.homedir(), project_name: 'Tangu 默认工作区', agent_config: { agentSlug: 'xyra', execMode: 'host', cwd: os.homedir() } },
    { ...base, id: 'pd-rootless', title: 'Rootless chat', updated_at: '2026-09-19 10:00:00', projectless: true, project_path: null, project_name: null, agent_config: { agentSlug: 'xyra', execMode: 'sandbox' } },
  ]
}
/** 假引擎回放的项目上下文(形状 = 引擎 services/projectContext.ts 的 ProjectContext);init / doc / settings / skills 会就地改它。 */
function contextFixture(projectDir) {
  return {
    cwd: projectDir, workspaceDir: path.join(projectDir, '.tangu'), workspaceDirName: '.tangu',
    doc: { path: path.join(projectDir, '.tangu', 'AGENTS.md'), exists: false, content: null, mtimeMs: null, bytes: 0, tooLarge: false, sources: [], truncated: false, candidates: ['AGENTS.md', '.agents/AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', '.tangu/AGENTS.md'] },
    skills: [
      { id: 'local:release-notes', name: 'Release notes', description: 'How this project writes release notes', path: path.join(projectDir, '.tangu', 'skills', 'release-notes'), legacy: false },
      { id: 'local:old-skill', name: 'Old skill', description: 'Lives in the legacy folder', path: path.join(projectDir, '.forsion', 'skills', 'old-skill'), legacy: true },
    ],
    plans: [{ name: 'plan-20260921-101500.md', path: path.join(projectDir, '.tangu', 'plans', 'plan-20260921-101500.md'), mtimeMs: Date.now() - 86_400_000, size: 1200, title: 'Ship v1' }],
    settings: null,
    git: {
      available: true, repo: true, nested: false, branch: 'main', detached: false, upstream: 'origin/main', ahead: 2, behind: 0,
      staged: 1, unstaged: 2, untracked: 1, changesTotal: 4,
      changes: [{ code: 'M ', path: 'src/index.ts' }, { code: ' M', path: 'README.md' }, { code: ' M', path: 'src/app/view.tsx' }, { code: '??', path: 'notes.txt' }],
      commits: [{ sha: 'a'.repeat(40), short: 'aaaaaaa', at: Date.now() - 3_600_000, subject: 'feat: project details panel' }, { sha: 'b'.repeat(40), short: 'bbbbbbb', at: Date.now() - 7_200_000, subject: 'chore: bump deps' }],
      remote: 'https://github.com/forsion/demo.git',
    },
  }
}

/** 桩引擎没有 /agent/runs?sessionId 路由时会弹「历史加载失败」;这里给了空表,但仍保险地关掉残留通知再截图。 */
async function dismissToasts(win) {
  for (let i = 0; i < 6; i += 1) {
    const btn = win.locator('.ntf-close').first()
    if (!(await btn.count().catch(() => 0))) break
    await btn.click({ timeout: 2_000 }).catch(() => {})
    await sleep(150)
  }
}
async function openSession(win, title, id) {
  for (let i = 0; i < 20; i++) {
    const row = win.locator('.t2s-srow, .t2o-row').filter({ hasText: title }).first()
    if (await row.count().catch(() => 0)) { await row.click().catch(() => {}); break }
    await sleep(400)
  }
  await win.waitForSelector(`[data-chat-surface="chat"][data-session-id="${id}"]`, { timeout: 20_000 })
  await sleep(500)
}
const noOverflow = (loc) => loc.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
/** 溢出时点名是谁:列出右缘超出面板的后代(类名 + 超出像素),不然「scrollWidth 大了」没法定位。 */
const overflowReport = (loc) => loc.evaluate((el) => {
  const right = el.getBoundingClientRect().right
  return Array.from(el.querySelectorAll('*')).filter((n) => n.getBoundingClientRect().right > right + 1 && n.getBoundingClientRect().width > 0)
    .slice(0, 6).map((n) => `${n.tagName.toLowerCase()}.${String(n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className).split(' ').slice(0, 2).join('.')}+${Math.round(n.getBoundingClientRect().right - right)}px`).join(', ')
})

async function run(app, win, stub, seen, home) {
  win.setDefaultTimeout(15_000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
  await win.waitForSelector('#root', { timeout: 30_000 })
  await win.waitForTimeout(2000)
  for (const label of ['跳过引导', 'Skip']) {
    const b = win.getByText(label, { exact: true })
    if (await b.count().catch(() => 0)) { await b.first().click().catch(() => {}); break }
  }
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await win.evaluate(() => { localStorage.setItem('forsion_default_space', 'tangu'); localStorage.removeItem('forsion_tangu_session_mode') })
  await win.reload({ waitUntil: 'domcontentloaded' })
  await win.waitForSelector('#root', { timeout: 30_000 })
  await win.waitForSelector('.t2sw, .t2s-side', { timeout: 30_000 })
  await sleep(1200)
  await openSession(win, 'Demo main', 'pd-main')
  await win.locator('.dv-edge-right').click()
  const details = win.locator('[data-tangu-details]')
  await details.waitFor()
  const profile = details.locator('[data-project-profile]')
  const shots = {}
  const shot = (name) => path.join(home, `${name}.png`)

  // ── 1 入口闸 + 头部 ────────────────────────────────────────────────
  await profile.waitFor({ timeout: 15_000 }).catch(() => {})
  if (!(await profile.count())) { await win.screenshot({ path: shot('failure-no-profile') }); throw new StopEarly('项目会话的右栏没有渲染 PROJECT 详情') }
  await details.getByText('Demo Project', { exact: false }).first().waitFor().catch(() => {})
  const head = await profile.evaluate((el) => ({
    kind: (el.querySelector('.team-profile-identity h3') || {}).textContent,
    name: (el.querySelector('.team-profile-name') || {}).value,
    pathText: (el.querySelector('.project-profile-path button') || {}).textContent,
    state: (el.querySelector('.agent-state') || {}).textContent,
    tabs: Array.from(el.querySelectorAll('.agent-section-nav [role=tab]')).map((b) => b.textContent),
    hasOpen: !!el.querySelector('.profile-expand'),
  }))
  check('1 项目会话 → 右栏是 PROJECT 详情:头部 = 「项目」+ 可编辑名称 + 路径 + 状态行(会话数 + 分支*)、三个标签', head.kind === '项目' && head.name === 'Demo Project' && /Demo Project$/.test(head.pathText || '') && /3 个会话/.test(head.state) && /main\*/.test(head.state) && head.tabs.length === 3 && head.hasOpen, JSON.stringify(head))
  check('1a 项目上下文只按会话拉一次(GET /agent/project-context?sessionId=pd-main)', seen.ctxGets.length >= 1 && seen.ctxGets.every((id) => id === 'pd-main'), JSON.stringify(seen.ctxGets))

  // ── 2 Agents 页:执行者 = 会话推导,当前会话置顶 ─────────────────────
  const rows = () => profile.locator('[data-project-executor]').evaluateAll((els) => els.map((el) => ({ key: el.dataset.projectExecutor, tag: (el.querySelector('.project-executor-tag') || {}).textContent || '', status: (el.querySelector('.team-member-status') || {}).textContent || '' })))
  let list = await rows()
  check('2 执行者列表:xyra(当前会话,置顶)→ coder → 临时配队;状态行带会话数与最近活动', list.map((r) => r.key).join(',') === 'agent:xyra,agent:coder,party:pd-team' && list[0].tag === '当前会话' && /1 个会话/.test(list[1].status) && /临时配队/.test(list[2].status), JSON.stringify(list))
  await sleep(350) // 导航滑块与入场动画走完再量,量到中间帧会假红
  check('2a 所有页面不横向溢出(Agents)', await noOverflow(profile), await overflowReport(profile))
  await win.waitForTimeout(300)
  await dismissToasts(win)
  await details.screenshot({ path: shots.agentsLight = shot('project-agents-zh-light') })
  await profile.locator('[data-project-executor="agent:coder"] .team-member-open').click()
  const coderDetail = profile.locator('[data-project-executor-detail="agent:coder"]')
  await coderDetail.locator('[data-agent-profile="coder"]').waitFor()
  check('3 点执行者行 → 就地打开该 Agent 的紧凑详情,返回键在场', await coderDetail.isVisible() && await profile.locator('.team-member-heading button').filter({ hasText: '返回项目' }).count() === 1)
  await profile.locator('.team-member-heading button').filter({ hasText: '返回项目' }).click()
  check('3a 返回项目后 Agents 列表复现', await profile.locator('[data-project-executor="agent:xyra"]').isVisible())
  await profile.locator('[data-project-executor="party:pd-team"] .team-member-open').click()
  const partyDetail = profile.locator('[data-project-executor-detail="party:pd-team"]')
  await partyDetail.locator('[data-team-profile]').waitFor()
  check('3b 点临时配队 → 就地打开 TEAM 详情(嵌套)', await partyDetail.isVisible())
  await profile.locator('.team-member-heading button').filter({ hasText: '返回项目' }).click()

  // ── 4 配置页:指令文件空态 → 创建 → 编辑 → 保存 ────────────────────────
  await profile.getByRole('tab', { name: '配置', exact: true }).click()
  const docCard = profile.locator('[data-project-doc]')
  await docCard.waitFor()
  const emptyButtons = await docCard.locator('.project-card-actions button').allTextContents()
  check('4 指令文件空态:说明 + 「创建 .tangu/AGENTS.md」+ 「让 Tangu 生成」', emptyButtons.length === 2 && /创建 \.tangu\/AGENTS\.md/.test(emptyButtons[0]) && /让 Tangu 生成/.test(emptyButtons[1]) && (await docCard.textContent()).includes('尚未创建'), JSON.stringify(emptyButtons))
  check('4a 技能卡列出两条,旧位置那条打标;计划卡列出「Ship v1」', await profile.locator('[data-project-skills] .project-row').count() === 2 && await profile.locator('[data-project-skills] .project-chip.warn').count() === 1 && (await profile.locator('[data-project-plans]').textContent()).includes('Ship v1'))
  await docCard.locator('.project-card-actions button').first().click()
  await docCard.locator('textarea').waitFor()
  check('4b 点创建 → POST init 一次 → 编辑器出现且带骨架正文,状态芯片变「已生效」', seen.init === 1 && (await docCard.locator('textarea').inputValue()) === TEMPLATE && (await docCard.textContent()).includes('已生效'), `init=${seen.init}`)
  await docCard.locator('textarea').fill(TEMPLATE + '\nRun npm test before committing.\n')
  const saveBtn = profile.locator('.agent-profile-save button.primary')
  await saveBtn.waitFor()
  await saveBtn.click()
  await profile.locator('.profile-save-notice').waitFor()
  const put = seen.docPuts[0]
  check('4c 保存 → PUT /agent/project-context/doc 带 sessionId + 正文 + 读出时的 mtime(冲突检测),不传路径', !!put && put.sessionId === 'pd-main' && /Run npm test/.test(put.content) && put.expectedMtimeMs === 1000 && !('path' in put), JSON.stringify(put))
  check('4d 保存后提示「已保存」、保存栏收起', (await profile.locator('.profile-save-notice').textContent()).includes('已保存') && await saveBtn.count() === 0)
  check('4e 配置页不横向溢出', await noOverflow(profile), await overflowReport(profile))
  await win.waitForTimeout(300)
  await details.screenshot({ path: shots.settingsLight = shot('project-settings-zh-light') })

  // ── 5 本机默认项:默认执行者 → 保存 → Agents 页出现星标 ──────────────────
  await profile.locator('[data-project-defaults] select').first().selectOption('agent:coder')
  await profile.locator('[data-project-defaults] select').nth(1).selectOption('full-auto')
  await profile.locator('.agent-profile-save button.primary').click()
  await win.waitForTimeout(400)
  const settingsPut = seen.settingsPuts.at(-1)
  check('5 默认项保存 → PUT settings { defaultAgent: coder, approvalMode: full-auto },不带 defaultTeam', !!settingsPut && settingsPut.sessionId === 'pd-main' && settingsPut.settings.defaultAgent === 'coder' && settingsPut.settings.approvalMode === 'full-auto' && !settingsPut.settings.defaultTeam, JSON.stringify(settingsPut))
  await profile.getByRole('tab', { name: 'Agents', exact: true }).click()
  list = await rows()
  check('5a Agents 页 coder 行带「项目默认」星标,行动作按钮 aria-pressed=true', list[1].key === 'agent:coder' && await profile.locator('[data-project-executor="agent:coder"] .project-inline-actions button[aria-pressed="true"]').count() === 1, JSON.stringify(list))
  // 星标按钮直接切换默认(不经保存栏):点 xyra 的「设为项目默认」→ PUT { defaultAgent: xyra },coder 星标移走
  await profile.locator('[data-project-executor="agent:xyra"] .project-inline-actions button').nth(1).click()
  await win.waitForTimeout(400)
  check('5b 行内「设为项目默认」立即写 PUT settings { defaultAgent: xyra } 并保留别的键(approvalMode)', seen.settingsPuts.at(-1)?.settings.defaultAgent === 'xyra' && seen.settingsPuts.at(-1)?.settings.approvalMode === 'full-auto' && await profile.locator('[data-project-executor="agent:xyra"] .project-inline-actions button[aria-pressed="true"]').count() === 1, JSON.stringify(seen.settingsPuts.at(-1)))

  // ── 6 Git 页 ───────────────────────────────────────────────────────
  await profile.getByRole('tab', { name: 'Git', exact: true }).click()
  const gitCard = profile.locator('[data-project-git]')
  await gitCard.waitFor()
  const gitText = await gitCard.textContent()
  check('6 Git 摘要:分支 main、上游 origin/main 领先 2、改动芯片(已暂存 1 / 未暂存 2 / 未跟踪 1)、远端地址', /main/.test(gitText) && /origin\/main/.test(gitText) && /领先 2/.test(gitText) && /已暂存 1/.test(gitText) && /未暂存 2/.test(gitText) && /未跟踪 1/.test(gitText) && /github\.com\/forsion\/demo/.test(gitText), gitText.slice(0, 200))
  check('6a 改动列表 4 行(XY 码 + 路径),最近提交 2 行', await profile.locator('[data-project-git-changes] .project-git-change').count() === 4 && await profile.locator('[data-project-git-commits] .project-git-commit').count() === 2 && (await profile.locator('[data-project-git-changes] h3').textContent()).includes('4 处改动'))
  const actions = await gitCard.locator('[data-project-git-actions] button').allTextContents()
  check('6b 动作行:在终端打开 / 在文件管理器中显示 / 复制路径 / 刷新', actions.length === 4 && /终端/.test(actions[0]) && /文件管理器/.test(actions[1]) && /复制路径/.test(actions[2]) && /刷新/.test(actions[3]), JSON.stringify(actions))
  const getsBefore = seen.ctxGets.length
  await gitCard.locator('[data-project-git-actions] button').nth(3).click()
  await win.waitForTimeout(500)
  check('6c 刷新 → 重拉一次项目上下文', seen.ctxGets.length === getsBefore + 1)
  check('6d Git 页不横向溢出', await noOverflow(profile), await overflowReport(profile))
  await win.waitForTimeout(300)
  await details.screenshot({ path: shots.gitLight = shot('project-git-zh-light') })
  await win.screenshot({ path: shots.windowLight = shot('project-window-zh-light') })

  // ── 7 用它开新会话:落成新对话草稿(activeId 空),右栏随之切成该 Agent 的详情 ────
  await profile.getByRole('tab', { name: 'Agents', exact: true }).click()
  await profile.locator('[data-project-executor="agent:coder"] .project-inline-actions button').first().click()
  await details.locator('> [data-agent-profile="coder"], .agent-profile-panel-title + [data-agent-profile="coder"]').first().waitFor({ timeout: 10_000 }).catch(() => {})
  const draftState = await win.evaluate(() => ({
    directAgent: !!document.querySelector('[data-tangu-details] > [data-agent-profile="coder"]'),
    projectGone: !document.querySelector('[data-tangu-details] [data-project-profile]'),
    composer: !!document.querySelector('.t2c-ta'),
    activeSession: (document.querySelector('[data-chat-surface="chat"]') || {}).getAttribute ? document.querySelector('[data-chat-surface="chat"]').getAttribute('data-session-id') : null,
  }))
  check('7 「用它开新会话」→ 主区进入新对话(无 session id)、右栏切成 coder 的 Agent 详情、没有建空会话', draftState.directAgent && draftState.projectGone && draftState.composer && !draftState.activeSession && stub.seen.runs.length === 0 && !seen.sessionsCreated, JSON.stringify(draftState))

  // ── 8 负对照:无根会话仍是 Agent 详情 ───────────────────────────────────
  await openSession(win, 'Rootless chat', 'pd-rootless')
  await details.locator('[data-agent-profile="xyra"]').waitFor()
  check('8 无根会话 → 右栏是 Agent 详情,不是项目页', await details.locator('[data-project-profile]').count() === 0)

  // ── 8b 默认工作区也是 Project:右栏是项目页;系统工作区不可改名 → 名称只读 ─────────
  await openSession(win, 'Default chat', 'pd-default')
  await details.locator('[data-project-profile]').waitFor({ timeout: 10_000 }).catch(() => {})
  const def = await details.evaluate((el) => {
    const p = el.querySelector('[data-project-profile]'), name = p && p.querySelector('.team-profile-name')
    return p ? { path: p.getAttribute('data-project-profile'), name: name && name.value, readOnly: !!(name && name.readOnly) } : null
  })
  check('8b 默认工作区的会话 → 右栏是 PROJECT 详情(默认目录),名称只读', !!def && /[\\/]Sessions$/.test(def.path) && /默认工作区/.test(def.name || '') && def.readOnly, JSON.stringify(def))

  // ── 8c/8d 默认组里的旧别名会话:面板跟会话自己的目录;别名是家目录 → Agent 详情 ────────
  await openSession(win, 'Old default chat', 'pd-alias')
  await details.locator('[data-project-profile]').waitFor({ timeout: 10_000 }).catch(() => {})
  const aliasPath = await details.evaluate((el) => { const p = el.querySelector('[data-project-profile]'); return p && p.getAttribute('data-project-profile') })
  const aliasGets = seen.ctxGets.filter((id) => id === 'pd-alias').length
  check('8c 别名会话 → 项目页显示它自己的目录(不是默认组的当前目录),且按它的 sessionId 取上下文', !!aliasPath && /[\\/]OldTangu$/.test(aliasPath) && aliasGets > 0, JSON.stringify({ aliasPath, aliasGets }))
  await openSession(win, 'Home default chat', 'pd-homealias')
  await details.locator('[data-agent-profile="xyra"]').waitFor({ timeout: 10_000 }).catch(() => {})
  check('8d 别名是家目录的会话 → 照旧 Agent 详情(引擎拒收家目录)', await details.locator('[data-project-profile]').count() === 0 && await details.locator('[data-agent-profile="xyra"]').count() > 0)

  // ── 9 英文 × 暗色:回到项目会话,三个页面都不溢出 + 截图 ───────────────────
  await win.evaluate(() => { localStorage.setItem('tangu_locale', 'en'); localStorage.setItem('forsion_theme_pref', 'dark') })
  await win.reload({ waitUntil: 'domcontentloaded' })
  await win.waitForSelector('#root', { timeout: 30_000 })
  await win.waitForSelector('.t2sw, .t2s-side', { timeout: 30_000 })
  await sleep(1000)
  await openSession(win, 'Demo main', 'pd-main')
  if (!(await details.count())) await win.locator('.dv-edge-right').click()
  await profile.waitFor()
  await profile.locator('[data-project-executor]').first().waitFor()
  const enHead = await profile.evaluate((el) => ({ kind: (el.querySelector('.team-profile-identity h3') || {}).textContent, tabs: Array.from(el.querySelectorAll('.agent-section-nav [role=tab]')).map((b) => b.textContent) }))
  check('9 英文界面:标题 Project、标签 Agents / Settings / Git', enHead.kind === 'Project' && enHead.tabs.join(',') === 'Agents,Settings,Git', JSON.stringify(enHead))
  const overflowEn = []
  for (const tab of ['Agents', 'Settings', 'Git']) {
    await profile.getByRole('tab', { name: tab, exact: true }).click()
    await win.waitForTimeout(280)
    await dismissToasts(win)
    overflowEn.push([tab, await noOverflow(profile)])
    await details.screenshot({ path: shots[`en-dark-${tab}`] = shot(`project-${tab.toLowerCase()}-en-dark`) })
  }
  check('9a 英文 × 暗色三页都不横向溢出', overflowEn.every(([, ok]) => ok), JSON.stringify(overflowEn))
  const dark = await win.evaluate(() => document.documentElement.getAttribute('data-mode'))
  check('9b 暗色确实生效(html[data-mode=dark])', dark === 'dark', String(dark))
  return shots
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out', 'main', 'main.js'))) { console.error('先跑 npm run build(仪器跑的是 out/ 产物)'); process.exit(1) }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-projectdetails-'))
  const userData = path.join(home, 'userData')
  const vault = path.join(home, 'vault')
  const projectDir = path.join(home, 'Demo Project')
  for (const dir of [userData, `${userData}-dev`, vault, projectDir]) fs.mkdirSync(dir, { recursive: true })
  const ctx = contextFixture(projectDir)
  const seen = { ctxGets: [], init: 0, docPuts: [], settingsPuts: [], skills: [], sessionsCreated: 0 }
  const projectIds = new Set(['pd-main', 'pd-coder', 'pd-team', 'pd-default', 'pd-alias'])
  const stub = await startStubEngine({ agents: AGENTS, sessions: sessionFixtures(projectDir, path.join(vault, 'Sessions'), path.join(home, 'OldTangu')), messages: [], handle: async ({ path: route, method, url, body }) => {
    if (route === '/agent/runs' && url.searchParams.has('sessionId')) return { runs: [] }
    if (route === '/agent/teams') return { teams: [] }
    if (route === '/agent/special/config') return { config: { historian: { enabled: false }, muse: { enabled: false } } }
    if (route.startsWith('/agent/project-context')) {
      const sid = method === 'GET' ? url.searchParams.get('sessionId') : (await body()).sessionId
      if (!projectIds.has(sid)) return { __code: 400, body: { detail: 'stub: not a project session' } }
      if (route === '/agent/project-context' && method === 'GET') { seen.ctxGets.push(sid); return ctx }
      if (route === '/agent/project-context/settings' && method === 'GET') return { settings: ctx.settings }
      if (route === '/agent/project-context/init' && method === 'POST') { seen.init += 1; ctx.doc = { ...ctx.doc, exists: true, content: TEMPLATE, mtimeMs: 1000, bytes: TEMPLATE.length, sources: [ctx.doc.path] }; return { createdDir: true, createdDoc: true, context: ctx } }
    }
    return undefined
  }, override: async ({ path: route, method, url, body }) => {
    // 桩对 ?archived=true 也回同一份会话表;不拦的话归档表 = 活跃表的复印件,执行者的会话数翻倍
    if (route === '/agent/sessions' && method === 'GET' && url.searchParams.get('archived') === 'true') return { sessions: [] }
    // 带 body 的写接口:override 在 handle 之前跑且能读 body(handle 的 body() 只能读一次,GET 分支已用掉 sessionId 的读取)
    if (route === '/agent/project-context/doc' && method === 'PUT') { const b = await body(); seen.docPuts.push(b); ctx.doc = { ...ctx.doc, exists: true, content: b.content, mtimeMs: 2000 }; return { path: ctx.doc.path, mtimeMs: 2000 } }
    if (route === '/agent/project-context/settings' && method === 'PUT') { const b = await body(); seen.settingsPuts.push(b); ctx.settings = b.settings; return { settings: b.settings } }
    if (route === '/agent/project-context/skills' && method === 'POST') { const b = await body(); seen.skills.push(b); const skill = { id: `local:${b.slug}`, name: b.name, description: b.description, path: path.join(projectDir, '.tangu', 'skills', b.slug), legacy: false }; ctx.skills.push(skill); return { skill } }
    if (route === '/agent/sessions' && method === 'POST') seen.sessionsCreated += 1
    return undefined
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
  const errors = []
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => { errors.push(String(e && e.stack || e).slice(0, 400)); console.error('[renderer pageerror]', String(e && e.stack || e).slice(0, 600)) })
    win.on('console', (m) => { if (m.type() === 'error') console.error('[renderer console.error]', m.text().slice(0, 600)) })
    shots = await run(app, win, stub, seen, home)
    check('10 渲染进程零 pageerror', errors.length === 0, errors.join(' || ').slice(0, 300))
  } catch (e) {
    if (e instanceof StopEarly) console.error(`STOP  ${e.message}`)
    else { console.error(e); check('runner 未捕获异常', false, String((e && e.message) || e)) }
    try { await (await app.firstWindow()).screenshot({ path: path.join(home, 'failure.png') }) } catch { /* ignore */ }
  } finally {
    await app.close().catch(() => {})
    try { stub.close() } catch { /* ignore */ }
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  console.log('ARTIFACTS ' + home)
  if (shots) console.log('SHOTS ' + JSON.stringify(shots))
  process.exit(failed.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
