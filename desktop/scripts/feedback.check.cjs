/** Real Electron: slash entry, selected diagnostics over IPC/HTTP, failure/retry, keyboard and responsive screenshots.
 * ⚠️ /feedback 开的是**独立浮窗**(Floating Panel 化之后):面板不在主窗里,每次「完成」窗口会关掉,
 *    下一轮要重新 app.waitForEvent('window') 拿。主窗只负责敲斜杠命令与切语言;尺寸/深色/键盘一律打在浮窗上。
 * npm run build && npm run check:feedback
 * All feedback goes to an isolated loopback server; no real account or feedback ticket is used.
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

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-feedback-'))
  const shots = path.join(home, 'screenshots'); fs.mkdirSync(shots)
  const userdata = path.join(home, 'userdata'); fs.mkdirSync(userdata)
  const vault = path.join(home, 'vault'); fs.mkdirSync(vault)
  fs.writeFileSync(path.join(userdata, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  const tickets = []
  let rejectNext = true
  const stub = await startStubEngine({
    sessions: [{ id: 'feedback-session', title: '日志与运行状态', model_id: 'm1', created_at: Date.now(), updated_at: Date.now(), projectless: true }],
    messages: [{ id: 'msg-1', role: 'user', content: 'A private conversation', created_at: Date.now() }],
    handle: async ({ path: route, body }) => {
      if (route === '/agent/runs') return { runs: [] }
      if (route === '/api/brain/users/me') return { id: 'test-feedback', username: 'Feedback tester' }
      if (route === '/agent/sessions/feedback-session/usage') return { tokensTotal: 2400, contextTokens: 800 }
      if (route === '/agent/sessions/feedback-session/timeline') return { runs: [{ runId: 'run-feedback', events: [{ type: 'run:done' }] }] }
      if (route === '/api/feedback') {
        tickets.push(await body())
        if (rejectNext) { rejectNext = false; return { __code: 503, body: { detail: 'Test retry' } } }
        return { success: true, id: 'FB-2026-0042' }
      }
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
    /** 敲一次斜杠命令,等浮窗开出来并返回它的 page + 面板 locator。 */
    const openFeedback = async (text) => {
      await input.fill(text)
      // 命令候选只在「纯命令、还没打空格」时挂着;带参数那次直接回车(旧版行为)
      if (!text.includes(' ')) await win.locator('button').filter({ hasText: /^\/feedback/ }).first().waitFor({ timeout: 10000 })
      const opened = app.waitForEvent('window')
      await input.press('Enter')
      const page = await opened
      await page.waitForLoadState('domcontentloaded')
      const panel = page.locator('.feedback-modal')
      await panel.waitFor({ timeout: 30000 })
      return { page, panel }
    }
    /** 尺寸要打在浮窗那个 BrowserWindow 上,不是主窗(getAllWindows()[0])。 */
    const sizeFloating = (w, h) => app.evaluate(({ BrowserWindow }, size) => {
      const target = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('window=floating'))
      if (!target) throw new Error('floating window not found')
      target.setMinimumSize(360, 480); target.setSize(size.w, size.h)
    }, { w, h })
    let { page: fbPage, panel: modal } = await openFeedback('/feedback')
    check('slash opens a separate feedback window instead of sending to the model', fbPage !== win && stub.seen.runs.length === 0)
    await modal.locator('textarea').fill('切换模型后，界面的运行状态没有更新。\n预期：新的模型名称与运行记录保持一致。\n重现：打开会话 → 切换模型 → 再发送一条消息。')
    await modal.getByText(/诊断附件已就绪/).waitFor()
    await modal.screenshot({ path: path.join(shots, 'feedback-light.png') })
    check('description retains keyboard focus after slash command', await modal.locator('textarea').evaluate((el) => document.activeElement === el))
    await modal.getByRole('button', { name: '预览附件', exact: true }).click()
    const reviewed = await modal.locator('pre').textContent()
    const payload = JSON.parse(reviewed)
    check('diagnostics include run timeline and usage', payload.timeline[0].runId === 'run-feedback' && payload.usage.tokensTotal === 2400)
    check('conversation is opt-in', !('messages' in payload))
    check('host token is absent from attachment', !reviewed.includes(token))
    await modal.getByRole('button', { name: '提交反馈', exact: true }).click()
    await modal.getByRole('alert').filter({ hasText: 'Test retry' }).waitFor()
    check('failed send keeps the panel and draft', await modal.isVisible())
    await modal.getByRole('button', { name: '重试提交', exact: true }).click()
    await modal.getByText('反馈已收到', { exact: true }).waitFor()
    check('retry sends the exact preview through real IPC and HTTP', tickets.length === 2 && Buffer.from(tickets[1].attachments[0].data_base64, 'base64').toString() === reviewed)
    check('success contains feedback reference', (await modal.textContent()).includes('FB-2026-0042'))
    await modal.getByRole('button', { name: '完成', exact: true }).click()
    await fbPage.waitForEvent('close').catch(() => {}) // 「完成」关窗:下一轮必须重新拿

    ;({ page: fbPage, panel: modal } = await openFeedback('/feedback 带内容的快捷反馈'))
    check('slash arguments prefill feedback', await modal.locator('textarea').inputValue() === '带内容的快捷反馈')
    await modal.getByText(/诊断附件已就绪/).waitFor()
    await modal.getByRole('checkbox', { name: /当前会话内容/ }).check()
    await modal.getByText(/诊断附件已就绪/).waitFor()
    await modal.getByRole('button', { name: '预览附件', exact: true }).click()
    check('selected conversation appears in preview', JSON.parse(await modal.locator('pre').textContent()).messages[0].content === 'A private conversation')
    await modal.getByRole('button', { name: '返回反馈', exact: true }).click()
    await fbPage.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.dataset.mode = 'dark' })
    await fbPage.waitForTimeout(350)
    await modal.screenshot({ path: path.join(shots, 'feedback-dark.png') })
    await sizeFloating(480, 640)
    await fbPage.waitForTimeout(350)
    await modal.screenshot({ path: path.join(shots, 'feedback-narrow.png') })
    const geometry = await modal.evaluate((el) => {
      const footer = el.querySelector('.feedback-footer').getBoundingClientRect()
      const r = el.getBoundingClientRect()
      return { width: innerWidth, fits: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1, footer: footer.bottom <= innerHeight, scroll: el.querySelector('.modal-body').scrollHeight > el.querySelector('.modal-body').clientHeight }
    })
    check('narrow window keeps the footer visible with one scroll area', geometry.width <= 480 && geometry.fits && geometry.footer && geometry.scroll)
    await modal.getByRole('checkbox', { name: /当前会话内容/ }).uncheck()
    await modal.getByRole('checkbox', { name: /应用与运行日志/ }).uncheck()
    await modal.getByRole('button', { name: '提交反馈', exact: true }).click()
    await modal.getByText('反馈已收到', { exact: true }).waitFor()
    check('text-only sends no attachment', tickets.at(-1).attachments.length === 0)
    await modal.getByRole('button', { name: '完成', exact: true }).click()
    await fbPage.waitForEvent('close').catch(() => {})
    const beforeOversize = tickets.length
    const oversize = await win.evaluate(() => window.tangu.submitFeedback({ description: 'Oversize guard', sessionLogJson: 'x'.repeat(5 * 1024 * 1024 + 1) }))
    check('IPC rejects oversize diagnostics before any HTTP request', !oversize.ok && oversize.error === 'attachment-too-large' && tickets.length === beforeOversize)
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
    await win.locator('.cmd-input').fill('切换语言')
    await win.locator('.cmd-item').filter({ hasText: '切换语言' }).click()
    await win.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.dataset.mode = 'light' })
    await win.waitForTimeout(350)
    ;({ page: fbPage, panel: modal } = await openFeedback('/feedback The status indicator did not update after switching models.'))
    await sizeFloating(480, 640)
    await modal.getByRole('heading', { name: 'Feedback', exact: true }).waitFor()
    await modal.getByText(/Diagnostics ready/).waitFor()
    await modal.screenshot({ path: path.join(shots, 'feedback-english-narrow.png') })
    const send = modal.getByRole('button', { name: 'Send feedback', exact: true })
    await send.focus(); await fbPage.keyboard.press('Tab')
    check('Tab stays inside the modal', await modal.evaluate((el) => el.contains(document.activeElement)))
    await modal.locator('textarea').focus(); await fbPage.keyboard.press('Control+Enter')
    await modal.getByText('Feedback received', { exact: true }).waitFor()
    check('English UI and keyboard shortcut submit correctly', tickets.at(-1).description.includes('The status indicator'))
    console.log(`${checks} checks passed. Screenshots: ${shots}`)
  } catch (error) {
    if (app) { const windows = app.windows(); if (windows[0]) await windows[0].screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {}) }
    console.error(`Evidence: ${home}`)
    throw error
  } finally { if (app) await app.close(); await stub.close() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
