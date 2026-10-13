/**
 * 应用 / 窗口引用 真 Electron 验收:气泡里的芯片与状态、点击打开、`[[` 菜单的分类胶囊、句内芯片(镜像层)、
 * 「已选择」条的 Shift+点击、发出去的文本、双 ⌘ 快捷键。
 *
 * 不碰这台电脑上的真应用:窗口 / 进程清单由本文件起的假 CU helper 回(PI_CU_SOCKET_PATH),
 * mdfind / open 换成夹具脚本(FORSION_APPREF_BIN_DIR)—— open 只把参数记进日志,不真的拉起任何东西。
 *
 * 用法:npm run build && npm run e2e:apprefs
 *   ZOOM=1.1   界面缩放(缺省 1;用户的 dev 常年 1.1,镜像层对不对齐两种都要看)
 * 截图:os.tmpdir()/forsion-app-refs-e2e/(DESIGN §8:几何全绿 ≠ 看起来对,自己看)。
 */
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.join(__dirname, '..')
const ZOOM = Number(process.env.ZOOM || 1)
const SHOT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), 'forsion-app-refs-e2e')
const tag = ZOOM === 1 ? '' : `-z${Math.round(ZOOM * 100)}`
const LEAD = '  '
const TAIL = ' '

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  const d = detail === undefined ? '' : `  | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d.length > 600 ? d.slice(0, 600) + '…' : d}`)
}

const APPS = [
  { appName: 'Google Chrome', pid: 11, bundleId: 'com.google.Chrome', isFrontmost: true },
  { appName: 'Numbers', pid: 12, bundleId: 'com.apple.iWork.Numbers' },
  { appName: 'Keynote', pid: 13, bundleId: 'com.apple.iWork.Keynote' },
]
const WINDOWS = [
  { pid: 11, windowId: 101, app: 'Google Chrome', bundleId: 'com.google.Chrome', title: 'Linear – Pricing', x: 0, y: 0, w: 900, h: 700 },
  { pid: 11, windowId: 102, app: 'Google Chrome', bundleId: 'com.google.Chrome', title: 'GitHub', x: 0, y: 0, w: 900, h: 700 },
  { pid: 12, windowId: 201, app: 'Numbers', bundleId: 'com.apple.iWork.Numbers', title: '季度预算.numbers', x: 0, y: 0, w: 900, h: 700 },
]

