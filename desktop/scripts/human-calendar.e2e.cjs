/** 默认日历 human/CALENDAR.db(10-21)真 Electron × 真引擎(托管模式,本检出 tangu-agent/dist)× 隔离 home:
 *  ① 日历视图读得到引擎家目录里那份、排在日历列表第一 ② 没设过默认库时新建事件落进 human/,库里的表不动
 *  ③ 别的设备同步下来(这里直接改磁盘)后,切回窗口就看得到。
 *  用法:先 npm run build(桌面)+ tangu-agent 的 npm run build;node scripts/human-calendar.e2e.cjs。截图在 HUMAN_CAL_OUT(缺省系统临时目录)。 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const { enterSpace } = require('./lib/uiux-electron.cjs')

const ROOT = path.resolve(__dirname, '..')
const OUT = process.env.HUMAN_CAL_OUT || path.join(os.tmpdir(), 'forsion-human-calendar')
const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`) }
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const db = (name, rows) => `${JSON.stringify({ version: 2, name, columns: [{ id: 'name', name: '名称', type: 'text' }, { id: 'date', name: '日期', type: 'calendarDate' }, { id: 'done', name: '完成', type: 'checkbox' }], rows }, null, 2)}\n`
const names = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).rows.map((r) => r.cells.name)

async function slotPoint(win, iso, min) {
  return win.evaluate(({ iso, min }) => {
    const cell = document.querySelector(`.amx-cal-daycol2[data-date="${iso}"]`)
    const timerow = document.querySelector('.amx-cal-timerow')
    if (!cell || !timerow) return null
    const r = cell.getBoundingClientRect()
    const zoom = cell.currentCSSZoom || 1
    const hourPx = parseFloat(getComputedStyle(timerow).getPropertyValue('--amx-hour-px')) || 44
    return { x: r.left + r.width / 2, y: r.top + ((min / 60) * hourPx + 4) * zoom }
  }, { iso, min })
}

async function main() {
  for (const f of ['out/main/main.js', '../tangu-agent/dist/standalone/main.js']) if (!fs.existsSync(path.join(ROOT, f))) throw new Error(`缺 ${f} —— 先 build`)
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-human-cal-'))
  const vault = path.join(home, 'vault')
  const workspace = path.join(home, 'workspace')
  const humanCal = path.join(home, 'tangu', 'human', 'CALENDAR.db')
  const d0 = ymd(new Date())
  fs.mkdirSync(vault, { recursive: true }); fs.mkdirSync(path.dirname(humanCal), { recursive: true })
  fs.writeFileSync(path.join(vault, '欢迎.md'), '# 默认日历检查\n')
  const VAULT_DB = path.join(vault, '产品日历.db')
  fs.writeFileSync(VAULT_DB, db('产品日历', [{ id: 'review', cells: { name: '评审会', date: `${d0}T15:00/${d0}T16:00` } }]))
  fs.writeFileSync(humanCal, db('我的日历', [{ id: 'dentist', cells: { name: '看牙医', date: `${d0}T10:00/${d0}T11:00` } }]))
  for (const dir of [path.join(home, 'userdata'), path.join(home, 'userdata-dev')]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed', sandbox: 'none', browserEnabled: false, unitHostEnabled: false, defaultWorkspaceDir: workspace }))
  }
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BROWSER_CDP: 'off', TANGU_HARNESS_QUIET: '1' },
  })
  const errors = []
  try {
    const win = await app.firstWindow({ timeout: 60_000 })
    win.on('pageerror', (e) => errors.push(e.message))
    await win.setViewportSize({ width: 1440, height: 900 })
    await win.waitForSelector('#root', { timeout: 40_000 })
    await skipOnboarding(win)
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    const ready = await win.waitForFunction(async () => (await window.tangu.getConfig()).backendState?.state === 'ready', null, { timeout: 120_000 }).then(() => true, () => false)
    check('前置:托管模式,本检出的引擎就绪', ready)
    check('进笔记(让库就绪)', await enterSpace(win, 'amadeus'))
    await win.waitForSelector('.am-app', { timeout: 30_000 })
    await win.waitForTimeout(2000)
    check('进日历', await enterSpace(win, 'calendar'))
    await win.waitForSelector('.amx-cal', { timeout: 30_000 })
    const seen = await win.waitForSelector('.amx-cal-event[aria-label^="看牙医"]', { timeout: 20_000 }).then(() => true, () => false)
    check('① human/CALENDAR.db 里的事件出现在日历上', seen)
    const legend = await win.evaluate(() => [...document.querySelectorAll('.amx-calcfg-row .amx-calcfg-name')].map((e) => e.textContent.trim()))
    check('① 日历列表里「我的日历」排第一,库里的表照常在', legend[0] === '我的日历' && legend.includes('产品日历'), JSON.stringify(legend))

    // 网格滚到今天中午附近,13:00 那格才在可视区里(同 calendar-ui 的 alignWeekGrid)
    await win.evaluate((iso) => {
      const sc = document.querySelector('.amx-cal-tscroll'), cell = document.querySelector(`.amx-cal-daycol2[data-date="${iso}"]`)
      const hourPx = parseFloat(getComputedStyle(document.querySelector('.amx-cal-timerow')).getPropertyValue('--amx-hour-px')) || 44
      sc.scrollLeft = Math.max(0, cell.offsetLeft - (sc.clientWidth - cell.clientWidth) / 2)
      sc.scrollTop = Math.max(0, cell.offsetTop + 9 * hourPx)
      sc.dispatchEvent(new Event('scroll'))
    }, d0)
    await win.waitForTimeout(350)
    const p = await slotPoint(win, d0, 13 * 60)
    await win.mouse.click(p.x, p.y)
    await win.waitForSelector('.amx-cal-event.amx-cal-draft', { timeout: 3000 }).catch(async (e) => { await win.screenshot({ path: path.join(OUT, 'no-draft.png') }); throw e })
    await win.keyboard.type('新建到我的日历')
    await win.keyboard.press('Enter')
    let wrote = false
    for (let i = 0; i < 40 && !wrote; i++) { await win.waitForTimeout(250); wrote = names(humanCal).includes('新建到我的日历') }
    check('② 没设过默认库:新建事件写进 human/CALENDAR.db', wrote, JSON.stringify(names(humanCal)))
    check('② 库里的表没被写', JSON.stringify(names(VAULT_DB)) === JSON.stringify(['评审会']))

    // 别的设备同步下来:引擎那份变了(这里直接改磁盘),回到窗口时比一下版本、变了就重读
    const cur = JSON.parse(fs.readFileSync(humanCal, 'utf8'))
    cur.rows.push({ id: 'synced', cells: { name: '同步来的', date: `${d0}T17:00/${d0}T17:30` } })
    fs.writeFileSync(humanCal, `${JSON.stringify(cur, null, 2)}\n`)
    await win.evaluate(() => window.dispatchEvent(new Event('focus')))
    const synced = await win.waitForSelector('.amx-cal-event[aria-label^="同步来的"]', { timeout: 8000 }).then(() => true, () => false)
    check('③ 磁盘上那份变了,切回窗口后日历跟上', synced)
    check('③ 刚建的那条还在', (await win.locator('.amx-cal-event[aria-label^="新建到我的日历"]').count()) > 0)
    await win.screenshot({ path: path.join(OUT, 'human-calendar.png') })
    check('没有页面异常', errors.length === 0, errors.slice(0, 3).join(' / '))
  } finally {
    await app.close().catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
  }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} passed;截图 ${path.join(OUT, 'human-calendar.png')}`)
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
