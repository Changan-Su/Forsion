/**
 * Space「添加到桌面」—— 真 Electron × 真主进程:快捷方式里那条 `forsion://space/<id>?window=standalone`
 * 到底开出了什么窗。(快捷方式文件本身的格式由 electron/spaceShortcut.test.ts 钉。)
 *
 *  C  冷启动带着链接(win/linux 快捷方式就是这么起的;mac 走 open-url,同一个路由函数):
 *     开出这个 Space 的独立窗,主窗建了但**不显示**。
 *  S  已经开着(主窗藏着)再起一个带链接的实例(二启):第二个进程立刻退出,第一个只开 Space 窗,主窗还是藏着。
 *  N  不带 window 参数的普通 `forsion://space/<id>`:照旧叫出主窗(老行为没被截走)。
 *  M  Ribbon 右键 Space 有「添加到桌面」;dev 下点了提示只在安装版可用(开发模式恒拒,主进程那条 IPC 接上了)。
 *  I  渲染层交给主进程的图标是一张 1024px PNG;拿它按 mac 的路子真做一个 .app(临时目录,isPackaged 假装为真):
 *     Info.plist 过 plutil、AppIcon.icns 过 iconutil、launch 可执行 —— 只检查,不双击(双击会唤起本机装的那个 Forsion)。
 *
 * ⚠️ 验不到的:安装版里 LaunchServices / 注册表把链接投给 Forsion 的那一段(dev 不注册 forsion://),
 *    Windows 任务栏按 Space 单独成组(setAppDetails)。
 * 需先 npm run build。用法:npm run e2e:spaceshortcut   (SPACESHORTCUT_SHOTS=<目录> 留截图与图标)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const electron = require('./lib/launch-electron.cjs')
const { loadTs } = require('./lib/load-ts.cjs')

const ROOT = path.join(__dirname, '..')
const SHOTS = process.env.SPACESHORTCUT_SHOTS || ''
const SPACE = 'probe-win'
const LINK = `forsion://space/${SPACE}?window=standalone`
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  | ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-spaceshortcut-'))
const userData = path.join(home, 'userdata')
const env = electron.workspaceEnv({ ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1', FORSION_CLIP_ENTRANCE: '0' })

/** 等到条件成立(或超时),返回最后一次的值。 */
async function until(fn, ms = 20000, step = 250) {
  const end = Date.now() + ms
  let v
  while (Date.now() < end) { v = await fn().catch(() => undefined); if (v) return v; await sleep(step) }
  return v
}