function startFakeHelper(sockPath) {
  const requests = []
  const server = net.createServer((socket) => {
    let buf = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        requests.push(msg)
        const ok = (result) => socket.destroyed || socket.write(`${JSON.stringify({ id: msg.id, ok: true, result })}\n`)
        if (msg.cmd === 'diagnostics') ok({ protocolVersion: 14, version: 'fake-e2e' })
        else if (msg.cmd === 'listApps') ok(APPS)
        else if (msg.cmd === 'dockCandidates') ok({ windows: WINDOWS })
        else if (msg.cmd === 'listWindows') ok(msg.pid === 13 ? [{ title: 'Q4 路演.key', windowId: 301 }] : [])
        else if (msg.cmd === 'focusWindow') ok({ focused: true })
        else socket.write(`${JSON.stringify({ id: msg.id, ok: false, error: { code: 'unknown_command', message: msg.cmd } })}\n`)
      }
    })
    socket.on('error', () => {})
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(sockPath, () => resolve({ requests, close: () => server.close() }))
  })
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-apprefs-'))
  const userdata = path.join(home, 'userdata')
  const vault = path.join(home, 'vault')
  const bin = path.join(home, 'bin')
  const openLog = path.join(home, 'open.log')
  for (const d of [userdata, vault, bin]) fs.mkdirSync(d)
  fs.writeFileSync(path.join(vault, '季度复盘.md'), '# 季度复盘\n')
  fs.writeFileSync(path.join(userdata, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  const md = (p, id, name) => `${p}   kMDItemCFBundleIdentifier = ${id}   kMDItemDisplayName = ${name}`
  fs.writeFileSync(path.join(bin, 'mdfind'), `#!/bin/sh\ncat <<'EOF'\n${[
    md('/Applications/Google Chrome.app', 'com.google.Chrome', 'Google Chrome'),
    md('/Applications/Numbers.app', 'com.apple.iWork.Numbers', 'Numbers'),
    md('/Applications/Keynote.app', 'com.apple.iWork.Keynote', 'Keynote'),
    md('/Applications/WeChat.app', 'com.tencent.xinWeChat', '微信'),
    md('/Applications/Lark.app', 'com.electron.lark', '飞书'),
  ].join('\n')}\nEOF\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\necho "$@" >> '${openLog}'\n`, { mode: 0o755 })
  fs.writeFileSync(openLog, '')
  const opened = () => fs.readFileSync(openLog, 'utf8').split('\n').filter(Boolean)

  const sock = path.join(home, 'h.sock')
  const helper = await startFakeHelper(sock)
  const at = Date.UTC(2026, 9, 13)
  const stub = await startStubEngine({
    sessions: [{ id: 'older', title: '定价讨论', model_id: 'm1', archived: false, agent_config: null, project_path: null, project_name: null, created_at: '2026-10-12 12:00:00', updated_at: '2026-10-12 12:00:00' }, { id: 'apprefs', title: '应用引用', model_id: 'm1', archived: false, agent_config: null, project_path: null, project_name: null, created_at: '2026-10-13 12:00:00', updated_at: '2026-10-13 12:00:00' }],
    messages: [
      { id: 'u1', role: 'user', content: '[[app://com.tencent.xinWeChat|微信]]\n把 [[window://com.google.Chrome|Linear – Pricing]] 里的定价和 [[window://com.apple.iWork.Numbers|竞品对比.numbers]] 对一下', timestamp: at, attachments: null },
      { id: 'a1', role: 'model', content: '对完了,结论写进了 [[window://com.apple.iWork.Keynote|Q4 路演.key]] 的第 3 页。没装的应用长这样:[[app://com.example.gone|Gone]]', timestamp: at + 1000 },
    ],
  })

  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, PI_CU_SOCKET_PATH: sock, FORSION_APPREF_BIN_DIR: bin },
    })
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 1000))
    await win.waitForSelector('#root')
    await win.evaluate((zoom) => {
      localStorage.setItem('forsion_default_space', 'tangu')
      // 新用户目录首次启动会把存着的缩放清一次(2.10.0 的默认值迁移),先标成迁移过再写
      if (zoom !== 1) { localStorage.setItem('forsion_ui_zoom_default_2_10_0', '1'); localStorage.setItem('forsion_ui_zoom', String(zoom)) }
    }, ZOOM)
    await win.reload({ waitUntil: 'domcontentloaded' })
    check('离开首启引导', await skipOnboarding(win))
    const view = win.locator('.t2-chat-view').first()
    await view.locator('#tocmsg-u1').waitFor()
    await win.locator('#tangu-splash').waitFor({ state: 'detached' })
    if (ZOOM !== 1) check(`界面缩放 = ${ZOOM}`, Math.abs(await win.evaluate(() => document.body.currentCSSZoom) - ZOOM) < 0.01, await win.evaluate(() => document.body.currentCSSZoom))

    // ── 气泡 ──
    const chip = (name) => view.locator('.app-ref', { hasText: name }).first()
    const stateOf = (name) => chip(name).getAttribute('data-state')
    await win.waitForFunction(() => document.querySelectorAll('.app-ref[data-state]').length >= 4, null, { timeout: 8000 }).catch(() => {})
    check('开头那行还原成带图标的芯片', await view.locator('#tocmsg-u1 .t2-user-refs .attach-chip--appref', { hasText: '微信' }).count() === 1)
    check('开着的窗口 = live', await stateOf('Linear – Pricing') === 'live', await stateOf('Linear – Pricing'))
    check('关掉的窗口 = closed 且变灰', await stateOf('竞品对比.numbers') === 'closed' && await chip('竞品对比.numbers').getAttribute('data-off') !== null, await stateOf('竞品对比.numbers'))
    check('不在屏上的窗口经 AX 找到 = live', await stateOf('Q4 路演.key') === 'live', await stateOf('Q4 路演.key'))
    check('没装的应用 = missing', await stateOf('Gone') === 'missing', await stateOf('Gone'))
    await chip('Linear – Pricing').hover()
    await win.waitForTimeout(800) // 卡片延迟 0.3s 才出
    const card = await chip('Linear – Pricing').locator('.app-ref-card').evaluate((el) => ({ shown: getComputedStyle(el).opacity === '1', text: el.textContent }))
    check('悬停卡写明「窗口还开着」', card.shown && /Google Chrome/.test(card.text) && /点击切到这个窗口/.test(card.text), card)
    await view.screenshot({ path: path.join(SHOT_DIR, `bubble${tag}.png`) })

    // ── 点击 ──
    await chip('Linear – Pricing').click()
    await win.waitForTimeout(400)
    const focus = helper.requests.filter((r) => r.cmd === 'focusWindow')
    check('点开着的窗口:提那扇窗口 + 切到应用', focus.length === 1 && focus[0].pid === 11 && focus[0].windowId === 101 && opened().join() === '-b com.google.Chrome', { focus, opened: opened() })
    await chip('竞品对比.numbers').click()
    await win.waitForTimeout(400)
    check('点已关的窗口:只打开应用', helper.requests.filter((r) => r.cmd === 'focusWindow').length === 1 && opened()[1] === '-b com.apple.iWork.Numbers', opened())
    await win.mouse.move(2, 2)

    // ── [[ 菜单:分类胶囊 ──
    const ta = view.locator('.t2c-ta')
    const strip = view.locator('.t2c-card .attach-chip[data-ref-kind]')
    await ta.click()
    await ta.pressSequentially('看一下 [[')
    const menu = view.locator('.t2c-menu--refs')
    await menu.locator('.t2c-menu-item').first().waitFor()
    await menu.locator('.t2c-cats[data-cap-ready]').waitFor()
    const cats = await menu.locator('.t2c-cat').evaluateAll((els) => els.map((e) => e.dataset.cat))
    check('分类条:全部 / 窗口 / 应用 / … / 会话', cats[0] === 'all' && cats[1] === 'window' && cats[2] === 'app' && cats.includes('session'), cats)
    const capX = () => menu.locator('.t2c-cats').evaluate((el) => el.style.getPropertyValue('--cap-x'))
    const x0 = await capX()
    await ta.press('ArrowRight')
    await win.waitForTimeout(260)
    const sel = await menu.locator('.t2c-cat[aria-selected="true"]').getAttribute('data-cat')
    const kinds = await menu.locator('.t2c-menu-item').evaluateAll((els) => [...new Set(els.map((e) => e.dataset.cat))])
    check('→ 切到下一类,滑块跟过去,列表只剩这一类', sel === cats[1] && (await capX()) !== x0 && kinds.join() === cats[1], { sel, x0, x1: await capX(), kinds })
    const slide = await menu.locator('.t2c-cats').evaluate((el) => getComputedStyle(el, '::before').transitionProperty)
    check('滑块带过渡', /translate|transform|all/.test(slide), slide)
    await view.screenshot({ path: path.join(SHOT_DIR, `menu${tag}.png`) })
    await menu.locator('.t2c-cat[data-cat="window"]').click()
    check('点胶囊也能切', await menu.locator('.t2c-cat[aria-selected="true"]').getAttribute('data-cat') === 'window')
    const order = await menu.locator('.t2c-menu-item .t2c-menu-cmd').allTextContents()
    check('窗口分类没打字时按前到后排', order.join('|') === 'Linear – Pricing|GitHub|季度预算.numbers', order)
    check('有分类条时不再重复那行说明', await menu.locator('.t2c-menu-sec').count() === 0)

    // ── 选一扇窗口:进「已选择」+ 光标处一枚句内芯片 ──
    await ta.press('Enter')
    await view.locator('.t2c-mirror .t2c-inref').waitFor()
    check('选完:文本框里是一段行内引用', (await ta.inputValue()) === `看一下 ${LEAD}Linear – Pricing${TAIL} `, JSON.stringify(await ta.inputValue()))
    check('选完:「已选择」多一枚窗口芯片', await strip.count() === 1 && await strip.first().getAttribute('data-ref-kind') === 'window')
    const LONG = '帮我把这页的三档价格抄下来,和上周记的那张表逐项对一遍,差在哪里列出来;'
    await win.keyboard.insertText(LONG.repeat(4)) // 够长,折成好几行
    const geo = () => view.locator('.t2c-card').evaluate((cardEl) => {
      const t = cardEl.querySelector('.t2c-ta'); const m = cardEl.querySelector('.t2c-mirror'); const r = m.querySelector('.t2c-inref')
      const tr = t.getBoundingClientRect(); const mr = m.getBoundingClientRect(); const rr = r.getBoundingClientRect()
      const cs = getComputedStyle(t); const ms = getComputedStyle(m)
      return {
        dx: Math.abs(mr.left - (tr.left + t.clientLeft)), dy: Math.abs(mr.top - (tr.top + t.clientTop)), dw: Math.abs(m.clientWidth - t.clientWidth),
        dbg: { mw: m.clientWidth, tw: t.clientWidth, styleW: m.style.width, rows: Math.round(t.scrollHeight / parseFloat(cs.lineHeight)) },
        font: cs.font === ms.font && cs.lineHeight === ms.lineHeight && cs.letterSpacing === ms.letterSpacing,
        lines: t.scrollHeight, mirrorLines: m.firstElementChild.scrollHeight + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom),
        inside: rr.left >= tr.left - 2 && rr.right <= tr.right + 2 && rr.top >= tr.top - 2 && rr.bottom <= tr.bottom + 2,
        icon: !!r.querySelector('.t2c-inref-ico'),
      }
    })
    const g1 = await geo()
    check('镜像层和文本框重合(位置 / 宽度 / 字体)', g1.dx < 0.6 && g1.dy < 0.6 && g1.dw < 0.6 && g1.font, g1)
    check('镜像层折行和文本框一致(多行)', g1.dbg.rows >= 3 && Math.abs(g1.lines - g1.mirrorLines) < 1.5 && g1.inside && g1.icon, g1)
    await view.locator('.composer-anchor').screenshot({ path: path.join(SHOT_DIR, `inline${tag}.png`) })

    // ── 退格:整段删,芯片跟着走 ──
    await ta.press('Meta+ArrowDown')
    await ta.pressSequentially(' [[微信')
    await menu.locator('.t2c-menu-item', { hasText: '微信' }).first().waitFor()
    await ta.press('Enter')
    check('第二枚(应用)也进了句内', await view.locator('.t2c-mirror .t2c-inref').count() === 2 && await strip.count() === 2, await ta.inputValue())
    await ta.press('Backspace') // 先删掉引用后面自动补的那个空格
    check('只删了空格,引用还在', await strip.count() === 2 && (await ta.inputValue()).endsWith(`${LEAD}微信${TAIL}`))
    await ta.press('Backspace')
    check('退格一次删掉整段,「已选择」里那枚跟着没了', !(await ta.inputValue()).includes('微信') && await strip.count() === 1 && await view.locator('.t2c-mirror .t2c-inref').count() === 1, JSON.stringify(await ta.inputValue()))

    // ── 别的引用(会话)同一套:进「已选择」+ 句内一段,退格整段删 ──
    await ta.pressSequentially('[[')
    await menu.locator('.t2c-cat[data-cat="session"]').click() // 当前会话不列,另一条是哪条不写死
    const chatName = (await menu.locator('.t2c-menu-item[data-cat="session"] .t2c-menu-cmd').first().textContent()).replace(/^\P{L}+/u, '').trim() // 菜单里会话名前面带一个表情
    await ta.press('Enter')
    check('会话引用也进句内', (await ta.inputValue()).endsWith(`${LEAD}${chatName}${TAIL} `) && await strip.filter({ hasText: chatName }).count() === 1 && await view.locator('.t2c-mirror .t2c-inref').count() === 2, { tail: (await ta.inputValue()).slice(-12), chatName, strip: await strip.allTextContents(), kinds: await strip.evaluateAll((els) => els.map((e) => e.dataset.refKind)), runs: await view.locator('.t2c-mirror .t2c-inref').allTextContents() })
    await ta.press('Backspace')
    await ta.press('Backspace')
    check('会话引用退格整段删', !(await ta.inputValue()).includes(LEAD + chatName) && await strip.count() === 1)

    // ── ＋ 菜单:只进「已选择」;Shift+点击才插到光标处 ──
    const before = await ta.inputValue()
    await view.locator('button:has(.add-pill-plus)').click()
    await view.locator('.add-menu-parent', { hasText: '添加应用或窗口' }).hover()
    await view.locator('.add-menu-result[data-app-kind="app"]', { hasText: 'Keynote' }).click()
    check('＋ 菜单加的只进「已选择」,不动文字', await strip.count() === 2 && before === await ta.inputValue() && await view.locator('.t2c-mirror .t2c-inref').count() === 1, await strip.allTextContents())
    const numbers = strip.filter({ hasText: '季度预算.numbers' })
    await view.locator('button:has(.add-pill-plus)').click() // 选完一项菜单就收了:再开一次加窗口
    await view.locator('.add-menu-parent', { hasText: '添加应用或窗口' }).hover()
    await view.locator('.add-menu-result[data-app-kind="window"]', { hasText: '季度预算.numbers' }).click()
    await ta.focus()
    await ta.press('Meta+ArrowDown')
    await numbers.click({ modifiers: ['Shift'] })
    check('Shift+点击「已选择」:插到光标处,前面的话一个字没少', (await ta.inputValue()) === `${before}${LEAD}季度预算.numbers${TAIL} ` && await strip.count() === 3 && await view.locator('.t2c-mirror .t2c-inref').count() === 2 && await ta.evaluate((el) => document.activeElement === el), JSON.stringify((await ta.inputValue()).slice(-24)))
    await numbers.locator('button').click()
    check('× 掉句内的那枚:文字留下、不再是引用', (await ta.inputValue()) === `${before}季度预算.numbers ` && await strip.count() === 2, JSON.stringify((await ta.inputValue()).slice(-24)))
    await view.locator('.composer-anchor').screenshot({ path: path.join(SHOT_DIR, `selected${tag}.png`) })

    // ── 暗色 ──
    await win.keyboard.press('Meta+k')
    await win.locator('.cmd-input').fill('切换明暗模式')
    await win.locator('.cmd-item', { hasText: '切换明暗模式' }).click()
    await win.waitForTimeout(400)
    await view.screenshot({ path: path.join(SHOT_DIR, `dark${tag}.png`) })

    // ── 发送:没进句子的引用在开头一行,句内的在原位,不重复 ──
    await ta.click()
    await ta.press('Enter')
    for (let i = 0; i < 30 && !stub.seen.runs.length; i++) await win.waitForTimeout(100)
    const sent = stub.seen.runs[0] && stub.seen.runs[0].message
    const winTok = '[[window://com.google.Chrome|Linear – Pricing]]'
    check('发出去:开头行只有没进句子的那枚', typeof sent === 'string' && sent.startsWith('[[app://com.apple.iWork.Keynote|Keynote]]\n'), sent)
    check('发出去:句内引用在原位换成 token,只出现一次,没有残留的占位空格', typeof sent === 'string' && sent.split(winTok).length === 2 && sent.includes(`看一下 ${winTok} 帮我`) && sent.endsWith('季度预算.numbers') && !/[  ]/.test(sent), sent)
    await view.locator('.t2-userwrap').last().locator('.app-ref', { hasText: 'Linear – Pricing' }).waitFor({ timeout: 5000 }).then(
      () => check('发出的消息在气泡里还原成芯片', true), () => check('发出的消息在气泡里还原成芯片', false))

    // ── 双 ⌘:引用最前面那扇窗口 ──
    await ta.click()
    await win.keyboard.down('MetaLeft')
    await win.keyboard.down('MetaRight')
    await win.keyboard.up('MetaRight')
    await win.keyboard.up('MetaLeft')
    await strip.first().waitFor({ timeout: 5000 }).catch(() => {})
    check('左右 ⌘ 同时按:最前面的窗口进「已选择」', await strip.count() === 1 && /Linear – Pricing/.test(await strip.first().textContent()), await strip.allTextContents())
    await win.keyboard.down('MetaLeft')
    await win.keyboard.press('k')
    await win.keyboard.up('MetaLeft')
    check('单个 ⌘ 的组合键照旧(⌘K 开命令面板)', await win.locator('.cmd-input').isVisible())
    await win.keyboard.press('Escape')
    await view.screenshot({ path: path.join(SHOT_DIR, `hotkey${tag}.png`) })
  } catch (err) {
    check(`台架中途抛错:${String(err.message || err).split('\n')[0]}`, false)
    if (app) await (await app.firstWindow()).screenshot({ path: path.join(SHOT_DIR, `fail${tag}.png`) }).catch(() => {})
  } finally {
    if (app) await app.close().catch(() => {})
    await stub.close?.()
    helper.close()
    if (!process.argv.includes('--keep')) fs.rmSync(home, { recursive: true, force: true })
  }
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过;截图 ${SHOT_DIR}`)
  if (bad.length) { console.log(bad.map((b) => `  ✗ ${b.name}`).join('\n')); process.exit(1) }
}

main().catch((err) => { console.error(err); process.exit(1) })
