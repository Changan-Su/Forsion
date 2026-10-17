/**
 * ctx.databases / ctx.noteTasks 端到端 —— 真 Electron × 真外置插件 × 预置笔记库 × 落盘核对。
 *
 * 单测 / 契约测试(pluginData.test.ts 等)验的是 DTO 与写口的分支;这里验它们看不见的那半:
 * manifest 声明真的走到了注入闸、没声明的插件真的摸不到、subscribe 的 ready 真的先假后真、
 * 写口真的落到了磁盘上(经典 .db、笔记视图的 frontmatter、笔记里那一行 `- [ ]`),以及插件详情页如实列出声明的能力。
 *
 * 需先 npm run build。用法:npm run check:plugindata(GUI 台架,走 devlock:见 CLAUDE.md / gui-verify)
 * 负对照:--nc=nocap(声明的那个探针也不写 capabilities)—— 期望 T1b 起整段变红。
 * 10-17 加 T5:ctx.calendar 的 'calendar' 档(manifest 白名单在主进程过滤,这一环单测摸不到)—— 注入闸、快照里的成员、
 * setColor 写进宿主日历设置(同一个 localStorage 键、按 vaultRoot)并推回快照。叠加源的数据形状由 pluginCalendar.test.ts 管。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const SHOT_DIR = '/tmp'
const NC = (process.argv.find((a) => a.startsWith('--nc=')) || '').split('=')[1] || ''
// 负对照的截图带后缀,不覆盖正式那轮的
const SHOT = (name) => path.join(SHOT_DIR, `${name}${NC ? '-nc-' + NC : ''}.png`)
const DECLARED = 'pdprobe-declared'
const SILENT = 'pdprobe-silent'
const DB_ONLY = 'pdprobe-dbonly' // 只声明 databases:两道闸写反 / 共用一个条件时它会露馅
const CAL = 'pdprobe-calendar' // 只声明 calendar

const results = []
function check(name, ok, detail) {
  // ⚠️ 必须 !!ok:`a && a.b === x` 遇 null 会短路成 null,按 ok===false 统计就漏项 → 假绿。
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms
  for (;;) {
    let v = null
    try { v = await fn() } catch { v = null }
    if (v || Date.now() > end) return v
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** 探针:setup 那一刻就订阅(此时库还没恢复 → 第一发应是 ready:false),每次回调按序记账;写口挂到 window 给台架直接调。 */
const PROBE_MAIN = [
  'var P = (window.__pdprobe = window.__pdprobe || {})',
  'var me = P[PLUGIN_TAG] = { hasDb: typeof ctx.databases !== "undefined", hasTasks: typeof ctx.noteTasks !== "undefined",',
  '  db: ctx.databases || null, tasks: ctx.noteTasks || null, dbLog: [], taskLog: [] }',
  'if (ctx.databases) ctx.databases.subscribe(function (s) { me.dbLog.push({ ready: s.ready, dbs: s.databases }) })',
  'if (ctx.noteTasks) ctx.noteTasks.subscribe(function (s) { me.taskLog.push({ ready: s.ready, tasks: s.tasks }) })',
  'me.hasEnsure = !!(ctx.calendar && ctx.calendar.ensureMember); me.hasCal = !!(ctx.calendar && ctx.calendar.subscribe); me.cal = ctx.calendar || null; me.calLog = []',
  'if (me.hasCal) ctx.calendar.subscribe(function (s) { me.calLog.push(s) })',
].join('\n')

function writeProbe(pluginsDir, id, caps) {
  const dir = path.join(pluginsDir, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'main.js'), PROBE_MAIN.replace(/PLUGIN_TAG/g, JSON.stringify(id)))
  const manifest = { id, name: id, version: '1.0.0', minAppVersion: '0.0.1', description: 'e2e 用的数据接缝探针,不是产品插件' }
  if (caps && NC !== 'nocap') manifest.capabilities = caps
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
}

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const T0 = new Date() // 基准日启动时定住:跨午夜跑也不假红
const day = (n) => ymd(new Date(T0.getFullYear(), T0.getMonth(), T0.getDate() + n))
const TASK = '准备季度汇报'

