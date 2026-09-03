// 配方编译器 → 真 Dashboard 渲染契约(harness ?dashrecipe 模式,真 Chromium)。
// 单测(dashboardRecipe.test.ts)钉的是字节层 round-trip;这支钉**渲染层**:
//   R1 编译字节经真解码器进 GridView,11 张真卡都上屏(6 KPI + 2 section + 2 表格文本卡 + 页脚)
//   R2 literal stat 卡显示的就是配方给的值(不拉 .db、无「加载中/找不到」残影)
//   R3 section 键名契约:三条分区标题全对,绝无「未命名分区」(2026-09-01 编译器发 label: 的雷)
//   R4 暗色档同样成立(&dark)
//   R6 指标卡绑视图(2026-09-02,?dashdata 夹具):stat 卡 `view:` 指 .db 已存视图 → 数据源先过该视图
//      的 filters 再算;绑定是每卡的(邻卡不受影响);找不到视图报错而非静默回退全表
// 用法:npm run check:dashrecipe(经 e2e-editor.cjs 起停 vite);--shot[=目录] 存截图
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
  return a ? (a.split('=')[1] || path.join(os.tmpdir(), 'dashrecipe-shots')) : null
})()
async function shot(page, name) {
  if (!SHOT_DIR) return
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
  console.log(`SHOT  ${path.join(SHOT_DIR, `${name}.png`)}`)
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.goto(`${BASE}?dashrecipe`)
    await page.waitForSelector('.dash3-card', { timeout: 15000 })
    const state = await page.evaluate(() => ({
      cards: document.querySelectorAll('.dash3-card').length,
      stats: document.querySelectorAll('.dash-stat').length,
      text: document.body.innerText,
      bytes: (window.__recipeBytes || '').slice(0, 80),
      tables: document.querySelectorAll('.dash3-card table').length,
      tableText: [...document.querySelectorAll('.dash3-card table')].map((t) => t.innerText).join(' '),
    }))
    check('R1 编译字节 → 真 GridView:11 张卡全部上屏(6 KPI+2 section+2 表格卡+页脚)', state.cards === 11, `cards=${state.cards}`)
    check('R1b 其中 6 张是 stat 卡', state.stats === 6, `stats=${state.stats}`)
    check('R2 literal 值上屏(1,234 / 98.6% / 123,456,789)',
      state.text.includes('1,234') && state.text.includes('98.6%') && state.text.includes('1.23 亿'))
    check('R2b 无 .db 残影(不出现 加载中/找不到)', !state.text.includes('找不到「') && !state.text.includes('加载中'))
    check('R3 分区标题全对', ['服务器状态 · demo-host', '用量排行(30天)'].every((s) => state.text.includes(s)))
    check('R3b 绝无「未命名分区」(section 键名契约)', !state.text.includes('未命名分区'))
    check('R2c GFM 表格在文本卡里真渲成 <table>(两张)+ 行内容上屏', state.tables === 2 && state.tableText.includes('gpt-x') && state.tableText.includes('8,520 万'), `tables=${state.tables}`)
    check('R0 字节确由真编译器产出(frontmatter 三件套开头)', state.bytes.startsWith('---\namadeus_page:'), state.bytes.slice(0, 30))
    await shot(page, 'dashrecipe-light')

    await page.goto(`${BASE}?dashrecipe&dark`)
    await page.waitForSelector('.dash3-card', { timeout: 15000 })
    const dark = await page.evaluate(() => ({
      cards: document.querySelectorAll('.dash3-card').length,
      bg: getComputedStyle(document.querySelector('.dash3-card')).backgroundColor,
    }))
    check('R4 暗色档同样 11 张卡', dark.cards === 11, `cards=${dark.cards}`)
    await shot(page, 'dashrecipe-dark')

    check('R5 无未捕获页面错误', errors.length === 0, errors.slice(0, 2).join(' | '))

    // ── R6 指标卡绑视图(?dashdata 已有夹具:台账.db 四行,状态 进行中×2 / 已完成×2,金额 100/200/50/null)
    //    不改 harness:经 window.__dbStore 给 .db 加一个带筛选的视图、经 window.__pageStore 把块 1 换成
    //    带 view: 的 stat 围栏。⚠️ setState 必须给 entries/blocks 新引用,否则 useMemo([entry.data]) 不重算。
    await page.goto(`${BASE}?dashdata`)
    await page.waitForSelector('.dash-stat-value', { timeout: 15000 })
    const statOf = (key) => page.$eval(`.dash3-card[data-key="${key}"] .dash-stat-value`, (e) => e.textContent.replace(/\s+/g, ''))
    const noteOf = (key) => page.$eval(`.dash3-card[data-key="${key}"]`, (e) => (e.querySelector('.dash-widget-note') || {}).textContent || '')
    const bindView = (fence) => page.evaluate((f) => {
      const db = window.__dbStore.getState()
      const entry = db.entries['台账.db']
      const data = entry.data
      const hasView = (data.views || []).some((v) => v.id === 'v3')
      const views = hasView ? data.views : [...(data.views || []), { id: 'v3', name: '进行中', type: 'table', filters: [{ colId: 'c1', op: 'eq', value: '进行中' }] }]
      window.__dbStore.setState({ entries: { ...db.entries, '台账.db': { ...entry, data: { ...data, views } } } })
      const ps = window.__pageStore.getState()
      window.__pageStore.setState({ blocks: { ...ps.blocks, 1: { ...ps.blocks[1], content: f } } })
    }, fence)
    const base = [await statOf('1'), await statOf('2')]
    check('R6-0 前置:?dashdata 夹具未绑视图时 行数 4 / 金额合计 350', base.join('|') === '4|350', base.join('|'))
    await bindView('```stat\nsource: 台账.db\nlabel: 进行中行数\nview: 进行中\n```')
    await page.waitForTimeout(300)
    const bound = [await statOf('1'), await statOf('2')]
    check('R6 stat 卡 view: 绑「进行中」视图 → 数据源先过视图筛选(4→2)', bound[0] === '2', `key1=${bound[0]}`)
    check('R6b 绑定是每卡的:邻卡(金额合计)仍 350', bound[1] === '350', `key2=${bound[1]}`)
    await bindView('```stat\nsource: 台账.db\ncol: 金额\nstat: sum\nlabel: 进行中金额\nview: v3\n```')
    await page.waitForTimeout(300)
    const byId = await statOf('1')
    check('R6c 按视图 id 兜底同样生效(sum 350→300)', byId === '300', `key1=${byId}`)
    await bindView('```stat\nsource: 台账.db\nlabel: 坏绑定\nview: 不存在\n```')
    await page.waitForTimeout(300)
    const missing = await page.$(`.dash3-card[data-key="1"] .dash-stat-value`)
    const note = await noteOf('1')
    check('R6d 找不到视图 → 卡上报错,绝不静默回退全表', !missing && note.includes('找不到视图「不存在」'), `note=${note.slice(0, 40)}`)
    await shot(page, 'dashrecipe-viewbind')
    check('R6e 绑视图一轮无未捕获页面错误', errors.length === 0, errors.slice(0, 2).join(' | '))
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
