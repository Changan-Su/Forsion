/**
 * 输入框上下文环详情弹层(ContextUsagePop,09-26 对标 Claude 的 Context window 面板):真组件 + 真 composer2.css,真 Chromium。
 * 钉:头部「已用 / 窗口 tokens(%)」、分段条的段数与总宽、分项口径(系统段 → 历史 → 余数=工具与本轮)、
 * 展开详情、自动压缩线、压缩按钮、登录后才有的今日 / 本周额度(已用百分比 + 重置时间 + 预警色)、
 * 英文界面无汉字、定宽无横向溢出;zh/en × 亮/暗展开截图各一张(自己看)。
 * 跑:npm run check:ctxusage   (worktree 里设 HARNESS_URL 指到另一个端口 + FORSION_VITE_CACHE_DIR)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse()
  for (const d of dirs) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const file = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(file)) return file
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

let checks = 0
function check(name, ok, detail) {
  if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`)
  checks++
  console.log(`PASS ${name}`)
}

const SHOT = process.argv.includes('--shot')
const OUT = process.env.CTXUSAGE_OUT || path.join(os.tmpdir(), 'ctxusage')

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const base = new URL(process.env.HARNESS_URL || 'http://localhost:5173/harness.html')
  base.pathname = '/ctxusage-harness.html'
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const open = async (params, locale = 'zh-CN') => {
    const page = await browser.newPage({ locale, viewport: { width: 520, height: 720 }, deviceScaleFactor: 2 })
    const url = new URL(base)
    url.search = params
    await page.goto(url.toString())
    await page.locator('.t2c-cu-head').waitFor()
    return page
  }
  const info = (page) => page.evaluate(() => {
    const pop = document.querySelector('.t2c-ctxring-pop')
    const bar = pop.querySelector(':scope > .t2c-cu-bar')
    const segs = [...bar.children].map((s) => s.getBoundingClientRect().width)
    return {
      text: pop.innerText,
      width: pop.getBoundingClientRect().width,
      overflowX: pop.scrollWidth - pop.clientWidth,
      barWidth: bar.getBoundingClientRect().width,
      segs,
      buffer: !!bar.querySelector('.t2c-cu-buffer'),
      limits: [...pop.querySelectorAll('.t2c-cu-limit')].map((r) => ({ key: r.dataset.limit, text: r.innerText, warn: !!r.querySelector('.t2c-cu-bar[data-warn]') })),
    }
  })

  // ── 中文 · 亮 ──
  let page = await open('')
  await page.waitForSelector('.t2c-cu-limit')
  let s = await info(page)
  check('头部:117.6k / 272k tokens (43%)', /上下文窗口/.test(s.text) && /117\.6k \/ 272k tokens \(43%\)/.test(s.text), s.text.slice(0, 80))
  check('分段条:6 段分项 + 右端自动压缩预留', s.segs.length === 7 && s.buffer, s.segs)
  const used = s.segs.slice(0, 6).reduce((a, b) => a + b, 0)
  check('分项总宽 ≈ 43% 条宽(按真实占用切,不按估算和)', Math.abs(used / s.barWidth - 117600 / 272000) < 0.03, { used, bar: s.barWidth })
  check('自动压缩线:还剩 138k 触发(255.6k,94%)', /还剩 138k 触发自动压缩（255\.6k，94%）/.test(s.text), s.text)
  check('定宽 300 无横向溢出', Math.round(s.width) === 300 && s.overflowX <= 0, s)
  check('额度区:今日已用 12% + 小时倒计时', s.limits[0]?.key === 'daily' && /已用 12%/.test(s.limits[0].text) && /小时 \d+ 分钟后重置/.test(s.limits[0].text) && !s.limits[0].warn, s.limits)
  check('额度区:本周已用 92% + 重置时间 + 预警色', s.limits[1]?.key === 'weekly' && /已用 92%/.test(s.limits[1].text) && /重置/.test(s.limits[1].text) && s.limits[1].warn, s.limits)
  check('未展开时不列分项', !/工具与本轮/.test(s.text))
  check('收起态箭头朝右(没被进度环的 rotate(-90deg) 带歪)', await page.locator('.t2c-cu-chev').evaluate((el) => getComputedStyle(el).transform === 'none'))
  if (SHOT) await page.locator('.t2c-ctxring-pop').screenshot({ path: path.join(OUT, 'zh-light-collapsed.png') })
  await page.locator('.t2c-cu-head').click()
  s = await info(page)
  check('展开:历史 38 条 61k / 工具与本轮 34.2k(余数)/ 系统提示 11.6k', /历史消息（38 条）\s*61k/.test(s.text) && /工具与本轮\s*34\.2k/.test(s.text) && /系统提示\s*11\.6k/.test(s.text), s.text)
  check('展开:多段分组列子项、单段不重复', /基础指引\/契约\s*~5\.4k/.test(s.text) && !/技能目录/.test(s.text), s.text)
  check('展开:预留 / 剩余 / 窗口来源 / 指令文件', /自动压缩预留/.test(s.text) && /剩余可用/.test(s.text) && /按模型族推断/.test(s.text) && /app\/AGENTS\.md/.test(s.text), s.text)
  check('展开后仍无横向溢出', s.overflowX <= 0, s.overflowX)
  const legend = await page.locator('.t2c-cu-legend').evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }))
  check('720 高窗口下分项列表不用滚就能看到「剩余可用」', legend.sh <= legend.ch + 1, legend)
  if (SHOT) await page.locator('.t2c-ctxring-pop').screenshot({ path: path.join(OUT, 'zh-light.png') })
  await page.locator('.t2c-ctxring-compact').click()
  check('压缩按钮点得到', await page.evaluate(() => window.__compacted === 1))
  await page.close()

  // ── 中文 · 暗 ──
  page = await open('dark')
  await page.waitForSelector('.t2c-cu-limit')
  await page.locator('.t2c-cu-head').click()
  if (SHOT) await page.locator('.t2c-ctxring-pop').screenshot({ path: path.join(OUT, 'zh-dark.png') })
  await page.close()

  // ── English · light / dark ──
  for (const mode of ['', 'dark']) {
    page = await open(`lang=en${mode ? '&dark' : ''}`, 'en-US')
    await page.waitForSelector('.t2c-cu-limit')
    await page.locator('.t2c-cu-head').click()
    s = await info(page)
    check(`英文${mode ? '暗' : '亮'}:无汉字`, !/[一-鿿]/.test(s.text), s.text)
    check(`英文${mode ? '暗' : '亮'}:Context window / until auto-compact / % used / Resets`, /Context window/.test(s.text) && /138k until auto-compact \(255\.6k, 94%\)/.test(s.text) && /12% used/.test(s.text) && /Resets in \d+ hr \d+ min/.test(s.text) && /Tools & this run/.test(s.text), s.text)
    check(`英文${mode ? '暗' : '亮'}:无横向溢出`, s.overflowX <= 0, s.overflowX)
    if (SHOT) await page.locator('.t2c-ctxring-pop').screenshot({ path: path.join(OUT, `en-${mode || 'light'}.png`) })
    await page.close()
  }

  // ── 边界 ──
  page = await open('noinfo')
  await page.waitForSelector('.t2c-cu-limit')
  s = await info(page)
  check('还没跑过 run:单段「已用」、无预留、无压缩线', s.segs.length === 1 && !s.buffer && !/自动压缩/.test(s.text), s)
  await page.close()

  page = await open('logout')
  await page.waitForTimeout(400)
  s = await info(page)
  check('未登录:没有额度区', s.limits.length === 0 && !/Forsion 额度/.test(s.text), s.text)
  await page.close()

  page = await open('unlimited&capped')
  await page.waitForSelector('.t2c-cu-limit')
  s = await info(page)
  check('今日不限:显示「不限」、无条、无倒计时', /不限/.test(s.limits[0].text) && !/重置/.test(s.limits[0].text) && s.limits[0].key === 'daily', s.limits)
  check('封顶说明不藏进详情(ctxlimit T7 依赖)', /模型最大 1M，默认只用到 272k/.test(s.text), s.text)
  await page.close()

  await browser.close()
  console.log(`\n${checks} checks passed${SHOT ? ` · shots → ${OUT}` : ''}`)
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
