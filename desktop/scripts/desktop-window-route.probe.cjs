/** 插件桌面小窗第 0 步实测(方案页 docs/ToBeImproved/插件桌面小窗方案_2026-11-26 第五节):
 *  路 1「同进程子窗」—— 主窗页面 window.open 一扇透明、无外壳的子窗,主窗那份 JS 直接往里画 —— 在 Electron 40 下成不成。
 *  不改产品代码:运行时给主窗换一个放行特定 frameName 的 window-open 处理器,其余照旧拒。
 *  量:① 开得出透明 / 无边框 / 不进任务栏 / 不可聚焦的子窗,主窗 JS 能直接写它的 DOM、收得到它的事件,和主窗同一个渲染进程;
 *     ② 主窗藏起来时,子窗 requestAnimationFrame 与主窗定时器各跑多快;③ 主窗重载后子窗还在不在;
 *     ④ 多一扇子窗 vs 多一扇 Mini 各多占多少内存 / 多几个进程。mac 点击是否激活 Forsion 要真鼠标,不在这里量。
 *  npx electron-vite build && node ../../.claude/hooks/devlock.cjs run --vehicle=e2e -- node scripts/desktop-window-route.probe.cjs */
const fs = require('fs'), os = require('os'), path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-dw-probe-'))
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const out = {}

async function metrics(app) {
  return app.evaluate(({ app }) => {
    const m = app.getAppMetrics()
    return { procs: m.length, renderers: m.filter((p) => p.type === 'Tab').length, kb: m.reduce((s, p) => s + (p.memory?.workingSetSize || 0), 0) }
  })
}

