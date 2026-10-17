/**
 * 设置零件(components/SettingsPage → 宿主「通知」页与插件的 ctx.ui.mountSettingsPage)的排法几何 + 截图。
 * 跑在 mobile 的设置台架上(生产 SettingsModal + 生产 CSS,无头 Chromium、隔离存储、不连后端):
 *   cd mobile && PORT=5291 ./node_modules/.bin/vite      # 或 .claude/launch.json 的 mobile-settings-harness
 *   node desktop/scripts/settings-parts.shot.cjs          # URL=http://localhost:5293/settings-harness.html 换端口
 * 手机 390×844(触屏)看「通知」与 ?parts 演示页的明 / 暗 / 青绿配色;桌面 1512×950 看「通知」明 / 暗与演示页。
 * 断言:手机上开关、数值、单个按钮和标题同一行靠右;输入框、步进器换到下一行占满;触屏按钮 / 输入框高 36;
 *       「转入…」点开是半屏;页面不横向溢出。截图写 OUT(缺省 /tmp/settings-parts-shots)。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright-core')

const BASE = process.env.URL || 'http://localhost:5291/settings-harness.html'
const OUT = process.env.OUT || path.join(os.tmpdir(), 'settings-parts-shots')
fs.mkdirSync(OUT, { recursive: true })

function exe() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const f = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(f)) return f
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE')
}

const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`) }

async function open(browser, { form, mode = 'light', skin, query }) {
  const desk = form === 'desktop'
  const ctx = await browser.newContext({ viewport: desk ? { width: 1512, height: 950 } : { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: !desk, isMobile: !desk, locale: 'zh-CN' })
  await ctx.addInitScript(({ skin }) => {
    localStorage.setItem('tangu_locale', 'zh')
    if (skin) { localStorage.setItem('forsion_theme_skin', skin); localStorage.setItem('forsion_theme_bg', skin) }
  }, { skin })
  const q = [desk ? 'desktop' : '', mode === 'dark' ? 'dark' : '', query].filter(Boolean).join('&')
  // 手机形态要真有触屏模拟:有时一张页拿不到(pointer: coarse 不成立,见记忆 project_mobile_e2e_first_page_no_touch),
  // 量出来就是桌面高度 —— 先确认,不成立就换一张页再开,三次都不成立直接报错,别把假红 / 假绿当结果。
  for (let attempt = 0; attempt < 3; attempt++) {
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${BASE}?${q}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.settings-panel', { timeout: 60000 })
    if (!desk && !(await page.evaluate(() => matchMedia('(pointer: coarse)').matches))) { await page.close(); continue }
    await page.waitForTimeout(900) // 等 .settings-sub 的入场动画走完
    return { ctx, page, errors }
  }
  throw new Error('手机形态三次都没拿到触屏模拟(pointer: coarse)')
}

/** 每行:标题框、控件框、行框,以及控件是不是和标题同一行(竖向有交叠)、是不是靠右。 */
const rows = (page) => page.evaluate(() => [...document.querySelectorAll('.settings-control-row[data-fit]')].map((r) => {
  const box = (n) => { const b = n.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height } }
  const title = box(r.querySelector('.settings-control-copy strong'))
  const ctl = r.querySelector('.settings-row-control')
  const row = box(r)
  const c = box(ctl)
  // 内边距按标题的左缩进量(手机设置页整体有 zoom,computed padding 是缩放前的数)
  const pad = r.querySelector('.settings-control-copy').getBoundingClientRect().left - row.l
  const tall = [...ctl.querySelectorAll('.btn, input, select, .settings-stepper')].map((n) => n.getBoundingClientRect().height)
  return { title: r.querySelector('.settings-control-copy strong').textContent, fit: r.dataset.fit, kind: ctl.firstElementChild?.className || ctl.firstElementChild?.tagName,
    sameLine: c.t < title.b && c.b > title.t, right: Math.abs(row.r - pad - c.r) < 2, below: c.t >= title.b - 1, fullWidth: Math.abs(c.w - (row.w - 2 * pad)) < 2, tall }
}))
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

