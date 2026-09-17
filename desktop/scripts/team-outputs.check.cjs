/** Team deliverables in the main ChatView: live SSE, replay, reload, interaction and file preview. */
const { _electron: electron } = require('playwright-core')
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert/strict')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.join(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-team-outputs-'))
const sid = 'team-outputs'
const config = { groupChat: true, groupAgents: ['xyra', 'artist'], execMode: 'host', cwd: home }
const agents = ['xyra', 'artist'].map((slug) => ({ slug, name: slug === 'artist' ? 'Artist' : 'Xyra', description: 'Team outputs', tools: [], model: '', systemPrompt: '', createdBy: 'user' }))
const session = { id: sid, title: 'Team deliverables', archived: false, model_id: 'm1', agent_config: config, projectless: false, project_path: home, project_name: 'Output test', created_at: '2026-09-17 00:00:00', updated_at: '2026-09-17 00:00:00' }
const html = '<div class="fs-panel"><h2>Team workflow</h2><p>Research → Review → Delivery</p><button onclick="this.textContent=\'INTERACTION-PASSED\'">Inspect workflow</button></div>'
const sketch = { id: 'delivery-sketch', role: 'model', content: '**🗣 Artist**\n\n', agent_slug: 'artist', timestamp: 2, tool_calls: [{ id: 'sketch-one', type: 'function', function: { name: 'sketch', arguments: JSON.stringify({ title: 'Team workflow', html }) }, ui_content_offset: 0 }], tool_results: [{ tool_call_id: 'sketch-one', content: 'Sketch card rendered.' }], display_files: [] }
const file = { id: 'delivery-file', role: 'model', content: '**🗣 Xyra**\n\n', agent_slug: 'xyra', timestamp: 3, tool_calls: [], tool_results: [], display_files: [{ name: 'report.txt', mime: 'text/plain', path: path.join(home, 'report.txt'), sourceSessionId: 'child-xyra' }] }
const img = { ...file, id: 'delivery-image', timestamp: 4, display_files: [{ name: 'chart.svg', mime: 'image/svg+xml', sourceSessionId: 'child-xyra', dataUrl: 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="70"><rect width="240" height="70" fill="#2563eb"/><text x="20" y="42" fill="white">Team chart</text></svg>').toString('base64') }] }
let app, win
async function main() {
  fs.writeFileSync(path.join(home, 'report.txt'), 'REPORT-PREVIEW-CONTENT')
  const stub = await startStubEngine({ sessions: [session], agents, override: async ({ path: p, method }) => {
    if (p === '/agent/runs' && method === 'GET') return { runs: [] }
    if (p.endsWith('/config')) return { agent_config: config }
  } })
  stub.script([
    { type: 'team_member', payload: { phase: 'start', slug: 'artist', name: 'Artist', messageId: 'work-artist', sessionId: 'child-artist', runId: 'run-artist' } },
    { type: 'team_output', payload: { message: sketch }, delay: 100 },
    { type: 'team_output', payload: { message: sketch } },
    { type: 'team_output', payload: { message: file } },
    { type: 'team_output', payload: { message: img } },
    { type: 'team_member', payload: { phase: 'end', reason: 'done', slug: 'artist', messageId: 'work-artist' }, delay: 500 },
    { type: 'done', payload: { content: '', group: true } },
  ])
  try {
    const ud = path.join(home, 'userdata')
    for (const dir of [ud, `${ud}-dev`]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'test' })) }
    app = await electron.launch({ args: [`--user-data-dir=${ud}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
    win = await app.firstWindow()
    win.setDefaultTimeout(15000)
    const errors = []
    win.on('pageerror', (e) => errors.push(String(e)))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 1000))
    await win.waitForSelector('#root')
    await win.waitForTimeout(2000)
    for (const label of ['跳过引导', 'Skip']) { const b = win.getByText(label, { exact: true }); if (await b.count()) { await b.first().click(); break } }
    await win.evaluate(() => localStorage.setItem('forsion_default_space', 'tangu'))
    await win.reload()
    await win.locator('.t2s-srow, .t2o-row').filter({ hasText: session.title }).first().click()
    const chat = win.locator('[data-chat-surface="chat"]')
    await chat.locator('.t2c-ta').fill('Show the team deliverables')
    await chat.locator('.t2c-ta').press('Enter')
    const card = chat.locator('.sketch-card')
    await card.waitFor()
    await win.waitForTimeout(1200)
    assert.equal(await card.count(), 1)
    assert.equal(await win.locator('.child-chat-panel').count(), 0)
    await chat.frameLocator('.sketch-frame').getByRole('button', { name: 'Inspect workflow' }).click()
    await chat.frameLocator('.sketch-frame').getByRole('button', { name: 'INTERACTION-PASSED' }).waitFor()
    assert.equal(await chat.locator('img[alt="chart.svg"]').evaluate((el) => el.complete && el.naturalWidth > 0), true)
    await win.screenshot({ path: path.join(home, 'outputs-light.png') })
    await chat.getByRole('button', { name: 'report.txt', exact: true }).click()
    await win.getByText('REPORT-PREVIEW-CONTENT', { exact: false }).first().waitFor()
    console.log('PASS live main-chat sketch, deduplication, iframe interaction, image and file preview')
    stub.state.messages = [{ id: 'u-r1', role: 'user', content: 'Show the team deliverables', timestamp: 1 }, sketch, file, img]
    await win.reload()
    await win.locator('.t2s-srow, .t2o-row').filter({ hasText: session.title }).first().click()
    await chat.locator('.sketch-card').waitFor()
    assert.equal(await chat.locator('.sketch-card').count(), 1)
    await chat.frameLocator('.sketch-frame').getByRole('button', { name: 'Inspect workflow' }).waitFor()
    await win.getByTitle('切换明暗模式').click()
    await win.waitForTimeout(400)
    await win.screenshot({ path: path.join(home, 'outputs-dark.png') })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 900))
    await win.waitForTimeout(400)
    await win.screenshot({ path: path.join(home, 'outputs-narrow.png') })
    assert.equal(await chat.locator('.sketch-frame').count(), 1)
    assert.deepEqual(errors, [])
    console.log('PASS reload retains full outputs; dark/narrow screenshots; no renderer errors')
    console.log('Artifacts:', home)
  } catch (e) {
    if (win) await win.screenshot({ path: path.join(home, 'failure.png') }).catch(() => {})
    console.error('Artifacts:', home)
    throw e
  } finally { if (app) await app.close(); await stub.close() }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
