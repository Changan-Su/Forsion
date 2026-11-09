/**
 * Muse 设置 ·「后台额度」区块:真组件 + 生产 CSS,Chromium 里点一遍(桩引擎 + 桩账号额度,不连后端)。
 * Run: node scripts/e2e-editor.cjs --check=bgquota-settings --shot   (worktree 里加 HARNESS_URL=http://localhost:5199/harness.html)
 * 另含设备页(?remote,P1-K10b):引擎对远程来源只回开关摘要时,「后台 Agent」是只读说明 + 两张开关卡。
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
  await page.waitForTimeout(400) // 选中态切换有 160ms 背景过渡,量完之后的静止卡面
  const navCard = await page.locator('#special-historian-tab').evaluate((e) => ({ h: Math.round(e.getBoundingClientRect().height), bg: getComputedStyle(e).backgroundColor })) // open() 选中的是 Muse,Historian 这张是未选中的卡面
  const block = page.locator('.special-bgquota')
  const text = await block.textContent()
  // 2026-09-28:剩余量、「用 AI 额度继续」开关与转入挪进「Forsion 云端 → 额度与积分」(Extend 画的页,测试在 Extend 仓);这里只留说明 + 跳转
  check('说明写清计入模型,并指向额度与积分', text.includes('Luna Lite') && text.includes('额度与积分'))
  check('跟随云端时不提示「别的模型」', !text.includes('不计入后台额度'))
  check('账号级那几样(剩余 / 开关 / 转入)已不在 Muse 页', await block.locator('[role="switch"]').count() === 0 && !text.includes('+10%') && !/剩余 \d/.test(text))
  if (shot) await block.screenshot({ path: path.join(out, 'bgquota-light.png') })
  await block.getByRole('button', { name: '打开额度与积分' }).click()
  const opened = await page.evaluate(() => window.__bgHarness.opened)
  check('「打开额度与积分」跳到 Forsion 云端 → 额度与积分', opened.includes('forsion/fx:forsion-extend:quota'), opened)
  check('账号级跳转不弄脏引擎设置的草稿', (await page.locator('.special-save').textContent()).includes('修改后保存'))

  await open('?other')
  check('Muse 显式选了别的模型 → 提示会走 AI 额度', (await page.locator('.special-bgquota').textContent()).includes('Muse 当前用的是 Opus 5.5，不计入后台额度'))
  // 11-09 方案 A:模型格换成引导 / 设置 → 模型同一个分组选择器;计入后台额度的模型和「跟随云端 · 它」贴「后台额度」,别的不贴,按钮里也不贴
  const menuTags = async () => {
    const menu = page.locator('.composer-menu--anchored')
    await menu.waitFor()
    return menu.locator('.menu-item').evaluateAll((items) => items.map((b) => [b.querySelector('.grow')?.textContent || '', !!b.querySelector('[data-bgq-tag]')]))
  }
  await page.locator('.special-field .model-select-btn').click()
  const museTags = await menuTags()
  check('Muse 模型菜单:跟随项与 Luna Lite 贴后台额度,Opus 5.5 不贴', museTags[0]?.[1] === true && museTags.some(([n, on]) => n === 'Luna Lite' && on) && museTags.some(([n, on]) => n === 'Opus 5.5' && !on), JSON.stringify(museTags))
  check('按钮里不放标签', await page.locator('.special-field .model-select-btn [data-bgq-tag]').count() === 0)
  const menuWidth = await page.locator('.composer-menu--anchored').evaluate((el) => el.offsetWidth) // 布局宽:进场缩放动画不影响
  check('菜单至少 320 宽', menuWidth >= 320, String(menuWidth))
  if (shot) { await page.waitForTimeout(250); await page.screenshot({ path: path.join(out, 'muse-model-menu.png') }) }
  await page.keyboard.press('Escape')
  await page.locator('#special-historian-tab').click()
  await page.locator('.special-field .model-select-btn').click()
  check('Historian 的模型菜单不贴后台额度(不走后台额度)', !(await menuTags()).some(([, on]) => on))
  await page.keyboard.press('Escape')
  await page.locator('#special-muse-tab').click()
  await page.locator('.special-bgquota').waitFor()

  // 本机「设置 → 模型 → 后台任务」那格选了别的:Muse 跟随时落到它(引擎 resolveBackgroundModelId 同一顺序),按钮、标签、下面的说明说同一个模型
  await open('?localbg=m-direct')
  const followBtn = page.locator('.special-field .model-select-btn')
  check('本机后台槽是自己接的 Key:按钮写「跟随本机后台任务 · My Key」', (await followBtn.textContent()).includes('跟随本机后台任务') && (await followBtn.textContent()).includes('My Key'), await followBtn.textContent())
  check('自己接的 Key 不说「不计入后台额度 / 扣 AI 额度」', !(await page.locator('.special-bgquota').textContent()).includes('不计入后台额度'))
  await followBtn.click()
  check('跟随项落到 My Key → 不贴后台额度', (await menuTags())[0]?.[1] === false)
  await page.keyboard.press('Escape')
  await open('?localbg=m-pro')
  check('本机后台槽是别的 Forsion 模型:提示它不计入后台额度', (await page.locator('.special-bgquota').textContent()).includes('Muse 当前用的是 Opus 5.5，不计入后台额度'))
  await page.locator('.special-field .model-select-btn').click()
  check('跟随项落到 Opus 5.5 → 不贴,Luna Lite 仍贴', (await menuTags()).filter(([, on]) => on).map(([n]) => n).join() === 'Luna Lite')
  await page.keyboard.press('Escape')

  await page.setViewportSize({ width: 420, height: 1100 })
  const narrow = await page.locator('.special-bgquota').evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, viewport: innerWidth, scroll: document.documentElement.scrollWidth }
  })
  check('窄栏不横向溢出', narrow.left >= 0 && narrow.right <= narrow.viewport && narrow.scroll <= narrow.viewport, narrow)
  if (shot) await page.locator('.special-bgquota').screenshot({ path: path.join(out, 'bgquota-narrow.png') })

  // ── 云端引擎(web/安卓):只有按轮 Historian 的开关 / 模型 / 轮数 / 首轮,外加额度说明(09-27)──
  await page.setViewportSize({ width: 900, height: 1100 })
  await page.goto(base.toString() + '?cloud')
  await page.locator('.special-agent-content').waitFor()
  const cloudText = await page.locator('.special-agents').textContent()
  check('云端:没有 Muse 标签、没有模式选择、没有提示词', await page.locator('#special-muse-tab').count() === 0 && await page.locator('.special-choices').count() === 0 && await page.locator('textarea').count() === 0)
  check('云端:写明按轮、计入 AI 额度、用完跳过', cloudText.includes('计入你的 AI 额度') && cloudText.includes('额度用完的那一轮会跳过'))
  const rounds = page.getByRole('spinbutton').first()
  await rounds.fill('4'); await rounds.press('Enter') // NumberField 失焦 / 回车才提交
  await page.locator('.special-save .btn.primary').click()
  await page.locator('.special-save').getByText('已保存').waitFor()
  const posts = await page.evaluate(() => window.__bgHarness.posts)
  check('云端:保存只发改动的 historian 键', posts.length === 1 && posts[0].historian && posts[0].historian.everyRounds === 4, posts)
  if (shot) await page.locator('.special-agents').screenshot({ path: path.join(out, 'historian-cloud.png') })

  // ── 设备页(远程来源):引擎只回开关摘要 + remote:true(P1-K10b)──
  await page.goto(base.toString() + '?remote')
  await page.locator('.special-agent-status').first().waitFor()
  const remoteText = await page.locator('.special-agents').textContent()
  check('远程:只读说明 + 两张开关卡', remoteText.includes('只能在运行它们的那台电脑上设置') && await page.locator('.special-agent-status').count() === 2, remoteText)
  const states = await page.locator('.special-agent-status i').evaluateAll((els) => els.map((e) => `${e.textContent}|${e.className}`))
  check('远程:开关状态照真值(Historian 启用 / Muse 关闭)', states[0] === '启用|on' && states[1] === '关闭|', states)
  check('远程:没有编辑器、保存栏、可点控件', await page.locator('.special-editor').count() === 0 && await page.locator('.special-save').count() === 0 && await page.locator('.special-agents button, .special-agents textarea, .special-agents input').count() === 0)
  const cards = await page.locator('.special-agent-status').evaluateAll((els) => els.map((e) => { const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return { h: Math.round(r.height), top: Math.round(r.top), bg: cs.backgroundColor, cursor: cs.cursor, display: cs.display } }))
  check('远程:开关卡与本机切换按钮同一张卡面(同高、同底色、不显示可点)', cards.every((c) => c.display === 'flex' && c.cursor !== 'pointer' && c.h === navCard.h && c.bg === navCard.bg) && cards[0].top === cards[1].top, { cards, navCard })
  if (shot) await page.locator('.special-agents').screenshot({ path: path.join(out, 'special-remote-light.png') })
  await page.setViewportSize({ width: 420, height: 1100 })
  const remoteNarrow = await page.locator('.special-agent-status').evaluateAll((els) => ({ tops: els.map((e) => Math.round(e.getBoundingClientRect().top)), right: Math.max(...els.map((e) => e.getBoundingClientRect().right)), viewport: innerWidth, scroll: document.documentElement.scrollWidth }))
  check('远程:窄栏两张卡上下排、不横向溢出', remoteNarrow.tops[1] > remoteNarrow.tops[0] && remoteNarrow.right <= remoteNarrow.viewport && remoteNarrow.scroll <= remoteNarrow.viewport, remoteNarrow)
  if (shot) await page.locator('.special-agents').screenshot({ path: path.join(out, 'special-remote-narrow.png') })
  await page.setViewportSize({ width: 900, height: 1100 })
  await page.goto(base.toString() + '?remote&dark&lang=en')
  await page.locator('.special-agent-status').first().waitFor()
  check('远程:英文界面同一句说明', (await page.locator('.special-agents').textContent()).includes('can only be set up on the computer they run on'))
  if (shot) await page.locator('.special-agents').screenshot({ path: path.join(out, 'special-remote-dark-en.png') })

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
