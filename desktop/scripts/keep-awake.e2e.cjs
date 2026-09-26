/**
 * 「有会话运行时阻止休眠」—— 真 Electron × 假引擎 × 系统真值(macOS `pmset -g assertions` 里本 app 主进程的 NoIdleSleepAssertion)。
 *
 * 钉住:默认关不拦 / 运行中打开立刻拦 / run 结束放 / 隐藏到托盘仍拦 / 运行中关开关立刻放 / 睡眠唤醒(resume)重新申请 /
 *       外部模式切号放(appStore 清 runningBySession)/ 主框架换新文档放(did-navigate)/ 主窗口加载失败放 /
 *       卫星窗口加载失败放(did-fail-load)/ 渲染进程崩溃放 / 退出无残留。
 * 用法:先 npm run build,再 node scripts/keep-awake.e2e.cjs(仅 darwin;Windows 走同一 powerSaveBlocker API,本机测不了)。
 * 依赖 lib/stub-engine.cjs 的 abort 端点与 override 钩子。截图落 SHOT_DIR(缺省系统 tmp)。
 * 负对照(2026-09-16 实跑):去掉切号清空 + did-navigate + resume 重申 → T10 / T11b / T12 三条转红,其余照绿。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const SHOT_DIR = process.env.SHOT_DIR || os.tmpdir()
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const SESSION = {
  id: 'keepawake-s1', title: '防休眠验收', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/keepawake-demo', project_name: 'keepawake-demo',
  created_at: '2026-09-16 09:00:00', updated_at: '2026-09-16 09:00:00',
}

/** 系统真值:本 app 主进程名下的闲置休眠断言行。 */
function assertionLines(pid) {
  const out = execFileSync('pmset', ['-g', 'assertions'], { encoding: 'utf8' })
  return out.split('\n').filter((l) => l.includes(`pid ${pid}(`) && /NoIdleSleepAssertion|PreventUserIdleSystemSleep/.test(l))
}
async function waitHeld(pid, want, timeout = 4000) {
  const end = Date.now() + timeout
  let lines = assertionLines(pid)
  while ((lines.length > 0) !== want && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 200))
    lines = assertionLines(pid)
  }
  return lines
}

async function send(win, text) {
  const ta = win.locator('.t2c-ta').first()
  for (let i = 0; i < 40; i++) {
    if (await ta.isEnabled().catch(() => false)) break
    await win.waitForTimeout(500)
  }
  await ta.click()
  await ta.fill(text)
  await win.keyboard.press('Enter')
}

async function openChatSession(win) {
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await win.waitForTimeout(1000)
  await win.evaluate((names) => {
    const button = [...document.querySelectorAll('button.rb-space')]
      .find((item) => names.some((name) => (item.getAttribute('aria-label') || item.getAttribute('title') || item.textContent || '').includes(name)))
    button?.click()
  }, ['Agent', 'Tangu'])
  await win.waitForTimeout(1500)
  if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) {
    await win.click('.dv-edge-left').catch(() => {})
    await win.waitForTimeout(700)
  }
  const picker = win.locator('.t2sw-mode-picker').first()
  if (await picker.count().catch(() => 0)) {
    await picker.locator('.t2sw-mode-trigger').click().catch(() => {})
    await picker.locator('[data-workspace-mode="sessions"]').click().catch(() => {})
    await win.waitForTimeout(1000)
  }
  const row = win.locator('.t2s-srow', { hasText: '防休眠验收' }).first()
  await row.waitFor({ timeout: 20_000 }).catch(() => {}) // 重载后要等重新连上假引擎、拉回会话列表
  if (!(await row.count().catch(() => 0))) {
    const shot = path.join(SHOT_DIR, 'keepawake-nav-fail.png')
    await win.screenshot({ path: shot })
    throw new Error(`没找到会话行;截图 ${shot}`)
  }
  await row.click()
  await win.waitForTimeout(900)
}

