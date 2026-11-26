/** 插件桌面小窗的真 Electron 台架(2026-11-26,方案页 docs/ToBeImproved/插件桌面小窗方案_2026-11-26;主进程 electron/pluginDesktopWindows.ts,
 *  渲染层 frontend/src/pluginDesktopWindow.ts)。探针插件经 ctx.workspace.open(view, { layer: { float: 'desktop' }, form: 'bare' }) 开小窗,看:
 *  ① 开成一扇透明、无边框、置顶、不可聚焦、和主窗同一个渲染进程的子窗,视图拿到 surface 'desktop' 和控制器;
 *  ② 视图真画进去了(子窗截图:角落全透明、中间有颜色),主题样式跟过去了(--accent-ink 解出来的颜色);
 *  ③ 挪窗夹在屏内(至少 32 px),主进程的窗口位置一致;改大小夹到工作区一半;
 *  ④ 点穿:缺省先点穿;鼠标移到宠物上接住、移到空白处点穿;setClickThrough('none') 整扇接住;
 *  ⑤ 同 key 再开不另开、只换参数;每个插件最多 3 扇(第 4 扇 limit);
 *  ⑥ 没声明 desktopWindow / 用户拒过 → 回落成窗口里的 bare 浮层(没有标题行);
 *  ⑦ 主窗藏起来:小窗还在、小窗的帧回调照跑;
 *  ⑧ 插件停用:它的小窗全关、清理跑了;再启用再开回到上次的位置;
 *  ⑨ 主窗重载:小窗全关;⑩ ctx.ui.float('desktop') 照旧报错;没有渲染层报错。
 *  另有:子窗页面自己的 moveTo / resizeTo 不认;⑥b 不预置授权的插件第一次开问一次、记住、撤回后关窗并再问(对话框在主进程替用户点);
 *  ⑪ 开着一扇挪过位置的小窗退出:20 s 内退干净、主进程没有未捕获异常、位置落盘。
 *  负对照(11-26 实跑红):去掉子窗的 content-bounds-updated 拦截 → resizeTo 把小窗撑到 1512×949,「moveTo / resizeTo 不认」红;
 *  听写 broadcast 不查 webContents 是否已销毁 → 退出时未捕获异常、错误框卡住退出(修之前的那几轮)。
 *  授权预置在 userData(探针 = 允许、denied 探针 = 不允许),dw-ask 不预置;mac 点击交还前台要真鼠标,不在这里量(见方案页第六节)。
 *  npx electron-vite build && node ../../.claude/hooks/devlock.cjs run --vehicle=e2e -- npm run check:desktopwindow
 *  隔离的假引擎 / 笔记库 / 插件;不往别的应用发任何输入(鼠标事件是页面里合成的)。 */
