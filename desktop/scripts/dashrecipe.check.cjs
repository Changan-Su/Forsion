// 配方编译器 → 真 Dashboard 渲染契约(harness ?dashrecipe 模式,真 Chromium)。
// 单测(dashboardRecipe.test.ts)钉的是字节层 round-trip;这支钉**渲染层**:
//   R1 编译字节经真解码器进 GridView,11 张真卡都上屏(6 KPI + 2 section + 2 表格文本卡 + 页脚)
//   R2 literal stat 卡显示的就是配方给的值(不拉 .db、无「加载中/找不到」残影)
//   R3 section 键名契约:三条分区标题全对,绝无「未命名分区」(2026-09-01 编译器发 label: 的雷)
//   R4 暗色档同样成立(&dark)
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
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
