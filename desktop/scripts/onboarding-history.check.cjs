/**
 * 首次引导「权限与数据」里的电脑历史一页:真组件 + 生产 CSS,Chromium 里把真 Electron 台架(check:first-run)到不了的状态都摆一遍。
 * (那边连的是真主进程 + 假 socket,只出得来「关」和「连不上」;这里用桩把 记录中 / 待授权 / 助手过旧 / Windows 都摆出来。)
 * 覆盖:各状态 × 深浅色 × zh/en × 1280×800 / 900×640 / 818×582(= 900×640 配 110% 界面缩放)不整页滚动、无横向溢出、底栏在窗内;
 *   默认关时拨开关 → 弹同意说明(同意那一段 + 五条都在、弹窗在窗内、开关仍是关)→ 取消仍关 → 确认才开;
 *   macOS 一直有辅助功能那一行,Windows 没有、换成一句说明;只看说明的入口不动开关。
 * Run: npm run check:onboardinghistory   (worktree 里加 HARNESS_URL=http://localhost:<port>/harness.html;截图在 os.tmpdir()/forsion-onboarding-history)
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
  const open = async (query, [width, height]) => {
    await page.setViewportSize({ width, height })
    await page.goto(`${baseUrl}?onboarding&${query}`)
    await page.locator('.ob-history').waitFor({ timeout: 20_000 })
    if (!/platform=win32/.test(query)) await page.locator('.ob-history [data-permission="computerAccessibility"]').waitFor()
    await page.waitForTimeout(250)
    // 入场动效收尾再量(循环播放的状态点收不了尾,跳过)
    await page.evaluate(() => document.getAnimations().forEach((a) => { try { a.finish() } catch { /* infinite */ } }))
  }
  const geometry = () => page.evaluate(() => {
    const content = document.querySelector('.ob-content'), footer = document.querySelector('.ob-footer').getBoundingClientRect()
    return { contentH: content.clientHeight, scrollH: content.scrollHeight, contentW: content.clientWidth, scrollW: content.scrollWidth,
      footerVisible: footer.bottom <= innerHeight + 1, docW: document.documentElement.scrollWidth, vw: innerWidth }
  })
  const SIZES = [[1280, 800], [900, 640], [818, 582]]
  for (const [name, query] of [
    ['off', 'status=off'], ['off-dark', 'status=off&dark'], ['off-en', 'status=off&lang=en'],
    ['recording', 'status=recording'], ['recording-dark-en', 'status=recording&dark&lang=en'],
    ['no-permission', 'status=no_permission'], ['no-permission-dark', 'status=no_permission&dark'],
    ['helper-missing', 'status=helper_missing'], ['helper-outdated-dark-en', 'status=helper_outdated&dark&lang=en'],
    ['paused', 'status=paused'], ['disconnected-en', 'status=disconnected&lang=en'],
    ['win-off', 'status=off&platform=win32'], ['win-helper-missing-dark-en', 'status=helper_missing&platform=win32&dark&lang=en'],
  ]) {
    for (const size of SIZES) {
      await open(query, size)
      const g = await geometry()
      await page.screenshot({ path: path.join(out, `${name}-${size.join('x')}.png`) })
      check(`${name} ${size.join('×')} 不整页滚动、无横向溢出、底栏在窗内`,
        g.scrollH <= g.contentH + 1 && g.scrollW <= g.contentW + 1 && g.footerVisible && g.docW <= g.vw, g)
    }
  }

  // ── 同意流程(默认关)──
  const sw = page.getByRole('switch')
  const dialog = page.locator('.ob-history-dialog')
  for (const [name, query] of [['zh', 'status=off'], ['en-dark', 'status=off&dark&lang=en']]) {
    for (const size of SIZES) {
      await open(query, size)
      check(`[${name} ${size.join('×')}] 默认关`, await sw.getAttribute('aria-checked') === 'false')
      await sw.click()
      await dialog.locator('.ch-about-row').first().waitFor()
      await page.evaluate(() => document.getAnimations().forEach((a) => { try { a.finish() } catch { /* infinite */ } }))
      const d = await dialog.evaluate((el) => {
        const r = el.getBoundingClientRect(), foot = el.querySelector('.ob-history-dialog-foot').getBoundingClientRect()
        return { open: el.open, inside: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth, footInside: foot.bottom <= r.bottom + 1,
          rows: el.querySelectorAll('.ch-about-row').length, consent: !!el.querySelector('.ob-history-consent')?.textContent.trim(), tip: !!el.querySelector('.ch-tip') }
      })
      await page.screenshot({ path: path.join(out, `consent-${name}-${size.join('x')}.png`) })
      check(`[${name} ${size.join('×')}] 拨开关弹同意说明:同意那一段 + 五条 + 建议都在,弹窗和两个按钮都在窗内`,
        d.open && d.inside && d.footInside && d.rows === 5 && d.consent && d.tip, d)
      check(`[${name} ${size.join('×')}] 弹着同意说明时开关仍是关`, await sw.getAttribute('aria-checked') === 'false')
      await dialog.locator('.ob-history-dialog-foot .btn.ghost').click()
      check(`[${name} ${size.join('×')}] 取消 → 弹窗关、仍是关`, !(await dialog.evaluate((el) => el.open)) && await sw.getAttribute('aria-checked') === 'false')
    }
  }
  await open('status=off', [1280, 800])
  await sw.click()
  await dialog.locator('.ob-history-dialog-foot .btn.primary').click()
  await page.locator('.ob-history[data-ch-status="recording"]').waitFor()
  check('确认 → 开、状态行变成「记录中」', await sw.getAttribute('aria-checked') === 'true' && !(await dialog.evaluate((el) => el.open)))
  await sw.click()
  await page.locator('.ob-history[data-ch-status="off"]').waitFor()
  check('再拨一次直接关,不再确认', await sw.getAttribute('aria-checked') === 'false' && !(await dialog.evaluate((el) => el.open)))
  // 只看说明:不动开关,没有「开启记录」
  await page.locator('.ob-history-more').click()
  await dialog.locator('.ch-about-row').first().waitFor()
  const readOnly = await dialog.evaluate((el) => ({ rows: el.querySelectorAll('.ch-about-row').length, foot: !!el.querySelector('.ob-history-dialog-foot') }))
  check('「完整说明」入口:五条都在、没有开启按钮、开关不动', readOnly.rows === 5 && !readOnly.foot && await sw.getAttribute('aria-checked') === 'false', readOnly)
  await page.keyboard.press('Escape')
  check('Esc 关掉说明', !(await dialog.evaluate((el) => el.open)))

  // ── 平台差异 ──
  await open('status=off', [1280, 800])
  check('macOS:没开开关也画辅助功能那一行(授权状态 + 入口)', await page.locator('.ob-history [data-permission="computerAccessibility"] .btn, .ob-history [data-permission="computerAccessibility"] .desktop-permissions-state').count() >= 1)
  await open('status=off&platform=win32', [1280, 800])
  check('Windows:没有辅助功能那一行,换成一句不需要授权的说明',
    await page.locator('.ob-history [data-permission]').count() === 0 && await page.locator('.ob-history-note').count() === 1)
  await open('status=helper_outdated', [1280, 800])
  check('助手过旧:状态行照实写,不显示成在录', await page.locator('.ob-history').getAttribute('data-ch-status') === 'helper_outdated'
    && await page.locator('.ob-history .settings-status-dot.warn').count() === 1)

  check('无页面错误', errors.length === 0, errors.slice(0, 5))
  await browser.close()
  console.log(`${pass} passed / ${fail} failed; SHOT ${out}`)
  process.exitCode = fail ? 1 : 0
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
