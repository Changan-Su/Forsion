/** Calendar 2026-11-12 regression: quoted note tasks, quiet undo, timed → all-day.
 * All files and preferences belong to a throwaway home; no production data is opened.
 * CALENDAR_PLUGIN_DIR=/absolute/Calendar checkout uses its built bundle.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
const OUT = process.env.CALENDAR_NOV12_ARTIFACT_DIR || '/tmp/forsion-calendar-nov12'
const PLUGIN = process.env.CALENDAR_PLUGIN_DIR
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const results = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail ?? '')}`) }
const day = new Date().toLocaleDateString('en-CA')
const before = `${day}T09:00/${day}T10:00`
const note = `# Quoted tasks\n\n> [!fold]- This week\n> - [ ] Quoted task @${day}\n>   - [ ] Attachment\n\n> \`\`\`md\n> - [ ] Example task @${day}\n> \`\`\`\n\nNote appointment @${day}T12:00/${day}T13:00\n`
async function clickSpace(win, labels) {
  await win.waitForFunction(labels => {
    const hit = [...document.querySelectorAll('button.rb-space')].find(b => labels.includes((b.getAttribute('aria-label') || b.getAttribute('title') || '').trim()))
    if (hit) { hit.click(); return true }
    document.querySelector('.rb-more[data-rb-more="top"]:not(.is-open)')?.click()
    return false
  }, labels, { timeout: 30000, polling: 200 })
}
async function waitDisk(file, predicate) {
  for (let n = 0; n < 60; n++) { const text = fs.readFileSync(file, 'utf8'); if (predicate(text)) return text; await new Promise(r => setTimeout(r, 100)) }
  return fs.readFileSync(file, 'utf8')
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-calendar-nov12-'))
  const vault = path.join(home, 'vault'), userdata = path.join(home, 'userdata'), config = `${userdata}-dev`
  fs.mkdirSync(vault); fs.mkdirSync(config)
  const dbFile = path.join(vault, 'events.db'), noteFile = path.join(vault, 'quoted.md')
  fs.writeFileSync(dbFile, JSON.stringify({ version: 1, name: 'Calendar fixture', columns: [{ id: 'name', name: 'Name', type: 'text' }, { id: 'date', name: 'Date', type: 'calendarDate' }], rows: [{ id: 'timed', cells: { name: 'Timed fixture', date: before } }] }, null, 2))
  fs.writeFileSync(noteFile, note)
  fs.writeFileSync(path.join(config, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  if (PLUGIN) for (const f of ['manifest.json', 'main.js', 'spaces', 'widgets']) if (fs.existsSync(path.join(PLUGIN, f))) fs.cpSync(path.join(PLUGIN, f), path.join(home, 'plugins/forsion-calendar', f), { recursive: true })
  const stub = await startStubEngine({ sessions: [], messages: [], models: [] })
  fs.writeFileSync(path.join(config, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'probe' }))
  let app, win
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
    win = await app.firstWindow()
    await skipOnboarding(win)
    await win.locator('.rb').waitFor({ timeout: 30000 })
    await win.evaluate(() => { localStorage.setItem('amadeus.calendar.mode', '3day'); localStorage.setItem('forsion_theme_pref', 'dark') })
    await clickSpace(win, ['笔记', 'Notes'])
    await win.locator('.am-app').first().waitFor({ timeout: 30000 })
    await clickSpace(win, ['日历', 'Calendar'])
    await win.locator('.amx-cal-event[aria-label^="Timed fixture"]').first().waitFor({ timeout: 30000 })
    const task = win.locator('.amx-calside2 .amx-todo-item', { hasText: 'Quoted task' })
    await task.waitFor({ timeout: 10000 })
    check('Quoted task appears in the Calendar Todo sidebar', await task.count() === 1)
    check('Quoted checkbox is not misclassified as a calendar event', await win.locator('.amx-cal-event, .amx-cal-chip-ev').filter({ hasText: 'Quoted task' }).count() === 0)
    check('Quoted fenced example is not a task', await win.locator('.amx-todo-item', { hasText: 'Example task' }).count() === 0)
    await clickSpace(win, ['待办', 'Tasks', 'Todo'])
    const fullTask = win.locator('.amx-todo-item', { hasText: 'Quoted task' })
    await fullTask.first().waitFor({ timeout: 10000 })
    check('Quoted task appears in the Tasks Space', await fullTask.count() === 1)
    await win.screenshot({ path: path.join(OUT, 'quoted-tasks.png') })
    const box = fullTask.getByRole('checkbox').first()
    await box.click()
    const afterCheck = await waitDisk(noteFile, text => text.includes('> - [x] Quoted task') && text.includes('>   - [x] Attachment'))
    check('Checking a quoted task and its child preserves all other Markdown bytes', afterCheck === note.replace('> - [ ] Quoted task', '> - [x] Quoted task').replace('>   - [ ] Attachment', '>   - [x] Attachment'), afterCheck)
    await clickSpace(win, ['日历', 'Calendar'])
    await win.locator('.amx-cal-tscroll').waitFor({ timeout: 10000 })
    const align = async () => {
      await win.evaluate(day => {
        const sc = document.querySelector('.amx-cal-tscroll'), col = document.querySelector(`.amx-cal-daycol2[data-date="${day}"]`)
        const hp = parseFloat(getComputedStyle(document.querySelector('.amx-cal-timerow')).getPropertyValue('--amx-hour-px')) || 44
        sc.scrollLeft = col.offsetLeft; sc.scrollTop = col.offsetTop + 7 * hp
        sc.dispatchEvent(new Event('scroll'))
      }, day)
      await win.waitForTimeout(250)
    }
    await align()
    const points = await win.evaluate(day => {
      const e = document.querySelector('.amx-cal-event[aria-label^="Timed fixture"]').getBoundingClientRect()
      const a = document.querySelector(`.amx-cal-allday2[data-date="${day}"]`).getBoundingClientRect()
      return { from: { x: e.left + e.width / 2, y: e.top + e.height / 2 }, to: { x: a.left + a.width / 2, y: a.top + a.height / 2 } }
    }, day)
    await win.mouse.move(points.from.x, points.from.y); await win.mouse.down()
    await win.mouse.move(points.to.x, points.to.y, { steps: 20 })
    await win.waitForTimeout(120)
    check('Dragging a timed event to the all-day row shows an all-day preview', await win.locator('.amx-cal-making').filter({ hasText: /全天|All day/ }).isVisible())
    const previewBox = await win.locator('.amx-cal-making').evaluate(el => ({ height: el.clientHeight, contentHeight: el.scrollHeight, width: el.clientWidth }))
    check('The narrow all-day preview never clips a wrapped second line', previewBox.height > 0 && previewBox.contentHeight <= previewBox.height + 1, previewBox)
    await win.screenshot({ path: path.join(OUT, 'all-day-preview.png') })
    await win.mouse.up()
    let disk = await waitDisk(dbFile, text => JSON.parse(text).rows[0].cells.date === day)
    check('Dropping to all-day persists a date without hidden times', JSON.parse(disk).rows[0].cells.date === day, disk)
    check('Rescheduling does not add a success toast', await win.locator('.ntf').filter({ hasText: /已改期|reschedul/i }).count() === 0)
    await win.keyboard.press(`${MOD}+z`)
    disk = await waitDisk(dbFile, text => JSON.parse(text).rows[0].cells.date === before)
    check('Undo restores the exact previous timed interval', JSON.parse(disk).rows[0].cells.date === before)
    await win.keyboard.press(`${MOD}+Shift+z`)
    disk = await waitDisk(dbFile, text => JSON.parse(text).rows[0].cells.date === day)
    check('Redo restores the all-day value', JSON.parse(disk).rows[0].cells.date === day)
    await win.locator(`.amx-cal-allday2[data-date="${day}"] .amx-cal-chip-ev`, { hasText: 'Timed fixture' }).click()
    const card = win.locator('.amx-cal-cardwrap')
    await card.waitFor()
    await card.locator('.amx-cal-card-timebtn').click()
    const allDay = card.locator('[data-calendar-all-day]')
    check('Event time editor exposes the checked all-day option', await allDay.isChecked())
    await allDay.uncheck()
    disk = await waitDisk(dbFile, text => JSON.parse(text).rows[0].cells.date === before)
    check('All-day can be changed back to a timed event', JSON.parse(disk).rows[0].cells.date === before)
    await allDay.check()
    disk = await waitDisk(dbFile, text => JSON.parse(text).rows[0].cells.date === day)
    check('Timed event can be changed back to all-day through its editor', JSON.parse(disk).rows[0].cells.date === day)
    await win.screenshot({ path: path.join(OUT, 'all-day-editor.png') })
  } catch (error) {
    await win?.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {})
    console.log(await win?.locator('body').innerText().catch(() => ''))
    throw error
  } finally {
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2))
    await app?.close(); await stub.close(); fs.rmSync(home, { recursive: true, force: true })
  }
  assert.ok(results.length && results.every(r => r.ok), 'Calendar November regression; see report.json')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
