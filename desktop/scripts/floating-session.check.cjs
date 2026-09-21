/** Real Electron: 浮窗面板(反馈 / 设置)必须挂上**主窗当前那条会话**。
 * 浮窗自带一套 store,它首次 connect 的兜底是列表第一条 —— 活动会话得由开窗方随 params 递过去,
 * 否则反馈「未关联会话」、设置里的「导出会话日志」会导出**另一条**会话(静默导错,人眼看不出)。
 * npm run build && npm run check:floatingsession
 * 全程打到隔离 loopback stub,不碰真账号、不发真工单。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.resolve(__dirname, '..')
let checks = 0
function check(name, condition) { assert.ok(condition, name); console.log(`PASS ${name}`); checks++ }
const now = Date.now()
// 两条会话:兜底会挑列表第一条,所以「挂对」必须落在**第二条**才算证据
const SESSIONS = [
  { id: 'sess-first', title: '列表第一条', model_id: 'm1', created_at: now - 1000, updated_at: now - 1000, projectless: true },
  { id: 'sess-active', title: '用户正在看的会话', model_id: 'm1', created_at: now, updated_at: now, projectless: true },
]

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-feedbackwin-'))
  const shots = path.join(home, 'screenshots'); fs.mkdirSync(shots)
  const userdata = path.join(home, 'userdata'); fs.mkdirSync(userdata)
  const vault = path.join(home, 'vault'); fs.mkdirSync(vault)
  fs.writeFileSync(path.join(userdata, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  const tickets = []
  const stub = await startStubEngine({
    sessions: SESSIONS,
    messages: [{ id: 'msg-1', role: 'user', content: 'A private conversation', created_at: now }],
    handle: async ({ path: route, body }) => {
      if (route === '/agent/runs') return { runs: [] }
      if (route === '/api/brain/users/me') return { id: 'test-feedback', username: 'Feedback tester' }
      if (route === '/api/feedback') { tickets.push(await body()); return { success: true, id: 'FB-2026-0043' } }
    },
  })
  const token = ['test', Buffer.from(JSON.stringify({ sub: 'test-feedback', exp: Math.floor(Date.now() / 1000) + 86400 * 10 })).toString('base64url'), 'test'].join('.')
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ cloudUrl: stub.url, token }))
  fs.writeFileSync(path.join(userdata, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, cloudUrl: stub.url, token }))
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 1000))
    await win.waitForSelector('#root')
    await win.evaluate(() => { localStorage.setItem('forsion_default_space', 'tangu'); localStorage.setItem('tangu_locale', 'zh') })
    await win.reload({ waitUntil: 'domcontentloaded' })
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`button:text-is("${label}")`).first()
      if (await b.isVisible().catch(() => false)) { await b.click(); break }
    }
    const input = win.locator('.t2c-ta').first()
    await input.waitFor({ timeout: 30000 })
    // 切到第二条会话:兜底恰好会挑第一条,不切就分不出「挂对」和「兜底蒙对」
    await win.locator('text=用户正在看的会话').first().click()
    await win.waitForTimeout(400)
    await input.fill('/feedback')
    await win.locator('button').filter({ hasText: /^\/feedback/ }).first().waitFor({ timeout: 10000 })
    const opened = app.waitForEvent('window')
    await input.press('Enter')
    const panel = await opened
    await panel.waitForLoadState('domcontentloaded')
    const modal = panel.locator('.feedback-modal')
    await modal.waitFor({ timeout: 30000 })
    check('/feedback 开出独立浮窗(不再画在主窗里)', panel !== win)
    await modal.getByText('关联会话：用户正在看的会话').waitFor({ timeout: 15000 })
    check('浮窗挂的是主窗当前会话,不是列表第一条', !(await modal.textContent()).includes('列表第一条'))
    const conversation = modal.getByRole('checkbox', { name: /当前会话内容/ })
    check('「当前会话内容」可勾选(用户报的就是它一直灰着)', await conversation.isEnabled())
    await modal.getByText(/诊断附件已就绪/).waitFor({ timeout: 30000 })
    await conversation.check()
    await modal.getByText(/诊断附件已就绪/).waitFor({ timeout: 30000 })
    await modal.getByRole('button', { name: '预览附件', exact: true }).click()
    const payload = JSON.parse(await modal.locator('pre').textContent())
    check('附件里的会话正文来自那条会话', payload.messages[0].content === 'A private conversation')
    await modal.getByRole('button', { name: '返回反馈', exact: true }).click()
    // 导出:blob 下载走 Electron 的 will-download,这里只证按钮在且点得动(落盘路径是壳的事)
    const exportBtn = modal.getByRole('button', { name: '导出日志文件', exact: true })
    check('附件可导出为本地文件', await exportBtn.isEnabled())
    await modal.screenshot({ path: path.join(shots, 'feedback-window.png') }) // 观感自查:会话行 + 导出按钮都在表单态
    await panel.close()

    // ── 设置浮窗:「导出会话日志」导的必须是主窗那条会话(导错是静默的,只能看落盘文件) ──
    const exported = path.join(home, 'exported-session.json')
    await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }) }, exported)
    const settingsOpened = app.waitForEvent('window')
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma')
    const settings = await settingsOpened
    await settings.waitForLoadState('domcontentloaded')
    await settings.locator('.settings-nav').waitFor({ timeout: 30000 })
    check('设置也开在独立浮窗里', settings !== win)
    await settings.locator('.settings-nav-parent > button', { hasText: /^\s*高级/ }).first().click()
    await settings.locator('.settings-nav-subitem', { hasText: '界面与会话' }).first().click()
    const exportJson = settings.getByRole('button', { name: /导出为 JSON/ })
    await exportJson.waitFor({ timeout: 15000 })
    check('设置里的导出按钮可用(没会话时它是灰的)', await exportJson.isEnabled())
    await exportJson.click()
    await settings.getByText(/已导出到|导出失败/).waitFor({ timeout: 30000 })
    const dumped = JSON.parse(fs.readFileSync(exported, 'utf8'))
    check('设置导出的是主窗当前会话,不是列表第一条', dumped.session && dumped.session.id === 'sess-active')
    console.log(`${checks} checks passed. Screenshots: ${shots}`)
  } catch (error) {
    if (app) { for (const [i, w] of app.windows().entries()) await w.screenshot({ path: path.join(shots, `failure-${i}.png`) }).catch(() => {}) }
    console.error(`Evidence: ${home}`)
    throw error
  } finally { if (app) await app.close(); await stub.close() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
