/** Full ChatView child conversation + Agent loadout UI. Isolated Electron, no user data. */
const { _electron: electron } = require('playwright-core')
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert/strict')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.join(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-agent-profile-'))
const base = { archived: false, model_id: 'm1', created_at: '2026-09-16 10:00:00', updated_at: '2026-09-16 10:00:00', projectless: false, project_path: home, project_name: 'Atlas' }
const config = { groupChat: true, groupAgents: ['xyra', 'research'], execMode: 'host', cwd: home, agentSlug: 'xyra' }
const main = { ...base, id: 'profile-main', title: 'Atlas team', agent_config: config }
const child = { ...base, id: 'profile-child', title: 'Research work', agent_config: { agentSlug: 'research', execMode: 'host', cwd: home, teamMember: { teamSessionId: main.id } } }
const agents = ['xyra', 'research'].map((slug) => ({ slug, name: slug === 'xyra' ? 'Xyra' : 'Research', description: slug === 'xyra' ? 'Project coordination' : 'Evidence and analysis', tools: [], model: '', thinkingLevel: '', maxIterations: null, approvalMode: '', systemPrompt: 'Be precise.', soul: '', createdBy: 'user', libraryDir: path.join(home, slug, 'Library') }))
const text = 'Full child conversation detail. '.repeat(60) + 'END-OF-COMPLETE-REPORT'
const toolResult = 'Complete tool output '.repeat(100) + 'END-OF-TOOL-RESULT'
const childMessages = [{ id: 'child-user', session_id: child.id, role: 'user', content: 'Research this thoroughly', timestamp: 1 }, { id: 'child-answer', session_id: child.id, role: 'model', content: text, reasoning: 'A detailed reasoning record.', agent_slug: 'research', timestamp: 2, tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"evidence.md"}' } }], tool_results: [{ tool_call_id: 'read-1', content: toolResult, isError: false }] }]
const solo = { ...base, id: 'profile-solo', title: 'Research notes', agent_config: { agentSlug: 'research', execMode: 'host', cwd: home } }
// 进化(HARNESS 工作笔记):一条现存、一条已删可恢复;第二条日期是手改出来的非 ISO 串,不许渲出 Invalid Date。
const harnessEntries = [{ id: 'h-cite', kind: 'recipe', title: 'Cite before concluding', body: 'Quote the primary source before concluding.', evidence: 'corrected twice', createdAt: '2026-09-10', updatedAt: '2026-09-16', version: 2 }, { id: 'h-scope', kind: 'note', title: 'Confirm scope first', body: 'Ask for time range and region.', createdAt: '2026-09-12', updatedAt: 'last week', version: 1 }]
const harnessOld = { id: 'h-old', kind: 'note', title: 'Prefer PDF over HTML', body: 'Superseded.', createdAt: '2026-09-01', updatedAt: '2026-09-01', version: 1 }
const harnessJournal = [{ ts: '2026-09-01T10:00:00Z', action: 'upsert', entryId: 'h-old', before: null, after: harnessOld }, { ts: '2026-09-10T08:00:00Z', action: 'upsert', entryId: 'h-cite', before: null, after: { ...harnessEntries[0], version: 1 } }, { ts: '2026-09-14T15:00:00Z', action: 'delete', entryId: 'h-old', before: harnessOld, after: null }, { ts: '2026-09-16T09:30:00Z', action: 'upsert', entryId: 'h-cite', before: { ...harnessEntries[0], version: 1 }, after: harnessEntries[0] }]
// Historian 自动档的提名(收件箱原始行):面板要显示「1 条待复盘候选」且不许把 `[日期 s:会话]` 内部记号渲出来;「进化」标签带角标。
const harnessCandidates = ['- [2026-09-17 s:abcd1234] Check the marker file before answering']
const harnessRollbacks = []
let harnessReads = 0
// 自进化自动档的提名 → 右上角提醒(HistorianStatus 在会话里每 2.5s 轮询活动):
//  - 团队主会话 Atlas team 的活动流**从第一次轮询起就带**一条提名 → 那是历史,不许弹(负对照;弹了会盖住右栏,后面的点击全被拦);
//  - Research notes 的活动流只在 nominate 置真后才出现提名 → 必须弹一张卡;点「复盘」就地往该会话发 /refine;同 id 不弹第二张。
const LONG_DESC = 'Use when the task needs this capability. '.repeat(8).trim() // 真实内置技能的描述有两三百字:一行放不下才测得出截断
let nominate = false
let harnessEmpty = false // 置真后 GET harness 回 entries: [] —— 「还没笔记但收件箱已有提名」这个首次用户的状态,候选段必须仍在
const historianPolls = { main: 0, solo: 0 }
const nomination = (id, sessionId) => ({ id, action: 'harness_candidates', detail: 'Check the marker file before answering', session_ref: sessionId, created_at: '2026-09-18 10:00:00' })
let saved = null, sessionModelSaved = null, avatarWrites = 0, avatarDeletes = 0
let app
async function run() {
  const stub = await startStubEngine({ agents, sessions: [main, solo], messages: [{ id: 'main-user', role: 'user', content: 'Plan the research', timestamp: 1 }, { id: 'main-answer', role: 'model', content: 'The team is ready.', timestamp: 2 }], override: async ({ path: p, method, url: u, body }) => {
    if (p === `/agent/sessions/${solo.id}` && method === 'PATCH') { const patch = await body(); sessionModelSaved = patch.model_id; Object.assign(solo, patch); return { session: solo } }
    if (p.endsWith('/memory/dream')) return { config: { enabled: false, modelId: '', timeoutMs: 60000, maxOutputTokens: 4096, intervalHours: 6 }, status: { state: 'idle', running: false }, candidates: 0 }
    if (p.endsWith('/memory/revisions')) return { revisions: [] }
    if (p.endsWith('/memory') && method === 'GET') return { version: 'version-1', content: 'Cite primary sources.', entries: [{ id: 'memory-1', content: 'Cite primary sources.', source: { kind: 'manual' }, evidenceIds: [], createdAt: 1, updatedAt: 1 }], tombstones: [], updatedAt: 1 }
    if (p === '/agent/runs' && method === 'GET') return { runs: [] }
    if (p === '/agent/agents/research/harness' && method === 'GET') { harnessReads++; return { entries: harnessEmpty ? [] : harnessEntries, journal: harnessJournal, candidates: harnessCandidates } }
    if (p === '/agent/special/config' && method === 'GET') return { config: { historian: { enabled: true, modelId: 'm1', harnessCandidates: true }, muse: { enabled: false } } }
    if (p.startsWith('/agent/special/historian/activity')) {
      const sid = (typeof u === 'string' ? new URL(u, 'http://stub') : u).searchParams.get('sessionId')
      if (sid === main.id) { historianPolls.main++; return { running: false, records: [], activity: [nomination('act-hc-main', main.id)] } }
      if (sid === solo.id) { historianPolls.solo++; return { running: false, records: [], activity: nominate ? [nomination('act-hc-solo', solo.id)] : [] } }
      return { running: false, records: [], activity: [] }
    }
    if (p === '/agent/agents/research/harness/rollback' && method === 'POST') { harnessRollbacks.push((await body()).id); return { ok: true, entry: harnessOld } }
    if (p.endsWith('/detail')) return { session: child }
    if (p.endsWith('/background')) return { background: [{ sessionId: child.id, kind: 'teamwork', title: child.title, agentSlug: 'research', runId: null, runStatus: null }] }
    if (p === `/agent/sessions/${child.id}/messages`) return { messages: childMessages }
    if (p.endsWith('/config') && p.startsWith('/agent/sessions/')) return { agent_config: p.includes(child.id) ? child.agent_config : p.includes(solo.id) ? solo.agent_config : config }
    // 「自建」徽标只认 origin:'agent'(manage_skill 写的);category:'agent' 的包内置专属技能(如 bluebird-video)没有徽标 —— 负对照。
    // builtin:true 的两条 = 随包内置技能(描述照真实内置的长度写):默认收在合上的「内置技能」组里,搜索命中才自动展开。
    if (p === '/agent/skills') return { skills: [{ id: 'local:research', name: 'Research notebook', description: 'Gather and cite evidence', category: 'agent' }, { id: 'local:writing', name: 'Writing', description: 'Write clear reports', origin: 'agent' },
      { id: 'local:git-workflow', name: 'Git workflow', description: LONG_DESC, category: '开发流程', builtin: true }, { id: 'local:web-research', name: 'Web research', description: LONG_DESC, category: '信息检索', builtin: true }] }
    // 日程:一条每天自动执行(锚点在过去 → 下一次要滚到未来)、一条已过期的一次性计划;规则两条,只有一条的动作链会叫醒 research(另一条是负对照)。
    if (p === '/agent/special/schedule' && method === 'GET') return { schedules: [{ slug: 'research', name: 'Research', db: { version: 1, name: 'Schedule', columns: [], rows: [] }, entries: [
      { id: 'sch-daily', name: 'Morning digest', date: '2026-01-01T09:00', repeat: '1d', auto: true, prompt: 'Summarize new primary sources.', description: '', todo: false, lastRun: '2026-09-18T09:00:03.000Z' },
      { id: 'sch-old', name: 'Kickoff review', date: '2026-02-01', repeat: '', auto: false, prompt: '', description: 'One-off planning note', todo: false, lastRun: '' }] }] }
    if (p === '/agent/special/muse/triggers' && method === 'GET') return { triggers: [
      { id: 'tr-mine', desc: 'Weekly source sweep', cond: { type: 'daily_at', time: '08:30' }, cooldownHours: 0, lastFiredAt: null, enabled: true, createdAt: '2026-09-01', actions: [{ type: 'agent_run', agentSlug: 'research', prompt: 'sweep' }], nextRunAt: null },
      { id: 'tr-other', desc: 'Someone else rule', cond: { type: 'daily_at', time: '07:00' }, cooldownHours: 0, lastFiredAt: null, enabled: true, createdAt: '2026-09-01', actions: [{ type: 'agent_run', agentSlug: 'xyra', prompt: 'x' }], nextRunAt: null }] }
    if (p === '/agent/tools') return { builtins: [], custom: [], mcp: [{ server: 'documents', status: 'connected', transport: 'stdio', tools: [{ name: 'read', description: 'Read documents' }] }] }
    if (p === '/agent/agents/research/avatar' && method === 'POST') { avatarWrites++; agents.find((a) => a.slug === 'research').avatar = 'avatar.png'; return { ok: true, avatar: 'avatar.png' } }
    if (p === '/agent/agents/research/avatar' && method === 'DELETE') { avatarDeletes++; delete agents.find((a) => a.slug === 'research').avatar; return { ok: true } }
    if (p.startsWith('/agent/agents/') && method === 'PATCH') { saved = await body(); const slug = p.split('/')[3]; const i = agents.findIndex((a) => a.slug === slug); agents[i] = { ...agents[i], ...saved }; return { agent: agents[i] } }
  } })
  try {
    const ud = path.join(home, 'userData')
    for (const dir of [ud, `${ud}-dev`]) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }))
    }
    app = await electron.launch({ args: [`--user-data-dir=${ud}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
    const win = await app.firstWindow()
    const errors = []
    win.on('pageerror', (e) => errors.push(String(e)))
    win.setDefaultTimeout(15000)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
    await win.waitForSelector('#root')
    await win.waitForTimeout(2000)
    for (const label of ['跳过引导', 'Skip']) { const b = win.getByText(label, { exact: true }); if (await b.count()) { await b.first().click(); break } }
    await win.waitForSelector('.dv-groupview')
    await win.evaluate(() => localStorage.setItem('forsion_default_space', 'tangu'))
    await win.reload()
    assert.equal(await win.getByTitle('Tangu', { exact: true }).count() > 0, true, 'Tangu Space must not collide with the Agents label')
    await win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Atlas team' }).first().click()
    await win.locator('[data-team-desk="status"] [data-slug="research"]').click()
    const panel = win.locator('.child-chat-panel')
    await panel.locator('[data-chat-surface="child-chat"]').waitFor()
    assert.equal(await panel.getByText(/END-OF-COMPLETE-REPORT/).count(), 1)
    assert.equal(await win.locator('.t2-tsum [data-team-desk="work"]').count(), 0)
    assert.equal(await win.locator('[data-chat-surface="chat"]').getAttribute('data-session-id'), main.id)
    await panel.locator('.t2c-ta').fill('Continue with sources')
    await panel.locator('.t2c-ta').press('Enter')
    await win.waitForTimeout(500)
    assert.equal(stub.seen.runs.at(-1)?.sessionId, child.id)
    assert.equal(stub.seen.runs.at(-1)?.agentConfig.agentSlug, 'research')
    assert.equal(stub.seen.runs.at(-1)?.agentConfig.teamMember.teamSessionId, main.id)
    await win.waitForTimeout(220)
    await win.screenshot({ path: path.join(home, 'child-chat.png') })
    console.log('PASS child full history, isolated send and retained parent identity')
    // 负对照:主会话的活动流从第一次轮询就带着一条提名 → 属于历史,不许弹卡。
    for (let i = 0; i < 40 && historianPolls.main < 2; i++) await win.waitForTimeout(250)
    assert.ok(historianPolls.main >= 2, `HistorianStatus polls the active session (polls=${historianPolls.main})`)
    assert.equal(await win.locator('.ntf').filter({ hasText: '有新的工作笔记候选' }).count(), 0, 'A nomination already present on the first poll is history, not news')
    await panel.locator('.agent-desk-head button').click()
    await win.locator('.dv-edge-right').click()
    await win.locator('[data-tangu-details]').waitFor()
    assert.equal(await win.locator('[data-tangu-details]').getByText('团队', { exact: true }).count(), 1)
    await win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Research notes' }).first().click()
    await win.locator('[data-tangu-details] [data-agent-profile="research"]').waitFor()
    assert.equal(await win.locator('.dv-tab[title="子聊天"], .dv-tab[title="记忆"], .dv-tab[title="Chat"]').count(), 0)
    const compact = win.locator('[data-tangu-details] [data-agent-profile="research"]')
    await compact.locator('.agent-current-session .profile-model-trigger').click()
    await compact.getByLabel('搜索模型或输入模型 ID', { exact: true }).press('ArrowDown')
    assert.equal(await compact.locator('.profile-model-results button').first().evaluate((el) => el === document.activeElement), true)
    await compact.locator('.profile-model-results button').first().press('Escape')
    assert.equal(await compact.locator('.agent-current-session .profile-model-trigger').evaluate((el) => el === document.activeElement), true)
    await compact.locator('.agent-current-session .profile-model-trigger').click()
    await compact.getByLabel('搜索模型或输入模型 ID', { exact: true }).fill('custom/session-model')
    await compact.getByRole('button', { name: '使用模型 ID：custom/session-model', exact: true }).click()
    await win.waitForTimeout(200)
    assert.equal(sessionModelSaved, 'custom/session-model')
    await compact.locator('.profile-config-group .profile-model-trigger').click()
    await compact.getByLabel('搜索模型或输入模型 ID', { exact: true }).fill('Stub')
    await compact.getByRole('button', { name: 'Stub m1', exact: true }).click()
    await compact.getByLabel('思考档位', { exact: true }).selectOption('high')
    await compact.getByRole('button', { name: '保存配置', exact: true }).click()
    await win.waitForTimeout(200)
    assert.equal(saved.model, 'm1')
    assert.equal(saved.thinkingLevel, 'high')
    assert.equal(solo.model_id, 'custom/session-model', 'Agent defaults must not overwrite a conversation override')
    await win.waitForTimeout(220)
    await compact.locator('.agent-profile-content').evaluate((el) => el.scrollTop = 0)
    await win.screenshot({ path: path.join(home, 'details-panel.png') })
    console.log('PASS overview model/thinking edits persist; session and Agent scopes remain independent')
    await win.locator('[data-tangu-details] .agent-section-nav button').filter({ hasText: '技能' }).click()
    assert.equal(await compact.locator('.agent-equipment-item').filter({ hasText: 'Writing' }).locator('.harness-kind').textContent(), '自建', 'A skill the agent wrote with manage_skill is badged')
    assert.equal(await compact.locator('.agent-equipment-item').filter({ hasText: 'Research notebook' }).locator('.harness-kind').count(), 0, 'A bundled agent-category skill without origin is not badged')
    // 内置技能收进默认合上的组:自己的两条在外面,内置两条在组里且不可见;组标题带已启用计数。
    const ownRows = compact.locator('.profile-section-enter > .agent-equipment-list .agent-equipment-item')
    const stockGroup = compact.locator('[data-equipment-group="builtin"]')
    assert.equal(await ownRows.count(), 2, 'Only non-built-in skills sit in the main list')
    assert.equal(await stockGroup.evaluate((el) => el.open), false, 'Built-in skills start collapsed')
    assert.equal(await stockGroup.locator('.agent-equipment-item').first().isVisible(), false)
    assert.ok((await stockGroup.locator('summary').textContent()).includes('2 / 2'), 'The collapsed group still reports how many built-in skills are enabled')
    // 描述默认一行(长描述被截断),点一下展开全文。
    await stockGroup.locator('summary').click()
    const longDesc = stockGroup.locator('.equipment-desc').first()
    assert.equal(await longDesc.evaluate((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).whiteSpace === 'nowrap'), true, 'A long description is clamped to one line')
    const clampedHeight = await longDesc.evaluate((el) => el.getBoundingClientRect().height)
    await longDesc.click()
    assert.ok(await longDesc.evaluate((el, h) => el.getAttribute('aria-expanded') === 'true' && el.getBoundingClientRect().height > h * 2, clampedHeight), 'Clicking the description expands the full text')
    await win.waitForTimeout(220)
    await win.locator('[data-tangu-details]').screenshot({ path: path.join(home, 'compact-skills.png') })
    await stockGroup.locator('summary').click()
    // 搜索命中内置技能 → 组自动展开;清空搜索 → 合回去(过滤后的命中不许藏在合着的组里)。
    await compact.getByLabel('搜索名称或描述', { exact: true }).fill('Git workflow')
    assert.equal(await stockGroup.evaluate((el) => el.open), true, 'A search hit inside the built-in group opens it')
    assert.equal(await compact.locator('.agent-equipment-item').count(), 1)
    await compact.getByLabel('搜索名称或描述', { exact: true }).fill('Writing')
    assert.equal(await compact.locator('.agent-equipment-item').count(), 1)
    await compact.getByLabel('Writing', { exact: false }).uncheck()
    await compact.getByLabel('搜索名称或描述', { exact: true }).fill('')
    assert.equal(await stockGroup.evaluate((el) => el.open), false, 'Clearing the search collapses the built-in group again')
    await compact.getByRole('button', { name: '仅看已启用', exact: true }).click()
    assert.equal(await ownRows.count(), 1)
    await compact.getByRole('button', { name: '仅看已启用', exact: true }).click()
    const geometry = await compact.evaluate((el) => {
      const body = el.querySelector('.agent-profile-content'), nav = el.querySelector('.agent-section-nav'), footer = el.querySelector('.agent-profile-save')
      body.scrollTop = body.scrollHeight
      return { footer: footer.getBoundingClientRect().bottom, panel: el.getBoundingClientRect().bottom, nav: nav.getBoundingClientRect().bottom, body: body.getBoundingClientRect().top, overflow: el.scrollWidth > el.clientWidth + 1 }
    })
    assert.ok(geometry.footer <= geometry.panel + 1 && geometry.nav <= geometry.body + 1 && !geometry.overflow)
    await win.locator('[data-tangu-details]').getByRole('button', { name: '保存配置', exact: true }).click()
    await win.waitForTimeout(200)
    assert.deepEqual(saved.enabledSkillIds, ['local:research', 'local:git-workflow', 'local:web-research'], 'Unchecking one skill keeps the rest, including the collapsed built-in ones')
    console.log('PASS default right details follows main session; compact skill editing')
    // 记忆与进化并成一个「成长」标签(两张分段卡);原来的两个一级标签不该还在。
    assert.equal(await compact.getByRole('tab', { name: '记忆', exact: true }).count() + await compact.getByRole('tab', { name: '进化', exact: true }).count(), 0)
    const segment = (name) => compact.locator('.profile-segment button').filter({ hasText: name })
    await compact.getByRole('tab', { name: '成长', exact: true }).click()
    assert.equal(await segment('记忆').getAttribute('aria-pressed'), 'true', 'Growth opens on the Memory layer')
    const memory = compact.locator('[data-testid="agent-memory-panel"]')
    await memory.getByText('Cite primary sources.', { exact: true }).first().waitFor()
    await memory.getByLabel('搜索记忆', { exact: true }).fill('absent')
    await memory.getByText('没有匹配的记忆', { exact: true }).waitFor()
    await memory.getByLabel('搜索记忆', { exact: true }).fill('')
    // 二级标签(条目 / 整理 / 原文 / 历史)已收成折叠块:条目始终在,原文点开才出现。
    assert.equal(await memory.locator('.profile-memory-nav').count(), 0)
    assert.equal(await memory.locator('[data-memory-entry-id="memory-1"]').getByRole('button', { name: '遗忘', exact: true }).count(), 1, 'Entry actions stay reachable by name as icon buttons')
    await win.waitForTimeout(220)
    await win.locator('[data-tangu-details]').screenshot({ path: path.join(home, 'compact-memory.png') })
    await memory.locator('summary').filter({ hasText: '编辑原文' }).click()
    await memory.getByRole('textbox', { name: '记忆原文', exact: true }).fill('Unsaved memory draft')
    await compact.getByRole('tab', { name: '技能', exact: true }).click()
    await compact.getByRole('tab', { name: '成长', exact: true }).click()
    assert.equal(await memory.getByRole('textbox', { name: '记忆原文', exact: true }).inputValue(), 'Unsaved memory draft')
    await segment('进化').click()
    await segment('记忆').click()
    assert.equal(await memory.getByRole('textbox', { name: '记忆原文', exact: true }).inputValue(), 'Unsaved memory draft', 'Switching between the two Growth layers keeps the memory draft')
    await win.waitForTimeout(220)
    assert.ok(!(await compact.locator('.agent-profile-save').textContent()).includes('已保存'), 'An Agent save must not imply an unsaved memory draft was saved')
    await win.screenshot({ path: path.join(home, 'memory-editor.png') })
    await compact.getByRole('tab', { name: '配置', exact: true }).click()
    // 基本信息并进头部:头像点开即换(立即保存),名称 / 简介原地编辑、与工作指令同走一个保存栏;配置页不再单列「基本信息」。
    assert.equal(await compact.getByText('基本信息', { exact: true }).count(), 0)
    const heroPortrait = compact.locator('.agent-character-hero .agent-portrait')
    await compact.getByLabel('更换头像', { exact: true }).setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') })
    await win.waitForTimeout(200)
    assert.equal(avatarWrites, 1)
    assert.equal(await heroPortrait.locator('img').count(), 1)
    await compact.locator('.agent-portrait-slot').hover()
    await win.waitForTimeout(220)
    await compact.locator('.agent-character-hero').screenshot({ path: path.join(home, 'hero-hover.png') })
    await compact.getByRole('button', { name: '移除头像', exact: true }).click()
    await win.waitForTimeout(200)
    assert.equal(avatarDeletes, 1)
    assert.equal(await heroPortrait.locator('img').count(), 0)
    await compact.getByLabel('名称', { exact: true }).fill('Research Lead')
    await compact.getByLabel('简介', { exact: true }).fill('Finds and checks primary evidence.')
    await win.waitForTimeout(220)
    await compact.locator('.agent-character-hero').screenshot({ path: path.join(home, 'hero-edit.png') })
    await compact.getByLabel('工作指令', { exact: true }).fill('# Instructions\n\nKeep source citations.')
    await compact.locator('.profile-text-editor').first().getByRole('button', { name: '阅读预览', exact: true }).click()
    await compact.locator('.profile-text-preview h1').getByText('Instructions', { exact: true }).waitFor()
    await compact.getByRole('button', { name: '保存配置', exact: true }).click()
    await win.waitForTimeout(200)
    assert.equal(saved.systemPrompt, '# Instructions\n\nKeep source citations.')
    assert.equal(saved.name, 'Research Lead')
    assert.equal(saved.description, 'Finds and checks primary evidence.')
    assert.equal(await compact.getByLabel('名称', { exact: true }).inputValue(), 'Research Lead')
    await win.waitForTimeout(220)
    await win.screenshot({ path: path.join(home, 'instructions-preview.png') })
    await compact.getByRole('tab', { name: '配置', exact: true }).press('Home')
    assert.equal(await compact.getByRole('tab', { name: '配置', exact: true }).getAttribute('aria-selected'), 'true')
    assert.equal(await compact.getByText('能力装备', { exact: true }).count(), 0)
    // 「能力装备」整块(跳技能 / MCP / 记忆的三张卡)与上方标签重复,已并掉:配置页正文里不该再有这类跳转卡。
    // 只量当前标签的正文(.profile-section-enter):记忆面板保持挂载(hidden)也在 .agent-profile-content 里,会误数。
    assert.equal(await compact.locator('.profile-section-enter button').filter({ hasText: /^(技能|MCP|记忆)/ }).count(), 0, 'Config tab must not repeat the Skills / MCP / Memory tabs as cards')
    console.log('PASS searchable memory, retained drafts, Markdown preview and keyboard tab navigation')
    // 进化是一级标签(原来藏在 记忆 → 资料库弹窗 → 第 4 个 tab):条目、芯片、时间线、撤销 / 恢复、就地发 /refine。
    const growthTab = compact.getByRole('tab', { name: '成长', exact: true })
    assert.equal(await growthTab.locator('.profile-tab-badge').textContent(), '1', 'The Growth tab carries the count of candidates awaiting reflection before it is opened')
    await growthTab.click()
    assert.equal(await segment('进化').locator('.profile-tab-badge').textContent(), '1', 'Inside Growth the badge sits on the Evolution layer')
    await segment('进化').click()
    const evolution = compact.locator('[data-agent-harness="research"]')
    await evolution.locator('[data-harness-entry="h-cite"]').waitFor()
    await evolution.locator('[data-harness-candidates="1"]').waitFor()
    // 日期由渲染器的 Intl 排版(Node 与 Chromium 的 ICU 未必同款,不拿 Node 算期望串):只钉「有 17 号、正文原样、没有内部记号」。
    const candidateText = await evolution.locator('.harness-candidate').textContent()
    assert.ok(/17/.test(candidateText) && candidateText.endsWith('Check the marker file before answering') && !/2026|s:abcd/.test(candidateText), `A candidate shows its date and text only: ${candidateText}`)
    assert.equal(await evolution.locator('.harness-kind').first().textContent(), '做法', 'Kinds render as localized chips, not raw ids')
    assert.equal(await evolution.getByText(/Invalid Date|T\d\d:\d\d/).count(), 0, 'Dates are localized; a hand-edited date falls back to its raw text')
    assert.equal(await evolution.locator('[data-harness-entry="h-scope"] .harness-meta').textContent(), 'v1 · last week')
    assert.ok((await evolution.textContent()).includes('写入要经审批'), 'The panel itself explains that working notes need approval')
    assert.equal(await compact.locator('.agent-profile-save').evaluate((el) => getComputedStyle(el).display), 'none', 'Growth has its own save paths: the empty save dock takes no space')
    win.once('dialog', (d) => d.accept())
    await evolution.getByRole('button', { name: '恢复', exact: true }).click()
    await win.waitForTimeout(200)
    assert.deepEqual(harnessRollbacks, ['h-old'])
    const readsBeforeRefine = harnessReads
    await evolution.getByRole('button', { name: '复盘本次对话', exact: true }).click()
    await evolution.getByText('已开始复盘，进度在对话里。', { exact: true }).waitFor()
    assert.equal(stub.seen.runs.at(-1)?.message, '/refine')
    assert.equal(stub.seen.runs.at(-1)?.sessionId, solo.id)
    await win.waitForTimeout(600)
    // 面板按 running 的两个沿各重读一次(起 run 一次、结束一次);只多一次 = 只在起跑时读,/refine 写完的笔记永远看不到。
    assert.ok(harnessReads >= readsBeforeRefine + 2, `Working notes reload both when the refine run starts and when it settles (reads ${readsBeforeRefine} → ${harnessReads})`)
    assert.equal(await compact.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false)
    await win.waitForTimeout(220)
    await win.locator('[data-tangu-details]').screenshot({ path: path.join(home, 'compact-evolution.png') })
    console.log('PASS evolution tab: localized notes, restore, in-place /refine and reload after the run')
    // 提名提醒:活动流第 3 次轮询才出现那条 harness_candidates → 弹一张卡(带会话名);点「复盘」发 /refine 到该会话;同一条不再弹第二张。
    assert.ok(historianPolls.solo >= 1, `HistorianStatus already polled this session before the nomination lands (polls=${historianPolls.solo})`)
    nominate = true
    const nudge = win.locator('.ntf').filter({ hasText: '「Research notes」有新的工作笔记候选' })
    await nudge.waitFor({ timeout: 20000 })
    const runsBeforeNudge = stub.seen.runs.length
    harnessEmpty = true // 这次 /refine 起止会让面板重读:模拟「笔记为空、收件箱有提名」的首次状态
    await nudge.locator('.ntf-action').click()
    await win.waitForTimeout(400)
    assert.equal(stub.seen.runs.length, runsBeforeNudge + 1, 'Clicking the nudge action starts exactly one run')
    assert.equal(stub.seen.runs.at(-1)?.message, '/refine')
    assert.equal(stub.seen.runs.at(-1)?.sessionId, solo.id)
    await evolution.locator('.harness-empty').waitFor()
    assert.equal(await evolution.locator('[data-harness-candidates="1"]').count(), 1, 'The candidates section is still shown when there are no working notes yet')
    await win.waitForTimeout(5500) // 再过两轮轮询:点过动作的卡已关掉,同一条提名(同 id)不许再弹出来
    assert.equal(await win.locator('.ntf').filter({ hasText: '有新的工作笔记候选' }).count(), 0, 'The same nomination never comes back after the action dismissed it')
    console.log('PASS nomination nudge: fires only for nominations that appear after the first poll, sends /refine to the session, no duplicates')
    // 日程标签:这个 Agent 自己的 SCHEDULE.db 条目 + 会叫醒它的自动化规则(与 Calendar / 自动化 Space 同一份数据,按 Agent 收拢)。
    await compact.getByRole('tab', { name: '日程', exact: true }).click()
    const schedule = compact.locator('[data-agent-schedule="research"]')
    const daily = schedule.locator('[data-schedule-entry="sch-daily"]')
    await daily.waitFor()
    // 每天一次、锚点在年初:显示的必须是滚到未来 24h 之内的「下一次」,不是锚点那天。
    // 不钉具体钟点:引擎的 'd' 是固定 24h(agentSchedule.ts 头注),跨夏令时地区本地钟点会漂 1h —— 本机在 BST 上实测显示 10:00,那是对的。
    const shown = (await daily.locator('time').textContent()).match(/^(\d+)\/(\d+) (\d\d):(\d\d)$/)
    assert.ok(shown, 'The next occurrence renders as M/D HH:mm')
    const nextAt = new Date(new Date().getFullYear(), Number(shown[1]) - 1, Number(shown[2]), Number(shown[3]), Number(shown[4])).getTime()
    assert.ok(nextAt > Date.now() - 60_000 && nextAt <= Date.now() + 24 * 3600_000 + 60_000, `A repeating entry shows its next occurrence, not its anchor date (${shown[0]})`)
    assert.equal(await daily.locator('.harness-kind').textContent(), '自动执行')
    assert.ok((await daily.textContent()).includes('上次执行'), 'The last unattended run is shown')
    assert.equal(await schedule.locator('.schedule-past').evaluate((el) => el.open), false, 'Past one-off entries are tucked into a collapsed group')
    assert.equal(await schedule.locator('.schedule-past [data-schedule-entry="sch-old"]').count(), 1)
    assert.equal(await schedule.locator('[data-schedule-rule="tr-mine"]').count(), 1, 'A rule whose action chain runs this agent is listed')
    assert.equal(await schedule.locator('[data-schedule-rule="tr-other"]').count(), 0, "Another agent's rule is not")
    assert.equal(await compact.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false)
    await win.waitForTimeout(220)
    await win.locator('[data-tangu-details]').screenshot({ path: path.join(home, 'compact-schedule.png') })
    console.log('PASS schedule tab: next occurrence, auto chip, collapsed past entries, only the rules that wake this agent')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 720))
    await compact.getByRole('tab', { name: '技能', exact: true }).click()
    await compact.getByRole('button', { name: '全部停用', exact: true }).click()
    const dock = await compact.evaluate((el) => {
      const footer = el.querySelector('.agent-profile-save').getBoundingClientRect()
      return { bottom: footer.bottom, viewport: innerHeight, content: el.querySelector('.agent-profile-content').clientHeight, overflow: el.scrollWidth > el.clientWidth + 1 }
    })
    assert.ok(dock.bottom <= dock.viewport && dock.content > 100 && !dock.overflow)
    await win.waitForTimeout(220)
    await win.screenshot({ path: path.join(home, 'compact-skills-unsaved.png') })
    await compact.getByRole('button', { name: '放弃修改', exact: true }).click()
    await win.emulateMedia({ reducedMotion: 'reduce' })
    await compact.getByRole('tab', { name: '配置', exact: true }).click()
    assert.equal(await compact.locator('.profile-section-enter').evaluate((el) => getComputedStyle(el).animationName), 'none')
    assert.equal(await compact.locator('.agent-section-nav').evaluate((el) => getComputedStyle(el, '::before').transitionProperty), 'none')
    await win.emulateMedia({ reducedMotion: 'no-preference' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))

    // Ribbon exposes the new Space directly.
    const agentsButton = win.locator('[data-ribbon-id="space:agents"], [data-id="space:agents"], button[title="Agents"]').first()
    if (await agentsButton.count()) await agentsButton.click()
    else await win.getByRole('button', { name: 'Agents', exact: true }).first().click()
    await win.locator('[data-agents-space]').waitFor()
    await win.locator('.agents-roster-item').filter({ hasText: 'Research' }).click()
    const profile = win.locator('[data-agent-profile="research"]')
    await profile.locator('.agent-section-nav button').filter({ hasText: '技能' }).click()
    assert.equal(await profile.getByLabel('Writing', { exact: false }).isChecked(), false)
    await profile.getByLabel('Writing', { exact: false }).check()
    await profile.getByLabel('Writing', { exact: false }).uncheck()
    await profile.getByRole('button', { name: '保存配置', exact: true }).click()
    await win.waitForTimeout(300)
    assert.deepEqual(saved.enabledSkillIds, ['local:research', 'local:git-workflow', 'local:web-research'], 'Unchecking one skill keeps the rest, including the collapsed built-in ones')
    await profile.locator('.agent-section-nav button').filter({ hasText: 'MCP' }).click()
    await profile.getByLabel('documents', { exact: false }).uncheck()
    await profile.getByRole('button', { name: '保存配置', exact: true }).click()
    await win.waitForTimeout(300)
    assert.deepEqual(saved.enabledMcpServers, [])
    await profile.locator('.agent-section-nav button').filter({ hasText: '配置' }).click()
    await win.waitForTimeout(220)
    await win.screenshot({ path: path.join(home, 'agents-light.png') })
    await win.evaluate(() => { document.documentElement.setAttribute('data-mode', 'dark'); document.documentElement.classList.add('dark') })
    await win.waitForTimeout(220)
    await win.screenshot({ path: path.join(home, 'agents-dark.png') })
    // 观感自查用(DESIGN.md §8):宽版 × 暗色下的技能 / 成长 / 日程各一张。
    for (const [tab, shot] of [['技能', 'agents-dark-skills.png'], ['成长', 'agents-dark-growth.png'], ['日程', 'agents-dark-schedule.png']]) {
      await profile.getByRole('tab', { name: tab, exact: true }).click()
      await win.waitForTimeout(260)
      await win.screenshot({ path: path.join(home, shot) })
      assert.equal(await profile.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false, `${tab} must not overflow the full-width profile`)
    }
    await profile.getByRole('tab', { name: '配置', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 900))
    await win.waitForTimeout(250)
    await win.waitForTimeout(220)
    await win.screenshot({ path: path.join(home, 'agents-narrow.png') })
    assert.equal(await profile.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false)
    await win.evaluate(() => { localStorage.setItem('tangu_locale', 'en'); localStorage.setItem('forsion_default_space', 'agents') })
    await win.reload()
    await win.locator('[data-agents-space]').waitFor()
    await win.locator('.agents-roster-item').filter({ hasText: 'Research' }).click()
    await profile.getByRole('tab', { name: 'Settings', exact: true }).click()
    await profile.getByRole('textbox', { name: 'Instructions', exact: true }).waitFor()
    assert.equal(await profile.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false)
    await win.waitForTimeout(220)
    await win.screenshot({ path: path.join(home, 'agents-english-config.png') })
    // 英文文案更长:窄栏宽度下三个新页面都不许横向溢出(标签名、分段卡说明、日程芯片)。
    for (const [tab, shot] of [['Skills', 'agents-english-skills.png'], ['Growth', 'agents-english-growth.png'], ['Schedule', 'agents-english-schedule.png']]) {
      await profile.getByRole('tab', { name: tab, exact: true }).click()
      await win.waitForTimeout(260)
      await win.screenshot({ path: path.join(home, shot) })
      assert.equal(await profile.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false, `${tab} must not overflow in English`)
    }
    assert.deepEqual(errors, [])
    console.log('PASS Agent skill and MCP loadout save; screenshots:', home)
  } catch (e) { console.error('Artifacts:', home); try { await (await app?.firstWindow())?.screenshot({ path: path.join(home, 'failure.png') }) } catch {} throw e } finally { await app?.close(); await stub.close() }
}
run().catch(async (e) => { console.error(e); try { const w = (await app?.windows())?.[0]; if (w) await w.screenshot({ path: path.join(home, 'failure.png') }) } catch {} process.exitCode = 1 })
