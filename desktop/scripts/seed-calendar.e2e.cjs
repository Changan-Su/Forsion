/** 库里不再种 Calendar.db(10-30)真 Electron × 真引擎(托管模式,本检出 tangu-agent/dist)× 隔离 home,每种情况各起一次:
 *  fresh   新用户:库里没有 Calendar.db,日历 Space 能用,新建事件落进 human/CALENDAR.db,文件也不会被镜像写回来
 *  seed    老用户没动过种子:挪进库回收站,应用里只剩默认日历
 *  used    老用户有数据:原地不动,事件照常在日历上
 *  corrupt 文件损坏:开库不动它,也不搬进 human/,日历 Space 照常能建事件;第一次写之后镜像才换掉它,原文留成 human/ 里的副本
 *  down    新用户 + 引擎不通(拦掉接口,等于 status: 'missing'):日历 Space 打得开,接口恢复后默认日历自己回来,能建事件
 *  用法:先 npm run build(桌面)+ tangu-agent 的 npm run build;node scripts/seed-calendar.e2e.cjs。ONLY=seed 只跑点名的;截图在 SEED_CAL_OUT。 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const { enterSpace } = require('./lib/uiux-electron.cjs')

const ROOT = path.resolve(__dirname, '..')
const OUT = process.env.SEED_CAL_OUT || path.join(os.tmpdir(), 'forsion-seed-calendar')
const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`) }
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const today = ymd(new Date())
const plus = (n) => ymd(new Date(Date.now() + n * 86_400_000))
const columns = [{ id: 'a', name: '名称', type: 'text' }, { id: 'b', name: '日期', type: 'calendarDate' }, { id: 'c', name: '完成', type: 'checkbox' }]
const seedRows = [
  { id: 's1', cells: { a: '欢迎使用 Calendar Space', b: `${today}T10:00/${today}T11:00`, c: true } },
  { id: 's2', cells: { a: '整理本周任务', b: plus(1) } },
  { id: 's3', cells: { a: '项目评审', b: `${plus(2)}T14:00/${plus(2)}T15:30` } },
]
const db = (rows) => `${JSON.stringify({ version: 1, name: '我的日历', columns, rows }, null, 2)}\n`
const SEEDS = { seed: db(seedRows), used: db([...seedRows, { id: 'mine', cells: { a: '看牙医', b: `${today}T09:00/${today}T09:30` } }]), corrupt: '{"version":1,"name":"我的日' }

const HUMAN_API = '**/agent/human/CALENDAR.db'

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

/** 网格滚到今天中午附近,点 13:00 那格,打标题回车:和用户新建事件同一条路。 */
async function createEvent(win, title) {
  await win.evaluate((iso) => {
    const sc = document.querySelector('.amx-cal-tscroll'), cell = document.querySelector(`.amx-cal-daycol2[data-date="${iso}"]`)
    const hourPx = parseFloat(getComputedStyle(document.querySelector('.amx-cal-timerow')).getPropertyValue('--amx-hour-px')) || 44
    sc.scrollLeft = Math.max(0, cell.offsetLeft - (sc.clientWidth - cell.clientWidth) / 2)
    sc.scrollTop = Math.max(0, cell.offsetTop + 9 * hourPx)
    sc.dispatchEvent(new Event('scroll'))
  }, today)
  await win.waitForTimeout(350)
  const p = await slotPoint(win, today, 13 * 60)
  await win.mouse.click(p.x, p.y)
  await win.waitForSelector('.amx-cal-event.amx-cal-draft', { timeout: 3000 })
  await win.keyboard.type(title)
  await win.keyboard.press('Enter')
}

