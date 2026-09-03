// 多维表「每视图独立列序 / 列宽」(DbView.order / DbView.widths,2026-09-02 对齐第二波 W2-B)。
// 台架 = harness ?erp 的库存表(8 列,含投影列 s_links),经 window.__erp.load 注入改造夹具:第三视图「自定列」
// 带 order + widths、全局 s_price.width=200;不碰 harness.tsx。
//
//   V1 视图 order 生效(表头序 = 视图序,投影列照排)、全局 columns 序不变;切回「表格」= 全局序
//   V1n 对照:同一夹具去掉 order → 「自定列」表头 = 全局序(证明 order 字段是 V1 的唯一变量,不是别的东西凑巧对上)
//   V2 视图 widths **整体替代**全局宽:视图里 s_qty=300 且 s_price≠200(没条目 = 弹性,不回落全局);切回表格 s_price=200 且 s_qty≠300
//   V3 首列铁律:order 把首列写在第 3 位 → 表头 [0] 仍是首列;拖别的列到首列左半也进不了 0 位
//   V4 带 order 的视图里拖列 → 写视图 order,全局 columns 不动;切回表格仍是全局序
//   V5 无 order 的视图里拖列 → 写全局 columns(现状不退),视图 order 不动;切到自定列仍是视图序
//   V6 拖宽同款两向:带 widths 的视图写 view.widths、全局 column.width 仍空;无 widths 的视图写 column.width
//   V7 视图菜单开关:开 = 拷全局序 + 全局宽进视图;关 = 两字段清掉
//   V8 带 widths 的视图里双击复位 → 只删视图条目,该列回弹性
//   V9 全程无未捕获页面错误
// 负对照(手工,日志有记录):visCols 忽略 view.order → V1/V3/V4 红;colW 忽略 view.widths → V2/V6 红。
// 用法:npm run check:viewcols(= node scripts/e2e-editor.cjs --check=db-viewcols)
const fs = require('fs'), os = require('os'), path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const STOCK = '库存表.db'
const results = []
const errors = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

// 全局列序(夹具 columns 数组序)与「自定列」视图序:投影列 s_links 刻意排到第 3 位(它与普通列一样参与排序)
const GLOBAL_IDS = ['s_name', 's_sku', 's_type', 's_price', 's_qty', 's_locked', 's_out', 's_links']
const GLOBAL_NAMES = ['货物名称', '唯一编号', '硬件类型', '单价/JPY', '数量', '锁单数量', '出库行', '出库(投影)']
const VIEW_ORDER = ['s_name', 's_qty', 's_links', 's_type', 's_sku', 's_price', 's_locked', 's_out']
const VIEW_NAMES = ['货物名称', '数量', '出库(投影)', '硬件类型', '唯一编号', '单价/JPY', '锁单数量', '出库行']

