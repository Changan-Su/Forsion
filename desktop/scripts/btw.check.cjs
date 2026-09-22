/** Real Electron:旁聊(/btw)= 会话级原生 Floating Panel。
 * 钉住:/btw 开浮窗且主对话里什么都不发;回答来自引擎旁聊端点、追问带上前一轮;切会话浮窗隐藏、切回再现(线程还在);
 * 划线「顺便问」复用同一扇窗并挂上引用;「引用到对话」把回答挂进主窗输入框;⌘; 快捷键;Esc 关窗。
 * npm run build && npm run check:btw
 * 全程打隔离 loopback stub(引擎旁聊端点按剧本回 SSE),不碰真账号、不烧模型额度。真模型那半 = tangu-agent `live:harness -- --only btw`。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
let checks = 0
function check(name, condition, detail) { assert.ok(condition, `${name}${detail ? ` | ${detail}` : ''}`); console.log(`PASS ${name}`); checks++ }
const now = Date.now()
const SESSIONS = [
  { id: 'sess-other', title: '另一条会话', model_id: 'm1', created_at: now - 1000, updated_at: now - 1000, projectless: true },
  { id: 'sess-main', title: 'Parser 重构', model_id: 'm1', created_at: now, updated_at: now, projectless: true },
]
const MESSAGES = [
  { id: 'u1', role: 'user', content: '记住:项目代号是 AZURE-FALCON。', timestamp: now - 500 },
  { id: 'a1', role: 'model', content: '好的,代号 AZURE-FALCON 已记下。接下来重构解析器的词法阶段。', timestamp: now - 400 },
]
const sse = (events) => ({ __buffer: Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')), contentType: 'text/event-stream' })
/** 找旁聊浮窗的 BrowserWindow(按 URL 里的 id)并读它的可见性。 */
const btwVisible = (app, id) => app.evaluate(({ BrowserWindow }, wid) => {
  const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(`id=${encodeURIComponent(wid)}`))
  return w ? w.isVisible() : null
}, id)
async function until(fn, ms = 8000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await new Promise((r) => setTimeout(r, 150)) } }

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-btw-'))
  const shots = path.join(home, 'screenshots'); fs.mkdirSync(shots)
  const userdata = path.join(home, 'userdata'); fs.mkdirSync(userdata)
  const vault = path.join(home, 'vault'); fs.mkdirSync(vault)
  fs.writeFileSync(path.join(userdata, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  const asides = []
  const stub = await startStubEngine({
    sessions: SESSIONS,
    messages: MESSAGES,
    handle: async ({ path: route, method, body }) => {
      if (route === '/agent/runs') return { runs: [] }
      if (route === '/api/brain/users/me') return { id: 'test-btw', username: 'BTW tester' }
      const m = /^\/agent\/sessions\/([^/]+)\/aside$/.exec(route)
      if (m && method === 'POST') {
        const b = await body()
        asides.push({ sessionId: m[1], ...b })
        const answer = b.thread?.length ? '倒过来是 **NOCLAF-ERUZA**。' : b.quote ? `这段在说代号:\`${b.quote.slice(0, 12)}\`。` : '项目代号是 **AZURE-FALCON**。'
        return sse([...answer.match(/.{1,6}/g).map((text) => ({ type: 'delta', text })), { type: 'done', content: answer, toolCallText: false }])
      }
    },
  })
  const token = ['test', Buffer.from(JSON.stringify({ sub: 'test-btw', exp: Math.floor(Date.now() / 1000) + 86400 * 10 })).toString('base64url'), 'test'].join('.')
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ cloudUrl: stub.url, token }))
  fs.writeFileSync(path.join(userdata, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, cloudUrl: stub.url, token }))
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
    await win.waitForSelector('#root')
    await win.evaluate(() => { localStorage.setItem('forsion_default_space', 'tangu'); localStorage.setItem('tangu_locale', 'zh') })
    await win.reload({ waitUntil: 'domcontentloaded' })
    check('主窗离开首启引导', await skipOnboarding(win))
    const input = win.locator('.t2c-ta').first()
    await input.waitFor({ timeout: 30000 })
    await win.locator('text=Parser 重构').first().click()
    await win.locator('.t2-content', { hasText: 'AZURE-FALCON 已记下' }).first().waitFor({ timeout: 15000 })

    // ── /btw 问题 → 浮窗 + 流式回答;主对话一条都不发 ──
    await input.fill('/btw 代号是什么?')
    const opened = app.waitForEvent('window')
    await input.press('Enter')
    const panel = await opened
    await panel.waitForLoadState('domcontentloaded')
    const btw = panel.locator('.btw-panel[data-btw-session="sess-main"]')
    await btw.waitFor({ timeout: 30000 })
    check('/btw 开出独立的旁聊浮窗', panel !== win && panel.url().includes('window=floating'))
    await btw.locator('.btw-turn-a', { hasText: 'AZURE-FALCON' }).waitFor({ timeout: 15000 })
    check('回答来自引擎旁聊端点,问的是本会话', asides.length === 1 && asides[0].sessionId === 'sess-main' && asides[0].question === '代号是什么?' && asides[0].thread.length === 0)
    check('主对话里什么都没发(没有起 run,输入框已清空)', stub.seen.runs.length === 0 && (await input.inputValue()) === '')
    check('浮窗标题带会话名', (await panel.title()).includes('Parser 重构') || (await panel.locator('.floating-native-chrome').textContent().catch(() => '')).includes('Parser 重构'))

    // ── 追问:带上前一轮 ──
    const box = btw.locator('.btw-input textarea')
    await box.fill('把它倒过来拼')
    await box.press('Enter')
    await btw.locator('.btw-turn-a', { hasText: 'NOCLAF-ERUZA' }).waitFor({ timeout: 15000 })
    check('追问把第一轮往返带给引擎', asides[1]?.thread?.length === 1 && asides[1].thread[0].answer.includes('AZURE-FALCON'))
    await panel.screenshot({ path: path.join(shots, 'btw-window.png') })

    // ── 会话级:切走隐藏、切回再现,线程还在 ──
    await win.locator('text=另一条会话').first().click()
    check('主窗切到别的会话 → 旁聊浮窗隐藏', (await until(async () => (await btwVisible(app, 'btw:sess-main')) === false)) === true)
    await win.locator('text=Parser 重构').first().click()
    check('切回原会话 → 浮窗再现', (await until(async () => (await btwVisible(app, 'btw:sess-main')) === true)) === true)
    check('再现后线程原样还在(隐藏不销毁)', (await btw.locator('.btw-turn').count()) === 2)

    // ── 划线「顺便问」:复用同一扇窗,选区挂成引用 ──
    const windowsBefore = app.windows().length
    const picked = await win.evaluate(() => {
      const p = [...document.querySelectorAll('.t2-content')].find((el) => el.textContent.includes('AZURE-FALCON 已记下'))
      const stream = p?.closest('.t2-stream')
      if (!p || !stream) return ''
      const range = document.createRange()
      range.selectNodeContents(p)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
      stream.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return sel.toString().trim()
    })
    const btwAction = win.locator('[data-testid="selection-btw"]').first()
    await btwAction.waitFor({ state: 'visible', timeout: 5000 })
    const menuBox = await win.locator('.t2-quote-menu').first().boundingBox()
    check('划线工具栏出现「顺便问」且不越出视图', !!menuBox && menuBox.x >= 0 && (await btwAction.textContent()).includes('顺便问'))
    await btwAction.click()
    const chip = btw.locator('.btw-quote-chip')
    await chip.waitFor({ timeout: 10000 })
    check('划线开的是同一扇旁聊窗(按会话复用,不新开)', app.windows().length === windowsBefore)
    check('选区挂成旁聊引用', !!picked && (await chip.textContent()).includes('AZURE-FALCON'))
    await box.press('Enter') // 空着回车 = 「解释一下这段」
    await btw.locator('.btw-turn').nth(2).locator('.btw-turn-a').waitFor({ timeout: 15000 })
    check('只挂引用空着回车 → 用缺省问题问', asides[2]?.question === '解释一下这段' && asides[2]?.quote?.includes('AZURE-FALCON'))

    // ── 引用到对话:回答挂进主窗输入框,不动草稿 ──
    await input.fill('我的草稿')
    await btw.locator('.btw-turn').nth(1).locator('[data-testid="btw-quote-to-chat"]').click()
    await win.locator('.t2c-quote-text', { hasText: 'NOCLAF-ERUZA' }).first().waitFor({ timeout: 10000 })
    check('「引用到对话」挂成主窗引用且草稿没被覆盖', (await input.inputValue()) === '我的草稿')

    // ── Esc 关窗(关了线程就丢:与 Claude 一样只在内存) ──
    const closed = panel.waitForEvent('close')
    await box.focus()
    await box.press('Escape')
    await closed
    check('Esc 关掉旁聊浮窗', panel.isClosed())

    // ── ⌘; 快捷键:当前会话开一扇新的空旁聊 ──
    await input.fill('')
    await input.focus()
    const reopened = app.waitForEvent('window')
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+;' : 'Control+;')
    const panel2 = await reopened
    await panel2.waitForLoadState('domcontentloaded')
    await panel2.locator('.btw-panel .btw-empty').waitFor({ timeout: 30000 })
    check('⌘; 开出当前会话的旁聊(新窗、空线程)', panel2.url().includes(encodeURIComponent('btw:sess-main')))
    await panel2.screenshot({ path: path.join(shots, 'btw-empty.png') })

    // ── 观感自查(DESIGN §8):英文界面 + 深色各截一张,人看 ──
    await panel2.evaluate(() => localStorage.setItem('tangu_locale', 'en'))
    await panel2.reload({ waitUntil: 'domcontentloaded' })
    const btw2 = panel2.locator('.btw-panel')
    await btw2.waitFor({ timeout: 30000 })
    await btw2.locator('.btw-input textarea').fill('What is the codename?')
    await btw2.locator('.btw-input textarea').press('Enter')
    await btw2.locator('.btw-turn-a', { hasText: 'AZURE-FALCON' }).waitFor({ timeout: 15000 })
    check('英文界面文案到位(不是 key、不是中文)', (await btw2.locator('.btw-hint').textContent()).startsWith('Uses this conversation as context'))
    await panel2.screenshot({ path: path.join(shots, 'btw-en.png') })
    // 深色走真主题管线:写模式偏好(loader 的 forsion_theme)后重载;只改 <html data-mode> 不会重算 token(实测截出来仍是浅色)
    await panel2.evaluate(() => localStorage.setItem('forsion_theme', 'dark'))
    await panel2.reload({ waitUntil: 'domcontentloaded' })
    await panel2.locator('.btw-panel').waitFor({ timeout: 30000 })
    await panel2.locator('.btw-panel .btw-input textarea').fill('What is the codename?')
    await panel2.locator('.btw-panel .btw-input textarea').press('Enter')
    await panel2.locator('.btw-turn-a', { hasText: 'AZURE-FALCON' }).waitFor({ timeout: 15000 })
    const bg = await panel2.evaluate(() => getComputedStyle(document.querySelector('.btw-panel')).backgroundColor)
    const lum = (bg.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3
    check('深色模式下面板底色是暗的(token 生效,不是写死的浅色)', lum < 90, bg)
    await panel2.screenshot({ path: path.join(shots, 'btw-en-dark.png') })
    console.log(`${checks} checks passed. Screenshots: ${shots}`)
  } catch (error) {
    if (app) { for (const [i, w] of app.windows().entries()) await w.screenshot({ path: path.join(shots, `failure-${i}.png`) }).catch(() => {}) }
    console.error(`Evidence: ${home}`)
    throw error
  } finally { if (app) await app.close(); await stub.close() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
