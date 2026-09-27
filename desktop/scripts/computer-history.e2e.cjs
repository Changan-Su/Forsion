/**
 * 电脑历史(Computer History)**真 Electron** 验证 —— 真主进程 × 真 IPC × 真磁盘 × 假 CU helper。
 *
 * 为什么在 check:computerhistory 之外还要这一条:那支是 web harness,`window.tangu.computerHistory` 是桩,
 * 「开关落配置 → 主进程连 helper socket → recordSubscribe 带策略 → 事件流逐行落 events/<日>.jsonl →
 *  state.json → 改排除表重订阅 → 暂停断订阅 → 清除原子删 → 关掉不再连」这条链一次都没被验过。桩会撒谎。
 *
 * 假 helper:本文件起一个 unix socket 服务器(PI_CU_SOCKET_PATH 指过去),说 CU helper 的行协议
 * (一行一个 JSON;diagnostics / permissionStatus 一问一答;recordSubscribe 首行回执后连接常开、按需推 {"ev":…})。
 * 它**不按策略过滤**,于是「终端只记标题」「排除 App」的落盘结论全靠主进程那层防御纵深 —— 正是要验的。
 * 它**从不自动推事件**:只在脚本调 helper.stream() 时推,否则「清除全部」之后的重订阅会把刚删空的目录又写满。
 *
 * ⚠️ 覆盖不到:
 *  - helper_missing 分支:设了 PI_CU_SOCKET_PATH = 外部 socket(externalSocket=true),主进程**不替它拉起**,
 *    连不上只会落 disconnected(external_unavailable),永远到不了 helper_missing。本脚本第二段另起一次,
 *    用 HOME 覆写 + PI_COMPUTER_USE_HELPER_APP_PATH 指向临时目录里不存在的 .app 走真 helper_missing(不连也不拉起任何真 helper)。
 *  - 真 helper 的 AX 采集 / 策略过滤、真辅助功能授权:要装好的 tangu-computer-use 与 TCC,属载具 C / 人工。
 *  - 本地零点前后 ~2 分钟跑:「今天的记录」按本地日界过滤,事件 t 可能落到昨天 → 预览断言可能假红。
 *
 * 负对照(断言必须能红):
 *   --nc=nofilter    终端那条文本改用不在 titleOnly 表里的 bundleId 发 → 「终端文本未落盘」必须红
 *   --nc=preenabled  预置配置 computerHistoryEnabled:true → 「默认关闭 / 关着零订阅」必须红
 *
 * 截图:os.tmpdir()/forsion-computer-history-e2e/(SHOT_DIR 可覆写;DESIGN §8:几何全绿 ≠ 看起来对,自己看)。
 * 上锁:脚本自己 `devlock.cjs acquire --vehicle=e2e --pid=<本进程>`,任何退出路径都 release(被占就退出码 3;--no-lock 跳过)。
 *
 * 用法:npm run build && npm run e2e:computerhistory   [--nc=nofilter|preenabled] [--skip-missing] [--keep]
 */
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.join(__dirname, '..')
const SHOT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), 'forsion-computer-history-e2e')
const argv = process.argv.slice(2)
const NC = (argv.find((a) => a.startsWith('--nc=')) || '').split('=')[1] || ''
const KEEP = argv.includes('--keep')
const SKIP_MISSING = argv.includes('--skip-missing') || !!NC
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 结果统计(skill §3.1b:check 一律 !!ok;未验单独计数,三个数之和必须 = 总数) ──────────────
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  const d = detail === undefined ? '' : `  | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d.length > 600 ? d.slice(0, 600) + '…' : d}`)
}
function skip(name, why) {
  results.push({ name, skipped: true })
  console.log(`SKIP  ${name}  | 未验:${why}`)
}
const note = (name, detail) => console.log(`NOTE  ${name}${detail ? '  | ' + detail : ''}`)

// ── devlock ──────────────────────────────────────────────────────────────────────────────────
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
  const r = spawnSync(process.execPath, [LOCK_SCRIPT, 'acquire', '--what=computer-history e2e', '--vehicle=e2e', '--eta=45', `--pid=${process.pid}`], { encoding: 'utf8' })
  process.stdout.write(r.stdout || '')
  process.stderr.write(r.stderr || '')
  if (r.status !== 0) {
    console.error('devlock 被占用:等它空闲(node devlock.cjs wait)再跑;确认那轮已废才 release。')
    process.exit(3)
  }
  lockHeld = true
}
process.on('exit', releaseLock)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { releaseLock(); process.exit(130) })
process.on('uncaughtException', (e) => { console.error(e); releaseLock(); process.exit(1) })

// ── 假 CU helper ──────────────────────────────────────────────────────────────────────────────
function startFakeHelper(sockPath) {
  const requests = [] // { cmd, id, policy, at, conn }
  const subs = new Map() // conn -> { socket, policy, openedAt, closedAt }
  const sockets = new Set()
  let connSeq = 0
  const server = net.createServer((socket) => {
    const conn = ++connSeq
    sockets.add(socket)
    let buf = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { requests.push({ cmd: '<bad-json>', raw: line.slice(0, 200), at: Date.now(), conn }); continue }
        requests.push({ cmd: msg.cmd, id: msg.id, policy: msg.policy, at: Date.now(), conn })
        const reply = (obj) => { if (!socket.destroyed) socket.write(`${JSON.stringify({ id: msg.id, ...obj })}\n`) }
        const perm = { accessibility: true, screenRecordingPreflight: true, screenRecordingCapturable: true, source: { attribution: 'helper-app', pid: process.pid, executablePath: '/fake/tangu-computer-use.app/Contents/MacOS/bridge' } }
        switch (msg.cmd) {
          case 'recordSubscribe':
            subs.set(conn, { socket, policy: msg.policy, openedAt: Date.now(), closedAt: null })
            reply({ ok: true, result: { subscribed: true, protocolVersion: 13, axTrusted: true } })
            break
          case 'diagnostics': reply({ ok: true, result: { protocolVersion: 13, version: 'fake-e2e' } }); break
          case 'permissionStatus': reply({ ok: true, result: perm }); break
          case 'checkPermissions': reply({ ok: true, result: perm }); break
          default: reply({ ok: false, error: { code: 'unknown_command', message: `fake helper does not know ${msg.cmd}` } })
        }
      }
    })
    socket.on('close', () => {
      sockets.delete(socket)
      const s = subs.get(conn)
      if (s && !s.closedAt) s.closedAt = Date.now()
    })
    socket.on('error', () => {})
  })
  return new Promise((resolve, reject) => {
    try { fs.unlinkSync(sockPath) } catch { /* 不存在 */ }
    server.once('error', reject)
    server.listen(sockPath, () => resolve({
      requests,
      subscribes: () => requests.filter((r) => r.cmd === 'recordSubscribe'),
      open: () => [...subs.values()].filter((s) => !s.closedAt),
      /** 往当前开着的订阅推事件;返回推给了几条连接。 */
      stream(events) {
        const open = [...subs.values()].filter((s) => !s.closedAt)
        for (const s of open) for (const ev of events) s.socket.write(`${JSON.stringify({ ev })}\n`)
        return open.length
      },
      cmds: () => requests.reduce((m, r) => ((m[r.cmd] = (m[r.cmd] || 0) + 1), m), {}),
      close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()) }),
    }))
  })
}

