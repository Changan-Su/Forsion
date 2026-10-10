/** Real Electron against the live-harness engine and its real model receipts.
 * Invoked by live-harness --only human --human-ui via e2e:planlive -- --human.
 * Every save/undo below reaches the real API and is checked against HUMAN.md on disk. */
const fs = require('fs')
const path = require('path')
const assert = require('assert/strict')
const electron = require('./lib/launch-electron.cjs')
const ROOT = path.join(__dirname, '..')
const base = process.env.TANGU_BACKEND_URL
const token = process.env.TANGU_HUMAN_TOKEN
const sid = process.env.TANGU_HUMAN_SESSION
const slug = process.env.TANGU_HUMAN_SLUG
const home = process.env.TANGU_HUMAN_UI_HOME
async function api(route, method = 'GET', body) {
  const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const value = await r.json(); assert.ok(r.ok, `${route}: ${r.status}`); return value
}
async function run() {
  assert.ok(base && token && sid && slug && home, 'Run through live-harness --only human --human-ui, or provide its isolated fixture environment')
  fs.mkdirSync(home, { recursive: true })
  const original = await api(`/agent/agents/${slug}/human`)
  const project = await api(`/agent/project-context/human?sessionId=${sid}`)
  const agentChange = original.history.find(h => h.actor === 'agent')
  const projectChange = project.history.find(h => h.actor === 'agent')
  const ud = path.join(home, 'userData')
  for (const dir of [ud, `${ud}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: base, token }))
  }
  let app, win
  const errors = []
  const shot = async name => { await win.waitForTimeout(200); await win.screenshot({ path: path.join(home, `${name}.png`) }) }
  try {
    app = await electron.launch({ args: [`--user-data-dir=${ud}`, '--lang=zh-CN', ROOT, '-ApplePersistenceIgnoreState', 'YES'], cwd: ROOT, env: { ...process.env, TANGU_HOME: path.join(home, 'shell') } })
    win = await app.firstWindow(); win.setDefaultTimeout(20000)
    win.on('pageerror', e => errors.push(String(e)))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
    await win.waitForSelector('#root'); await win.waitForTimeout(1800)
    for (const label of ['跳过引导', 'Skip']) { const b = win.getByText(label, { exact: true }); if (await b.count()) { await b.first().click(); break } }
    await win.waitForSelector('.dv-groupview')
    await win.evaluate(() => { localStorage.setItem('forsion_default_space', 'tangu'); localStorage.setItem('tangu_locale', 'zh'); localStorage.removeItem('forsion_tangu_session_mode') })
    await win.reload()
    const row = win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Human collaboration live' }).first()
    await row.click()
    await win.locator(`[data-chat-surface="chat"][data-session-id="${sid}"]`).waitFor()
    const aCard = win.locator(`[data-human-update="${agentChange.id}"]`)
    const pCard = win.locator(`[data-human-update="${projectChange.id}"]`)
    await aCard.waitFor(); await pCard.waitFor()
    assert.equal(await win.locator('[data-human-updates]').count(), 1, 'Two scopes share one durable update card')
    assert.ok((await aCard.innerText()).includes('已生效'))
    await aCard.getByRole('button', { name: '查看说明', exact: true }).click()
    const details = win.locator('[data-tangu-details]')
    const agent = details.locator('[data-human-scope="agent"]')
    await agent.locator('.md-body').waitFor()
    assert.equal(await details.getByRole('tab', { name: '协作', exact: true }).getAttribute('aria-selected'), 'true')
    await shot('human-agent-light')
    await pCard.getByRole('button', { name: '查看说明', exact: true }).click()
    const proj = details.locator('[data-human-scope="project"]')
    await proj.locator('.md-body').waitFor()
    await details.locator('.human-inherited summary').click()
    await agent.locator('.md-body').waitFor()
    await shot('human-project-light')
    await pCard.getByRole('button', { name: '撤销本次更新', exact: true }).click()
    await pCard.getByText('本次更新已撤销', { exact: true }).waitFor()
    assert.equal(fs.readFileSync(project.path, 'utf8'), '', 'Card undo restores actual project Markdown')
    await win.reload()
    await row.click()
    await aCard.waitFor(); await pCard.getByText('本次更新已撤销', { exact: true }).waitFor()
    console.log('PASS real model receipts survive reload, Agent/project deep links, inherited scope, real disk undo')
    await aCard.getByRole('button', { name: '修改', exact: true }).click()
    const editor = agent.getByRole('textbox', { name: '编辑协作说明', exact: true })
    await editor.waitFor()
    const draft = original.content + '\n\n## 手工补充\n先展示可运行的例子。\n'
    await editor.fill(draft)
    await details.getByRole('tab', { name: '配置', exact: true }).click()
    await details.getByRole('tab', { name: '协作', exact: true }).click()
    assert.equal(await editor.inputValue(), draft, 'Draft survives tab unmount')
    // A second writer wins while the first draft remains open. UI must preserve both.
    const external = original.content + '\n\n外部新修改：请保留这行。\n'
    await api(`/agent/agents/${slug}/human`, 'PUT', { expectedVersion: original.version, content: external, summary: 'Concurrent edit fixture' })
    await agent.getByRole('button', { name: '保存', exact: true }).click()
    await agent.getByRole('alert').filter({ hasText: '你的草稿仍保留' }).waitFor()
    assert.equal(await editor.inputValue(), draft)
    assert.equal(fs.readFileSync(original.path, 'utf8'), external)
    await agent.getByRole('button', { name: '查看最新内容', exact: true }).click()
    await agent.locator('.human-latest').waitFor()
    await editor.fill(external + '\n## 手工补充\n先展示可运行的例子。\n')
    await agent.getByRole('button', { name: '已合并，使用最新版本保存', exact: true }).click()
    await editor.waitFor({ state: 'detached' })
    assert.ok(fs.readFileSync(original.path, 'utf8').includes('请保留这行'))
    assert.ok(fs.readFileSync(original.path, 'utf8').includes('先展示可运行的例子'))
    assert.equal(await aCard.getByRole('button', { name: '撤销本次更新', exact: true }).isDisabled(), true, 'Old cards cannot undo newer edits')
    await agent.getByRole('button', { name: '更多操作', exact: true }).click()
    await win.getByRole('menuitem', { name: '查看原文', exact: true }).click()
    await agent.locator('.human-source').waitFor()
    assert.ok((await agent.locator('.human-path').innerText()).includes('HUMAN.md'))
    await shot('human-source-light')
    await agent.getByRole('button', { name: '更多操作', exact: true }).click()
    await win.getByRole('menuitem', { name: '阅读视图', exact: true }).click()
    console.log('PASS real save/CAS conflict/merge, draft preservation, stale-card protection, source and history')
    // ── 旧版本写的说明(10-10):更新记录里全是没盖章的 Agent 写入 → 面板提示一句;点「让 Agent 重写」发进当前对话,真模型改完出更新卡,提示自己消失 ──
    const historyRoot = path.join(path.dirname(original.path), '..', '..', 'human-history')
    const historyFile = fs.readdirSync(historyRoot).map(d => path.join(historyRoot, d, 'history.json')).find(f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).some(r => r.scope?.kind === 'agent' && r.scope.slug === slug) } catch { return false } })
    assert.ok(historyFile, 'Agent handbook history is on disk')
    assert.ok(JSON.parse(fs.readFileSync(historyFile, 'utf8')).some(r => r.actor === 'agent' && r.rules >= 2), 'The engine stamps agent writes with the writing-rules version')
    assert.equal(await agent.locator('[data-human-legacy]').count(), 0, 'A handbook written under the current rules shows no hint')
    // 装成旧引擎留下的样子:内容里混着 Agent 自己的承诺,记录里只有没盖章的 Agent 写入(用户没手改过)。这一段用完把文档和记录放回原样 ——
    // 台架在界面验收之后还有两步(撤销后列约定、自然反馈),它们认的是这之前的那份文档。那条承诺特意不提「选方案」,免得和自然反馈那一步撞题。
    const savedDoc = fs.readFileSync(original.path, 'utf8'), savedHistory = fs.readFileSync(historyFile, 'utf8')
    const legacyDoc = '# 协作约定\n\n## 需要你做的\n\n- 给出两种方案时，你先选定方向再让我动手。\n\n## 我这边会做\n\n改完实际运行，并把验证结果贴出来。\n\n每次交结果前，我会先把改动列成三条以内的摘要。\n'
    await api(`/agent/agents/${slug}/human`, 'PUT', { expectedVersion: (await api(`/agent/agents/${slug}/human`)).version, content: legacyDoc, summary: 'Legacy fixture' })
    // 每一条都改成没盖章的 Agent 写入(刚才那次 PUT 也算):提示还要求「现在这份就是最后一条记录写成的那份」,所以最后一条不能删
    fs.writeFileSync(historyFile, JSON.stringify(JSON.parse(fs.readFileSync(historyFile, 'utf8')).map(({ rules, ...r }) => ({ ...r, actor: 'agent' }))))
    await win.evaluate(() => window.dispatchEvent(new CustomEvent('forsion:human-changed')))
    const legacyHint = agent.locator('[data-human-legacy]')
    await legacyHint.waitFor()
    assert.ok((await legacyHint.innerText()).includes('这份说明是旧版本写的'))
    await shot('human-legacy-hint')
    await agent.getByRole('button', { name: '更多操作', exact: true }).click()
    assert.equal(await win.getByRole('menuitem', { name: '让 Agent 重写', exact: true }).isDisabled(), false, 'Rewrite is available on the card-opened Agent page of a local, non-plan chat with that Agent')
    await win.keyboard.press('Escape')
    await legacyHint.getByRole('button', { name: '让 Agent 重写', exact: true }).click()
    await agent.getByText('已发到对话里', { exact: false }).waitFor()
    await win.locator(`[data-chat-surface="chat"][data-session-id="${sid}"]`).getByText('请把协作说明按现在的写法重写一遍', { exact: false }).first().waitFor()
    await legacyHint.waitFor({ state: 'detached', timeout: 240000 }) // 真模型改完:新的一条 Agent 写入带章,提示自己消失
    const rewritten = fs.readFileSync(original.path, 'utf8')
    assert.notEqual(rewritten, legacyDoc, 'The real model rewrote the handbook on disk')
    await shot('human-legacy-rewritten')
    // 按结果判,不只看「改了」(10-10 这一步曾在两边认反的情况下照样打出 PASS:用户那条被挪走,自己的两条承诺改成「请你……」留下)。
    // 这是真模型的行为,红了先看截图和这次的工具调用,别当成界面坏了。
    // 按意思认(和 tangu-agent/scripts/lib/human-real-live.mjs 的 keepsHumanChoice 同一个判法):换了说法的「你告诉我选哪一种」也算还在
    assert.ok(rewritten.split('\n').some(l => /方案|做法|选项|方向/.test(l) && /你[^。\n]{0,16}(选|倾向|定)|告诉我[^。\n]{0,10}(选|倾向)/.test(l)), `The human's own line (pick a direction first) must stay in the handbook:\n${rewritten}`)
    assert.doesNotMatch(rewritten, /实际运行|验证结果|三条以内/, `The agent's own promises must leave the handbook, in either voice:\n${rewritten}`)
    // 挪进记忆的句子在回复下面出一行回执(条目折叠在里面,数那一行)
    const memoryRows = await win.locator(`[data-chat-surface="chat"][data-session-id="${sid}"] [data-self-receipt]`).count()
    fs.writeFileSync(original.path, savedDoc); fs.writeFileSync(historyFile, savedHistory)
    await win.evaluate(() => window.dispatchEvent(new CustomEvent('forsion:human-changed')))
    await agent.getByText('先展示可运行的例子', { exact: false }).first().waitFor()
    console.log(`PASS legacy hint from history, rewrite sent to the chat, real model rewrote it, hint cleared (old promise section ${rewritten.includes('我这边会做') ? 'STILL THERE' : 'gone'}; self-update receipts in the chat: ${memoryRows})`)
    await win.evaluate(() => { document.documentElement.setAttribute('data-mode', 'dark'); document.documentElement.classList.add('dark') })
    await shot('human-agent-dark')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 900))
    await shot('human-agent-narrow')
    assert.equal(await agent.evaluate(el => el.scrollWidth > el.clientWidth + 1), false)
    await win.evaluate(() => localStorage.setItem('tangu_locale', 'en'))
    await win.reload()
    await row.click()
    await aCard.getByRole('button', { name: 'View handbook', exact: true }).click()
    await agent.locator('.md-body').waitFor()
    await shot('human-agent-english')
    assert.equal(await agent.evaluate(el => el.scrollWidth > el.clientWidth + 1), false)
    const nav = details.locator('.agent-section-nav')
    const activeTab = nav.getByRole('tab', { name: 'Collaboration', exact: true })
    await activeTab.scrollIntoViewIfNeeded()
    assert.equal(await activeTab.isVisible(), true)
    assert.ok(await nav.locator('button').evaluateAll(buttons => buttons.every(b => { const s = b.querySelector('span'); if (!s) return true; const br = b.getBoundingClientRect(), sr = s.getBoundingClientRect(); return sr.left >= br.left - 1 && sr.right <= br.right + 1 })), 'English labels remain within their own tab cells')
    assert.deepEqual(errors, [], 'No renderer errors')
    console.log('PASS light/dark/narrow/English; screenshots:', home)
  } catch (e) { if (win) await shot('failure').catch(() => {}); throw e }
  finally { await app?.close() }
}
run().catch(e => { console.error(e); process.exitCode = 1 })
