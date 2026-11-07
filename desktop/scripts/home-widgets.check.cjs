/**
 * 主页小组件(11-07 方案 A):真 Electron(out/ 构建)× 桩引擎 × 临时家目录里装好带 `widgets` 的日历核心插件。
 * 查:没存过摆放 = 右栏 今天 / 待办 / 卜算子·建议;插件卡的行(下一条实心点、逾期标红、今天几条完成);「用这句」填进主页输入框;
 * 收纳面板三组;存过摆放的老用户一张不动;窄窗收成图标条用各自的图标;第一次出现的上手提示。截图进 OUT(缺省 ../../outputs/home-widgets)。
 *
 * 用法:先在本检出 npx electron-vite build;日历插件检出里 npm run build;然后
 *   CALENDAR_PLUGIN_DIR=<Forsion-Calendar 检出> node ../../.claude/hooks/devlock.cjs run --vehicle=e2e --what="主页小组件" --eta=3 -- node scripts/home-widgets.check.cjs
 */
const fs = require('fs')
const path = require('path')
const { launch, boot, sleep, makeReporter, captureWindow } = require('./lib/uiux-electron.cjs')

const OUT = path.resolve(process.env.OUT || path.join(__dirname, '../../outputs/home-widgets'))
const PLUGIN = process.env.CALENDAR_PLUGIN_DIR && path.resolve(process.env.CALENDAR_PLUGIN_DIR)
const KEY = 'forsion.homepage.widgets.desktop.v1'
const R = makeReporter()
const check = R.check

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const at = (d) => `${ymd(d)}T${hm(d)}`
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const db = (name, columns, rows) => JSON.stringify({ version: 1, name, columns, rows }, null, 2)

/** 今天还剩的三条(从下一个整半点起,晚上十点前)+ 明天两条;待办:逾期 / 今天(一条做完)/ 明天 / 未排期。 */
function seedVault(vault, now) {
  const slot = new Date(now); slot.setMinutes(now.getMinutes() < 30 ? 30 : 60, 0, 0)
  const later = (h) => { const d = new Date(slot.getTime() + h * 3_600_000); return d.getDate() === now.getDate() && d.getHours() < 23 ? d : null }
  const t1 = slot, t2 = later(2), t3 = later(5)
  const tmr = addDays(now, 1)
  const events = [
    ['e1', '读书会 ·《置身事内》', t1], ['e2', '设计对稿', t2], ['e3', '羽毛球', t3],
    ['e4', '产品周会', new Date(tmr.getFullYear(), tmr.getMonth(), tmr.getDate(), 10)], ['e5', '牙医复诊', new Date(tmr.getFullYear(), tmr.getMonth(), tmr.getDate(), 15)],
  ].filter(([, , d]) => d).map(([id, name, d]) => ({ id, cells: { name, date: `${at(d)}/${at(new Date(d.getTime() + 3_600_000))}` } }))
  fs.writeFileSync(path.join(vault, '工作日历.db'), db('工作日历', [{ id: 'name', name: '名称', type: 'text' }, { id: 'date', name: '日期', type: 'calendarDate' }], events))
  const todos = [
    ['t1', '续费域名', ymd(addDays(now, -2)), false], ['t2', '给周会写议程', ymd(now), false], ['t3', '回复设计稿评论', ymd(now), true],
    ['t4', '订周五的会议室', `${ymd(tmr)}T16:00`, false], ['t5', '整理读书笔记', '', false],
  ].map(([id, name, date, done]) => ({ id, cells: { name, ...(date ? { date } : {}), done } }))
  fs.writeFileSync(path.join(vault, '待办.db'), db('待办', [
    { id: 'name', name: '名称', type: 'text' }, { id: 'date', name: '日期', type: 'calendarDate' }, { id: 'done', name: '完成', type: 'checkbox' },
  ], todos))
  return { first: events[0]?.cells.name }
}

const STARTERS = [
  { id: 's1', text: '明天 10:00 的「产品周会」还没有议程。按本周开发日志起一份议程。', source: { kind: 'calendar', label: '产品周会' } },
  { id: 's2', text: '「蓬洲云同步简化方案」三天没动了。把剩下的待定项列成清单。', source: { kind: 'note', label: '蓬洲云同步简化方案' } },
  { id: 's3', text: '每周一为「AI 学习仪表盘」规划一个开发里程碑。', source: { kind: 'muse', label: 'AI 学习仪表盘' } },
]