/** 第二个实例:同一个 userData,带着链接起,应当拿不到单实例锁、立刻退出(把 argv 交给第一个)。 */
function secondInstance(link) {
  return new Promise((resolve) => {
    const child = spawn(require('electron'), [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT, link, ...electron.MAC_FLAGS], { cwd: ROOT, env, stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: 'timeout' }) }, 20000)
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code }) })
  })
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  // 纯数据的用户 Space(异步装载):Space 窗得等它注册上来,同 space-window.e2e 的夹具。
  fs.mkdirSync(path.join(home, 'spaces', 'probe'), { recursive: true })
  fs.writeFileSync(path.join(home, 'spaces', 'probe', 'space.json'), JSON.stringify({
    id: SPACE, name: { zh: '探针空间', en: 'Probe space' }, icon: 'star', version: '1.0.0',
    layout: { main: [{ type: 'outline', pinned: true }], left: [], right: [] },
  }), 'utf8')

  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT, LINK], cwd: ROOT, env })
  try {
    /** 主进程眼里的窗口:主窗 = URL 不带 window= 的那扇。 */
    const wins = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => {
      const url = w.webContents.getURL()
      const q = url.includes('?') ? new URLSearchParams(url.slice(url.indexOf('?'))) : new URLSearchParams()
      return { id: w.id, kind: q.get('window') || 'main', space: q.get('space'), visible: w.isVisible(), loaded: !!url }
    }))
    const mainWin = async () => (await wins()).find((w) => w.kind === 'main')
    const spaceWin = async () => (await wins()).find((w) => w.space === SPACE)

    // ───────── C 冷启动 ─────────
    const sw = await until(async () => { const w = await spaceWin(); return w && w.visible ? w : undefined }, 40000)
    check('C1 冷启动带链接:开出这个 Space 的独立窗并显示', !!sw?.visible, await wins())
    await sleep(3000) // 主窗的 ready-to-show 一般比 Space 窗晚,给足时间再看它有没有冒出来
    const m1 = await mainWin()
    check('C2 主窗建了但没显示', !!m1 && !m1.visible, m1)
    const spacePage = await until(async () => app.windows().find((p) => p.url().includes(`space=${SPACE}`)), 10000)
    if (spacePage) {
      await spacePage.waitForSelector('.dv-groupview', { timeout: 30000 }).catch(() => {})
      check('C3 Space 窗挂上了界面(不是停在「还没准备好」)', (await spacePage.locator('.dv-groupview').count()) > 0 && !(await spacePage.locator('.space-window-wait').count()))
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await spacePage.screenshot({ path: path.join(SHOTS, 'C-space-window.png') }) }
    } else check('C3 Space 窗挂上了界面', false, 'no page')

    // ───────── S 二启 ─────────
    await app.evaluate(({ BrowserWindow }, sp) => {
      for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes(`space=${sp}`)) w.close()
    }, SPACE)
    await until(async () => !(await spaceWin()), 10000)
    check('S0 关掉 Space 窗', !(await spaceWin()))
    const second = await secondInstance(LINK)
    check('S1 第二个实例拿不到锁、自己退出', second.code === 0, second)
    const sw2 = await until(async () => { const w = await spaceWin(); return w && w.visible ? w : undefined }, 20000)
    check('S2 第一个实例开出 Space 窗', !!sw2?.visible, await wins())
    const m2 = await mainWin()
    check('S3 主窗仍然藏着', !!m2 && !m2.visible, m2)

    // ───────── N 普通 deep link ─────────
    await secondInstance(`forsion://space/${SPACE}`)
    const m3 = await until(async () => { const w = await mainWin(); return w && w.visible ? w : undefined }, 15000)
    check('N1 不带 window 参数的链接照旧叫出主窗', !!m3?.visible, await wins())

    // ───────── M 菜单 ─────────
    const win = app.windows().find((p) => !p.url().includes('window='))
    await win.waitForSelector('#root', { timeout: 30000 })
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.rb-space', { timeout: 30000 })
    await win.waitForTimeout(1500)
    const target = win.locator(`.rb-space[data-space-id="${SPACE}"]`).first()
    const btn = (await target.count()) ? target : win.locator('.rb-top .rb-space').first()
    const rightClick = async () => { await btn.click({ button: 'right' }); await win.waitForTimeout(400) }
    await rightClick()
    const item = win.locator('.rb-menu button, .rb-menu [role="menuitem"]', { hasText: '添加到桌面' }).first()
    check('M1 Ribbon 右键 Space 有「添加到桌面」', (await item.count()) > 0, await win.locator('.rb-menu').innerText().catch(() => ''))
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'M-ribbon-menu.png') })
    await item.click().catch(() => {})
    const toast = await until(async () => (await win.locator('text=只在安装版里可用').count()) > 0, 8000)
    check('M2 dev 下点了提示只在安装版可用(IPC 接上、开发模式恒拒)', !!toast)

    // ───────── I 图标 → 真 .app ─────────
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('spaces:addToDesktop')
      ipcMain.handle('spaces:addToDesktop', (_e, input) => { globalThis.__spaceShortcutInput = input; return { ok: false, code: 'unpackaged' } })
    })
    await win.waitForTimeout(800)
    await rightClick()
    await win.locator('.rb-menu button, .rb-menu [role="menuitem"]', { hasText: '添加到桌面' }).first().click().catch(() => {})
    const input = await until(() => app.evaluate(() => globalThis.__spaceShortcutInput), 8000)
    const dataUrl = input && input.iconPng
    check('I1 渲染层交来名字、兜底名和一张 PNG 图标', !!input && typeof input.name === 'string' && !!input.fallbackName && /^data:image\/png;base64,/.test(dataUrl || ''), input && { ...input, iconPng: dataUrl ? `${dataUrl.length} chars` : null })
    if (dataUrl) {
      const iconDir = path.join(home, 'icon')
      fs.mkdirSync(iconDir, { recursive: true })
      const src = path.join(iconDir, 'src.png')
      fs.writeFileSync(src, Buffer.from(dataUrl.split(',')[1], 'base64'))
      if (SHOTS) fs.copyFileSync(src, path.join(SHOTS, 'I-icon-1024.png'))
      if (process.platform === 'darwin') {
        const dims = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', src]).toString()
        check('I2 图标是 1024×1024', /pixelWidth: 1024/.test(dims) && /pixelHeight: 1024/.test(dims), dims.replace(/\s+/g, ' '))
        const iconPng = (size) => {
          const out = path.join(iconDir, `${size}.png`)
          execFileSync('sips', ['-z', String(size), String(size), src, '--out', out], { stdio: 'ignore' })
          return fs.readFileSync(out)
        }
        const { createSpaceShortcut } = loadTs(path.join(ROOT, 'electron/spaceShortcut.ts'))
        const desk = path.join(home, 'Desktop')
        fs.mkdirSync(desk)
        const r = await createSpaceShortcut({ id: SPACE, name: input.name }, {
          platform: 'darwin', isPackaged: true, desktopDir: desk, execPath: '/Applications/Forsion.app/Contents/MacOS/Forsion',
          iconDir: path.join(home, 'space-shortcuts'), fallbackName: input.fallbackName, iconPng,
        })
        check('I3 按 mac 的路子做出 .app', r.ok, r)
        if (r.ok) {
          let lint = ''
          try { lint = execFileSync('plutil', ['-lint', path.join(r.path, 'Contents/Info.plist')]).toString() } catch (e) { lint = String(e.stdout || e) }
          check('I4 Info.plist 合法', /OK/.test(lint), lint.trim())
          const iconset = path.join(home, 'AppIcon.iconset')
          let iconOk = false
          try { execFileSync('iconutil', ['-c', 'iconset', path.join(r.path, 'Contents/Resources/AppIcon.icns'), '-o', iconset]); iconOk = fs.readdirSync(iconset).length >= 5 } catch (e) { console.log(String(e.stderr || e)) }
          check('I5 AppIcon.icns 能被 iconutil 拆开', iconOk, iconOk ? fs.readdirSync(iconset) : undefined)
          check('I6 launch 可执行', (fs.statSync(path.join(r.path, 'Contents/MacOS/launch')).mode & 0o111) !== 0)
          if (SHOTS) {
            // Finder 会怎么画这个 .app:Quick Look 缩略图(读 CFBundleIconFile)。
            // qlmanage 画完也可能不退出(实测挂住),给它 20 秒。
            try { execFileSync('qlmanage', ['-t', '-s', '512', '-o', SHOTS, r.path], { stdio: 'ignore', timeout: 20000 }) } catch { /* 没有也不算失败 */ }
            fs.cpSync(r.path, path.join(SHOTS, path.basename(r.path)), { recursive: true })
          }
        }
      }
    }
  } finally {
    await app.close().catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); fs.rmSync(home, { recursive: true, force: true }); process.exit(1) })