/** 一张经典 .db、一个笔记视图(.db 指向 会议/ 文件夹,列 id = frontmatter 键)、一篇带 `- [ ] … @日期` 的笔记。 */
function seedVault(vault) {
  const cols = [{ id: 'name', name: '名称', type: 'text' }, { id: 'date', name: '日期', type: 'calendarDate' }, { id: 'done', name: '完成', type: 'checkbox' }]
  const rows = [['r1', '周会', day(0)], ['r2', '交周报', day(1)], ['r3', '买牛奶', '']]
    .map(([id, name, date]) => ({ id, cells: { name, ...(date ? { date } : {}) } }))
  fs.writeFileSync(path.join(vault, '日程.db'), JSON.stringify({ version: 1, name: '日程', columns: cols, rows }, null, 2))
  fs.writeFileSync(path.join(vault, '会议记录.db'), JSON.stringify({
    version: 1, name: '会议记录', source: { folder: '会议' },
    columns: [{ id: '__page_name', name: 'Page Name', type: 'page' }, { id: 'date', name: '日期', type: 'date' }], rows: [],
  }, null, 2))
  fs.mkdirSync(path.join(vault, '会议'))
  fs.writeFileSync(path.join(vault, '会议', '产品评审.md'), `---\ndate: ${day(2)}\n---\n# 产品评审\n`)
  fs.writeFileSync(path.join(vault, '周计划.md'), `# 周计划\n\n- [ ] ${TASK} @${day(1)}\n`)
}

const readDb = (vault, name) => JSON.parse(fs.readFileSync(path.join(vault, name), 'utf8'))
const rowOf = (vault, name, id) => readDb(vault, name).rows.find((r) => r.id === id)

/** 进设置(独立浮窗):开窗前先 arm window 事件;开不出来返回 null。同 active-window.e2e.cjs。 */
async function openSettings(app, win) {
  const opened = app.waitForEvent('window', { timeout: 15000 }).catch(() => null)
  await win.keyboard.press('Meta+Comma').catch(() => {})
  const sp = await opened
  if (!sp) return null
  await sp.waitForLoadState('domcontentloaded').catch(() => {})
  await sp.waitForSelector('.settings-main', { timeout: 15000 }).catch(() => {})
  return (await sp.locator('.settings-main').first().count().catch(() => 0)) > 0 ? sp : null
}
async function clickExact(page, scope, labels) {
  for (const l of labels) {
    const b = page.locator(scope).getByRole('button', { name: l, exact: true }).first()
    if (await b.count().catch(() => 0)) {
      await b.scrollIntoViewIfNeeded().catch(() => {})
      await b.click().catch(() => {})
      await page.waitForTimeout(600)
      return true
    }
  }
  return false
}
/** 插件页 → 已安装插件 → 点开某张卡,返回详情根的 locator(没点进去 = null)。 */
async function openDetail(sp, id) {
  const card = sp.locator(`[data-plugin-id="${id}"]`).first()
  if (!(await card.count().catch(() => 0))) {
    await clickExact(sp, '.settings-nav', ['插件', 'Plugins'])
    await clickExact(sp, '.settings-shell, body', ['已安装插件', 'Installed plugins'])
  }
  if (!(await card.count().catch(() => 0))) return null
  await card.click().catch(() => {})
  const detail = sp.locator(`[data-plugin-detail="${id}"]`).first()
  await detail.waitFor({ timeout: 5000 }).catch(() => {})
  return (await detail.count().catch(() => 0)) ? detail : null
}

