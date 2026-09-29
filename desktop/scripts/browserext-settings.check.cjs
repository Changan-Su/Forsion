/**
 * 设置 → 浏览器 →「Chrome 扩展」卡片:真组件 + 生产 CSS,Chromium 里点一遍(桩引擎,不连后端)。
 * Run: node scripts/e2e-editor.cjs --check=browserext-settings --shot   (worktree 里加 HARNESS_URL=http://localhost:5199/harness.html)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse() : []
  for (const d of dirs) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const file = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(file)) return file
    }
  }
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' // 独立临时配置跑,不碰用户的 Chrome
  if (fs.existsSync(chrome)) return chrome
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
  base.pathname = '/browserext-harness.html'
  const shot = process.argv.some((arg) => arg.startsWith('--shot'))
  const out = path.join(os.tmpdir(), 'forsion-browserext-settings')
  fs.mkdirSync(out, { recursive: true })
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 900, height: 900 } })
  page.on('dialog', (d) => void d.accept()) // 换码的二次确认
  const panel = page.locator('[data-testid="browser-extension-panel"]')
  const open = async (query = '') => { await page.goto(base.toString() + query); await panel.waitFor() }

  await open()
  check('未连接时状态写明', (await page.locator('[data-testid="browser-extension-status"]').textContent()) === '未连接')
  check('连接码整段显示', (await page.locator('[data-testid="browser-extension-code"]').textContent()).startsWith('tangu:47655:'))
  const text = await panel.textContent()
  check('三步安装说明齐全', text.includes('1. ') && text.includes('chrome://extensions') && text.includes('加载已解压的扩展程序') && text.includes('3. '))
  if (shot) await page.locator('.settings-browser-ext-panel').screenshot({ path: path.join(out, 'ext-light.png') })

  await panel.getByRole('button', { name: '打开扩展文件夹' }).click()
  const opened = await page.evaluate(() => window.__extHarness.opened)
  check('「打开扩展文件夹」打开随包的扩展目录', opened.length === 1 && opened[0].endsWith('/tangu-server/browser-extension'), opened)

  await panel.getByRole('button', { name: '换一个' }).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="browser-extension-code"]')?.textContent?.includes('abab'))
  check('换码确认后显示新码', (await page.evaluate(() => window.__extHarness.resets)) === 1)

  // 竞态:换码之前 / 途中发出的轮询晚回来,不许把新码盖回旧码
  const codeText = () => page.locator('[data-testid="browser-extension-code"]').textContent()
  await open()
  await page.waitForFunction(() => document.querySelector('[data-testid="browser-extension-code"]')?.textContent?.startsWith('tangu:'))
  await page.evaluate(() => { window.__extHarness.holdPolls = true })
  await page.waitForFunction(() => window.__extHarness.held.length > 0, null, { timeout: 5000 })
  const oldCode = await codeText()
  await panel.getByRole('button', { name: '换一个' }).click()
  await page.waitForFunction((old) => document.querySelector('[data-testid="browser-extension-code"]')?.textContent !== old, oldCode)
  await page.evaluate(() => window.__extHarness.release())
  await page.waitForTimeout(300)
  const shown = await codeText()
  check('换码前发出的轮询晚到,不会把旧码盖回来', shown !== oldCode && shown === (await page.evaluate(() => window.__extHarness.code)), { shown, oldCode })

  // 换码进行中按钮置灰:两次换码乱序返回会留下已作废的码
  await open()
  await page.evaluate(() => { window.__extHarness.holdResets = true })
  const resetBtn = panel.getByRole('button', { name: '换一个' })
  await resetBtn.click()
  await page.waitForFunction(() => window.__extHarness.held.length > 0)
  const busy = await resetBtn.isDisabled()
  await page.evaluate(() => window.__extHarness.release())
  await page.waitForFunction(() => document.querySelector('[data-testid="browser-extension-code"]')?.textContent?.includes('abab'))
  check('换码进行中「换一个」置灰,回来后恢复', busy && (await resetBtn.isEnabled()), { busy })

  await open('?external')
  const extText = await panel.textContent()
  check('外部引擎:不给「打开扩展文件夹」(目录在引擎那台机器上),改为写明路径',
    (await panel.getByRole('button', { name: '打开扩展文件夹' }).count()) === 0 && extText.includes('外部引擎') && extText.includes('/tangu-server/browser-extension'), extText.slice(-160))
  if (shot) await page.locator('.settings-browser-ext-panel').screenshot({ path: path.join(out, 'ext-external.png') })

  await open('?connected')
  check('连上后状态为已连接', (await page.locator('[data-testid="browser-extension-status"]').textContent()) === '已连接')
  await open('?busy')
  check('端口被占时直说原因', (await page.locator('[data-testid="browser-extension-status"]').textContent()).includes('47655') )

  await page.setViewportSize({ width: 420, height: 900 })
  await open('?connected')
  const narrow = await page.locator('.settings-browser-ext-panel').evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, viewport: innerWidth, scroll: document.documentElement.scrollWidth }
  })
  check('窄栏不横向溢出', narrow.left >= 0 && narrow.right <= narrow.viewport && narrow.scroll <= narrow.viewport, narrow)
  if (shot) await page.locator('.settings-browser-ext-panel').screenshot({ path: path.join(out, 'ext-narrow.png') })

  if (shot) {
    await page.setViewportSize({ width: 900, height: 900 })
    await open('?connected&dark&lang=en')
    await page.locator('.settings-browser-ext-panel').screenshot({ path: path.join(out, 'ext-dark-en.png') })
    console.log(`SHOT ${out}`)
  }
  await browser.close()
  console.log(`\n${checks} checks passed`)
}

main().catch((e) => { console.error(`FAIL ${e.message}`); process.exit(1) })
