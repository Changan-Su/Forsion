/**
 * 设置 → 浏览器 →「浏览器扩展」卡片:真组件 + 生产 CSS,Chromium 里点一遍(桩引擎,不连后端)。
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
  check('从没连上过:状态是「未安装」', (await page.locator('[data-testid="browser-extension-status"]').textContent()) === '未安装')
  check('连接码整段显示', (await page.locator('[data-testid="browser-extension-code"]').textContent()).startsWith('tangu:47655:'))
  const text = await panel.textContent()
  check('三步安装说明齐全,Chrome / Edge 的扩展页与按钮名都写到', text.includes('1. ') && text.includes('chrome://extensions') && text.includes('edge://extensions') && text.includes('加载未打包的扩展程序') && text.includes('加载解压缩的扩展') && text.includes('3. '))
  check('不知道系统时选择框不给系统专属提示', !text.includes('⌘⇧G') && !text.includes('Ctrl+L'))
  check('「允许其他设备连接本机」关着:第 3 步说 Forsion 会弹「允许并打开」,「手动配对」缺省展开', text.includes('允许并打开') && text.includes('允许其他设备连接本机') && (await page.locator('[data-testid="browser-extension-manual"]').getAttribute('aria-expanded')) === 'true')

  // 手动安装底座:扩展复制出包(用户找得到)、替用户打开扩展页、拖拽把手走原生拖出
  check('只认到 Chrome:只给 Chrome 的按钮,也不出 Edge 提醒', (await panel.getByRole('button', { name: '在 Edge 中打开扩展页' }).count()) === 0 && (await page.locator('[data-testid="browser-extension-edge-warning"]').count()) === 0)
  await panel.getByRole('button', { name: '在 Chrome 中打开扩展页' }).click()
  await page.waitForFunction(() => window.__extHarness.pagesOpened.length === 1)
  check('「在 Chrome 中打开扩展页」交给主进程,打开成功不出提示', (await page.evaluate(() => window.__extHarness.pagesOpened)).join() === 'chrome' && (await page.locator('[data-testid="browser-extension-open-note"]').count()) === 0)
  await page.locator('[data-testid="browser-extension-drag"]').dispatchEvent('dragstart')
  const dragged = await page.evaluate(() => window.__extHarness.dragged)
  check('拖拽把手拖出的是复制出包的那份', dragged.length === 1 && dragged[0].endsWith('/Forsion/Forsion Clip'), dragged)
  check('复制出包的路径写在卡片上', (await panel.textContent()).includes('Application Support/Forsion/Forsion Clip'))
  await panel.getByRole('button', { name: '打开扩展文件夹' }).click()
  const opened = await page.evaluate(() => window.__extHarness.opened)
  check('「打开扩展文件夹」打开复制出包的那份', opened.length === 1 && opened[0].endsWith('/Forsion/Forsion Clip'), opened)
  if (shot) await page.locator('.settings-browser-ext-panel').screenshot({ path: path.join(out, 'ext-light.png') })

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

  await open('?notfound')
  await panel.getByRole('button', { name: '在 Chrome 中打开扩展页' }).click()
  await page.locator('[data-testid="browser-extension-open-note"]').waitFor()
  check('没找到浏览器:提示已复制地址', /没找到 Chrome。已复制 chrome:\/\/extensions/.test(await page.locator('[data-testid="browser-extension-open-note"]').textContent()))

  // Windows:Chrome / Edge 都装了 → 两个按钮;点 Edge = 开了新窗口、地址已复制,提示 Ctrl+L 粘贴;选择框提示走 Windows 的
  await open('?both&launched&platform=win32')
  check('Chrome / Edge 都装了:两个按钮都在', (await panel.locator('[data-testid^="browser-extension-open-"]').evaluateAll((els) => els.map((el) => el.dataset.testid))).join() === 'browser-extension-open-chrome,browser-extension-open-edge')
  const edgeWarning = await page.locator('[data-testid="browser-extension-edge-warning"]').textContent().catch(() => '')
  check('装了 Edge:提醒 Edge 会弹「关闭开发人员模式下的扩展」,别点「关闭扩展」,关掉了去 edge://extensions 打开', edgeWarning.includes('关闭开发人员模式下的扩展') && edgeWarning.includes('别点「关闭扩展」') && edgeWarning.includes('edge://extensions'), edgeWarning)
  await panel.getByRole('button', { name: '在 Edge 中打开扩展页' }).click()
  await page.locator('[data-testid="browser-extension-open-note"]').waitFor()
  const launchedNote = await page.locator('[data-testid="browser-extension-open-note"]').textContent()
  check('Windows 打开 Edge:交给主进程的是 edge,提示新窗口 + 已复制 edge://extensions + Ctrl+L 粘贴', (await page.evaluate(() => window.__extHarness.pagesOpened)).join() === 'edge' && launchedNote.includes('已打开 Edge 新窗口') && launchedNote.includes('edge://extensions') && launchedNote.includes('Ctrl+L'), launchedNote)
  check('Windows:选择框提示是 Ctrl+L 粘贴路径', (await panel.textContent()).includes('按 Ctrl+L 粘贴路径') && !(await panel.textContent()).includes('⌘⇧G'))
  if (shot) await page.locator('.settings-browser-ext-panel').screenshot({ path: path.join(out, 'ext-win-both.png') })
  await open('?platform=darwin')
  check('mac:选择框提示是 ⌘⇧G', (await panel.textContent()).includes('⌘⇧G') && !(await panel.textContent()).includes('按 Ctrl+L 粘贴路径'))
  await open('?edgeonly')
  check('只装了 Edge:只给 Edge 的按钮,带 Edge 提醒', (await panel.getByRole('button', { name: '在 Edge 中打开扩展页' }).count()) === 1 && (await panel.getByRole('button', { name: '在 Chrome 中打开扩展页' }).count()) === 0 && (await page.locator('[data-testid="browser-extension-edge-warning"]').count()) === 1)
  await open('?nobrowser')
  check('一个浏览器都认不出:退回只给 Chrome(主进程会复制地址)', (await panel.locator('[data-testid^="browser-extension-open-"]').count()) === 1 && (await panel.getByRole('button', { name: '在 Chrome 中打开扩展页' }).count()) === 1)

  // 副本是旧版:挂载时不换(Chrome 正从那里加载),写明有新版;拖的那一下先换成随包版本再拖
  await open('?stale')
  await page.locator('[data-testid="browser-extension-update-hint"]').waitFor()
  check('副本旧版:挂载只补缺不换,写明有新版本', (await page.evaluate(() => window.__extHarness.prepares)).every((u) => u === false))
  await page.locator('[data-testid="browser-extension-drag"]').dispatchEvent('dragstart')
  await page.waitForFunction(() => window.__extHarness.dragged.length === 1)
  check('副本旧版:拖之前先换成随包版本', (await page.evaluate(() => window.__extHarness.prepares)).includes(true) && (await page.locator('[data-testid="browser-extension-update-hint"]').count()) === 0)

  // 副本准备失败:退回打开随包目录,写明原因(Codex 10-20)
  await open('?copyfail')
  await page.locator('[data-testid="browser-extension-copy-error"]').waitFor()
  await panel.getByRole('button', { name: '打开扩展文件夹' }).click()
  const openedFail = await page.evaluate(() => window.__extHarness.opened)
  check('副本准备失败:退回打开随包目录,不给拖拽把手', openedFail[0]?.endsWith('/tangu-server/browser-extension') && (await page.locator('[data-testid="browser-extension-drag"]').count()) === 0, openedFail)

  await open('?noclip')
  await panel.getByRole('button', { name: '打开扩展文件夹' }).click()
  const openedOld = await page.evaluate(() => window.__extHarness.opened)
  check('壳里没有 clipExtension:退回打开随包目录,不给拖拽把手', openedOld.length === 1 && openedOld[0].endsWith('/tangu-server/browser-extension') && (await page.locator('[data-testid="browser-extension-drag"]').count()) === 0, openedOld)

  await open('?external&both&platform=win32')
  const extText = await panel.textContent()
  check('外部引擎:不给「打开扩展文件夹」/「打开扩展页」(在引擎那台机器上装),选择框不给本机系统提示,改为写明路径',
    (await panel.getByRole('button', { name: '打开扩展文件夹' }).count()) === 0 && (await panel.locator('[data-testid^="browser-extension-open-"]').count()) === 0 && !extText.includes('Ctrl+L 粘贴路径') && (await page.locator('[data-testid="browser-extension-edge-warning"]').count()) === 0 && extText.includes('外部引擎') && extText.includes('/tangu-server/browser-extension'), extText.slice(-160))
  if (shot) await page.locator('.settings-browser-ext-panel').screenshot({ path: path.join(out, 'ext-external.png') })

  await open('?connected')
  check('连上后状态写明版本', (await page.locator('[data-testid="browser-extension-status"]').textContent()) === '已连接 · Forsion Clip 2.1.0')
  await open('?installed')
  check('连上过、现在没连:状态是「未连接」', (await page.locator('[data-testid="browser-extension-status"]').textContent()) === '未连接')

  // 一次配对能用(互联开着):第 3 步改说「点允许」,连接码收进「手动配对」,点开才出来
  await open('?hoston')
  const hostOnText = await panel.textContent()
  check('互联开着:第 3 步说装好后点「允许」,不再让粘码', hostOnText.includes('点「允许」') && !hostOnText.includes('允许其他设备连接本机') && (await page.locator('[data-testid="browser-extension-code"]').count()) === 0)
  await page.locator('[data-testid="browser-extension-manual"]').click()
  await page.locator('[data-testid="browser-extension-code"]').waitFor()
  check('展开「手动配对」后连接码与「换一个」都在', (await panel.getByRole('button', { name: '换一个' }).count()) === 1)
  if (shot) await page.locator('.settings-browser-ext-panel').screenshot({ path: path.join(out, 'ext-hoston-manual.png') })
  await open('?hoston&external')
  check('外部引擎:「手动配对」缺省展开', (await page.locator('[data-testid="browser-extension-code"]').count()) === 1)
  await open('?busy')
  check('端口被占时直说原因', (await page.locator('[data-testid="browser-extension-status"]').textContent()).includes('47655') )

  await page.setViewportSize({ width: 420, height: 900 })
  await open('?connected&both')
  const narrow = await page.locator('.settings-browser-ext-panel').evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, viewport: innerWidth, scroll: document.documentElement.scrollWidth }
  })
  check('窄栏不横向溢出', narrow.left >= 0 && narrow.right <= narrow.viewport && narrow.scroll <= narrow.viewport, narrow)
  if (shot) await page.locator('.settings-browser-ext-panel').screenshot({ path: path.join(out, 'ext-narrow.png') })

  if (shot) {
    await page.setViewportSize({ width: 900, height: 900 })
    await open('?connected&dark&lang=en&both&launched&platform=win32')
    await panel.getByRole('button', { name: 'Open extensions in Edge' }).click()
    await page.locator('[data-testid="browser-extension-open-note"]').waitFor()
    await page.locator('.settings-browser-ext-panel').screenshot({ path: path.join(out, 'ext-dark-en.png') })
    console.log(`SHOT ${out}`)
  }
  await browser.close()
  console.log(`\n${checks} checks passed`)
}

main().catch((e) => { console.error(`FAIL ${e.message}`); process.exit(1) })
