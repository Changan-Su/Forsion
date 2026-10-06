/**
 * 侧边拼接(App Dock)**真机**台架 —— 真 Electron 主进程 × 真 CU helper(协议 14,缺省 dev-recorder 起的那个)× 真 TextEdit 窗口。
 *
 * 为什么不用假 helper:这功能的全部价值在「两扇不同进程的窗口看起来是一扇」—— 位置跟没跟上、层级对不对、
 * 最小化后藏没藏,只有 WindowServer 说了算。假 helper 回什么面板就摆什么,一条都证不了。
 *
 * 目标窗口用 TextEdit 自己的 AppleScript 挪 / 缩放 / 最小化:不需要辅助功能授权,只要本终端能给 TextEdit 发 Apple Event。
 * 台架只碰**自己新建的那篇**(按窗口名寻址),收尾时不存盘关掉。用户已经开着的 TextEdit 文档不动。
 *
 * 需要 helper 有「辅助功能」才能验的(没有就记「未验」,不假装通过):
 *  - 用户拖面板 → 目标跟着走(setWindowFrame 走 AX)
 *  - 读划线(selection 走 AX)
 * dev helper 授权:Forsion-Instrumentality-Project/tangu-computer-use 下 `node scripts/dev-recorder.mjs grant`,系统设置里拨开,再 stop + start。
 *
 * 负对照:--nc=nofollow  把跟随间隔设成 1 小时(DOCK_FOLLOW_MS 环境变量)→ T2「挪目标面板跟上」必须红。
 *
 * 用法:npm run build && npm run e2e:appdock   [--nc=nofollow] [--keep]
 *   DOCK_SOCK=<helper socket>  缺省 ~/Library/Caches/tangu-computer-use-dev/bridge.sock
 * 截图:os.tmpdir()/forsion-app-dock-e2e/(DESIGN §8:几何全绿 ≠ 看起来对,自己看)。
 */
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.join(__dirname, '..')
const SHOT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), 'forsion-app-dock-e2e')
const SOCK = process.env.DOCK_SOCK || path.join(os.homedir(), 'Library/Caches/tangu-computer-use-dev/bridge.sock')
const argv = process.argv.slice(2)
const NC = (argv.find((a) => a.startsWith('--nc=')) || '').split('=')[1] || ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  const d = detail === undefined ? '' : `  | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d.length > 500 ? d.slice(0, 500) + '…' : d}`)
}
function skip(name, why) { results.push({ name, skipped: true }); console.log(`SKIP  ${name}  | 未验:${why}`) }

function ask(payload, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCK)
    let buf = ''
    const t = setTimeout(() => { s.destroy(); reject(new Error('timeout')) }, timeoutMs)
    s.setEncoding('utf8')
    s.on('connect', () => s.write(JSON.stringify({ id: 'e2e', ...payload }) + '\n'))
    s.on('data', (c) => {
      buf += c
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      clearTimeout(t); s.destroy()
      const p = JSON.parse(buf.slice(0, nl))
      p.ok ? resolve(p.result) : reject(Object.assign(new Error(p.error && p.error.message), { code: p.error && p.error.code }))
    })
    s.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

// ── TextEdit:只碰自己新建的那篇 ──────────────────────────────────────────────────────────────
const osa = (...lines) => execFileSync('osascript', lines.flatMap((l) => ['-e', l]), { encoding: 'utf8' }).trim()
const te = {
  name: '',
  open() {
    this.name = osa('tell application "TextEdit"', 'set d to make new document with properties {text:"Forsion dock e2e — select me"}', 'return name of d', 'end tell')
    return this.name
  },
  /** AppleScript 的 bounds = {左, 上, 右, 下},原点主屏左上(与 CG / Electron 同一坐标系)。 */
  setRect(x, y, w, h) { osa(`tell application "TextEdit" to set bounds of window "${this.name}" to {${x}, ${y}, ${x + w}, ${y + h}}`) },
  minimize(on) { osa(`tell application "TextEdit" to set miniaturized of window "${this.name}" to ${on}`) },
  activate() { osa('tell application "TextEdit" to activate') },
  close() { if (this.name) try { osa(`tell application "TextEdit" to close document "${this.name}" saving no`) } catch { /* 已关 */ } },
}
const activateFinder = () => osa('tell application "Finder" to activate')