async function main() {
  if (!PLUGIN || !fs.existsSync(path.join(PLUGIN, 'main.js'))) throw new Error('CALENDAR_PLUGIN_DIR 要指向打好包的 Forsion-Calendar 检出(npm run build)')
  fs.mkdirSync(OUT, { recursive: true })
  const now = new Date()
  let seeded = {}
  const ctx = await launch({
    tag: 'home-widgets', fixtures: { agents: [], sessions: [] },
    beforeLaunch: ({ home, vault }) => {
      seeded = seedVault(vault, now)
      // 日历核心插件:装进临时家目录,版本号抬高,随包那份(更旧)不会把它换掉
      const dest = path.join(home, 'plugins', 'forsion-calendar')
      for (const f of ['manifest.json', 'main.js', 'spaces', 'widgets']) fs.cpSync(path.join(PLUGIN, f), path.join(dest, f), { recursive: true })
      const m = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'))
      fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ ...m, version: '99.0.0' }, null, 2))
    },
    stubOverride: async (req) => {
      if (req.path === '/agent/special/muse/starters' && req.method === 'GET') return { starters: STARTERS }
      if (req.path === '/agent/widgets' && req.method === 'GET') return { widgets: [] }
      if (/^\/agent\/widgets\//.test(req.path)) return { __code: 404, body: { error: 'WIDGET_NOT_FOUND' } }
    },
  })
  const { app, win } = ctx
  const ids = (side) => win.evaluate((s) => [...document.querySelectorAll(`.hp-rail-${s} .hp-wcard`)].map((c) => c.dataset.widgetId), side)
  const card = (id) => win.locator(`.hp-rail .hp-wcard[data-widget-id="${id}"]`).first()
  try {
    await boot(app, win, { space: 'home', width: 1512, height: 950 })
    await win.evaluate(() => document.fonts.ready)
    await win.locator('.hp-rail-right .hp-wcard').first().waitFor({ timeout: 15_000 })
    await sleep(3500) // 插件装载 + 第一次拿行

    // ── 缺省摆放 = 方案 A ──
    check('没存过摆放:右栏 今天 / 待办 / 卜算子·建议', JSON.stringify(await ids('right')) === JSON.stringify(['plugin:forsion-calendar/today', 'plugin:forsion-calendar/todo', 'builtin:muse']), JSON.stringify(await ids('right')))
    check('没存过摆放:本机不写摆放(只是缺省)', (await win.evaluate((k) => localStorage.getItem(k), KEY)) === null)
    const today = await card('plugin:forsion-calendar/today').innerText()
    check('今天卡:卡头「今天 · 日历」', /今天/.test(today) && /日历/.test(today), today.split('\n').slice(0, 2).join(' / '))
    check('今天卡:有今天剩下的那条和明天分组', !!seeded.first && today.includes(seeded.first) && today.includes('明天') && today.includes('产品周会'), today.replace(/\n/g, ' | ').slice(0, 160))
    check('今天卡:下一条是实心点', await card('plugin:forsion-calendar/today').locator('.hp-wl-row.now .hp-wl-dot.on').count() === 1)
    const todo = await card('plugin:forsion-calendar/todo').innerText()
    check('待办卡:逾期在最前、标红', await card('plugin:forsion-calendar/todo').locator('.hp-wl-row').first().innerText().then((s) => s.includes('续费域名') && s.includes('逾期'))
      && await card('plugin:forsion-calendar/todo').locator('.hp-wl-meta[data-tone="warn"]').count() >= 1)
    check('待办卡:底栏写今天完成几条', /今天 1 \/ 2 完成/.test(todo), todo.replace(/\n/g, ' | ').slice(-60))
    check('待办卡:今天做完的划掉', await card('plugin:forsion-calendar/todo').locator('.hp-wl-row.done').count() === 1)
    check('卜算子·建议:一签 + 用这句', (await card('builtin:muse').innerText()).includes('用这句'))
    const gap = await win.evaluate(() => {
      const rail = document.querySelector('.hp-rail-right')?.getBoundingClientRect()
      const mid = document.querySelector('.hp-composer')?.getBoundingClientRect()
      return rail && mid ? Math.round(rail.left - mid.right) : null
    })
    check('输入框和右栏不重叠(至少隔 32)', gap !== null && gap >= 32, `gap=${gap}`)
    await win.mouse.move(4, 4)
    await sleep(2500) // 上手提示:锚点出现 2 秒后、停手 1.5 秒后
    const tip = await win.locator('.guide-spot-card').first().innerText().catch(() => '')
    check('第一次出现:右栏旁的上手提示', tip.includes('主页能放小组件了'), tip.replace(/\n/g, ' / '))
    await captureWindow(app, path.join(OUT, 'a-default.png'))
    await win.locator('.guide-spot-card .btn').first().click().catch(() => {})

    // ── 用这句:填进主页输入框 ──
    await card('builtin:muse').locator('.hp-wbtn').first().click()
    await sleep(800)
    const draft = await win.evaluate(() => document.querySelector('.hp-composer .t2c-ta')?.value || '')
    check('「用这句」整句填进主页输入框(不发)', draft === STARTERS[0].text, draft.slice(0, 40))
    await win.keyboard.press('Escape'); await sleep(500)

    // ── 收纳面板三组 ──
    await win.locator('.hp-dock .hp-more').first().click(); await sleep(700)
    await win.locator('.hp-organizer-tabs [data-tab="widgets"]').first().click(); await sleep(900)
    const heads = await win.evaluate(() => [...document.querySelectorAll('.hp-lib-h > b')].map((b) => b.textContent))
    check('收纳:内置 / 插件 / Agent 做的 三组', JSON.stringify(heads) === JSON.stringify(['内置', '插件', 'Agent 做的']), JSON.stringify(heads))
    const tiles = await win.evaluate(() => [...document.querySelectorAll('.hp-lib-tile')].map((t) => t.innerText.replace(/\n/g, ' ')))
    check('收纳:插件那组有「今天 · 日历」「待办 · 日历」且已放', tiles.some((t) => /^今天 .*已放/.test(t)) && tiles.some((t) => /^待办 .*已放/.test(t)), JSON.stringify(tiles))
    await captureWindow(app, path.join(OUT, 'library.png'))
    // 收件箱(内置)放进第一个空位:右栏满 → 左栏
    await win.locator('.hp-lib-tile').filter({ hasText: '收件箱' }).first().click(); await sleep(600)
    check('右栏满了:落到左栏', JSON.stringify(await ids('left')) === JSON.stringify(['builtin:inbox']), JSON.stringify(await ids('left')))
    await win.keyboard.press('Escape'); await sleep(400)
    const box = await win.evaluate(() => ({ w: innerWidth, h: innerHeight }))
    await win.mouse.click(box.w - 60, box.h - 40); await sleep(600)
    await captureWindow(app, path.join(OUT, 'with-left.png'))

    // ── 老用户存过的摆放一张不动 ──
    await win.evaluate((k) => { localStorage.setItem(k, JSON.stringify({ left: [], center: ['clock', 'composer', 'row', 'dock'], row: [{ id: 'builtin:status', w: 4 }], right: [] })); window.dispatchEvent(new StorageEvent('storage', { key: k })) }, KEY)
    await sleep(1000)
    check('存过摆放(右栏空):照存的来,不补卡', (await ids('right')).length === 0 && (await ids('left')).length === 0)

    // ── 插件没装 / 旧版没声明的那张:平时不画,编辑态画成占位、拿得掉 ──
    await win.evaluate((k) => { localStorage.setItem(k, JSON.stringify({ left: [], center: ['clock', 'composer', 'row', 'dock'], row: [{ id: 'builtin:status', w: 4 }], right: ['plugin:no-such-plugin/x', 'builtin:notes'] })); window.dispatchEvent(new StorageEvent('storage', { key: k })) }, KEY)
    await sleep(1000)
    check('没装的插件卡:平时跳过', JSON.stringify(await ids('right')) === JSON.stringify(['builtin:notes']), JSON.stringify(await ids('right')))
    await win.locator('.hp-edit-button').first().click(); await sleep(800)
    const ghost = await win.locator('.hp-rail-right .hp-wcard[data-widget-id="plugin:no-such-plugin/x"]').first().innerText().catch(() => '')
    check('没装的插件卡:编辑态画成占位', ghost.includes('装上或更新'), ghost.replace(/\n/g, ' / '))
    await win.locator('.hp-rail-right .hp-wcard[data-widget-id="plugin:no-such-plugin/x"] .hp-edit-btn').first().click(); await sleep(600)
    check('没装的插件卡:编辑态拿得掉', JSON.stringify(await win.evaluate((k) => JSON.parse(localStorage.getItem(k)).right, KEY)) === JSON.stringify(['builtin:notes']))
    await captureWindow(app, path.join(OUT, 'edit-mode.png'))
    await win.locator('.hp-edit-done').first().click(); await sleep(500)

    // ── 窄窗:收成图标条,用各自的图标 ──
    await win.evaluate((k) => { localStorage.removeItem(k); window.dispatchEvent(new StorageEvent('storage', { key: k })) }, KEY)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800)); await sleep(1200)
    const strip = await win.evaluate(() => [...document.querySelectorAll('.hp-rail-right.hp-strip .hp-strip-btn')].map((b) => (b.querySelector('img') ? 'img' : b.querySelector('svg')?.getAttribute('class') || '')))
    check('窄窗:右栏收成三颗图标(插件用插件图标)', strip.length === 3, JSON.stringify(strip))
    await captureWindow(app, path.join(OUT, 'strip-1280.png'))
  } finally {
    await ctx.close()
  }
  process.exitCode = R.summary() ? 1 : 0
}
main().catch((e) => { console.error(e); process.exit(1) })
