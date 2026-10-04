/** Real Electron session icon editing, persistence, native tabs and Historian setting.
 * npm run build && node scripts/session-emoji.check.cjs
 * Isolated userData / vault / backend; FORSION_APP_ROOT can point at an isolated build.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.resolve(__dirname, '..')
const APP_ROOT = process.env.FORSION_APP_ROOT || ROOT
let checks = 0
function check(name, ok) { assert.ok(ok, name); console.log(`PASS ${name}`); checks++ }

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-session-emoji-'))
  const userdata = path.join(home, 'userdata'), vault = path.join(home, 'vault'), project = path.join(home, 'project')
  for (const dir of [userdata, vault, project]) fs.mkdirSync(dir)
  fs.writeFileSync(path.join(vault, 'Emoji.md'), '# Emoji\n')
  fs.writeFileSync(path.join(userdata, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  const sessions = [
    { id: 'emoji-one', title: 'SQLite 会话', emoji: null },
    { id: 'emoji-two', title: '园艺会话', emoji: '🌱' },
    ...Array.from({ length: 4 }, (_, i) => ({ id: `emoji-extra-${i}`, title: `其他会话 ${i + 1}`, emoji: null })),
  ].map((s) => ({ ...s, app_id: 'tangu', kind: 'user', archived: false, model_id: 'm1', project_path: project, project_name: 'Emoji Workspace', projectless: false, summary: '会话图标验证', created_at: '2026-09-30T20:00:00Z', updated_at: '2026-09-30T20:00:00Z' }))
  const messages = [{ id: 'm1', role: 'user', content: '说明 SQLite 的 WAL 模式。', timestamp: 1000 }, { id: 'm2', role: 'model', content: 'WAL 使用预写日志提高读写并发。', timestamp: 2000 }]
  const config = {
    historian: { enabled: true, modelId: '', everyRounds: 3, firstRoundTrigger: true, mode: 'independent', prompt: '', harnessCandidates: true },
    muse: { enabled: false, modelId: '', restartWindowHours: 1, maxRestartsPerWindow: 3, maxIterationsPerCycle: 20, maxTodosPerWindow: 5, supervisorPollMinutes: 5, activeHours: null, allowedFolders: [], mode: 'ask', heartbeatMinutes: 120, notify: 'immediate', escalateTo: '' },
  }
  const writes = [], settings = [], activity = []
  let rejectSave = false
  const stub = await startStubEngine({ sessions, messages, agents: [{ slug: 'xyra', name: 'Xyra', createdBy: 'system' }], override: async ({ path: p, method, body, url }) => {
    if (p === '/agent/sessions' && method === 'GET') return { sessions: sessions.filter((s) => !!s.archived === (url.searchParams.get('archived') === 'true')) }
    const match = p.match(/^\/agent\/sessions\/([^/]+)$/)
    if (match && method === 'PATCH') {
      const patch = await body(); writes.push({ id: match[1], patch })
      if (rejectSave) return { __code: 500, body: { detail: 'test: save failed' } }
      const row = sessions.find((s) => s.id === match[1]); Object.assign(row, patch); return { session: row }
    }
    if (/^\/agent\/sessions\/[^/]+\/detail$/.test(p)) return { session: sessions.find((s) => s.id === p.split('/')[3]) }
    if (p === '/agent/special/config') {
      if (method === 'POST') { const patch = await body(); settings.push(patch); Object.assign(config.historian, patch.historian); Object.assign(config.muse, patch.muse) }
      return { config, defaults: { historianPrompt: 'Default prompt' } }
    }
    if (p === '/agent/special/historian/activity') return { activity, records: [], running: false }
  } })
  for (const dir of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }))
  }
  let app, win
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', APP_ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
    win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
    await win.waitForSelector('#root')
    await win.evaluate(() => { localStorage.setItem('forsion_default_space', 'tangu'); localStorage.setItem('forsion_theme_pref', 'light') })
    await win.reload({ waitUntil: 'domcontentloaded' })
    for (const label of ['跳过引导', 'Skip']) { const b = win.getByRole('button', { name: label, exact: true }).first(); if (await b.isVisible().catch(() => false)) { await b.click(); break } }
    const row = (id) => win.locator(`[data-sel-id="${id}"]`).first()
    await row('emoji-one').waitFor({ timeout: 30000 })
    check('已有 Emoji 在列表显示', await row('emoji-two').locator('[data-session-emoji="🌱"]').count() === 1)
    await row('emoji-one').click()
    const openPicker = async (id, label = '设置图标') => { await row(id).click({ button: 'right' }); await win.locator('.ctx-menu button', { hasText: label }).click(); await win.locator('.amx-iconpick').waitFor(); await win.waitForTimeout(350) }
    const pick = async (value) => { await win.locator('.amx-iconpick input').fill(value); await win.locator('.amx-iconpick input').press('Enter') }
    await openPicker('emoji-one')
    await pick('👩🏽‍💻')
    await win.locator('.amx-iconpick').waitFor({ state: 'hidden' })
    check('保存完整 Emoji，没有截断组合字符', sessions[0].emoji === '👩🏽‍💻' && writes.at(-1).patch.emoji === '👩🏽‍💻')
    check('列表立即更新图标', await row('emoji-one').locator('[data-session-emoji="👩🏽‍💻"]').count() === 1)
    await win.locator('.wb-tab [data-session-emoji="👩🏽‍💻"]').first().waitFor()
    check('原生聊天标签页同步图标', true)
    await row('emoji-one').click({ button: 'right' }); await win.locator('.ctx-menu button', { hasText: '在新标签页打开' }).click()
    await row('emoji-two').click()
    await win.locator('.wb-tab [data-session-emoji="🌱"]').first().waitFor()
    check('固定会话标签保留自己的图标，不随当前会话改变', await win.locator('.wb-tab [data-session-emoji="👩🏽‍💻"]').count() >= 1)
    await row('emoji-one').click()
    await openPicker('emoji-one'); await win.screenshot({ path: path.join(home, 'picker-zh-light.png') })
    const previous = writes.length
    await pick('invalid-icon')
    check('无效文本不提交且保留选择器', writes.length === previous && await win.locator('.amx-iconpick').isVisible())
    rejectSave = true
    await pick('🎨'); await win.waitForTimeout(200)
    check('保存失败保留原图标与选择器', await row('emoji-one').locator('[data-session-emoji="👩🏽‍💻"]').count() === 1 && await win.locator('.amx-iconpick').isVisible())
    rejectSave = false
    await pick('🎨'); await win.locator('.amx-iconpick').waitFor({ state: 'hidden' })
    await win.reload({ waitUntil: 'domcontentloaded' }); await row('emoji-one').waitFor()
    check('重载后图标仍在', await row('emoji-one').locator('[data-session-emoji="🎨"]').count() === 1)
    await row('emoji-one').click()
    await openPicker('emoji-one'); await win.locator('.amx-db-opt-clear').click(); await win.locator('.amx-iconpick').waitFor({ state: 'hidden' })
    check('移除图标保存为空并恢复默认图标', sessions[0].emoji === null && await row('emoji-one').locator('[data-session-emoji]').count() === 0)
    // Reproduce a delayed Historian update after the normal run-done refresh has passed.
    sessions[0].emoji = '🗄️'; activity.push({ id: 'icon-auto-1', action: 'icon_updated', detail: '🗄️', session_ref: 'emoji-one', created_at: '2026-09-30T21:00:00Z' })
    await row('emoji-one').locator('[data-session-emoji="🗄️"]').waitFor({ timeout: 10000 })
    check('Historian 延迟产出的图标自动刷新', true)
    await win.locator('.t2s-viewmore').first().click()
    const card = win.locator('.wsd-card', { hasText: '园艺会话' })
    await card.waitFor()
    check('工作区卡片显示会话图标', await card.locator('[data-session-emoji="🌱"]').count() === 1)
    await win.waitForTimeout(350); await win.screenshot({ path: path.join(home, 'workspace-cards.png') })
    await card.click({ button: 'right' }); await win.locator('.ctx-menu button', { hasText: '设置图标' }).click(); await pick('🎨'); await win.locator('.amx-iconpick').waitFor({ state: 'hidden' })
    check('工作区卡片的菜单也能设置图标', await card.locator('[data-session-emoji="🎨"]').count() === 1 && await row('emoji-two').locator('[data-session-emoji="🎨"]').count() === 1)
    await row('emoji-one').click()
    await win.screenshot({ path: path.join(home, 'sessions-zh-light.png') })
    const settingsOpened = app.waitForEvent('window', { timeout: 20000 })
    await win.evaluate(() => window.dispatchEvent(new CustomEvent('forsion:open-settings', { detail: 'agents/ag-special' })))
    let settingsWin = await settingsOpened
    const toggle = settingsWin.getByRole('switch', { name: '自动选择会话图标', exact: true })
    await toggle.waitFor()
    check('旧配置缺省显示开启', await toggle.getAttribute('aria-checked') === 'true')
    await toggle.click(); await settingsWin.getByRole('button', { name: '保存更改', exact: true }).click()
    await settingsWin.getByText('更改已保存', { exact: true }).waitFor()
    check('关闭开关只保存 autoEmoji 字段', JSON.stringify(settings.at(-1)) === JSON.stringify({ historian: { autoEmoji: false }, muse: {} }))
    await toggle.scrollIntoViewIfNeeded(); await settingsWin.waitForTimeout(350); await settingsWin.screenshot({ path: path.join(home, 'historian-zh-light.png') })
    await settingsWin.evaluate(() => window.close())
    const command = async (name) => { await win.keyboard.press('Meta+k'); await win.locator('.cmd-input').fill(name); await win.locator('.cmd-item', { hasText: name }).click(); await win.waitForTimeout(300) }
    await command('切换明暗模式'); await openPicker('emoji-one'); await win.screenshot({ path: path.join(home, 'picker-zh-dark.png') })
    await win.locator('.amx-iconpick input').press('Escape')
    await command('切换语言'); await openPicker('emoji-one', 'Set icon'); await win.screenshot({ path: path.join(home, 'picker-en-dark.png') })
    const rect = await win.locator('.amx-iconpick').boundingBox(), viewport = await win.evaluate(() => ({ w: innerWidth, h: innerHeight }))
    check('选择器处于可见窗口内', rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.w + 1 && rect.y + rect.height <= viewport.h + 1)
    await win.locator('.amx-iconpick input').press('Escape')
    const reopened = app.waitForEvent('window', { timeout: 20000 })
    await win.evaluate(() => window.dispatchEvent(new CustomEvent('forsion:open-settings', { detail: 'agents/ag-special' })))
    settingsWin = await reopened
    await settingsWin.getByRole('switch', { name: 'Choose session icons automatically', exact: true }).waitFor()
    check('重新打开设置保持关闭', await settingsWin.getByRole('switch', { name: 'Choose session icons automatically', exact: true }).getAttribute('aria-checked') === 'false')
    await settingsWin.waitForTimeout(350)
    await settingsWin.getByRole('switch', { name: 'Choose session icons automatically', exact: true }).evaluate((el) => el.closest('.special-toggle-row').scrollIntoView({ block: 'center' }))
    await settingsWin.waitForTimeout(350); await settingsWin.screenshot({ path: path.join(home, 'historian-en-dark.png') })
    await settingsWin.close()
    await command('Toggle light/dark mode')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 760))
    await openPicker('emoji-one', 'Set icon')
    const narrow = await win.locator('.amx-iconpick').boundingBox(), narrowViewport = await win.evaluate(() => ({ w: innerWidth, h: innerHeight }))
    check('窄窗口选择器完整可见', narrow.x >= 0 && narrow.y >= 0 && narrow.x + narrow.width <= narrowViewport.w + 1 && narrow.y + narrow.height <= narrowViewport.h + 1)
    await win.screenshot({ path: path.join(home, 'picker-en-light-narrow.png') })
    console.log(`${checks}/${checks} passed; screenshots: ${home}`)
  } catch (err) { if (win) await win.screenshot({ path: path.join(home, 'failure.png') }).catch(() => {}); console.error(`Failure screenshot: ${home}/failure.png`); throw err }
  finally { if (app) await app.close().catch(() => {}); await stub.close() }
}
main().catch((err) => { console.error(err); process.exitCode = 1 })
