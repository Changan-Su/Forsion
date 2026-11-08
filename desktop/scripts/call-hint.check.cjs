/**
 * 通话键首次提示(宿主上手提示,2026-11-07 LCL 表面规范第一期)的真 Electron 仪器。
 * 原来 views/chat2/CallHint.tsx 自己画一个气泡;现在由宿主 amadeus/plugins/hostTips.ts 登记成上手提示,
 * 圈住 Composer2 通话键上的 data-guide-anchor="chat-call",和插件提示同一套节奏。
 *
 * 隔离 profile 里存一个通话模型(realtimeModelId),主页输入框空着时发送键就是通话键。没登录、不是云端模型 → 直连文案。
 * 断言:
 *  A 圈注出现,圈住的是通话键;小卡标题 / 直连正文(中文)
 *  B 小卡左边是「换个音色」(额外动作占「不再提示」的位置),右边「知道了」
 *  C 输入框里打了字(发送键不再是通话键)→ 圈注收掉、不记看过
 *  D 重开应用再出(一个视图打开一次最多一条);点「换个音色」→ 收掉、记成看过、设置打开
 *  E 记成看过后重开不再出
 * ⚠ 负对照靶子:把 hostTips.ts 里的 registerHostTip 注掉,A 必须红。
 *
 * 用法:npm run build 之后 `node scripts/call-hint.check.cjs`(台架上锁见仓根 .claude/hooks/devlock.cjs)。
 * SHOTS=<目录> 时拍浅色、深色各一张。
 */
const fs = require('fs'), os = require('os'), path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-call-hint-'))
const SHOTS = process.env.SHOTS
const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`) }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(fn, timeoutMs = 10000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) { if (await fn()) return true; await pause(150) }
  return false
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(2) }
  const home = path.join(temp, 'home')
  fs.mkdirSync(home, { recursive: true })
  const userData = path.join(temp, 'userdata')
  fs.mkdirSync(userData + '-dev', { recursive: true })
  const stub = await startStubEngine({ sessions: [] })
  fs.writeFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'call-hint-test-token', realtimeModelId: 'test-realtime' }))
  let app, win
  // 重开 = 关掉整个应用再起(同一份 profile);location.reload() 在 Electron 里会卡住(宿主有自己的整窗重载桥)
  const launch = async (first) => {
    if (app) await app.close().catch(() => {})
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, PI_CU_SOCKET_PATH: path.join(temp, 'bridge.sock') } })
    win = await app.firstWindow()
    await win.waitForSelector('.shell-host', { timeout: 30000, state: 'attached' })
    const left = await skipOnboarding(win, first ? 15000 : 3000)
    await win.evaluate(() => { for (const b of document.querySelectorAll('.dialog-actions button')) b.click() }).catch(() => {})
    return left
  }
  const call = () => win.locator('[data-guide-anchor="chat-call"]')
  const ring = () => win.locator('.guide-spot-ring')
  const card = () => win.locator('.guide-spot-card')
  const seen = () => win.evaluate(() => localStorage.getItem('guide.forsion.voice-call'))
  const shoot = async (name) => {
    if (!SHOTS) return
    fs.mkdirSync(SHOTS, { recursive: true })
    for (const dark of [false, true]) {
      await win.evaluate((d) => { document.documentElement.dataset.mode = d ? 'dark' : 'light'; document.documentElement.classList.toggle('dark', d) }, dark)
      await pause(300)
      await win.screenshot({ path: path.join(SHOTS, `${name}-${dark ? 'dark' : 'light'}.png`) })
    }
    await win.evaluate(() => { document.documentElement.dataset.mode = 'light'; document.documentElement.classList.remove('dark') })
  }
  try {
    check('主窗已离开首启引导', await launch(true))
    check('主页输入框空着:发送键是通话键(带锚点)', await waitFor(() => call().count().then((n) => n > 0), 20000))
    check('没登录、不是云端模型 → data-call-billing = direct', (await call().first().getAttribute('data-call-billing').catch(() => '')) === 'direct')

    check('A 圈注出现(停手 1.5 秒、锚点露出 2 秒后)', await waitFor(() => ring().count().then((n) => n === 1), 15000))
    const geo = await win.evaluate(() => {
      const r = document.querySelector('.guide-spot-ring')?.getBoundingClientRect()
      const a = document.querySelector('[data-guide-anchor="chat-call"]')?.getBoundingClientRect()
      return r && a ? { wraps: r.left <= a.left + 1 && r.top <= a.top + 1 && r.right >= a.right - 1 && r.bottom >= a.bottom - 1, r: [r.left, r.top, r.width, r.height].map(Math.round), a: [a.left, a.top, a.width, a.height].map(Math.round) } : null
    })
    check('A 圈住的是通话键', !!geo && geo.wraps, JSON.stringify(geo))
    const title = await card().locator('.guide-spot-title').textContent().catch(() => '')
    const body = await card().textContent().catch(() => '')
    check('A 小卡标题 + 直连正文', title === '可以直接和 Tangu 通话了' && body.includes('费用由你的语音服务商收取'), `${title} | ${body}`)
    check('B 左边是「换个音色」', (await card().locator('.guide-spot-mute').textContent().catch(() => '')) === '换个音色')
    await shoot('call-hint')

    // C:打了字 → 发送键不再是通话键 → 锚点没了 → 圈注收掉,不记看过
    await win.locator('[data-guide-anchor="chat-composer"] textarea, [data-guide-anchor="chat-composer"] [contenteditable="true"]').first().click()
    await win.keyboard.type('你好')
    check('C 打了字 → 圈注收掉', await waitFor(() => ring().count().then((n) => n === 0), 5000))
    check('C 不记看过', (await seen()) === null, String(await seen()))
    for (let i = 0; i < 2; i++) await win.keyboard.press('Backspace')

    // D:同一个视图这次打开已经出过一条(和插件提示同一套节奏)→ 重开应用再出;点「换个音色」
    await launch(false)
    await win.mouse.move(5, 5)
    check('D 重开后圈注再出(没看过)', await waitFor(() => ring().count().then((n) => n === 1), 20000))
    const windowsBefore = app.windows().length
    await card().locator('.guide-spot-mute').click()
    check('D 点「换个音色」→ 圈注收掉', await waitFor(() => ring().count().then((n) => n === 0), 3000))
    check('D 记成看过', !!(await seen()), String(await seen()))
    const settingsOpen = await waitFor(async () => {
      if (app.windows().length > windowsBefore) return true
      for (const w of app.windows()) if (await w.locator('.settings-page').count().catch(() => 0)) return true
      return false
    }, 8000)
    check('D 设置打开了', settingsOpen, `windows ${windowsBefore} → ${app.windows().length}`)

    // E:看过之后重开不再出
    await launch(false)
    await waitFor(() => call().count().then((n) => n > 0), 20000)
    await pause(6000)
    check('E 看过之后重开不再出', (await ring().count()) === 0)
  } finally {
    if (app) await app.close().catch(() => {})
    await stub.close()
  }
  console.log(`${results.filter(Boolean).length}/${results.length} passed`)
  if (results.some((ok) => !ok) || results.length === 0) process.exitCode = 1
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
