/** Chat View 窄栏回归：真 Electron / 真 ChatView、引擎与 Agent 选择、草稿增高、zoom、中英与明暗。
 * npm run build && npm run check:chatlayout
 * 使用临时 userData / TANGU_HOME / Vault 与假后端，不读写用户会话和笔记。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.resolve(__dirname, '..')
const agents = Array.from({ length: 28 }, (_, i) => ({
  slug: i ? `agent-${i}` : 'xyra', name: i ? `Research assistant ${i}` : 'Xyra',
  description: i ? 'Analyze project files and explain the results' : 'General assistant',
  createdBy: 'user',
}))
const engines = ['claude', 'codex', 'gemini'].map((id) => ({ id, name: id, available: true }))
let checks = 0
function check(name, ok, detail) {
  assert.ok(ok, `${name}: ${JSON.stringify(detail)}`)
  console.log(`PASS ${name}`)
  checks++
}

async function main() {
  assert.ok(fs.existsSync(path.join(ROOT, 'out/main/main.js')), '先运行 npm run build')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-chat-layout-'))
  const userdata = path.join(home, 'userdata')
  const vault = path.join(home, 'vault')
  fs.mkdirSync(userdata)
  fs.mkdirSync(vault)
  fs.writeFileSync(path.join(vault, 'Layout.md'), '# Layout verification\n')
  fs.writeFileSync(path.join(userdata, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  const stub = await startStubEngine({ agents, engines })
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
    })
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1050))
    await win.waitForSelector('#root')
    await win.evaluate(() => localStorage.setItem('forsion_default_space', 'tangu'))
    await win.reload({ waitUntil: 'domcontentloaded' })
    for (const label of ['跳过引导', 'Skip']) {
      const button = win.locator(`button:text-is("${label}")`).first()
      if (await button.isVisible().catch(() => false)) { await button.click(); break }
    }
    const view = win.locator('.t2-chat-view').first()
    await view.waitFor({ timeout: 30000 })
    await view.locator('.agent-picker .engine-pill').first().waitFor({ state: 'attached', timeout: 30000 })
    // 真 Electron 会沿用系统指针位置；缩宽恰好把 pill 移到指针下时会展开名称，改变内容宽度。
    await win.mouse.move(1, 1)
    await win.waitForTimeout(700)

    const resize = async (width, height, zoom = 1) => {
      await view.evaluate((el, size) => {
        el.style.flex = 'none'
        el.style.width = `${size.width}px`
        el.style.height = `${size.height}px`
        el.style.zoom = String(size.zoom)
      }, { width, height, zoom })
      await win.waitForTimeout(180)
    }
    const geometry = () => view.evaluate((el) => {
      const col = el.querySelector('.t2-chat-col')
      const empty = col.querySelector(':scope > .t2-empty')
      const composer = col.querySelector(':scope > .composer-anchor')
      const rect = (node) => {
        const r = node.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }
      }
      return {
        col: rect(col), empty: rect(empty), composer: rect(composer),
        emptyVisible: getComputedStyle(empty).visibility !== 'hidden',
        density: empty.dataset.density, zoom: el.currentCSSZoom || 1,
        composerMeasured: parseFloat(getComputedStyle(col).getPropertyValue('--t2-composer-h')),
        streamPadding: parseFloat(getComputedStyle(col.querySelector('.t2-stream-inner')).paddingBottom),
        controls: [...el.querySelectorAll('.compact-chat-picker, .t2c-send, .t2c-stop, .t2c-row > *')]
          .filter((node) => node.getClientRects().length).map(rect),
        compact: [...el.querySelectorAll('.compact-chat-picker')].filter((node) => node.getClientRects().length).map(rect),
      }
    })
    const safe = async (name) => {
      const g = await geometry()
      check(`${name}: 欢迎区与输入区不重叠`, !g.emptyVisible || g.empty.bottom + 23 * g.zoom <= g.composer.top, g)
      check(`${name}: 控件不超出聊天列`, g.controls.every((r) => r.left >= g.col.left - 1 && r.right <= g.col.right + 1), g)
      check(`${name}: 高度测量不重复缩放`, Math.abs(g.composerMeasured * g.zoom - g.composer.height) < 2, g)
      check(`${name}: 消息流保留输入区高度`, g.streamPadding * g.zoom >= g.composer.height, g)
      return g
    }

    await resize(800, 820)
    const wide = await safe('宽栏')
    check('宽栏仍在 View 中心', wide.emptyVisible && Math.abs((wide.empty.top + wide.empty.bottom - wide.col.top - wide.col.bottom) / 2) < 2, wide)
    check('宽栏保留胶囊', wide.compact.length === 0, wide)
    const more = await view.locator('.agent-picker').evaluate((el) => {
      const scroll = el.querySelector('.engine-picker-scroll')
      const button = el.querySelector('.engine-picker-more')
      scroll.scrollLeft = scroll.scrollWidth
      return { scrollRight: scroll.getBoundingClientRect().right, moreLeft: button?.getBoundingClientRect().left }
    })
    check('更多按钮不盖住选项', more.moreLeft >= more.scrollRight, more)
    const fitsWidth = await view.locator('.agent-picker .engine-picker-scroll').evaluate((el) => el.scrollWidth + 16)
    await resize(fitsWidth, 820)
    const fit = await view.locator('.agent-picker .engine-picker-scroll').evaluate((el) => ({
      content: el.scrollWidth, viewport: el.clientWidth, bar: el.parentElement.clientWidth,
      col: el.closest('.t2-chat-col').clientWidth, padding: getComputedStyle(el.parentElement).padding,
    }))
    check('刚好容纳全部选项时收起更多按钮', await view.locator('.agent-picker .engine-picker-more').count() === 0, { fitsWidth, ...fit })

    await resize(420, 720)
    const narrow = await safe('窄栏')
    check('窄栏两个带名称的入口并排', narrow.compact.length === 2 && Math.abs(narrow.compact[0].top - narrow.compact[1].top) < 1, narrow)
    await view.locator('.agent-picker select').selectOption('agent-17')
    check('选择 Agent 更新当前名称', (await view.locator('.agent-picker .compact-chat-picker-name').textContent()) === agents[17].name)
    await view.locator('.engine-picker:not(.agent-picker) select').selectOption('codex')
    await win.waitForTimeout(150)
    check('外部引擎隐藏 Tangu Agent 入口', await view.locator('.agent-picker').count() === 0)
    await view.locator('.engine-picker select').selectOption('')
    await view.locator('.agent-picker select').waitFor()
    await view.locator('.agent-picker select').selectOption('xyra')
    await view.screenshot({ path: path.join(home, 'narrow.png') })

    await resize(320, 620)
    const small = await safe('极窄栏')
    check('极窄栏入口上下排列', small.compact.length === 2 && small.compact[1].top >= small.compact[0].bottom + 5, small)
    await view.screenshot({ path: path.join(home, 'small.png') })
    await resize(420, 360)
    await safe('矮窗口')
    await view.locator('.t2c-ta').fill('A draft with multiple lines\n'.repeat(8))
    await win.waitForTimeout(120)
    await safe('多行草稿')
    await view.locator('.t2c-ta').fill('')
    await resize(420, 720, 1.25)
    await safe('界面缩放 125%')
    await resize(420, 720)
    await win.keyboard.press('Meta+k')
    await win.locator('.cmd-input').fill('切换明暗模式')
    await win.locator('.cmd-item', { hasText: '切换明暗模式' }).click()
    await win.waitForTimeout(400)
    await view.screenshot({ path: path.join(home, 'narrow-dark.png') })
    await win.keyboard.press('Meta+k')
    await win.locator('.cmd-input').fill('切换语言')
    await win.locator('.cmd-item', { hasText: '切换语言' }).click()
    await win.waitForTimeout(180)
    await resize(420, 720)
    await safe('英文窄栏')
    check('英文引擎入口已翻译', await view.locator('.engine-picker:not(.agent-picker) select').getAttribute('aria-label') === 'Engine')
    await view.screenshot({ path: path.join(home, 'narrow-en.png') })

    await win.evaluate(() => window.tangu.openMini({}))
    let mini
    for (let i = 0; i < 100 && !mini; i++) {
      mini = app.windows().find((page) => page.url().includes('window=mini'))
      if (!mini) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(mini, 'Mini window did not open')
    await mini.locator('.t2-chat-col > .t2-empty').waitFor({ state: 'attached', timeout: 30000 })
    await mini.locator('#tangu-splash').waitFor({ state: 'detached', timeout: 10000 })
    await mini.waitForTimeout(200)
    const miniGeometry = await mini.locator('.t2-chat-col').evaluate((col) => {
      const empty = col.querySelector(':scope > .t2-empty')
      const composer = col.querySelector(':scope > .composer-anchor')
      return { visible: getComputedStyle(empty).visibility !== 'hidden', bottom: empty.getBoundingClientRect().bottom, top: composer.getBoundingClientRect().top,
        colHeight: col.clientHeight, colTop: col.getBoundingClientRect().top, composerHeight: composer.offsetHeight, composerTop: composer.offsetTop,
        emptyHeight: empty.offsetHeight, emptyTop: empty.offsetTop, inline: empty.style.cssText, density: empty.dataset.density }
    })
    await mini.screenshot({ path: path.join(home, 'mini.png') })
    check('Mini 卡片欢迎区可读且不重叠', miniGeometry.visible && miniGeometry.bottom <= miniGeometry.top - 23, miniGeometry)
    console.log(`${checks}/${checks} passed; screenshots: ${home}`)
  } catch (error) {
    const win = app?.windows()[0]
    if (win) {
      await win.screenshot({ path: path.join(home, 'failure.png') }).catch(() => {})
      console.error('Failure screenshot:', path.join(home, 'failure.png'))
      console.error((await win.locator('body').innerText().catch(() => '')).slice(0, 1600))
    }
    throw error
  } finally {
    await app?.close()
    await stub.close()
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
