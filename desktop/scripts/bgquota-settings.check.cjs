/**
 * Muse 设置 ·「后台额度」区块:真组件 + 生产 CSS,Chromium 里点一遍(桩引擎 + 桩账号额度,不连后端)。
 * Run: node scripts/e2e-editor.cjs --check=bgquota-settings --shot   (worktree 里加 HARNESS_URL=http://localhost:5199/harness.html)
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
  base.pathname = '/bgquota-harness.html'
  const shot = process.argv.some((arg) => arg.startsWith('--shot'))
  const out = path.join(os.tmpdir(), 'forsion-bgquota-settings')
  fs.mkdirSync(out, { recursive: true })
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 900, height: 1100 } })
  const open = async (query = '') => {
    await page.goto(base.toString() + query)
    await page.locator('#special-muse-tab').click()
    await page.locator('.special-bgquota').waitFor()
  }

  await open()
  const block = page.locator('.special-bgquota')
  const text = await block.textContent()
  check('说明写清额外赠送、份额与计入模型', text.includes('相当于你额度的 15%') && text.includes('Luna Lite'))
  check('两轴剩余按精确比例', text.includes('剩余 13%') && text.includes('剩余 60%'))
  check('低于 15% 的那条换警示色', await block.locator('[data-axis="daily"] em[data-low]').count() === 1 && await block.locator('[data-axis="weekly"] em[data-low]').count() === 0)
  check('跟随云端时不提示「别的模型」', !text.includes('不计入后台额度'))
  if (shot) await block.screenshot({ path: path.join(out, 'bgquota-light.png') })

  await block.getByRole('switch', { name: '用完后改用主额度继续' }).click()
  await page.waitForFunction(() => document.querySelector('.special-bgquota [role="switch"]')?.getAttribute('aria-checked') === 'true')
  check('「用主额度继续」开关立即生效', true)

  await block.getByRole('button', { name: '+10%' }).click()
  check('转入需要二次确认', await block.getByRole('button', { name: '再点确认' }).isVisible())
  await block.getByRole('button', { name: '再点确认' }).click()
  await block.getByText('已转入,本周期有效').waitFor()
  const converted = await page.evaluate(() => window.__bgHarness.converted)
  check('确认后按 10% 转入并刷新余量', converted.length === 1 && converted[0] === 10 && (await block.textContent()).includes('剩余 48%'), converted)
  check('账号级操作不弄脏引擎设置的草稿', (await page.locator('.special-save').textContent()).includes('修改后保存'))

  await open('?other')
  check('Muse 显式选了别的模型 → 提示会走主额度', (await page.locator('.special-bgquota').textContent()).includes('Muse 当前用的是 Opus 5.5,不计入后台额度'))

  await page.setViewportSize({ width: 420, height: 1100 })
  const narrow = await page.locator('.special-bgquota').evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, viewport: innerWidth, scroll: document.documentElement.scrollWidth }
  })
  check('窄栏不横向溢出', narrow.left >= 0 && narrow.right <= narrow.viewport && narrow.scroll <= narrow.viewport, narrow)
  if (shot) await page.locator('.special-bgquota').screenshot({ path: path.join(out, 'bgquota-narrow.png') })

  if (shot) {
    await page.setViewportSize({ width: 900, height: 1100 })
    await open('?dark&lang=en')
    await page.locator('.special-bgquota').screenshot({ path: path.join(out, 'bgquota-dark-en.png') })
    console.log(`SHOT ${out}`)
  }
  await browser.close()
  console.log(`${checks}/${checks} passed`)
}

main().catch((error) => { console.error(error); process.exit(1) })
