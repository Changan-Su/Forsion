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
const teamAvatarPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const models = [{ id: 'm1', name: 'Stub Base', provider: 'stub', contextWindow: 128_000 }, { id: 'm2', name: 'Stub Sonnet', provider: 'stub', contextWindow: 200_000 }, { id: 'm3', name: 'Stub Opus', provider: 'stub', contextWindow: 200_000 }]
const base = { archived: false, model_id: 'm1', created_at: '2026-09-16 10:00:00', updated_at: '2026-09-16 10:00:00' }
const savedSession = { ...base, id: 'saved-party', title: 'Atlas work', projectless: true, project_path: null, project_name: null, agent_config: { teamSlug: team.slug, groupChat: true, groupAgents: ['xyra', 'research'], execMode: 'host', cwd: team.libraryDir, approvalMode: 'readonly', enabledMcpServers: [] } }
const projectSession = { ...base, id: 'project-party', title: 'Project party', projectless: false, project_path: home, project_name: 'Atlas project', agent_config: { groupChat: true, groupAgents: ['xyra', 'research'], execMode: 'host', cwd: home, extraRoots: ['/tmp/evidence'] } }
const sessions = [savedSession, projectSession]
let app, failLoad = true, failPut = false, teamWrites = 0, agentWrites = 0, teamAvatarWrites = 0, lastTeamPatch = null
async function run() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) throw new Error('Run npm run build first')
  const stub = await startStubEngine({ agents, sessions, models, override: async ({ path: p, method, body }) => {
    if (p === '/agent/runs' && method === 'GET') return { runs: [] }
    if (p === '/agent/teams') return { teams: [team] }
    if (p === '/agent/teams/atlas/session/open') return { session: savedSession, created: false }
    if (p === '/agent/teams/atlas/avatar') {
      if (method === 'GET') return team.avatar === 'avatar.png' ? { __buffer: teamAvatarPng, contentType: 'image/png' } : { __code: 404, body: { detail: 'no avatar' } }
      if (method === 'POST') { teamAvatarWrites++; team.avatar = 'avatar.png'; return { ok: true, avatar: team.avatar } }
      if (method === 'DELETE') { team.avatar = ''; return { ok: true } }
    }
    if (p === '/agent/teams/atlas') {
      if (method === 'GET') return failLoad ? { __code: 503, body: { detail: 'Team load failed (fixture)' } } : { team }
      if (method === 'PATCH') { teamWrites++; lastTeamPatch = await body(); team = { ...team, ...lastTeamPatch }; return { team } }
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
    // 会话级调档(模型 / Effort):改的是本会话,Agent 定义与 TEAM 定义都不许跟着动。
    const researchCard = party.locator('[data-team-member="research"]')
    await researchCard.getByRole('button', { name: 'Research 本会话模型', exact: true }).click()
    await researchCard.locator('.composer-menu .menu-item').filter({ hasText: 'Stub Sonnet' }).click()
    await researchCard.getByLabel('Research 本会话 Effort', { exact: true }).selectOption('high')
    await party.getByRole('button', { name: '添加成员', exact: true }).click()
    await party.locator('.team-candidates button').filter({ hasText: 'Writer' }).click()
    await party.locator('[data-team-member="writer"]').getByRole('button', { name: '向前调整位置', exact: true }).click()
    // 基本信息在头部原地编辑:名称 / 简介直接改,Emoji 从头像右上角「设置 Emoji」进入;「TEAM 配置」页只剩 TEAM.md。
    const hero = party.locator('.team-profile-hero')
    await hero.getByLabel('团队名称', { exact: true }).fill('Atlas Expedition')
    await hero.getByLabel('简介', { exact: true }).fill('Explore, verify and deliver with evidence.')
    await hero.getByRole('button', { name: '设置 Emoji', exact: true }).click()
    await hero.getByLabel('Emoji 标识', { exact: true }).fill('🚀')
    await hero.getByLabel('Emoji 标识', { exact: true }).press('Enter')
    assert.equal((await hero.locator('.team-profile-emblem').textContent()).trim(), '🚀')
    await win.waitForTimeout(220)
    await hero.screenshot({ path: path.join(home, 'team-hero-edit.png') })
    await party.getByRole('button', { name: 'TEAM 配置', exact: true }).click()
    assert.equal(await party.getByText('基本信息', { exact: true }).count(), 0)
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
    assert.equal(team.description, 'Explore, verify and deliver with evidence.')
    assert.equal(team.avatar, '🚀')
    assert.deepEqual(savedSession.agent_config.groupAgents, ['xyra', 'research'])
    failPut = false
    await party.getByRole('button', { name: '保存团队', exact: true }).click()
    await party.getByRole('status').filter({ hasText: '已保存' }).waitFor()
    assert.deepEqual(savedSession.agent_config.groupAgents, ['xyra', 'writer', 'research'])
    assert.deepEqual(savedSession.agent_config.teamMemberConfigs, { research: { model: 'm2', thinkingLevel: 'high' } })
    // 负对照:调档只进会话配置 —— TEAM 定义的 PATCH 体里不许出现它,别的成员也不许凭空长出一条空调档。
    assert.equal('teamMemberConfigs' in lastTeamPatch, false)
    assert.equal(team.teamMemberConfigs, undefined)
    assert.equal(agents.find((a) => a.slug === 'research').model, '')
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
    // 调档从会话配置读回来;没调过的成员显示「沿用」而不是某个具体模型。
    const researchTuning = party.locator('[data-team-member="research"]')
    assert.equal(await researchTuning.getByLabel('Research 本会话 Effort', { exact: true }).inputValue(), 'high')
    assert.match(await researchTuning.getByRole('button', { name: 'Research 本会话模型', exact: true }).textContent(), /Stub Sonnet/)
    assert.match(await party.locator('[data-team-member="xyra"]').getByRole('button', { name: 'Xyra 本会话模型', exact: true }).textContent(), /默认模型/)
    const tuningBox = async (sel) => party.locator(`[data-team-member="xyra"] ${sel}`).boundingBox()
    const [modelBox, effortBox] = [await tuningBox('.model-select-btn'), await tuningBox('.team-member-effort')]
    assert.ok(modelBox.width >= 96, `模型格被挤窄到 ${modelBox.width}px(详情面板窄,三格一行会把它压成一个图标)`)
    assert.equal(Math.abs(modelBox.y - effortBox.y) < 2, true, '模型与 Effort 必须同排')
    await win.waitForTimeout(220)
    await win.screenshot({ path: path.join(home, 'party-light.png') })
    await party.locator('[data-team-member="xyra"]').getByRole('button', { name: 'Xyra 本会话模型', exact: true }).click()
    await party.locator('[data-team-member="xyra"] .composer-menu').waitFor()
    await win.waitForTimeout(160)
    await party.locator('.team-lineup').screenshot({ path: path.join(home, 'party-tuning-open.png') })
    await win.keyboard.press('Escape')
    await win.getByTitle('切换明暗模式', { exact: true }).click()
    await win.waitForFunction(() => document.documentElement.getAttribute('data-mode') === 'dark')
    await win.waitForTimeout(400)
    await win.waitForTimeout(220)
    await win.screenshot({ path: path.join(home, 'party-dark.png') })
    assert.equal((await party.locator('.team-profile-hero .team-profile-emblem').textContent()).trim(), '🚀')
    await party.getByRole('button', { name: 'TEAM 配置', exact: true }).click()
    assert.equal(await party.getByLabel('团队指令 · TEAM', { exact: true }).inputValue(), team.doc)
    await party.getByLabel('上传图片', { exact: true }).setInputFiles({ name: 'team.png', mimeType: 'image/png', buffer: teamAvatarPng })
    await win.waitForTimeout(250)
    assert.equal(teamAvatarWrites, 1)
    assert.equal(team.avatar, 'avatar.png')
    await party.locator('.team-profile-hero .team-profile-emblem img').waitFor()
    // 侧栏团队行与详情页共用 store.teamAvatars:上传后当场换图,且绝不能把文件名 avatar.png 当 emoji 画出来。
    const teamRow = win.locator('.t2o-row').filter({ hasText: 'Atlas Expedition' }).first()
    const rowShowsImage = async () => {
      await teamRow.locator('.t2o-avstack > img').waitFor()
      assert.ok(!(await teamRow.textContent()).includes('avatar.png'), 'Team row must not render the avatar filename as an emoji')
    }
    await rowShowsImage()
    await win.waitForTimeout(220)
    await win.screenshot({ path: path.join(home, 'team-settings.png') })
    await win.reload()
    await teamRow.click()
    await party.locator('.team-profile-emblem img').waitFor()
    await rowShowsImage()
    await teamRow.screenshot({ path: path.join(home, 'team-row-image.png') })
    await party.getByRole('button', { name: '移除图片', exact: true }).click()
    await party.getByText('团队头像已移除', { exact: true }).waitFor()
    assert.equal(team.avatar, '')
    assert.equal(await teamRow.locator('.t2o-avstack > img').count(), 0)
    assert.equal(await party.locator('.team-profile-emblem img').count(), 0)
    console.log('PASS saved TEAM survives UI reload with its charter, roles, roster and custom image avatar (profile + sidebar row, upload + remove)')

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
    await party.locator('[data-team-member="xyra"]').getByRole('button', { name: 'Xyra 本会话模型', exact: true }).click()
    await party.locator('[data-team-member="xyra"] .composer-menu .menu-item').filter({ hasText: 'Stub Opus' }).click()
    // 临时成员的模型 / Effort 就住在它自己的定义里:卡上这两个控件必须写 groupTempAgents,不许再往调档表里存第二份。
    await party.getByLabel('Fact checker 本会话 Effort', { exact: true }).selectOption('low')
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
    assert.deepEqual(projectSession.agent_config.teamMemberConfigs, { xyra: { model: 'm3' } })
    assert.equal(projectSession.agent_config.groupTempAgents[0].thinkingLevel, 'low')
    assert.deepEqual(projectSession.agent_config.extraRoots, ['/tmp/evidence'])
    assert.equal(projectSession.agent_config.teamSlug, undefined)
    assert.equal(projectSession.project_path, home)
    await party.getByRole('button', { name: '配队', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 900))
    await win.waitForTimeout(250)
    assert.equal(await panel.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false)
    const narrowModel = await party.locator('[data-team-member="xyra"] .model-select-btn').boundingBox()
    assert.ok(narrowModel.width >= 96, `窄窗下模型格只剩 ${narrowModel.width}px —— Effort 该换行让位`)
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
    assert.deepEqual(sent?.agentConfig.teamMemberConfigs, { xyra: { model: 'm3' } })
    assert.equal(sent?.agentConfig.groupTempAgents[0].thinkingLevel, 'low')
    assert.deepEqual(errors, [])
    console.log('PASS project-only team charter and temporary member configuration persist and reach the next run without touching saved TEAM or Agent defaults')
    console.log('Screenshots:', home)
  } catch (e) { try { const win = await app?.firstWindow(); await win?.screenshot({ path: path.join(home, 'failure.png') }); fs.writeFileSync(path.join(home, 'failure.html'), await win.locator('[data-tangu-details]').innerHTML()); fs.writeFileSync(path.join(home, 'failure-aria.txt'), await win.locator('[data-tangu-details]').ariaSnapshot()) } catch {} console.error('Artifacts:', home); throw e }
  finally { await app?.close(); await stub.close() }
}
run().catch((e) => { console.error(e); process.exitCode = 1 })
