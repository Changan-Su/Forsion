/**
 * 全局语音输入(听写)的真 Electron 台架 —— macOS。先 `npx electron-vite build`,再 `npm run e2e:dictation`。
 *
 * 覆盖:官方插件缺省关 → 打开即注册全局快捷键 / 换键 / 关掉即撤;胶囊(桌面作用域浮层)出现时不抢焦点(Forsion 自己的窗口保持聚焦、
 * 别的应用在前台时前台不变 —— 用系统的前台应用读数核,不是看 Electron 自己的说法);说话 → 实时转写 → 写进 Forsion 自己的输入框;
 * 密码框拒绝 + 复制;写进别的应用(Finder 在前台)走 JXA 的整条剪贴板事务:快照 → 写 → 还原,目标换了就不写、留复制;Esc 只在有胶囊时注册。
 *
 * 不碰用户的东西:剪贴板操作走私有命名剪贴板(FORSION_DICTATION_PASTEBOARD),驱动在私有剪贴板上绝不发 ⌘V;全局快捷键由台架直接调控制器
 * (FORSION_E2E_DICTATION 挂出来的 toggle,即快捷键回调本身),不合成系统按键;麦克风换成合成音;转写是本地假服务。
 * 结束时把台架开始前的前台应用切回去。真 ⌘V 与真点胶囊(系统级点击不激活 Forsion)这两下要辅助功能授权,台架不做,见 gui-verify 的
 * computer use 那一轮。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { WebSocketServer } = require('ws')
const { boot, launch, shotDir, sleep } = require('./lib/uiux-electron.cjs')

if (process.platform !== 'darwin') { console.log('SKIP: dictation e2e runs on macOS (Windows: see the GitHub issue checklist)'); process.exit(0) }

const BOARD = `com.forsion.dictation.e2e.${process.pid}`
process.env.FORSION_E2E_DICTATION = '1'
process.env.FORSION_DICTATION_PASTEBOARD = BOARD

const jxa = (body) => execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); ${body}`], { encoding: 'utf8' }).trim()
const frontPid = () => Number(jxa('Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier)'))
const activatePid = (pid) => jxa(`var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${Number(pid)}); a.isNil() ? 'gone' : String(a.activateWithOptions(2))`)
const finderPid = () => Number(jxa(`var l = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.finder'); Number(l.count) ? Number(l.objectAtIndex(0).processIdentifier) : 0`))
const board = (body) => jxa(`var pb = $.NSPasteboard.pasteboardWithName($(${JSON.stringify(BOARD)})); ${body}`)
const seedBoard = () => board(`pb.clearContents
  var a = $.NSPasteboardItem.alloc.init; a.setStringForType($('user clipboard'), $.NSPasteboardTypeString)
  a.setDataForType($('rich').dataUsingEncoding($.NSUTF8StringEncoding), $('com.forsion.e2e.rich'))
  var arr = $.NSMutableArray.alloc.init; arr.addObject(a); pb.writeObjects(arr); ''`)
const readBoard = () => JSON.parse(board(`var out = [], items = pb.pasteboardItems, n = Number(items.count)
  for (var i = 0; i < n; i++) { var it = items.objectAtIndex(i), ts = it.types, m = Number(ts.count), o = {}
    for (var j = 0; j < m; j++) { var t = ts.objectAtIndex(j); o[ObjC.unwrap(t)] = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(it.dataForType(t), $.NSUTF8StringEncoding)) }
    out.push(o) }
  JSON.stringify(out)`))

async function until(fn, what, timeout = 8000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    last = await fn()
    if (last) return last
    await sleep(60)
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`)
}

async function main() {
  // 假的 Forsion 实时转写(同 voice-input.e2e 的协议):每段音频回一点中间结果,finish 时回定稿。
  let sessions = 0
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{}') })
  const sockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/api/brain/realtime?mode=transcription&') || req.headers.authorization !== 'Bearer dictation-fixture') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      sessions++
      const send = (type, fields = {}) => ws.send(JSON.stringify({ type, ...fields }))
      let frames = 0
      send('dictation.supported')
      send('session.updated')
      ws.on('message', (data, binary) => {
        if (binary) {
          if (++frames === 2) send('conversation.item.input_audio_transcription.text', { item_id: 'one', text: '今天', stash: '讨论的' })
          return
        }
        if (String(data) !== 'finish') return
        send('conversation.item.input_audio_transcription.completed', { item_id: 'one', transcript: '今天讨论了三件事。' })
        send('session.finished')
      })
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const cloudUrl = `http://127.0.0.1:${server.address().port}`
  const userFront = frontPid()
  const shots = shotDir('dictation')
  let ctx
  let passed = 0
  const ok = (name) => { passed++; console.log(`PASS ${name}`) }
  try {
    ctx = await launch({
      tag: 'dictation-e2e', overrideHome: true,
      beforeLaunch: ({ home }) => fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ cloudUrl, token: 'dictation-fixture' })),
    })
    const { app, win } = ctx
    await boot(app, win, { space: 'tangu', width: 1150, height: 750 })
    const electronPid = await app.evaluate(() => process.pid)
    const state = () => win.evaluate(() => window.tangu.dictation.state())
    const registered = (accel) => app.evaluate(({ globalShortcut }, a) => globalShortcut.isRegistered(a), accel)
    const ctl = (method, ...args) => app.evaluate((_e, a) => globalThis.__forsionDictation.controller[a.method](...a.args), { method, args })
    const phase = async () => (await ctl('state')).phase
    const capsuleInfo = () => app.evaluate(({ BrowserWindow }) => {
      const w = globalThis.__forsionDictation.capsule.window()
      if (!w) return null
      return { visible: w.isVisible(), focused: w.isFocused(), focusable: w.isFocusable(), onTop: w.isAlwaysOnTop(), focusedWindowIsCapsule: BrowserWindow.getFocusedWindow() === w, bounds: w.getBounds() }
    })

    // ── 1. 官方插件缺省关:不占快捷键;窄接口上没有写字的方法 ──
    const s0 = await state()
    assert.equal(s0.enabled, false)
    assert.equal(await registered('Alt+Shift+Space'), false)
    assert.deepEqual(Object.keys(await win.evaluate(() => Object.fromEntries(Object.keys(window.tangu.dictation).map((k) => [k, 1])))).sort(), ['allowAccessibility', 'attach', 'onChange', 'setHotkey', 'state'])
    assert.ok((await win.evaluate(() => localStorage.getItem('amadeus.plugins.disabled'))).includes('voice-input'))
    ok('the official plugin ships off and claims no shortcut; the bridge has no way to type')

    // ── 2. 打开插件 → 主窗挂租约 → 注册快捷键、胶囊预先建好藏着;换键 ──
    await win.evaluate(() => {
      const off = JSON.parse(localStorage.getItem('amadeus.plugins.disabled') || '[]').filter((x) => x !== 'voice-input')
      localStorage.setItem('amadeus.plugins.disabled', JSON.stringify(off))
    })
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await until(async () => (await state()).enabled, 'service enabled by the plugin lease')
    const defaultTaken = !(await registered('Alt+Shift+Space'))
    if (defaultTaken) console.log('NOTE: Alt+Shift+Space is taken by another app on this machine; continuing with the test shortcut')
    await win.evaluate(() => window.tangu.dictation.setHotkey('alt+shift+f9'))
    assert.equal(await registered('Alt+Shift+F9'), true)
    assert.equal(await registered('Alt+Shift+Space'), false)
    assert.equal((await state()).hotkey, 'alt+shift+f9')
    const prepared = await until(capsuleInfo, 'capsule window prepared')
    assert.equal(prepared.visible, false)
    assert.equal(prepared.focusable, false)
    ok('enabling the plugin registers the global shortcut; changing it re-registers; the capsule waits hidden')

    // 胶囊页:麦克风换成合成音
    const capsule = await until(() => app.windows().find((p) => p.url().includes('dictation.html')), 'capsule page')
    await capsule.waitForLoadState('domcontentloaded')
    await capsule.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const ac = new AudioContext()
        const dst = ac.createMediaStreamDestination()
        const osc = ac.createOscillator()
        osc.connect(dst)
        osc.start()
        await ac.resume()
        dst.stream.getAudioTracks()[0].stop = () => { void ac.close() }
        return dst.stream
      }
    })

    // DICTATION_HOLD=<秒>:停在这里给 computer use 那一轮用(真按快捷键 ⌥⇧F9、真点胶囊上的按钮),每次状态变化打印前台应用;不跑后面的断言。
    const hold = Number(process.env.DICTATION_HOLD || 0)
    if (hold > 0) {
      console.log(`HOLD ${hold}s: press Alt+Shift+F9 in any app (Forsion pid ${electronPid}); capsule clicks are real OS clicks now`)
      let last = ''
      const end = Date.now() + hold * 1000
      while (Date.now() < end) {
        const s = await ctl('state')
        const c = await capsuleInfo()
        const line = `${s.phase}${s.failure ? ':' + s.failure : ''} front=${frontPid()} capsuleVisible=${!!c?.visible} capsuleFocused=${!!c?.focused} forsionFocusedWindow=${await app.evaluate(({ BrowserWindow }) => !!BrowserWindow.getFocusedWindow())}`
        if (line !== last) { console.log(new Date().toISOString().slice(11, 23), line); last = line }
        await sleep(150)
      }
      return
    }

    // ── 3. Forsion 自己的输入框:胶囊不抢焦点,实时字出现在胶囊上,写进光标处 ──
    await app.evaluate(({ app: a, BrowserWindow }) => {
      a.focus({ steal: true })
      const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('dictation.html'))
      main?.focus()
    })
    const input = win.locator('.t2-chat-view:visible .t2c-ta').first()
    await input.click()
    await input.fill('记一下：')
    await until(async () => frontPid() === electronPid, 'Forsion in front')
    await ctl('toggle')
    await until(async () => (await phase()) === 'listening', 'listening')
    const shown = await until(async () => { const c = await capsuleInfo(); return c?.visible && c }, 'capsule visible')
    assert.equal(shown.focused, false)
    assert.equal(shown.focusedWindowIsCapsule, false)
    assert.equal(shown.onTop, true)
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL().includes('dictation.html') ?? null), false)
    assert.equal(frontPid(), electronPid)
    assert.equal(await registered('Escape'), true)
    await capsule.waitForFunction(() => /今天/.test(document.querySelector('.dcap-line')?.textContent || ''), null, { timeout: 8000 })
    await capsule.screenshot({ path: path.join(shots, 'listening.png') })
    await ctl('toggle')
    await win.waitForFunction(() => [...document.querySelectorAll('.t2-chat-view .t2c-ta')].some((t) => t.checkVisibility() && t.value === '记一下：今天讨论了三件事。'), null, { timeout: 10_000 })
    await until(async () => (await phase()) === 'idle', 'idle after done')
    assert.equal(await registered('Escape'), false)
    assert.equal((await capsuleInfo()).visible, false)
    ok('own window: capsule never takes focus, live text shows, the result lands at the caret, Esc is released')

    // ── 4. 密码框:不写,留复制(复制走私有剪贴板)──
    await win.evaluate(() => {
      const i = document.createElement('input')
      i.type = 'password'
      i.id = 'dictation-e2e-pw'
      i.style.cssText = 'position:fixed;left:12px;top:12px;z-index:2147483647'
      document.body.append(i)
      i.focus()
    })
    await ctl('toggle')
    await until(async () => (await phase()) === 'listening', 'listening (password)')
    await capsule.waitForFunction(() => /今天/.test(document.querySelector('.dcap-line')?.textContent || ''), null, { timeout: 8000 })
    await ctl('toggle')
    const refused = await until(async () => { const s = await ctl('state'); return s.phase === 'failed' && s }, 'refusal')
    assert.equal(refused.failure, 'secure-field')
    assert.equal(refused.text, '今天讨论了三件事。')
    assert.equal(await win.evaluate(() => document.getElementById('dictation-e2e-pw').value), '')
    await capsule.waitForSelector('.dcap-primary', { timeout: 5000 })
    await capsule.screenshot({ path: path.join(shots, 'refused-password.png') })
    await capsule.click('.dcap-primary')
    await until(async () => (await ctl('state')).copied, 'copied')
    assert.deepEqual(readBoard(), [{ 'public.utf8-plain-text': '今天讨论了三件事。' }])
    await win.evaluate(() => document.getElementById('dictation-e2e-pw').remove())
    await until(async () => (await phase()) === 'idle', 'idle after copy')
    ok('password field: nothing typed, Copy puts the text on the clipboard')

    // ── 5. 别的应用在前台(Finder):胶囊出现、点胶囊上的按钮,前台都不变;剪贴板事务:写完原样还原 ──
    const finder = finderPid()
    if (!finder) throw new Error('Finder is not running')
    activatePid(finder)
    await until(async () => frontPid() === finder, 'Finder in front')
    seedBoard()
    const seeded = readBoard()
    await ctl('toggle')
    await until(async () => (await phase()) === 'listening', 'listening (external)')
    await until(async () => (await capsuleInfo())?.visible, 'capsule visible over Finder')
    await sleep(300)
    assert.equal(frontPid(), finder, 'showing the capsule must not bring Forsion to the front')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow() === null), true)
    await capsule.waitForFunction(() => /今天/.test(document.querySelector('.dcap-line')?.textContent || ''), null, { timeout: 8000 })
    await capsule.click('.dcap-primary') // 「完成」(页内点击;系统级点击不激活要 computer use 那一轮验)
    await until(async () => ['done', 'idle'].includes(await phase()), 'inserted into Finder (private clipboard)', 12_000)
    assert.equal(frontPid(), finder)
    assert.deepEqual(readBoard(), seeded)
    ok('another app in front: capsule keeps it in front; clipboard transaction restores what the user had')

    // ── 6. 说着话切走了应用:不写,留复制 ──
    await until(async () => (await phase()) === 'idle', 'idle')
    activatePid(finder)
    await until(async () => frontPid() === finder, 'Finder in front again')
    seedBoard()
    await ctl('toggle')
    await until(async () => (await phase()) === 'listening', 'listening (switch away)')
    await capsule.waitForFunction(() => /今天/.test(document.querySelector('.dcap-line')?.textContent || ''), null, { timeout: 8000 })
    activatePid(electronPid)
    await until(async () => frontPid() === electronPid, 'Forsion in front (user switched)')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('dictation.html'))?.focus())
    await ctl('toggle')
    const moved = await until(async () => { const s = await ctl('state'); return s.phase === 'failed' && s }, 'target-changed')
    assert.equal(moved.failure, 'target-changed')
    assert.deepEqual(readBoard(), [{ 'public.utf8-plain-text': 'user clipboard', 'com.forsion.e2e.rich': 'rich' }])
    await capsule.screenshot({ path: path.join(shots, 'target-changed.png') })
    await capsule.click('.dcap-primary')
    await until(async () => (await ctl('state')).copied, 'copied after target change')
    assert.deepEqual(readBoard(), [{ 'public.utf8-plain-text': '今天讨论了三件事。' }])
    ok('switching apps mid-dictation: nothing typed into the new app, Copy offered')

    // ── 7. Esc(取消)只在有胶囊时是全局键 ──
    await until(async () => (await phase()) === 'idle', 'idle')
    assert.equal(await registered('Escape'), false)
    await ctl('toggle')
    await until(async () => (await phase()) === 'listening', 'listening (cancel)')
    assert.equal(await registered('Escape'), true)
    await ctl('cancel')
    assert.equal(await phase(), 'idle')
    assert.equal(await registered('Escape'), false)
    await until(async () => !(await capsuleInfo()).visible, 'capsule hidden after cancel')
    ok('Esc is global only while the capsule is up; cancel discards')

    // ── 8. 关掉插件:租约随主窗重载撤掉,快捷键撤、胶囊收 ──
    await win.evaluate(() => {
      const off = JSON.parse(localStorage.getItem('amadeus.plugins.disabled') || '[]')
      if (!off.includes('voice-input')) off.push('voice-input')
      localStorage.setItem('amadeus.plugins.disabled', JSON.stringify(off))
    })
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await until(async () => !(await state()).enabled, 'service off after disabling the plugin')
    assert.equal(await registered('Alt+Shift+F9'), false)
    assert.equal(await capsuleInfo(), null)
    ok('disabling the plugin releases the shortcut and closes the capsule')

    assert.ok(sessions >= 4, `expected several streaming sessions, got ${sessions}`)
    console.log(`\n${passed} passed. Screenshots: ${shots}`)
  } finally {
    try { if (userFront) activatePid(userFront) } catch { /* ignore */ }
    try { board('pb.releaseGlobally; ""') } catch { /* ignore */ }
    if (ctx) await ctx.close()
    server.close()
  }
}

main().catch((e) => { console.error('FAIL', e); process.exit(1) })
