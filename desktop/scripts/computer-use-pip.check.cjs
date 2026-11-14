/** Computer Use 悬浮小画面(window.tangu.computerUsePip,宿主私有桥)的真 Electron 契约。
 * 用法:npm run build && node ../../.claude/hooks/devlock.cjs run --vehicle=e2e --what="悬浮小画面" --eta=2 -- npm run check:cupip
 * (devlock 路径按仓根算;worktree 里换成仓根的绝对路径。跑之前先 `lsof -iTCP -sTCP:LISTEN | grep node` 看有没有残留的 vite。)
 *
 * 隔离 TANGU_HOME 里**现生成**一个探针插件,插件 id 借用 tangu-computer-use(宿主只认这个 id 的 live 视图)、视图只画一块定高的块,
 * 不依赖真插件、不连任何 helper(PI_CU_SOCKET_PATH 指到临时目录)。静默:Playwright 起的实例 QUIET_WINDOWS,主窗压到 -1;
 * 悬浮小画面在 QUIET 下由主进程自己压到 -1(electron/main.ts),这里再挂一道 browser-window-created 兜底,读系统层级断言。
 *
 * 钉的是:
 *   1 open() 之前没有这扇窗;插件被停用时 open() 回 false、窗口从没 show 过
 *   2 open() 回 true:264 宽、主屏右上角距边 24、置顶、不可聚焦、高度 = 拖动条 + 视图内容高
 *   3 视图拿到 surface === 'pip';窗口里没有 Mini 卡头
 *   4 再 open() 幂等:还是那一扇,拖走的位置不变
 *   5 不进 Mini 名册:?window=mini 的窗口数不变,mini-session 文件里没有它
 *   6 ctx.tangu.stop({ runId: 不存在 }) 在 pip 里回 false(转发通了,且不乱停)
 *   7 点「放回去」关掉;isOpen() 回 false
 */
