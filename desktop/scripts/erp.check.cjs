// 电脑销售ERP 渲染面仪器(harness ?erp 模式,真 Chromium)。引擎链路在插件仓 pc-erp/check.mjs;这支只钉**渲染层**:
//   E1 多值关联:订单「配件(多选)」一格 ≥2 枚 chip
//   E2 反向引用:订单「出库行」= 出库记录里指回本单的备注,顿号拼接;没人指回的行显示 –
//   E3 公式链:硬件总额 / 服务费 / 总计 / 定金 / 配件总价(多值 lookup sum)数值全对;format(创建日期) = YYYY-MM;全表无 #错误
//   E4 自动编号:订单号显示前缀 ORD-1;created 列上屏
//   E5 计算列不落盘:store 里的 cells 没有公式/lookup 键
//   E6 看板:泳道 = 选项数 + 1(「未分组」恒在);卡数之和 = 行数;激活 tab 是「看板」
//   E7 暗色档同样成立(&dark 走真主题)
//   E8 无未捕获页面错误
//   L1/L2 关联三件:芯片显示列 titleCol(出库记录里的订单芯片 = ORD-x)/ picker 候选限定 refFilter(CPU 槽位只列 cpu SKU),各带注入负对照
//   L3/L4 可编辑投影列(lookupKind='links'):库存表「出库(投影)」渲 chip / picker 挑一行 → 对侧表 x_part 变、本表 store 无 cell;负对照 = 注入去掉 lookupKind
//   E9 溢出态列对齐:表头 .amx-db-th / 数据行 .amx-db-cell / 页脚 .amx-db-stat 同下标的左右边界逐像素相等(≤0.5px);
//      前置条件 .amx-db-scroll 必须真溢出(不溢出时三者天然对齐 = 假绿)。?dbdemo(带分组 .amx-db-group 的路径)在 900px 视口再钉一次
//   E9c 任一列宽 ≤ COL_W_MAX;E9d 表总宽 ≤ 64 + COL_W_MAX×列数(错位候选 C 仪器:外层 grid minmax(max-content,1fr) 让全表
//      被单个最宽格拉平,E9 对此全绿 —— 这两条只让问题可见不解决;夹具里出库记录 x4 备注刻意 19 字,与 x3 顿号拼接后 25 字)
//   F1-F5 表单视图(view.type='form'):字段集不含计算/盖章列 / 提交一次 = 一次 mutate 且盖章有值 / 必填为空不提交 / after=table 跳表格 / 工具栏无通用新建;负对照见 F 段注释
//   G1-G6 甘特视图(view.type='gantt',夹具 任务表.db):条数 = 有日期行数 / left 随日期单调 / 今日线贴今天开始的条 / 日↔周换档落盘且不冲掉起止列 / 点标题开 RowEditor / 独立结束列;负对照见 G 段注释
//   N1-N5 数字显示格式 / 多附件 / 导出 CSV(W2-F3):N1 按 precision+单位显示、N2 进编辑态回原始值、
//      N3 CSV 表头=可见列 + 注入/引号/中文转义 + BOM、N4 筛选后只导筛剩的行、N5 附件两形态各自的 chip 数;负对照见 N 段注释
//   负对照经 window.__erp.load 注入改坏的夹具:多选格改成单值 → chip <2;反向列去掉 lookupBackCol → –(两条必须翻红);
//   x4 备注加长到 38 字(拼接后 44 字)→ E9c/E9d 翻红
//   T1-T5 层级树 + 日期分组(夹具 任务表.db 的「层级」/「按日」/「按月」视图):缩进层级 / 折叠 / 环仍渲全行不卡死 / **孤儿当根(T3b)** / 日期组头与空组落位 / 缩进条随首列铁律恒在 0 格;负对照见 T 段注释
// 用法:npm run check:erp(经 e2e-editor.cjs 起停 vite);`npm run check:erp -- --shot[=目录]` 存明暗两张截图
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const SHOT_DIR = (() => {
  const a = process.argv.find((x) => x.startsWith('--shot'))
  return a ? (a.split('=')[1] || path.join(os.tmpdir(), 'erp-shots')) : null
})()
async function shot(page, name) {
  if (!SHOT_DIR) return
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
  console.log(`SHOT  ${path.join(SHOT_DIR, `${name}.png`)}`)
}

/** 表格视图快照:按表头文本定位列(data-coltype 对 rowlink/lookup/formula 一律折成 text,只能数下标)。 */
const TABLE_SNAPSHOT = () => {
  const heads = [...document.querySelectorAll('.amx-db-hrow .amx-db-th-name')].map((e) => e.textContent.trim())
  const rows = [...document.querySelectorAll('.amx-db-row:not(.amx-db-hrow)')].filter((r) => r.querySelectorAll('.amx-db-cell').length === heads.length)
  const cell = (r, name) => r.querySelectorAll('.amx-db-cell')[heads.indexOf(name)]
  const text = (r, name) => { const c = cell(r, name); if (!c) return null; const inp = c.querySelector('input'); return (inp ? inp.value : c.innerText).trim() }
  const byCustomer = {}
  for (const r of rows) {
    const key = text(r, '客户')
    byCustomer[key] = {
      chips: cell(r, '配件(多选)')?.querySelectorAll('.amx-db-chip').length ?? -1,
      lines: text(r, '出库行'), hw: text(r, '硬件总额/JPY'), fee: text(r, '服务费/JPY'), total: text(r, '总计/JPY'),
      deposit: text(r, '定金/JPY'), extra: text(r, '配件总价/JPY'), month: text(r, '月份'), no: text(r, '订单号'), created: text(r, '创建日期'),
    }
  }
  const store = window.__dbStore.getState().entries['订单总表.db']
  return {
    heads, rowCount: rows.length, byCustomer,
    errs: document.querySelectorAll('.amx-db-computed[data-err]').length,
    storeKeys: store ? Object.keys(store.data.rows[0].cells) : [],
    activeTab: document.querySelector('.amx-db-viewtab[data-active]')?.textContent.trim() ?? '',
  }
}
const KANBAN_SNAPSHOT = () => ({
  lanes: document.querySelectorAll('.amx-db-lane').length,
  cards: [...document.querySelectorAll('.amx-db-lane-count')].reduce((s, e) => s + (parseInt(e.textContent, 10) || 0), 0),
  activeTab: document.querySelector('.amx-db-viewtab[data-active]')?.textContent.trim() ?? '',
  dark: document.documentElement.classList.contains('dark') || document.documentElement.getAttribute('data-mode') === 'dark',
})

/** 列边界对齐快照:三种行各自是独立 grid,溢出时 1fr 若按各行自己的内容解析就会错位(2026-09-02 实报:表头 140 / 数据行 161·187)。 */
const ALIGN_SNAPSHOT = () => {
  const edges = (row, sel) => [...row.querySelectorAll(`:scope > ${sel}`)].map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.right] })
  const head = edges(document.querySelector('.amx-db-hrow'), '.amx-db-th')
  const stats = edges(document.querySelector('.amx-db-statsrow'), '.amx-db-stat')
  const rows = [...document.querySelectorAll('.amx-db-row:not(.amx-db-hrow):not(.amx-db-statsrow)')].map((r) => edges(r, '.amx-db-cell')).filter((c) => c.length === head.length)
  let maxDev = 0
  for (const cells of [stats, ...rows]) for (let i = 0; i < head.length; i++) maxDev = Math.max(maxDev, Math.abs(cells[i][0] - head[i][0]), Math.abs(cells[i][1] - head[i][1]))
  const sc = document.querySelector('.amx-db-scroll')
  const w = (c) => Math.round(c[1][1] - c[1][0]) // 第二列(首个 1fr 列)的宽
  return { cols: head.length, rows: rows.length, maxDev: Math.round(maxDev * 100) / 100, overflow: sc.scrollWidth - sc.clientWidth, widths: [head, stats, ...rows].map(w) }
}

/** 列宽上界(px)。来源:2026-09-02 实测 ?erp 订单总表 20 列 @1400×900 视口(Chromium for Testing,系统字体):
 *  夹具基线(最长格 = 25 字 nowrap 反向 lookup 拼接值)maxW≈212-223px(首屏与二次导航差 ~10px);31 字 → 281-294px;
 *  38 字 → 350px;44 字 → 420px;60 字 → 504px;60 个汉字 → 784px。
 *  取 260 = 基线 + ~20% 余量:能抓住 ≥ ~30 字的 nowrap 值把全表撑爆,又不被字体/滚动条差异误伤。
 *  ⚠️ 换了修法(候选 A 按内容定宽 / B 全定宽)后这里应**收紧**而不是放宽。 */
