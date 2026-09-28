/**
 * 急停 + 远程锁定(P1 · K2)**真 Electron** 验证 —— 真主进程 × 真 preload / IPC × 真磁盘 × 真 globalShortcut,外部模式桩引擎。
 *
 * 为什么在单测之外还要这一条:electron/remoteSafety.test.ts 里文件 / 热键 / 托盘都是注入的桩;这里验 main.ts 的接线本身:
 *   ① window.tangu.remoteSafety 真的挂在 preload 上、IPC 通(get / estop / setHotkey);
 *   ② 急停热键 ⌃⌥⇧. 真注册进 globalShortcut(被别的实例占着时状态如实报 in_use);
 *   ③ 设置里「立即急停」→ userData/remote-lock.json 落盘 lock.locked=true、状态锁定(外部模式桩引擎没有 /agent/remote/* → 待补发);
 *   ④ **重启同一 userData → 仍锁定**(锁跨重启,S7 的真 Electron 半边);改键落盘、重启后照旧;
 *   ⑤ 设置浮窗 › 远程会话 页末尾真渲染出「急停与远程锁定」(经 K4 扩展槽),截图。
 * ⚠️ 覆盖不到:解锁(会弹真的 Touch ID / 管理员密码框,属人工);托盘菜单与菜单栏标题(系统托盘无法自动化,属人工截图);
 *   托管模式下引擎收到 FORSION_REMOTE_LOCK_FILE(由 live 台架 estop 场景与 backendManager 代码覆盖)。
 *
 * 上锁:devlock.cjs acquire --vehicle=e2e(被占退出码 3;--no-lock 跳过),任何退出路径都 release。
 * 截图:os.tmpdir()/forsion-remote-safety-e2e/(SHOT_DIR 可覆写)。
 * 用法:npm run build && node scripts/remote-safety.e2e.cjs [--keep]
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.join(__dirname, '..')
const SHOT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), 'forsion-remote-safety-e2e')
const argv = process.argv.slice(2)
const KEEP = argv.includes('--keep')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const HOTKEY = 'Control+Alt+Shift+.'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  const d = detail === undefined ? '' : `  | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d.length > 600 ? d.slice(0, 600) + '…' : d}`)
}
const note = (name, detail) => console.log(`NOTE  ${name}${detail ? '  | ' + detail : ''}`)

// ── devlock ──
function findDevlock() {
  for (let d = __dirname; ; d = path.dirname(d)) {
    const f = path.join(d, '.claude', 'hooks', 'devlock.cjs')
    if (fs.existsSync(f)) return f
    if (path.dirname(d) === d) return null
  }
}
const LOCK_SCRIPT = findDevlock()
let lockHeld = false
function releaseLock() {
  if (!lockHeld) return
  lockHeld = false
  const r = spawnSync(process.execPath, [LOCK_SCRIPT, 'release'], { encoding: 'utf8' })
  process.stdout.write(r.stdout || '')
}
function acquireLock() {
  if (argv.includes('--no-lock')) { note('devlock', '--no-lock:不上锁'); return }
  if (!LOCK_SCRIPT) { note('devlock', '向上找不到 .claude/hooks/devlock.cjs,不上锁'); return }
  const r = spawnSync(process.execPath, [LOCK_SCRIPT, 'acquire', '--what=remote-safety e2e', '--vehicle=e2e', '--eta=15', `--pid=${process.pid}`], { encoding: 'utf8' })
  process.stdout.write(r.stdout || '')
  process.stderr.write(r.stderr || '')
  if (r.status !== 0) { console.error('devlock 被占用:等它空闲再跑。'); process.exit(3) }
  lockHeld = true
}
process.on('exit', releaseLock)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { releaseLock(); process.exit(130) })

async function launch(home, stub) {
  const app = await electron.launch({
    // -ApplePersistenceIgnoreState:强杀过的 Electron 下次启动先弹「重新打开窗口」模态框,firstWindow 等不到(台架纪律)
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT, '-ApplePersistenceIgnoreState', 'YES'],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: path.join(home, 'tangu'), TANGU_BACKEND_URL: stub.url },
    timeout: 120_000,
  })
  const win = await app.firstWindow({ timeout: 120_000 })
  await win.waitForSelector('#root', { timeout: 60_000 })
  return { app, win }
}
/** 按 PID 收掉这次起的 Electron(close 超时才 SIGKILL 自己那个 pid;绝不 pkill)。 */
async function shutdown(app) {
  const pid = app.process()?.pid
  await Promise.race([app.close().catch(() => {}), sleep(10_000)])
  if (pid) { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } }
}
const waitState = async (win, pred, ms = 15_000) => {
  const end = Date.now() + ms
  let s = null
  while (Date.now() < end) {
    s = await win.evaluate(() => window.tangu?.remoteSafety?.get?.()).catch(() => null)
    if (s && pred(s)) return s
    await sleep(300)
  }
  return s
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  acquireLock()
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const stub = await startStubEngine({ sessions: [], messages: [], models: [{ id: 'm1', name: 'Stub', provider: 'stub', contextWindow: 128_000 }] })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-remote-safety-'))
  let lockFile = path.join(home, 'userdata-dev', 'remote-lock.json') // dev 下 main 顶部把 userData 改成 <dir>-dev;启动后按真值覆盖
  let run = null
  try {
    // ── 第一次启动 ──
    run = await launch(home, stub)
    lockFile = path.join(await run.app.evaluate(({ app }) => app.getPath('userData')), 'remote-lock.json')
    check('主窗离开首启引导', await skipOnboarding(run.win))
    const s0 = await waitState(run.win, (s) => s.hotkey && (s.hotkey.registered || s.hotkey.error))
    check('① preload 暴露 window.tangu.remoteSafety,get() 通', !!s0 && s0.locked === false, s0 && { locked: s0.locked, hotkey: s0.hotkey })
    const registered = await run.app.evaluate(({ globalShortcut }, acc) => globalShortcut.isRegistered(acc), HOTKEY)
    if (s0?.hotkey?.registered) check('② 急停热键 ⌃⌥⇧. 真注册进 globalShortcut', registered === true, { registered })
    else check('② 热键被占用时状态如实报 in_use(另一个 Forsion 实例占着?)', s0?.hotkey?.error === 'in_use' && registered === false, s0?.hotkey)
    check('开机未锁:锁文件不存在(从未急停)', !fs.existsSync(lockFile))

    // ⑤ 设置浮窗 › 远程会话:真渲染(经 K4 扩展槽)
    await run.win.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: '设置', builtin: 'settings', params: { tab: 'remote-sessions', skillKey: null } }))
    let settings = null
    for (let i = 0; i < 60 && !settings; i++) {
      for (const w of run.app.windows()) {
        if (w === run.win) continue
        if (await w.locator('[data-setting-anchor="remote-safety"]').count().catch(() => 0)) { settings = w; break }
      }
      if (!settings) await sleep(500)
    }
    check('⑤ 设置浮窗「远程会话」页末尾渲染出「急停与远程锁定」', !!settings)
    if (settings) {
      const panel = settings.locator('[data-setting-anchor="remote-safety"]')
      await panel.scrollIntoViewIfNeeded().catch(() => {})
      await sleep(400)
      await panel.screenshot({ path: path.join(SHOT_DIR, 'electron-settings-unlocked.png') }).catch(() => {})
      // ③ 立即急停(设置里点真按钮)
      await settings.locator('[data-rsf="estop"]').click()
      await settings.locator('[data-rsf="unlock"]').waitFor({ timeout: 15_000 }).catch(() => {})
      await sleep(400)
      await panel.screenshot({ path: path.join(SHOT_DIR, 'electron-settings-locked.png') }).catch(() => {})
    } else {
      await run.win.evaluate(() => window.tangu.remoteSafety.estop())
    }
    const s1 = await waitState(run.win, (s) => s.locked)
    check('③ 急停后状态锁定、来源 settings;外部模式桩引擎没有急停路由 → 待补发', s1?.locked === true && s1?.lockSource === 'settings' && s1?.pendingEstop === true, s1 && { locked: s1.locked, lockSource: s1.lockSource, pendingEstop: s1.pendingEstop, engine: s1.engine })
    let file = null
    try { file = JSON.parse(fs.readFileSync(lockFile, 'utf8')) } catch (e) { file = String(e.message) }
    check('③ userData/remote-lock.json 落盘 lock.locked=true', file?.v === 1 && file?.lock?.locked === true && file?.lock?.source === 'settings', file)
    const mode = fs.existsSync(lockFile) ? (fs.statSync(lockFile).mode & 0o777).toString(8) : 'missing'
    check('③ 锁文件 0600', mode === '600', mode)

    // 改键落盘(真 globalShortcut:新键注册、旧键注销)
    const hk = await run.win.evaluate(() => window.tangu.remoteSafety.setHotkey('Control+Alt+Shift+K'))
    const regs = await run.app.evaluate(({ globalShortcut }) => ({ k: globalShortcut.isRegistered('Control+Alt+Shift+K'), dot: globalShortcut.isRegistered('Control+Alt+Shift+.') }))
    let savedHotkey = null
    try { savedHotkey = JSON.parse(fs.readFileSync(lockFile, 'utf8')).hotkey } catch { /* 缺文件 = 红 */ }
    check('改键:新键注册、旧键注销、落盘', (hk.registered ? regs.k && !regs.dot : true) && savedHotkey === 'Control+Alt+Shift+K', { hk, regs, savedHotkey })
    await shutdown(run.app)
    run = null

    // ── 第二次启动(同一 userData):锁跨重启 ──
    run = await launch(home, stub)
    await skipOnboarding(run.win)
    const s2 = await waitState(run.win, (s) => s.hotkey && (s.hotkey.registered || s.hotkey.error))
    check('④ 重启同一 userData → 仍锁定(锁跨重启)', s2?.locked === true && s2?.lockSource === 'settings', s2 && { locked: s2.locked, lockSource: s2.lockSource })
    check('④ 重启后沿用改过的热键', s2?.hotkey?.accelerator === 'Control+Alt+Shift+K', s2?.hotkey)
  } finally {
    if (run) await shutdown(run.app)
    await stub.close?.()
    if (!KEEP) fs.rmSync(home, { recursive: true, force: true })
    else note('保留 home', home)
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${failed ? '❌' : '✅'} ${results.length - failed} 过 / ${failed} 挂 —— 截图:${SHOT_DIR}`)
  releaseLock()
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); releaseLock(); process.exit(1) })
