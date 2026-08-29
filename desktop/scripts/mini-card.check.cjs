/**
 * Genesis Mini Card 真 Electron 契约检查。
 *
 * 钉住这次重设计最容易静默回退的几件事:
 * ① 窗口是 320x420 的独立卡片,不再被 3:4 固定比例绑死;
 * ② mini 不再挂 mobile 的双层顶栏 / push 抽屉,也不再 zoom 整个 feature 视图;
 * ③ 新对话空状态会为悬浮 composer 让位,二者不重叠;
 * ④ 标签/更多使用卡内 popover,不会变回覆盖大半窗口的 bottom sheet;
 * ⑤ 从主窗带 sessionId 打开时,Mini 复用原壳并定向到同一份正式会话;
 * ⑥ 亮暗主题都留一张真实 Electron 截图供人工复核;
 * ⑦ 切到 Amadeus 空间时 Vault 已恢复 —— mini 只挂主区 leaf,左栏那个唯一的 ensureAmadeusReady
 *    触发点永不挂载,漏了 MiniRoot 里的补引导就恒显「打开 Vault 文件夹」空态(2026-08-27 用户实报)。
 *
 * 跑:npm run build && npm run check:minicard
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.resolve(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function waitForMini(app) {
  for (let i = 0; i < 120; i++) {
    const hit = app.windows().find((win) => win.url().includes('window=mini'))
    if (hit) return hit
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Mini Card window did not open')
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js,先跑 npm run build')
    process.exit(1)
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-minicard-'))
  const lightShot = path.join(os.tmpdir(), `forsion-mini-card-light-${process.pid}.png`)
  const menuShot = path.join(os.tmpdir(), `forsion-mini-card-menu-${process.pid}.png`)
  const darkShot = path.join(os.tmpdir(), `forsion-mini-card-dark-${process.pid}.png`)
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${path.join(home, 'userdata')}`, ROOT],
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home, // ensureDefaultVault 按 homedir() 建默认工作区 —— 不隔离就写进用户真家目录
        TANGU_HOME: home,
        TANGU_BACKEND_URL: 'http://127.0.0.1:1',
        ELECTRON_ENABLE_LOGGING: '1',
      },
    })
    const mainWin = await app.firstWindow()
    await mainWin.waitForSelector('#root', { timeout: 30_000 })
    const targetSessionId = 'mini-card-check-session'
    const loadingSessionId = `${targetSessionId}-while-loading`
    await mainWin.evaluate(({ first, latest }) => {
      window.tangu?.openMini?.({ sessionId: first })
      window.tangu?.openMini?.({ sessionId: latest })
    }, { first: targetSessionId, latest: loadingSessionId })

    const mini = await waitForMini(app)
    await mini.waitForSelector('.mini-card-shell', { timeout: 30_000 })
    await mini.waitForSelector(`[data-chat-surface="chat"][data-session-id="${loadingSessionId}"]`, { timeout: 30_000 })
    await mini.waitForTimeout(350)

    const target = await mini.evaluate(() => ({
      query: new URLSearchParams(location.search).get('sessionId'),
      rendered: document.querySelector('.t2-chat-view')?.getAttribute('data-session-id') || null,
      surfaces: Array.from(document.querySelectorAll('.t2-chat-view')).map((el) => el.getAttribute('data-chat-surface')),
    }))
    check('带 sessionId 打开 Mini → 同一正式会话', target.query === targetSessionId && target.rendered === loadingSessionId && target.surfaces.includes('chat'), JSON.stringify(target))

    const updatedSessionId = `${targetSessionId}-updated`
    await mainWin.evaluate((sessionId) => window.tangu?.openMini?.({ sessionId }), updatedSessionId)
    await mini.waitForSelector(`[data-chat-surface="chat"][data-session-id="${updatedSessionId}"]`, { timeout: 30_000 })
    check('Mini 已显示时改目标 → 原窗口就地切会话', app.windows().filter((win) => win.url().includes('window=mini')).length === 1, `windows=${app.windows().length}`)

    const bounds = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('window=mini'))
      return win?.getBounds() || null
    })
    check('Mini Card 窗口 = 320x420', bounds?.width === 320 && bounds?.height === 420, bounds && `${bounds.width}x${bounds.height}`)

    const metrics = await mini.evaluate(() => {
      const box = (selector) => {
        const el = document.querySelector(selector)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
      }
      const shell = document.querySelector('.mini-card-shell')
      const main = document.querySelector('.mini-card-main')
      return {
        viewport: { width: innerWidth, height: innerHeight },
        chrome: box('.mini-card-chrome'),
        main: box('.mini-card-main'),
        empty: box('.t2-chat-col > .t2-empty'),
        composer: box('.t2-chat-col > .composer-anchor'),
        oldTopbars: document.querySelectorAll('.mb-topbar, .mini-ribbon').length,
        drawers: document.querySelectorAll('.mb-drawer').length,
        sheets: document.querySelectorAll('.mb-sheet').length,
        zoom: main ? getComputedStyle(main).zoom : '',
        overflowX: shell ? shell.scrollWidth - shell.clientWidth : -1,
        overflowY: shell ? shell.scrollHeight - shell.clientHeight : -1,
        radius: shell ? parseFloat(getComputedStyle(shell).borderRadius) : 0,
      }
    })
    check('只有单层紧凑 chrome', !!metrics.chrome && metrics.chrome.height <= 50 && metrics.oldTopbars === 0, JSON.stringify({ chrome: metrics.chrome, old: metrics.oldTopbars }))
    check('不挂 mobile push 抽屉与 bottom sheet', metrics.drawers === 0 && metrics.sheets === 0, `drawers=${metrics.drawers} sheets=${metrics.sheets}`)
    check('feature 内容不再整体 zoom', metrics.zoom === '1', `zoom=${metrics.zoom}`)
    check('壳层无横纵溢出', metrics.overflowX === 0 && metrics.overflowY === 0, `x=${metrics.overflowX} y=${metrics.overflowY}`)
    check('空状态为 composer 留位不重叠', !!metrics.empty && !!metrics.composer && metrics.empty.bottom <= metrics.composer.y, JSON.stringify({ empty: metrics.empty, composer: metrics.composer }))
    check('窗口圆角裁切存在', metrics.radius > 0, `radius=${metrics.radius}`)
    await mini.screenshot({ path: lightShot })

    await mini.locator('.mini-card-action').nth(1).click()
    await mini.waitForSelector('.mini-card-popover')
    await mini.waitForTimeout(220)
    const menu = await mini.locator('.mini-card-popover').evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, rows: el.querySelectorAll('.mini-card-row').length }
    })
    check('更多菜单是卡内 popover', menu.x >= 0 && menu.y >= 44 && menu.right <= 320 && menu.bottom <= 420 && menu.rows > 0, JSON.stringify(menu))
    await mini.screenshot({ path: menuShot })

    await mini.locator('.mini-card-action').nth(1).click()
    await mini.evaluate(() => {
      document.documentElement.classList.add('dark')
      document.documentElement.dataset.mode = 'dark'
    })
    await mini.waitForTimeout(100)
    await mini.screenshot({ path: darkShot })

    // ⑦ 切到 Amadeus 空间:vault 必须已恢复。空库也没关系 —— 空态按钮是「新建笔记」而非「打开 Vault 文件夹」。
    await mini.locator('.mini-card-space').click()
    await mini.locator('.mini-card-popover .mini-card-row', { hasText: 'Amadeus' }).first().click()
    await mini.waitForSelector('[data-view="amadeus-editor"]', { timeout: 30_000 })
    await mini.waitForTimeout(1200)
    const amadeus = await mini.evaluate(() => ({
      welcome: document.querySelector('.amx-welcome-sub')?.textContent || '',
      btn: document.querySelector('.amx-welcome-btn')?.textContent || '',
      editor: !!document.querySelector('.amx-pane'),
    }))
    check('Amadeus 空间的 Vault 已引导(非「打开 Vault」空态)', amadeus.editor && !/打开 Vault/.test(amadeus.btn), JSON.stringify(amadeus))

    console.log(`SCREENSHOT  light ${lightShot}`)
    console.log(`SCREENSHOT  menu  ${menuShot}`)
    console.log(`SCREENSHOT  dark  ${darkShot}`)
  } finally {
    if (app) await app.close().catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
  }

  const bad = results.filter((item) => !item.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
