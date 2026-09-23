/** Real Electron contract for the sixth panel surface: native window behavior + rendered settings. */
const fs = require('fs'), os = require('os'), path = require('path')
const { spawn } = require('child_process')
const { _electron: electron, chromium } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-floating-panel-'))
const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`) }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const WEB_ORIGIN = 'http://127.0.0.1:5199'

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(cache).filter((dir) => dir.startsWith('chromium-')).sort().reverse()
  for (const dir of dirs) for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
    const candidate = path.join(cache, dir, 'chrome-mac-arm64', app)
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error('Chromium not found; set CHROMIUM_EXE')
}

async function checkWeb() {
  const vite = spawn('npx', ['vite', 'frontend', '--host', '127.0.0.1', '--port', '5199', '--strictPort'], { cwd: ROOT, stdio: 'ignore' })
  let browser
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(WEB_ORIGIN)).ok) break } catch { /* starting */ }
      await pause(100)
    }
    browser = await chromium.launch({ executablePath: findChromium(), headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-GB' })
    await page.goto(WEB_ORIGIN, { waitUntil: 'networkidle' })
    await page.evaluate(async () => {
      const { useApp } = await import('/src/stores/appStore.ts')
      useApp.getState().setOnboarding(false)
      useApp.getState().openSettings('general')
    })
    await page.locator('.floating-panel-window .settings-page').waitFor({ timeout: 15000 })
    await page.waitForTimeout(500)
    await page.evaluate(() => document.getAnimations().forEach((animation) => {
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish()
    }))
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector('.floating-panel-window').getBoundingClientRect()
      const shell = document.querySelector('.shell-host')
      return { left: panel.left, right: innerWidth - panel.right, width: panel.width,
        shellVisible: getComputedStyle(shell).visibility !== 'hidden', appRegion: getComputedStyle(document.querySelector('.floating-panel-layer')).webkitAppRegion }
    })
    check('Web uses a centered non-fullscreen Floating panel', geometry.left > 20 && geometry.right > 20 && geometry.width < 1200, JSON.stringify(geometry))
    check('Web keeps the main workspace visible and panel non-draggable', geometry.shellVisible && geometry.appRegion === 'no-drag')
    // web 的设置是居中浮层:面板动作画在面板提示条里;app 级 toast(连接 / 会话列表失败那类)绝不能进这条
    // (那是 Electron 浮窗里会与主窗重复的那一类),它走右上角通知卡 —— 浮层开着也照弹(09-21 起只有首启引导让位)。
    // 两步分开查:提示条是「后到覆盖先到」,混在一起发的话,误进提示条的 app 级那条会被面板那条顶掉而假绿(Codex 评审)。
    const stripTexts = () => page.evaluate(() => [...document.querySelectorAll('.floating-panel-window [data-panel-notice]')].map((el) => el.textContent))
    await page.evaluate(async () => {
      const { useApp } = await import('/src/stores/appStore.ts')
      useApp.getState().toast('app-level probe', true)
    })
    await page.waitForTimeout(150)
    const afterApp = await stripTexts()
    const appCard = await page.locator('.ntf', { hasText: 'app-level probe' }).count()
    check('Web: an app-level toast never enters the panel strip and still shows as a card over the panel', afterApp.length === 0 && appCard === 1, JSON.stringify({ afterApp, appCard }))
    await page.evaluate(async () => {
      const { panelToast } = await import('/src/components/PanelNotice.tsx')
      panelToast('panel probe', true)
    })
    await page.waitForTimeout(150)
    const afterPanel = await stripTexts()
    check('Web: panel notices render in the panel strip only', afterPanel.length === 1 && afterPanel[0] === 'panel probe'
      && await page.locator('.ntf', { hasText: 'panel probe' }).count() === 0, JSON.stringify(afterPanel))
    // 点真按钮:web 没有 requestMainAction,「发送测试通知」原地发 —— 卡片必须在设置浮层开着时就看得见。
    // SettingsModal 只在挂载时读 initialTab,浮层开着再 openSettings 不会换页 → 走侧栏导航(也就是用户的点法)。
    await page.locator('.floating-panel-window .settings-nav').getByRole('button', { name: 'Notifications', exact: true }).click({ timeout: 15000 })
    await page.locator('.floating-panel-window').getByRole('button', { name: 'Send test notification', exact: true }).click({ timeout: 15000 })
    const webCard = page.locator('.ntf', { hasText: 'This is a test notification' })
    await webCard.first().waitFor({ timeout: 5000 }).catch(() => {})
    // 同主窗那条:卡片从右侧屏外滑进来,DOM 里有 ≠ 看得见,等它落进视口(截图也就在那之后)。
    let webBox = null
    for (let i = 0; i < 60 && await webCard.count(); i++) {
      webBox = await webCard.first().evaluate((el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth } })
      if (webBox.left >= 0 && webBox.right <= webBox.vw) break
      await pause(50)
    }
    check('Web: Send test notification shows the real card while the settings overlay is open',
      await webCard.count() === 1 && !!webBox && webBox.left >= 0 && webBox.right <= webBox.vw && await page.locator('.floating-panel-window').count() === 1,
      `cards=${await webCard.count()} box=${JSON.stringify(webBox)}`)
    const shot = path.join(temp, 'floating-settings-web.png')
    await page.screenshot({ path: shot })
    console.log(`WEB_SCREENSHOT ${shot}`)
  } finally {
    if (browser) await browser.close()
    vite.kill('SIGTERM')
  }
}

async function main() {
  const userData = path.join(temp, 'userdata')
  fs.mkdirSync(userData + '-dev', { recursive: true })
  // 「重载插件」的应答可切:先 500(验错误条常驻),再成功(验成功条自动消失)。
  let rescanFail = true
  const stub = await startStubEngine({ sessions: [], handle: ({ path: p }) => p !== '/agent/plugins/rescan' ? undefined
    : rescanFail ? { __code: 500, body: { detail: 'stub rescan failure' } } : { ok: true, addedIds: [], needsRestart: false, plugins: [] } })
  fs.writeFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'floating-test-token' }))
  // 用户 Space 夹具(TANGU_HOME=temp → spaces 在 temp/spaces):验「在设置浮窗里卸载,主窗 ribbon 也撤掉」。
  const probeSpaceDir = path.join(temp, 'spaces', 'probe-space')
  fs.mkdirSync(probeSpaceDir, { recursive: true })
  fs.writeFileSync(path.join(probeSpaceDir, 'space.json'), JSON.stringify({ id: 'probe-space', name: { zh: '探针空间', en: 'Probe space' }, layout: { main: [{ type: 'chat' }] } }))
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=en-GB', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: temp, TANGU_BACKEND_URL: stub.url, PI_CU_SOCKET_PATH: path.join(temp, 'bridge.sock') } })
    const main = await app.firstWindow()
    await main.waitForSelector('.shell-host', { timeout: 30000, state: 'attached' })
    // 原来立即找精确名 'Skip',从没点中过 —— 主窗一直停在引导页(09-21 测试通知那条断言才把它暴露出来),坑见 helper。
    check('main window left onboarding before the panel checks', await skipOnboarding(main))
    await main.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'about' } }))
    let floating
    for (let i = 0; i < 120; i++) {
      floating = app.windows().find((page) => page.url().includes('window=floating'))
      if (floating) break
      await pause(50)
    }
    if (!floating) throw new Error('Floating window missing')
    await floating.waitForSelector('.floating-native-root .settings-page', { timeout: 30000 })
    check('Floating window never mounts the Forsion startup splash', await floating.locator('#tangu-splash').count() === 0)
    await floating.waitForTimeout(300)
    check('settings renders in a dedicated Floating window', app.windows().filter((page) => page.url().includes('window=floating')).length === 1)
    const native = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('window=floating'))
      return { minimizable: win.isMinimizable(), closable: win.isClosable(), resizable: win.isResizable(), parent: !!win.getParentWindow() }
    })
    check('native window is movable-family, minimizable, closable and resizable', native.minimizable && native.closable && native.resizable && native.parent, JSON.stringify(native))
    await main.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'plugins' } }))
    await pause(300)
    check('opening the same panel id reuses its native window', app.windows().filter((page) => page.url().includes('window=floating')).length === 1)
    // 外观跨窗同步:设置住在独立渲染进程里,换肤必须传到主窗(2.11.1 实报:只有设置窗自己变色)。
    // 走真 UI 点击 —— 内置包里没有 vite,import('/src/...') 那套只在 web 分支成立。
    await main.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'theme' } }))
    await floating.locator('.settings-theme-palette .skin-row').first().waitFor({ timeout: 15000 })
    const skinOf = (page) => page.evaluate(() => document.documentElement.dataset.skin)
    const before = await skinOf(main)
    const chips = floating.locator('.settings-theme-palette .skin-row').first().locator('.skin-chip')
    // 主题色轴的第三格(teal);挑一个铁定不同于缺省 cream 的目标,免得「本来就对」混成假绿。
    await chips.nth(2).click()
    let after = before
    for (let i = 0; i < 60; i++) {
      after = await skinOf(main)
      if (after !== before) break
      await pause(50)
    }
    check('changing the accent in the Floating settings window repaints the main window',
      before === 'cream' && after === 'teal', `main ${before} -> ${after}`)
    check('the settings window itself followed the click', await skinOf(floating) === 'teal')
    // 换主题色 = 成就「theme-change」(goal 1)跨线。track() 跑在浮窗渲染进程里;成就弹窗只有主窗挂 —— 以前排进浮窗
    // 自己的队列永远不播。主窗要自己接到这次解锁并弹出来。
    const mainAchToast = async () => { for (let i = 0; i < 80; i++) { if (await main.locator('.ach-toast').count()) return true; await pause(50) } return false }
    check('an achievement unlocked inside the Floating settings (theme change) toasts in the main window', await mainAchToast(),
      `mainToasts=${await main.locator('.ach-toast').count()} floatingToasts=${await floating.locator('.ach-toast').count()}`)

    // 同一条广播的另一半(prefs):字体 / 缩放 / 丝滑光标 / 界面语言。各自有自己的 applier,
    // 所以要一个一个真点过去 —— 只验主题色会漏掉它们(用户 09-20 的原话:你只修一个算什么)。
    const uiOf = (page) => page.evaluate(() => ({
      font: (document.getElementById('forsion-ui-font')?.textContent || '').length,
      caret: document.documentElement.classList.contains('sc-on'),
      zoom: document.documentElement.style.getPropertyValue('--uiz') || '',
      lang: document.documentElement.lang,
    }))
    const settled = async (page, want) => {
      for (let i = 0; i < 60; i++) {
        const now = await uiOf(page)
        if (want(now)) return now
        await pause(50)
      }
      return uiOf(page)
    }
    const baseline = await uiOf(main)
    await floating.locator('.settings-theme-fonts select').first().selectOption({ index: 1 })
    const afterFont = await settled(main, (v) => v.font > 0)
    check('界面字体跟到主窗', baseline.font === 0 && afterFont.font > 0, JSON.stringify({ before: baseline.font, after: afterFont.font }))

    await floating.locator('.settings-theme-behavior button[role="switch"]').first().click()
    const afterCaret = await settled(main, (v) => v.caret !== baseline.caret)
    check('丝滑光标跟到主窗', afterCaret.caret !== baseline.caret, `${baseline.caret} -> ${afterCaret.caret}`)

    await floating.locator('.settings-zoom-presets button').nth(2).click()
    const afterZoom = await settled(main, (v) => v.zoom === '1.2')
    check('界面缩放跟到主窗', baseline.zoom === '' && afterZoom.zoom === '1.2', `'${baseline.zoom}' -> '${afterZoom.zoom}'`)
    // 调回 100%:既验反向(删键→回端默认),也让浮窗恢复原尺寸再去点语言开关。
    await floating.locator('.settings-zoom-presets button').nth(1).click()
    const backZoom = await settled(main, (v) => v.zoom === '')
    check('缩放调回 100% 也跟得到(删键回默认)', afterZoom.zoom === '1.2' && backZoom.zoom === '', `'1.2' -> '${backZoom.zoom}'`)

    // 设置自己的提示条(09-21):浮窗不挂 NotificationHost,插件装卸 / 重扫 / Space 卸载等结果以前全部静默蒸发。
    // 断言一律打在浮窗 page 上 —— 那才是用户看着的地方。走真 UI:引擎插件页的「重载插件」。
    await main.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'amadeus-plugins' } }))
    await floating.locator('.settings-nav-subitem', { hasText: 'Tangu engine plugins' }).click({ timeout: 15000 })
    const rescan = floating.getByRole('button', { name: 'Reload plugins', exact: true })
    const notice = floating.locator('[data-panel-notice]')
    const noticeState = async () => (await notice.count())
      ? notice.evaluate((el) => ({ text: el.textContent || '', error: el.classList.contains('is-error'), role: el.getAttribute('role') }))
      : null
    await rescan.click({ timeout: 15000 })
    await notice.waitFor({ timeout: 5000 }).catch(() => {})
    const failShown = await noticeState()
    check('settings action failure shows in the Floating window\'s own notice strip',
      !!failShown && failShown.error && failShown.role === 'alert' && failShown.text.includes('stub rescan failure'), JSON.stringify(failShown))
    await pause(4500)
    check('the error strip stays until dismissed (no auto-hide)', (await noticeState())?.error === true)
    const noticeShot = path.join(temp, 'floating-settings-notice.png')
    await floating.screenshot({ path: noticeShot })
    console.log(`NOTICE_SCREENSHOT ${noticeShot}`)
    const closable = await notice.count() === 1
    if (closable) await notice.locator('.mk-notice-close').click()
    check('the close button dismisses the strip', closable && await notice.count() === 0)
    rescanFail = false
    await rescan.click()
    await notice.waitFor({ timeout: 5000 }).catch(() => {})
    const okShown = await noticeState()
    check('settings action success shows in the strip', !!okShown && !okShown.error && okShown.text.includes('no new plugins'), JSON.stringify(okShown))
    const okShot = path.join(temp, 'floating-settings-notice-ok.png')
    await floating.screenshot({ path: okShot }).then(() => console.log(`NOTICE_OK_SCREENSHOT ${okShot}`)).catch(() => {})
    await notice.waitFor({ state: 'detached', timeout: 6000 }).catch(() => {})
    check('the success strip hides itself', !!okShown && await notice.count() === 0)
    // 「发送测试通知」预览的是主窗那张真通知卡:点在设置浮窗里,卡片要出现在主窗(浮窗本就不挂 NotificationHost)。
    await main.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'notifications' } }))
    await floating.getByRole('button', { name: 'Send test notification', exact: true }).click({ timeout: 15000 })
    const mainCard = main.locator('.ntf', { hasText: 'This is a test notification' })
    await mainCard.first().waitFor({ timeout: 5000 }).catch(() => {})
    check('Send test notification in the Floating settings pops the card in the main window',
      await mainCard.count() === 1 && await floating.locator('.ntf').count() === 0,
      `main=${await mainCard.count()} floating=${await floating.locator('.ntf').count()} mainHost=${await main.locator('.ntf-wrap').count()} shell=${await main.evaluate(() => getComputedStyle(document.querySelector('.shell-host')).visibility)}`)
    // 卡片是从右侧屏外滑进来的(framer-motion):DOM 里有 ≠ 用户看得见,要等它真落进主窗视口。
    let cardBox = null
    for (let i = 0; i < 60 && await mainCard.count(); i++) { // 先判存在:locator.evaluate 找不到元素会干等 30s 默认超时
      cardBox = await mainCard.first().evaluate((el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, hidden: document.visibilityState } }).catch(() => null)
      if (cardBox && cardBox.left >= 0 && cardBox.right <= cardBox.vw) break
      await pause(50)
    }
    check('the test card actually slides into the main window viewport', !!cardBox && cardBox.left >= 0 && cardBox.right <= cardBox.vw, JSON.stringify(cardBox))
    // 主窗此刻在设置浮窗背后:没有动画在跑时 captureScreenshot 可能等不到新帧(负对照里实测挂住过),只在卡片真出来时截。
    if (cardBox) {
      const mainShot = path.join(temp, 'main-after-test-notification.png')
      await main.screenshot({ path: mainShot, timeout: 10000 }).then(() => console.log(`MAIN_SCREENSHOT ${mainShot}`)).catch(() => {})
    }

    // ── 09-21:设置 / 反馈浮窗里「作用在工作台上」的动作。浮窗 = 独立渲染进程 + 独立 store,动作的效果以前全落在
    // 浮窗自己身上,主窗纹丝不动。断言一律打在主窗 —— 那才是动作的目标。
    const settingsPage = async (tab) => { // 浮窗可能被「关窗类」动作关掉了:活着就复用(不会有 window 事件),否则等新窗
      const live = app.windows().find((p) => !p.isClosed() && p.url().includes('window=floating') && p.url().includes('id=settings'))
      const opened = live ? null : app.waitForEvent('window', { timeout: 15000 })
      await main.evaluate((t) => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: t } }), tab)
      const page = live || await opened
      await page.waitForSelector('.floating-native-root .settings-page', { timeout: 30000 })
      return page
    }
    const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await pause(50) } return !!(await fn()) }

    // ① 开发者选项「触发成就弹窗」:每按一次都要在主窗重放(它是调成就动画用的)。
    await main.evaluate(() => localStorage.setItem('forsion_tangu_dev_mode', '1'))
    floating = await settingsPage('developer')
    await until(async () => (await main.locator('.ach-toast').count()) === 0, 8000) // 等上一条(theme-change)播完,别混进来
    await floating.getByRole('button', { name: 'Fire achievement toast', exact: true }).click({ timeout: 15000 })
    check('Fire achievement toast (developer options) plays in the main window',
      await until(async () => (await main.locator('.ach-toast').count()) > 0), `mainToasts=${await main.locator('.ach-toast').count()}`)

    // ② 插件详情页的命令按钮:命令跑在调用它的渲染进程里 —— 在浮窗里点「统计字数」数的是浮窗的(空)当前页,
    // 结果吐司(.amx-toast)也只有主窗渲染 → 点了什么都看不见。卫星窗里不再给这排按钮(命令照旧在主窗 ⌘K 里)。
    floating = await settingsPage('amadeus-plugins')
    await floating.locator('[data-plugin-id="word-count"]').first().click({ timeout: 15000 })
    await floating.locator('[data-plugin-detail="word-count"]').waitFor({ timeout: 10000 })
    const countBtn = floating.getByRole('button', { name: 'Count words', exact: true })
    const countBtns = await countBtn.count()
    let toastsAfterRun = null
    if (countBtns) { await countBtn.first().click(); await pause(600); toastsAfterRun = { main: await main.locator('.amx-toast').count(), floating: await floating.locator('.amx-toast').count() } }
    check('the Floating plugin detail page offers no command buttons that would run in the wrong window', countBtns === 0, JSON.stringify({ countBtns, toastsAfterRun }))

    // ③ 卸载用户 Space:磁盘目录删掉之外,主窗的 ribbon 图标也要跟着撤(以前只撤了浮窗自己的,主窗要重启)。
    // 新装的用户 Space 不占顶栏槽位,进的是 ribbon「更多」浮层 —— 两处都看。
    // 「更多」浮层是 mouseenter 开的(不是 click):指针还停在按钮上时再悬停不会重开,读到空列表会被当成「已撤掉」
    // 而假绿(实测踩过)→ 每次先把指针挪开再悬停;读不到行返回 null(≠ false)。
    const flyRows = main.locator('.rb-fly-row')
    const mainRibbonHasProbe = async () => {
      if (await main.locator('.rb-slot[data-id="space:probe-space"]').count()) return true
      await main.mouse.move(600, 400)
      await main.locator('.rb-more').first().hover()
      if (!(await until(async () => (await flyRows.count()) > 0, 2000))) return null // 浮层里恒有 Automation / Muse 等行
      const rows = await flyRows.allTextContents()
      await main.keyboard.press('Escape')
      await main.mouse.move(600, 400)
      await until(async () => (await flyRows.count()) === 0, 1000)
      return rows.some((t) => t.includes('Probe space'))
    }
    const hadRibbon = await until(async () => (await mainRibbonHasProbe()) === true, 10000)
    floating = await settingsPage('spaces')
    floating.once('dialog', (d) => void d.accept())
    await floating.locator('.settings-collection-row', { hasText: 'probe-space' }).getByRole('button', { name: 'Uninstall', exact: true }).click({ timeout: 15000 })
    const diskGone = await until(async () => !fs.existsSync(probeSpaceDir))
    check('uninstalling a user Space in the Floating settings also removes it from the main window ribbon',
      hadRibbon && diskGone && await until(async () => (await mainRibbonHasProbe()) === false),
      JSON.stringify({ hadRibbon, diskGone, stillInMainRibbon: await mainRibbonHasProbe() }))

    // ④ 反馈「让 Tangu 帮我诊断」:草稿要进主窗的聊天输入框(以前 setPendingDraft / openView 都落在反馈浮窗里,窗一关就没了)。
    const feedbackOpened = app.waitForEvent('window', { timeout: 15000 })
    await main.evaluate(() => window.tangu.openFloatingPanel({ id: 'feedback', title: 'Feedback', builtin: 'feedback' }))
    const feedback = await feedbackOpened
    await feedback.locator('#feedback-description').fill('probe: the sidebar froze after sync', { timeout: 30000 })
    await feedback.locator('.feedback-diagnose').click()
    const draftIn = () => main.locator('.t2c-ta').first().inputValue().catch(() => '')
    check('Diagnose in chat puts the draft into the main window composer',
      await until(async () => (await draftIn()).includes('the sidebar froze after sync')), JSON.stringify((await draftIn()).slice(0, 80)))
    // chat-draft 会把主窗提到前面(用户要去那儿看草稿)→ 此刻截主窗有新帧;仍带超时兜底(主窗在后面时会挂住)。
    const draftShot = path.join(temp, 'main-after-diagnose.png')
    await main.screenshot({ path: draftShot, timeout: 10000 }).then(() => console.log(`DRAFT_SCREENSHOT ${draftShot}`)).catch(() => {})

    // ⑤ 高级「恢复默认布局」:先在主窗多开一个标签页,再从浮窗恢复 —— 主窗的标签数要回去(浮窗自己没有 Dockview,
    // 以前 resetLayout 在那边第一句 `if (!api) return` 就退了,什么也没发生)。放最后:它会关掉设置窗。
    const tabCount = () => main.locator('.dv-tab').count()
    const tabsBefore = await tabCount()
    await main.locator('.dv-new-tab').first().click()
    const added = await until(async () => (await tabCount()) > tabsBefore)
    floating = await settingsPage('advanced')
    await floating.locator('.settings-nav-subitem', { hasText: 'UI & sessions' }).click({ timeout: 15000 })
    await floating.getByRole('button', { name: 'Restore default layout', exact: true }).click({ timeout: 15000 })
    check('Restore default layout in the Floating settings resets the main window layout',
      added && await until(async () => (await tabCount()) === tabsBefore), JSON.stringify({ tabsBefore, added, after: await tabCount() }))

    floating = await settingsPage('about')
    await floating.locator('.locale-seg button').first().waitFor({ timeout: 15000 })
    await floating.locator('.locale-seg button').first().click() // 中文
    const afterLocale = await settled(main, (v) => v.lang === 'zh-CN')
    check('界面语言跟到主窗', baseline.lang === 'en' && afterLocale.lang === 'zh-CN', `${baseline.lang} -> ${afterLocale.lang}`)

    const shot = path.join(temp, 'floating-settings.png')
    await floating.screenshot({ path: shot })
    check('panel has no viewport overflow', await floating.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth && document.documentElement.scrollHeight === document.documentElement.clientHeight))
    console.log(`SCREENSHOT ${shot}`)
  } finally {
    if (app) await app.close().catch(() => {})
    await stub.close()
  }
  await checkWeb()
  console.log(`${results.filter(Boolean).length}/${results.length} passed`)
  if (results.some((ok) => !ok)) process.exitCode = 1
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