;(async () => {
  const browser = await chromium.launch({ executablePath: exe(), headless: true })
  try {
    // ── 手机「通知」:全是开关,和标题同一行、靠右(旧规则:一律掉到下一行靠左) ──
    for (const mode of ['light', 'dark']) {
      const { ctx, page, errors } = await open(browser, { form: 'phone', mode, query: 'tab=notifications' })
      const rs = await rows(page)
      const bad = rs.filter((r) => !(r.fit === 'inline' && r.sameLine && r.right))
      check(`手机 · 通知(${mode}):${rs.length} 个开关都和标题同一行、靠右`, rs.length >= 5 && !bad.length, bad.map((r) => r.title).join(',') || '')
      check(`手机 · 通知(${mode}):不横向溢出、无页面错误`, (await overflow(page)) <= 0 && !errors.length, errors[0] || '')
      await page.screenshot({ path: path.join(OUT, `phone-notifications-${mode}.png`) })
      await ctx.close()
    }
    // ── 手机演示页:紧凑留右、宽控件换行占满、触屏 36、选了就执行 → 半屏 ──
    for (const [mode, skin] of [['light'], ['dark'], ['light', 'teal']]) {
      const tag = skin ? `${mode}-${skin}` : mode
      const { ctx, page, errors } = await open(browser, { form: 'phone', mode, skin, query: 'parts' })
      const rs = await rows(page)
      const by = Object.fromEntries(rs.map((r) => [r.title, r]))
      const inline = ['额度重置卡', '余额', '用完后改用 AI 额度继续', '从 AI 额度转入', '我的邀请码', '转入方式']
      const wrap = ['用积分兑换', '兑换码']
      const badInline = inline.filter((t) => !(by[t] && by[t].sameLine && by[t].right))
      const badWrap = wrap.filter((t) => !(by[t] && by[t].below && by[t].fullWidth))
      check(`手机 · 零件(${tag}):紧凑控件和标题同一行靠右`, !badInline.length, badInline.join(',') || inline.length + ' 行')
      check(`手机 · 零件(${tag}):输入框、步进器换到下一行占满`, !badWrap.length, badWrap.join(',') || wrap.length + ' 行')
      const short = rs.flatMap((r) => r.tall.filter((h) => h < 35.5).map((h) => `${r.title}=${h}`))
      check(`手机 · 零件(${tag}):触屏上按钮 / 输入框 / 步进器高 ≥36`, !short.length, short.join(',') || '')
      check(`手机 · 零件(${tag}):「从 AI 额度转入」是一枚按钮`, (await page.locator('.settings-control-row', { hasText: '从 AI 额度转入' }).locator('.btn').count()) === 1)
      check(`手机 · 零件(${tag}):不横向溢出、无页面错误`, (await overflow(page)) <= 0 && !errors.length, errors[0] || '')
      await page.screenshot({ path: path.join(OUT, `phone-parts-${tag}.png`) })
      await page.evaluate(() => { const b = document.querySelector('.settings-body'); b.scrollTop = b.scrollHeight })
      await page.waitForTimeout(200)
      await page.screenshot({ path: path.join(OUT, `phone-parts-${tag}-bottom.png`) })
      await page.evaluate(() => { document.querySelector('.settings-body').scrollTop = 0 })
      if (!skin) {
        await page.locator('.settings-control-row', { hasText: '从 AI 额度转入' }).locator('.btn').click()
        await page.waitForTimeout(500)
        const sheet = await page.evaluate(() => {
          const s = document.querySelector('.settings-parts-sheet .mb-sheet')
          if (!s) return null
          const b = s.getBoundingClientRect()
          return { rows: s.querySelectorAll('.mb-sheet-row').length, bottom: Math.round(innerHeight - b.bottom), scrim: getComputedStyle(s.parentElement).position }
        })
        check(`手机 · 零件(${mode}):「转入…」弹出贴底半屏,三个选项`, !!sheet && sheet.rows === 3 && sheet.bottom === 0 && sheet.scrim === 'fixed', JSON.stringify(sheet))
        await page.screenshot({ path: path.join(OUT, `phone-parts-${mode}-sheet.png`) })
        await page.locator('.settings-parts-sheet .mb-sheet-row').nth(1).click()
        await page.waitForTimeout(200)
        check(`手机 · 零件(${mode}):选了之后半屏收起、回调拿到选项`, (await page.locator('.settings-parts-sheet').count()) === 0 && (await page.locator('[data-parts-log]').textContent()) === '转入 10%')
      }
      await ctx.close()
    }
    // ── 桌面:通知页(明 / 暗)与演示页,控件都在右边 ──
    for (const [mode, query] of [['light', 'tab=notifications'], ['dark', 'tab=notifications'], ['light', 'parts'], ['dark', 'parts']]) {
      const { ctx, page, errors } = await open(browser, { form: 'desktop', mode, query })
      const rs = await rows(page)
      const bad = rs.filter((r) => !(r.sameLine && r.right))
      check(`桌面 · ${query}(${mode}):控件都和标题同一行靠右`, rs.length > 0 && !bad.length, bad.map((r) => r.title).join(',') || rs.length + ' 行')
      check(`桌面 · ${query}(${mode}):无页面错误`, !errors.length, errors[0] || '')
      await page.screenshot({ path: path.join(OUT, `desktop-${query.replace('=', '-')}-${mode}.png`) })
      await ctx.close()
    }
  } finally {
    await browser.close()
  }
  console.log(`\n${results.filter(Boolean).length}/${results.length} 通过 · 截图在 ${OUT}`)
  process.exitCode = results.every(Boolean) ? 0 : 1
})().catch((e) => { console.error(e); process.exit(1) })