async function closeApp(app) {
  if (!app) return
  const closed = await Promise.race([app.close().then(() => true, () => false), sleep(15_000).then(() => false)])
  if (!closed) { try { app.process().kill('SIGKILL') } catch { /* 已退 */ } }
}

async function main() {
  if (process.platform !== 'darwin') { console.log('SKIP  侧边拼接只支持 macOS'); process.exit(0) }
  const mainJs = path.join(ROOT, 'out/main/main.js')
  if (!fs.existsSync(mainJs) || !fs.readFileSync(mainJs, 'utf8').includes('appDock:open')) {
    console.error('out/main/main.js 缺失或是旧的(没有 appDock:open)—— 先跑 npm run build'); process.exit(1)
  }
  const diag = await ask({ cmd: 'diagnostics' }).catch((e) => { console.error(`helper 不在 ${SOCK}(${e.code || e.message})—— 先 node scripts/dev-recorder.mjs build && start`); process.exit(1) })
  if (diag.protocolVersion < 14) { console.error(`helper 协议 ${diag.protocolVersion} < 14,不认 dockProbe —— 重编 dev helper`); process.exit(1) }
  const hasAX = diag.accessibility === true
  if (NC) console.log(`⚠️ 负对照 --nc=${NC}:期望对应断言变红\n`)
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-dock-'))
  const stub = await startStubEngine({ sessions: [], messages: [], models: [] })
  const env = { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, PI_CU_SOCKET_PATH: SOCK, TANGU_HARNESS_QUIET: '0' }
  if (NC === 'nofollow') env.DOCK_FOLLOW_MS = '3600000'
  let app, wasHidden = false, mine = null
  try {
    wasHidden = osa('tell application "System Events" to get visible of process "TextEdit"') === 'false'
    te.open()
    te.activate() // TextEdit 被 ⌘H 过时整个 App 是隐藏的,窗口不在屏上(CG onScreen=false),候选里自然没有它
    te.setRect(120, 120, 700, 520)
    await sleep(400)
    // 按 windowId 认那一行:helper 没有屏幕录制 / 辅助功能时标题全空,按标题认不出来
    mine = (await ask({ cmd: 'dockCandidates' })).windows.find((w) => w.app === 'TextEdit' && w.x === 120 && w.y === 120 && w.w === 700)
    if (!mine) throw new Error('helper 的候选里找不到台架新建的 TextEdit 窗口(120,120,700×520)')
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT, env })
    const win = await app.firstWindow()
    check('T0 首启引导已跳过', await skipOnboarding(win))

    // ── 打开面板(命令面板入口走的就是这条)→ 候选里有我们那扇 TextEdit ──
    const opened = app.waitForEvent('window', { predicate: (p) => /dock=1/.test(p.url()), timeout: 20_000 })
    const r = await win.evaluate(() => window.tangu.appDockOpen())
    check('T1 appDockOpen 成功', r && r.ok, r)
    const dock = await opened
    const row = dock.locator(`.dock-picker-row[data-window-id="${mine.windowId}"]`)
    await row.first().waitFor({ timeout: 15_000 }).catch(() => {})
    check('T1b 候选列表里有那扇 TextEdit 窗口', await row.count() > 0, await dock.locator('.dock-picker-row').allInnerTexts().catch(() => []))
    await dock.screenshot({ path: path.join(SHOT_DIR, 'picker.png') })
    await row.first().click()

    const dockBounds = () => app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => /dock=1/.test(x.webContents.getURL()))
      return w ? { ...w.getBounds(), visible: w.isVisible(), id: Number(w.getMediaSourceId().split(':')[1]) } : null
    })
    const targetRect = async () => {
      const list = (await ask({ cmd: 'dockCandidates' })).windows
      const t = list.find((w) => w.windowId === mine.windowId)
      return t ? { x: t.x, y: t.y, width: t.w, height: t.h, windowId: t.windowId } : null
    }
    const glued = async () => {
      const t = await targetRect(); const d = await dockBounds()
      return { ok: !!t && !!d && d.visible && d.x === t.x + t.width && d.y === t.y && d.height === t.height, t, d }
    }
    await sleep(600)
    let g = await glued()
    check('T2 贴上:面板紧贴目标右沿,上沿、高度一致', g.ok, g)
    await dock.locator('[data-ref-kind="app"]').first().waitFor({ timeout: 10_000 }).catch(() => {})
    check('T2b 输入框上默认挂着这个 App 的引用芯片', await dock.locator('[data-ref-kind="app"]', { hasText: 'TextEdit' }).count() > 0)

    // ── 目标 → 面板 ──
    te.setRect(260, 160, 640, 460)
    await sleep(300)
    g = await glued()
    check('T3 挪目标 + 改尺寸:面板 300ms 内跟上', g.ok, g)
    te.minimize(true)
    await sleep(900)
    check('T4 目标最小化 → 面板藏起', (await dockBounds())?.visible === false, await dockBounds())
    te.minimize(false)
    // 还原的神灯动画在机器忙时能拖到 1s+;按「贴好了」轮询,最多 3s(断言的是最终贴好,不是动画时长)
    for (let i = 0; i < 15; i++) { await sleep(200); g = await glued(); if (g.ok) break }
    check('T4b 目标还原 → 面板回来并贴好', g.ok, g)

    // ── 层级:别的 App 到前台再切回目标,面板必须在目标之上(CGWindowList 前→后的顺序)──
    activateFinder(); await sleep(500)
    te.activate(); await sleep(500)
    const order = (await ask({ cmd: 'dockCandidates' })).windows.map((w) => w.windowId)
    const d = await dockBounds(); const t = await targetRect()
    const iDock = order.indexOf(d.id), iTarget = order.indexOf(t.windowId)
    check('T5 目标 App 到前台 → 面板在它之上(不抢焦点)', iDock >= 0 && iTarget >= 0 && iDock < iTarget, { iDock, iTarget, top: order.slice(0, 4) })
    try { execFileSync('screencapture', ['-x', '-R', `${t.x - 10},${t.y - 10},${t.width + d.width + 20},${t.height + 20}`, path.join(SHOT_DIR, 'docked.png')]) } catch { console.log('NOTE  screencapture 失败(本终端没有屏幕录制权限),只留了面板自身截图') }
    await dock.screenshot({ path: path.join(SHOT_DIR, 'panel.png') })

    // ── 面板 → 目标(要 AX)──
    if (hasAX) {
      const before = await targetRect()
      await app.evaluate(({ BrowserWindow }, dx) => {
        const w = BrowserWindow.getAllWindows().find((x) => /dock=1/.test(x.webContents.getURL()))
        const b = w.getBounds(); w.setBounds({ ...b, x: b.x + dx, y: b.y + 40 })
      }, 80)
      await sleep(900)
      const after = await targetRect()
      check('T6 拖面板 → 目标跟着走(只挪不缩放)', after.x === before.x + 80 && after.y === before.y + 40 && after.width === before.width, { before, after })
      const sel = await dock.evaluate(() => window.tangu.appDockSelection())
      check('T7 读得到目标 App 的焦点信息(选区读取通路通)', sel && !sel.error, sel)
    } else {
      skip('T6 拖面板 → 目标跟着走', 'helper 没有辅助功能授权(setWindowFrame 走 AX)')
      skip('T7 读划线', 'helper 没有辅助功能授权(selection 走 AX)')
    }

    // ── 目标关掉 → 面板收起 ──
    const dockClosed = dock.waitForEvent('close', { timeout: 5_000 }).then(() => true, () => false)
    te.close(); te.name = ''
    check('T8 目标窗口关掉 → 面板一并收起', await dockClosed)
  } catch (e) {
    check('台架异常', false, String(e && e.stack || e))
  } finally {
    te.close()
    if (wasHidden) try { osa('tell application "System Events" to set visible of process "TextEdit" to false') } catch { /* 还原不了就算了 */ }
    await closeApp(app)
    try { stub.close() } catch { /* ignore */ }
    if (!argv.includes('--keep')) fs.rmSync(home, { recursive: true, force: true })
  }
  const passed = results.filter((x) => x.ok === true).length
  const failed = results.filter((x) => !x.skipped && x.ok !== true).length
  const unverified = results.filter((x) => x.skipped).length
  console.log(`\n${passed} passed / ${failed} failed / ${unverified} 未验  (总 ${results.length})`)
  console.log(`截图 → ${SHOT_DIR}`)
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