/** 开一页 ?erp 库存表,注入改造夹具(opts.noOrder = 自定列不带 order;opts.headLate = order 把首列写到第 3 位)。 */
async function fresh(browser, opts = {}) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1400, height: 900 } })
  p.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message) })
  await p.goto(`${URL}?erp&db=${encodeURIComponent(STOCK)}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.amx-db-hrow .amx-db-th', { timeout: 20000 })
  await p.evaluate(([stock, order, o]) => {
    const fx = window.__erp.fixture()
    const t = fx[stock]
    t.columns.find((c) => c.id === 's_price').width = 200
    const v3 = { id: 'v3', name: '自定列', type: 'table', widths: { s_qty: 300 } }
    if (!o.noOrder) v3.order = o.headLate ? [order[1], order[2], order[0], ...order.slice(3)] : order
    t.views.push(v3)
    window.__erp.load(fx)
  }, [STOCK, VIEW_ORDER, opts])
  await p.waitForSelector('.amx-db-viewtab:has-text("自定列")', { timeout: 10000 })
  await p.waitForTimeout(300)
  return p
}

const heads = (p) => p.evaluate(() => [...document.querySelectorAll('.amx-db-hrow .amx-db-th-name')].map((e) => e.textContent))
const thW = (p, name) => p.evaluate((n) => {
  const th = [...document.querySelectorAll('.amx-db-hrow .amx-db-th')].find((e) => e.querySelector('.amx-db-th-name')?.textContent === n)
  return th ? Math.round(th.getBoundingClientRect().width) : -1
}, name)
/** 落盘面快照(dbStore 内存态 = 500ms 防抖前的真源):全局列序 / 全局宽 / 各视图的 order、widths。 */
const store = (p) => p.evaluate((stock) => {
  const d = window.__dbStore.getState().entries[stock].data
  return {
    cols: d.columns.map((c) => c.id),
    widths: Object.fromEntries(d.columns.filter((c) => c.width !== undefined).map((c) => [c.id, c.width])),
    views: Object.fromEntries((d.views ?? []).map((v) => [v.id, { order: v.order, widths: v.widths }])),
  }
}, STOCK)
const tab = async (p, name) => { await p.click(`.amx-db-viewtab:has-text("${name}")`); await p.waitForTimeout(250) }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol

/** 合成一次 HTML5 列拖拽(写法照 db-colorder.check:dragstart 与 dragover/drop 必须分两个 tick,让 React 先把 colDrag 提交上去)。 */
const dragCol = async (p, fromName, toName, side) => {
  const started = await p.evaluate((from) => {
    const th = (n) => [...document.querySelectorAll('.amx-db-hrow .amx-db-th')].find((e) => e.querySelector('.amx-db-th-name')?.textContent === n)
    const src = th(from)
    if (!src) return `找不到列 ${from}`
    const btn = src.querySelector('.amx-db-thbtn')
    if (btn.getAttribute('draggable') !== 'true') return 'NOT-DRAGGABLE'
    window.__dt = new DataTransfer()
    btn.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))
    return 'OK'
  }, fromName)
  if (started !== 'OK') return started
  await p.waitForTimeout(80)
  const r = await p.evaluate(([to, sd]) => {
    const th = (n) => [...document.querySelectorAll('.amx-db-hrow .amx-db-th')].find((e) => e.querySelector('.amx-db-th-name')?.textContent === n)
    const dst = th(to)
    if (!dst) return `找不到列 ${to}`
    const rc = dst.getBoundingClientRect()
    const x = sd === 'right' ? rc.left + rc.width * 0.8 : rc.left + rc.width * 0.2
    const y = rc.top + rc.height / 2
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: window.__dt }))
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: window.__dt }))
    return 'OK'
  }, [toName, side])
  await p.waitForTimeout(250)
  return r
}

/** 真鼠标拖宽:合成 PointerEvent 的 pointerId 进 setPointerCapture 会 NotFoundError,只能走 page.mouse。 */
const resize = async (p, name, dx) => {
  const rc = await p.evaluate((n) => {
    const th = [...document.querySelectorAll('.amx-db-hrow .amx-db-th')].find((e) => e.querySelector('.amx-db-th-name')?.textContent === n)
    const g = th?.querySelector('.amx-db-resize')
    if (!g) return null
    const r = g.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, name)
  if (!rc) return `找不到拖杆 ${name}`
  await p.mouse.move(rc.x, rc.y)
  await p.mouse.down()
  await p.mouse.move(rc.x + dx, rc.y, { steps: 6 })
  await p.mouse.up()
  await p.waitForTimeout(300)
  return 'OK'
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })

  // ── V1:视图 order 生效、全局序不变;切回无 order 的视图 = 全局序
  {
    const p = await fresh(browser)
    await tab(p, '自定列')
    const h1 = await heads(p)
    const s = await store(p)
    await tab(p, '表格')
    const h2 = await heads(p)
    record('V1 视图 order 生效(投影列照排)、全局 columns 序不变;切回表格 = 全局序',
      eq(h1, VIEW_NAMES) && eq(s.cols, GLOBAL_IDS) && eq(h2, GLOBAL_NAMES),
      `自定列=${h1.join(',')} 表格=${h2.join(',')} cols=${s.cols.join(',')}`)
    await p.close()
  }

  // ── V1n 对照:同一夹具去掉 order → 自定列表头 = 全局序(order 字段是唯一变量)
  {
    const p = await fresh(browser, { noOrder: true })
    await tab(p, '自定列')
    const h = await heads(p)
    record('V1n 对照:自定列不带 order → 表头 = 全局序', eq(h, GLOBAL_NAMES), h.join(','))
    await p.close()
  }

  // ── V2:视图 widths 整体替代全局宽(没条目 = 弹性);切回表格恢复全局宽
  {
    const p = await fresh(browser)
    await tab(p, '自定列')
    const qty1 = await thW(p, '数量'), price1 = await thW(p, '单价/JPY')
    await tab(p, '表格')
    const qty2 = await thW(p, '数量'), price2 = await thW(p, '单价/JPY')
    record('V2 视图 widths 生效且不回落全局(s_qty=300、s_price≠200);切回表格 s_price=200、s_qty≠300',
      near(qty1, 300) && !near(price1, 200, 5) && near(price2, 200) && !near(qty2, 300, 5),
      `自定列 数量=${qty1} 单价=${price1};表格 数量=${qty2} 单价=${price2}`)
    await p.close()
  }

  // ── V3:首列铁律 —— order 把首列写在第 3 位,表头 [0] 仍是首列;拖别的列到首列左半也进不了 0 位;首列本身不可拖
  {
    const p = await fresh(browser, { headLate: true })
    await tab(p, '自定列')
    const h1 = await heads(p)
    const r = await dragCol(p, '硬件类型', '货物名称', 'left')
    const h2 = await heads(p)
    const r0 = await dragCol(p, '货物名称', '数量', 'right')
    const s = await store(p)
    record('V3 首列不可被视图 order 挪走;拖到首列左半也只落到它右边;首列 draggable=false',
      h1[0] === '货物名称' && h1[1] === '数量' && r === 'OK' && h2[0] === '货物名称' && h2[1] === '硬件类型' && r0 === 'NOT-DRAGGABLE' && s.cols[0] === 's_name',
      `${h1.slice(0, 3).join(',')} → ${r} ${h2.slice(0, 3).join(',')} / ${r0} / v3.order[0..2]=${(s.views.v3.order || []).slice(0, 3).join(',')}`)
    await p.close()
  }

  // ── V4:带 order 的视图里拖列 → 写视图 order,全局 columns 不动;切回表格仍是全局序
  {
    const p = await fresh(browser)
    await tab(p, '自定列')
    const r = await dragCol(p, '单价/JPY', '数量', 'left')
    const h1 = await heads(p)
    const s = await store(p)
    await tab(p, '表格')
    const h2 = await heads(p)
    record('V4 带 order 的视图拖列 → 只写 view.order,全局 columns 不动;切回表格 = 全局序',
      r === 'OK' && h1.indexOf('单价/JPY') === 1 && h1.indexOf('数量') === 2 && eq(s.cols, GLOBAL_IDS) && eq(s.views.v3.order.slice(0, 3), ['s_name', 's_price', 's_qty']) && eq(h2, GLOBAL_NAMES),
      `${r} 自定列=${h1.slice(0, 3).join(',')} v3.order=${s.views.v3.order.join(',')} cols=${s.cols.slice(0, 3).join(',')}`)
    await p.close()
  }

  // ── V5:无 order 的视图里拖列 → 写全局 columns(现状不退),视图 order 不动;切到自定列仍是视图序
  {
    const p = await fresh(browser)
    const r = await dragCol(p, '数量', '唯一编号', 'left')
    const h1 = await heads(p)
    const s = await store(p)
    await tab(p, '自定列')
    const h2 = await heads(p)
    record('V5 无 order 的视图拖列 → 写全局 columns,v3.order 不动;自定列仍是视图序',
      r === 'OK' && h1.indexOf('数量') === 1 && s.cols[1] === 's_qty' && eq(s.views.v3.order, VIEW_ORDER) && eq(h2, VIEW_NAMES),
      `${r} 表格=${h1.slice(0, 3).join(',')} cols=${s.cols.slice(0, 3).join(',')} 自定列=${h2.slice(0, 3).join(',')}`)
    await p.close()
  }

  // ── V6:拖宽两向 —— 带 widths 的视图写 view.widths(全局 column.width 仍空);无 widths 的视图写 column.width
  {
    const p = await fresh(browser)
    await tab(p, '自定列')
    const r1 = await resize(p, '数量', 60)
    const s1 = await store(p)
    const w1 = await thW(p, '数量')
    await tab(p, '表格')
    const before = await thW(p, '数量')
    const r2 = await resize(p, '数量', 60)
    const s2 = await store(p)
    const w2 = await thW(p, '数量')
    record('V6 带 widths 视图拖宽 → view.widths(300→360)、column.width 仍空;表格拖宽 → column.width,v3.widths 不动',
      r1 === 'OK' && near(s1.views.v3.widths.s_qty, 360) && s1.widths.s_qty === undefined && near(w1, 360)
        && r2 === 'OK' && near(s2.widths.s_qty, before + 60, 3) && near(w2, before + 60, 3) && near(s2.views.v3.widths.s_qty, 360) && s2.views.v1.widths === undefined,
      `${r1} v3.s_qty=${s1.views.v3.widths.s_qty} th=${w1} global=${s1.widths.s_qty};${r2} global.s_qty=${s2.widths.s_qty}(起 ${before}) th=${w2} v3.s_qty=${s2.views.v3.widths.s_qty}`)
    await p.close()
  }

  // ── V7:视图菜单开关 —— 开 = 拷全局序 + 全局宽进视图;关 = 两字段清掉(表格视图本来两字段都缺)
  {
    const p = await fresh(browser)
    await p.click('[aria-label="view settings"]')
    await p.waitForSelector('.amx-db-pop [data-owncols]', { timeout: 5000 })
    const a0 = await p.getAttribute('.amx-db-pop [data-owncols]', 'data-owncols')
    await p.click('.amx-db-pop [data-owncols]')
    await p.waitForTimeout(250)
    const s1 = await store(p)
    const a1 = await p.getAttribute('.amx-db-pop [data-owncols]', 'data-owncols')
    await p.click('.amx-db-pop [data-owncols]')
    await p.waitForTimeout(250)
    const s2 = await store(p)
    const a2 = await p.getAttribute('.amx-db-pop [data-owncols]', 'data-owncols')
    record('V7 开关:开 → v1.order=全局序、v1.widths={s_price:200};关 → 两字段清掉;按钮态跟着走',
      a0 === 'off' && a1 === 'on' && a2 === 'off' && eq(s1.views.v1.order, GLOBAL_IDS) && eq(s1.views.v1.widths, { s_price: 200 })
        && s2.views.v1.order === undefined && s2.views.v1.widths === undefined,
      `${a0}→${a1}→${a2} on:order=${(s1.views.v1.order || []).length}列 widths=${JSON.stringify(s1.views.v1.widths)} off:order=${s2.views.v1.order} widths=${s2.views.v1.widths}`)
    await p.close()
  }

  // ── V8:带 widths 的视图里双击复位 → 只删视图条目,该列回弹性(不回落全局,全局本来也没给 s_qty)
  {
    const p = await fresh(browser)
    await tab(p, '自定列')
    await p.dblclick('.amx-db-hrow .amx-db-th:has(.amx-db-th-name:text-is("数量")) .amx-db-resize')
    await p.waitForTimeout(250)
    const s = await store(p)
    const w = await thW(p, '数量')
    record('V8 带 widths 视图双击拖杆 → 删视图条目、列回弹性;widths 对象仍在(开关不掉)',
      s.views.v3.widths !== undefined && s.views.v3.widths.s_qty === undefined && !near(w, 300, 5) && s.widths.s_qty === undefined,
      `v3.widths=${JSON.stringify(s.views.v3.widths)} th=${w}`)
    await p.close()
  }

  record('V9 无未捕获页面错误', errors.length === 0, errors.slice(0, 3).join(' | '))

  await browser.close()
  const pass = results.filter(Boolean).length
  console.log(`\n${pass}/${results.length} 通过`)
  process.exit(results.every(Boolean) ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
