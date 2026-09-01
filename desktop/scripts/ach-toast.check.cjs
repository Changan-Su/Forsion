/**
 * 成就 toast 的交互契约(真 Electron)。2026-08-31 起 toast 可点(点击 = 开成就面板),
 * 于是多出三条纯 CSS/时序的约束,几何断言和单测都抓不到:
 *   1) **揭示前不能吃点击**:0~31% 信息条整条被 clip-path 藏在徽章后面(ach-t-body),
 *      这段时间点击层必须穿透 —— 否则用户点的是一块看着什么都没有的地方却把面板点开了。
 *      门在 css 的 `animation: ach-t-hit 4.6s step-end both`;删掉它这条立刻红(负对照实跑过)。
 *   2) **悬停/聚焦冻住**:CSS animation-play-state + tsx 的 held 必须同时冻,少一个就是
 *      「伸手去点的过程中它自己没了」,这一下落到下面的界面上。
 *   3) 不悬停时仍按原样自行消失(held 不能卡住)。
 * 触发用真成就:theme.change(切配色命令)与 chat.send(主页发一条),都是 goal=1。
 * 跑:npm run check:achtoast   (先 npm run build)
 */
const fs = require('fs'), os = require('os'), path = require('path')
const { _electron: electron } = require('playwright-core')
const ROOT = path.join(__dirname, '..')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const r = []
const say = (n, ok, d) => { r.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d !== undefined ? ' | ' + JSON.stringify(d) : ''}`) }
const atCenter = (win) => win.evaluate(() => {
  const t = document.querySelector('.ach-toast'); if (!t) return 'no-toast'
  const b = t.getBoundingClientRect()
  const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
  return el ? (el.className && el.className.baseVal !== undefined ? 'svg' : String(el.className || el.tagName)) : 'null'
})
;(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-toast-'))
  const stub = await startStubEngine()
  const app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, ROOT], cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
  const win = await app.firstWindow()
  const errors = []; win.on('pageerror', (e) => errors.push(e.message))
  await win.waitForSelector('#root'); await win.waitForTimeout(2500)
  for (const t of ['跳过引导', 'Skip']) { const b = win.getByText(t, { exact: true }).first(); if (await b.count()) { await b.click(); break } }
  await win.waitForTimeout(800)
  const fire = async () => {
    await win.keyboard.press('Escape').catch(() => {}); await win.waitForTimeout(120)
    if (!(await win.$('.cmd-overlay'))) await win.click('.rb-bottom .rb-slot[data-id="rb-cmd"] button')
    await win.waitForSelector('.cmd-input'); await win.fill('.cmd-input', '配色'); await win.waitForTimeout(200)
    await win.keyboard.press('Enter')
    await win.waitForSelector('.ach-toast', { timeout: 5000 })
  }

  await fire()
  await win.waitForTimeout(400) // ≈9%:信息条还整条藏在徽章后
  say('揭示前(≈0.4s)点击穿透,不是隐形点击区', (await atCenter(win)) !== 'ach-toast-hit', await atCenter(win))
  await win.waitForTimeout(1300) // ≈37%:已揭示
  say('揭示后(≈1.7s)点击层接管', (await atCenter(win)) === 'ach-toast-hit', await atCenter(win))

  // 悬停冻结:光标压住不动,越过 4.6s 动画 + 5.2s 兜底都不该消失
  await win.hover('.ach-toast .ach-toast-hit')
  await win.waitForTimeout(6000)
  say('悬停时 toast 冻住不自行消失(>5.2s)', !!(await win.$('.ach-toast')))
  const paused = await win.evaluate(() => getComputedStyle(document.querySelector('.ach-toast')).animationPlayState)
  say('悬停时根动画 paused', paused === 'paused', paused)

  await win.click('.ach-toast .ach-toast-hit'); await win.waitForTimeout(800)
  say('点击 → 成就面板打开', await win.evaluate(() => !!document.querySelector('.fs-overlay, .settings-page')))
  say('点击 → toast 收掉', !(await win.$('.ach-toast')))
  await win.click('.settings-back'); await win.waitForTimeout(700)

  // 不悬停时照旧自行消失。theme.change 那条已被上面消耗(goal=1 只跨线一次),换 chat.send 触发另一条。
  await win.click('.hp-composer textarea')
  await win.keyboard.type('hi')
  await win.keyboard.press('Enter')
  await win.waitForSelector('.ach-toast', { timeout: 8000 })
  await win.mouse.move(20, 20)
  await win.waitForTimeout(6200)
  say('不悬停时仍会自行消失', !(await win.$('.ach-toast')))
  say('无未捕获渲染异常', errors.length === 0, errors)
  await app.close(); await stub.close?.()
  console.log(`${r.filter(Boolean).length}/${r.length} 通过`)
  process.exit(r.every(Boolean) ? 0 : 1)
})().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
