/**
 * Chatbox quota advisory: real component + production CSS in Chromium.
 * Run: node scripts/e2e-editor.cjs --check=quota-banner --shot
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

async function main() {
  const base = new URL(process.env.HARNESS_URL || 'http://localhost:5173/harness.html')
  base.pathname = '/quota-harness.html'
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1000, height: 720 } })
  await page.goto(base.toString())
  const banner = page.locator('.t2-quota-advisory')
  await banner.waitFor()

  check('显示更紧张的本周额度', (await banner.textContent()).includes('本周托管 AI 额度即将用尽,仅剩 8%'))
  check('显示升级会员', await banner.getByText('升级会员', { exact: true }).isVisible())
  check('显示可用重置卡数', await banner.getByText('使用重置卡 (2)', { exact: true }).isVisible())
  const geometry = await page.locator('.quota-harness-chat').evaluate((root) => {
    const strip = root.querySelector('.t2-quota-advisory').getBoundingClientRect()
    const cardEl = root.querySelector('.t2c-card')
    const composer = cardEl.getBoundingClientRect()
    const textarea = root.querySelector('.t2c-ta').getBoundingClientRect()
    const col = root.querySelector('.t2-chat-col').getBoundingClientRect()
    return {
      nested: root.querySelector('.t2-quota-advisory')?.parentElement === cardEl,
      strip: { left: strip.left, right: strip.right, top: strip.top, bottom: strip.bottom },
      composer: { left: composer.left, right: composer.right, top: composer.top },
      textarea: { top: textarea.top }, col: { left: col.left, right: col.right },
    }
  })
  check('提示条是 Chatbox 内部 header', geometry.nested, geometry)
  check('提示条贴住 Chatbox 顶边并与正文分隔', Math.abs(geometry.strip.top - geometry.composer.top) < 2 && geometry.strip.bottom < geometry.textarea.top, geometry)
  check('提示条与 Chatbox 共用外轮廓', Math.abs(geometry.strip.left - geometry.composer.left) < 2 && Math.abs(geometry.strip.right - geometry.composer.right) < 2, geometry)

  await banner.getByLabel('关闭额度提示').click()
  check('当前档位可关闭', await banner.count() === 0)
  await page.evaluate(() => window.__quotaHarness.setQuota({ weeklyRemaining: 4 }))
  await banner.waitFor()
  check('进入 5% 档会重新提醒', (await banner.textContent()).includes('严重不足,仅剩 4%'))

  await banner.getByText('使用重置卡 (2)', { exact: true }).click()
  check('使用重置卡需要二次确认', await banner.getByText('再次点击确认', { exact: true }).isVisible())
  await banner.getByText('再次点击确认', { exact: true }).click()
  await banner.waitFor({ state: 'detached' })
  check('额度恢复后提示消失', await banner.count() === 0)

  await page.evaluate(() => window.__quotaHarness.setQuota({ dailyRemaining: 0, weeklyRemaining: 40, resetCards: 0 }))
  await banner.waitFor()
  check('耗尽状态与无卡状态正确', (await banner.textContent()).includes('今日托管 AI 额度已用尽') && (await banner.textContent()).includes('暂无重置卡'))

  if (process.argv.some((arg) => arg.startsWith('--shot'))) {
    const out = path.join(os.tmpdir(), 'forsion-quota-banner')
    fs.mkdirSync(out, { recursive: true })
    await page.screenshot({ path: path.join(out, 'quota-light.png') })
    await page.setViewportSize({ width: 420, height: 720 })
    await page.screenshot({ path: path.join(out, 'quota-narrow.png') })
    const narrow = await banner.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, viewport: innerWidth, height: r.height }
    })
    check('窄栏提示不横向溢出', narrow.left >= 0 && narrow.right <= narrow.viewport, narrow)
    console.log(`SHOT ${out}`)
  }

  await browser.close()
  console.log(`${checks}/${checks} passed`)
}

main().catch((error) => { console.error(error); process.exit(1) })