async function startHeldRun(stub, win, text) {
  stub.script([{ type: 'token', delay: 100, payload: { delta: '开工…' } }, { type: '__hold' }])
  await send(win, text)
  await win.waitForSelector('.t2c-stop', { timeout: 8000 })
}
async function stopRun(win) {
  const before = await win.locator('.t2c-stop').count()
  await win.locator('.t2c-stop').first().click()
  const gone = await win.waitForSelector('.t2c-stop', { state: 'detached', timeout: 12_000 }).then(() => true, () => false)
  return { before, gone, settingsOpen: await win.locator('.settings-main').count() }
}

async function main() {
  if (process.platform !== 'darwin') { console.log('SKIP: 仅 darwin 可用 pmset 取系统真值'); return }
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/ —— 先 electron-vite build'); process.exit(1) }
  const stub = await startStubEngine({
    sessions: [SESSION],
    messages: [],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }],
    // 在飞 run 列表回空:崩溃重载后的新渲染层不会重挂旧 run,T7 才是确定性的
    override: ({ path: p, method }) => (p === '/agent/runs' && method === 'GET' ? { runs: [] } : undefined),
  })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-keepawake-'))
  const userData = path.join(home, 'userdata')
  const app = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
  })
  const pid = app.process().pid
  try {
    const win = await app.firstWindow()
    await win.setViewportSize({ width: 1400, height: 900 })
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await openChatSession(win)

    // T0 默认关、空闲
    const cfg0 = await win.evaluate(() => window.tangu.getConfig())
    check('T0a 默认 keepAwakeWhileRunning 非 true', cfg0.keepAwakeWhileRunning !== true, `got=${cfg0.keepAwakeWhileRunning}`)
    check('T0b preload 暴露 reportRunningSessions', await win.evaluate(() => typeof window.tangu.reportRunningSessions === 'function'))
    check('T0c 空闲无断言', (await waitHeld(pid, false, 1500)).length === 0)

    // T1 默认关 + 有 run → 不拦
    await startHeldRun(stub, win, '长任务一')
    await win.waitForTimeout(1500)
    check('T1 开关关着时有 run 也不拦', assertionLines(pid).length === 0)

    // T2 走真 UI:设置→常规里拨开(运行中打开要立刻拦)
    // 设置画在独立浮窗里(Floating Panel 化 2026-09-20):开窗前先 arm window 事件,面板 locator / 截图 / 深色 class
    // 一律打在浮窗 page 上;`getConfig` 仍走主窗(配置住主进程,读哪个窗口都一样)。
    const settingsOpened = app.waitForEvent('window')
    await win.keyboard.press('Meta+Comma')
    const sp = await settingsOpened
    await sp.waitForLoadState('domcontentloaded')
    await sp.waitForSelector('.settings-main', { timeout: 30_000 })
    const nav = sp.locator('.settings-nav')
    const general = nav.getByRole('button', { name: '常规', exact: true }).first()
    if (await general.count().catch(() => 0)) { await general.click().catch(() => {}); await sp.waitForTimeout(600) }
    const panel = sp.locator('.settings-panel', { hasText: '有会话运行时阻止休眠' }).first()
    await panel.scrollIntoViewIfNeeded()
    const sw = panel.locator('[role="switch"]').first()
    check('T2a 常规里有这张卡,开关初值为关', (await panel.count()) === 1 && (await sw.getAttribute('aria-checked')) === 'false')
    await panel.screenshot({ path: path.join(SHOT_DIR, 'keepawake-panel-off.png') })
    await sp.screenshot({ path: path.join(SHOT_DIR, 'keepawake-general-page.png') })
    await sw.click()
    await sp.waitForFunction(() => document.querySelector('.settings-panel [aria-label="有会话运行时阻止休眠"]')?.getAttribute('aria-checked') === 'true', null, { timeout: 5000 }).catch(() => {})
    check('T2b 点开后开关态为开', (await sw.getAttribute('aria-checked')) === 'true')
    const cfg1 = await win.evaluate(() => window.tangu.getConfig())
    check('T2c 配置落盘为 true', cfg1.keepAwakeWhileRunning === true)
    let lines = await waitHeld(pid, true)
    check('T2d 运行中打开 → 立刻持有断言', lines.length > 0, lines.join(' ‖ ').trim())
    await panel.screenshot({ path: path.join(SHOT_DIR, 'keepawake-panel-on.png') })
    await sp.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.dataset.mode = 'dark' })
    await sp.waitForTimeout(400)
    await panel.screenshot({ path: path.join(SHOT_DIR, 'keepawake-panel-on-dark.png') })
    await sp.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.dataset.mode = 'light' })
    const spClosed = sp.waitForEvent('close')
    await sp.locator('.settings-nav button:text-is("返回应用"), .settings-nav button:text-is("Back to app")').first().click({ timeout: 5000 }).catch(() => {})
    await spClosed.catch(() => {})
    await win.waitForTimeout(800)

    // T3 run 结束 → 放
    check('T2e 设置浮窗已关掉(后面的窗口断言里不该再有它)', sp.isClosed())
    const st = await stopRun(win)
    await win.screenshot({ path: path.join(SHOT_DIR, 'keepawake-after-stop.png') })
    lines = await waitHeld(pid, false)
    check('T3 run 结束 → 释放', lines.length === 0, JSON.stringify({ ...st, aborts: stub.seen.aborts, lines }))

    // T4 再起 run → 拦
    await startHeldRun(stub, win, '长任务二')
    lines = await waitHeld(pid, true)
    check('T4 开着时新 run → 持有', lines.length > 0)

    // T5 关窗口 = 藏进托盘,渲染层还活着 → 继续拦
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().forEach((w) => w.close()) })
    await new Promise((r) => setTimeout(r, 1500))
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))
    check('T5 关窗(隐藏到托盘)后仍持有', assertionLines(pid).length > 0, `windows visible=${JSON.stringify(visible)}`)
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().forEach((w) => w.show()) })
    await win.waitForTimeout(800)

    // T6 运行中关开关 → 立刻放;再开 → 立刻拦
    await win.evaluate(() => window.tangu.setConfig({ keepAwakeWhileRunning: false }))
    lines = await waitHeld(pid, false)
    check('T6a 运行中关掉开关 → 立刻释放', lines.length === 0)
    await win.evaluate(() => window.tangu.setConfig({ keepAwakeWhileRunning: true }))
    lines = await waitHeld(pid, true)
    check('T6b 再打开 → 立刻持有', lines.length > 0)

    // T12 睡眠唤醒(resume)→ 重新申请:断言还在,但换成了新的一枚(Windows 主动睡眠会终止旧请求)
    const idOf = (ls) => (/\[(0x[0-9a-f]+)\]/.exec(ls[0] || '') || [])[1] || null
    const beforeResume = idOf(assertionLines(pid))
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit('resume') })
    await new Promise((r) => setTimeout(r, 800))
    lines = await waitHeld(pid, true)
    const afterResume = idOf(lines)
    check('T12 resume 后重新申请(仍持有且断言 id 换新)', lines.length > 0 && !!beforeResume && !!afterResume && beforeResume !== afterResume, `${beforeResume} → ${afterResume}`)

    // T10 外部模式切号(T4 起的真 run 仍挂着):订阅被 abort 后 runningBySession 必须清空,否则断言永远不放
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.send('auth:changed', { loggedIn: false }) })
    lines = await waitHeld(pid, false)
    check('T10 外部模式切号 → 释放', lines.length === 0, lines.join(' ‖ '))

    // 以下验主进程的清零路径:新页面用渲染层契约直接报「有 run」,触发前先确认稳定持有(防假绿)
    const appUrl = win.url()
    const loadApp = async () => {
      await new Promise((r) => setTimeout(r, 2000)) // 上一步若触发了 recoverRenderer 重载,先让它落定
      // 与 recoverRenderer 的重载撞车时 loadURL 会以 -3(被取代)拒绝,反正两边都是回到应用页
      await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].loadURL(url).catch(() => {}), appUrl)
      await win.waitForFunction(() => typeof window.tangu?.reportRunningSessions === 'function', null, { timeout: 30_000 })
      await win.waitForTimeout(3000) // 让新页面自己的启动流程先跑完,免得它随后报 0 覆盖
      await win.evaluate(() => window.tangu.reportRunningSessions(1))
      await win.waitForTimeout(1500)
      return assertionLines(pid).length > 0
    }

    // T11 主框架换成一个永远不会上报的新文档(= 重载后渲染层没跑到上报)→ did-navigate 替它清
    check('T11a 新页面报有 run → 稳定持有', await loadApp())
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].loadURL('about:blank'))
    lines = await waitHeld(pid, false)
    check('T11b 换成不上报的新文档 → 释放', lines.length === 0, lines.join(' ‖ '))

    // T13 主框架加载失败(错误页不触发 did-navigate)→ did-fail-load 替它清
    check('T13a 新页面报有 run → 稳定持有', await loadApp())
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].loadURL('file:///nonexistent-forsion-keepawake.html').catch(() => {}))
    lines = await waitHeld(pid, false)
    check('T13b 主框架加载失败 → 释放', lines.length === 0, lines.join(' ‖ '))

    // T14 卫星窗口(没有 recoverRenderer 兜重载)主框架加载失败 → did-fail-load 替它清
    await win.evaluate(() => window.tangu.openDetached([]))
    let det = null
    for (let i = 0; i < 100 && !det; i++) {
      det = app.windows().find((w) => !w.isClosed() && w.url().includes('window=detached')) || null
      if (!det) await new Promise((r) => setTimeout(r, 200))
    }
    check('T14a 卫星窗口开出来了', !!det)
    if (det) {
      await det.waitForFunction(() => typeof window.tangu?.reportRunningSessions === 'function', null, { timeout: 30_000 })
      await det.waitForTimeout(3000)
      await det.evaluate(() => window.tangu.reportRunningSessions(1))
      await det.waitForTimeout(1500)
      check('T14b 卫星窗口报有 run → 稳定持有', assertionLines(pid).length > 0)
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('window=detached'))?.loadURL('file:///nonexistent-forsion-keepawake.html').catch(() => {})
      })
      lines = await waitHeld(pid, false)
      check('T14c 卫星窗口主框架加载失败 → 释放', lines.length === 0, lines.join(' ‖ '))
      await app.evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) if (/window=detached|nonexistent-forsion-keepawake/.test(w.webContents.getURL())) w.destroy()
      })
    }

    // T7 渲染进程崩溃(来不及报 0)→ 主进程替它清(放最后:崩溃后 Playwright 的 page 句柄作废)
    check('T7a 新页面报有 run → 稳定持有', await loadApp())
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer() })
    lines = await waitHeld(pid, false, 6000)
    check('T7b 渲染进程崩溃 → 释放', lines.length === 0, lines.join(' ‖ '))

    // T8 持久化到桌面壳配置文件
    const shellCfg = JSON.parse(fs.readFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), 'utf8'))
    check('T8 落在 userData(dev 加 -dev 后缀)/tangu-desktop-config.json', shellCfg.keepAwakeWhileRunning === true, `got=${shellCfg.keepAwakeWhileRunning}`)
  } finally {
    await app.close().catch(() => {})
    try { stub.close?.() } catch { /* ignore */ }
  }
  const afterClose = assertionLines(pid)
  check('T9 退出 app 后系统里不留断言', afterClose.length === 0)
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} PASS`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
