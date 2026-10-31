/**
 * 插件沙箱(方案 A,tangu-agent/docs/plugin-sandbox.md)的端到端契约(真 Electron 父进程 + 它真起的沙箱子进程)。
 *
 * 证的是:
 *   1 引擎发 client_cmd(plugin.start)→ 渲染层 claim(digest = body 的 sha256)→ 主进程真起一份 Forsion → result 回到引擎,
 *     带运行态状态(视图注册了、插件自己的 console 在)和一张 JPEG 截图
 *   2 隔离:沙箱的 userData / home / 工作区 / 智库都在 <forsionHome>/sandbox/<id> 下;用户这份的智库一个文件都没多
 *   3 保存即重载:改 main.js → 子进程监视到 → 新标记出现、loads 增加
 *   4 在沙箱里跑插件命令;命令里调 window.tangu.sandbox.action('report') → 父进程把话放进对话输入框
 *   5 setup 抛错 → 状态 failed,带原文
 *   6 对话卡:工具结果里嵌的状态画成沙箱卡,「打开沙箱窗口」可点
 *   7 安装到我的 Forsion(确认框在台架里自动点「安装」)→ plugins/<id> 出现,不带 node_modules
 *   8 停止 → 子进程退出;再关父进程不留孤儿
 *   9 负对照:非插件文件夹 → invalid_args,不起进程
 *  10 (`--focus`,仅 macOS,会真把窗口叫到前面几秒)「打开沙箱窗口」第一次、以及被别的窗口盖住之后再点一次,
 *     沙箱窗口都排在屏幕最前(读系统窗口列表的前后顺序)
 *
 * ⚠️ 量的是 out/ 里的产物,源码改了没 `npm run build` 就是白测。
 * 跑:node .claude/hooks/devlock.cjs run --vehicle=e2e --what="plugin sandbox" -- npm run check:pluginsandbox
 * `SHOT_DIR=<目录>` 额外落沙箱窗口截图(子进程自己截的那张)与对话卡截图;`-- --focus` 加跑第 10 项(会抢几秒前台)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-plugsbx-'))
const UD = path.join(home, 'userdata')
const VAULT = path.join(home, 'vault')
const PLUGIN_ID = 'sbx-fixture'
const PLUGIN = path.join(home, 'projects', PLUGIN_ID)
const SBX = path.join(home, 'sandbox', PLUGIN_ID)
const SHOT_DIR = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : null

const mainJs = (marker) => `console.log('${marker}')
console.log('SBX_SKIN ' + document.documentElement.dataset.skin)
ctx.registerView({ id: 'fixture-view', title: 'Sandbox fixture', mount(el) { const b = document.createElement('h1'); b.textContent = '${marker}'; el.append(b); return () => b.remove() } })
ctx.registerCommand({ id: 'fixture-ping', title: 'Fixture ping', run(a) { console.log('FIXTURE_PING ' + JSON.stringify(a || {})) } })
ctx.registerCommand({ id: 'fixture-report', title: 'Fixture report', run() { window.tangu.sandbox.action('report', 'FIXTURE_NOTE_FROM_SANDBOX') } })
return () => {}
`
function writePlugin(source) {
  fs.mkdirSync(path.join(PLUGIN, 'node_modules', 'dep'), { recursive: true })
  fs.writeFileSync(path.join(PLUGIN, 'manifest.json'), JSON.stringify({ id: PLUGIN_ID, name: 'Sandbox fixture', version: '0.0.3', apiVersion: 1, main: 'main.js' }))
  fs.writeFileSync(path.join(PLUGIN, 'node_modules', 'dep', 'index.js'), '1')
  fs.writeFileSync(path.join(PLUGIN, 'main.js'), source)
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 600) : ''}`)
}
async function until(read, timeout = 20_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    try { const v = await read(); if (v) return v } catch { /* 途中 */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}
/** 只比文件:用户那份打开对话时自己会在智库里建空的 Sessions/ 目录,与沙箱无关。 */
const listFiles = (dir) => listTree(dir).filter((p) => fs.statSync(path.join(dir, p)).isFile())
const listTree = (dir) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(path.relative(dir, p)); if (e.isDirectory()) walk(p) } }; if (fs.existsSync(dir)) walk(dir); return out.sort() }
const FOCUS = process.argv.includes('--focus') && process.platform === 'darwin'
/** 屏幕上普通层级(0)的大窗口,从前到后的属主 pid(CGWindowList 本来就按前后排;只读层级与尺寸,不要屏幕录制权限)。 */
const JXA_FRONT = `ObjC.import('CoreGraphics'); function run() { return JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0))).filter((w) => w.kCGWindowLayer == 0 && w.kCGWindowBounds.Width > 300 && w.kCGWindowBounds.Height > 200).map((w) => String(w.kCGWindowOwnerPID))) }`
const frontPids = () => JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', JXA_FRONT]).toString())
/** 把某个进程真的变成前台 App(像用户点了它的窗口),再读前台是谁。只排窗口不够:前台 App 不让,后台进程的 focus 会被系统拒掉。 */
const activatePid = (pid) => execFileSync('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); function run(a) { $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(a[0])).activateWithOptions($.NSApplicationActivateAllWindows); delay(0.6); return String($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier) }`, String(pid)]).toString().trim()
const sandboxPids = () => { try { return execFileSync('pgrep', ['-f', path.join(SBX, 'userdata')], { encoding: 'utf8' }).trim().split('\n').filter(Boolean) } catch { return [] } }
const saveShot = (name, dataUrl) => { if (SHOT_DIR && dataUrl) { fs.mkdirSync(SHOT_DIR, { recursive: true }); fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(dataUrl.split(',')[1], 'base64')) } }

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  writePlugin(mainJs('SBX_MARK_ONE'))
  fs.mkdirSync(VAULT, { recursive: true })
  fs.writeFileSync(path.join(VAULT, 'mine.md'), '# my note\n')
  fs.mkdirSync(`${UD}-dev`, { recursive: true })
  fs.writeFileSync(path.join(`${UD}-dev`, 'amadeus-config.dev.json'), JSON.stringify({ localVault: VAULT, lastVault: VAULT }))
  const vaultBefore = listFiles(VAULT)

  // 引擎这头:client_cmd 的 claim / result 走 /inquiries/cc_*(契约 phone-control.md §3.2),这里记下来对答案
  const claims = []
  const results_ = []
  const ACK = 'cc_check_1'
  const body = JSON.stringify({ v: 1, runId: 'r1', sessionId: 'sbx-s1', ackId: ACK, ns: 'plugin', op: 'start', args: { dir: PLUGIN }, iat: Date.now(), target: { kind: 'origin' } })
  const stub = await startStubEngine({
    sessions: [{ id: 'sbx-s1', title: 'Sandbox check', summary: '', model_id: 'm1', archived: false, emoji: null, agent_config: null, project_path: '/tmp/sbx-demo', project_name: 'sbx-demo', created_at: '2026-10-23 09:00:00', updated_at: '2026-10-23 09:00:00' }],
    messages: [],
    override: async ({ path: p, method, body: read }) => {
      if (method !== 'POST' || !p.includes('/inquiries/cc_')) return undefined
      const b = await read()
      if (b.phase === 'claim') { claims.push(b); return { ok: true, nonce: 'nonce-1', execMs: 90_000 } }
      if (b.phase === 'result') { results_.push(b); return { ok: true } }
      return { __code: 410, body: { detail: 'gone' } }
    },
  })

  const errs = []
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${UD}`, '--lang=zh-CN', ROOT],
      cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      timeout: 45_000,
    })
    const win = await app.firstWindow()
    win.setDefaultTimeout(15_000)
    win.on('pageerror', (e) => errs.push(String((e && e.message) || e)))
    await win.setViewportSize({ width: 1500, height: 900 })
    await win.waitForSelector('#root', { state: 'attached', timeout: 45_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) { const b = win.locator(`text=${label}`).first(); if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break } }
    await win.waitForSelector('.dv-groupview', { timeout: 45_000 })
    // 确认框在台架里自动点「安装」(第 0 个按钮);别的对话框不受影响
    await app.evaluate(({ dialog }) => { const orig = dialog.showMessageBox; dialog.showMessageBox = async (w, o) => ((o && o.title) === '安装插件' || (o && o.title) === 'Install plugin' ? { response: 0, checkboxChecked: false } : orig.call(dialog, w, o)) })

    check('0 用户那份声明了 plugin.sandbox(桌面能力面装上了)',
      await win.evaluate(() => !!window.tangu?.pluginSandbox && !window.tangu?.sandbox))

    // ── 1 走一遍真实的 run:工具调用 → client_cmd → 渲染层 claim → 主进程起沙箱 → result ──
    // 用户这份换成非缺省的主题色:沙箱首屏要跟上(能力面每次 exec 带上 forsion_theme* 键)
    await win.evaluate(() => localStorage.setItem('forsion_theme_skin', 'coral'))
    await win.evaluate(() => {
      const b = [...document.querySelectorAll('button.rb-space')].find((x) => /Agent|Tangu/.test(x.getAttribute('aria-label') || x.getAttribute('title') || x.textContent || ''))
      b?.click()
    })
    await win.waitForTimeout(1500)
    if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) { await win.click('.dv-edge-left').catch(() => {}); await win.waitForTimeout(700) }
    await win.locator('.t2s-srow', { hasText: 'Sandbox check' }).first().click()
    await win.waitForTimeout(900)
    const embedded = (st) => `Running: plugin "Sandbox fixture" 0.0.3.\n<sandbox-status>${JSON.stringify(st)}</sandbox-status>`
    // 真引擎这时阻塞在 requestClientAction 上:run 挂住,等 result 到了再收尾(stub.finish)
    stub.script([
      { type: 'tool_call', delay: 100, payload: { id: 'ts1', name: 'plugin_sandbox', arguments: JSON.stringify({ action: 'start', path: PLUGIN }) } },
      { type: 'client_cmd', delay: 100, payload: { ackId: ACK, ns: 'plugin', body } },
      { type: '__hold' },
    ])
    const ta = win.locator('.t2c-ta').first()
    await ta.click(); await ta.fill('try the plugin in the sandbox'); await win.keyboard.press('Enter')

    const res = await until(() => results_[0], 75_000)
    const st = res && res.text ? JSON.parse(res.text) : null
    const digest = crypto.createHash('sha256').update(body, 'utf8').digest('hex')
    check('1a 渲染层按契约 claim:digest = body 的 sha256,claimant 合规', claims[0] && claims[0].digest === digest && /^[A-Za-z0-9_-]{16,64}$/.test(claims[0].claimant || ''), JSON.stringify(claims[0] || null))
    check('1b result 回到引擎:ok、running、视图注册了、插件自己的 console 在、带 JPEG 截图',
      res && res.ok === true && res.nonce === 'nonce-1' && st?.state === 'running' && st.views.includes('fixture-view')
      && st.logs.some((l) => l.text.includes('SBX_MARK_ONE')) && /^data:image\/jpeg;base64,/.test(res.image || ''),
      JSON.stringify({ ok: res && res.ok, state: st?.state, views: st?.views, logs: st?.logs?.slice(-3), image: (res?.image || '').slice(0, 30), error: res?.error }))
    check('1c 外观跟着用户那份:沙箱首屏的主题色 = 用户这份的(coral)', !!st?.logs.some((l) => l.text === 'SBX_SKIN coral'), JSON.stringify(st?.logs?.filter((l) => l.text.startsWith('SBX_SKIN'))))
    saveShot('sandbox-window.jpg', res?.image)
    if (st) stub.finish('r1', [{ type: 'tool_result', payload: { id: 'ts1', name: 'plugin_sandbox', result: embedded(st), elapsedMs: 5000 } }, { type: 'done', payload: {} }])

    // ── 2 隔离 ──
    const cfg = JSON.parse(fs.readFileSync(path.join(SBX, 'userdata-dev', 'tangu-desktop-config.json'), 'utf8'))
    check('2 隔离:沙箱的数据都在 sandbox/<id> 下,引擎指向死端口;用户这份的智库没多一个文件',
      fs.existsSync(path.join(SBX, 'home')) && fs.existsSync(path.join(SBX, 'vault')) && cfg.mode === 'external' && /127\.0\.0\.1:1$/.test(cfg.backendUrl)
      && JSON.stringify(listFiles(VAULT)) === JSON.stringify(vaultBefore) && sandboxPids().length > 0,
      JSON.stringify({ vault: listTree(VAULT), sbx: fs.readdirSync(SBX), pids: sandboxPids() }))

    const exec = (op, args = {}) => win.evaluate(([o, a]) => window.tangu.pluginSandbox.exec(o, a, { sessionId: 'sbx-s1', ui: { storage: {} } }), [op, args])
    const status = async () => { const r = await exec('status'); return r.ok ? JSON.parse(r.text) : null }

    // ── 3 保存即重载 ──
    writePlugin(mainJs('SBX_MARK_TWO'))
    const two = await until(async () => { const s = await status(); return s && s.logs.some((l) => l.text.includes('SBX_MARK_TWO')) && s.loads >= 2 && s }, 25_000)
    check('3 保存即重载:新标记出现、loads 增加', !!two, JSON.stringify(two ? { loads: two.loads } : await status()))

    // ── 4 命令 + 报告问题 ──
    const ping = await exec('command', { command: 'fixture-ping', args: { n: 7 } })
    const pinged = await until(async () => (await status())?.logs.some((l) => l.text.includes('FIXTURE_PING {"n":7}')), 10_000)
    const missing = await exec('command', { command: 'nope' })
    check('4a 在沙箱里跑插件命令(参数原样到);不存在的命令回可用列表', ping.ok && pinged && /fixture-ping/.test(missing.error || ''), JSON.stringify({ ping: ping.error, missing: missing.error }))
    await exec('command', { command: 'fixture-report' })
    const drafted = await until(async () => (await ta.inputValue().catch(() => '')).includes('FIXTURE_NOTE_FROM_SANDBOX'), 10_000)
    check('4b 沙箱窗口里「报告问题」→ 回到发起的对话,话放进输入框', drafted, await ta.inputValue().catch(() => ''))

    // ── 6 对话卡 ──
    const card = await until(() => win.locator('[data-sandbox-card]').first().isVisible().catch(() => false), 30_000)
    if (SHOT_DIR && card) await win.locator('[data-sandbox-card]').first().screenshot({ path: path.join(SHOT_DIR, 'sandbox-card.png') })
    const cardText = card ? await win.locator('[data-sandbox-card]').first().textContent() : ''
    check('6 对话卡:工具结果画成沙箱卡,带「打开沙箱窗口」', card && /Sandbox fixture/.test(cardText) && await win.locator('[data-sandbox-card] button.primary').count() === 1, cardText)

    // ── 5 setup 抛错 ──
    writePlugin(`throw new Error('SBX_SETUP_EXPLODED')\n`)
    const failed = await until(async () => { const s = await status(); return s && s.state === 'failed' && (s.setupError || '').includes('SBX_SETUP_EXPLODED') && s }, 25_000)
    check('5 setup 抛错 → failed,带原文', !!failed, JSON.stringify(await status()))
    writePlugin(mainJs('SBX_MARK_THREE'))
    await until(async () => (await status())?.state === 'running', 25_000)

    // ── 7 安装 ──
    const inst = await win.evaluate(() => window.tangu.pluginSandbox.install())
    check('7 安装到我的 Forsion:plugins/<id> 出现,不带 node_modules', inst.ok && fs.existsSync(path.join(home, 'plugins', PLUGIN_ID, 'main.js')) && !fs.existsSync(path.join(home, 'plugins', PLUGIN_ID, 'node_modules')), JSON.stringify(inst))

    // ── 9 负对照 ──
    const notPlugin = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-plugsbx-not-'))
    const bad = await exec('start', { dir: notPlugin })
    check('9 负对照:不是插件的文件夹 → invalid_args;原来那个沙箱照旧在', bad.ok === false && bad.code === 'invalid_args' && (await status())?.pluginId === PLUGIN_ID, JSON.stringify(bad))

    // ── 10 打开沙箱窗口:第一次 + 被盖住之后再点一次 ──
    if (FOCUS) {
      await win.evaluate(() => window.tangu.pluginSandbox.show())
      await win.waitForTimeout(1000)
      const first = frontPids()
      // 像用户回到自己那份 Forsion:父窗抬回普通层、排到最前,盖住沙箱窗口
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.isVisible()); w.setAlwaysOnTop(false); w.showInactive() })
      const activeApp = activatePid(app.process().pid)
      await win.waitForTimeout(800)
      const covered = frontPids()
      await win.evaluate(() => window.tangu.pluginSandbox.show())
      await win.waitForTimeout(1000)
      const again = frontPids()
      const pids = sandboxPids(), parent = String(app.process().pid)
      check('10a 打开沙箱窗口(第一次)→ 沙箱窗口在屏幕最前', pids.includes(first[0]), JSON.stringify({ front: first.slice(0, 3), pids }))
      check('10b 被盖住之后再点一次 → 还是回到最前', covered[0] !== again[0] && pids.includes(again[0]), JSON.stringify({ activeApp, covered: covered.slice(0, 3), again: again.slice(0, 3), parent, pids }))
      // 用户在界面上点「重置数据」(卡片 / Coding Studio / 沙箱窗口):新起的那份要出现在最前,不能压在所有窗口下面
      await win.evaluate(() => window.tangu.pluginSandbox.reset())
      await win.waitForTimeout(1500)
      const afterReset = frontPids(), pids2 = sandboxPids()
      check('10c 界面上点了重置 → 新起的沙箱窗口在最前', pids2.includes(afterReset[0]), JSON.stringify({ front: afterReset.slice(0, 3), pids: pids2 }))
    }

    // ── 8 停止 ──
    await win.evaluate(() => window.tangu.pluginSandbox.stop())
    const gone = await until(() => sandboxPids().length === 0, 15_000)
    const after = await win.evaluate(() => window.tangu.pluginSandbox.state())
    check('8a 停止 → 子进程退出,状态 running:false', gone && after.running === false, JSON.stringify({ pids: sandboxPids(), after }))
    await exec('start', { dir: PLUGIN })
    await app.close(); app = null
    const orphan = await until(() => sandboxPids().length === 0, 15_000)
    check('8b 关掉用户那份 → 沙箱跟着退,不留孤儿', orphan, JSON.stringify(sandboxPids()))

    check('全程无渲染层异常', errs.length === 0, errs.slice(0, 3).join(' / '))
  } finally {
    if (app) await app.close().catch(() => {})
    for (const pid of sandboxPids()) try { process.kill(Number(pid), 'SIGKILL') } catch { /* 已退 */ }
    stub.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}
main().catch((e) => { console.error(e); for (const pid of sandboxPids()) try { process.kill(Number(pid), 'SIGKILL') } catch { /* */ } process.exit(1) })
