/** Party configuration in the real Electron shell; isolated home and a stateful API fixture. */
const { _electron: electron } = require('playwright-core')
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert/strict')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.join(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-team-profile-'))
const agents = ['xyra', 'research', 'writer'].map((slug) => ({ slug, name: { xyra: 'Xyra', research: 'Research', writer: 'Writer' }[slug], description: { xyra: 'Project coordination', research: 'Evidence and analysis', writer: 'Clear, considered writing' }[slug], tools: [], model: '', thinkingLevel: '', maxIterations: null, approvalMode: '', systemPrompt: 'Be precise.', soul: '', createdBy: 'user', libraryDir: path.join(home, slug, 'Library') }))
let team = { slug: 'atlas', name: 'Atlas Crew', description: 'Explore, verify and deliver.', avatar: '🧭', lead: 'xyra', members: [{ slug: 'xyra', role: '协调与规划' }, { slug: 'research', role: '证据与分析' }], doc: 'Cite primary evidence.', createdAt: '', libraryDir: path.join(home, 'team-library') }
const base = { archived: false, model_id: 'm1', created_at: '2026-09-16 10:00:00', updated_at: '2026-09-16 10:00:00' }
const savedSession = { ...base, id: 'saved-party', title: 'Atlas work', projectless: true, project_path: null, project_name: null, agent_config: { teamSlug: team.slug, groupChat: true, groupAgents: ['xyra', 'research'], execMode: 'host', cwd: team.libraryDir, approvalMode: 'readonly', enabledMcpServers: [] } }
const projectSession = { ...base, id: 'project-party', title: 'Project party', projectless: false, project_path: home, project_name: 'Atlas project', agent_config: { groupChat: true, groupAgents: ['xyra', 'research'], execMode: 'host', cwd: home, extraRoots: ['/tmp/evidence'] } }
const sessions = [savedSession, projectSession]
let app, failLoad = true, failPut = false, teamWrites = 0, agentWrites = 0
async function run() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) throw new Error('Run npm run build first')
  const stub = await startStubEngine({ agents, sessions, override: async ({ path: p, method, body }) => {
    if (p === '/agent/runs' && method === 'GET') return { runs: [] }
    if (p === '/agent/teams') return { teams: [team] }
    if (p === '/agent/teams/atlas/session/open') return { session: savedSession, created: false }
    if (p === '/agent/teams/atlas') {
      if (method === 'GET') return failLoad ? { __code: 503, body: { detail: 'Team load failed (fixture)' } } : { team }
      if (method === 'PATCH') { teamWrites++; team = { ...team, ...await body() }; return { team } }
    }
    if (p.endsWith('/background')) return { background: [] }
    if (p === '/agent/skills') return { skills: [{ id: 'local:research', name: 'Research notebook', description: 'Gather evidence' }, { id: 'local:writing', name: 'Writing', description: 'Write clear reports' }] }
    if (p === '/agent/tools') return { builtins: [], custom: [], mcp: [] }
    if (p.startsWith('/agent/agents/') && method === 'PATCH') { agentWrites++; const slug = p.split('/')[3]; const i = agents.findIndex((a) => a.slug === slug); agents[i] = { ...agents[i], ...await body() }; return { agent: agents[i] } }
    if (p.startsWith('/agent/sessions/')) {
      const session = sessions.find((s) => s.id === p.split('/')[3])
      if (session && p.endsWith('/config')) {
        if (method === 'PUT') {
          if (failPut) return { __code: 503, body: { detail: 'Session save failed (fixture)' } }
          session.agent_config = await body()
        }
        return { agent_config: session.agent_config }
      }
      if (session && method === 'PATCH') { Object.assign(session, await body()); return { session } }
    }
  } })
  try {
    const ud = path.join(home, 'userData')
    for (const dir of [ud, `${ud}-dev`]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' })) }
    app = await electron.launch({ args: [`--user-data-dir=${ud}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
    const win = await app.firstWindow(), errors = []
    win.on('pageerror', (e) => errors.push(String(e)))
    win.setDefaultTimeout(15000)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1050))
    await win.waitForSelector('#root')
    await win.waitForTimeout(2000)
    for (const label of ['跳过引导', 'Skip']) { const b = win.getByText(label, { exact: true }); if (await b.count()) { await b.first().click(); break } }
    await win.waitForSelector('.dv-groupview')
    await win.evaluate(() => localStorage.setItem('forsion_default_space', 'tangu'))
    await win.reload()
    await win.locator('.t2o-row').filter({ hasText: 'Atlas Crew' }).first().click()
    if (!await win.locator('[data-tangu-details]').isVisible()) await win.locator('.dv-edge-right').click()
    const panel = win.locator('[data-tangu-details]'), party = panel.locator('[data-team-profile]')
    await party.getByRole('alert').filter({ hasText: 'Team load failed' }).waitFor()
    assert.equal(await party.locator('.team-lineup').count(), 0)
    failLoad = false
    await party.getByRole('button', { name: '重新加载', exact: true }).click()
    await party.locator('[data-team-member="research"]').waitFor()
    console.log('PASS failed TEAM load cannot expose an empty writable editor; retry restores the party')

    await party.locator('[data-team-member="research"]').getByRole('button', { name: '移出阵容', exact: true }).click()
    assert.equal(await party.getByRole('button', { name: '保存团队', exact: true }).isDisabled(), true)
    await party.getByRole('button', { name: '放弃修改', exact: true }).click()
    await party.getByLabel('Research 职责', { exact: true }).fill('事实核查与交叉验证')
    await party.getByRole('button', { name: '添加成员', exact: true }).click()
    await party.locator('.team-candidates button').filter({ hasText: 'Writer' }).click()
    await party.locator('[data-team-member="writer"]').getByRole('button', { name: '向前调整位置', exact: true }).click()
    await party.getByRole('button', { name: 'TEAM 配置', exact: true }).click()
    await party.getByLabel('团队名称', { exact: true }).fill('Atlas Expedition')
    await party.getByLabel('团队指令 · TEAM', { exact: true }).fill('Verify primary sources and deliver an evidence-based report.')
    await party.getByRole('button', { name: '配队', exact: true }).click()
    await party.getByRole('button', { name: '查看成员 Research', exact: true }).click()
    const detail = party.locator('[data-team-member-detail="research"]'), profile = detail.locator('[data-agent-profile="research"]')
    await profile.waitFor()
    assert.equal(await win.locator('[data-chat-surface="chat"]').getAttribute('data-session-id'), savedSession.id)
    assert.equal(await win.locator('[data-agents-space]').count(), 0)
    await profile.locator('.agent-section-nav button').filter({ hasText: '技能' }).click()
    await profile.getByLabel('Writing', { exact: false }).uncheck()
    await party.getByRole('button', { name: '返回配队', exact: true }).click()
    assert.equal(await party.getByLabel('Research 职责', { exact: true }).inputValue(), '事实核查与交叉验证')
    await party.getByRole('button', { name: '查看成员 Research', exact: true }).click()
    assert.equal(await profile.getByLabel('Writing', { exact: false }).isChecked(), false)
    await profile.getByRole('button', { name: '保存配置', exact: true }).click()
    await profile.getByRole('status').waitFor()
    assert.equal(agentWrites, 1)
    assert.deepEqual(agents.find((a) => a.slug === 'research').enabledSkillIds, ['local:research'])
    await win.waitForTimeout(220)
    await win.screenshot({ path: path.join(home, 'member-config.png') })
    await party.getByRole('button', { name: '返回配队', exact: true }).click()
    failPut = true
    await party.getByRole('button', { name: '保存团队', exact: true }).click()
    await party.getByRole('alert').filter({ hasText: 'TEAM 已保存' }).waitFor()
    assert.equal(team.name, 'Atlas Expedition')
    assert.deepEqual(savedSession.agent_config.groupAgents, ['xyra', 'research'])
    failPut = false
    await party.getByRole('button', { name: '保存团队', exact: true }).click()
    await party.getByRole('status').filter({ hasText: '已保存' }).waitFor()
    assert.deepEqual(savedSession.agent_config.groupAgents, ['xyra', 'writer', 'research'])
    assert.equal(savedSession.agent_config.teamSlug, 'atlas')
    assert.equal(savedSession.agent_config.approvalMode, 'readonly')
    assert.deepEqual(savedSession.agent_config.enabledMcpServers, [])
    assert.equal(team.members.find((m) => m.slug === 'research').role, '事实核查与交叉验证')
    assert.equal(team.doc, 'Verify primary sources and deliver an evidence-based report.')
    console.log('PASS lineup validation, add/reorder, member drill-down, retained drafts, actual Agent save, partial failure and retry')

    await win.reload()
    await win.locator('.t2o-row').filter({ hasText: 'Atlas Expedition' }).first().click()
    await party.locator('[data-team-member="writer"]').waitFor()
    assert.deepEqual(await party.locator('[data-team-member]').evaluateAll((els) => els.map((e) => e.dataset.teamMember)), ['xyra', 'writer', 'research'])
    await win.waitForTimeout(220)
    await win.screenshot({ path: path.join(home, 'party-light.png') })
    await win.getByTitle('切换明暗模式', { exact: true }).click()
    await win.waitForFunction(() => document.documentElement.getAttribute('data-mode') === 'dark')
    await win.waitForTimeout(400)
    await win.waitForTimeout(220)
    await win.screenshot({ path: path.join(home, 'party-dark.png') })
    await party.getByRole('button', { name: 'TEAM 配置', exact: true }).click()
    assert.equal(await party.getByLabel('团队指令 · TEAM', { exact: true }).inputValue(), team.doc)
    await win.waitForTimeout(220)
    await win.screenshot({ path: path.join(home, 'team-settings.png') })
    console.log('PASS saved TEAM survives UI reload with its charter, roles and roster')

    await win.locator('.t2s-srow').filter({ hasText: 'Project party' }).first().click()
    await party.locator('[data-team-member="research"]').waitFor()
    const savedTeamWrites = teamWrites
    await party.getByRole('button', { name: '添加成员', exact: true }).click()
    await party.getByRole('button', { name: '新建临时成员', exact: true }).click()
    const temp = party.locator('.team-temp-member')
    await temp.getByLabel('名称', { exact: true }).fill('Fact checker')
    await temp.getByLabel('工作指令', { exact: true }).fill('Cross-check claims against the cited sources.')
    await temp.getByRole('button', { name: '返回配队并检查修改', exact: true }).click()
    await party.getByLabel('Fact checker 职责', { exact: true }).fill('核查')
    await party.getByRole('button', { name: 'TEAM 配置', exact: true }).click()
    await party.getByLabel('团队名称', { exact: true }).fill('Project expedition')
    await party.getByLabel('团队指令 · TEAM', { exact: true }).fill('Work only on this project.')
    await party.getByRole('button', { name: '保存团队', exact: true }).click()
    await party.getByRole('status').filter({ hasText: '已保存' }).waitFor()
    assert.equal(teamWrites, savedTeamWrites)
    assert.equal(projectSession.title, 'Project expedition')
    assert.equal(projectSession.agent_config.teamDoc, 'Work only on this project.')
    assert.equal(projectSession.agent_config.groupTempAgents[0].name, 'Fact checker')
    assert.equal(projectSession.agent_config.teamRoles[projectSession.agent_config.groupTempAgents[0].slug], '核查')
    assert.deepEqual(projectSession.agent_config.extraRoots, ['/tmp/evidence'])
    assert.equal(projectSession.agent_config.teamSlug, undefined)
    assert.equal(projectSession.project_path, home)
    await party.getByRole('button', { name: '配队', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 900))
    await win.waitForTimeout(250)
    assert.equal(await panel.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false)
    await win.waitForTimeout(220)
    await win.screenshot({ path: path.join(home, 'project-party-narrow.png') })
    await win.reload()
    await win.locator('.t2s-srow').filter({ hasText: 'Project expedition' }).first().click()
    await party.getByRole('button', { name: '查看成员 Fact checker', exact: true }).click()
    assert.equal(await temp.getByRole('textbox', { name: '工作指令', exact: true }).inputValue(), 'Cross-check claims against the cited sources.')
    await win.locator('[data-chat-surface="chat"] .t2c-ta').fill('Use the configured party')
    await win.locator('[data-chat-surface="chat"] .t2c-ta').press('Enter')
    await win.waitForTimeout(500)
    const sent = stub.seen.runs.at(-1)
    assert.equal(sent?.sessionId, projectSession.id)
    assert.equal(sent?.agentConfig.teamDoc, 'Work only on this project.')
    assert.equal(sent?.agentConfig.groupTempAgents[0].systemPrompt, 'Cross-check claims against the cited sources.')
    assert.equal(sent?.agentConfig.teamRoles[sent.agentConfig.groupTempAgents[0].slug], '核查')
    assert.deepEqual(errors, [])
    console.log('PASS project-only team charter and temporary member configuration persist and reach the next run without touching saved TEAM or Agent defaults')
    console.log('Screenshots:', home)
  } catch (e) { try { const win = await app?.firstWindow(); await win?.screenshot({ path: path.join(home, 'failure.png') }); fs.writeFileSync(path.join(home, 'failure.html'), await win.locator('[data-tangu-details]').innerHTML()); fs.writeFileSync(path.join(home, 'failure-aria.txt'), await win.locator('[data-tangu-details]').ariaSnapshot()) } catch {} console.error('Artifacts:', home); throw e }
  finally { await app?.close(); await stub.close() }
}
run().catch((e) => { console.error(e); process.exitCode = 1 })