const COL_W_MAX = 260
/** 列宽快照:表头 .amx-db-th 的实际宽(不含 28px 行首 / 36px 加列两条固定轨)+ 滚动容器总宽。 */
const WIDTH_SNAPSHOT = () => {
  const ths = [...document.querySelector('.amx-db-hrow').querySelectorAll(':scope > .amx-db-th')]
  const cols = ths.map((e) => ({ name: (e.querySelector('.amx-db-th-name') || {}).textContent, w: Math.round(e.getBoundingClientRect().width * 10) / 10 }))
  const sc = document.querySelector('.amx-db-scroll')
  const maxW = Math.max(...cols.map((c) => c.w))
  const widest = cols.filter((c) => c.w === maxW)
  // 现行 CSS 下全列等宽(都被最宽格拉平),widest 报「全部 N 列等宽」而不是误导性的首列名
  return { n: cols.length, maxW, widest: widest.length === cols.length ? `全部 ${cols.length} 列等宽` : widest.map((c) => c.name).join('/'), scrollWidth: sc.scrollWidth, overflow: sc.scrollWidth - sc.clientWidth }
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.goto(`${BASE}?erp`)
    await page.waitForSelector('.amx-db-row:not(.amx-db-hrow)', { timeout: 15000 })
    const s = await page.evaluate(TABLE_SNAPSHOT)
    const z = s.byCustomer['张三'] || {}, li = s.byCustomer['李四'] || {}, w = s.byCustomer['王五'] || {}
    check('E0 订单总表 3 行上屏,激活 tab=订单总表', s.rowCount === 3 && s.activeTab === '订单总表', `rows=${s.rowCount} tab=${s.activeTab}`)
    check('E1 多值关联:张三「配件(多选)」2 枚 chip', z.chips === 2, `chips=${z.chips}`)
    check('E2 反向引用:张三「出库行」= 张三-CPU、张三-显卡(顿号)', z.lines === '张三-CPU、张三-显卡', `lines=${z.lines}`)
    check('E2b 反向引用:王五无出库行 → –', w.lines === '–', `lines=${w.lines}`)
    check('E3 公式链:硬件总额 112000 / 服务费 11696 / 总计 125196 / 定金 25039', z.hw === '112000' && z.fee === '11696' && z.total === '125196' && z.deposit === '25039', JSON.stringify([z.hw, z.fee, z.total, z.deposit]))
    check('E3b 多值 lookup sum:配件总价 24000', z.extra === '24000', `extra=${z.extra}`)
    check('E3c format(创建日期):张三 2026-03 / 王五 2026-04', z.month === '2026-03' && w.month === '2026-04', `${z.month} ${w.month}`)
    check('E3d 李四(无运费、只 CPU):总计 30726 定金 6145', li.total === '30726' && li.deposit === '6145', `${li.total} ${li.deposit}`)
    check('E3e 全表无 #错误 / #循环', s.errs === 0, `errs=${s.errs}`)
    check('E4 自动编号带前缀 ORD-1;created 上屏', z.no === 'ORD-1' && (z.created || '').startsWith('2026-03-15'), `no=${z.no} created=${z.created}`)
    check('E5 计算列不落盘(store cells 无 o_hw/o_lines/o_p_cpu)', !['o_hw', 'o_lines', 'o_p_cpu', 'o_month'].some((k) => s.storeKeys.includes(k)), s.storeKeys.join(','))
    const al = await page.evaluate(ALIGN_SNAPSHOT)
    check('E9 溢出态:表头/数据行/页脚列边界逐像素对齐(≤0.5px)', al.overflow > 0 && al.rows === 3 && al.maxDev <= 0.5, `overflow=${al.overflow} maxDev=${al.maxDev} col2 widths(head,stats,rows)=${al.widths.join('/')}`)
    await shot(page, 'erp-table-light')

    // 负对照(经注入口,证明 E1/E2 的断言会翻红):多选格改成单值字符串;反向列去掉 lookupBackCol
    const neg = await page.evaluate(async () => {
      const fx = window.__erp.fixture()
      const order = fx['订单总表.db']
      order.rows[0].cells.o_extra = 's03'
      const lines = order.columns.find((c) => c.id === 'o_lines'); delete lines.lookupBackCol
      window.__erp.load(fx)
      await new Promise((r) => setTimeout(r, 400))
      return { rows: document.querySelectorAll('.amx-db-row:not(.amx-db-hrow)').length }
    })
    const n = await page.evaluate(TABLE_SNAPSHOT)
    const nz = n.byCustomer['张三'] || {}
    check('负对照 注入单值配件 → E1 翻红(chip=1)', neg.rows >= 3 && nz.chips === 1, `chips=${nz.chips}`)
    check('负对照 注入去掉 lookupBackCol → E2 翻红(出库行=–)', nz.lines === '–', `lines=${nz.lines}`)
    check('负对照 注入后其它公式仍对(注入口没把表弄坏)', nz.hw === '103000', `hw=${nz.hw}`)

    await page.goto(`${BASE}?erp&view=看板`)
    await page.waitForSelector('.amx-db-lane', { timeout: 15000 })
    const k = await page.evaluate(KANBAN_SNAPSHOT)
    check('E6 看板泳道 = 4 选项 + 未分组 = 5;卡数之和 = 3;激活 tab=看板', k.lanes === 5 && k.cards === 3 && k.activeTab === '看板', JSON.stringify(k))

    await page.goto(`${BASE}?erp&db=出库记录.db&view=看板`)
    await page.waitForSelector('.amx-db-lane', { timeout: 15000 })
    const k2 = await page.evaluate(KANBAN_SNAPSHOT)
    // 2026-09-02 夹具加了第 4 行出库(x4,E9c/E9d 的长 lookup 值)→ 3 卡改 4 卡
    check('E6b 出库记录看板:5 泳道、4 卡', k2.lanes === 5 && k2.cards === 4, JSON.stringify(k2))

    await page.goto(`${BASE}?erp&view=看板&dark`)
    await page.waitForSelector('.amx-db-lane', { timeout: 15000 })
    const d = await page.evaluate(KANBAN_SNAPSHOT)
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.amx-dbview')).backgroundColor)
    check('E7 暗色档:同样 5 泳道 3 卡,且真主题已切暗', d.lanes === 5 && d.cards === 3 && d.dark, `${JSON.stringify(d)} bg=${bg}`)
    await shot(page, 'erp-kanban-dark')

    // E9b 分组路径(.amx-db-group 包着数据行)在 900px 视口必溢出;dbdemo 那张表带分组 + 多列排序
    await page.setViewportSize({ width: 900, height: 900 })
    await page.goto(`${BASE}?dbdemo`)
    await page.waitForSelector('.amx-db-row:not(.amx-db-hrow) .amx-db-cell', { timeout: 15000 })
    const al2 = await page.evaluate(ALIGN_SNAPSHOT)
    check('E9b ?dbdemo 分组路径 900px 溢出态同样逐像素对齐', al2.overflow > 0 && al2.rows >= 3 && al2.maxDev <= 0.5, `overflow=${al2.overflow} rows=${al2.rows} maxDev=${al2.maxDev} col2 widths=${al2.widths.join('/')}`)
    await shot(page, 'dbdemo-table-900')

    // ── L 系列(P1-1 titleCol / P1-2 refFilter,关联三件):芯片显示列 + picker 候选限定;夹具见 harness ?erp ──
    //   L1 出库记录「订单总表」芯片 = ORD-1(titleCol=o_no),不是订单总表首列的客户名
    //   L2 订单总表「CPU」picker 只列 s_type=cpu 的 SKU;「显卡」只列显卡
    //   负对照经注入口:去掉 titleCol → 芯片变回客户名;去掉 refFilter → picker 列全部 4 个 SKU(两条必须翻红)
    const OUT_SNAPSHOT = () => {
      const heads = [...document.querySelectorAll('.amx-db-hrow .amx-db-th-name')].map((e) => e.textContent.trim())
      const rows = [...document.querySelectorAll('.amx-db-row:not(.amx-db-hrow)')].filter((r) => r.querySelectorAll('.amx-db-cell').length === heads.length)
      const out = {}
      for (const r of rows) {
        const cells = r.querySelectorAll('.amx-db-cell')
        const key = cells[heads.indexOf('备注')]?.querySelector('input')?.value
        out[key] = [...cells[heads.indexOf('订单总表')].querySelectorAll('.amx-db-chip')].map((c) => c.textContent.trim()).join(',')
      }
      return out
    }
    /** 打开某客户行某关联列的 picker(点 .amx-db-cellbtn),返回是否点到。 */
    const OPEN_PICKER = ([customer, colName]) => {
      const heads = [...document.querySelectorAll('.amx-db-hrow .amx-db-th-name')].map((e) => e.textContent.trim())
      const rows = [...document.querySelectorAll('.amx-db-row:not(.amx-db-hrow)')].filter((r) => r.querySelectorAll('.amx-db-cell').length === heads.length)
      const row = rows.find((r) => r.querySelectorAll('.amx-db-cell')[heads.indexOf('客户')]?.querySelector('input')?.value === customer)
      const btn = row?.querySelectorAll('.amx-db-cell')[heads.indexOf(colName)]?.querySelector('.amx-db-cellbtn')
      if (!btn) return false
      btn.click()
      return true
    }
    const PICKER_ITEMS = () => [...document.querySelectorAll('.amx-db-pop .amx-db-opt:not(.amx-db-opt-clear)')].map((b) => b.textContent.replace('✓', '').trim())
    const pickerOf = async (customer, colName) => {
      const hit = await page.evaluate(OPEN_PICKER, [customer, colName])
      if (!hit) return null
      await page.waitForSelector('.amx-db-pop', { timeout: 5000 })
      const items = await page.evaluate(PICKER_ITEMS)
      await page.keyboard.press('Escape')
      await page.waitForSelector('.amx-db-pop', { state: 'detached', timeout: 5000 })
      return items
    }
    await page.setViewportSize({ width: 1400, height: 900 })
    await page.goto(`${BASE}?erp&db=出库记录.db`)
    await page.waitForSelector('.amx-db-row:not(.amx-db-hrow) .amx-db-cell', { timeout: 15000 })
    const l1 = await page.evaluate(OUT_SNAPSHOT)
    check('L1 芯片显示列:出库记录「订单总表」芯片 = ORD-1 / ORD-1 / ORD-2(titleCol=o_no,不是客户名)', l1['张三-CPU'] === 'ORD-1' && l1['张三-显卡'] === 'ORD-1' && l1['李四-内存'] === 'ORD-2', JSON.stringify(l1))
    await page.evaluate(async () => {
      const fx = window.__erp.fixture()
      delete fx['出库记录.db'].columns.find((c) => c.id === 'x_order').titleCol
      window.__erp.load(fx)
      await new Promise((r) => setTimeout(r, 400))
    })
    const l1n = await page.evaluate(OUT_SNAPSHOT)
    check('负对照 注入去掉 titleCol → L1 翻红(芯片回落首列 = 客户名 张三)', l1n['张三-CPU'] === '张三' && l1n['李四-内存'] === '李四', JSON.stringify(l1n))

    await page.goto(`${BASE}?erp`)
    await page.waitForSelector('.amx-db-row:not(.amx-db-hrow) .amx-db-cell', { timeout: 15000 })
    const cpuItems = await pickerOf('张三', 'CPU')
    const gpuItems = await pickerOf('张三', '显卡')
    check('L2 候选限定:「CPU」picker 只列 s_type=cpu 的 1 个 SKU(Intel i5-12400F)', !!cpuItems && cpuItems.length === 1 && cpuItems[0] === 'Intel i5-12400F', JSON.stringify(cpuItems))
    check('L2b 候选限定:「显卡」picker 只列 RTX 4060 8G', !!gpuItems && gpuItems.length === 1 && gpuItems[0] === 'RTX 4060 8G', JSON.stringify(gpuItems))
    await page.evaluate(async () => {
      const fx = window.__erp.fixture()
      delete fx['订单总表.db'].columns.find((c) => c.id === 'o_cpu').refFilter
      window.__erp.load(fx)
      await new Promise((r) => setTimeout(r, 400))
    })
    await page.waitForSelector('.amx-db-row:not(.amx-db-hrow) .amx-db-cell', { timeout: 15000 })
    const cpuAll = await pickerOf('张三', 'CPU')
    check('负对照 注入去掉 refFilter → L2 翻红(CPU picker 列全部 4 个 SKU)', !!cpuAll && cpuAll.length === 4, JSON.stringify(cpuAll))

    // L3/L4 可编辑投影列(W2-A):库存表「出库(投影)」= 出库记录里 x_part 指回本行的行(chip 文案 = 出库记录首列 备注);
    //   picker 挑一行 → **对侧表**(出库记录)x_part 变(单值列 = 覆盖,原持有行失去它)、本表 store 永无 s_links cell;
    //   负对照 = 注入去掉 lookupKind → 退回普通反向 lookup(无 lookupCol → 空):无 chip、无可点按钮
    const STOCK_SNAPSHOT = () => {
      const heads = [...document.querySelectorAll('.amx-db-hrow .amx-db-th-name')].map((e) => e.textContent.trim())
      const rows = [...document.querySelectorAll('.amx-db-row:not(.amx-db-hrow)')].filter((r) => r.querySelectorAll('.amx-db-cell').length === heads.length)
      const out = {}
      for (const r of rows) {
        const cells = r.querySelectorAll('.amx-db-cell')
        const key = cells[heads.indexOf('货物名称')]?.querySelector('input')?.value
        const c = cells[heads.indexOf('出库(投影)')]
        out[key] = { chips: c ? [...c.querySelectorAll('.amx-db-chip')].map((x) => x.textContent.trim()) : null, btn: !!c?.querySelector('[data-backlink] .amx-db-cellbtn') }
      }
      const st = window.__dbStore.getState().entries
      return {
        rows: out,
        stockKeys: [...new Set(st['库存表.db'].data.rows.flatMap((r) => Object.keys(r.cells)))],
        outParts: Object.fromEntries(st['出库记录.db'].data.rows.map((r) => [r.id, r.cells.x_part ?? null])),
      }
    }
    const OPEN_STOCK_PICKER = (name) => {
      const heads = [...document.querySelectorAll('.amx-db-hrow .amx-db-th-name')].map((e) => e.textContent.trim())
      const rows = [...document.querySelectorAll('.amx-db-row:not(.amx-db-hrow)')].filter((r) => r.querySelectorAll('.amx-db-cell').length === heads.length)
      const row = rows.find((r) => r.querySelectorAll('.amx-db-cell')[heads.indexOf('货物名称')]?.querySelector('input')?.value === name)
      const btn = row?.querySelectorAll('.amx-db-cell')[heads.indexOf('出库(投影)')]?.querySelector('[data-backlink] .amx-db-cellbtn')
      if (!btn) return false
      btn.click()
      return true
    }
    await page.goto(`${BASE}?erp&db=库存表.db`)
    await page.waitForSelector('.amx-db-row:not(.amx-db-hrow) .amx-db-cell', { timeout: 15000 })
    const l3 = await page.evaluate(STOCK_SNAPSHOT)
    const i5 = l3.rows['Intel i5-12400F'], ddr = l3.rows['DDR5 32G'], ssd = l3.rows['1T SSD']
    check('L3 投影列渲 chip:i5 = [张三-CPU];DDR5 = [李四-内存, DDR5 32G 6000MHz 套条];SSD 空且可点;store 无 s_links', !!i5 && i5.chips.join() === '张三-CPU' && ddr.chips.join() === '李四-内存,DDR5 32G 6000MHz 套条' && ssd.chips.length === 0 && ssd.btn && !l3.stockKeys.includes('s_links'), JSON.stringify({ i5, ddr, ssd, keys: l3.stockKeys }))
    const hitPick = await page.evaluate(OPEN_STOCK_PICKER, '1T SSD')
    await page.waitForSelector('.amx-db-pop', { timeout: 5000 })
    const projItems = await page.evaluate(PICKER_ITEMS)
    check('L4 picker 候选 = 出库记录 4 行(备注文案)', hitPick && projItems.length === 4 && projItems.includes('张三-显卡'), JSON.stringify(projItems))
    await page.evaluate(() => { [...document.querySelectorAll('.amx-db-pop .amx-db-opt')].find((b) => b.textContent.startsWith('张三-显卡')).click() })
    await page.waitForTimeout(300)
    const l4 = await page.evaluate(STOCK_SNAPSHOT)
    check('L4b 挑「张三-显卡」→ 对侧 x2.x_part = s04(覆盖 s02)、RTX 4060 失去 chip、SSD 得到 chip;弹层不关;本表 store 仍无 s_links', l4.outParts.x2 === 's04' && l4.outParts.x1 === 's01' && l4.rows['1T SSD'].chips.join() === '张三-显卡' && l4.rows['RTX 4060 8G'].chips.length === 0 && !l4.stockKeys.includes('s_links') && !!(await page.$('.amx-db-pop')), JSON.stringify({ parts: l4.outParts, ssd: l4.rows['1T SSD'], rtx: l4.rows['RTX 4060 8G'], keys: l4.stockKeys }))
    await page.keyboard.press('Escape')
    await page.waitForSelector('.amx-db-pop', { state: 'detached', timeout: 5000 })
    await page.evaluate(async () => {
      const fx = window.__erp.fixture()
      delete fx['库存表.db'].columns.find((c) => c.id === 's_links').lookupKind
      window.__erp.load(fx)
      await new Promise((r) => setTimeout(r, 400))
    })
    await page.waitForSelector('.amx-db-row:not(.amx-db-hrow) .amx-db-cell', { timeout: 15000 })
    const l3n = await page.evaluate(STOCK_SNAPSHOT)
    check('负对照 注入去掉 lookupKind → L3 翻红(i5 无 chip、无可点按钮)', !!l3n.rows['Intel i5-12400F'] && l3n.rows['Intel i5-12400F'].chips.length === 0 && !l3n.rows['Intel i5-12400F'].btn, JSON.stringify(l3n.rows['Intel i5-12400F']))

    // E9c/E9d 列宽上界(错位候选 C):回到 1400 视口的订单总表;前置条件仍是真溢出
    await page.setViewportSize({ width: 1400, height: 900 })
    await page.goto(`${BASE}?erp`)
    await page.waitForSelector('.amx-db-row:not(.amx-db-hrow)', { timeout: 15000 })
    const wd = await page.evaluate(WIDTH_SNAPSHOT)
    check(`E9c 任一列宽 ≤ ${COL_W_MAX}px(夹具含 25 字 nowrap lookup 值)`, wd.overflow > 0 && wd.maxW <= COL_W_MAX, `maxW=${wd.maxW} widest=${wd.widest} n=${wd.n}`)
    check(`E9d 表总宽 ≤ 64 + ${COL_W_MAX}×列数`, wd.overflow > 0 && wd.scrollWidth <= 64 + COL_W_MAX * wd.n, `scrollWidth=${wd.scrollWidth} bound=${64 + COL_W_MAX * wd.n}`)
    // 负对照:x3 备注加长到 38 字 → 全表列宽被拉过上界(E9c/E9d 的断言真会翻红)
    const wn = await page.evaluate(async () => {
      const fx = window.__erp.fixture()
      fx['出库记录.db'].rows[3].cells.x_title = '李四-内存 DDR5 32G 6000MHz 套条(含散热马甲,白色限定版)'
      window.__erp.load(fx)
      await new Promise((r) => setTimeout(r, 400))
      const ths = [...document.querySelector('.amx-db-hrow').querySelectorAll(':scope > .amx-db-th')]
      const ws = ths.map((e) => e.getBoundingClientRect().width)
      const sc = document.querySelector('.amx-db-scroll')
      return { n: ws.length, maxW: Math.round(Math.max(...ws)), scrollWidth: sc.scrollWidth }
    })
    check('负对照 注入 38 字 lookup 值(拼接后 44 字)→ E9c 翻红(maxW > 上界)', wn.maxW > COL_W_MAX, `maxW=${wn.maxW}`)
    check('负对照 注入 38 字 lookup 值(拼接后 44 字)→ E9d 翻红(总宽 > 上界)', wn.scrollWidth > 64 + COL_W_MAX * wn.n, `scrollWidth=${wn.scrollWidth} bound=${64 + COL_W_MAX * wn.n}`)

    // ── F 系列(P1-4 表单视图 view.type='form'):夹具订单总表第 3 个视图「下单表单」(required=o_customer,defaults o_status=未确认) ──
    //   F1 字段集 = 列序 − 计算列 − 盖章列:含 客户/订单状态/运费/CPU…,不含 订单号/创建日期/CPU单价/硬件总额/月份/出库行;默认 订单状态 = 未确认
    //   F2 填客户「赵六」提交 → rows 3→4、**恰好 1 次 mutate**(整行一次落盘)、新行 o_no=4(盖章)、o_created 非空、o_status=未确认、无计算列键;留在表单且已清空
    //   F3 客户留空提交 → rows 不变、字段标 data-err
    //   F4 after='table' → 提交后激活 tab 跳到「订单总表」
    //   负对照经注入口:去掉 required → 空提交也加行(F3 翻红);defaults.o_no=999 → 新行 o_no 仍 = 4(盖章压最后);hidden=['o_ship'] → 运费字段消失(F1 翻红)
    const FORM_SNAPSHOT = () => {
      const rows = window.__dbStore.getState().entries['订单总表.db'].data.rows
      const last = rows[rows.length - 1]
      return {
        title: document.querySelector('.amx-db-form-title')?.textContent.trim() ?? '',
        fields: [...document.querySelectorAll('.amx-db-form-field')].map((f) => f.querySelector('.amx-db-form-label').textContent.replace('*', '').trim()),
        required: [...document.querySelectorAll('.amx-db-form-field[data-required]')].map((f) => f.dataset.col),
        desc: document.querySelector('.amx-db-form-field[data-col="o_customer"] .amx-db-form-desc')?.textContent.trim() ?? '',
        customer: document.querySelector('.amx-db-form-field[data-col="o_customer"] input')?.value ?? null,
        status: document.querySelector('.amx-db-form-field[data-col="o_status"] .amx-db-cellbtn')?.textContent.trim() ?? '',
        errs: [...document.querySelectorAll('.amx-db-form-field[data-err]')].map((f) => f.dataset.col),
        submit: document.querySelector('.amx-db-form-submit')?.textContent.trim() ?? '',
        done: document.querySelector('.amx-db-form-done')?.textContent.trim() ?? '',
        rows: rows.length, last: last ? last.cells : null,
        activeTab: document.querySelector('.amx-db-viewtab[data-active]')?.textContent.trim() ?? '',
        mut: window.__mut ?? -1,
      }
    }
    /** 包一层 store.mutate 计数(DatabaseEmbed 每次调用都从 getState() 现取,换掉即生效)。 */
    const COUNT_MUTATE = () => {
      const st = window.__dbStore
      const orig = st.getState().mutate
      window.__mut = 0
      st.setState({ mutate: (ref, fn) => { window.__mut++; return orig(ref, fn) } })
    }
    const FORM_URL = `${BASE}?erp&view=${encodeURIComponent('下单表单')}`
    const CUSTOMER_INPUT = '.amx-db-form-field[data-col="o_customer"] input'
    const settle = () => page.waitForTimeout(300)
    await page.goto(FORM_URL)
    await page.waitForSelector('.amx-db-form-submit', { timeout: 15000 })
    const f1 = await page.evaluate(FORM_SNAPSHOT)
    const NOT_FIELDS = ['订单号', '创建日期', 'CPU单价/JPY', '硬件总额/JPY', '月份', '出库行', '配件总价/JPY']
    check('F1 表单字段集:含 客户/订单状态/运费/CPU/配件(多选),不含盖章列与计算列;激活 tab=下单表单', ['客户', '订单状态', '运费', 'CPU', '配件(多选)'].every((n) => f1.fields.includes(n)) && !NOT_FIELDS.some((n) => f1.fields.includes(n)) && f1.activeTab === '下单表单', JSON.stringify(f1.fields))
    check('F1b 必填星标 = 客户;默认值 订单状态=未确认 已预填;说明 / 提交文案上屏', f1.required.join() === 'o_customer' && f1.status === '未确认' && f1.desc === '客户姓名' && f1.submit === '提交订单', JSON.stringify({ req: f1.required, status: f1.status, desc: f1.desc, submit: f1.submit }))
    await shot(page, 'erp-form-light')

    await page.fill(CUSTOMER_INPUT, '赵六')
    await page.evaluate(COUNT_MUTATE)
    await page.click('.amx-db-form-submit')
    await settle()
    const f2 = await page.evaluate(FORM_SNAPSHOT)
    check('F2 提交一次 → rows 3→4;恰好 1 次 mutate(整行一次落盘,不是 addRow 后逐 setCell)', f2.rows === 4 && f2.mut === 1, `rows=${f2.rows} mut=${f2.mut}`)
    check('F2b 新行:客户=赵六、状态=未确认(默认值)、o_no=4 / o_created 有值(盖章)、无计算列键', !!f2.last && f2.last.o_customer === '赵六' && f2.last.o_status === '未确认' && f2.last.o_no === 4 && typeof f2.last.o_created === 'string' && f2.last.o_created.length >= 10 && !['o_hw', 'o_lines', 'o_p_cpu', 'o_month'].some((k) => k in f2.last), JSON.stringify(f2.last))
    check('F2c 提交后留在表单:客户已清空、默认值仍预填、回执「已提交 1 条」', f2.customer === '' && f2.status === '未确认' && f2.done === '已提交 1 条' && f2.activeTab === '下单表单', JSON.stringify({ customer: f2.customer, status: f2.status, done: f2.done, tab: f2.activeTab }))

    await page.click('.amx-db-form-submit')
    await settle()
    const f3 = await page.evaluate(FORM_SNAPSHOT)
    check('F3 必填为空不提交:rows 仍 4、客户字段标 data-err、mutate 未增加', f3.rows === 4 && f3.errs.join() === 'o_customer' && f3.mut === 1, `rows=${f3.rows} errs=${f3.errs} mut=${f3.mut}`)

    // 负对照 a:去掉 required → 空提交也加行(证明 F3 的拦截来自 required)
    const loadForm = async (mut) => {
      await page.evaluate(async (mutSrc) => {
        const fx = window.__erp.fixture()
        const v = fx['订单总表.db'].views.find((x) => x.type === 'form')
        // eslint-disable-next-line no-new-func
        new Function('v', mutSrc)(v)
        window.__erp.load(fx)
        await new Promise((r) => setTimeout(r, 400))
      }, mut)
      await page.waitForSelector('.amx-db-form-submit', { timeout: 15000 })
    }
    await loadForm('delete v.form.required')
    await page.click('.amx-db-form-submit')
    await settle()
    const na = await page.evaluate(FORM_SNAPSHOT)
    check('负对照 注入去掉 required → F3 翻红(空提交也加行 rows=4,无 data-err)', na.rows === 4 && na.errs.length === 0, `rows=${na.rows} errs=${na.errs}`)
    // 负对照 b:defaults 塞盖章列 o_no=999 → 新行 o_no 仍是盖章的 4(defaults 改不了盖章列)
    await loadForm('v.form.defaults.o_no = 999')
    await page.fill(CUSTOMER_INPUT, '钱七')
    await page.click('.amx-db-form-submit')
    await settle()
    const nb = await page.evaluate(FORM_SNAPSHOT)
    check('守卫 注入 defaults.o_no=999 → 新行 o_no 仍 = 4(盖章压最后 + 提交前剥盖章键)', nb.rows === 4 && !!nb.last && nb.last.o_no === 4 && nb.last.o_customer === '钱七', JSON.stringify(nb.last))
    // 负对照 c:hidden 掉运费 → 字段集少一项(证明 F1 的字段集断言是活的)
    await loadForm("v.hidden = ['o_ship']")
    const nc = await page.evaluate(FORM_SNAPSHOT)
    check('负对照 注入 hidden=[o_ship] → F1 翻红(运费字段消失)', !nc.fields.includes('运费') && nc.fields.includes('客户'), JSON.stringify(nc.fields))
    // F4 after='table':提交后跳到表格视图
    await loadForm("v.form.after = 'table'")
    await page.fill(CUSTOMER_INPUT, '孙八')
    await page.click('.amx-db-form-submit')
    await settle()
    const f4 = await page.evaluate(FORM_SNAPSHOT)
    check('F4 after=table:提交后激活 tab 跳到「订单总表」且 rows=4', f4.activeTab === '订单总表' && f4.rows === 4, `tab=${f4.activeTab} rows=${f4.rows}`)
    // F5 表单视图工具栏没有通用「新建」(直接 addRow() 绕过必填/默认值,建行只走表单提交);负对照 = 同一选择器在表格视图必须存在(证明选择器没坏)
    //   ⚠️ 选择器必须限定在工具栏 .amx-db-viewbar 里:FormBody 的提交按钮复用了 .amx-db-newbtn 样式类,裸选会把它当成「新建」(首跑就是这么红的)
    await page.goto(FORM_URL)
    await page.waitForSelector('.amx-db-form-submit', { timeout: 15000 })
    const f5 = await page.evaluate(() => ({ newbtn: !!document.querySelector('.amx-db-viewbar .amx-db-newbtn'), tab: document.querySelector('.amx-db-viewtab[data-active]')?.textContent.trim() ?? '' }))
    check('F5 表单视图工具栏无通用「新建」按钮', !f5.newbtn && f5.tab === '下单表单', JSON.stringify(f5))
    await page.goto(`${BASE}?erp`)
    await page.waitForSelector('.amx-db-hrow', { timeout: 15000 })
    const f5n = await page.evaluate(() => ({ newbtn: !!document.querySelector('.amx-db-viewbar .amx-db-newbtn'), tab: document.querySelector('.amx-db-viewtab[data-active]')?.textContent.trim() ?? '' }))
    check('负对照 表格视图同一选择器有「新建」(F5 的选择器是活的)', f5n.newbtn && f5n.tab !== '下单表单', JSON.stringify(f5n))

    // ── G 系列(W2-E 甘特视图 view.type='gantt'):夹具 任务表.db 第 2 个视图「甘特」(startCol=t_date,endCol 缺 = 同列,scale 缺 = day);
    //   5 行:k1 区间(已过 3 天)/ k2 今天单日 / k3 带时刻单日 / k4 区间(将来 5 天)/ k5 无日期
    //   G1 条数 = 有日期行数 = 4(**固定数**,别从 store 现算 —— 负对照清日期后两边一起变、断言恒绿);无日期行恰 1 条、在标题列最底、标 data-undated
    //   G2 条的 left 随 data-start 单调不减;单日条宽 = 28px(日档一天),k4 5 天 = 140px
    //   G3 今日线存在,且 left = 今天开始的 k2 条的 left(±0.5px;线宽 2 / margin-left −1,取 rect.left + 1)
    //   G4 点「周」→ root data-scale=week、canvas 变窄、k4 宽 40px(5 天 × 8);落盘 view.gantt.scale=week 且 startCol 没被冲掉(嵌套配置 spread)
    //   G5 点行标题 → .amx-db-roweditor 出现(走 RowEditor 那条路,不是第三个分发点)
    //   G6 视图「甘特(截止)」endCol=t_due(周档):k4 条 = t_date 起侧 → t_due = 8 天 × 8 = 64px(独立结束列压过同格区间的末侧)
    //   负对照经注入口:删掉 k2 的 t_date → 条 3 ≠ 4(G1 翻红)、无日期 2 条
    const GANTT_SNAPSHOT = () => {
      const bars = [...document.querySelectorAll('.amx-db-gantt-bar')].map((b) => { const r = b.getBoundingClientRect(); return { id: b.dataset.row, s: b.dataset.start, e: b.dataset.end, left: Math.round(r.left * 10) / 10, width: Math.round(r.width * 10) / 10 } })
      const labels = [...document.querySelectorAll('.amx-db-gantt-label')].map((l) => ({ id: l.dataset.row, undated: 'undated' in l.dataset }))
      const today = document.querySelector('.amx-db-gantt-today')
      const canvas = document.querySelector('.amx-db-gantt-canvas')
      const tab = document.querySelector('.amx-db-viewtab[data-active]')?.textContent.trim() ?? ''
      const v = (window.__dbStore.getState().entries['任务表.db']?.data.views ?? []).find((x) => x.name === tab)
      return {
        bars, labels, activeTab: tab,
        todayLeft: today ? Math.round((today.getBoundingClientRect().left + 1) * 10) / 10 : null,
        canvasW: canvas ? Math.round(canvas.getBoundingClientRect().width) : 0,
        scale: document.querySelector('.amx-db-gantt')?.dataset.scale ?? '',
        cfg: v?.gantt ?? null,
        editor: !!document.querySelector('.amx-db-roweditor'),
      }
    }
    const GANTT_URL = `${BASE}?erp&db=${encodeURIComponent('任务表.db')}&view=${encodeURIComponent('甘特')}`
    await page.goto(GANTT_URL)
    await page.waitForSelector('.amx-db-gantt-bar', { timeout: 15000 })
    const g1 = await page.evaluate(GANTT_SNAPSHOT)
    const barOf = (snap, id) => snap.bars.find((b) => b.id === id) || {}
    const undatedIds = (snap) => snap.labels.filter((l) => l.undated).map((l) => l.id)
    check('G1 甘特:4 条 = 4 个有日期行;无日期 k5 恰 1 条、在标题列最底且标 data-undated;激活 tab=甘特', g1.bars.length === 4 && undatedIds(g1).join() === 'k5' && g1.labels[g1.labels.length - 1].id === 'k5' && g1.labels.length === 5 && g1.activeTab === '甘特', `bars=${g1.bars.length} undated=${undatedIds(g1)} last=${g1.labels[g1.labels.length - 1]?.id}`)
    const sortedByStart = [...g1.bars].sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0))
    const monotonic = sortedByStart.every((b, i) => i === 0 || b.left >= sortedByStart[i - 1].left)
    check('G2 条的 left 随日期单调;单日 k2 宽 28、k4 5 天宽 140、k1 3 天宽 84', monotonic && barOf(g1, 'k2').width === 28 && barOf(g1, 'k4').width === 140 && barOf(g1, 'k1').width === 84, JSON.stringify(sortedByStart.map((b) => [b.id, b.s, b.left, b.width])))
    check('G3 今日线存在且贴住今天开始的 k2 条(left ±0.5px)', g1.todayLeft != null && Math.abs(g1.todayLeft - barOf(g1, 'k2').left) <= 0.5, `today=${g1.todayLeft} k2=${barOf(g1, 'k2').left}`)
    await shot(page, 'erp-gantt-light')
    await page.click('.amx-db-gantt-scale[data-scale="week"]')
    await settle()
    const g4 = await page.evaluate(GANTT_SNAPSHOT)
    check('G4 切周档:data-scale=week、canvas 变窄、k4 宽 40;落盘 scale=week 且 startCol=t_date 未被冲掉', g4.scale === 'week' && g4.canvasW < g1.canvasW && barOf(g4, 'k4').width === 40 && g4.cfg && g4.cfg.scale === 'week' && g4.cfg.startCol === 't_date', `scale=${g4.scale} canvas=${g1.canvasW}→${g4.canvasW} k4=${barOf(g4, 'k4').width} cfg=${JSON.stringify(g4.cfg)}`)
    await page.click('.amx-db-gantt-label[data-row="k1"]')
    await page.waitForSelector('.amx-db-roweditor', { timeout: 5000 }).catch(() => {})
    const g5 = await page.evaluate(GANTT_SNAPSHOT)
    check('G5 点行标题 → 行编辑器 .amx-db-roweditor 打开(RowEditor 那条路)', g5.editor, `editor=${g5.editor}`)
    await page.keyboard.press('Escape')
    await page.goto(`${BASE}?erp&db=${encodeURIComponent('任务表.db')}&view=${encodeURIComponent('甘特(截止)')}`)
    await page.waitForSelector('.amx-db-gantt-bar', { timeout: 15000 })
    const g6 = await page.evaluate(GANTT_SNAPSHOT)
    check('G6 独立结束列 endCol=t_due(周档):k4 = 8 天 × 8 = 64px(压过同格区间末侧的 5 天);其余行仍 4 条', g6.scale === 'week' && barOf(g6, 'k4').width === 64 && g6.bars.length === 4, `k4=${barOf(g6, 'k4').width} bars=${g6.bars.length} scale=${g6.scale}`)
    await page.goto(`${GANTT_URL}&dark`)
    await page.waitForSelector('.amx-db-gantt-bar', { timeout: 15000 })
    await shot(page, 'erp-gantt-dark')
    // 负对照:删掉 k2 的日期 → 条 3(G1 的「= 4」翻红),无日期 2 条
    await page.goto(GANTT_URL)
    await page.waitForSelector('.amx-db-gantt-bar', { timeout: 15000 })
    await page.evaluate(async () => {
      const fx = window.__erp.fixture()
      delete fx['任务表.db'].rows.find((r) => r.id === 'k2').cells.t_date
      window.__erp.load(fx)
      await new Promise((r) => setTimeout(r, 400))
    })
    await page.waitForSelector('.amx-db-gantt-bar', { timeout: 15000 })
    const gn = await page.evaluate(GANTT_SNAPSHOT)
    check('负对照 注入删掉 k2 日期 → G1 翻红(条 3 ≠ 4;无日期 k2,k5 两条排底)', gn.bars.length === 3 && undatedIds(gn).join() === 'k2,k5', `bars=${gn.bars.length} undated=${undatedIds(gn)}`)

    // ── T 系列(W2-D 层级树 + 日期分组,夹具 任务表.db):视图「层级」(treeCol=t_parent,k1←k2←k3 三级链 + k4/k5 两个根)、
    //   「按日」(groupBy=t_date,groupUnit 缺 = 日档)、「按月」(groupUnit=month)
    //   T1 缩进层级正确:行序 k1,k2,k3,k4,k5,data-depth = 0,1,2,0,0;有子的 k1/k2 才有折叠钮;根容器 data-tree=tree;
    //      缩进条实测宽 = 18 + depth×14(16px 钮/占位 + 2px 右间距 + 每级 14px 缩进)—— 观感量,证明 depth 真画出来了
    //      (**必须验 data-tree** —— 只看「全是 0 层」的话,退回平铺时也全绿,是个假绿)
    //   T2 折叠 k1 → 子孙 k2/k3 消失,行数 5→3,k1 自己还在且钮变闭合态;再点回来恢复 5(折叠只是视线,不动数据)
    //   T3 造环(k1 的父指到 k3 → k1→k3→k2→k1)→ **仍然渲出全部 5 行**、不卡死、零折叠钮、**行上连 data-depth 都不出现**
    //      (退回平铺 = 与没配树列时逐字节同款的渲染,不是「画成一棵全 0 层的树」);data-tree=flat:cycle 让退因可见;
    //      store 行数照旧 5(没被清过)
    //   T3b 孤儿(k2 的父指到不在场的 gone = 「筛选/搜索把父行筛没了」)→ **当根,树不塌**:k2 到 depth 0、
    //      它下面的 k3 仍缩进在 1、k1 因失去唯一的子而不再有折叠钮;data-tree 仍是 tree(不是 flat:orphan),
    //      data-orphans=1 让「这是孤儿当根」与「父格本来就空」区分得开(2026-09-02 编排者裁决,理由见 tree.ts 文件头)
    //   T4 按日分组:组头 5 个 = 4 个日期组 + 「未设置」,且未设置**恒在最后**;各组卡数之和 = 5;按月档组数变少
    //   负对照:① treeCol 指到非自指列 t_type → 零折叠钮 + data-tree 属性消失(判据 isSelfRefCol 是活的)
    //          ② k3 的日期改成与 k2 同一天 → T4 的「5 组」翻红(4 组)
    const TREE_SNAPSHOT = () => {
      const rows = [...document.querySelectorAll('.amx-db-row:not(.amx-db-hrow):not(.amx-db-statsrow)')]
        .map((r) => ({ id: r.dataset.row, depth: r.dataset.depth === undefined ? null : Number(r.dataset.depth), kids: 'haskids' in r.dataset }))
      return {
        rows,
        carets: [...document.querySelectorAll('.amx-db-treecaret')].map((b) => ({ id: b.dataset.row, open: 'open' in b.dataset })),
        tree: document.querySelector('.amx-db-scroll')?.dataset.tree ?? null,
        // 孤儿数(buildTree.orphanIds.length):没这个的话「孤儿当根」与「父格本来就是空的」在 DOM 里逐字节同款 = 假绿
        orphans: document.querySelector('.amx-db-scroll')?.dataset.orphans ?? null,
        // 缩进的观感量:首个数据格里缩进条的实际宽(每级 14px),用来证明 depth 真的画出来了而不只是个属性
        leads: [...document.querySelectorAll('.amx-db-row:not(.amx-db-hrow) .amx-db-treelead')].map((e) => Math.round(e.getBoundingClientRect().width)),
        groups: [...document.querySelectorAll('.amx-db-group')].map((g) => ({
          key: g.dataset.group,
          count: Number(g.querySelector('.amx-db-lane-count')?.textContent ?? -1),
          none: !!g.querySelector('.amx-db-lane-none'),
        })),
        activeTab: document.querySelector('.amx-db-viewtab[data-active]')?.textContent.trim() ?? '',
        storeRows: window.__dbStore.getState().entries['任务表.db']?.data.rows.length ?? -1,
      }
    }
    const taskUrl = (v) => `${BASE}?erp&db=${encodeURIComponent('任务表.db')}&view=${encodeURIComponent(v)}`
    await page.goto(taskUrl('层级'))
    await page.waitForSelector('.amx-db-hrow', { timeout: 15000 })
    const t1 = await page.evaluate(TREE_SNAPSHOT)
    check(
      'T1 层级树:行序 k1,k2,k3,k4,k5 且 depth=0,1,2,0,0;折叠钮只在有子的 k1/k2;缩进条逐级 +14px;data-tree=tree',
      t1.rows.map((r) => `${r.id}:${r.depth}`).join(',') === 'k1:0,k2:1,k3:2,k4:0,k5:0' &&
        t1.carets.map((c) => c.id).join() === 'k1,k2' && t1.carets.every((c) => c.open) &&
        t1.leads.join() === t1.rows.map((r) => 18 + r.depth * 14).join() && t1.tree === 'tree' && t1.activeTab === '层级',
      `rows=${JSON.stringify(t1.rows)} carets=${JSON.stringify(t1.carets)} leads=${t1.leads} tree=${t1.tree}`,
    )
    await shot(page, 'erp-tree-light')
    await page.click('.amx-db-treecaret[data-row="k1"]')
    await settle()
    const t2 = await page.evaluate(TREE_SNAPSHOT)
    await page.click('.amx-db-treecaret[data-row="k1"]')
    await settle()
    const t2b = await page.evaluate(TREE_SNAPSHOT)
    check(
      'T2 折叠 k1:子孙 k2/k3 消失、行数 5→3(k1,k4,k5)、钮转闭合;再点回来恢复 5 行(折叠不动数据,store 恒 5)',
      t2.rows.map((r) => r.id).join() === 'k1,k4,k5' && t2.rows.length === 3 && t1.rows.length === 5 &&
        t2.carets.find((c) => c.id === 'k1') && !t2.carets.find((c) => c.id === 'k1').open &&
        t2b.rows.length === 5 && t2.storeRows === 5,
      `折叠后=${t2.rows.map((r) => r.id).join()} 展开后=${t2b.rows.length} store=${t2.storeRows}`,
    )
    // T3 环:k1 的父指到 k3 → k1→k3→k2→k1(注入口整份换表 + 重挂)
    await page.evaluate(async () => {
      const fx = window.__erp.fixture()
      fx['任务表.db'].rows.find((r) => r.id === 'k1').cells.t_parent = 'k3'
      window.__erp.load(fx)
      await new Promise((r) => setTimeout(r, 400))
    })
    await page.waitForSelector('.amx-db-hrow', { timeout: 15000 })
    const t3 = await page.evaluate(TREE_SNAPSHOT)
    check(
      'T3 环(k1→k3→k2→k1):不卡死,5 行一条不少、零折叠钮、无 data-depth(真平铺),data-tree=flat:cycle',
      t3.rows.length === 5 && t3.rows.map((r) => r.id).join() === 'k1,k2,k3,k4,k5' &&
        t3.rows.every((r) => r.depth === null) && t3.leads.length === 0 && t3.carets.length === 0 && t3.tree === 'flat:cycle' && t3.storeRows === 5,
      `rows=${JSON.stringify(t3.rows)} carets=${t3.carets.length} tree=${t3.tree}`,
    )
    // T3b 孤儿当根(2026-09-02 裁决,推翻首版的「孤儿 → 整表退平铺」):把 k2 的父指到不在场的 gone
    //   —— 这就是「筛选/搜索把父行筛没了」在渲染层的等价态。k2 当根,它下面的 k3 **保住缩进**;
    //   k1 因为失去了唯一的子而不再有折叠钮 —— 这一条是判别信号:若退回整表平铺则 5 行全 depth=null、零钮、
    //   data-tree=flat:orphan;若只是「父格被清空」则 data-orphans 不会出现。三者互不相同,不会假绿。
    await page.evaluate(async () => {
      const fx = window.__erp.fixture()
      fx['任务表.db'].rows.find((r) => r.id === 'k2').cells.t_parent = 'gone'
      window.__erp.load(fx)
      await new Promise((r) => setTimeout(r, 400))
    })
    await page.waitForSelector('.amx-db-hrow', { timeout: 15000 })
    const t3b = await page.evaluate(TREE_SNAPSHOT)
    check(
      'T3b 孤儿(k2 的父被筛没)→ **当根**不退平铺:depth=0,0,1,0,0、缩进条 18,18,32,18,18、折叠钮只剩 k2、data-tree=tree 且 data-orphans=1',
      t3b.rows.map((r) => `${r.id}:${r.depth}`).join(',') === 'k1:0,k2:0,k3:1,k4:0,k5:0' &&
        t3b.carets.map((c) => c.id).join() === 'k2' &&
        t3b.leads.join() === '18,18,32,18,18' && t3b.tree === 'tree' && t3b.orphans === '1' && t3b.storeRows === 5,
      `rows=${JSON.stringify(t3b.rows)} carets=${JSON.stringify(t3b.carets)} leads=${t3b.leads} tree=${t3b.tree} orphans=${t3b.orphans}`,
    )
    // 负对照 ①:treeCol 指到非自指列(多选列 t_type)→ 判据不认,层级整个不生效
    await page.evaluate(async () => {
      const fx = window.__erp.fixture()
      fx['任务表.db'].views.find((v) => v.name === '层级').treeCol = 't_type'
      window.__erp.load(fx)
      await new Promise((r) => setTimeout(r, 400))
    })
    await page.waitForSelector('.amx-db-hrow', { timeout: 15000 })
    const tn1 = await page.evaluate(TREE_SNAPSHOT)
    check('负对照 注入 treeCol=t_type(非自指列)→ T1 翻红(零折叠钮、无 depth 属性、data-tree 属性消失)',
      tn1.carets.length === 0 && tn1.tree === null && tn1.rows.length === 5 && tn1.rows.every((r) => r.depth === null),
      `carets=${tn1.carets.length} tree=${tn1.tree} depths=${tn1.rows.map((r) => r.depth)}`)
    // T4 日期分组(先回到干净夹具)
    await page.goto(taskUrl('按日'))
    await page.waitForSelector('.amx-db-group', { timeout: 15000 })
    const t4 = await page.evaluate(TREE_SNAPSHOT)
    const lastG = t4.groups[t4.groups.length - 1]
    check(
      'T4 按日分组:5 个组头 = 4 个日期组 + 「未设置」;未设置恒在最后且计数 1;各组行数之和 = 5;日期键升序',
      t4.groups.length === 5 && lastG.none && lastG.key === '__none' && lastG.count === 1 &&
        t4.groups.reduce((s, g) => s + g.count, 0) === 5 &&
        t4.groups.slice(0, 4).every((g, i, a) => /^\d{4}-\d{2}-\d{2}$/.test(g.key) && (i === 0 || a[i - 1].key < g.key)),
      JSON.stringify(t4.groups),
    )
    await page.goto(taskUrl('按月'))
    await page.waitForSelector('.amx-db-group', { timeout: 15000 })
    const t4m = await page.evaluate(TREE_SNAPSHOT)
    check('T4b 按月档:键是 YYYY-MM、组数 ≤ 日档、未设置仍在最后,行数之和照旧 5',
      t4m.groups.length <= t4.groups.length && t4m.groups.slice(0, -1).every((g) => /^\d{4}-\d{2}$/.test(g.key)) &&
        t4m.groups[t4m.groups.length - 1].none && t4m.groups.reduce((s, g) => s + g.count, 0) === 5,
      JSON.stringify(t4m.groups))
    await page.goto(`${taskUrl('层级')}&dark`)
    await page.waitForSelector('.amx-db-hrow', { timeout: 15000 })
    await shot(page, 'erp-tree-dark')
    // 负对照 ②:k3 的日期改成与 k2 同一天 → 日期组少一个(T4 的「5 组」是活的)
    await page.goto(taskUrl('按日'))
    await page.waitForSelector('.amx-db-group', { timeout: 15000 })
    await page.evaluate(async () => {
      const fx = window.__erp.fixture()
      const t = fx['任务表.db'].rows
      t.find((r) => r.id === 'k3').cells.t_date = t.find((r) => r.id === 'k2').cells.t_date
      window.__erp.load(fx)
      await new Promise((r) => setTimeout(r, 400))
    })
    await page.waitForSelector('.amx-db-group', { timeout: 15000 })
    const tn2 = await page.evaluate(TREE_SNAPSHOT)
    check('负对照 注入 k3 与 k2 同日 → T4 翻红(4 组 ≠ 5;合并后的那组 2 行)',
      tn2.groups.length === 4 && tn2.groups.some((g) => g.count === 2) && tn2.groups.reduce((s, g) => s + g.count, 0) === 5,
      JSON.stringify(tn2.groups))

    // T5 缩进条挂在 visCols[0]:它是标题列**只因为** orderColumns 把 columns[0] 钉死在 0 位 + 隐藏过滤放行 i===0。
    //   整个观感都压在这条不变式上,所以真拿一个把别的列排到前面的 view.order 打一遍(否则「碰巧对」永远不会被发现)。
    //   ⚠️ 断言必须同时验「注入真的生效了」(表头次列变成任务类型),不然 order 被忽略时这条是空绿。
    await page.evaluate(async () => {
      const fx = window.__erp.fixture()
      const v = fx['任务表.db'].views.find((x) => x.name === '层级')
      v.order = ['t_type', 't_title', 't_status', 't_date', 't_due', 't_staff', 't_parent'] // 刻意把 t_title 写在第二位
      window.__erp.load(fx)
      await new Promise((r) => setTimeout(r, 400))
    })
    await page.goto(taskUrl('层级'))
    await page.waitForSelector('.amx-db-hrow', { timeout: 15000 })
    const t5 = await page.evaluate(() => {
      const heads = [...document.querySelectorAll('.amx-db-hrow .amx-db-th-name')].map((e) => e.textContent.trim())
      const k1 = document.querySelector('.amx-db-row[data-row="k1"]')
      const cells = k1 ? [...k1.querySelectorAll('.amx-db-cell')] : []
      return {
        heads: heads.slice(0, 3),
        // 缩进条所在格的下标 + 该格的文本(必须是标题列的值,不是任务类型的芯片)
        leadCellIdx: cells.findIndex((c) => c.querySelector('.amx-db-treelead')),
        // 标题格里是 <input>,innerText 恒空 —— 取 value(首跑就是这么红的)
        leadCellText: (() => { const c = cells.find((x) => x.querySelector('.amx-db-treelead')); if (!c) return ''; const i = c.querySelector('input'); return (i ? i.value : c.innerText).trim() })(),
        depths: [...document.querySelectorAll('.amx-db-row[data-depth]')].map((r) => r.dataset.depth).join(),
      }
    })
    check(
      'T5 视图列序把 t_type 排到前面(首列铁律仍把标题列钉在 0 位):缩进条仍在第 0 格且那格是「装机任务-张三」;表头次列变成任务类型(证明 order 真生效)',
      t5.leadCellIdx === 0 && t5.leadCellText.includes('装机任务-张三') && t5.heads[0] === '文本' && t5.heads[1] === '任务类型' && t5.depths === '0,1,2,0,0',
      JSON.stringify(t5),
    )

    // ── N 段(W2-F3):数字显示格式 / 多附件 / 导出 CSV ────────────────────────────
    //   N1 配了 precision+单位的数字列(运费)与公式列(总计)只读显示带格式;没配的列(硬件总额)原样
    //   N2 点一下数字格子 → 进编辑态,input.value 是**原始值**(不是 ¥1,500.00元;不然一点就把显示串存回去)
    //   N3 导出 CSV:表头 = 屏幕上的可见列(逐字);注入(=1+1)前置 '、含逗号引号的中文加引号且引号双写;数字格式进 CSV
    //   N4 搜索过滤后再导出 → 只导筛剩的行(导的是「当前视图」不是整表)
    //   N5 附件列两形态:旧单值 1 枚 chip、新 string[] 2 枚
    //   负对照:同一份夹具去掉 precision/unitPrefix/unitSuffix → N1 翻红(格子回到裸 input,text='1500')
    const NUM_SNAPSHOT = () => {
      const heads = [...document.querySelectorAll('.amx-db-hrow .amx-db-th-name')].map((e) => e.textContent.trim())
      const rows = [...document.querySelectorAll('.amx-db-row:not(.amx-db-hrow)')].filter((r) => r.querySelectorAll('.amx-db-cell').length === heads.length)
      const cellOf = (r, name) => r.querySelectorAll('.amx-db-cell')[heads.indexOf(name)]
      const custOf = (r) => { const c = cellOf(r, '客户'); const i = c && c.querySelector('input'); return ((i ? i.value : (c ? c.innerText : '')) || '').trim() }
      const read = (r, name) => {
        const c = cellOf(r, name)
        if (!c) return null
        const inp = c.querySelector('input')
        // fmt = 走了格式化只读 span(而不是裸 input);input = 编辑态里的原始值
        return { text: c.innerText.trim(), fmt: !!c.querySelector('.amx-db-numfmt'), input: inp ? inp.value : null }
      }
      const pick = (name) => rows.find((r) => custOf(r) === name)
      const z = pick('张三')
      const l = pick('李四')
      return {
        heads,
        rowCount: rows.length,
        ship: z ? read(z, '运费') : null,
        shipEmpty: l ? read(l, '运费') : null,
        total: z ? read(z, '总计/JPY') : null,
        hw: z ? read(z, '硬件总额/JPY') : null,
        att: rows.map((r) => { const c = cellOf(r, '附件'); return { cust: custOf(r), chips: c ? c.querySelectorAll('.amx-db-file').length : -1 } }),
        exportBtns: document.querySelectorAll('[aria-label="export csv"]').length,
      }
    }
    /** 台架里 window.amadeus 没有 exportCsv 也没有 window.tangu → csvExportMode()='download' 那条路。
     *  拦下 URL.createObjectURL 拿到 Blob 正文,并把 <a>.click 打成空操作(别真触发下载)。 */
    const ARM_CSV = () => {
      const oc = URL.createObjectURL
      const ok = HTMLAnchorElement.prototype.click
      window.__csvBlob = null
      URL.createObjectURL = (b) => { window.__csvBlob = b; return 'blob:erp-stub' }
      HTMLAnchorElement.prototype.click = function () { /* 拦住真下载 */ }
      window.__csvRestore = () => { URL.createObjectURL = oc; HTMLAnchorElement.prototype.click = ok }
    }
    /** 夹具补丁:给运费/总计配显示格式、加附件列(两形态)、加两行 CSV 注入/引号素材。fmt=false 时不配格式(负对照)。 */
    const LOAD_NUM_FIXTURE = async (fmt) => {
      const fx = window.__erp.fixture()
      const t = fx['订单总表.db']
      if (fmt) {
        Object.assign(t.columns.find((c) => c.id === 'o_ship'), { precision: 2, unitPrefix: '¥', unitSuffix: '元' })
        Object.assign(t.columns.find((c) => c.id === 'o_total'), { precision: 2, unitPrefix: '¥' })
      }
      // 附件列:o1 旧单值 string、o2 新 string[](都用非图片扩展名,免得 <img> 去请求 amadeus-asset://)
      t.columns.push({ id: 'o_att', name: '附件', type: 'file' })
      t.rows.find((r) => r.id === 'o1').cells.o_att = '.amadeus/发票.pdf'
      t.rows.find((r) => r.id === 'o2').cells.o_att = ['.amadeus/发票.pdf', '.amadeus/合同.txt']
      // CSV 素材:注入起手 / 逗号+引号+中文
      t.rows.push({ id: 'o8', cells: { o_customer: '张三, "VIP"', o_status: '未确认', o_ship: -50 } })
      t.rows.push({ id: 'o9', cells: { o_customer: '=1+1', o_status: '未确认' } })
      window.__erp.load(fx)
      await new Promise((r) => setTimeout(r, 400))
    }
    await page.goto(`${BASE}?erp`)
    await page.waitForSelector('.amx-db-row', { timeout: 15000 })
    await page.evaluate(LOAD_NUM_FIXTURE, true)
    await page.waitForSelector('.amx-db-numfmt', { timeout: 15000 })
    const n1 = await page.evaluate(NUM_SNAPSHOT)
    check('N1 数字列按 precision/unit 显示:运费 ¥1,500.00元、公式列 总计 ¥125,196.00;没配格式的 硬件总额 仍是裸 112000;空值不显示成 ¥0.00元',
      n1.ship && n1.ship.fmt && n1.ship.text === '¥1,500.00元' &&
      n1.total && n1.total.text === '¥125,196.00' &&
      n1.hw && !n1.hw.fmt && n1.hw.text === '112000' &&
      n1.shipEmpty && n1.shipEmpty.fmt && n1.shipEmpty.text === '空',
      JSON.stringify([n1.ship, n1.total, n1.hw, n1.shipEmpty]))
    await shot(page, 'erp-numfmt')  // 观感自查①:格式化数字列 + 工具条导出按钮(--shot 时才存)
    // 观感自查②:附件列在最右,得把横向滚动条推到底才看得见多附件 chip;看完滚回去(N2 靠 el.click() 不吃坐标,但别给后面留脏态)
    await page.evaluate(() => { const s = document.querySelector('.amx-db-scroll'); if (s) s.scrollLeft = s.scrollWidth })
    await page.waitForTimeout(150)
    await shot(page, 'erp-files')
    await page.evaluate(() => { const s = document.querySelector('.amx-db-scroll'); if (s) s.scrollLeft = 0 })
    check('N5 附件列两形态:旧单值 1 枚 chip、string[] 2 枚(读端两形态都认,旧数据不迁移)',
      n1.att.find((a) => a.cust === '张三').chips === 1 && n1.att.find((a) => a.cust === '李四').chips === 2,
      JSON.stringify(n1.att))
    // N2:点数字格子 → 编辑态显示原始值
    const clicked = await page.evaluate(() => {
      const heads = [...document.querySelectorAll('.amx-db-hrow .amx-db-th-name')].map((e) => e.textContent.trim())
      const i = heads.indexOf('运费')
      const rows = [...document.querySelectorAll('.amx-db-row:not(.amx-db-hrow)')].filter((r) => r.querySelectorAll('.amx-db-cell').length === heads.length)
      const el = rows[0].querySelectorAll('.amx-db-cell')[i].querySelector('.amx-db-numfmt')
      if (!el) return false
      el.click()
      return true
    })
    await page.waitForTimeout(200)
    const n2 = await page.evaluate(NUM_SNAPSHOT)
    check('N2 点一下 → 编辑态 input.value = 原始值 1500(不是 ¥1,500.00元:否则一点就把显示串当新值存回去)',
      clicked && n2.ship && !n2.ship.fmt && n2.ship.input === '1500',
      JSON.stringify([clicked, n2.ship]))
    // N3:导出 CSV(台架走 Blob 下载那条路)
    await page.evaluate(ARM_CSV)
    await page.click('[aria-label="export csv"]')
    await page.waitForTimeout(200)
    // ⚠️ BOM 必须量**字节**:Blob.text() 走 UTF-8 decode,按规范会把开头的 BOM 吃掉 —— 拿它判 BOM 恒为假绿的反面
    //(第一轮就在这翻红过:文件里有 BOM,text() 里没有)。
    const cap = await page.evaluate(async () => {
      if (!window.__csvBlob) { window.__csvRestore(); return null }
      const b = window.__csvBlob
      const head = [...new Uint8Array(await b.arrayBuffer()).slice(0, 3)]
      const text = await b.text()
      window.__csvRestore()
      return { text, head, type: b.type }
    })
    const csv = cap ? cap.text : null
    const lines = csv ? csv.replace(/^﻿/, '').split('\r\n') : []
    // 逐条列出子判据:整块 && 起来一红就看不出是哪一条(上一轮就是这么多花了一趟)
    const n3f = {
      bom: !!cap && cap.head.join() === '239,187,191', // EF BB BF
      mime: !!cap && cap.type.includes('charset=utf-8'),
      head: lines[0] === n1.heads.join(','),
      inject: csv ? csv.includes("\r\n'=1+1,") : false,
      quote: csv ? csv.includes('"张三, ""VIP"""') : false,
      numfmt: csv ? csv.includes('"¥1,500.00元"') : false,
      rows: lines.filter((l) => l !== '').length === n1.rowCount + 1,
    }
    check('N3 导出 CSV:BOM + CRLF;表头逐字 = 屏幕上的可见列;=1+1 前置 \';含逗号引号的中文加引号且引号双写;数字格式进 CSV;行数 = 屏幕行数',
      Object.values(n3f).every(Boolean),
      JSON.stringify({ ...n3f, head3: cap && cap.head, n: lines.filter((l) => l !== '').length, want: n1.rowCount + 1, last: lines[lines.length - 2] }))
    // N4:搜索过滤后再导出 —— 导的是当前视图筛剩的行,不是整表
    await page.fill('.amx-db-search', '张三')
    await page.waitForTimeout(300)
    // ⚠️ 必须与 NUM_SNAPSHOT 同一套数法(按 .amx-db-cell 数过滤):裸选择器会把表尾的「＋ 新建」行也数进来
    const n4rows = await page.evaluate(() => {
      const heads = document.querySelectorAll('.amx-db-hrow .amx-db-th-name').length
      return [...document.querySelectorAll('.amx-db-row:not(.amx-db-hrow)')].filter((r) => r.querySelectorAll('.amx-db-cell').length === heads).length
    })
    await page.evaluate(ARM_CSV)
    await page.click('[aria-label="export csv"]')
    await page.waitForTimeout(200)
    const csv2 = await page.evaluate(async () => { const t = window.__csvBlob ? await window.__csvBlob.text() : null; window.__csvRestore(); return t })
    const lines2 = csv2 ? csv2.replace(/^﻿/, '').split('\r\n').filter((l) => l !== '') : []
    check('N4 筛选后导出只含筛剩的行(2 行「张三」),且没把 李四/王五 带出去',
      lines2.length === n4rows + 1 && n4rows === 2 && !csv2.includes('李四') && !csv2.includes('王五') && csv2.includes('"张三, ""VIP"""'),
      JSON.stringify({ csvRows: lines2.length - 1, screenRows: n4rows }))
    // 负对照:同一份夹具**不配**格式 → 数字格子回到裸 input,N1 翻红
    await page.goto(`${BASE}?erp`)
    await page.waitForSelector('.amx-db-row', { timeout: 15000 })
    await page.evaluate(LOAD_NUM_FIXTURE, false)
    await page.waitForTimeout(300)
    const nn = await page.evaluate(NUM_SNAPSHOT)
    check('负对照 去掉 precision/unitPrefix/unitSuffix → N1 翻红(运费回到裸 input、text 空、value=1500;总计裸 125196)',
      nn.ship && !nn.ship.fmt && nn.ship.input === '1500' && nn.ship.text !== '¥1,500.00元' &&
      nn.total && nn.total.text === '125196',
      JSON.stringify([nn.ship, nn.total]))
    // 观感自查③:暗色档(新样式只用既有 token,这张是「真没写死颜色」的证据)
    await page.goto(`${BASE}?erp&dark`)
    await page.waitForSelector('.amx-db-row', { timeout: 15000 })
    await page.evaluate(LOAD_NUM_FIXTURE, true)
    await page.waitForSelector('.amx-db-numfmt', { timeout: 15000 })
    await shot(page, 'erp-numfmt-dark')

    check('E8 无未捕获页面错误', errors.length === 0, errors.slice(0, 2).join(' | '))
  } catch (e) {
    check('跑完', false, String(e))
    try {
      const dump = await page.evaluate(() => ({ text: document.body.innerText.slice(0, 400), html: document.body.innerHTML.slice(0, 300) }))
      console.error('BODY:', JSON.stringify(dump))
      console.error('ERRORS:', errors.slice(0, 5).join('\n'))
    } catch (e2) { /* 尽力 */ }
  } finally {
    await browser.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
})()
