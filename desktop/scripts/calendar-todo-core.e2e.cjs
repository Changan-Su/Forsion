/** Compiled Electron, real core bundle seeding + IPC + vault files. No user profile is touched. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.resolve(__dirname, '..')
const OUT = process.env.CALENDAR_TODO_OUT || path.join(os.tmpdir(), 'forsion-calendar-todo-core')
const results = []
function pass(name, value = true) { assert.ok(value, name); results.push(name); console.log(`PASS ${results.length}: ${name}`) }
const pad = (n) => String(n).padStart(2, '0')
const day = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` }
const columns = [{ id: 'name', name: '事项', type: 'text' }, { id: 'date', name: '日期', type: 'calendarDate' }, { id: 'done', name: '完成', type: 'checkbox' }]
async function space(win, id) {
  const button = win.locator(`button.rb-space[data-space-id="${id}"]`)
  if (!await button.isVisible().catch(() => false)) {
    await win.locator('[data-rb-more="top"]').click()
  }
  await button.click()
}
async function fixture(empty, stub) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-todo-accept-'))
  const vault = path.join(home, 'vault'), user = path.join(home, 'userdata')
  fs.mkdirSync(vault); fs.mkdirSync(`${user}-dev`)
  fs.writeFileSync(path.join(vault, 'Welcome.md'), '# Test vault\n')
  if (!empty) fs.writeFileSync(path.join(vault, 'Tasks.db'), JSON.stringify({ version: 1, name: '工作清单', columns, rows: [
    { id: 'one', cells: { name: '整理设计反馈', date: `${day()}T10:00/${day()}T11:00` }, body: '# Existing record body' },
    { id: 'two', cells: { name: '买咖啡豆' } },
  ] }))
  fs.writeFileSync(path.join(`${user}-dev`, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  const app = await electron.launch({ cwd: ROOT, args: [`--user-data-dir=${user}`, '--lang=zh-CN', ROOT], env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url }, timeout: 60000 })
  const win = await app.firstWindow(); const errors = []
  try {
  win.on('pageerror', (e) => errors.push(e.message))
  await win.setViewportSize({ width: 1440, height: 900 }); await win.waitForSelector('#root')
  await win.evaluate(() => localStorage.setItem('forsion_tangu_onboarding_done', '1')); await win.reload()
  // Version-update onboarding is separate from first-run onboarding.
  for (let i = 0; i < 100; i++) {
    const skip = win.getByText('跳过引导', { exact: true }).first()
    if (await skip.isVisible().catch(() => false)) { await skip.click(); break }
    if (await win.locator('button.rb-space[data-space-id="calendar"]').isVisible().catch(() => false)) break
    await win.waitForTimeout(200)
  }
  await win.locator('button.rb-space[data-space-id="calendar"]').waitFor({ timeout: 45000 })
  await win.locator('style[data-plugin="forsion-calendar"]').waitFor({ state: 'attached', timeout: 30000 })
  return { app, win, home, vault, errors, cleanup: async () => { await app.close(); fs.rmSync(home, { recursive: true, force: true }) } }
  } catch (e) { await win.screenshot({ path: path.join(OUT, 'boot-failure.png') }).catch(() => {}); await app.close(); fs.rmSync(home, { recursive: true, force: true }); throw e }
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const stub = await startStubEngine({ models: [{ id: 'test', name: 'Test', provider: 'stub', contextWindow: 128000, thinkingLevels: ['off'] }] })
  let f
  try {
    f = await fixture(false, stub); const { win, vault } = f
    const plugins = await win.evaluate(() => window.amadeus.listPlugins())
    pass('Calendar is seeded as a core plugin', plugins.some((p) => p.id === 'forsion-calendar' && p.preinstalled))
    const updates = await win.evaluate(() => window.tangu.getCorePluginUpdates())
    pass('Calendar participates in the core update chain', updates.items.some((p) => p.id === 'forsion-calendar' && p.packageName === '@forsion/calendar'))
    await space(win, 'calendar')
    await win.locator('.fc-root .amx-cal').waitFor()
    await win.locator('.fc-root .amx-calside2 .amx-todo').waitFor()
    pass('Native Calendar Space keeps the plugin-rendered calendar and Todo companion')
    pass('No duplicate Calendar Space', await win.locator('[data-space-id="forsion-calendar"]').count() === 0)
    await win.getByRole('button', { name: '显示选项', exact: true }).click()
    await win.getByRole('group', { name: '时间刻度', exact: true }).waitFor()
    await win.waitForTimeout(250)
    pass('Display settings use a compact semantic scale', !(await win.locator('.fc-menu:popover-open').innerText()).includes('px'))
    await win.screenshot({ path: path.join(OUT, 'calendar-menu-light.png') }); await win.keyboard.press('Escape')
    const originalEvent = win.locator('.fc-view-calendar [data-key="Tasks.db::one"]').first()
    await originalEvent.click()
    await win.locator('.fc-record .plugin-record').waitFor()
    pass('Existing Calendar events open the native record editor through the plugin')
    await win.keyboard.press('Escape')
    await originalEvent.click({ button: 'right' })
    await win.getByRole('menuitem', { name: '克隆', exact: true }).click()
    await win.waitForTimeout(800)
    pass('The event menu clones the full native record', JSON.parse(fs.readFileSync(path.join(vault, 'Tasks.db'), 'utf8')).rows.filter((r) => r.body === '# Existing record body').length === 2)
    await win.locator('.ntf-action', { hasText: '撤销' }).last().click()
    await win.waitForTimeout(800)
    pass('Event-menu undo removes only the cloned record', JSON.parse(fs.readFileSync(path.join(vault, 'Tasks.db'), 'utf8')).rows.length === 2)
    await space(win, 'forsion-todo')
    const root = win.locator('.fc-view-todo .amx-todo')
    await root.locator('[data-task="db:Tasks.db:one"]').waitFor()
    pass('Independent Tasks Space opens the same new renderer')
    const input = root.getByRole('textbox', { name: '添加待办', exact: true })
    await input.fill('记录一个想法'); await input.press('Enter')
    await root.getByText('记录一个想法', { exact: true }).waitFor()
    await win.waitForTimeout(900)
    const db = () => JSON.parse(fs.readFileSync(path.join(vault, 'Tasks.db'), 'utf8'))
    pass('Quick add persists without inventing a date', db().rows.some((r) => r.cells.name === '记录一个想法' && !r.cells.date))
    pass('Input clears and keeps focus for the next task', await input.inputValue() === '' && await input.evaluate((e) => document.activeElement === e))
    await input.fill('明天 提交材料'); await input.press('Enter')
    await root.getByText('提交材料', { exact: true }).waitFor(); await win.waitForTimeout(800)
    pass('Natural-language date persists', !!db().rows.find((r) => r.cells.name === '提交材料')?.cells.date)
    const one = root.locator('[data-task="db:Tasks.db:one"]')
    await one.getByRole('checkbox').click()
    await one.getByRole('checkbox', { checked: true }).waitFor()
    pass('Completion immediately checks and lingers in place', await one.isVisible())
    await win.locator('.ntf-action', { hasText: '撤销' }).last().click()
    await one.getByRole('checkbox', { checked: false }).waitFor(); await win.waitForTimeout(800)
    pass('Undo restores the real row and body', db().rows.find((r) => r.id === 'one').cells.done !== true && db().rows.find((r) => r.id === 'one').body === '# Existing record body')
    const geo = await root.locator('.amx-todo-item').first().evaluate((el) => ({ h: el.getBoundingClientRect().height, font: getComputedStyle(el.querySelector('.amx-todo-name')).fontSize }))
    pass('Desktop rows use compact native density', geo.h <= 36 && parseFloat(geo.font) <= 13)
    await win.screenshot({ path: path.join(OUT, 'todo-light.png') })
    const modeButton = win.getByRole('button', { name: '切换明暗模式', exact: true })
    if (!await modeButton.isVisible().catch(() => false)) await win.locator('[data-rb-more="bottom"]').click()
    await modeButton.click()
    await win.waitForFunction(() => document.documentElement.dataset.mode === 'dark')
    await win.waitForTimeout(400)
    await win.screenshot({ path: path.join(OUT, 'todo-dark.png') })
    // @forsion/calendar 0.1.2+ 把宽档的筛选分段收进「待办选项」菜单、标题跟着筛选走;旧版仍是分段按钮。两版都认。
    const seg = root.locator('.amx-todo-seg')
    if (await seg.count()) await seg.getByRole('button', { name: '今天', exact: true }).click()
    else { await root.getByRole('button', { name: '待办选项', exact: true }).click(); await win.getByRole('menuitemcheckbox', { name: '今天', exact: true }).click() }
    await space(win, 'calendar'); await space(win, 'forsion-todo')
    const todayOn = await seg.count() ? await seg.getByRole('button', { name: '今天', exact: true }).getAttribute('aria-pressed') === 'true' : (await root.locator('.amx-todo-title').innerText()).trim() === '今天'
    pass('Filters survive Space navigation', todayOn)
    pass('No renderer exceptions', !f.errors.length)
    await f.cleanup(); f = null; f = await fixture(true, stub)
    await space(f.win, 'forsion-todo')
    const blank = f.win.locator('.fc-view-todo .amx-todo')
    await blank.getByRole('textbox', { name: '添加待办', exact: true }).fill('我的第一条待办')
    await blank.getByRole('button', { name: '创建待办清单并添加', exact: true }).click()
    await blank.getByText('我的第一条待办', { exact: true }).waitFor({ timeout: 20000 })
    const created = fs.readdirSync(path.join(f.vault, 'Plugins'), { recursive: true }).filter((p) => String(p).endsWith('.db'))
    pass('Empty vault explicitly creates an ordinary task database', created.length === 1)
    await f.win.screenshot({ path: path.join(OUT, 'todo-empty-first-task.png') })
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ vehicle: 'compiled Electron + real IPC and vault files', passed: results, errors: f.errors }, null, 2))
    console.log(`Evidence: ${OUT}`)
  } catch (e) {
    if (f) { await f.win.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(OUT, 'failure.txt'), await f.win.locator('body').innerText().catch(() => '')); console.error(f.errors) }
    throw e
  } finally { if (f) await f.cleanup(); await stub.close() }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
