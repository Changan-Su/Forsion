/** Real Electron against the live-harness engine: the「工作笔记已更新」card is rebuilt from a real model's persisted
 * manage_harness receipt, and its Undo reaches the real rollback API.
 * Invoked by live-harness --only harnessopen --harness-ui (which supplies the environment below); build desktop first.
 * The engine-side contract (409 on a second undo, notes gone from the next system prompt) stays in the live scenario. */
const fs = require('fs')
const path = require('path')
const assert = require('assert/strict')
const electron = require('./lib/launch-electron.cjs')
const ROOT = path.join(__dirname, '..')
const base = process.env.TANGU_BACKEND_URL
const token = process.env.TANGU_HARNESS_TOKEN
const sid = process.env.TANGU_HARNESS_SESSION
const slug = process.env.TANGU_HARNESS_SLUG
const rev = process.env.TANGU_HARNESS_REV
const entryId = process.env.TANGU_HARNESS_ENTRY
const home = process.env.TANGU_HARNESS_UI_HOME
async function api(route) {
  const r = await fetch(base + route, { headers: { Authorization: `Bearer ${token}` } })
  const value = await r.json(); assert.ok(r.ok, `${route}: ${r.status}`); return value
}
async function run() {
  assert.ok(base && token && sid && slug && rev && entryId && home, 'Run through live-harness --only harnessopen --harness-ui, or provide its isolated fixture environment')
  fs.mkdirSync(home, { recursive: true })
  assert.ok((await api(`/agent/agents/${slug}/harness`)).entries.some(e => e.id === entryId), 'The real model wrote the entry before the UI opens')
  const ud = path.join(home, 'userData')
  // 工作区和笔记库都钉在夹具目录里:不给的话外壳回落到 ~/Forsion-Dev,挂上的是开发者真实的笔记库。
  const vault = path.join(home, 'vault'); const ws = path.join(home, 'workspace')
  for (const dir of [vault, ws]) fs.mkdirSync(dir, { recursive: true })
  for (const dir of [ud, `${ud}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: base, token, defaultWorkspaceDir: ws }))
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
    // 台架经 API 建的 agent 会话不在侧栏任何一行里(侧栏的 agent 行打开的是它的私聊)。按会话 id 打开,走的是产品自己的通道:
    // 点系统通知 → 主进程 webContents.send('approval:open') → attentionOpen.openSessionFromApproval。
    await win.waitForTimeout(1200)
    await app.evaluate(({ BrowserWindow }, sessionId) => BrowserWindow.getAllWindows()[0].webContents.send('approval:open', { sessionId }), sid)
    await win.locator(`[data-chat-surface="chat"][data-session-id="${sid}"]`).waitFor()
    const card = win.locator(`[data-harness-update="${rev}"]`)
    await card.waitFor()
    await win.locator(`[data-harness-update="${rev}"][data-harness-state="current"]`).waitFor() // 状态从真引擎的编辑史推出
    const text = await card.innerText()
    assert.ok(text.includes('已生效') && text.includes('新增'), `Card shows the applied create: ${text}`)
    assert.equal(await win.locator('[data-harness-updates]').count(), 1)
    await shot('harness-card-live')
    await card.getByRole('button', { name: '撤销本次更新' }).click()
    await win.locator(`[data-harness-update="${rev}"][data-harness-state="undone"]`).waitFor()
    assert.equal((await api(`/agent/agents/${slug}/harness`)).entries.some(e => e.id === entryId), false, 'Undo removed the entry on the real engine')
    assert.ok((await card.innerText()).includes('本次更新已撤销'))
    assert.equal(await card.getByRole('button', { name: '撤销本次更新' }).count(), 0, 'An undone card offers no second undo')
    await shot('harness-card-live-undone')
    await card.getByRole('button', { name: '查看工作笔记' }).click()
    await win.locator('[data-tangu-details]').waitFor()
    await shot('harness-card-live-details')
    assert.deepEqual(errors, [], 'No renderer errors')
    console.log('PASS real card + undo; screenshots:', home)
  } catch (e) { if (win) await shot('failure').catch(() => {}); throw e }
  finally { await app?.close() }
}
run().catch(e => { console.error(e); process.exitCode = 1 })