async function scenario(kind) {
  console.log(`\n== ${kind}`)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `forsion-seed-cal-${kind}-`))
  const workspace = path.join(home, 'workspace')
  const vault = path.join(workspace, 'Amadeus')
  const calendar = path.join(vault, 'Calendar.db')
  const humanCal = path.join(home, 'tangu', 'human', 'CALENDAR.db')
  const rows = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).rows.map((r) => r.cells.name ?? r.cells.a)
  fs.mkdirSync(vault, { recursive: true })
  const brandNew = kind === 'fresh' || kind === 'down'
  if (!brandNew) {
    fs.writeFileSync(calendar, SEEDS[kind])
    fs.writeFileSync(path.join(vault, '欢迎.md'), '# 老用户\n')
  }
  for (const dir of [path.join(home, 'userdata'), path.join(home, 'userdata-dev')]) {
    fs.mkdirSync(dir, { recursive: true })
    // 新用户不写 lastVault:走首启 ensureDefaultVault
    if (!brandNew) fs.writeFileSync(path.join(dir, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed', sandbox: 'none', browserEnabled: false, unitHostEnabled: false }))
  }
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, FORSION_WORKSPACE_DIR: workspace, TANGU_BROWSER_CDP: 'off', TANGU_HARNESS_QUIET: '1' },
  })
  const errors = []
  try {
    const win = await app.firstWindow({ timeout: 60_000 })
    win.on('pageerror', (e) => errors.push(e.message))
    if (kind === 'down') await win.route(HUMAN_API, (route) => route.abort())
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
    await win.waitForSelector('.fc-root .amx-cal', { timeout: 30_000 })
    const legendOf = () => win.evaluate(() => [...document.querySelectorAll('.amx-calcfg-row .amx-calcfg-name')].map((e) => e.textContent.trim()))
    if (kind === 'down') {
      await win.waitForSelector('.amx-cal-empty', { timeout: 10_000 })
      const hint = await win.locator('.amx-cal-empty').innerText()
      check('引擎不通:日历 Space 打得开,没有可写日历时有提示', hint.includes('还没有日历'), hint)
      await win.screenshot({ path: path.join(OUT, 'down.png') })
      await win.unroute(HUMAN_API)
      const t0 = Date.now()
      const back = await win.waitForFunction(() => document.querySelector('.amx-calcfg-row .amx-calcfg-name'), null, { timeout: 15_000 }).then(() => true, () => false)
      check('引擎恢复后默认日历自己回来', back, `${Date.now() - t0} ms`)
    }
    await win.waitForFunction(() => document.querySelector('.amx-calcfg-row .amx-calcfg-name'), null, { timeout: 15_000 }).catch(() => {})
    const legend = await legendOf()
    check('日历列表只有一本「我的日历」', legend.filter((n) => n === '我的日历').length === 1, JSON.stringify(legend))

    if (brandNew) {
      check('新用户:库里没有 Calendar.db', fs.existsSync(vault) && !fs.existsSync(calendar))
      check('新用户:human/CALENDAR.db 第一次写才建', !fs.existsSync(humanCal))
    }
    if (kind === 'seed') {
      check('没动过的种子:库根上没了', !fs.existsSync(calendar))
      const meta = JSON.parse(fs.readFileSync(path.join(vault, '.trash', '.meta.json'), 'utf8'))
      check('没动过的种子:在库回收站里,能按原名恢复', Object.values(meta).some((e) => e.original === 'Calendar.db'), JSON.stringify(Object.values(meta)))
    }
    if (kind === 'used') {
      check('有数据的文件:原地不动', fs.readFileSync(calendar, 'utf8') === SEEDS.used)
      check('有数据的文件:事件在日历上', await win.waitForSelector('.amx-cal-event[aria-label^="看牙医"]', { timeout: 20_000 }).then(() => true, () => false))
    }
    if (kind === 'corrupt') check('损坏的文件:一个字节不动', fs.readFileSync(calendar, 'utf8') === SEEDS.corrupt)

    await createEvent(win, '第一条事件')
    let wrote = false
    for (let i = 0; i < 40 && !wrote; i++) { await win.waitForTimeout(250); wrote = fs.existsSync(humanCal) && rows(humanCal).includes('第一条事件') }
    check('新建事件写进 human/CALENDAR.db', wrote, fs.existsSync(humanCal) ? JSON.stringify(rows(humanCal)) : '文件不存在')
    check('事件显示在日历上', await win.waitForSelector('.amx-cal-event[aria-label^="第一条事件"]', { timeout: 8000 }).then(() => true, () => false))
    await win.waitForTimeout(1000) // 写完当场镜像一遍:库根那份不能被写回来
    if (brandNew || kind === 'seed') check('镜像没有把 Calendar.db 写回库里', !fs.existsSync(calendar))
    if (kind === 'corrupt') {
      const dir = path.dirname(humanCal)
      const copy = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).find((f) => fs.readFileSync(path.join(dir, f), 'utf8') === SEEDS.corrupt)
      check('损坏的文件:原文留成 human/ 里的副本', !!copy, copy)
    }
    if (kind === 'used') check('有数据的文件:继续镜像,新事件也进来了', rows(calendar).includes('第一条事件') && rows(calendar).includes('看牙医'), JSON.stringify(rows(calendar)))
    await win.screenshot({ path: path.join(OUT, `${kind}.png`) })
    check('没有页面异常', errors.length === 0, errors.slice(0, 3).join(' / '))
  } finally {
    await app.close().catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
  }
}

async function main() {
  for (const f of ['out/main/main.js', '../tangu-agent/dist/standalone/main.js']) if (!fs.existsSync(path.join(ROOT, f))) throw new Error(`缺 ${f} —— 先 build`)
  fs.mkdirSync(OUT, { recursive: true })
  const only = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean)
  for (const kind of ['fresh', 'down', 'seed', 'used', 'corrupt']) if (!only.length || only.includes(kind)) await scenario(kind)
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} passed;截图在 ${OUT}`)
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