async function launch(home, stubUrl) {
  const app = await electron.launch({
    args: ['--user-data-dir=' + path.join(home, 'userdata'), '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: Object.assign({}, process.env, { TANGU_HOME: home, TANGU_BACKEND_URL: stubUrl }),
  })
  const win = await app.firstWindow()
  await win.waitForSelector('#root', { timeout: 40000 })
  await win.waitForTimeout(2500)
  for (const label of ['跳过引导', 'Skip']) {
    const b = win.locator('text=' + label).first()
    if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
  }
  await win.waitForSelector('.dv-groupview', { timeout: 40000 })
  return { app, win }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  if (NC) console.log('⚠️ 负对照模式 --nc=' + NC + ':期望相关断言变红\n')

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-pd-'))
  const vault = path.join(home, 'vault')
  let stub = null
  let app = null
  let win = null
  try {
    stub = await startStubEngine({ sessions: [], messages: [], models: [] })
    fs.mkdirSync(vault, { recursive: true })
    seedVault(vault)
    // 未打包构建的 userData 是 <dir>-dev(见 lib/launch-electron.cjs 的 ⚠️):库配置写在那里才读得到
    fs.mkdirSync(path.join(home, 'userdata-dev'), { recursive: true })
    fs.writeFileSync(path.join(home, 'userdata-dev', 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
    const pluginsDir = path.join(home, 'plugins')
    writeProbe(pluginsDir, DECLARED, ['databases', 'noteTasks'])
    writeProbe(pluginsDir, SILENT, null)
    writeProbe(pluginsDir, DB_ONLY, ['databases'])
    writeProbe(pluginsDir, CAL, ['calendar'])

    ;({ app, win } = await launch(home, stub.url))
    const probe = (id) => win.evaluate((k) => { const p = (window.__pdprobe || {})[k]; return p ? { hasDb: p.hasDb, hasTasks: p.hasTasks } : null }, id)
    const loaded = await waitFor(async () => (await probe(DECLARED)) && (await probe(SILENT)) && (await probe(DB_ONLY)) && (await probe(CAL)), 15000)
    check('T0 四个探针插件都装载了(外置插件跑起来了)', loaded)

    // ── T1 注入闸:没声明 → 整个不存在;声明了 → 都在 ─────────────────────
    const silent = await probe(SILENT)
    const declared = await probe(DECLARED)
    check('T1a 没声明的插件 ctx.databases / ctx.noteTasks 都不存在', silent && !silent.hasDb && !silent.hasTasks, JSON.stringify(silent))
    check('T1b 声明了的插件两者都在', declared && declared.hasDb && declared.hasTasks, JSON.stringify(declared))
    const dbOnly = await probe(DB_ONLY)
    check('T1c 只声明 databases 的插件只有 ctx.databases(两道闸各管各的)', dbOnly && dbOnly.hasDb && !dbOnly.hasTasks, JSON.stringify(dbOnly))

    // ── T2 subscribe:setup 那一刻库还没恢复 → 先 ready:false,之后 ready:true 且第一次 ready 就看齐这几张表 ──
    const dbLog = () => win.evaluate((k) => ((window.__pdprobe || {})[k] || { dbLog: [] }).dbLog.map((e) => ({
      ready: e.ready, dbs: e.dbs.map((d) => ({ path: d.path, name: d.name, kind: d.kind, cols: d.columns.map((c) => ({ id: c.id, type: c.type, base: c.base })), rows: d.rows })),
    })), DECLARED)
    const ready = await waitFor(async () => (await dbLog()).find((e) => e.ready), 20000)
    const log0 = (await dbLog())[0]
    check('T2a 第一发回调是 ready:false(加载中 ≠ 库里没有表)', log0 && log0.ready === false, log0 ? 'n=' + log0.dbs.length : '没有回调')
    check('T2b 之后翻成 ready:true', ready)
    const byName = (n) => ready && ready.dbs.find((d) => d.name === n)
    const table = byName('日程')
    const notes = byName('会议记录')
    // 判据照技能文档:日期列 = base date 或 type calendarDate(calendarDate 落盘是 text),勾选列 = base checkbox
    const hasDate = table && table.cols.some((c) => c.id === 'date' && (c.base === 'date' || c.type === 'calendarDate'))
    const hasCheck = table && table.cols.some((c) => c.id === 'done' && c.base === 'checkbox')
    check('T2c 第一次 ready 就看到经典表(kind=table,三行,日期列 / 勾选列认得出)', table && table.kind === 'table' && table.rows.length === 3 && hasDate && hasCheck,
      table ? `${table.path} rows=${table.rows.length} cols=${JSON.stringify(table.cols)}` : JSON.stringify(ready && ready.dbs.map((d) => d.name)))
    const review = notes && notes.rows.find((r) => r.name === '产品评审')
    check('T2d 也看到笔记视图(kind=notes,行 = 笔记,属性来自 frontmatter)', notes && notes.kind === 'notes' && review && review.cells.date === day(2),
      notes ? JSON.stringify(notes.rows) : '')

    const taskLog = () => win.evaluate((k) => ((window.__pdprobe || {})[k] || { taskLog: [] }).taskLog, DECLARED)
    const t0 = await waitFor(async () => (await taskLog())[0])
    check('T2e0 noteTasks 第一发也是 ready:false', t0 && t0.ready === false, t0 ? 'n=' + t0.tasks.length : '没有回调')
    const tReady = await waitFor(async () => (await taskLog()).find((e) => e.ready && e.tasks.some((t) => t.text.includes('季度汇报'))), 15000)
    const task = tReady && tReady.tasks.find((t) => t.text.includes('季度汇报'))
    check('T2e noteTasks 看到笔记里的 `- [ ] … @日期`(isTask、未勾、due 对)', task && task.isTask && task.checked === false && task.due === day(1) && task.path === '周计划.md',
      task ? JSON.stringify(task) : '')

    // ── T3 写口落盘 ───────────────────────────────────────────────────────
    const call = (expr, args) => win.evaluate(({ expr, args, k }) => {
      const p = window.__pdprobe[k]
      return new Function('db', 'tasks', 'args', `return (${expr})`)(p.db, p.tasks, args)
    }, { expr, args, k: DECLARED })
    if (table && notes && review) {
      const newDate = `${day(3)}T15:00/${day(3)}T16:00`
      const ok = await call('db.setCell(args.p, "r1", "date", args.v)', { p: table.path, v: newDate })
      const disk = await waitFor(() => { const r = rowOf(vault, '日程.db', 'r1'); return r && r.cells.date === newDate && r })
      check('T3a 经典表 setCell 落盘', ok === true && disk, `ret=${ok} disk=${JSON.stringify(rowOf(vault, '日程.db', 'r1'))}`)

      const okN = await call('db.setCell(args.p, args.r, "date", args.v)', { p: notes.path, r: review.id, v: day(4) })
      // 只认文件头那段 frontmatter 里的键:写进正文的 `date: …` 不算
      const fmDate = () => { const m = /^---\n([\s\S]*?)\n---\n/.exec(fs.readFileSync(path.join(vault, '会议', '产品评审.md'), 'utf8')); return m && m[1].split('\n').filter((l) => l.startsWith('date:')) }
      const fm = await waitFor(() => { const d = fmDate(); return d && d.length === 1 && d[0] === `date: ${day(4)}` })
      check('T3b 笔记视图 setCell 落到那篇笔记的 frontmatter', okN === true && fm, `ret=${okN} file=${JSON.stringify(fs.readFileSync(path.join(vault, '会议', '产品评审.md'), 'utf8'))}`)

      const id = await call('db.addRow(args.p, { date: args.d }, "新事件")', { p: table.path, d: day(5) })
      const added = await waitFor(() => { const r = typeof id === 'string' && rowOf(vault, '日程.db', id); return r && r.cells.date === day(5) && r.cells.name === '新事件' && r })
      check('T3c addRow 落盘(名称进首列、日期进日期列)', added, `id=${id} disk=${JSON.stringify(typeof id === 'string' && rowOf(vault, '日程.db', id))}`)

      const undoType = await win.evaluate(({ p, k }) => { window.__pdundo = window.__pdprobe[k].db.deleteRow(p, 'r3'); return typeof window.__pdundo }, { p: table.path, k: DECLARED })
      const gone = await waitFor(() => !rowOf(vault, '日程.db', 'r3'))
      check('T3d deleteRow 落盘并给出撤销函数', undoType === 'function' && gone, `undo=${undoType} gone=${gone}`)
      await win.evaluate(() => window.__pdundo && window.__pdundo())
      const back = await waitFor(() => { const r = rowOf(vault, '日程.db', 'r3'); return r && r.cells.name === '买牛奶' && r })
      check('T3e 撤销后那一行原样回到磁盘', back, JSON.stringify(rowOf(vault, '日程.db', 'r3')))

      const nullForNotes = await call('db.deleteRow(args.p, args.r)', { p: notes.path, r: review.id })
      check('T3f 笔记视图的行 deleteRow 返回 null、笔记还在', nullForNotes === null && fs.existsSync(path.join(vault, '会议', '产品评审.md')), 'ret=' + JSON.stringify(nullForNotes))
    } else check('T3 写口落盘', false, '前面没拿到表,跳不过去')

    if (task) {
      const ok = await call('tasks.update(args.id, { checked: true })', { id: task.id })
      const md = await waitFor(() => fs.readFileSync(path.join(vault, '周计划.md'), 'utf8').includes(`- [x] ${TASK} @${day(1)}`))
      check('T3g noteTasks.update 勾选后笔记那一行变成 `- [x]`', ok === true && md, `ret=${ok} file=${JSON.stringify(fs.readFileSync(path.join(vault, '周计划.md'), 'utf8'))}`)
    } else check('T3g noteTasks.update 勾选落盘', false, '前面没拿到任务')

    // ── T5 ctx.calendar 的 'calendar' 档 ────────────────────────────────
    const calOf = (id) => win.evaluate((k) => { const p = (window.__pdprobe || {})[k]; return p ? { hasEnsure: p.hasEnsure, hasCal: p.hasCal } : null }, id)
    const cS = await calOf(SILENT), cD = await calOf(DECLARED), cC = await calOf(CAL)
    check('T5a 没声明 calendar:ensureMember 在、subscribe 不在(声明了别的也一样);声明了才有', cS && cS.hasEnsure && !cS.hasCal && cD && !cD.hasCal && cC && cC.hasEnsure && cC.hasCal,
      JSON.stringify({ cS, cD, cC }))
    const calLog = () => win.evaluate((k) => ((window.__pdprobe || {})[k] || { calLog: [] }).calLog, CAL)
    const calReady = await waitFor(async () => (await calLog()).find((e) => e.ready && e.members.some((m) => m.path === '日程.db')), 20000)
    const m0 = calReady && calReady.members.find((m) => m.path === '日程.db')
    check('T5b 快照里有成员 日程.db(日期列 date、勾选列 done)和它的颜色', m0 && m0.dateCol === 'date' && m0.checkboxCol === 'done' && /^#[0-9a-f]{6}$/i.test(calReady.colors['日程.db'] || ''),
      calReady ? JSON.stringify({ members: calReady.members, colors: calReady.colors }) : JSON.stringify(await calLog()))
    if (cC && cC.hasCal) {
      const ret = await win.evaluate((k) => ({ bad: window.__pdprobe[k].cal.setColor('日程.db', 'red'), ok: window.__pdprobe[k].cal.setColor('日程.db', '#123456') }), CAL)
      const stored = await win.evaluate((v) => { try { const c = JSON.parse(localStorage.getItem('amadeus.calendar.cfg') || '{}'); return c[v] && c[v].colors && c[v].colors['日程.db'] } catch { return null } }, vault)
      const pushed = await waitFor(async () => (await calLog()).some((e) => e.colors['日程.db'] === '#123456'), 5000)
      check('T5c setColor:坏颜色 false;好颜色写进宿主日历设置(按库根存)并推回快照', ret.bad === false && ret.ok === true && stored === '#123456' && pushed, JSON.stringify({ ret, stored, pushed }))
    } else check('T5c setColor 写进宿主日历设置', false, '没有 ctx.calendar.subscribe')

    // ── T4 插件详情页如实列出声明的能力(走真 UI)────────────────────────
    const sp = await openSettings(app, win)
    const d1 = sp && await openDetail(sp, DECLARED)
    const caps1 = d1 ? await d1.locator('[data-plugin-caps]').first().textContent({ timeout: 2000 }).catch(() => null) : null
    check('T4a 声明的插件详情页有「这个插件可以：读写你的多维表、读写笔记里的 @ 任务」', caps1 && caps1.includes('多维表') && caps1.includes('@ 任务') && !caps1.includes('前台窗口'), 'text=' + JSON.stringify(caps1))
    if (sp) await sp.screenshot({ path: SHOT('plugin-data-detail') }).catch(() => {})
    if (d1) await d1.locator('[data-plugin-back]').first().click().catch(() => {})
    const d2 = sp && await openDetail(sp, SILENT)
    const caps2 = d2 ? await d2.locator('[data-plugin-caps]').count() : -1
    check('T4b 没声明的插件详情页没有这一行', d2 && caps2 === 0, 'count=' + caps2)
    if (sp) await sp.screenshot({ path: SHOT('plugin-data-detail-silent') }).catch(() => {})
    if (d2) await d2.locator('[data-plugin-back]').first().click().catch(() => {})
    const d3 = sp && await openDetail(sp, CAL)
    const caps3 = d3 ? await d3.locator('[data-plugin-caps]').first().textContent({ timeout: 2000 }).catch(() => null) : null
    check('T4c 只声明 calendar 的插件详情页只列日历那一条', caps3 && caps3.includes('日历') && !caps3.includes('多维表'), 'text=' + JSON.stringify(caps3))
    if (sp) await sp.screenshot({ path: SHOT('plugin-data-detail-calendar') }).catch(() => {})
  } catch (e) {
    console.error('\n跑挂了:', e && e.stack)
    if (win) await win.screenshot({ path: SHOT('plugin-data-crash') }).catch(() => {})
    results.push({ name: '脚本跑完', ok: false })
  } finally {
    if (app) await app.close().catch(() => {})
    if (stub && stub.close) await Promise.resolve(stub.close()).catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(`${home}-workspace`, { recursive: true, force: true })
  }

  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad} passed / ${bad} failed  (共 ${results.length})`)
  console.log(`截图:${SHOT('plugin-data-detail')}、${SHOT('plugin-data-detail-silent')}`)
  process.exit(bad ? 1 : 0)
}

main()