const fs = require('fs'), os = require('os'), path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-desktop-window-'))
const shots = path.join(temp, 'screenshots'), results = []
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
function check(name, ok, detail = '') { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : detail}`) }
let step = 'start'
const mark = (s) => { step = s; console.log(`· ${s}`) }
// 哪一步挂住就报哪一步,不让整轮无声地等到外面的超时
let appPid = 0
const watchdog = setTimeout(() => { console.error(`TIMEOUT at step: ${step}`); try { if (appPid) process.kill(appPid, 'SIGKILL') } catch {} process.exit(2) }, 240000)

const probeMain = (tag) => `
  window.__dw = window.__dw || {};
  window.__dw[${JSON.stringify(tag)}] = { ctx, views: [] };
  ctx.registerView({ id: 'pet', title: 'Pet', forms: { bare: true }, mount(el, view) {
    const pet = document.createElement('div');
    pet.className = 'dw-pet';
    pet.style.cssText = 'position:absolute;left:20px;top:20px;width:80px;height:80px;border-radius:50%;background:var(--accent-ink, rgb(255, 0, 0))';
    el.append(pet);
    const rec = { surface: view.surface, hasDesktop: !!view.desktop, params: view.getParams(), changes: [], cleaned: false, view, pet };
    view.onParamsChanged((p) => rec.changes.push(p));
    window.__dw[${JSON.stringify(tag)}].views.push(rec);
    return () => { rec.cleaned = true };
  } });`

async function main() {
  const userData = path.join(temp, 'userdata'), vault = path.join(temp, 'vault')
  for (const dir of [userData, userData + '-dev', vault, shots]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(userData + '-dev', 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault }))
  fs.writeFileSync(path.join(userData + '-dev', 'plugin-desktop-grants.json'), JSON.stringify({ version: 1, grants: { 'dw-probe': 'allow', 'dw-denied': 'deny' } }))
  fs.writeFileSync(path.join(vault, 'Note.md'), '# Note\n')
  for (const [id, caps] of [['dw-probe', ['desktopWindow']], ['dw-nocap', []], ['dw-denied', ['desktopWindow']], ['dw-ask', ['desktopWindow']]]) {
    const dir = path.join(temp, 'plugins', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', minAppVersion: '0.0.1', capabilities: caps }))
    fs.writeFileSync(path.join(dir, 'main.js'), probeMain(id))
  }
  const stub = await startStubEngine({ sessions: [] })
  fs.writeFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'dw-token' }))
  const errors = []
  let quitMoved = null
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
    env: { ...process.env, TANGU_HOME: temp, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1', PI_CU_SOCKET_PATH: path.join(temp, 'bridge.sock') } })
  try {
    appPid = app.process().pid
    mark('launched')
    const win = await app.firstWindow()
    win.on('pageerror', (e) => errors.push(`main: ${e.message}`))
    await win.waitForSelector('.dv-groupview', { timeout: 30000, state: 'attached' })
    check('main window left onboarding', await skipOnboarding(win))
    await win.waitForFunction(() => !!window.__dw?.['dw-probe']?.ctx?.workspace?.open && !!window.__dw?.['dw-nocap'] && !!window.__dw?.['dw-denied'] && !!window.__dw?.['dw-ask'], null, { timeout: 30000 })
    // 主进程弹的每个对话框和未捕获异常都记一笔(文字 + 调用栈):退不掉时看是谁弹的,异常在收尾算失败
    await app.evaluate(({ dialog }, file) => {
      const fs = process.getBuiltinModule('fs')
      process.on('uncaughtException', (e) => fs.appendFileSync(file, `uncaughtException: ${e?.stack ?? e}\n\n`))
      for (const k of ['showMessageBox', 'showMessageBoxSync', 'showErrorBox']) {
        const orig = dialog[k].bind(dialog)
        dialog[k] = (...args) => { const o = args.find((x) => x && typeof x === 'object' && ('message' in x || 'buttons' in x)); fs.appendFileSync(file, `${k}: ${o?.message ?? args[0]}\n${new Error().stack}\n\n`)
          // dw-ask 的第一次询问:替用户点「允许」并计数(没有预置授权的那条真路径)
          if (k === 'showMessageBox' && String(o?.message ?? '').includes('dw-ask')) { globalThis.__dwAsked = (globalThis.__dwAsked || 0) + 1; return Promise.resolve({ response: 0, checkboxChecked: false }) }
          return orig(...args) }
      }
    }, path.join(temp, 'dialogs.log'))
    // 记下主进程对每扇窗的 setIgnoreMouseEvents(Electron 没有读回的接口)
    await app.evaluate(({ BrowserWindow }) => {
      globalThis.__dwIgnore = []
      const orig = BrowserWindow.prototype.setIgnoreMouseEvents
      BrowserWindow.prototype.setIgnoreMouseEvents = function (ignore, opts) { globalThis.__dwIgnore.push({ id: this.id, ignore, forward: !!opts?.forward }); return orig.call(this, ignore, opts) }
    })
    const wopen = (tag, opts) => win.evaluate(([t, o]) => window.__dw[t].ctx.workspace.open('pet', o).then((r) => ({ ...r, close: !!r.close, closed: undefined })), [tag, opts])
    const desktopWins = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.getURL() === 'about:blank')
      .map((w) => ({ id: w.id, bounds: w.getBounds(), visible: w.isVisible(), onTop: w.isAlwaysOnTop(), focusable: w.isFocusable(), pid: w.webContents.getOSProcessId(), title: w.getTitle() })))
    const mainPid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !/about:blank/.test(w.webContents.getURL()) && !/window=/.test(w.webContents.getURL()))?.webContents.getOSProcessId())

    check('ctx.workspace.forms lists bare', await win.evaluate(() => window.__dw['dw-probe'].ctx.workspace.forms?.includes('bare')))

    // ① 开成桌面小窗
    mark('① 开成桌面小窗')
    const r1 = await wopen('dw-probe', { layer: { float: 'desktop' }, form: 'bare', key: 'a', params: undefined, size: { width: 120, height: 120 } })
    await pause(800)
    let wins = await desktopWins()
    check('opens a desktop window: ok, layer desktop, form bare, with close', r1.ok && r1.layer.float === 'desktop' && r1.form === 'bare' && r1.close, JSON.stringify(r1))
    const w1 = wins[0]
    check('the window is visible, on top, not focusable, 120 × 120, same renderer process as the main window',
      wins.length === 1 && w1.visible && w1.onTop && !w1.focusable && w1.bounds.width === 120 && w1.bounds.height === 120 && w1.pid === mainPid, JSON.stringify({ wins, mainPid }))
    const v1 = await win.evaluate(() => { const r = window.__dw['dw-probe'].views[0]; return r && { surface: r.surface, hasDesktop: r.hasDesktop, inChild: r.pet.ownerDocument !== document } })
    check('the view got surface desktop, a controller, and is drawn into the child document', v1 && v1.surface === 'desktop' && v1.hasDesktop && v1.inChild, JSON.stringify(v1))

    // ② 截图:透明 + 画上去了 + 主题色
    mark('② 截图:透明 + 画上去了 + 主题色')
    const px = await app.evaluate(async ({ BrowserWindow }, id) => {
      const w = BrowserWindow.fromId(id)
      const img = await w.webContents.capturePage()
      const { width, height } = img.getSize(), bmp = img.toBitmap()
      const at = (x, y) => { const i = (y * width + x) * 4; return [bmp[i + 2], bmp[i + 1], bmp[i], bmp[i + 3]] } // BGRA → RGBA
      return { corner: at(1, 1), center: at(Math.round(width / 2), Math.round(height / 2)), png: img.toPNG().toString('base64') }
    }, w1.id)
    fs.writeFileSync(path.join(shots, 'desktop-window.png'), Buffer.from(px.png, 'base64'))
    const accent = await win.evaluate(() => { const r = window.__dw['dw-probe'].views[0]; return r.pet.ownerDocument.defaultView.getComputedStyle(r.pet).backgroundColor })
    check('captured window: corner fully transparent, center painted', px.corner[3] === 0 && px.center[3] === 255, JSON.stringify({ corner: px.corner, center: px.center }))
    check('theme styles reached the child (--accent-ink resolved, not the red fallback)', !!accent && accent !== 'rgb(255, 0, 0)', accent)

    // ③ 挪窗夹在屏内、主进程一致;改大小夹到一半
    mark('③ 挪窗夹在屏内、主进程一致;改大小夹到一半')
    const moved = await win.evaluate(() => { const d = window.__dw['dw-probe'].views[0].view.desktop; d.moveTo(-1000, 300); return { b: d.bounds(), wa: d.workArea() } })
    await pause(300)
    wins = await desktopWins()
    check('moveTo is clamped (≥ 32 px stays on screen) and the real window follows', moved.b.x === -88 && wins[0].bounds.x === -88 && wins[0].bounds.y === 300, JSON.stringify({ moved, real: wins[0].bounds }))
    const resized = await win.evaluate(() => { const d = window.__dw['dw-probe'].views[0].view.desktop; d.resize(99999, 120); return d.bounds() })
    check('resize is clamped to half the work area', resized.width === Math.floor(moved.wa.width / 2), JSON.stringify({ resized, wa: moved.wa }))
    await win.evaluate(() => { const d = window.__dw['dw-probe'].views[0].view.desktop; d.resize(120, 120); d.moveTo(d.workArea().x + 200, d.workArea().y + 200) })
    await pause(300)
    const beforeDom = (await desktopWins()).find((w) => w.id === w1.id)?.bounds
    await win.evaluate(() => { const w = window.__dw['dw-probe'].views[0].pet.ownerDocument.defaultView; w.resizeTo(4000, 4000); w.moveTo(0, 0) })
    await pause(500)
    const afterDom = (await desktopWins()).find((w) => w.id === w1.id)?.bounds
    check("the child page's own moveTo / resizeTo are ignored (only the controller moves it)", JSON.stringify(beforeDom) === JSON.stringify(afterDom), JSON.stringify({ beforeDom, afterDom }))

    // ④ 点穿
    mark('④ 点穿')
    const ign = async () => (await app.evaluate(() => globalThis.__dwIgnore)).filter((c) => c.id === w1.id)
    await win.evaluate(() => {
      const r = window.__dw['dw-probe'].views[0], d = r.pet.ownerDocument, W = d.defaultView
      d.dispatchEvent(new W.MouseEvent('mousemove', { clientX: 60, clientY: 60, bubbles: true }))
    })
    await pause(200)
    const afterPet = await ign()
    await win.evaluate(() => {
      const r = window.__dw['dw-probe'].views[0], d = r.pet.ownerDocument, W = d.defaultView
      d.dispatchEvent(new W.MouseEvent('mousemove', { clientX: 3, clientY: 3, bubbles: true }))
    })
    await pause(200)
    const afterEmpty = await ign()
    check('click-through: over the pet it catches, over the empty corner it passes through (forwarding moves)',
      afterPet.at(-1)?.ignore === false && afterEmpty.at(-1)?.ignore === true && afterEmpty.at(-1)?.forward === true, JSON.stringify(afterEmpty))
    await win.evaluate(() => window.__dw['dw-probe'].views[0].view.desktop.setClickThrough('none'))
    await pause(200)
    check("setClickThrough('none'): the whole window catches", (await ign()).at(-1)?.ignore === false)
    await win.evaluate(() => window.__dw['dw-probe'].views[0].view.desktop.setClickThrough('shape'))

    // ⑤ 同 key 复用 + 上限
    mark('⑤ 同 key 复用 + 上限')
    await wopen('dw-probe', { layer: { float: 'desktop' }, form: 'bare', key: 'a' })
    await win.evaluate(() => window.__dw['dw-probe'].ctx.workspace.open({ view: 'pet', params: { skin: 'dog' } }, { layer: { float: 'desktop' }, form: 'bare', key: 'a' }))
    await pause(400)
    const reuse = await win.evaluate(() => ({ n: window.__dw['dw-probe'].views.length, changes: window.__dw['dw-probe'].views[0].changes }))
    check('the same key reopens nothing; new params reach the view', (await desktopWins()).length === 1 && reuse.n === 1 && reuse.changes.at(-1)?.skin === 'dog', JSON.stringify(reuse))
    const rb = await wopen('dw-probe', { layer: { float: 'desktop' }, form: 'bare', key: 'b' })
    const rc = await wopen('dw-probe', { layer: { float: 'desktop' }, form: 'bare', key: 'c' })
    const rd = await wopen('dw-probe', { layer: { float: 'desktop' }, form: 'bare', key: 'd' })
    await pause(600)
    check('at most 3 per plugin: the 4th is refused with limit 3', rb.ok && rc.ok && !rd.ok && rd.reason === 'limit' && rd.limit === 3 && (await desktopWins()).length === 3, JSON.stringify({ rb, rc, rd }))

    // ⑥ 回落
    mark('⑥ 回落')
    const rn = await wopen('dw-nocap', { layer: { float: 'desktop' }, form: 'bare', size: { width: 100, height: 100 } })
    const rdn = await wopen('dw-denied', { layer: { float: 'desktop' }, form: 'bare' })
    await pause(600)
    const inWindow = await win.evaluate(() => ({
      cards: document.querySelectorAll('.lcl-float[data-view-float="bare"]').length,
      heads: document.querySelectorAll('.lcl-float[data-view-float="bare"] .lcl-float-view-head').length,
      surfaces: ['dw-nocap', 'dw-denied'].map((t) => window.__dw[t].views[0]?.surface),
    }))
    check('no desktopWindow capability / denied before → a bare card in the window (no title row), surface floating',
      rn.ok && rn.layer.float === 'window' && rdn.ok && rdn.layer.float === 'window' && inWindow.cards === 2 && inWindow.heads === 0
        && inWindow.surfaces.every((s) => s === 'floating') && (await desktopWins()).length === 3, JSON.stringify({ rn, rdn, inWindow }))
    await win.screenshot({ path: path.join(shots, 'main-with-fallback.png') })

    // ⑥b 第一次询问(不预置授权)与撤回
    mark('⑥b 第一次询问与撤回')
    const grantsFile = path.join(userData + '-dev', 'plugin-desktop-grants.json')
    const grantOnDisk = () => { try { return JSON.parse(fs.readFileSync(grantsFile, 'utf8')).grants['dw-ask'] ?? null } catch { return 'unreadable' } }
    const asked = () => app.evaluate(() => globalThis.__dwAsked || 0)
    const rx = await wopen('dw-ask', { layer: { float: 'desktop' }, form: 'bare', key: 'x' })
    const ry = await wopen('dw-ask', { layer: { float: 'desktop' }, form: 'bare', key: 'y' })
    await pause(800)
    check('first use asks once, remembers allow, a second window does not ask again',
      rx.ok && rx.layer.float === 'desktop' && ry.ok && ry.layer.float === 'desktop' && (await asked()) === 1 && grantOnDisk() === 'allow' && (await desktopWins()).length === 5,
      JSON.stringify({ rx, ry, asked: await asked(), grant: grantOnDisk(), n: (await desktopWins()).length }))
    const revoked = await win.evaluate(() => window.tangu.desktopWindow.revoke('dw-ask'))
    await pause(800)
    check('revoke closes its windows and forgets the answer', revoked === true && (await desktopWins()).length === 3 && grantOnDisk() === null,
      JSON.stringify({ revoked, n: (await desktopWins()).length, grant: grantOnDisk() }))
    const rx2 = await wopen('dw-ask', { layer: { float: 'desktop' }, form: 'bare', key: 'x' })
    await pause(600)
    check('after revoke the next open asks again', rx2.ok && (await asked()) === 2, JSON.stringify({ rx2, asked: await asked() }))
    await win.evaluate(() => window.tangu.desktopWindow.revoke('dw-ask'))
    await pause(600)

    // ⑦ 主窗藏起来
    mark('⑦ 主窗藏起来')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !/about:blank/.test(w.webContents.getURL()) && !/window=/.test(w.webContents.getURL()))?.hide())
    await pause(1200)
    const frames = await win.evaluate(() => new Promise((res) => {
      const d = window.__dw['dw-probe'].views[0].view.desktop; let n = 0; const t0 = performance.now()
      const step = () => { n++; if (performance.now() - t0 < 1000) d.requestFrame(step); else res(n) }
      d.requestFrame(step)
    }))
    const hiddenWins = await desktopWins()
    check('main window hidden: desktop windows stay visible and their frames keep running', hiddenWins.length === 3 && hiddenWins.every((w) => w.visible) && frames >= 30, JSON.stringify({ frames, n: hiddenWins.length }))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !/about:blank/.test(w.webContents.getURL()) && !/window=/.test(w.webContents.getURL()))?.showInactive())
    await pause(600)

    // ⑧ 停用 → 全关、清理跑了;再启用再开 → 回到上次的位置
    mark('⑧ 停用 → 全关、清理跑了;再启用再开 → 回到上次的位置')
    const lastBounds = (await desktopWins()).find((w) => w.id === w1.id)?.bounds
    await win.evaluate(() => {
      localStorage.setItem('amadeus.plugins.disabled', JSON.stringify(['dw-probe']))
      window.dispatchEvent(new StorageEvent('storage', { key: 'amadeus.plugins.disabled', newValue: JSON.stringify(['dw-probe']) }))
    })
    await pause(1500)
    const cleaned = await win.evaluate(() => window.__dw['dw-probe'].views.map((r) => r.cleaned))
    check('disabling the plugin closes all its desktop windows and runs its cleanups', (await desktopWins()).length === 0 && cleaned.every(Boolean), JSON.stringify(cleaned))
    await win.evaluate(() => {
      localStorage.setItem('amadeus.plugins.disabled', '[]')
      window.dispatchEvent(new StorageEvent('storage', { key: 'amadeus.plugins.disabled', newValue: '[]' }))
    })
    await win.waitForFunction(() => window.__dw['dw-probe'].views.length === 0 || window.__dw['dw-probe'].ctx !== undefined, null, { timeout: 15000 })
    await pause(1500)
    const ra = await wopen('dw-probe', { layer: { float: 'desktop' }, form: 'bare', key: 'a', size: { width: 120, height: 120 } })
    await pause(800)
    const back = (await desktopWins())[0]?.bounds
    check('re-enabled and reopened: back where it was', ra.ok && !!back && !!lastBounds && back.x === lastBounds.x && back.y === lastBounds.y, JSON.stringify({ ra, back, lastBounds }))

    // ⑩ ctx.ui.float('desktop') 照旧报错
    mark('⑩ ctx.ui.float(desktop) 照旧报错')
    check("ctx.ui.float('desktop') still throws", await win.evaluate(() => { try { window.__dw['dw-probe'].ctx.ui.float({ scope: 'desktop' }); return false } catch { return true } }))

    // ⑨ 主窗重载 → 全关
    mark('⑨ 主窗重载 → 全关')
    await win.reload()
    await win.waitForSelector('.dv-groupview', { timeout: 30000, state: 'attached' })
    await pause(1000)
    check('reloading the main window closes the desktop windows', (await desktopWins()).length === 0)

    // ⑪ 带着一只开着的宠物退出:先开一扇、挪个位置,收尾时退出要干净、位置要落盘
    mark('⑪ 开着小窗退出')
    await win.waitForFunction(() => !!window.__dw?.['dw-probe']?.ctx?.workspace?.open, null, { timeout: 30000 })
    const rq = await wopen('dw-probe', { layer: { float: 'desktop' }, form: 'bare', key: 'q', size: { width: 120, height: 120 } })
    await pause(800)
    quitMoved = await win.evaluate(() => { const d = window.__dw['dw-probe'].views.at(-1).view.desktop; d.moveTo(d.workArea().x + 300, d.workArea().y + 250); return d.bounds() })
    await pause(300)
    check('a desktop window is open going into quit', rq.ok && (await desktopWins()).length === 1, JSON.stringify(rq))
  } finally {
    check('no renderer errors', errors.length === 0, errors.join(' | '))
    mark('closing')
    const pid = app.process().pid
    const closed = await Promise.race([app.close().then(() => true, () => true), pause(20000).then(() => false)])
    if (!closed) { // 退不掉:采样主进程看卡在哪,再按 PID 收掉
      const out = path.join(temp, 'quit-sample.txt')
      try { require('child_process').execFileSync('sample', [String(pid), '1', '-file', out], { stdio: 'ignore' }) } catch {}
      console.log(`quit hung; sample at ${out}`)
      try { console.log(fs.readFileSync(path.join(temp, 'dialogs.log'), 'utf8').slice(0, 4000)) } catch { console.log('no dialogs logged') }
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
    check('the app quits within 20 s', closed)
    if (quitMoved) {
      let saved = null
      try { saved = JSON.parse(fs.readFileSync(path.join(temp, 'userdata-dev', 'plugin-desktop-windows.json'), 'utf8')).bounds['dw-probe#q'] } catch { /* 没写 */ }
      check('quitting with a window open saves where it was moved', !!saved && saved.x === quitMoved.x && saved.y === quitMoved.y, JSON.stringify({ saved, quitMoved }))
    }
    // 主进程的未捕获异常:台架接住了(否则 Electron 弹错误框、退出卡死),这里照样算失败(11-26 抓到听写 broadcast 往已销毁的 webContents send)
    let uncaught = ''
    try { uncaught = fs.readFileSync(path.join(temp, 'dialogs.log'), 'utf8').split('\n\n').filter((b) => b.startsWith('uncaughtException')).join('\n\n') } catch { /* 没有记录 = 没有 */ }
    check('no uncaught exceptions in the main process', !uncaught, uncaught.slice(0, 1500))
    await stub.close?.()
    console.log(`screenshots: ${shots}`)
    const failed = results.filter((r) => !r).length
    console.log(`${results.length - failed}/${results.length} passed`)
    process.exitCode = failed ? 1 : 0
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => clearTimeout(watchdog))