const fs = require('fs'), os = require('os'), path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`) }
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, timeout = 20000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const v = await fn(); if (v) return v; await pause(100) }
  return null
}

const PROBE_MAIN = `
ctx.registerView({
  id: 'live',
  title: 'Live probe',
  mount(el, view) {
    const box = document.createElement('div')
    box.className = 'pip-probe'
    box.dataset.surface = String(view && view.surface)
    box.style.height = '190px'
    box.textContent = 'probe'
    el.appendChild(box)
    window.__pipProbeStop = (t) => (ctx.tangu && ctx.tangu.stop ? ctx.tangu.stop(t) : Promise.resolve('no-stop'))
    return () => box.remove()
  },
})
`

function writeProbe(pluginsDir) {
  const dir = path.join(pluginsDir, 'tangu-computer-use')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'main.js'), PROBE_MAIN)
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    // 版本写得比随包那份高:启动时的内置播种「永不降级」,写 0.0.1 会被随包的真插件整个换掉(11-13 实跑:窗里挂的是真插件,探针不见了)
    id: 'tangu-computer-use', name: 'PiP probe', version: '99.0.0', minAppVersion: '0.0.1',
    description: 'computer-use-pip.check probe; not the product plugin',
  }, null, 2))
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(2) }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-cupip-'))
  const userData = path.join(home, 'userData')
  fs.mkdirSync(`${userData}-dev`, { recursive: true })
  writeProbe(path.join(home, 'plugins'))
  const stub = await startStubEngine({})
  fs.writeFileSync(path.join(`${userData}-dev`, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'cupip' }))
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HARNESS_QUIET: '1', TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, PI_CU_SOCKET_PATH: path.join(home, 'bridge.sock') } })
    // 兜底:任何新窗的置顶一律压到 -1,并记下 pip 窗的 show(「从没上过屏」要靠它)
    await app.evaluate(({ app: a }) => {
      globalThis.__pipShows = []
      a.on('browser-window-created', (_e, w) => {
        const orig = w.setAlwaysOnTop.bind(w)
        w.setAlwaysOnTop = (flag) => orig(flag, 'normal', -1)
        orig(true, 'normal', -1)
        for (const ev of ['show']) w.on(ev, () => { if (w.webContents.getURL().includes('window=pip')) globalThis.__pipShows.push(Date.now()) })
      })
    })
    const win = await app.firstWindow()
    await win.waitForSelector('.dv-groupview', { timeout: 30000, state: 'attached' })
    await skipOnboarding(win)
    const pipWindows = () => app.evaluate(({ BrowserWindow, screen }) => BrowserWindow.getAllWindows()
      .filter((w) => w.webContents.getURL().includes('window=pip'))
      .map((w) => ({ id: w.id, visible: w.isVisible(), bounds: w.getBounds(), top: w.isAlwaysOnTop(), focusable: w.isFocusable(), parent: !!w.getParentWindow(), work: screen.getPrimaryDisplay().workArea })))
    const minis = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('window=mini')).length)
    check('1 open() 之前没有悬浮小画面', (await pipWindows()).length === 0)
    check('桥只在桌面:window.tangu.computerUsePip 在', await win.evaluate(() => typeof window.tangu?.computerUsePip?.open === 'function'))
    const miniBefore = await minis()

    // 停用探针插件 → open() 回 false、从没 show。停用名单 = localStorage 'amadeus.plugins.disabled'(pluginStore DISABLED_KEY,
    // 各窗口同源共用);pip 窗启动时读到的就是停用态,视图不注册、宿主报不可用。
    const KEY = 'amadeus.plugins.disabled'
    const prev = await win.evaluate((k) => localStorage.getItem(k), KEY)
    await win.evaluate(([k, v]) => { let list = []; try { list = JSON.parse(v || '[]') } catch { /* ignore */ } localStorage.setItem(k, JSON.stringify([...new Set([...list, 'tangu-computer-use'])])) }, [KEY, prev])
    const refused = await win.evaluate(() => window.tangu.computerUsePip.open())
    check('1 插件停用:open() 回 false', refused === false)
    check('1 插件停用:窗口从没 show 过、也没留下', (await app.evaluate(() => globalThis.__pipShows.length)) === 0 && (await pipWindows()).length === 0)
    await win.evaluate(([k, v]) => { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v) }, [KEY, prev])

    const opened = await win.evaluate(() => window.tangu.computerUsePip.open())
    check('2 open() 回 true', opened === true)
    const [w] = await pipWindows()
    const expectX = w && w.work.x + w.work.width - 264 - 24
    check('2 264 宽、主屏右上角距边 24', !!w && w.bounds.width === 264 && w.bounds.x === expectX && w.bounds.y === w.work.y + 24, JSON.stringify(w))
    check('2 置顶、不可聚焦、无父窗、可见', !!w && w.top && !w.focusable && !w.parent && w.visible)
    const pip = await until(() => app.windows().find((p) => p.url().includes('window=pip')))
    // 这扇窗是主窗开出来的,不属于启动流程:上屏那一刻不该还盖着启动闪屏(盖着的话人先看到开屏画面,一两秒后才是实时画面)
    check('2 上屏时不挂启动闪屏', !!pip && await pip.evaluate(() => !document.getElementById('tangu-splash')))
    const pipLogs = []
    pip.on('console', (m) => { if (pipLogs.length < 40) pipLogs.push(`${m.type()}: ${m.text().slice(0, 300)}`) })
    pip.on('pageerror', (e) => { pipLogs.push(`pageerror: ${String(e && e.message).slice(0, 300)}`) })
    try { await pip.waitForSelector('.pip-probe', { timeout: 15000 }) } catch (e) {
      // 视图没挂上:把这扇窗里实际画了什么、控制台说了什么打出来再抛(否则只有一句超时,无从下手)
      const dom = await pip.evaluate(() => document.body.innerHTML.replace(/\s+/g, ' ').slice(0, 2400)).catch((x) => `读不到 DOM: ${x}`)
      console.error('[cupip] pip 窗的 DOM:', dom)
      console.error('[cupip] pip 窗的控制台:', JSON.stringify(pipLogs, null, 1))
      throw e
    }
    const surface = await pip.evaluate(() => document.querySelector('.pip-probe')?.dataset.surface)
    check('3 视图上下文 surface === pip', surface === 'pip', String(surface))
    check('3 没有 Mini 卡头', await pip.evaluate(() => !document.querySelector('.mini-card-chrome')))
    const h = (await until(async () => { const [x] = await pipWindows(); return x && x.bounds.height >= 190 + 18 && x.bounds.height })) || 0
    check('2 高度随内容(拖动条 + 190)', h >= 208 && h <= 214, String(h))

    await app.evaluate(({ BrowserWindow }) => { const x = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('window=pip')); x.setPosition(80, 300) })
    check('4 再 open() 回 true', (await win.evaluate(() => window.tangu.computerUsePip.open())) === true)
    const again = await pipWindows()
    check('4 还是那一扇、位置不变', again.length === 1 && again[0].id === w.id && again[0].bounds.x === 80 && again[0].bounds.y === 300, JSON.stringify(again.map((x) => x.bounds)))
    check('5 不进 Mini 名册', (await minis()) === miniBefore)
    const sessionFile = path.join(`${userData}-dev`, 'mini-session.json')
    check('5 Mini 会话文件里没有它', !fs.existsSync(sessionFile) || !fs.readFileSync(sessionFile, 'utf8').includes('pip'))

    const stopped = await pip.evaluate(() => window.__pipProbeStop({ runId: 'no-such-run' }))
    check('6 pip 里 stop({ runId: 不存在 }) 回 false', stopped === false, String(stopped))

    await pip.click('.pip-close')
    check('7 点「放回去」关掉', !!(await until(async () => (await pipWindows()).length === 0, 5000)))
    check('7 isOpen() 回 false', (await win.evaluate(() => window.tangu.computerUsePip.isOpen())) === false)
  } catch (e) {
    console.error(e); check('runner 未捕获异常', false, String((e && e.message) || e))
  } finally {
    if (app) await app.close().catch(() => {})
    try { await stub.close() } catch { /* ignore */ }
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  const failed = results.filter((r) => !r).length
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
