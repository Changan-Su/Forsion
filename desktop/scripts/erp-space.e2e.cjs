/**
 * 「电脑销售ERP」捆绑包的**真 Electron × 真主进程 × 真引擎**验收(载具 B,gui-verify §三)。
 *
 * 台架(`check:erp`)验的是渲染面,`pc-erp/check.mjs` 验的是 dist 引擎链路——两者都打了桩:
 * 台架没有 window.tangu(bundle Space 装不进来),check.mjs 的 io 是内存表。这支把桩全拆掉:
 *   · 从磁盘发现 bundle(`<TANGU_HOME>/plugins/pc-erp`)→ Space 真进 ribbon;
 *   · 插件 setup 真跑:workFolder 钉死、六张 .db + 仪表盘真落进库、`ctx.automation.ensure` 真发到引擎;
 *   · 引擎是 backendManager 托管的 `tangu-agent/dist/standalone/main.js`(临时 TANGU_HOME 冷启动);
 *   · 下单 = 改磁盘上的 订单总表.db(模拟外部/agent 写入)+ POST /automation/kick:先加行(槽位齐、状态空)断言**不**扇出,
 *     再把状态设「未确认」(0.1.1 起这才是「下单」),然后**读磁盘**断言出库/库存/任务/财务四张表被自动化改对
 *     (排空链:状态→出库→库存;确认→任务+定金;完成→尾款+运费)。
 *
 * 数据全在临时 TANGU_HOME,不碰 ~/.forsion-dev。需先 `npm run build`(desktop out/)与 `cd ../tangu-agent && npm run build`。
 * 用法:npm run e2e:erp   ｜ `--nc=norule` 负对照:登记后删掉「出库扣库存」那条规则,期望 S6 的库存断言变红;
 *      `--nc=rowadded` 负对照:「下单」规则改回 0.1.0 的 row_added,期望 S3d + S5pre 变红(未提交的行当场扇出);
 *      `--nc=nolist`:负对照:插件不注册左栏列表源,期望 S11d 变红(证明左栏真的来自 plugin:pc-erp:tables,不是碰巧的笔记树);
 *      `--nc=noseam` 负对照:插件里 app.mutateDb 的返回改成 {ok:false},期望 S10b + S10c 变红(证明 S10 走的是宿主 CAS 接缝那条路,不是回落路径)。
 * 截图:/tmp/erp-e2e-*.png(观感自查用)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const PLUGIN_SRC = path.join(ROOT, '..', '..', 'Forsion-Instrumentality-Project', 'pc-erp')
const ENGINE_ENTRY = path.join(ROOT, '..', 'tangu-agent', 'dist', 'standalone', 'main.js')
const FOLDER = '电脑销售ERP'
const NC = (process.argv.find((a) => a.startsWith('--nc=')) || '').split('=')[1] || ''

const results = []
// ⚠️ 必须 `!!ok`:`a && a.b === x` 遇 null 短路成 null,按 ok===false 统计会漏,一条真失败能报绿(gui-verify §3.1b)。
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
const writeDb = (p, db) => fs.writeFileSync(p, `${JSON.stringify(db, null, 2)}\n`)
async function until(fn, ms, step = 500) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await sleep(step)
  }
}
function request(url, { method = 'GET', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = body ? JSON.stringify(body) : null
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers: {
      Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
    } }, (res) => {
      let s = ''
      res.on('data', (c) => { s += c })
      res.on('end', () => { try { resolve({ status: res.statusCode, json: s ? JSON.parse(s) : null }) } catch { resolve({ status: res.statusCode, json: null, text: s }) } })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}
async function clickSpace(win, names) {
  const clicked = await win.evaluate((labels) => {
    const buttons = [...document.querySelectorAll('button.rb-space')]
    const hit = buttons.find((b) => labels.includes((b.getAttribute('title') || b.textContent || '').trim()))
    if (!hit) return false
    hit.click()
    return true
  }, names)
  return clicked
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) throw new Error('缺 out/main/main.js —— 先跑 npm run build')
  if (!fs.existsSync(ENGINE_ENTRY)) throw new Error('缺 tangu-agent/dist/standalone/main.js —— 先 cd ../tangu-agent && npm run build')
  if (!fs.existsSync(path.join(PLUGIN_SRC, 'manifest.json'))) throw new Error(`找不到插件源码 ${PLUGIN_SRC}`)
  if (NC) console.log(`⚠️ 负对照模式 --nc=${NC}:期望相关断言变红\n`)

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-erp-'))
  const vault = path.join(home, 'vault')
  const userData = path.join(home, 'userdata')
  fs.mkdirSync(vault, { recursive: true })
  fs.mkdirSync(`${userData}-dev`, { recursive: true })
  fs.writeFileSync(path.join(vault, '欢迎.md'), '# ERP 验收库\n')
  fs.writeFileSync(path.join(`${userData}-dev`, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2))
  // ⚠️ DEFAULT_CONFIG.mode 是 'external'(main.ts):全新家目录**不会**自动 spawn 托管引擎,
  // backendStatus 永远 stopped —— 第一版脚本就是在这儿等了 180s。预置 managed 才有真引擎可验。
  // (dev 下 userData 被 main.ts:64 加了 -dev 后缀,与 amadeus-config.dev.json 同目录。)
  fs.writeFileSync(path.join(`${userData}-dev`, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed' }, null, 2))
  fs.cpSync(PLUGIN_SRC, path.join(home, 'plugins', 'pc-erp'), { recursive: true })
  if (NC === 'rowadded') {
    // 负对照:把临时家目录里那份 main.js 的「下单」规则改回 0.1.0 的 row_added → 期望 S3d 与 S5pre 变红(未提交的空/半成品行当场扇出)。
    const mp = path.join(home, 'plugins', 'pc-erp', 'main.js')
    const before = fs.readFileSync(mp, 'utf8')
    const after = before.replace(/"event": "cell_changed",\n(\s*)"column_id": "o_status",\n\s*"equals": "未确认",/, '"event": "row_added",')
    if (after === before) throw new Error('[nc=rowadded] 没找到 order-added 的 cell_changed 块,负对照失效')
    fs.writeFileSync(mp, after)
  }
  if (NC === 'nolist') {
    // 负对照:插件不注册左栏列表源 → space.json 的 mode 落到死源,WorkspaceView 回退成笔记树 → 期望 S11d 变红。
    const mp = path.join(home, 'plugins', 'pc-erp', 'main.js')
    const before = fs.readFileSync(mp, 'utf8')
    const after = before.replace('if (ctx.registerListSource) {', 'if (false && ctx.registerListSource) {')
    if (after === before) throw new Error('[nc=nolist] 没找到 registerListSource 注册块,负对照失效')
    fs.writeFileSync(mp, after)
  }
  if (NC === 'noseam') {
    // 负对照:宿主接缝「失败」→ 插件按契约进 rejected、不写、不记版本 → S10b/S10c 必红。若 S10 仍绿,说明它其实在看回落路径(或根本没走命令)。
    const mp = path.join(home, 'plugins', 'pc-erp', 'main.js')
    const before = fs.readFileSync(mp, 'utf8')
    const after = before.replace('r = await app.mutateDb(p, (db) => {', "r = await Promise.resolve({ ok: false, error: 'nc-seam' }) || app.mutateDb(p, (db) => {")
    if (after === before) throw new Error('[nc=noseam] 没找到 upgradeTables 里的 app.mutateDb 调用,负对照失效')
    fs.writeFileSync(mp, after)
  }
  const erp = (f) => path.join(vault, FOLDER, f)

  // 不传 TANGU_BACKEND_URL:让 backendManager 真的 spawn tangu-agent/dist(自动化只在真引擎里跑)。
  const launch = () => electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home },
  })
  let app = await launch()
  const errors = []
  let token = ''
  let engineUrl = ''
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => errors.push(e.message))
    await win.setViewportSize({ width: 1440, height: 900 })
    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForTimeout(2200)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.getByText(label, { exact: true }).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })

    // ── S1 bundle Space 从磁盘进 ribbon ─────────────────────────────────────────
    const hasSpace = await until(() => win.evaluate(() => [...document.querySelectorAll('button.rb-space')].some((b) => /电脑销售ERP|PC Sales ERP/.test(b.getAttribute('title') || b.textContent || ''))), 30_000)
    check('S1 ribbon 出现「电脑销售ERP」Space(bundle spaces/ 从磁盘装载)', hasSpace)

    // ── S2 进 Amadeus 让 vault 落地 → 插件按库播种 ───────────────────────────────
    check('S2a 能点进 Amadeus', await clickSpace(win, ['Amadeus']))
    await win.waitForSelector('.am-app', { timeout: 30_000 }).catch(() => {})
    const seeded = await until(() => ['库存表.db', '入库记录.db', '出库记录.db', '订单总表.db', '任务表.db', '财务表.db', '财务仪表盘.dashboard.md'].every((f) => fs.existsSync(erp(f))), 60_000)
    check('S2 六张 .db + 财务仪表盘 真落进库的 电脑销售ERP/', seeded, seeded ? '' : `已有:${fs.existsSync(path.join(vault, FOLDER)) ? fs.readdirSync(path.join(vault, FOLDER)).join(',') : '(无文件夹)'}`)
    const inv0 = readJson(erp('库存表.db'))
    const ord0 = readJson(erp('订单总表.db'))
    check('S2b 库存表 12 行示例 + 订单总表 16 个槽位列(o_cpu…o_periph2)', inv0 && inv0.rows.length === 12 && ord0 && ['o_cpu', 'o_mb', 'o_gpu', 'o_ssd1', 'o_periph2', 'o_lines'].every((id) => ord0.columns.some((c) => c.id === id)))

    // ── S3 真引擎起来 + 10 条规则登记 ────────────────────────────────────────────
    const st = await until(async () => {
      const s = await win.evaluate(() => window.tangu && window.tangu.backendStatus ? window.tangu.backendStatus() : null).catch(() => null)
      return s && s.state === 'ready' && s.url ? s : null
    }, 180_000, 1000)
    check('S3a 托管引擎冷启动到 ready(临时 TANGU_HOME)', st, st ? st.url : '超时 180s')
    if (!st) throw new Error('引擎没起来,后面无从验')
    // S3e(P0-a):preload 的 onBackendStatus **注册即回放**当前状态 —— 引擎早已 ready、此刻没有新广播,新订阅者也必须
    // 在 3s 内收到 ready(渲染层 boot 里注册前有 await,广播落在缝里靠这条回放兜底)。负对照见 scripts/boot-replay.check.cjs --nc=noreplay。
    const replayed = await win.evaluate(() => new Promise((resolve) => {
      const timer = setTimeout(() => { off(); resolve('none') }, 3000)
      const off = window.tangu.onBackendStatus((s) => { clearTimeout(timer); off(); resolve(s.state) })
    })).catch((e) => `error:${e.message}`)
    check('S3e onBackendStatus 注册即回放:引擎已 ready 时新订阅者 3s 内收到 ready', replayed === 'ready', `got=${replayed}`)
    engineUrl = st.url.replace(/\/$/, '')
    token = fs.readFileSync(path.join(home, 'desktop-local-token'), 'utf8').trim()
    const listRules = async () => {
      const r = await request(`${engineUrl}/agent/special/muse/triggers`, { token }).catch(() => null)
      return r && r.json && Array.isArray(r.json.triggers) ? r.json.triggers.filter((t) => String(t.id).startsWith('plugin:pc-erp:')) : null
    }
    const rules = await until(async () => { const l = await listRules(); return l && l.length >= 10 ? l : null }, 120_000, 1500)
    check('S3 引擎里有 10 条 plugin:pc-erp:* 规则(0.1.2 起 order-added + order-submitted 两条下单入口)(ctx.automation.ensure 真发到位)', rules && rules.length === 10, rules ? rules.map((t) => t.id.split(':')[2]).join(',') : '超时')
    if (rules) {
      const outAdded = rules.find((t) => t.id.endsWith(':out-added'))
      const orderAdded = rules.find((t) => t.id.endsWith(':order-added'))
      check('S3b 规则字段过引擎白名单不被剥:out-added 带 where + rowFrom,order-added 带 skipIfEmpty,冷却 0', !!(outAdded && outAdded.cond && Array.isArray(outAdded.cond.where) && outAdded.cond.where.length && outAdded.actions && outAdded.actions[0] && outAdded.actions[0].rowFrom && orderAdded && orderAdded.actions && orderAdded.actions.every((a) => a.type !== 'db_row_add' || a.skipIfEmpty) && outAdded.cooldownHours === 0 && orderAdded.cooldownHours === 0), `where=${JSON.stringify(outAdded && outAdded.cond.where)} rowFrom=${outAdded && outAdded.actions[0] && outAdded.actions[0].rowFrom} cooldown=${outAdded && outAdded.cooldownHours}`)
      // 0.1.1:「下单」= 订单状态 cell_changed equals 未确认(不再是 row_added:桌面「+ 新行」建的是空行,row_added 当场对空行跑完就再没人盯)。
      check('S3d order-added 的 cond 真到引擎:cell_changed × o_status × equals 未确认', !!(orderAdded && orderAdded.cond && orderAdded.cond.event === 'cell_changed' && orderAdded.cond.columnId === 'o_status' && orderAdded.cond.equals === '未确认'), JSON.stringify(orderAdded && orderAdded.cond))
      check('S3c 全部 enabled 且无 disabledReason', rules.every((t) => t.enabled && !t.disabledReason))
      if (NC === 'norule' && outAdded) {
        const del = await request(`${engineUrl}/agent/special/muse/triggers/${encodeURIComponent(outAdded.id)}`, { method: 'DELETE', token })
        console.log(`  [nc] 删掉 ${outAdded.id} → ${del.status}`)
      }
    }
    const kick = async () => { await request(`${engineUrl}/agent/special/automation/kick`, { method: 'POST', token }).catch(() => {}) }
    // 首次踢一下让引擎给新规则播种游标(创建即 dropCursors → 下一轮只播种不触发)。
    await kick(); await sleep(6000)

    // ── S4 进 ERP Space,看一眼 ───────────────────────────────────────────────────
    check('S4a 能切进「电脑销售ERP」Space', await clickSpace(win, ['电脑销售ERP', 'PC Sales ERP']))
    const dbview = await win.waitForSelector('.amx-dbview', { timeout: 30_000 }).catch(() => null)
    check('S4 Space 主区是多维表视图(space.json 的 amadeus-db 面板真开出来)', dbview)
    await win.waitForTimeout(1500)
    const tabs = await win.evaluate(() => [...document.querySelectorAll('.dv-tab')].map((t) => (t.textContent || '').trim()).filter(Boolean))
    check('S4b 主区三个标签页都开出来(订单总表 / 财务仪表盘 / 库存表)', tabs.some((t) => t.includes('订单总表')) && tabs.some((t) => t.includes('仪表盘')) && tabs.some((t) => t.includes('库存表')), `tabs=${JSON.stringify(tabs)}`)
    await win.screenshot({ path: '/tmp/erp-e2e-space-empty.png' })

    // ── S5 磁盘加行(槽位齐、**无状态**)→ 踢门铃 → 出库仍 0 行;再把状态设「未确认」→ 踢 → 出库 8 行 + 库存扣减 ──
    //    两段对应桌面真实路径:「+ 新行」→ 慢慢填槽位 → 状态设 未确认 = 提交。第一段是负向:未提交的行绝不扇出。
    const inv = readJson(erp('库存表.db'))
    const byName = (s) => inv.rows.find((r) => String(r.cells.s_name).includes(s))
    // ⚠️ 关键词必须唯一:'240' 会先命中 "i5-12400F"(第一版把散热器槽位选成 CPU,CPU 扣两次、金额全偏)。
    const pick = { cpu: byName('i5-12400F'), mb: byName('B760M'), gpu: byName('4060'), ram: byName('DDR5'), psu: byName('850W'), cooler: byName('240 水冷'), case: byName('ITX'), ssd: byName('1T SSD') }
    check('S5a′ 8 个 SKU 互不重复', new Set(Object.values(pick).filter(Boolean).map((r) => r.id)).size === 8)
    check('S5a 示例库存里找得到 8 个 SKU', Object.values(pick).every(Boolean))
    const q0 = Object.fromEntries(Object.entries(pick).map(([k, r]) => [k, { qty: r.cells.s_qty, locked: r.cells.s_locked || 0 }]))
    const ord = readJson(erp('订单总表.db'))
    ord.rows.push({ id: 'e2e-order-1', cells: {
      o_customer: '张三', o_no: 1, o_created: '2026-09-02T04:00', o_install: '2026-09-10T14:00', o_staff: '小王', o_place: '东京', o_count: 1, o_ship: 1500,
      o_cpu: pick.cpu.id, o_mb: pick.mb.id, o_gpu: pick.gpu.id, o_ram: pick.ram.id, o_psu: pick.psu.id, o_cooler: pick.cooler.id, o_case: pick.case.id, o_ssd1: pick.ssd.id, o_ssd1n: 2,
    } })
    writeDb(erp('订单总表.db'), ord)
    await kick(); await sleep(6000)
    const out0 = readJson(erp('出库记录.db'))
    const invPre = readJson(erp('库存表.db'))
    check('S5pre 未提交的行(槽位齐、状态空)不扇出:6s 后出库仍 0 行、库存不动', !!(out0 && out0.rows.length === 0 && invPre && invPre.rows.find((r) => r.id === pick.cpu.id).cells.s_qty === q0.cpu.qty), `outs=${out0 ? out0.rows.length : '?'}`)
    // 提交:状态设「未确认」(cell_changed equals)→ 才扇出
    const setStatus = (s) => { const d = readJson(erp('订单总表.db')); d.rows.find((r) => r.id === 'e2e-order-1').cells.o_status = s; writeDb(erp('订单总表.db'), d) }
    setStatus('未确认'); await kick()
    const out1 = await until(() => { const d = readJson(erp('出库记录.db')); return d && d.rows.length >= 8 ? d : null }, 60_000)
    check('S5 状态设「未确认」后 出库记录 自动建 8 行(只建填了配件的槽位,skipIfEmpty)', out1 && out1.rows.length === 8, `rows=${out1 ? out1.rows.length : '?'}`)
    if (out1) {
      check('S5b 出库行都挂回订单、状态=未确认、SSD 数量 2、时间已盖章', out1.rows.every((r) => r.cells.x_order === 'e2e-order-1' && r.cells.x_status === '未确认' && typeof r.cells.x_time === 'string') && out1.rows.some((r) => r.cells.x_part === pick.ssd.id && r.cells.x_qty === 2))
    }
    const inv1 = await until(() => { const d = readJson(erp('库存表.db')); const c = d && d.rows.find((r) => r.id === pick.ssd.id); return c && c.cells.s_qty === q0.ssd.qty - 2 ? d : null }, 60_000)
    const cell = (d, id) => d && d.rows.find((r) => r.id === id).cells
    check('S5c 库存扣减:CPU 数量-1 锁单+1;SSD 数量-2 锁单+2(rowFrom 配件 + {{= }} 算术)', !!(inv1 && cell(inv1, pick.cpu.id).s_qty === q0.cpu.qty - 1 && cell(inv1, pick.cpu.id).s_locked === q0.cpu.locked + 1 && cell(inv1, pick.ssd.id).s_qty === q0.ssd.qty - 2 && cell(inv1, pick.ssd.id).s_locked === q0.ssd.locked + 2), inv1 ? `cpu=${JSON.stringify(cell(inv1, pick.cpu.id).s_qty)}/${cell(inv1, pick.cpu.id).s_locked} ssd=${cell(inv1, pick.ssd.id).s_qty}/${cell(inv1, pick.ssd.id).s_locked}` : '超时:库存没动')
    const untouched = readJson(erp('库存表.db')).rows.find((r) => r.id === byName('7800X3D').id)
    check('S5d 未下单的 SKU 不动', untouched && untouched.cells.s_qty === 2 && !(untouched.cells.s_locked))

    // ── S6 确认 → 出库级联 + 锁单释放 + 任务 + 定金 ──────────────────────────────
    setStatus('已确认'); await kick()
    const fin1 = await until(() => { const d = readJson(erp('财务表.db')); return d && d.rows.some((r) => String(r.cells.f_title).includes('定金')) ? d : null }, 60_000)
    check('S6 确认后 财务表 出现「装机定金」= round(总计×0.2) = 35576(引擎侧物化公式列)', fin1 && fin1.rows.some((r) => String(r.cells.f_title).includes('定金') && r.cells.f_in === 35576 && r.cells.f_cat === '装机销售' && r.cells.f_order === 'e2e-order-1'), fin1 ? JSON.stringify(fin1.rows.map((r) => [r.cells.f_title, r.cells.f_in])) : '超时')
    const task1 = await until(() => { const d = readJson(erp('任务表.db')); return d && d.rows.length >= 1 ? d : null }, 30_000)
    check('S6b 任务表 建 1 条装机任务(待执行,日期=装机时间,挂回订单)', task1 && task1.rows.length === 1 && task1.rows[0].cells.t_status === '待执行' && task1.rows[0].cells.t_date === '2026-09-10T14:00' && task1.rows[0].cells.t_order === 'e2e-order-1', task1 ? JSON.stringify(task1.rows[0].cells) : '超时')
    const out2 = await until(() => { const d = readJson(erp('出库记录.db')); return d && d.rows.length === 8 && d.rows.every((r) => r.cells.x_status === '已确认') ? d : null }, 60_000)
    check('S6c 出库 8 行全部级联为 已确认(match 订单总表={{row.id}})', out2)
    const inv2 = await until(() => { const d = readJson(erp('库存表.db')); return d && cell(d, pick.cpu.id).s_locked === q0.cpu.locked && cell(d, pick.ssd.id).s_locked === q0.ssd.locked ? d : null }, 60_000)
    check('S6d 锁单释放:CPU/SSD 锁单回到 0,数量保持扣减后的值', !!(inv2 && cell(inv2, pick.cpu.id).s_qty === q0.cpu.qty - 1 && cell(inv2, pick.ssd.id).s_qty === q0.ssd.qty - 2), inv2 ? '' : '超时:锁单没释放')

    // ── S7 完成 → 尾款 + 运费 ────────────────────────────────────────────────────
    setStatus('已完成'); await kick()
    const fin2 = await until(() => { const d = readJson(erp('财务表.db')); return d && d.rows.some((r) => String(r.cells.f_title).includes('尾款')) && d.rows.some((r) => String(r.cells.f_title).includes('运费')) ? d : null }, 60_000)
    check('S7 完成后 财务表 出现「装机尾款」142303 + 「订单运费」支 1500', fin2 && fin2.rows.some((r) => String(r.cells.f_title).includes('尾款') && r.cells.f_in === 142303) && fin2.rows.some((r) => String(r.cells.f_title).includes('运费') && r.cells.f_out === 1500 && r.cells.f_cat === '运营费用'), fin2 ? JSON.stringify(fin2.rows.map((r) => [r.cells.f_title, r.cells.f_in, r.cells.f_out])) : '超时')
    const rulesAfter = await listRules()
    check('S7b 全程没有规则被断路器停用(无 disabledReason)', rulesAfter && rulesAfter.every((t) => t.enabled && !t.disabledReason), rulesAfter ? rulesAfter.filter((t) => !t.enabled).map((t) => `${t.id}:${t.disabledReason}`).join(';') : '')

    // ── S8 界面:渲染层看见自动化写的数据(VaultWatcher → dbStore 热重载)+ 截图 ──────
    await win.waitForTimeout(2500)
    // 主区多标签时 dockview 把非活动面板也挂在 DOM 里,querySelector 会摸到隐藏的那份 —— 先点到订单总表标签再看。
    await win.evaluate(() => { const t = [...document.querySelectorAll('.dv-tab')].find((x) => (x.textContent || '').includes('订单总表')); t && t.click() })
    await win.waitForTimeout(1200)
    const uiText = await win.evaluate(() => {
      const active = document.querySelector('.dv-groupview.active-group .amx-dbview, .dv-groupview .amx-dbview')
      return active ? active.innerText : ''
    })
    check('S8 订单总表视图里能看到「张三」这一行(外部写入热重载)', uiText.includes('张三'))
    // 界面行 vs 磁盘行:渲染层若拿着旧快照写回(双写者对撞),自动化改的状态会被冲掉 —— 两边都要看。
    const diskRow = readJson(erp('订单总表.db')).rows.find((r) => r.id === 'e2e-order-1')
    const uiRow = await win.evaluate(() => {
      const view = document.querySelector('.dv-groupview.active-group .amx-dbview') || document.querySelector('.amx-dbview')
      const row = view && [...view.querySelectorAll('.amx-db-row')].find((r) => (r.innerText || '').includes('张三'))
      return row ? row.innerText.replace(/\s+/g, ' ') : ''
    })
    check('S8d 磁盘上订单行仍是自动化跑完后的状态(已完成 + 装机时间)', diskRow && diskRow.cells.o_status === '已完成' && diskRow.cells.o_install === '2026-09-10T14:00', JSON.stringify(diskRow && { o_status: diskRow.cells.o_status, o_install: diskRow.cells.o_install, o_created: diskRow.cells.o_created }))
    // calendarDate 在表格里按本地化显示(「9月10日 14:00」),不是磁盘串;关联列显示目标行标题。
    check('S8e 界面订单行显示出状态、装机时间与配件 chip(不是只剩客户/订单号)', uiRow.includes('已完成') && /9月10日|2026-09-10/.test(uiRow) && uiRow.includes('i5-12400F'), `ui="${uiRow.slice(0, 160)}"`)
    await win.screenshot({ path: '/tmp/erp-e2e-space-order.png' })

    // ── S10 「升级表结构」走宿主 CAS 接缝(ctx.app.mutateDb → readDatabase → db:write-cas)───────
    // 台架(pc-erp/check.mjs U7)证的是「宿主有 mutateDb 插件就只走它」,pluginDb.test 证的是 CAS 语义;这里把桩全拆掉:
    // 磁盘上把两张表**降回 0.1.1 形状**(订单总表删「下单表单」视图 + o_customer 的 titleCol、入库记录删 i_name 列;rows 一字不动)
    // → 外部写入热重载后视图标签消失 → 命令面板跑「电脑销售ERP:升级表结构」→ 插件走接缝 → 磁盘补回、rows 逐字节不变 →
    // 视图标签回来(mutateDb 成功后宿主 reloadByPath 热重载)。负对照 --nc=noseam 见头注。
    const ordPre = readJson(erp('订单总表.db'))
    const inPre = readJson(erp('入库记录.db'))
    const rowsBefore = JSON.stringify(ordPre.rows)
    const titleColBefore = (ordPre.columns.find((c) => c.titleCol) || {}).id || ''
    ordPre.views = ordPre.views.filter((v) => v.name !== '下单表单')
    for (const c of ordPre.columns) delete c.titleCol
    inPre.columns = inPre.columns.filter((c) => c.id !== 'i_name')
    writeDb(erp('订单总表.db'), ordPre)
    writeDb(erp('入库记录.db'), inPre)
    const viewTabs = () => win.evaluate(() => [...document.querySelectorAll('.dv-groupview.active-group .amx-db-viewtab, .amx-db-viewtab')].map((t) => (t.textContent || '').trim()))
    const gone = await until(async () => !(await viewTabs()).includes('下单表单'), 12_000)
    check('S10a 磁盘降回 0.1.1 形状后,界面「下单表单」视图标签消失(外部写入热重载)', gone, JSON.stringify(await viewTabs()))
    await win.keyboard.press('Meta+k')
    const palette = await win.waitForSelector('.cmd-input', { timeout: 5_000 }).catch(() => null)
    if (palette) {
      await palette.fill('升级表结构')
      await win.waitForTimeout(400)
      const item = win.locator('.cmd-item', { hasText: '升级表结构' }).first()
      if (await item.count()) await item.click()
      else await win.keyboard.press('Enter')
    }
    check('S10 命令面板(mod+k)里能搜到并执行「电脑销售ERP:升级表结构」', !!palette, palette ? '' : '.cmd-input 没出现')
    const upgraded = await until(() => {
      const o = readJson(erp('订单总表.db')); const i = readJson(erp('入库记录.db'))
      return !!(o && o.views.some((v) => v.name === '下单表单') && i && i.columns.some((c) => c.id === 'i_name')) && { o, i }
    }, 15_000)
    check('S10b 插件经 app.mutateDb 把两张表补回(视图 + 列 + titleCol),rows 逐字节不变', !!(upgraded && JSON.stringify(upgraded.o.rows) === rowsBefore && (upgraded.o.columns.find((c) => c.titleCol) || {}).id === titleColBefore), upgraded ? `titleCol=${(upgraded.o.columns.find((c) => c.titleCol) || {}).id}` : `超时:views=${JSON.stringify((readJson(erp('订单总表.db')) || { views: [] }).views.map((v) => v.name))}`)
    const back = await until(async () => (await viewTabs()).includes('下单表单'), 12_000)
    check('S10c 界面「下单表单」视图标签回来(mutateDb 成功后宿主 reloadByPath 热重载)', back, JSON.stringify(await viewTabs()))
    check('S8b 切进「自动化」Space', await clickSpace(win, ['自动化', 'Automation']))
    await win.waitForTimeout(2500)
    const autoText = await win.evaluate(() => document.body.innerText || '')
    check('S8c 自动化列表里列出 ERP 规则(描述可见)', /出库|订单|入库|库存/.test(autoText))
    await win.screenshot({ path: '/tmp/erp-e2e-automation.png' })
    // ── S11 ERP Space 是本次会话**第一个碰 Amadeus 的 Space** ────────────────────────────
    //    前面每一阶段都先进过 Amadeus(S2a),vault 早就落地了 —— 那条路盖不住用户实报的
    //    「一进这个 Space 就一直显示在加载」。这里整个重启(启动缺省 = 主位槽 Space,见 spaces.tsx)
    //    ⚠️ 这一段**依赖启动时序**,脚本没有强制「面板先挂载、vault 后落地」的接缝(要做得确定性,
    //    得往生产代码里塞一个可阻塞 restoreVault 的测试开关,不值)。2026-09-02 实测的红绿基线:
    //    去掉 dbStore 的 gen 依赖 → S11b/S11c 红;补上 → 全绿。哪天它恒绿到可疑,先怀疑时序漂了。
    //    再直接点进 ERP:vault 懒引导是 void 异步(主进程还要 readConfig+stat 才 setRoot),
    //    而配方里的面板一挂载就读盘;谁都不重试 → 仪表盘 activePage 永不落地 = 永久骨架屏,
    //    多维表 = 「数据库文件缺失」。
    await app.close().catch(() => {})
    app = await launch()
    const win2 = await app.firstWindow()
    win2.on('pageerror', (e) => errors.push(e.message))
    await win2.setViewportSize({ width: 1440, height: 900 })
    await win2.waitForSelector('#root', { timeout: 40_000 })
    await win2.waitForTimeout(2200)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win2.getByText(label, { exact: true }).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win2.waitForSelector('.dv-groupview', { timeout: 40_000 })
    // 启动缺省是「主位槽」Space(spaces.tsx),所以这里**第一件事**就点 ERP —— 全程没进过 Amadeus,
    // 正是用户的真实路径:vault 尚未打开,而 Space 配方一挂载就开始读盘。
    const clicked2 = await until(() => clickSpace(win2, ['电脑销售ERP', 'PC Sales ERP']), 20_000)
    const tabs2 = await until(async () => {
      const t = await win2.evaluate(() => [...document.querySelectorAll('.dv-tab')].map((x) => (x.textContent || '').trim()).filter(Boolean))
      return t.some((x) => x.includes('订单总表')) ? t : null
    }, 30_000)
    check('S11a 冷启动后第一次就切进 ERP Space,三个标签开出来', !!(clicked2 && tabs2 && tabs2.some((t) => t.includes('仪表盘')) && tabs2.some((t) => t.includes('库存表'))), `tabs=${JSON.stringify(tabs2)}`)
    const dbText = await until(async () => {
      const s0 = await win2.evaluate(() => document.body.innerText || '')
      return s0.includes('张三') ? s0 : null
    }, 25_000)
    check('S11b 订单总表面板读得出数据(不是「数据库文件缺失」)', !!dbText, `state=${JSON.stringify(await win2.evaluate(() => [...document.querySelectorAll('.amx-db-state')].map((e) => (e.textContent || '').trim())))}`)
    const dashTab = win2.locator('.dv-tab', { hasText: '仪表盘' }).first()
    if (await dashTab.count().catch(() => 0)) await dashTab.click().catch(() => {})
    const dashOk = await until(() => win2.evaluate(() => !!document.querySelector('.dash-router-page')), 25_000)
    check('S11c 财务仪表盘真渲染出来(不是永久骨架屏)', !!dashOk, dashOk ? '' : `sk=${await win2.evaluate(() => document.querySelectorAll('.dv-groupview .sk').length)}`)
    // 左栏 = 插件列表源(0.1.5):飞书进 base 看到的是「这张 base 的表」,不是整个库的文件树。
    const side = await until(async () => {
      const txt = await win2.evaluate(() => (document.querySelector('.t2s-side, .t2sw-plug') || {}).innerText || '')
      return txt.includes('库存表') && txt.includes('财务表') ? txt : null
    }, 15_000)
    check('S11d 左栏列的是 ERP 六张表 + 仪表盘,不是笔记树(插件列表源 plugin:pc-erp:tables)',
      !!(side && ['库存表', '入库记录', '出库记录', '订单总表', '任务表', '财务表', '财务仪表盘'].every((n) => side.includes(n)) && !side.includes('欢迎')),
      side ? side.replace(/\n/g, ' | ').slice(0, 200) : '超时:左栏没出现表清单')
    await win2.screenshot({ path: '/tmp/erp-e2e-coldstart.png' })

    check('S9 全程无 pageerror', errors.length === 0, errors.slice(0, 3).join(' | '))
  } catch (e) {
    // ⚠️ 必须登记成一条失败:此前只打印+截图,`failed` 仍为空 → **抛异常的那次跑会以 0 退出报绿**,
    //    而它后面的断言一条都没执行(codex 2026-09-02 [high];正是「假绿母题」那一类)。
    results.push({ name: `脚本中断,其后断言未执行:${String((e && e.message) || e)}`, ok: false })
    console.error('中断:', e)
    try { const win = await app.firstWindow(); await win.screenshot({ path: '/tmp/erp-e2e-fail.png' }) } catch { /* ignore */ }
  } finally {
    try {
      if (engineUrl && token) {
        const win = await app.firstWindow()
        const logs = await win.evaluate(() => window.tangu && window.tangu.backendLogs ? window.tangu.backendLogs() : []).catch(() => [])
        const tail = (logs || []).filter((l) => /automation|drain|自动化|plugin:pc-erp|失败/.test(l)).slice(-25)
        if (tail.length) console.log('\n[engine log 尾]\n' + tail.join('\n'))
      }
    } catch { /* ignore */ }
    await app.close().catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
  }
  const failed = results.filter((r) => r.ok === false)
  const skipped = results.filter((r) => r.skipped)
  console.log(`\n${results.length - failed.length - skipped.length} passed / ${failed.length} failed / ${skipped.length} 未验(共 ${results.length})`)
  process.exit(failed.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