// ── 事件夹具 ──────────────────────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0')
/** 与主进程 localDay 同口径:按事件 t 的本地日期分文件。 */
const localDay = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const VSCODE = { name: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode' }
const SAFARI = { name: 'Safari', bundleId: 'com.apple.Safari' }
const TERMINAL = { name: 'Terminal', bundleId: 'com.apple.Terminal' }
const HEALTH = { name: 'Health', bundleId: 'com.apple.Health' }
/** 每个 App 段 ≥ 10s(foldSessions 丢掉更短且没打字的段);末尾那条单事件段必被丢,只为收尾终端段。 */
function sessionEvents(base) {
  const term = NC === 'nofilter' ? { name: 'Terminal', bundleId: 'com.example.PlainTerminal' } : TERMINAL
  return [
    { t: base, kind: 'app', app: VSCODE, title: 'foo.ts — proj' },
    { t: base + 4_000, kind: 'text', app: VSCODE, title: 'foo.ts — proj', el: { role: 'AXTextArea' }, text: 'const E2E_VSCODE_TEXT = 1' },
    { t: base + 8_000, kind: 'click', app: VSCODE, el: { role: 'AXButton', label: 'Run' } },
    { t: base + 12_000, kind: 'key', app: VSCODE, keys: 'cmd+s' },
    { t: base + 20_000, kind: 'window', app: SAFARI, title: 'Example Domain', url: 'https://example.com/' },
    { t: base + 40_000, kind: 'app', app: term, title: 'zsh — 80×24' },
    { t: base + 44_000, kind: 'text', app: term, el: { role: 'AXTextArea' }, text: 'export E2E_TERMINAL_SECRET=abc' },
    { t: base + 60_000, kind: 'app', app: VSCODE, title: 'bar.ts — proj' },
  ]
}

// ── 磁盘读数 ──────────────────────────────────────────────────────────────────────────────────
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return { __bad: l } } }) } catch { return null } }
const jsonlFiles = (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) } catch { return [] } }
async function until(fn, timeout = 8_000, step = 150) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v || Date.now() >= end) return v
    await sleep(step)
  }
}

// ── UI 小工具 ─────────────────────────────────────────────────────────────────────────────────
const L = {
  zh: { ch: '电脑历史', theme: '外观', about: '关于', refresh: '刷新', resume: '恢复记录' },
  en: { ch: 'Computer history', theme: 'Appearance', about: 'About', refresh: 'Refresh', resume: 'Resume' },
}

/** 进设置浮窗(Floating Panel 化后设置住独立窗口:先 arm window 事件再按热键)。 */
async function openSettings(app, win) {
  const opened = app.waitForEvent('window', { timeout: 20_000 }).catch(() => null)
  await win.keyboard.press('Meta+Comma')
  let sp = await opened
  if (!sp) {
    const retry = app.waitForEvent('window', { timeout: 20_000 }).catch(() => null)
    await win.locator('#rb-settings, [data-ribbon-id="rb-settings"]').first().click({ timeout: 4_000 }).catch(() => {})
    sp = await retry
  }
  if (!sp) throw new Error('设置浮窗没开出来')
  await sp.waitForLoadState('domcontentloaded').catch(() => {})
  await sp.waitForSelector('.settings-nav', { timeout: 30_000 })
  return sp
}

/** 点左栏一级页(精确可访问名,skill §3.1b 坑 1),等目标内容出现;没出现再点一次。 */
async function gotoTab(sp, label, readySel) {
  for (let i = 0; i < 2; i++) {
    const b = sp.locator('.settings-nav').getByRole('button', { name: label, exact: true }).first()
    if (!(await b.count().catch(() => 0))) return false
    await b.scrollIntoViewIfNeeded().catch(() => {})
    await b.click().catch(() => {})
    if (await sp.locator(readySel).first().waitFor({ timeout: 6_000 }).then(() => true, () => false)) return true
  }
  return false
}

async function setMode(sp, lang, mode) {
  if (!(await gotoTab(sp, L[lang].theme, '[data-setting-anchor="color-mode"]'))) return false
  await sp.locator('[data-setting-anchor="color-mode"] .seg button').nth(mode === 'dark' ? 1 : 0).click()
  return sp.waitForFunction((m) => document.documentElement.dataset.mode === m, mode, { timeout: 6_000 }).then(() => true, () => false)
}

const chStatus = (sp) => sp.locator('.ch-page').first().getAttribute('data-ch-status').catch(() => null)
const switchChecked = (sp) => sp.locator('.ch-page [role="switch"]').first().getAttribute('aria-checked').catch(() => null)
const waitStatus = (sp, status, timeout = 10_000) =>
  sp.waitForSelector(`.ch-page[data-ch-status="${status}"]`, { timeout }).then(() => true, () => false)

/** .ch-page 里有没有元素伸出页面右缘(横向溢出)。 */
const overflow = (sp) => sp.evaluate(() => {
  const p = document.querySelector('.ch-page')
  if (!p) return { missing: true }
  const pr = p.getBoundingClientRect()
  const bad = []
  for (const el of p.querySelectorAll('*')) {
    const r = el.getBoundingClientRect()
    if (r.width && r.right > pr.right + 1) bad.push(`${String(el.className || el.tagName).slice(0, 40)}:${Math.round(r.right - pr.right)}px`)
  }
  return { scroll: p.scrollWidth, client: p.clientWidth, bad: bad.slice(0, 6) }
})

