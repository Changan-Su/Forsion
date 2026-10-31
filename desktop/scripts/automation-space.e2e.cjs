/** Automation studio: real Electron UI, isolated user data, controlled backend. Build first. */
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs')
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
      if (p === '/agent/special/historian/activity') return { activity: [] }
      if (p === '/agent/special/schedule') return { schedules: [] }
      if (p === '/agent/special/automation/sessions') return { sessions: [] }
      if (p === '/agent/special/automation/actions') return { tools: [{ name: 'safe_test', description: 'Test tool', parameters: { properties: { enabled: { type: 'boolean' } }, required: ['enabled'] } }] }
      if (p === '/agent/special/muse/triggers') {
        if (method === 'GET') return { triggers: rules }
        const b = await body(); requests.push(b)
        const prev = rules.find((r) => r.id === b.id)
        const observe = b.observe ?? prev?.observe // 缺席 = 保留,和引擎 upsertTrigger 同口径
        const tr = { id: b.id || `auto-${rules.length + 1}`, desc: b.desc, enabled: b.enabled, cond: { type: b.cond_type, ...(b.time ? { time: b.time } : {}) }, actions: b.actions, cooldownHours: b.cooldown_hours || 0, lastFiredAt: null, ...(observe ? { observe, observeSince: new Date(Date.now() - 2 * 86_400_000).toISOString(), observeHits: 1 } : {}) }
        const at = rules.findIndex((r) => r.id === tr.id)
        if (at < 0) rules.push(tr); else rules[at] = tr
        return { trigger: tr, created: at < 0 }
      }
      if (p === '/agent/special/automation/sources') {
        const src = (id, group, zh, extra = {}) => ({ id, group, name: { zh, en: zh }, params: [], eventSource: 'poll', timed: false, defaultCooldownHours: 24, requires: [], available: true, ...extra })
        return { sources: [
          src('at', 'time', '指定时间'), src('every', 'time', '每隔'), src('daily_at', 'time', '每天'), src('manual', 'time', '手动'),
          src('computer.app_opened', 'computer', '打开了 App', { params: [{ key: 'app', type: 'app', name: { zh: 'App', en: 'App' }, required: true }], defaultCooldownHours: 2, eventSource: 'computer' }),
          src('computer.unlocked', 'computer', '解锁 / 唤醒', { available: false, reason: 'trigger:computer_history_off', eventSource: 'computer' }),
          src('event_seen', 'forsion', '活动日志'),
          src('plugin:demo:ping', 'plugin', '示例插件事件', { eventSource: 'plugin' }),
        ] }
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
    const autoButton = win.locator('button.rb-space[aria-label="自动化"], button.rb-space[aria-label="Automation"]').first()
    // 10-02 起上区只常驻 5 个 Space,自动化缺省收在「…」里:先点「…」展开再点,点完 collapse() 收起。
    const revealAuto = async () => { if (!(await autoButton.isVisible().catch(() => false))) { await win.locator('.rb-top .rb-more').first().click().catch(() => {}); await win.waitForTimeout(300) } }
    const collapse = () => win.evaluate(() => document.querySelector('.rb-open-top .rb-more')?.click())
    await revealAuto()
    if (await autoButton.count()) { await autoButton.click(); await collapse() } else await openSpace()
    await win.waitForSelector('.auto-home')
    const showGuide = async () => {
      await win.getByRole('button', { name: '自动化操作', exact: true }).click()
      await win.getByRole('menuitem', { name: '入门与模板', exact: true }).click()
    }
    check('shared workspace collects navigation above the list in two compact rows', await win.locator('.t2sw-plug-list').evaluate((el) => el.getBoundingClientRect().top - el.closest('.t2sw-plug').getBoundingClientRect().top < 90))
    check('first visit offers four real starter templates', await win.locator('.auto-starter').count() === 4)
    await win.screenshot({ path: path.join(OUT, 'home-zh.png') })
    for (const label of ['Muse 巡检', '史官记忆维护']) {
      await win.locator('.t2sw-plug').getByText(label, { exact: true }).click()
      await win.getByRole('button', { name: '运行结果', exact: true }).click()
      await win.locator('.wb-extend .auto-runs').waitFor()
      check(`${label} keeps its history entry in Extend View`, true)
      await win.locator('.wb-extend-close').click()
      await win.locator('.wb-extend').waitFor({ state: 'detached' })
    }
    await showGuide()
    await win.locator('.auto-starter').first().click()
    await win.waitForSelector('.auto-canvas')
    check('starter opens trigger, notification, review nodes without saving', await win.locator('.auto-flow-node').count() === 3 && requests.length === 0)
    check('native Workspace source renders the automation navigation', await win.locator('.t2sw-plug').count() === 1 && await win.locator('.auto-list').count() === 0)
    check('canvas starts with native chrome and no permanent inspector', await win.locator('.amx-stage-hud').count() === 1 && await win.locator('.auto-inspector').count() === 0)
    await win.screenshot({ path: path.join(OUT, 'canvas-clean-zh.png') })
    await win.locator('.auto-flow-node').first().click()
    await win.getByRole('textbox', { name: '名称', exact: true }).fill('Canvas regression')
    const node = win.locator('.auto-flow-node').nth(1)
    await node.click()
    check('node configuration opens in a native Extend View', await win.locator('.wb-extend .auto-inspector').count() === 1)
    const visibleNode = win.locator('.auto-inspector .auto-node:not([hidden])')
    const title = visibleNode.locator('input[type="text"]').first()
    await title.fill('First notification')
    const bodyField = visibleNode.locator('textarea')
    await bodyField.fill('Run at: ')
    await bodyField.press('End')
    await visibleNode.locator('.auto-template-field').nth(1).getByRole('combobox').selectOption('{{now}}')
    check('variable picker inserts into the focused field', await bodyField.inputValue() === 'Run at: {{now}}')
    await win.locator('.wb-extend-close').click()
    await win.locator('.wb-extend').waitFor({ state: 'detached' })
    await node.click()
    await visibleNode.waitFor()
    check('closing and reopening the same node preserves its draft', await bodyField.inputValue() === 'Run at: {{now}}')
    await node.hover()
    const before = await node.boundingBox()
    const worldBefore = await node.evaluate((el) => parseFloat(el.style.left))
    const lineBefore = await win.locator('.auto-canvas-edges > path').first().getAttribute('d')
    await win.mouse.move(before.x + 80, before.y + 35)
    await win.mouse.down()
    await win.mouse.move(before.x + 140, before.y + 45, { steps: 10 })
    await win.mouse.up()
    await win.waitForFunction((left) => parseFloat(document.querySelectorAll('.auto-flow-node')[1].style.left) !== left, worldBefore)
    check('dragging moves a node and updates its connector', await node.evaluate((el) => parseFloat(el.style.left)) > worldBefore + 20 && await win.locator('.auto-canvas-edges > path').first().getAttribute('d') !== lineBefore)
    check('dragging keeps execution numbering', (await node.innerText()).startsWith('1.'))
    const canvas = win.locator('.auto-canvas')
    const transformBefore = await win.locator('.auto-canvas-world').getAttribute('style')
    await canvas.hover({ position: { x: 20, y: 20 } })
    await win.mouse.wheel(30, 60)
    await win.waitForFunction((before) => document.querySelector('.auto-canvas-world')?.getAttribute('style') !== before, transformBefore)
    check('trackpad scrolling pans the workflow canvas', true)
    await win.getByRole('button', { name: '适应内容', exact: true }).click()
    await win.getByRole('button', { name: '放大', exact: true }).click()
    await win.getByRole('button', { name: '缩小', exact: true }).click()
    await win.getByRole('button', { name: '添加步骤', exact: true }).click()
    await win.getByRole('menuitem', { name: '通知', exact: true }).click()
    await visibleNode.locator('input[type="text"]').first().fill('Second notification')
    await visibleNode.getByRole('button', { name: '上移', exact: true }).click()
    check('step reorder updates canvas numbering', (await win.locator('.auto-flow-node').nth(1).innerText()).includes('Second notification'))
    const noOverlap = await win.locator('.auto-flow-node').evaluateAll((nodes) => nodes.every((a, i) => nodes.slice(i + 1).every((b) => {
      const x = a.getBoundingClientRect(), y = b.getBoundingClientRect()
      return x.right <= y.left || y.right <= x.left || x.bottom <= y.top || y.bottom <= x.top
    })))
    check('structural edits reflow previously dragged nodes without overlap', noOverlap)
    await win.locator('[role=menuitem]').first().waitFor({ state: 'detached' }) // 菜单有退场动画
    check('step choices are collected in the shared menu', await win.locator('.auto-canvas-tools button').count() === 2)
    check('canvas controls do not scroll out of their viewport after editing', await win.locator('.auto-canvas').evaluate((el) => {
      const stage = el.getBoundingClientRect(), tools = el.querySelector('.auto-canvas-tools').getBoundingClientRect()
      return el.scrollTop === 0 && el.scrollLeft === 0 && tools.top >= stage.top && tools.left >= stage.left
    }))
    await win.screenshot({ path: path.join(OUT, 'canvas-zh.png') })
    await win.getByRole('button', { name: '保存为暂停', exact: true }).click()
    await win.waitForSelector('.auto-detail-flow')
    check('new rule is saved paused with the chosen action order', requests[0].enabled === false && requests[0].actions[0].title === 'Second notification' && requests[0].actions[1].body === 'Run at: {{now}}')
    check('saving selects the returned rule immediately', await win.locator('.auto-detail .auto-card-title').innerText() === 'Canvas regression')
    await win.locator('.auto-detail').getByRole('button', { name: '试跑', exact: true }).click()
    await win.locator('.auto-extension .auto-execution-error').waitFor()
    check('run results expose every step and full failure text', (await win.locator('.auto-extension .auto-executions').innerText()).includes('Could not deliver the second notification'))
    await win.waitForFunction(() => document.querySelector('.wb-extend')?.getBoundingClientRect().width >= 300)
    await win.screenshot({ path: path.join(OUT, 'results-zh.png') })
    failExecutions = true
    await win.locator('.auto-detail').getByRole('button', { name: '试跑', exact: true }).click()
    await win.locator('.auto-extension [role="alert"]').waitFor()
    check('ledger loading failure offers recovery instead of an empty history', (await win.locator('.auto-extension [role="alert"]').innerText()).includes('无法读取运行记录'))
    failExecutions = false
    await win.locator('.auto-extension').getByRole('button', { name: '重试', exact: true }).click()
    await win.locator('.auto-extension .auto-executions').waitFor()
    check('ledger retry restores the execution results', true)
    await win.getByRole('button', { name: '更多操作', exact: true }).click()
    await win.getByRole('menuitem', { name: '启用', exact: true }).click()
    await win.waitForFunction(() => document.querySelector('.auto-detail .auto-status-label')?.textContent === '已启用')
    check('enabling preserves the complete action chain', requests.at(-1).enabled && requests.at(-1).actions.length === 2)
    await win.locator('.t2sw-plug .t2s-search input').fill('not-a-rule')
    check('sidebar search filters saved rules', await win.locator('.t2sw-plug-list .t2s-srow').filter({ hasText: 'Canvas regression' }).count() === 0)
    await win.locator('.t2sw-plug .t2s-search input').fill('')
    await win.locator('.auto-detail').getByRole('button', { name: '编辑', exact: true }).click()
    await win.waitForSelector('.auto-canvas')
    check('editing preserves enabled state', await win.getByRole('button', { name: '保存并启用', exact: true }).isEnabled())
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 820))
    await win.screenshot({ path: path.join(OUT, 'canvas-narrow-flow-zh.png') })
    await win.locator('.auto-flow-node').nth(1).click()
    await win.waitForFunction(() => document.querySelector('.wb-extend')?.getBoundingClientRect().width >= 240)
    const geometry = await win.locator('.auto-workflow-builder').evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth, visible: !!document.querySelector('.wb-extend .auto-inspector input') }))
    check('narrow canvas uses the native configuration panel without horizontal overflow', geometry.scroll <= geometry.width + 1 && geometry.visible)
    check('narrow configuration labels remain readable', await visibleNode.locator('.auto-node-head').evaluate((el) => el.getBoundingClientRect().height < 65))
    await win.screenshot({ path: path.join(OUT, 'canvas-narrow-zh.png') })
    await win.getByRole('button', { name: '取消', exact: true }).click()
    await showGuide()
    await win.locator('.auto-starter').nth(1).click()
    check('agent template explains the missing selection', (await win.locator('.auto-save-status').innerText()).includes('选择执行任务的 Agent') && await win.getByRole('button', { name: '保存为暂停', exact: true }).isDisabled())
    await win.locator('.auto-save-status button').click()
    check('validation navigates to the incomplete node', await visibleNode.locator('select').first().isVisible())
    await visibleNode.locator('select').first().selectOption('writer')
    check('selecting an agent completes the template', await win.getByRole('button', { name: '保存为暂停', exact: true }).isEnabled())
    await win.getByRole('button', { name: '取消', exact: true }).click()
    await showGuide()
    await win.locator('.auto-starter').first().click()
    await win.locator('.auto-flow-node').first().click()
    await win.getByRole('textbox', { name: '名称', exact: true }).fill('Registry rule')
    await win.locator('[data-trigger-group]').first().waitFor()
    check('trigger menu is grouped from the registry', (await win.locator('[data-trigger-group]').evaluateAll((els) => els.map((e) => e.dataset.triggerGroup))).join() === 'time,computer,forsion,external')
    check('three timers stay one menu item and plugin sources join External', await win.locator('[data-trigger="timer"]').count() === 1 && await win.locator('[data-trigger-group="external"] [data-trigger="plugin:demo:ping"]').count() === 1)
    check('a source without its permission is listed but disabled', await win.locator('[data-trigger="computer.unlocked"]').isDisabled())
    await win.locator('[data-trigger="computer.app_opened"]').click()
    await win.locator('input[aria-label="app"]').fill('Figma')
    await win.locator('[data-rule-only]').getByRole('button', { name: '工作日', exact: true }).click()
    await win.screenshot({ path: path.join(OUT, 'trigger-menu-zh.png') })
    await win.getByRole('button', { name: '保存为暂停', exact: true }).click()
    await win.locator('.auto-detail .auto-card-title').filter({ hasText: 'Registry rule' }).waitFor()
    const saved = requests.at(-1)
    check('a registry source saves its params and only-conditions', saved.cond_type === 'computer.app_opened' && saved.params?.app === 'Figma' && saved.only?.weekdays?.join() === '1,2,3,4,5')
    // 观察档:规则卡头三段控件 → 运行结果「本应执行」→ 编辑不转正 → 只有用户点启用才转正
    const state = win.locator('.auto-card-head [role="radiogroup"]')
    const pick = async (name) => { const n = requests.length; await state.getByRole('radio', { name, exact: true }).click(); while (requests.length === n) await win.waitForTimeout(50); await state.locator('[aria-checked="true"]').filter({ hasText: name }).waitFor() }
    check('a rule offers pause, observe and enable', (await state.getByRole('radio').allInnerTexts()).join() === '暂停,观察,启用')
    await pick('观察')
    check('observe keeps the rule on and sends observe', requests.at(-1).enabled === true && requests.at(-1).observe === true)
    await win.locator('.t2s-srow', { hasText: 'Registry rule' }).getByText('观察中').waitFor()
    check('the list says the rule is observing', true)
    check('the card warns that test runs are real', /试跑仍会真实执行/.test(await win.locator('.auto-detail').innerText()))
    executions.length = 0
    executions.push({ id: 'exec-observed', trigger_id: rules[0].id, origin: 'auto', status: 'observed', created_at: new Date().toISOString(), error: null, steps: [{ type: 'agent_run', ok: true, observed: true, target: 'writer', row: 'Attention Residuals', summary: '写 200 字摘要' }] })
    await win.locator('.auto-card-head').getByRole('button', { name: '运行结果', exact: true }).click()
    const observed = win.locator('.auto-execution').first()
    await observed.getByText('本应执行', { exact: true }).waitFor()
    await win.screenshot({ path: path.join(OUT, 'observed-runs.png') })
    check('runs show what would have run and how far it has come', /Attention Residuals/.test(await observed.innerText()) && /writer/.test(await observed.innerText()) && /没有执行任何动作/.test(await observed.innerText()) && await win.getByText('观察 2 天 · 命中 1 次', { exact: true }).isVisible())
    check('an observed row uses the hollow dot', await observed.locator('.auto-dot.observed').count() === 1)
    await win.keyboard.press('Escape')
    await pick('暂停')
    check('pausing leaves observe alone', requests.at(-1).enabled === false && !('observe' in requests.at(-1)))
    await win.locator('.auto-card-head').getByRole('button', { name: '编辑', exact: true }).click()
    await win.locator('.auto-builder-footer').waitFor()
    check('a paused rule can still be saved to observe', await win.locator('.auto-builder-footer').getByRole('button', { name: '保存并观察', exact: true }).isVisible())
    await win.locator('.auto-builder-footer').getByRole('button', { name: '保存并观察', exact: true }).click()
    await win.locator('.auto-card-head [aria-checked="true"]').filter({ hasText: '观察' }).waitFor()
    check('save and observe turns the rule on', requests.at(-1).enabled === true && requests.at(-1).observe === true)
    await win.locator('.auto-card-head').getByRole('button', { name: '编辑', exact: true }).click()
    await win.locator('.auto-builder-footer').waitFor()
    check('editing an observing rule never offers save and enable', await win.locator('.auto-builder-footer').getByRole('button', { name: '保存并启用', exact: true }).count() === 0)
    await win.locator('.auto-builder-footer').getByRole('button', { name: '保存并观察', exact: true }).click()
    await win.locator('.auto-card-head [aria-checked="true"]').filter({ hasText: '观察' }).waitFor()
    check('saving an edit keeps it observing without sending observe', requests.at(-1).enabled === true && !('observe' in requests.at(-1)))
    await pick('启用')
    check('only the user turns it on, with observe false', requests.at(-1).enabled === true && requests.at(-1).observe === false)
    await win.evaluate(() => { localStorage.setItem('tangu_locale', 'en'); localStorage.setItem('forsion_theme', 'dark') })
    await win.reload({ waitUntil: 'domcontentloaded' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000))
    await win.waitForSelector('.dv-groupview', { timeout: 40000 })
    await revealAuto()
    await autoButton.click()
    await collapse()
    await win.locator('.auto-home').waitFor({ timeout: 30000 })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000))
    await win.locator('.auto-starter').first().click()
    await win.locator('.auto-canvas').waitFor()
    await win.screenshot({ path: path.join(OUT, 'canvas-en-dark.png') })
    check('English canvas uses translated labels', await win.locator('.auto-canvas').getAttribute('aria-label') === 'Workflow canvas')
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
