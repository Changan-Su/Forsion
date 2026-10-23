/** Real Electron:旁聊(/btw)。10-18「挂点统一」起主窗里开在对话右边那块子会话面板(不弹浮窗),卫星窗才开原生浮窗。
 * 钉住:/btw 开在面板里且主对话里什么都不发;回答来自引擎旁聊端点、追问带上前一轮;切会话面板跟着换、切回来线程还在;
 * 划线「顺便问」挂在同一条回答上 → 接着同一段并挂上引用(「在侧栏提问」并进了它);「带回这里」把回答挂进主窗输入框;
 * 引用是卡片,可以挂多段、逐张移除,已发消息开头的引用块还原成卡片;⌘; 快捷键;Esc 关面板;英文 / 深色截图。
 * 落库与「从这里分出」那一行的重开另见 scripts/branch-anchors.e2e.cjs。
 * npm run build && npm run check:btw
 * 全程打隔离 loopback stub(引擎旁聊端点按剧本回 SSE),不碰真账号、不烧模型额度。真模型那半 = tangu-agent `live:harness -- --only btw`。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs')
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
  // 引用磁贴跳回原文的来源(u0 的第二段引用出自这里;第一段哪都没有 → 点了看全文)
  { id: 'a00', role: 'model', content: '先记一笔:第二段引用\n还有第二行,后面会用到。', timestamp: now - 800 },
  { id: 'u0', role: 'user', content: '> 第一段引用\n\n> 第二段引用\n> 还有第二行\n\n这两段是什么关系?', timestamp: now - 700 },
  { id: 'a0', role: 'model', content: '它们说的是同一件事。', timestamp: now - 600 },
  { id: 'u1', role: 'user', content: '记住:项目代号是 AZURE-FALCON。', timestamp: now - 500 },
  { id: 'a1', role: 'model', content: '好的,代号 AZURE-FALCON 已记下。接下来重构解析器的词法阶段。', timestamp: now - 400 },
]
const sse = (events) => ({ __buffer: Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')), contentType: 'text/event-stream' })
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
        if (String(b.question).includes('慢')) await new Promise((r) => setTimeout(r, 2500)) // 让这一问在流里多待一会儿
        const answer = b.thread?.length ? '倒过来是 **NOCLAF-ERUZA**。' : b.quote ? `这段在说代号:\`${b.quote.slice(0, 12)}\`。` : '项目代号是 **AZURE-FALCON**。'
        // 同真引擎:没给挂点 → 挂到最近一条回答(a1),done 回记录 id 与挂点
        return sse([...answer.match(/.{1,6}/g).map((text) => ({ type: 'delta', text })), { type: 'done', content: answer, toolCallText: false, asideId: b.aside_id || `x-${m[1]}`, asideMessageId: b.message_id || 'a1' }])
      }
    },
  })
  const token = ['test', Buffer.from(JSON.stringify({ sub: 'test-btw', exp: Math.floor(Date.now() / 1000) + 86400 * 10 })).toString('base64url'), 'test'].join('.')
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ cloudUrl: stub.url, token }))
  // 未打包的构建把 userData 改成 <user-data-dir>-dev(electron/main.ts),只写 userdata/ 应用读不到 → 令牌为空、开机不连,主窗一重载就连不回假引擎
  for (const dir of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, cloudUrl: stub.url, token }))
  }
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
    // 登录后首次同步卡(SyncSetupCard)启动 2.5s 后才弹、会盖住划线条;桩环境里点「稍后」也会再弹(10-23 实测),和本台架无关:藏掉
    const hideSyncCard = () => win.addStyleTag({ content: '.sync-setup-backdrop { display: none !important; }' })
    await hideSyncCard()
    const input = win.locator('.t2c-ta').first()
    await input.waitFor({ timeout: 30000 })
    await win.locator('text=Parser 重构').first().click()
    await win.locator('.t2-content', { hasText: 'AZURE-FALCON 已记下' }).first().waitFor({ timeout: 15000 })

    // ── /btw 问题 → 右边面板 + 流式回答;主对话一条都不发 ──
    const windowsBefore = app.windows().length
    await input.fill('/btw 代号是什么?')
    await input.press('Enter')
    const btw = win.locator('[data-aside-panel] .btw-panel[data-btw-session="sess-main"]')
    await btw.waitFor({ timeout: 30000 })
    check('/btw 开在对话右边那块面板里,没有新开窗', app.windows().length === windowsBefore)
    await btw.locator('.btw-turn-a', { hasText: 'AZURE-FALCON' }).waitFor({ timeout: 15000 })
    check('回答来自引擎旁聊端点,问的是本会话', asides.length === 1 && asides[0].sessionId === 'sess-main' && asides[0].question === '代号是什么?' && asides[0].thread.length === 0)
    check('主对话里什么都没发(没有起 run,输入框已清空)', stub.seen.runs.length === 0 && (await input.inputValue()) === '')
    check('面板头写「顺便问」,内容头部显示所属会话', (await win.locator('[data-aside-panel] .agent-desk-title').textContent()) === '顺便问' && (await btw.locator('.btw-context').textContent()).includes('Parser 重构'))

    // ── 追问:带上前一轮和记录 id ──
    const box = btw.locator('.btw-input textarea')
    await box.fill('把它倒过来拼')
    await box.press('Enter')
    await btw.locator('.btw-turn-a', { hasText: 'NOCLAF-ERUZA' }).waitFor({ timeout: 15000 })
    check('追问把第一轮往返和记录 id 带给引擎', asides[1]?.thread?.length === 1 && asides[1].thread[0].answer.includes('AZURE-FALCON') && asides[1].aside_id === 'x-sess-main', JSON.stringify(asides[1]))
    await win.screenshot({ path: path.join(shots, 'btw-panel.png') })

    // ── 跟着会话走:切走面板跟着换、切回来线程还在 ──
    await win.locator('text=另一条会话').first().click()
    check('主窗切到别的会话 → 那块面板不在了', (await until(async () => (await btw.count()) === 0)) === true)
    await win.locator('text=Parser 重构').first().click()
    await btw.waitFor({ timeout: 10000 })
    check('切回原会话 → 面板再现,线程原样还在', (await btw.locator('.btw-turn').count()) === 2)
    // 面板滑出期间对话列在变宽 / 变窄,划线条遇到盒子变化就收(ViewSelectionBar 的 ResizeObserver):等它停下再划
    await win.waitForTimeout(800)
    const taH = await btw.locator('.btw-input textarea').evaluate((el) => el.getBoundingClientRect().height)
    check('面板滑出后空输入框是一行高(没被首帧的窄宽度撑高)', taH < 60, String(taH))

    // ── 划线「顺便问」:挂在同一条回答上 → 接着同一段,选区挂成引用 ──
    const pickReply = () => win.evaluate(() => {
      const p = [...document.querySelectorAll('[data-chat-surface="chat"] .t2-content')].find((el) => el.textContent.includes('AZURE-FALCON 已记下'))
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
    const picked = await pickReply()
    const btwAction = win.locator('[data-testid="selection-btw"]').first()
    await btwAction.waitFor({ state: 'visible', timeout: 5000 })
    const menuBox = await win.locator('[data-testid="selection-bar"]').first().boundingBox()
    check('划线工具栏出现「顺便问」且不越出视图', !!menuBox && menuBox.x >= 0 && (await btwAction.textContent()).includes('顺便问'))
    check('「在侧栏提问」并进了「顺便问」,划线工具栏里没有它了', (await win.locator('[data-testid="selection-ask-in-panel"]').count()) === 0)
    await btwAction.click()
    const chip = btw.locator('.btw-quote-chip')
    await chip.waitFor({ timeout: 10000 })
    check('划线挂在同一条回答上 → 接着同一段(前两问还在),选区挂成引用', (await btw.locator('.btw-turn').count()) === 2 && !!picked && (await chip.textContent()).includes('AZURE-FALCON'))
    await box.press('Enter') // 空着回车 = 「解释一下这段」
    await btw.locator('.btw-turn').nth(2).locator('.btw-turn-a').waitFor({ timeout: 15000 })
    check('只挂引用空着回车 → 用缺省问题问,挂点是划线所在那条回答', asides[2]?.question === '解释一下这段' && asides[2]?.quote?.includes('AZURE-FALCON') && asides[2]?.message_id === 'a1', JSON.stringify(asides[2]))

    // ── 带回这里:回答挂进主窗输入框,不动草稿 ──
    await input.fill('我的草稿')
    const bringBack = btw.locator('.btw-turn').nth(1).locator('[data-testid="btw-quote-to-chat"]')
    check('回答下面的按钮叫「带回这里」', (await bringBack.textContent()).includes('带回这里'))
    await bringBack.click()
    await win.locator('.t2c-tilerow .att-tile--quote .att-tile-head', { hasText: 'NOCLAF-ERUZA' }).first().waitFor({ timeout: 10000 })
    check('「带回这里」挂成主窗引用且草稿没被覆盖', (await input.inputValue()) === '我的草稿')

    // ── 引用卡:再划一段点「引用」→ 两张卡并排挂着(不顶掉上一段),可以单独移除 ──
    const mainQuotes = win.locator('[data-chat-surface="chat"] .t2c-tilerow .att-tile--quote')
    await win.waitForTimeout(800) // 引用卡挂上后输入区长高、对话区重排:选区会被冲掉,等它落定再划
    await pickReply()
    await win.locator('[data-testid="selection-quote"]').first().click()
    await until(async () => (await mainQuotes.count()) === 2, 5000)
    const cardTexts = await mainQuotes.locator('.att-tile-head').allTextContents()
    check('再引用一段 → 输入框上方两张引用卡,先挂的那张还在', cardTexts.length === 2 && cardTexts[0].includes('NOCLAF-ERUZA') && cardTexts[1].includes('AZURE-FALCON'), JSON.stringify(cardTexts))
    await win.screenshot({ path: path.join(shots, 'quote-cards.png') })
    await mainQuotes.first().locator('.att-tile-x').click()
    await until(async () => (await mainQuotes.count()) === 1, 5000)
    check('单独移除一张,另一张留着', (await mainQuotes.locator('.att-tile-head').allTextContents()).join('|').includes('AZURE-FALCON') && (await mainQuotes.count()) === 1)
    const bubble = await win.evaluate(() => {
      const wrap = [...document.querySelectorAll('[data-chat-surface="chat"] .t2-userwrap')].find((el) => el.textContent.includes('这两段是什么关系'))
      const cards = [...(wrap?.querySelectorAll('.att-tile--quote .att-tile-head') || [])].map((el) => el.textContent)
      // 引用磁贴在气泡上方;正文在长提问折叠(UserFold)里面,不是气泡的直接文本节点:去掉按钮后取剩下的字
      const rest = wrap?.querySelector('.t2-user')?.cloneNode(true)
      rest?.querySelectorAll('button').forEach((el) => el.remove())
      return { cards, body: (rest?.textContent || '').trim(), raw: !!rest?.textContent.includes('> ') }
    })
    check('已发消息开头的两段引用是两张卡,正文不再带「> 」', bubble.cards.length === 2 && bubble.cards[1].includes('还有第二行') && bubble.body === '这两段是什么关系?' && !bubble.raw, JSON.stringify(bubble))
    // 气泡里的引用磁贴:点得到原文的跳回去闪两下,点不到的看全文(QuoteTile)
    const bubbleTiles = win.locator('[data-chat-surface="chat"] #tocmsg-u0 .att-tile--quote .att-tile-open')
    await bubbleTiles.nth(1).click()
    check('气泡里点引用磁贴 → 跳回出处那条回答并闪', await until(async () => win.evaluate(() => !!document.querySelector('[data-chat-surface="chat"] #tocmsg-a00.t2-jump-flash')), 5000))
    await bubbleTiles.nth(0).click()
    const preview = win.locator('.quote-preview')
    await preview.waitFor({ timeout: 5000 })
    check('找不到出处的引用 → 看全文', (await preview.textContent()).includes('第一段引用'))
    await win.waitForTimeout(400) // 等入场动画放完再拍
    await win.screenshot({ path: path.join(shots, 'quote-preview.png') })
    await win.keyboard.press('Escape')
    check('Esc 关掉全文窗', await until(async () => (await preview.count()) === 0, 5000))
    await win.locator('text=另一条会话').first().click()
    await until(async () => (await btw.count()) === 0)
    check('切到别的会话 → 主对话输入框上方没有上一个会话的引用卡', (await mainQuotes.count()) === 0)
    await win.locator('text=Parser 重构').first().click()
    await btw.waitFor({ timeout: 10000 })
    await win.waitForTimeout(800)
    check('切回来 → 这个会话的引用卡还在', (await mainQuotes.count()) === 1)

    // ── 上一问还在流时主窗又来一条 /btw:不能被吞(主窗输入框已清空),进旁聊输入框等着 ──
    await input.fill('/btw 慢一点的问题')
    await input.press('Enter')
    await btw.locator('.btw-turn[data-status="streaming"]').waitFor({ timeout: 10000 })
    await input.fill('/btw 第二问')
    await input.press('Enter')
    await until(async () => (await box.inputValue()) === '第二问', 5000)
    check('流式中再来的 /btw 进了旁聊输入框,没有被吞', (await box.inputValue()) === '第二问' && (await input.inputValue()) === '')
    await btw.locator('.btw-turn[data-status="streaming"]').waitFor({ state: 'detached', timeout: 15000 })
    await box.fill('')

    // ── Esc 关面板 ──
    await box.focus()
    await box.press('Escape')
    check('Esc 关掉那块面板', (await until(async () => (await win.locator('[data-aside-panel]').count()) === 0)) === true)

    // ── ⌘; 快捷键:当前会话的旁聊开回面板(线程还在) ──
    await input.fill('')
    await input.focus()
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+;' : 'Control+;')
    await btw.waitFor({ timeout: 10000 })
    check('⌘; 在面板里开回当前会话的旁聊,线程还在', (await btw.locator('.btw-turn').count()) >= 3 && app.windows().length === windowsBefore)

    // ── 观感自查(DESIGN §8):英文界面 + 深色各截一张,人看 ──
    await win.evaluate(() => localStorage.setItem('tangu_locale', 'en'))
    await win.reload({ waitUntil: 'domcontentloaded' })
    await hideSyncCard()
    await input.waitFor({ timeout: 30000 })
    await win.locator('text=Parser 重构').first().click()
    await win.locator('.t2-content', { hasText: 'AZURE-FALCON 已记下' }).first().waitFor({ timeout: 15000 })
    await input.focus()
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+;' : 'Control+;')
    await btw.waitFor({ timeout: 10000 })
    await box.fill('What is the codename?')
    await box.press('Enter')
    await btw.locator('.btw-turn-a', { hasText: 'AZURE-FALCON' }).last().waitFor({ timeout: 15000 })
    check('英文界面文案到位(不是 key、不是中文)', (await btw.locator('.btw-hint').textContent()).startsWith('Uses this conversation as context') && (await win.locator('[data-aside-panel] .agent-desk-title').textContent()) === 'By the way')
    await win.screenshot({ path: path.join(shots, 'btw-en.png') })
    // 深色走真主题管线:写模式偏好(loader 的 forsion_theme)后重载;只改 <html data-mode> 不会重算 token(实测截出来仍是浅色)
    await win.evaluate(() => localStorage.setItem('forsion_theme', 'dark'))
    await win.reload({ waitUntil: 'domcontentloaded' })
    await hideSyncCard()
    await input.waitFor({ timeout: 30000 })
    await win.locator('text=Parser 重构').first().click()
    await input.focus()
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+;' : 'Control+;')
    await btw.waitFor({ timeout: 10000 })
    const bg = await win.evaluate(() => getComputedStyle(document.querySelector('[data-aside-panel] .agent-desk-inner') || document.body).backgroundColor)
    const lum = (bg.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3
    check('深色模式下面板底色是暗的(token 生效,不是写死的浅色)', lum < 90, bg)
    await win.screenshot({ path: path.join(shots, 'btw-en-dark.png') })
    console.log(`${checks} checks passed. Screenshots: ${shots}`)
  } catch (error) {
    if (app) { for (const [i, w] of app.windows().entries()) await w.screenshot({ path: path.join(shots, `failure-${i}.png`) }).catch(() => {}) }
    console.error(`Evidence: ${home}`)
    throw error
  } finally { if (app) await app.close(); await stub.close() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