/** 文字对前景 / 合成后底色的对比度。颜色经 1×1 canvas 归一(computed style 可能是 oklch / color()),
 *  底色从 <html> 往下逐层按 alpha 合成(只看 background-color,不含渐变 / 毛玻璃)。 */
const contrastOf = (sp, sel) => sp.evaluate((s) => {
  const el = document.querySelector(s)
  if (!el) return null
  const cv = document.createElement('canvas')
  cv.width = cv.height = 1
  const x = cv.getContext('2d', { willReadFrequently: true })
  const rgba = (c) => { x.clearRect(0, 0, 1, 1); x.fillStyle = '#000'; x.fillStyle = c; x.fillRect(0, 0, 1, 1); const d = x.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255] }
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]))
  const chain = []
  for (let e = el; e; e = e.parentElement) chain.unshift(e)
  let bg = [255, 255, 255]
  for (const e of chain) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) bg = over(c, bg) }
  const fg = over(rgba(getComputedStyle(el).color), bg)
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]) }
  const [a, b] = [lum(fg), lum(bg)].sort((p, q) => q - p)
  return { ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100, fg: fg.map(Math.round), bg: bg.map(Math.round), size: getComputedStyle(el).fontSize }
}, sel)

/** 同意条正文(用户开录前必须读的那段)对比度 ≥ 4.5(WCAG AA,11px 小字);标题一并量。 */
async function consentContrast(sp, tag) {
  const body = await contrastOf(sp, '.ch-confirm--consent p')
  const head = await contrastOf(sp, '.ch-confirm--consent strong')
  check(`[${tag}] 同意条正文对比度 ≥ 4.5`, !!body && body.ratio >= 4.5, body)
  check(`[${tag}] 同意条标题对比度 ≥ 4.5`, !!head && head.ratio >= 4.5, head)
}

/** 拍一组:顶部(开关 / 状态 / 同意条)、今日预览、底部(排除表 / 清除)。 */
async function shots(sp, tag, parts = ['top', 'preview', 'bottom']) {
  const files = []
  const scrollTop = () => sp.evaluate(() => { for (let e = document.querySelector('.ch-page'); e; e = e.parentElement) if (e.scrollTop) e.scrollTop = 0 })
  const center = (sel) => sp.evaluate((s) => { const el = document.querySelector(s); if (el) el.scrollIntoView({ block: 'center' }); return !!el }, sel)
  for (const part of parts) {
    if (part === 'top') await scrollTop()
    else if (part === 'preview') await center('.ch-sessions, .ch-page .settings-empty-row')
    else if (part === 'bottom') await center('.ch-page [data-ch-add="app"]')
    await sp.waitForTimeout(350)
    const file = path.join(SHOT_DIR, `${tag}-${part}.png`)
    await sp.screenshot({ path: file })
    files.push(file)
  }
  const o = await overflow(sp)
  check(`[${tag}] .ch-page 无横向溢出`, !o.missing && o.scroll <= o.client + 1 && o.bad.length === 0, o)
  await scrollTop()
  return files
}

