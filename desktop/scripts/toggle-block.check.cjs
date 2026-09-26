// 生产 UnifiedPage 折叠块：真实鼠标/键盘、保存重开、嵌套与主题截图。
// npm run e2e:editor -- --check=toggle-block [--shot=/tmp/amadeus-toggle]
const fs = require('fs'), os = require('os'), path = require('path')
const { chromium } = require('playwright-core')
const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const FOLD = `${PM} > blockquote.callout-fold`
const HEAD = `${FOLD} > p:first-child`
const ARROW = `${HEAD} > .callout-chevron`
const results = []
const shotDir = (process.argv.find((a) => a.startsWith('--shot=')) || '').slice(7)
function check(name, ok, detail = '') {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`)
}
function chromiumPath() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const dir of fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse())
    for (const app of ['Google Chrome for Testing', 'Chromium']) {
      const p = path.join(root, dir, 'chrome-mac-arm64', `${app}.app/Contents/MacOS/${app}`)
      if (fs.existsSync(p)) return p
    }
  throw new Error('找不到 Chromium')
}
async function clickText(page, selector, end = false) {
  const point = await page.locator(selector).first().evaluate((el, end) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node
    const nodes = []
    while ((node = walker.nextNode())) {
      if (!node.parentElement.closest('button,.callout-syntax')) nodes.push(node)
    }
    const target = end ? nodes.at(-1) : nodes[0]
    const r = document.createRange()
    r.selectNodeContents(target)
    const b = r.getBoundingClientRect()
    return { x: end ? b.right - 1 : b.left + 1, y: b.top + b.height / 2 }
  }, end)
  await page.mouse.click(point.x, point.y)
}
async function main() {
  const browser = await chromium.launch({ executablePath: chromiumPath(), headless: true })
  const errors = []
  const fresh = async (seed, locale = 'zh-CN') => {
    const p = await browser.newPage({ locale, viewport: { width: 1200, height: 860 } })
    p.on('pageerror', (e) => errors.push(e.message))
    await p.goto(`${URL}?upage&upane&useed=${encodeURIComponent(seed)}`)
    await p.waitForSelector(FOLD)
    return p
  }
  const saved = async (p) => {
    await p.waitForTimeout(1200)
    return p.evaluate(() => window.__upage.writes.at(-1)?.text || '')
  }
  const tokenWidth = (p) => p.locator(`${HEAD} .callout-token`).first().evaluate((el) => el.getBoundingClientRect().width)
  try {
    let p = await fresh('> [!fold]- 标题\n> 内容一\n> 内容二\n\n后续段落')
    await p.waitForTimeout(1300)
    check('打开旧的单换行折叠块不写盘', await p.evaluate(() => window.__upage.writes.length) === 0)
    check('单换行内容真实收起', await p.locator(`${FOLD} > p`).count() === 3 && !await p.locator(`${FOLD} > p`).nth(1).isVisible())
    const before = await p.locator(ARROW).boundingBox()
    check('固定 24px SVG 三角与可访问状态', await p.locator(`${ARROW} svg`).count() === 1 && await p.locator(ARROW).getAttribute('aria-expanded') === 'false' && before.width === 24)
    await clickText(p, HEAD, true)
    await p.keyboard.type(' edited')
    check('单击标题直接打字，不切换折叠', await p.locator(FOLD).evaluate((el) => el.classList.contains('callout-collapsed')) && (await p.locator(HEAD).innerText()).includes('edited'))
    check('编辑标题不露隐藏令牌', await tokenWidth(p) === 0)
    const md = await saved(p)
    check('标题编辑保留完整内容与 Markdown 令牌', md.includes('[!fold]-') && md.includes('edited') && md.includes('内容二'), md)
    await p.locator(ARROW).click()
    const after = await p.locator(ARROW).boundingBox()
    await p.locator(`${FOLD} > p`).nth(1).waitFor({ state: 'visible' })
    check('展开后正文可见，箭头不随标题长度移动', await p.locator(`${FOLD} > p`).nth(1).isVisible() && before.x === after.x)
    await p.locator(ARROW).focus()
    await p.keyboard.press('Space')
    await p.keyboard.press('Enter')
    const keyboardState = await p.locator(ARROW).evaluate((el) => ({ expanded: el.getAttribute('aria-expanded'), focused: el === document.activeElement, active: document.activeElement?.className }))
    check('键盘可连续切换，焦点留在按钮', keyboardState.expanded === 'true' && keyboardState.focused, keyboardState)
    await p.close()
    p = await fresh(md)
    check('保存重开标题、折叠状态、隐藏内容保留', (await p.locator(HEAD).innerText()).includes('edited') && !await p.locator(`${FOLD} > p`).nth(1).isVisible() && await p.locator(`${FOLD} > p`).count() === 3)
    await p.locator(`${PM} > p`).last().click()
    await p.keyboard.press('Meta+a') // v4 第一档选当前段，第二档才是全文。
    await p.keyboard.press('Meta+a')
    const copied = await p.locator(PM).evaluate((el) => {
      const data = new DataTransfer()
      el.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }))
      return data.getData('text/plain')
    })
    check('折叠态复制保留隐藏内容，不夹带界面按钮', copied.includes('内容二') && copied.includes('[!fold]-') && !copied.includes('</>'), copied)
    await p.close()

    p = await fresh('> [!fold]- 标题\n>\n> 原有内容\n\n后续段落')
    await clickText(p, HEAD, true)
    await p.keyboard.press('Enter')
    await p.keyboard.press('Meta+z')
    check('一次撤销回车还原标题和折叠状态', await p.locator(ARROW).getAttribute('aria-expanded') === 'false' && await p.locator(`${FOLD} > p`).count() === 2)
    await p.keyboard.press('Meta+Shift+z')
    await p.keyboard.type('新增内容')
    check('标题回车展开并进入正文', await p.locator(ARROW).getAttribute('aria-expanded') === 'true' && (await p.locator(`${FOLD} > p`).nth(1).innerText()).trim() === '新增内容', await p.locator(FOLD).innerText())
    await p.locator(ARROW).click()
    await p.keyboard.type('继续编辑')
    check('正文中收起后，光标回到可见标题', (await p.locator(HEAD).innerText()).includes('继续编辑'))
    await clickText(p, HEAD)
    await p.keyboard.press('Backspace')
    check('标题开头退格转普通段落，子内容完整保留', await p.locator(FOLD).count() === 0 && (await p.locator(PM).innerText()).includes('新增内容') && (await p.locator(PM).innerText()).includes('原有内容'))
    await p.close()

    p = await fresh('> [!fold]+\n\n后续段落')
    check('空标题与空内容有可操作提示', await p.locator(HEAD).getAttribute('data-placeholder') === '折叠标题' && await p.locator('.callout-empty').isVisible())
    await p.locator('.callout-empty').click()
    await p.keyboard.type('从空块开始')
    check('点击空内容直接输入', await p.locator(`${FOLD} > p`).nth(1).innerText() === '从空块开始' && await p.locator('.callout-empty').count() === 0)
    await p.close()

    p = await fresh('> [!fold]+ 标题\n>\n> 内容\n\n后续段落')
    await clickText(p, HEAD, true)
    await p.keyboard.press('Meta+ArrowLeft')
    // Home/系统行首不会把新文字写到隐藏令牌之前。
    await p.keyboard.type('首')
    check('行首输入位于标题开头并保留折叠结构', await p.locator(FOLD).count() === 1 && (await p.locator(HEAD).innerText()).includes('首标题'), await p.locator(PM).innerText())
    await p.locator(HEAD).dblclick()
    check('双击仍按文本选词，不露源码', await tokenWidth(p) === 0)
    await p.locator(HEAD).hover()
    await p.locator('.callout-source').click()
    check('显式源码入口能编辑令牌', await tokenWidth(p) > 10)
    await p.locator(`${PM} > p`).last().click()
    check('离开折叠块自动收回源码', await tokenWidth(p) === 0)
    await p.close()

    p = await fresh('> [!fold]+ 标题\n\n后续段落')
    await p.locator('.callout-empty').click()
    await p.keyboard.press('Enter')
    await p.keyboard.type('折叠外新段落')
    check('空内容回车退出折叠块', (await p.locator(`${PM} > p`).allTextContents()).includes('折叠外新段落'))
    await p.close()

    p = await fresh('> [!fold]+ 外层\n>\n> > [!fold]- 内层\n> >\n> > 内层内容\n>\n> 外层内容\n\n后续段落')
    check('嵌套折叠各自显示按钮', await p.locator('.callout-chevron').count() === 2)
    await p.locator(ARROW).click()
    await p.locator('.callout-fold .callout-fold').waitFor({ state: 'hidden' })
    check('外层收起完全隐藏子折叠（含 padding）', !await p.locator('.callout-fold .callout-fold').isVisible())
    await p.locator(ARROW).click()
    await p.locator('.callout-fold .callout-fold').waitFor({ state: 'visible' })
    check('外层展开保留内层的折叠状态', await p.locator('.callout-fold .callout-fold.callout-collapsed').count() === 1)
    await p.locator('.callout-fold .callout-fold .callout-chevron').click()
    await p.locator('.callout-fold .callout-fold > p').nth(1).waitFor({ state: 'visible' })
    check('内层独立展开内容', await p.locator('.callout-fold .callout-fold > p').nth(1).isVisible())
    await p.close()

    if (shotDir) {
      fs.mkdirSync(shotDir, { recursive: true })
      p = await fresh('折叠块让长笔记保持清晰。\n\n> [!fold]+ 项目计划 · Project plan\n>\n> 点击标题即可编辑，左侧三角控制展开与收起。\n>\n> - 整理需求与参考\n> - 验证鼠标和键盘操作\n>\n> > [!fold]- 更多细节 · Details\n> >\n> > 嵌套的内容也有独立状态。\n\n> [!fold]- 一个很长的折叠标题，在窄窗口自然换行，箭头始终位于第一行左侧\n>\n> 隐藏的正文。\n\n> [!fold]+\n\n正文继续。')
      await p.mouse.click(4, 4)
      // 深浅色主题由 toggle-block.electron.cjs 走真实主题 store；此台架壳固定浅色。
      await p.screenshot({ path: path.join(shotDir, 'light.png') })
      await p.setViewportSize({ width: 460, height: 860 })
      await p.screenshot({ path: path.join(shotDir, 'narrow.png') })
      check('窄窗口无横向溢出', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await p.close()
    }
    check('页面无运行时错误', errors.length === 0, errors)
  } finally {
    await browser.close()
  }
  const failed = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
