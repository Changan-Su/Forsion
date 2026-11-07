/**
 * 电脑历史的说明 / 同意弹窗(ComputerHistoryDialog:首启引导团队屏「详情」与主页输入框下面那一行共用)+ 主页那一行(ComputerHistoryAsk):
 * 真组件 + 生产 CSS,在 Chromium 里把各种情形摆一遍(computer-history-harness 的 ?ask / ?dialog,桩 window.tangu.computerHistory,不连 helper)。
 * 真应用里的流程(跳过引导 → 主页出现那一行、团队屏「详情」)在 check:first-run;设置页的开关与同意条在 check:computerhistory。
 * 覆盖:
 *  - 主页那一行 × 深浅色 × zh/en × macOS / Windows × 1280×800 / 900×640 / 818×582(= 900×640 配 110% 界面缩放):无横向溢出、整行在窗内;
 *  - 「开启…」→ 同意说明:同意那一段 + 五条 + 建议都在,弹窗和两个按钮都在窗内,落点在「取消」;弹着时电脑历史仍是关;
 *  - 取消 / Esc → 弹窗关、仍是关、那一行还在;确认 → 开、弹窗关、那一行收起、本机记号变 dismissed;开成后 macOS 接着请辅助功能,Windows 不请;
 *  - 「开启记录」写失败 → 弹窗里报错、不关、仍是关、记号不动;关掉再开,上次的错不留;
 *  - ✕ → 那一行收起、记号 dismissed;电脑历史开着 / 动过(dataGen > 0)→ 那一行不出;
 *  - 只看说明(团队屏「详情」):五条都在、没有开启按钮、落点在关闭钮、Esc / 点遮罩都能关、关了还能再开;
 *  - 无页面错误。
 * Run: npm run check:onboardinghistory   (worktree 里自己起 npx vite frontend --port <空闲口>,再带 HARNESS_URL=http://localhost:<port>/harness.html;
 *      截图在 os.tmpdir()/forsion-onboarding-history,或 SHOT_DIR)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')

const baseUrl = new URL(process.env.HARNESS_URL || 'http://localhost:5173/harness.html')
baseUrl.pathname = '/computer-history-harness.html'
const out = process.env.SHOT_DIR || path.join(os.tmpdir(), 'forsion-onboarding-history')
fs.mkdirSync(out, { recursive: true })
let pass = 0, fail = 0
const check = (name, ok, detail) => { if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, JSON.stringify(detail)) } }

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()) })
  const finishAnimations = () => page.evaluate(() => document.getAnimations().forEach((a) => { try { a.finish() } catch { /* infinite */ } }))
  /** 打开台架;ready = 等哪个元素出来(缺省 = 不等,调用方自己等)。 */
  const open = async (query, [width, height], ready) => {
    await page.setViewportSize({ width, height })
    await page.goto(`${baseUrl}?${query}`)
    await page.waitForFunction(() => (window.__chGets || 0) > 0, null, { timeout: 20_000 })
    if (ready) await page.locator(ready).first().waitFor({ timeout: 20_000 })
    await page.waitForTimeout(150)
    await finishAnimations()
  }
  const row = page.locator('[data-ch-ask]')
  const dialog = page.locator('.ob-history-dialog')
  const dialogOpen = () => dialog.evaluate((el) => el.open).catch(() => false)
  /** 桩里电脑历史此刻开没开(读真 API,不看界面)。 */
  const enabledNow = () => page.evaluate(async () => (await window.tangu.computerHistory.get()).state.enabled)
  const mark = () => page.evaluate(() => localStorage.getItem('forsion_ch_ask'))
  const permissionRequests = () => page.evaluate(() => [...(window.__permissionRequests || [])])
  /** 弹窗开着时量:在窗内、底部按钮在弹窗内、五条 + 建议、同意那一段、落点。 */
  const measureDialog = () => dialog.evaluate((el) => {
    const r = el.getBoundingClientRect(), foot = el.querySelector('.ob-history-dialog-foot')?.getBoundingClientRect()
    const focus = document.activeElement
    return { open: el.open, inside: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
      footInside: foot ? foot.bottom <= r.bottom + 1 && foot.top >= r.top : null, foot: !!foot,
      rows: el.querySelectorAll('.ch-about-row').length, consent: !!el.querySelector('.ob-history-consent')?.textContent.trim(), tip: !!el.querySelector('.ch-tip'),
      focus: focus?.closest('.ob-history-dialog-foot') ? `foot:${focus.className}` : focus?.classList.contains('icon-btn') ? 'close' : focus?.tagName,
      hScroll: el.scrollWidth > el.clientWidth + 1 }
  })
  const SIZES = [[1280, 800], [900, 640], [818, 582]]

  // ── 主页那一行 + 同意说明:几何(各语言 × 深浅色 × 平台 × 尺寸)──
  for (const [name, query] of [
    ['zh', 'ask&status=off'], ['zh-dark', 'ask&status=off&dark'], ['en', 'ask&status=off&lang=en'],
    ['en-dark-win', 'ask&status=off&dark&lang=en&platform=win32'], ['zh-win-teal', 'ask&status=off&platform=win32&skin=teal'],
  ]) {
    for (const size of SIZES) {
      const tag = `[${name} ${size.join('×')}]`
      await open(query, size, '[data-ch-ask]')
      const g = await row.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, rowOverflow: el.scrollWidth > el.clientWidth + 1,
          docW: document.documentElement.scrollWidth, vw: innerWidth, buttons: el.querySelectorAll('[data-ch-ask-enable], [data-ch-ask-dismiss]').length }
      })
      await page.screenshot({ path: path.join(out, `ask-${name}-${size.join('x')}.png`) })
      check(`${tag} 那一行在窗内、无横向溢出、「开启…」和 ✕ 都在`, g.inside && !g.rowOverflow && g.docW <= g.vw && g.buttons === 2, g)

      await page.locator('[data-ch-ask-enable]').click()
      await dialog.locator('.ch-about-row').first().waitFor()
      await finishAnimations()
      const d = await measureDialog()
      await page.screenshot({ path: path.join(out, `consent-${name}-${size.join('x')}.png`) })
      check(`${tag} 「开启…」弹同意说明:同意那一段 + 五条 + 建议,弹窗和两个按钮都在窗内,落点在「取消」`,
        d.open && d.inside && d.footInside && !d.hScroll && d.rows === 5 && d.consent && d.tip && /^foot:.*ghost/.test(d.focus || ''), d)
      check(`${tag} 弹着同意说明时仍是关`, !(await enabledNow()))
      await dialog.locator('.ob-history-dialog-foot .btn.ghost').click()
      check(`${tag} 取消 → 弹窗关、仍是关、那一行还在`, !(await dialogOpen()) && !(await enabledNow()) && await row.count() === 1)
    }
  }

  // ── 同意流程 ──
  for (const [platform, query] of [['macOS', 'ask&status=off'], ['Windows', 'ask&status=off&platform=win32']]) {
    await open(query, [1280, 800], '[data-ch-ask]')
    await page.locator('[data-ch-ask-enable]').click()
    await dialog.locator('.ch-about-row').first().waitFor()
    await page.keyboard.press('Escape')
    check(`[${platform}] Esc 关掉同意说明,仍是关`, !(await dialogOpen()) && !(await enabledNow()) && await row.count() === 1)
    await page.locator('[data-ch-ask-enable]').click()
    await dialog.locator('.ob-history-dialog-foot .btn.primary').click()
    await row.waitFor({ state: 'detached' })
    const requests = await permissionRequests()
    check(`[${platform}] 确认 → 开、弹窗关、那一行收起、记号 dismissed`,
      await enabledNow() && !(await dialogOpen()) && await mark() === 'dismissed', { mark: await mark() })
    check(`[${platform}] 开成后${platform === 'macOS' ? '接着请辅助功能' : '不请权限'}`,
      JSON.stringify(requests) === JSON.stringify(platform === 'macOS' ? ['computerAccessibility'] : []), requests)
  }

  // 写失败:弹窗里报错、不关、仍是关;关掉再开,上次的错不留
  await open('ask&status=off&failEnable', [1280, 800], '[data-ch-ask]')
  await page.locator('[data-ch-ask-enable]').click()
  await dialog.locator('.ob-history-dialog-foot .btn.primary').click()
  await dialog.locator('.ob-history-dialog-error').waitFor()
  const failed = await dialog.evaluate((el) => ({ open: el.open, error: el.querySelector('.ob-history-dialog-error')?.textContent || '' }))
  await page.screenshot({ path: path.join(out, 'consent-write-failed.png') })
  check('写失败 → 弹窗里报错、不关、仍是关、记号不动、没请权限',
    failed.open && /simulated write failure/.test(failed.error) && !(await enabledNow()) && await mark() === 'pending' && (await permissionRequests()).length === 0, failed)
  await dialog.locator('.ob-history-dialog-foot .btn.ghost').click()
  await page.locator('[data-ch-ask-enable]').click()
  await dialog.locator('.ch-about-row').first().waitFor()
  check('关掉再开,上次的错不留', await dialog.locator('.ob-history-dialog-error').count() === 0)
  await page.keyboard.press('Escape')

  // ✕ = 不再提醒
  await open('ask&status=off', [1280, 800], '[data-ch-ask]')
  await page.locator('[data-ch-ask-dismiss]').click()
  await row.waitFor({ state: 'detached' })
  check('✕ → 那一行收起、记号 dismissed、电脑历史不动', await mark() === 'dismissed' && !(await enabledNow()))

  // 不该出现的情形:开着的、动过的(读回来了也不出)
  for (const [name, query] of [['开着', 'ask&status=recording'], ['动过(dataGen 1)', 'ask&status=off&touched']]) {
    await open(query, [1280, 800])
    await page.waitForTimeout(300)
    check(`${name} → 那一行不出`, await row.count() === 0)
  }

  // ── 只看说明(团队屏「详情」)──
  for (const [name, query] of [['zh', 'dialog&status=off'], ['en-dark', 'dialog&status=off&dark&lang=en'], ['zh-recording-win', 'dialog&status=recording&platform=win32']]) {
    for (const size of SIZES) {
      const tag = `[details ${name} ${size.join('×')}]`
      await open(query, size, '.ob-history-dialog[open] .ch-about-row')
      const d = await measureDialog()
      await page.screenshot({ path: path.join(out, `details-${name}-${size.join('x')}.png`) })
      check(`${tag} 五条 + 建议都在、没有开启按钮和同意段、弹窗在窗内、落点在关闭钮`,
        d.open && d.inside && !d.hScroll && d.rows === 5 && d.tip && !d.foot && !d.consent && d.focus === 'close', d)
    }
  }
  const before = await enabledNow()
  await page.keyboard.press('Escape')
  check('只看说明:Esc 关,电脑历史不动', !(await dialogOpen()) && await enabledNow() === before)
  await page.locator('[data-open-details]').click()
  await dialog.locator('.ch-about-row').first().waitFor()
  check('关了还能再开', await dialogOpen())
  await page.mouse.click(4, 4) // 遮罩(弹窗外)
  await page.waitForTimeout(100)
  check('点遮罩关', !(await dialogOpen()))

  check('无页面错误', errors.length === 0, errors.slice(0, 5))
  await browser.close()
  console.log(`${pass} passed / ${fail} failed; SHOT ${out}`)
  process.exitCode = fail ? 1 : 0
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
