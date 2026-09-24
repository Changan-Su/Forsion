/** Automation studio: real Electron UI, isolated user data, controlled backend. Build first. */
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.resolve(__dirname, '..')
const OUT = process.env.AUTOMATION_ARTIFACT_DIR || path.join(os.tmpdir(), 'forsion-automation-space')
const results = []
function check(name, ok) { assert.ok(ok, name); results.push(name); console.log(`PASS ${name}`) }
async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-auto-'))
  const rules = [], executions = [], requests = []
  let failExecutions = false, app, win
  const special = { muse: { enabled: false, supervisorPollMinutes: 15 }, historian: { enabled: false, everyRounds: 5 } }
  const stub = await startStubEngine({
    agents: [{ slug: 'writer', name: 'Writer', description: 'Writing assistant', instructions: '', icon: 'bot', skills: [] }],
    override: async ({ path: p, method, body }) => {
      if (p === '/agent/special/config') return { config: special }
      if (p === '/agent/special/muse/status') return { status: { enabled: false, running: false, sessionId: null } }
      if (p === '/agent/special/schedule') return { schedules: [] }
      if (p === '/agent/special/automation/sessions') return { sessions: [] }
      if (p === '/agent/special/automation/actions') return { tools: [{ name: 'safe_test', description: 'Test tool', parameters: { properties: { enabled: { type: 'boolean' } }, required: ['enabled'] } }] }
      if (p === '/agent/special/muse/triggers') {
        if (method === 'GET') return { triggers: rules }
        const b = await body(); requests.push(b)
        const tr = { id: b.id || `auto-${rules.length + 1}`, desc: b.desc, enabled: b.enabled, cond: { type: b.cond_type, ...(b.time ? { time: b.time } : {}) }, actions: b.actions, cooldownHours: b.cooldown_hours || 0, lastFiredAt: null }
        const at = rules.findIndex((r) => r.id === tr.id)
        if (at < 0) rules.push(tr); else rules[at] = tr
        return { trigger: tr, created: at < 0 }
      }
      if (p === '/agent/special/automation/executions') return failExecutions ? { __code: 500, body: { error: 'fixture failure' } } : { executions }
      if (/\/automation\/triggers\/.+\/fire$/.test(p)) {
        const b = await body(); check('test run uses manual origin', b.origin === 'manual')
        executions.unshift({ id: `exec-${executions.length}`, trigger_id: rules[0].id, origin: 'manual', status: 'failed', created_at: new Date().toISOString(), error: 'Second action failed', steps: [{ type: 'notify', ok: true, summary: 'First notification delivered' }, { type: 'notify', ok: false, summary: 'Could not deliver the second notification' }] })
        return { ok: false, status: 'failed', steps: executions[0].steps }
      }
    },
  })
  try {
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
    win = await app.firstWindow()
    const pageErrors = []
    win.on('pageerror', (error) => pageErrors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000))
    await win.waitForSelector('#root')
    await win.getByRole('button', { name: '跳过引导', exact: true }).waitFor({ timeout: 20000 }).catch(() => {})
    for (const label of ['跳过引导', 'Skip']) {
      const button = win.getByRole('button', { name: label, exact: true }).first()
      if (await button.isVisible().catch(() => false)) { await button.click(); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 40000 })
    await win.locator('#tangu-splash').waitFor({ state: 'detached' })
    const openSpace = async () => { await win.locator('button.rb-space').filter({ hasText: /^自动化$|^Automation$/ }).first().click() }
    // Ribbon labels may be visually collapsed, so use the accessible title when needed.
    const autoButton = win.locator('button.rb-space[title="自动化"], button.rb-space[title="Automation"]').first()
    if (await autoButton.count()) await autoButton.click(); else await openSpace()
    await win.waitForSelector('.auto-home')
    check('first visit offers four real starter templates', await win.locator('.auto-starter').count() === 4)
    await win.screenshot({ path: path.join(OUT, 'home-zh.png') })
    await win.locator('.auto-starter').first().click()
    await win.waitForSelector('.auto-canvas')
    check('starter opens trigger, notification, review nodes without saving', await win.locator('.auto-flow-node').count() === 3 && requests.length === 0)
    await win.getByRole('textbox', { name: '名称', exact: true }).fill('Canvas regression')
    const node = win.locator('.auto-flow-node').nth(1)
    await node.click()
    const visibleNode = win.locator('.auto-inspector .auto-node:not([hidden])')
    const title = visibleNode.locator('input[type="text"]').first()
    await title.fill('First notification')
    const bodyField = visibleNode.locator('textarea')
    await bodyField.fill('Run at: ')
    await bodyField.press('End')
    await visibleNode.locator('.auto-template-field').nth(1).getByRole('combobox').selectOption('{{now}}')
    check('variable picker inserts into the focused field', await bodyField.inputValue() === 'Run at: {{now}}')
    const before = await node.boundingBox()
    const lineBefore = await win.locator('.auto-canvas-edges > path').first().getAttribute('d')
    await win.mouse.move(before.x + 80, before.y + 35)
    await win.mouse.down()
    await win.mouse.move(before.x + 140, before.y + 45, { steps: 10 })
    await win.mouse.up()
    const after = await node.boundingBox()
    check('dragging moves a node and updates its connector', after.x > before.x + 40 && await win.locator('.auto-canvas-edges > path').first().getAttribute('d') !== lineBefore)
    check('dragging keeps execution numbering', (await node.innerText()).startsWith('1.'))
    const canvas = win.locator('.auto-canvas')
    const transformBefore = await win.locator('.auto-canvas-world').getAttribute('style')
    await canvas.hover({ position: { x: 20, y: 20 } })
    await win.mouse.wheel(30, 60)
    await win.waitForFunction((before) => document.querySelector('.auto-canvas-world')?.getAttribute('style') !== before, transformBefore)
    check('trackpad scrolling pans the workflow canvas', true)
    await win.getByRole('button', { name: '适应视图', exact: true }).click()
    await win.getByRole('button', { name: '放大画布', exact: true }).click()
    await win.getByRole('button', { name: '缩小画布', exact: true }).click()
    await win.locator('.auto-addstep').getByRole('button', { name: '通知', exact: true }).click()
    await visibleNode.locator('input[type="text"]').first().fill('Second notification')
    await visibleNode.getByRole('button', { name: '上移', exact: true }).click()
    check('step reorder updates canvas numbering', (await win.locator('.auto-flow-node').nth(1).innerText()).includes('Second notification'))
    const noOverlap = await win.locator('.auto-flow-node').evaluateAll((nodes) => nodes.every((a, i) => nodes.slice(i + 1).every((b) => {
      const x = a.getBoundingClientRect(), y = b.getBoundingClientRect()
      return x.right <= y.left || y.right <= x.left || x.bottom <= y.top || y.bottom <= x.top
    })))
    check('structural edits reflow previously dragged nodes without overlap', noOverlap)
    check('add-step buttons stay on one text line', await win.locator('.auto-addstep button').evaluateAll((buttons) => buttons.every((b) => b.getBoundingClientRect().height < 40)))
    await win.screenshot({ path: path.join(OUT, 'canvas-zh.png') })
    await win.getByRole('button', { name: '保存为暂停', exact: true }).click()
    await win.waitForSelector('.auto-detail-flow')
    check('new rule is saved paused with the chosen action order', requests[0].enabled === false && requests[0].actions[0].title === 'Second notification' && requests[0].actions[1].body === 'Run at: {{now}}')
    check('saving selects the returned rule immediately', await win.locator('.auto-detail .auto-card-title').innerText() === 'Canvas regression')
    await win.locator('.auto-detail').getByRole('button', { name: '试跑', exact: true }).click()
    await win.locator('.auto-detail .auto-execution-error').waitFor()
    check('run results expose every step and full failure text', (await win.locator('.auto-detail .auto-executions').innerText()).includes('Could not deliver the second notification'))
    await win.screenshot({ path: path.join(OUT, 'results-zh.png') })
    failExecutions = true
    await win.locator('.auto-detail').getByRole('button', { name: '试跑', exact: true }).click()
    await win.locator('.auto-detail [role="alert"]').waitFor()
    check('ledger loading failure offers recovery instead of an empty history', (await win.locator('.auto-detail [role="alert"]').innerText()).includes('无法读取运行记录'))
    failExecutions = false
    await win.locator('.auto-detail').getByRole('button', { name: '重试', exact: true }).click()
    await win.locator('.auto-detail .auto-executions').waitFor()
    check('ledger retry restores the execution results', true)
    const ruleRow = win.locator('.auto-list .auto-item').filter({ hasText: 'Canvas regression' })
    await ruleRow.getByRole('switch').click()
    await win.waitForFunction(() => document.querySelector('.auto-detail .auto-status-label')?.textContent === '已启用')
    check('enabling preserves the complete action chain', requests.at(-1).enabled && requests.at(-1).actions.length === 2)
    await win.getByRole('textbox', { name: '搜索自动化', exact: true }).fill('not-a-rule')
    check('sidebar search filters saved rules', await win.locator('.auto-list .auto-item').filter({ hasText: 'Canvas regression' }).count() === 0)
    await win.getByRole('textbox', { name: '搜索自动化', exact: true }).fill('')
    await win.locator('.auto-detail').getByRole('button', { name: '编辑', exact: true }).click()
    await win.waitForSelector('.auto-canvas')
    check('editing preserves enabled state', await win.getByRole('button', { name: '保存并启用', exact: true }).isEnabled())
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 820))
    await win.getByRole('button', { name: '工作流画布', exact: true }).click()
    await win.screenshot({ path: path.join(OUT, 'canvas-narrow-flow-zh.png') })
    await win.locator('.auto-flow-node').nth(1).click()
    const geometry = await win.locator('.auto-workflow-builder').evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth, visible: !!el.querySelector('.auto-inspector input') }))
    check('narrow canvas and configuration tabs have no horizontal overflow', geometry.scroll <= geometry.width + 1 && geometry.visible)
    await win.screenshot({ path: path.join(OUT, 'canvas-narrow-zh.png') })
    await win.getByRole('button', { name: '取消', exact: true }).click()
    await win.locator('.auto-overview').click()
    await win.locator('.auto-starter').nth(1).click()
    check('agent template explains the missing selection', (await win.locator('.auto-save-status').innerText()).includes('选择执行任务的 Agent') && await win.getByRole('button', { name: '保存为暂停', exact: true }).isDisabled())
    await win.locator('.auto-save-status button').click()
    check('validation navigates to the incomplete node', await visibleNode.locator('select').first().isVisible())
    await visibleNode.locator('select').first().selectOption('writer')
    check('selecting an agent completes the template', await win.getByRole('button', { name: '保存为暂停', exact: true }).isEnabled())
    await win.getByRole('button', { name: '取消', exact: true }).click()
    await win.evaluate(() => { localStorage.setItem('tangu_locale', 'en'); localStorage.setItem('forsion_theme', 'dark') })
    await win.reload({ waitUntil: 'domcontentloaded' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000))
    await win.locator('button.rb-space[title="Automation"]').click()
    await win.locator('.auto-home').waitFor({ timeout: 30000 })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000))
    await win.locator('.auto-starter').first().click()
    await win.locator('.auto-canvas').waitFor()
    await win.screenshot({ path: path.join(OUT, 'canvas-en-dark.png') })
    check('English canvas uses translated labels', (await win.locator('.auto-canvas-heading').innerText()).includes('Workflow canvas'))
    console.log('Renderer errors:', JSON.stringify(pageErrors))
    check('no renderer errors', pageErrors.length === 0)
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ checks: results, pageErrors }, null, 2))
    console.log(`${results.length} checks passed. Artifacts: ${OUT}`)
  } catch (error) {
    if (win) { await win.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(OUT, 'failure.txt'), await win.locator('body').innerText().catch(() => '')) }
    throw error
  } finally { await app?.close(); await stub.close() }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