// ── 主流程 ────────────────────────────────────────────────────────────────────────────────────
async function launchApp(home, sock, stubUrl, extraEnv = {}) {
  const env = { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stubUrl, ...extraEnv }
  if (sock) env.PI_CU_SOCKET_PATH = sock
  else delete env.PI_CU_SOCKET_PATH
  // -ApplePersistenceIgnoreState YES(放在 ROOT 之后,否则 YES 会被当成 app 路径):跳过 macOS 窗口恢复。
  //  ① 任何一轮 Electron 崩过之后,macOS 对 com.github.Electron 弹「意外退出,是否重新打开窗口」模态
  //     (sample:NSPersistentUIRestorer promptToIgnorePersistentStateWithCrashHistory → NSAlert runModal),
  //     下一轮 firstWindow 干等 30s、主进程日志全空 —— 台架被上一轮的崩溃拖死;
  //  ② T15 偶发主进程 SIGSEGV(台架经 inspector 对设置浮窗 setContentSize/center 之后第一次输入即崩,产品路径不改浮窗尺寸):
  //     加了它之后同组合 0/10 复现(不加时 4/4;无同条件对照 —— 崩溃史让不加 flag 的启动卡在上面的模态)。
  const app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT, '-ApplePersistenceIgnoreState', 'YES'], cwd: ROOT, env })
  const mainLog = []
  app.process().stdout?.on('data', (d) => mainLog.push(String(d)))
  app.process().stderr?.on('data', (d) => mainLog.push(String(d)))
  // 生命周期取证(T15 偶发「page closed」那次没留下分诊所需的证据):窗口关 / 渲染进程崩 / 主进程退(退出码 + 信号)各记一笔,
  // 失败时连同主进程日志尾一起打出来 —— 分清是产品把窗关了、渲染层崩了,还是外部把 Electron 整个杀了(SIGTERM = 有人 pkill)。
  const t0 = Date.now()
  const life = []
  const mark = (what) => life.push(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${what}`)
  const tag = (p) => { try { return /window=floating/.test(p.url()) ? 'floating' : 'main' } catch { return '?' } }
  app.process().on('exit', (code, signal) => mark(`主进程退出 code=${code} signal=${signal}`))
  app.on('close', () => mark('ElectronApplication close'))
  const watchPage = (p) => {
    p.on('close', () => mark(`窗口关闭(${tag(p)})`))
    p.on('crash', () => mark(`渲染进程崩溃(${tag(p)})`))
  }
  app.windows().forEach(watchPage)
  app.on('window', watchPage)
  return { app, mainLog, life, mark }
}

/** 失败取证:生命周期时间线 + 主进程日志尾(不过滤:崩溃栈 / 信号 / 单实例锁提示都可能不含 error 字样)。 */
function dumpLife(life, mainLog) {
  console.error('生命周期时间线:\n  ' + (life.length ? life.join('\n  ') : '(无事件)'))
  const tail = mainLog.join('').split('\n').filter(Boolean).slice(-40)
  console.error('主进程日志尾(未过滤,最后 40 行):\n' + (tail.length ? tail.join('\n') : '(空)'))
}

async function closeApp(app) {
  if (!app) return
  const closed = await Promise.race([app.close().then(() => true, () => false), sleep(15_000).then(() => false)])
  if (!closed) { try { app.process().kill('SIGKILL') } catch { /* 已退 */ } } // 只杀自己起的那个子进程,不 pkill
}

const rendererErrors = []
function watchErrors(page, tag) {
  page.on('pageerror', (e) => rendererErrors.push(`[${tag} pageerror] ${String(e && e.stack || e).slice(0, 400)}`))
  page.on('console', (m) => { if (m.type() === 'error') rendererErrors.push(`[${tag} console.error] ${m.text().slice(0, 400)}`) })
}

async function mainPhase(stub) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-chist-'))
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fch-')) // unix socket 路径上限 104 字节,单独一个短目录
  const sock = path.join(sockDir, 'cu.sock')
  const chRoot = path.join(home, 'computer-history')
  const eventsDir = path.join(chRoot, 'events')
  const statePath = path.join(chRoot, 'state.json')
  const cfgPath = path.join(home, 'userdata-dev', 'tangu-desktop-config.json') // dev 态 userData = --user-data-dir + '-dev'
  const helper = await startFakeHelper(sock)
  if (NC) console.log(`⚠️ 负对照 --nc=${NC}:期望对应断言变红\n`)
  if (NC === 'preenabled') {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
    fs.writeFileSync(cfgPath, JSON.stringify({ computerHistoryEnabled: true }))
  }
  let app, mainLog = [], life = [], mark = () => {}, bodyFailed = false
  try {
    ;({ app, mainLog, life, mark } = await launchApp(home, sock, stub.url))
    const win = await app.firstWindow()
    watchErrors(win, 'main')
    await win.waitForSelector('#root', { timeout: 40_000 })
    check('T0 首启引导已跳过(主窗 .shell-host 可见)', await skipOnboarding(win))
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 }).catch(() => {})
    await win.waitForTimeout(800)

    const sp = await openSettings(app, win)
    watchErrors(sp, 'settings')
    const bw = await app.browserWindow(sp)
    await bw.evaluate((w) => { w.setContentSize(1040, 1000); w.center() }).catch(() => {})
    check('T0b 设置 → 外观 → 亮色(起点钉浅色,不跟系统)', await setMode(sp, 'zh', 'light'))

    // ── ① 默认关闭 ──
    check('T1a 设置左栏「系统」组里有「电脑历史」并能打开', await gotoTab(sp, L.zh.ch, '.ch-page'))
    await sp.waitForTimeout(2_500) // 给主进程足够时间:要连早就连了
    check('T1b 默认关闭:开关 aria-checked=false、data-ch-status=off', (await switchChecked(sp)) === 'false' && (await chStatus(sp)) === 'off',
      { checked: await switchChecked(sp), status: await chStatus(sp) })
    check('T2 关着时不建 <home>/computer-history(引擎把「没有 state.json」当关)', !fs.existsSync(chRoot))
    check('T3 关着时假 helper 收到 0 条 recordSubscribe', helper.subscribes().length === 0, helper.cmds())

    // ── ② 开启要先过同意确认 ──
    await sp.locator('.ch-page [role="switch"]').first().click()
    const consent = await sp.locator('.ch-confirm--consent').first().waitFor({ timeout: 4_000 }).then(() => true, () => false)
    check('T4 点开关 → 出同意确认条,开关仍是关', consent && (await switchChecked(sp)) === 'false', { consent, checked: await switchChecked(sp) })
    await sp.waitForTimeout(800)
    check('T5 确认前仍 0 条订阅、仍未建目录', helper.subscribes().length === 0 && !fs.existsSync(chRoot), { subs: helper.subscribes().length, dir: fs.existsSync(chRoot) })
    await shots(sp, 'zh-light-consent', ['top'])
    await consentContrast(sp, 'zh-light-consent')

    await sp.locator('.ch-confirm--consent .btn.primary').first().click()
    check('T6 确认 → 状态 recording(UI)', await waitStatus(sp, 'recording'), { status: await chStatus(sp) })
    await until(() => helper.open().length === 1, 5_000)
    const sub1 = helper.subscribes()
    check('T7 恰好 1 条 recordSubscribe,连接常开', sub1.length === 1 && helper.open().length === 1, { subs: sub1.length, open: helper.open().length, cmds: helper.cmds() })
    const pol = sub1[0] && sub1[0].policy
    check('T8 下发策略:titleOnly 含 com.apple.Terminal 与 com.forsion.*,excludeBundleIds 空,text/clicks/keys 开',
      !!pol && Array.isArray(pol.titleOnlyBundleIds) && pol.titleOnlyBundleIds.includes('com.apple.Terminal') && pol.titleOnlyBundleIds.includes('com.forsion.*')
        && Array.isArray(pol.excludeBundleIds) && pol.excludeBundleIds.length === 0 && pol.text === true && pol.clicks === true && pol.keys === true, pol)
    const st1 = await until(() => { const s = readJson(statePath); return s && s.enabled === true && s.status === 'recording' ? s : null }, 5_000)
    check('T9 state.json = {enabled:true, status:"recording"}', !!st1, readJson(statePath))
    check('T10 开关落进桌面配置 computerHistoryEnabled:true', readJson(cfgPath)?.computerHistoryEnabled === true, readJson(cfgPath))

    // ── ③ 事件流落盘 + 终端只记标题 ──
    const base1 = Date.now() - 90_000
    const evs1 = sessionEvents(base1)
    check('T11a 假 helper 把事件推给了 1 条订阅', helper.stream(evs1) === 1)
    const dayFile = path.join(eventsDir, `${localDay(base1)}.jsonl`)
    const lines1 = await until(() => { const ls = readLines(dayFile); return ls && ls.some((l) => l.text && l.text.includes('E2E_VSCODE_TEXT')) && ls.length >= 7 ? ls : null }, 6_000)
    const ls1 = lines1 || readLines(dayFile) || []
    const kinds = new Set(ls1.map((l) => l.kind))
    check(`T11b ${path.basename(dayFile)} 落下 app/window/text/click/key(VS Code 文本、Safari 网址都在)`,
      ['app', 'window', 'text', 'click', 'key'].every((k) => kinds.has(k))
        && ls1.some((l) => l.kind === 'window' && l.url === 'https://example.com/')
        && ls1.some((l) => l.kind === 'text' && l.app?.bundleId === 'com.microsoft.VSCode'),
      { file: dayFile, n: ls1.length, kinds: [...kinds] })
    check('T12 终端的 app 事件照记(带标题)', ls1.some((l) => l.kind === 'app' && l.app?.name === 'Terminal' && l.title === 'zsh — 80×24'))
    const rawDay = fs.existsSync(dayFile) ? fs.readFileSync(dayFile, 'utf8') : ''
    check('T13 终端(默认只记标题)里敲的字没落盘(helper 没过滤,主进程防御纵深挡住)', !!rawDay && !rawDay.includes('E2E_TERMINAL_SECRET'),
      rawDay.split('\n').filter((l) => l.includes('Terminal')).join(' ‖ '))
    let mode = ''
    try { mode = (fs.statSync(dayFile).mode & 0o777).toString(8) } catch { /* 无文件 */ }
    check('T13b 日文件权限 600、目录 700', mode === '600' && (fs.statSync(chRoot).mode & 0o777).toString(8) === '700', { file: mode })

    // ── ④ 今日预览 ──
    await sp.locator('.ch-page').getByRole('button', { name: L.zh.refresh, exact: true }).first().click()
    const apps1 = await until(async () => {
      const a = await sp.locator('.ch-session strong').allInnerTexts().catch(() => [])
      return ['Visual Studio Code', 'Safari', 'Terminal'].every((x) => a.includes(x)) ? a : null
    }, 5_000)
    const hosts = await sp.locator('.ch-session-host').allInnerTexts().catch(() => [])
    check('T14 刷新后「今天的记录」列出 VS Code / Safari / Terminal 三段,Safari 行露 example.com', !!apps1 && hosts.includes('example.com'),
      { apps: apps1 || await sp.locator('.ch-session strong').allInnerTexts().catch(() => []), hosts })
    await shots(sp, 'zh-light-recording')
    note('[zh-light-recording] 预览时间 / 主机名(text-faint)对比度', JSON.stringify({ time: (await contrastOf(sp, '.ch-session-time'))?.ratio, host: (await contrastOf(sp, '.ch-session-host'))?.ratio, hint: (await contrastOf(sp, '.ch-page .settings-control-list .settings-row-description, .ch-page .settings-control-list small, .ch-page .settings-control-list p'))?.ratio }))

    // ── ⑤ 手填 Bundle ID 排除 → 重订阅带新策略 ──
    const beforeEx = helper.subscribes().length
    await sp.locator('.ch-page [data-ch-add="app"] input').fill('com.apple.Health')
    mark('T15 按 Enter 提交排除 App')
    await sp.locator('.ch-page [data-ch-add="app"] input').press('Enter')
    mark('T15 Enter 已返回')
    const chip = await sp.locator('.ch-chip[data-bundle-id="com.apple.Health"]').first().waitFor({ timeout: 5_000 }).then(() => true, () => false)
    check('T15 排除表出现 com.apple.Health 芯片', chip)
    await until(() => helper.subscribes().length > beforeEx && helper.open().length === 1, 5_000)
    const lastPol = helper.subscribes().at(-1)?.policy
    check('T16 重订阅:新 recordSubscribe 的 policy.excludeBundleIds 含 com.apple.Health,旧连接已关(开着的恰 1 条)',
      helper.subscribes().length === beforeEx + 1 && helper.open().length === 1 && Array.isArray(lastPol?.excludeBundleIds) && lastPol.excludeBundleIds.includes('com.apple.Health')
        && !lastPol.titleOnlyBundleIds?.includes('com.apple.Health'),
      { subs: helper.subscribes().length, before: beforeEx, open: helper.open().length, exclude: lastPol?.excludeBundleIds })
    check('T17 排除表落进桌面配置', (readJson(cfgPath)?.computerHistoryExclude?.apps || []).includes('com.apple.Health'), readJson(cfgPath)?.computerHistoryExclude)
    const nowH = Date.now()
    helper.stream([
      { t: nowH - 6_000, kind: 'app', app: HEALTH, title: 'E2E_HEALTH_TITLE' },
      { t: nowH - 3_000, kind: 'text', app: HEALTH, el: { role: 'AXTextField' }, text: 'E2E_HEALTH_SECRET' },
    ])
    const healthDay = path.join(eventsDir, `${localDay(nowH - 6_000)}.jsonl`)
    const hLine = await until(() => (readLines(healthDay) || []).find((l) => l.app?.bundleId === 'com.apple.Health'), 5_000)
    await sleep(1_300) // 等可能跟在后面的文本那条也落盘(FLUSH_MS=1s)
    const rawH = fs.existsSync(healthDay) ? fs.readFileSync(healthDay, 'utf8') : ''
    check('T18 被排除 App:只留 {app:{excluded:true}} 切换事实,标题与输入都不落盘', !!hLine && hLine.app.excluded === true && !hLine.title && !rawH.includes('E2E_HEALTH'),
      { line: hLine, leaked: rawH.includes('E2E_HEALTH') })

    // ── ⑥ 暂停 30 分钟 → 断订阅;恢复 → 重订阅 ──
    const beforePause = helper.subscribes().length
    const tPause = Date.now()
    await sp.locator('.ch-page .ch-btn-row button').first().click()
    check('T19 暂停 30 分钟 → 订阅连接被关(开着的 0 条)', !!(await until(() => helper.open().length === 0, 5_000)), { open: helper.open().length })
    const stP = await until(() => { const s = readJson(statePath); return s && s.status === 'paused' ? s : null }, 5_000)
    const expectUntil = tPause + 30 * 60_000
    check('T20 state.json status=paused,pausedUntil ≈ 现在 + 30 分钟(±60s)', !!stP && stP.enabled === true && Math.abs(stP.pausedUntil - expectUntil) < 60_000,
      { state: readJson(statePath), expectUntil })
    const resumeBtn = sp.locator('.ch-page').getByRole('button', { name: L.zh.resume, exact: true })
    check('T21 UI 显示已暂停并给出「恢复记录」', (await waitStatus(sp, 'paused', 4_000)) && (await resumeBtn.count()) === 1, { status: await chStatus(sp) })
    await sp.waitForTimeout(2_000)
    check('T22 暂停期间不再重连(2s 内无新订阅)', helper.subscribes().length === beforePause && helper.open().length === 0, { subs: helper.subscribes().length, before: beforePause })
    await resumeBtn.first().click()
    await until(() => helper.subscribes().length > beforePause && helper.open().length === 1, 6_000)
    const stR = await until(() => { const s = readJson(statePath); return s && s.status === 'recording' && s.pausedUntil === null ? s : null }, 5_000)
    check('T23 恢复 → 重新 recordSubscribe、开着 1 条、state.json 回 recording', helper.subscribes().length === beforePause + 1 && helper.open().length === 1 && !!stR && (await chStatus(sp)) === 'recording',
      { subs: helper.subscribes().length, open: helper.open().length, state: readJson(statePath) })

    // ── ⑦ 清除全部(带确认)──
    const beforeClear = helper.subscribes().length
    await sp.locator('.ch-page [data-clear="all"]').click()
    const clearConfirm = await sp.locator('.ch-page .ch-confirm:not(.ch-confirm--consent)').first().waitFor({ timeout: 4_000 }).then(() => true, () => false)
    check('T24 点「全部」只出确认条,文件还在(确认前不删)', clearConfirm && jsonlFiles(eventsDir).length > 0, { confirm: clearConfirm, files: jsonlFiles(eventsDir) })
    await shots(sp, 'zh-light-clear-confirm', ['bottom'])
    await sp.locator('.ch-page .ch-confirm .btn.danger').first().click()
    const emptied = await until(() => jsonlFiles(eventsDir).length === 0, 5_000)
    check('T25 确认删除 → events/ 下没有任何 .jsonl', !!emptied, { files: jsonlFiles(eventsDir), all: fs.existsSync(eventsDir) ? fs.readdirSync(eventsDir) : null })
    const cleared = await sp.locator('.ch-page .ch-cleared').first().waitFor({ timeout: 4_000 }).then(() => true, () => false)
    const emptyPreview = await until(async () => (await sp.locator('.ch-session').count()) === 0, 4_000)
    check('T26 显示「已清除」且今日预览清空', cleared && !!emptyPreview, { cleared, sessions: await sp.locator('.ch-session').count() })
    await until(() => helper.subscribes().length > beforeClear && helper.open().length === 1, 6_000)
    check('T27 清除=断开重订阅(helper 丢差分基线):新订阅 1 条、开着 1 条', helper.subscribes().length === beforeClear + 1 && helper.open().length === 1,
      { subs: helper.subscribes().length, before: beforeClear, open: helper.open().length })
    await sleep(1_500)
    check('T27b 重订阅后没有任何事件回灌(目录仍空)', jsonlFiles(eventsDir).length === 0, jsonlFiles(eventsDir))

    // ── ⑧ 深色:录制态截图 → 关掉 → 同意条截图 ──
    helper.stream(sessionEvents(Date.now() - 90_000))
    await sleep(1_600)
    check('T28 设置 → 外观 → 暗色(documentElement.dataset.mode=dark)', await setMode(sp, 'zh', 'dark'))
    await gotoTab(sp, L.zh.ch, '.ch-page')
    await sp.locator('.ch-page').getByRole('button', { name: L.zh.refresh, exact: true }).first().click()
    await until(async () => (await sp.locator('.ch-session').count()) >= 3, 4_000)
    await shots(sp, 'zh-dark-recording')
    note('[zh-dark-recording] 预览时间 / 主机名(text-faint)对比度', JSON.stringify({ time: (await contrastOf(sp, '.ch-session-time'))?.ratio, host: (await contrastOf(sp, '.ch-session-host'))?.ratio, hint: (await contrastOf(sp, '.ch-page .settings-control-list .settings-row-description, .ch-page .settings-control-list small, .ch-page .settings-control-list p'))?.ratio }))

    const beforeOff = helper.subscribes().length
    await sp.locator('.ch-page [role="switch"]').first().click()
    const stOff = await until(() => { const s = readJson(statePath); return s && s.enabled === false && s.status === 'off' ? s : null }, 5_000)
    check('T29 关开关(无需确认)→ state.json {enabled:false, status:"off"}', !!stOff && (await waitStatus(sp, 'off', 4_000)), readJson(statePath))
    check('T30 关掉 → 订阅连接全关', !!(await until(() => helper.open().length === 0, 4_000)), { open: helper.open().length })
    check('T31 关掉落进配置 computerHistoryEnabled:false', readJson(cfgPath)?.computerHistoryEnabled === false, readJson(cfgPath))
    await sp.waitForTimeout(2_000)
    check('T32 关着 2s 内不再连 helper', helper.subscribes().length === beforeOff && helper.open().length === 0, { subs: helper.subscribes().length, before: beforeOff })

    await sp.locator('.ch-page [role="switch"]').first().click()
    const consent2 = await sp.locator('.ch-confirm--consent').first().waitFor({ timeout: 4_000 }).then(() => true, () => false)
    check('T33 深色下再开 → 同意条出现、开关仍关、没发订阅', consent2 && (await switchChecked(sp)) === 'false' && helper.subscribes().length === beforeOff)
    await shots(sp, 'zh-dark-consent', ['top'])
    await consentContrast(sp, 'zh-dark-consent')
    await sp.locator('.ch-confirm--consent .btn.ghost').first().click()
    await sp.waitForTimeout(600)
    check('T34 同意条点「取消」→ 收起、开关仍关、仍无订阅', (await sp.locator('.ch-confirm--consent').count()) === 0 && (await switchChecked(sp)) === 'false' && helper.subscribes().length === beforeOff)

    // ── ⑨ 英文 + 浅色:同意条 → 开 → 录制态截图 → 关 ──
    const toEn = (await gotoTab(sp, L.zh.about, '.locale-seg'))
      && await sp.locator('.locale-seg button').nth(1).click().then(() => true, () => false)
      && await sp.waitForFunction(() => document.documentElement.lang === 'en', null, { timeout: 6_000 }).then(() => true, () => false)
    check('T35 设置 → 关于 → English(documentElement.lang=en)', toEn)
    check('T35b 浅色(英文界面下切回 Light)', await setMode(sp, 'en', 'light'))
    const enNav = await gotoTab(sp, L.en.ch, '.ch-page')
    note('英文界面下设置浮窗顶栏标题(.floating-native-chrome)', JSON.stringify(await sp.locator('.floating-native-chrome').first().innerText().catch(() => null)))
    const enLabel = await sp.locator('.ch-page [role="switch"]').first().getAttribute('aria-label').catch(() => null)
    check('T36 左栏英文「Computer history」,开关可访问名 = Record computer history', enNav && enLabel === 'Record computer history', { enNav, enLabel })
    await sp.locator('.ch-page [role="switch"]').first().click()
    const consent3 = await sp.locator('.ch-confirm--consent').first().waitFor({ timeout: 4_000 }).then(() => true, () => false)
    const consentText = consent3 ? await sp.locator('.ch-confirm--consent').first().innerText() : ''
    check('T37 英文同意条无汉字残留', consent3 && !/[一-鿿]/.test(consentText), consentText.slice(0, 160))
    await shots(sp, 'en-light-consent', ['top'])
    await consentContrast(sp, 'en-light-consent')
    const beforeEn = helper.subscribes().length
    await sp.locator('.ch-confirm--consent .btn.primary').first().click()
    await waitStatus(sp, 'recording')
    await until(() => helper.subscribes().length > beforeEn && helper.open().length === 1, 5_000)
    const enPol = helper.subscribes().at(-1)?.policy
    check('T38 英文界面重开 → 新订阅带着持久化的排除表(com.apple.Health)', helper.open().length === 1 && (enPol?.excludeBundleIds || []).includes('com.apple.Health'), enPol?.excludeBundleIds)
    const base3 = Date.now() - 90_000
    helper.stream(sessionEvents(base3))
    const day3 = path.join(eventsDir, `${localDay(base3)}.jsonl`)
    const ok3 = await until(() => (readLines(day3) || []).some((l) => l.text && l.text.includes('E2E_VSCODE_TEXT')), 5_000)
    check('T39 英文界面下事件照常落盘', !!ok3)
    await sp.locator('.ch-page').getByRole('button', { name: L.en.refresh, exact: true }).first().click()
    await until(async () => (await sp.locator('.ch-session').count()) >= 3, 4_000)
    const pageText = await sp.locator('.ch-page').innerText()
    const zhLeft = (pageText.match(/[一-鿿][^\n]{0,20}/g) || []).slice(0, 5)
    check('T40 英文「电脑历史」页正文无汉字残留', zhLeft.length === 0, zhLeft)
    await shots(sp, 'en-light-recording')
    note('[en-light-recording] 预览时间 / 主机名(text-faint)对比度', JSON.stringify({ time: (await contrastOf(sp, '.ch-session-time'))?.ratio, host: (await contrastOf(sp, '.ch-session-host'))?.ratio, hint: (await contrastOf(sp, '.ch-page .settings-control-list .settings-row-description, .ch-page .settings-control-list small, .ch-page .settings-control-list p'))?.ratio }))

    await sp.locator('.ch-page [role="switch"]').first().click()
    const stOff2 = await until(() => { const s = readJson(statePath); return s && s.enabled === false && s.status === 'off' ? s : null }, 5_000)
    await until(() => helper.open().length === 0, 4_000)
    check('T41 最终关掉:state.json enabled:false、订阅全关', !!stOff2 && helper.open().length === 0, { state: readJson(statePath), open: helper.open().length })

    // ── 证据 ──
    const chErr = rendererErrors.filter((e) => /computer.?history|ch-page|computerHistory/i.test(e))
    check('T42 渲染层没有电脑历史相关报错', chErr.length === 0, chErr)
    const chLog = mainLog.join('').split('\n').filter((l) => l.includes('[computer-history]'))
    note('主进程 [computer-history] 日志', chLog.length ? chLog.slice(0, 10).join(' ‖ ') : '(无)')
    note('假 helper 收到的命令计数', JSON.stringify(helper.cmds()))
    if (rendererErrors.length) note(`渲染层其它报错 ${rendererErrors.length} 条(与本功能无关的噪音,仅供参考)`, rendererErrors.slice(0, 5).join(' ‖ '))
  } catch (e) {
    console.error('BODY ERROR:', (e && e.stack) || e)
    bodyFailed = true
    check('脚本主体跑完没有抛错', false, String(e && e.message || e))
    try {
      const pages = app ? app.windows() : []
      for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(SHOT_DIR, `FAIL-window${i}.png`) }).catch(() => {})
      console.error('失败截图 →', SHOT_DIR)
      const chLog = mainLog.join('').split('\n').filter((l) => /computer-history|error/i.test(l)).slice(-15)
      if (chLog.length) console.error('主进程日志尾:\n' + chLog.join('\n'))
      if (rendererErrors.length) console.error('渲染层报错:\n' + rendererErrors.slice(-10).join('\n'))
    } catch { /* 取证尽力而为 */ }
  } finally {
    mark('台架 closeApp(此后的关闭 / 退出是台架自己收尾)')
    await closeApp(app)
    if (bodyFailed) dumpLife(life, mainLog) // 收尾之后再打:主进程退出(码 + 信号)的回调此时一定已到
    await helper.close().catch(() => {})
    if (!KEEP) {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(sockDir, { recursive: true, force: true })
    } else note('--keep', `home=${home} sock=${sock}`)
  }
}

/**
 * 第二段:真 helper_missing。PI_CU_SOCKET_PATH 不设(externalSocket=false)→ socket 落在 <HOME>/Library/Caches/…;
 * HOME 覆写到临时目录 → 那里没人听;PI_COMPUTER_USE_HELPER_APP_PATH 指向不存在的 .app → launchHelper 判「没装」,
 * 不 `open -n` 任何东西。期望:开启后状态 helper_missing,页内挂出辅助功能权限卡。**不点卡上的安装按钮。**
 */
async function missingPhase(stub) {
  // ⚠️ socket 路径 = <HOME>/Library/Caches/tangu-computer-use/bridge.sock(46 字节后缀),macOS 上限 104 字节:
  //    HOME 放 os.tmpdir()(/var/folders/…/T/,49 字节)下会超 → connect 报 EINVAL → 落 disconnected 而不是 helper_missing
  //    (第一版就这么假红的)。/tmp 短,优先用它。
  let shortRoot = os.tmpdir()
  try { fs.accessSync('/tmp', fs.constants.W_OK); shortRoot = '/tmp' } catch { /* 退回 tmpdir,可能超长 */ }
  const home = fs.mkdtempSync(path.join(shortRoot, 'fchm-'))
  const fakeApp = path.join(home, 'NotInstalled', 'tangu-computer-use.app')
  const sockUnderHome = path.join(home, 'Library', 'Caches', 'tangu-computer-use', 'bridge.sock')
  if (Buffer.byteLength(sockUnderHome) > 103) {
    skip('M1-M3 helper_missing 分支', `临时 HOME 下的 socket 路径 ${Buffer.byteLength(sockUnderHome)} 字节,超 macOS 104 字节上限`)
    fs.rmSync(home, { recursive: true, force: true })
    return
  }
  let app, mainLog = [], life = []
  try {
    ;({ app, mainLog, life } = await launchApp(home, null, stub.url, { HOME: home, PI_COMPUTER_USE_HELPER_APP_PATH: fakeApp }))
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 40_000 })
    await skipOnboarding(win)
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 }).catch(() => {})
    const sp = await openSettings(app, win)
    const bw = await app.browserWindow(sp)
    await bw.evaluate((w) => { w.setContentSize(1040, 1000); w.center() }).catch(() => {})
    await setMode(sp, 'zh', 'light')
    if (!(await gotoTab(sp, L.zh.ch, '.ch-page'))) { skip('M1 helper_missing 分支', '第二段没能打开电脑历史页'); return }
    await sp.locator('.ch-page [role="switch"]').first().click()
    await sp.locator('.ch-confirm--consent .btn.primary').first().click().catch(() => {})
    const missing = await waitStatus(sp, 'helper_missing', 12_000)
    const st = readJson(path.join(home, 'computer-history', 'state.json'))
    check('M1 没装 helper(非外部 socket)→ 状态 helper_missing(UI + state.json)', missing && st?.status === 'helper_missing', { ui: await chStatus(sp), state: st })
    const card = await sp.locator('.ch-page .ch-permission').first().waitFor({ timeout: 6_000 }).then(() => true, () => false)
    check('M2 helper_missing 时页内挂出辅助功能权限卡', card)
    check('M3 没有在临时 HOME 下凭空拉起 helper(socket 不存在)', !fs.existsSync(sockUnderHome))
    await sp.locator('.ch-page .ch-permission [data-permission="computerAccessibility"]').first().waitFor({ timeout: 8_000 }).catch(() => {})
    const lay = await sp.evaluate(() => {
      const panels = [...document.querySelectorAll('.ch-page .settings-panel')]
      const refresh = document.querySelector('.ch-page [data-ch-refresh-status]')
      const card = document.querySelector('.ch-page .ch-permission')
      const cs = card ? getComputedStyle(card) : null
      const left = (el) => el?.getBoundingClientRect().left
      const right = (el) => el?.getBoundingClientRect().right
      return {
        refreshInStatusRow: !!refresh && !!panels[0]?.contains(refresh) && !!refresh.closest('.settings-control-row'),
        cardIsPanel: !!card?.classList.contains('settings-panel'), cardBorder: cs ? parseFloat(cs.borderTopWidth) : 0,
        headLeft: [left(panels[0]?.querySelector('.settings-panel-icon')), left(card?.querySelector('.settings-panel-icon'))],
        btnRight: [right(refresh), right(card?.querySelector('[data-permission] .btn'))],
        pauseRow: !!document.querySelector('.ch-page .ch-btn-row'),
        cardToolbar: !!card?.querySelector('.desktop-permissions-toolbar'),
      }
    })
    check('M4 helper_missing 版式:「刷新状态」在首张面板状态行;权限卡是同页面板(有描边、图标左缘与按钮右缘对齐首张面板);不给暂停',
      lay.refreshInStatusRow && lay.cardIsPanel && lay.cardBorder > 0 && !lay.cardToolbar && !lay.pauseRow
        && Math.abs(lay.headLeft[0] - lay.headLeft[1]) <= 0.5 && Math.abs(lay.btnRight[0] - lay.btnRight[1]) <= 0.5, lay)
    await shots(sp, 'zh-light-helper-missing', ['top'])
    await sp.locator('.ch-page [role="switch"]').first().click() // 关掉,别让它在退避里反复试
    await waitStatus(sp, 'off', 5_000)
    const chLog = mainLog.join('').split('\n').filter((l) => l.includes('[computer-history]'))
    if (chLog.length) note('第二段主进程 [computer-history] 日志', chLog.slice(0, 5).join(' ‖ '))
  } catch (e) {
    console.error('MISSING PHASE ERROR:', (e && e.stack) || e)
    dumpLife(life, mainLog)
    check('第二段(helper_missing)跑完没有抛错', false, String(e && e.message || e))
    try { for (const [i, p] of (app ? app.windows() : []).entries()) await p.screenshot({ path: path.join(SHOT_DIR, `FAIL-missing-window${i}.png`) }).catch(() => {}) } catch { /* ignore */ }
  } finally {
    await closeApp(app)
    if (!KEEP) fs.rmSync(home, { recursive: true, force: true })
  }
}

async function main() {
  if (process.platform !== 'darwin') { console.log('SKIP  电脑历史只在 macOS 采集,本台架只在 darwin 上跑'); process.exit(0) }
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  if (!fs.readFileSync(path.join(ROOT, 'out/main/main.js'), 'utf8').includes('recordSubscribe')) {
    console.error('out/main/main.js 里没有 recordSubscribe —— 产物是旧的,先跑 npm run build')
    process.exit(1)
  }
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  acquireLock()
  let stub = null
  try {
    stub = await startStubEngine({ sessions: [], messages: [], models: [] })
    await mainPhase(stub)
    if (!SKIP_MISSING) await missingPhase(stub)
    else skip('M1-M3 helper_missing 分支', NC ? '负对照模式不跑第二段' : '--skip-missing')
  } finally {
    try { stub && stub.close() } catch { /* 同步 close,无 promise */ }
    releaseLock()
  }
  const passed = results.filter((r) => r.ok === true).length
  const failed = results.filter((r) => !r.skipped && r.ok !== true).length
  const unverified = results.filter((r) => r.skipped).length
  console.log(`\n${passed} passed / ${failed} failed / ${unverified} 未验  (总 ${results.length}${passed + failed + unverified === results.length ? '' : ' ⚠️ 三数之和 ≠ 总数'})`)
  console.log(`截图 → ${SHOT_DIR}`)
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); releaseLock(); process.exit(1) })