async function main() {
  const userData = path.join(temp, 'userdata'), vault = path.join(temp, 'vault')
  for (const dir of [userData, userData + '-dev', vault]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(userData + '-dev', 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault }))
  fs.writeFileSync(path.join(vault, 'Note.md'), '# Note\n')
  const stub = await startStubEngine({ sessions: [] })
  fs.writeFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'dw-token' }))
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
    env: { ...process.env, TANGU_HOME: temp, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1', PI_CU_SOCKET_PATH: path.join(temp, 'bridge.sock') } })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('.dv-groupview', { timeout: 30000, state: 'attached' })
    await skipOnboarding(win)
    await pause(1500)
    out.before = await metrics(app)

    // 换处理器:只放行 frameName 'dw-probe',窗口选项照 desktopFloat.ts(focus keep + pin)
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((w) => /index\.html/.test(w.webContents.getURL()) && !/window=/.test(w.webContents.getURL()))
      globalThis.__dwMain = main
      const prev = main.webContents
      prev.setWindowOpenHandler((d) => {
        if (d.frameName !== 'dw-probe') return { action: 'deny' }
        const mac = process.platform === 'darwin'
        return { action: 'allow', outlivesOpener: false, overrideBrowserWindowOptions: {
          x: 200, y: 200, width: 180, height: 180, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
          hasShadow: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
          ...(mac ? { type: 'panel' } : {}), focusable: false, acceptFirstMouse: true, alwaysOnTop: true,
        } }
      })
      prev.once('did-create-window', (child, details) => {
        globalThis.__dwChild = child
        child.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver')
        child.showInactive()
        globalThis.__dwChildInfo = { frameName: details.frameName }
      })
    })

    // 主窗页面开子窗、往里画、收事件
    out.dom = await win.evaluate(async () => {
      const c = window.open('about:blank', 'dw-probe')
      if (!c) return { opened: false }
      await new Promise((r) => setTimeout(r, 400))
      let access = false, err = ''
      try { access = !!c.document.body } catch (e) { err = String(e) }
      if (!access) return { opened: true, access, err }
      const d = c.document
      for (const n of document.querySelectorAll('style, link[rel="stylesheet"]')) d.head.append(n.cloneNode(true))
      for (const a of ['data-theme', 'data-skin', 'data-bg', 'class']) { const v = document.documentElement.getAttribute(a); if (v != null) d.documentElement.setAttribute(a, v) }
      d.documentElement.style.background = 'transparent'; d.body.style.cssText = 'margin:0;background:transparent;overflow:hidden'
      const pet = document.createElement('div') // 主窗的 document 造,挂进子窗
      pet.id = 'pet'; pet.style.cssText = 'position:absolute;left:50px;top:50px;width:80px;height:80px;border-radius:50%;background:var(--accent, #3d6b57)'
      d.body.append(pet)
      let clicks = 0; pet.addEventListener('click', () => { clicks++ })
      pet.dispatchEvent(new c.MouseEvent('click', { bubbles: true }))
      window.__dwC = c; window.__dwPet = pet
      return { opened: true, access, adopted: pet.ownerDocument === d, mainInstanceof: pet instanceof HTMLElement, childInstanceof: pet instanceof c.HTMLElement,
        clicks, childHasTangu: !!c.tangu, accentVar: getComputedStyle(pet).backgroundColor }
    })
    await pause(600)
    out.child = await app.evaluate(async () => {
      const c = globalThis.__dwChild, m = globalThis.__dwMain
      if (!c) return { created: false }
      const img = await c.webContents.capturePage()
      const sz = img.getSize(), bmp = img.toBitmap(), at = (x, y) => { const i = (y * sz.width + x) * 4; return [bmp[i], bmp[i + 1], bmp[i + 2], bmp[i + 3]] }
      return { created: true, ...globalThis.__dwChildInfo, bounds: c.getBounds(), visible: c.isVisible(), onTop: c.isAlwaysOnTop(), focusable: c.isFocusable(),
        focused: c.isFocused(), samePid: c.webContents.getOSProcessId() === m.webContents.getOSProcessId(),
        corner: at(2, 2), center: at(Math.round(sz.width / 2), Math.round(sz.height / 2)), size: sz,
        ignoreMouse: (() => { try { c.setIgnoreMouseEvents(true, { forward: true }); c.setIgnoreMouseEvents(false); return 'ok' } catch (e) { return String(e) } })() }
    })
    out.afterChild = await metrics(app)

    // ② 帧率:主窗可见 / 藏起来
    const rate = () => win.evaluate(() => new Promise((res) => {
      const c = window.__dwC; let raf = 0, tick = 0; const t0 = performance.now()
      const loop = () => { raf++; if (performance.now() - t0 < 2000) c.requestAnimationFrame(loop) }
      c.requestAnimationFrame(loop)
      const iv = setInterval(() => { tick++ }, 16)
      setTimeout(() => { clearInterval(iv); res({ childRafPerSec: raf / 2, mainTimerPerSec: tick / 2 }) }, 2000)
    }))
    out.rateVisible = await rate()
    await app.evaluate(() => globalThis.__dwMain.hide())
    await pause(1500)
    out.rateMainHidden = await rate()
    out.childVisibleWhileMainHidden = await app.evaluate(() => globalThis.__dwChild.isVisible())
    await app.evaluate(() => globalThis.__dwMain.showInactive())
    await pause(800)

    // ④ 对照:多开一扇 Mini
    await win.evaluate(() => window.tangu?.openMini?.())
    await pause(5000)
    out.afterMini = await metrics(app)

    // ③ 主窗重载
    await win.reload()
    await pause(3000)
    out.childAfterReload = await app.evaluate(() => ({ destroyed: globalThis.__dwChild.isDestroyed() }))
    // 重载后的新页面能不能按名字找回那扇子窗(不新建),并清掉旧内容重画
    await win.waitForSelector('.dv-groupview', { timeout: 30000, state: 'attached' })
    out.reattach = await win.evaluate(async () => {
      const c = window.open('', 'dw-probe')
      if (!c) return { got: false }
      let access = false; try { access = !!c.document.body } catch { /* cross */ }
      const stale = access ? c.document.getElementById('pet') : null
      return { got: true, access, staleLeft: !!stale, href: access ? c.location.href : '' }
    })
    out.windowsAfterReattach = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length)
    const png = await app.evaluate(async () => (await globalThis.__dwChild.webContents.capturePage()).toPNG().toString('base64'))
    fs.writeFileSync(path.join(process.env.DW_SHOT_DIR || temp, 'dw-child.png'), Buffer.from(png, 'base64'))
  } finally {
    await app.close().catch(() => {})
    await stub.close?.()
    console.log(JSON.stringify(out, null, 2))
  }
}
main().catch((e) => { console.error(e); console.log(JSON.stringify(out, null, 2)); process.exit(1) })
