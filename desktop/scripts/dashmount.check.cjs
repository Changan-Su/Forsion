// 插件仪表盘挂载接缝(ctx.dashboard.mount → mountPluginDashboard)的真渲染契约(harness ?dashmount)。
// 钉的是「没有笔记库也能开原生 Dashboard」这条产品承诺(2026-09-02 用户实报后立的):
//   M1 vaultRoot 恒 null(harness 从不开库)→ 真 GridView 仍挂进裸 div,卡片全上屏
//   M2 手排(setFmExtra)→ 内存 sink → onLayout 拿到整页文本(不是写库;库根本没开)
//   M3 卸载再挂、把上次文本作 layoutText 传回 → 手排的几何存活(再生成保布局走通了内存路线)
//   M4 卸载后作用域真的被收掉(dispose 之后不再来 onLayout)
//   M5 无未捕获页面错误
// 用法:npm run check:dashmount(经 e2e-editor.cjs 起停 vite;worktree 里设 HARNESS_URL 指独立端口);--shot 存截图
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
  return a ? (a.split('=')[1] || path.join(os.tmpdir(), 'dashmount-shots')) : null
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
    await page.goto(`${BASE}?dashmount`)
    await page.waitForSelector('.dash3-card', { timeout: 15000 })
    const s1 = await page.evaluate(() => ({
      cards: document.querySelectorAll('.dash3-card').length,
      stats: document.querySelectorAll('.dash-stat').length,
      tables: document.querySelectorAll('.dash3-card table').length,
      vault: window.__pageStore ? window.__pageStore.getState().vaultRoot : 'no-facade',
      text: document.body.innerText,
      layouts: (window.__layouts || []).length,
    }))
    check('M1 无库(vaultRoot=null)也把真 GridView 挂进裸 div:8 张卡上屏', s1.cards === 8 && s1.stats === 6 && s1.tables === 1, `cards=${s1.cards} stats=${s1.stats} tables=${s1.tables} vault=${s1.vault}`)
    check('M1b 主作用域 vaultRoot 未被污染(仍 null)', s1.vault === null || s1.vault === 'no-facade', String(s1.vault))
    check('M1c literal 值与表格内容上屏', s1.text.includes('585.8 万') && s1.text.includes('DeepSeek-V4-Pro'))
    check('M1d 挂载本身不触发 onLayout(没人手排就别写)', s1.layouts === 0, `layouts=${s1.layouts}`)
    await shot(page, 'dashmount-1')

    // M2:模拟排版台的一次手排 —— 把 kpi-users 改成 6×5,期待 ~400ms 防抖后 onLayout 收到整页文本
    await page.evaluate(() => {
      const fm = window.__dashMount.fmExtra()
      window.__dashMount.setFmExtra(fm.replace(/kpi-users: \[ 1, 4, 2 \]/, 'kpi-users: [ 1, 6, 5 ]'))
    })
    await page.waitForFunction(() => (window.__layouts || []).length >= 1, null, { timeout: 5000 })
    const s2 = await page.evaluate(() => ({ n: window.__layouts.length, last: window.__layouts[window.__layouts.length - 1] }))
    check('M2 手排 → 内存 sink → onLayout 拿到整页文本(含改后的几何)', s2.n >= 1 && s2.last.includes('kpi-users: [ 1, 6, 5 ]') && s2.last.startsWith('---\namadeus_page:'), `n=${s2.n}`)

    // M3:卸载再挂,传回上次文本 → 6×5 存活
    await page.evaluate(() => window.__dashMount.remountWithLastLayout())
    await page.waitForFunction(() => document.querySelectorAll('.dash3-card').length === 8, null, { timeout: 8000 })
    await page.waitForTimeout(300)
    const s3 = await page.evaluate(() => ({ fm: window.__dashMount.fmExtra(), cards: document.querySelectorAll('.dash3-card').length }))
    check('M3 再挂载 + layoutText 传回 → 手排几何存活(kpi-users 仍 6×5)', s3.fm.includes('kpi-users: [ 1, 6, 5 ]'), s3.fm.split('\n').find((l) => l.includes('kpi-users')))
    await shot(page, 'dashmount-2-relayout')

    // M4:卸载后不再有 onLayout(作用域真收掉)
    const before = await page.evaluate(() => window.__layouts.length)
    await page.evaluate(() => window.__dashMount.dispose())
    await page.waitForTimeout(700)
    const s4 = await page.evaluate(() => ({ n: window.__layouts.length, cards: document.querySelectorAll('.dash3-card').length }))
    check('M4 卸载:树摘掉、此后无 onLayout 泄漏', s4.cards === 0 && s4.n <= before + 1, `cards=${s4.cards} layouts=${before}→${s4.n}`)

    check('M5 无未捕获页面错误', errors.length === 0, errors.slice(0, 2).join(' | '))
  } catch (e) {
    check('跑完', false, String(e))
    try {
      const dump = await page.evaluate(() => ({ text: document.body.innerText.slice(0, 300) }))
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
