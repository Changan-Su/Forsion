/** Real Electron:旁聊(/btw)= 会话级原生 Floating Panel。
 * 钉住:/btw 开浮窗且主对话里什么都不发;回答来自引擎旁聊端点、追问带上前一轮;切会话浮窗隐藏、切回再现(线程还在);
 * 划线「顺便问」复用同一扇窗并挂上引用;「引用到对话」把回答挂进主窗输入框;⌘; 快捷键;Esc 关窗。
 * 划线「在侧栏提问」= 同一种旁聊开在右侧栏(不弹窗、不进主对话、跟着当前会话走);引用是卡片,可以挂多段、逐张移除,
 * 已发消息开头的引用块还原成卡片(2026-10-11)。
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
  { id: 'u0', role: 'user', content: '> 第一段引用\n\n> 第二段引用\n> 还有第二行\n\n这两段是什么关系?', timestamp: now - 700 },
  { id: 'a0', role: 'model', content: '它们说的是同一件事。', timestamp: now - 600 },
  { id: 'u1', role: 'user', content: '记住:项目代号是 AZURE-FALCON。', timestamp: now - 500 },
  { id: 'a1', role: 'model', content: '好的,代号 AZURE-FALCON 已记下。接下来重构解析器的词法阶段。', timestamp: now - 400 },
]
const sse = (events) => ({ __buffer: Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')), contentType: 'text/event-stream' })
/** 找旁聊浮窗的 BrowserWindow(按 URL 里的 id)并读它的可见性 / 能否最小化。 */
const btwWin = (app, id) => app.evaluate(({ BrowserWindow }, wid) => {
  const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(`id=${encodeURIComponent(wid)}`))
  return w ? { visible: w.isVisible(), minimizable: w.isMinimizable() } : null
}, id)
const btwVisible = async (app, id) => (await btwWin(app, id))?.visible ?? null
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
    // 78e57675 起内置浮窗的标题按界面语言现译成功能名(DESIGN「悬浮输入区」:标题栏只放简短功能名,会话名在内容头部,见下面 .btw-context 那条)。
    // 原来这条断言等的是标题提示里带会话名,从那次起在 main 上一直是红的。
    if (process.platform === 'darwin') check('浮窗标题栏只放功能名', (await panel.locator('.floating-native-chrome > span').getAttribute('title')) === '顺便问')
    const chrome = await panel.evaluate(() => {
      const header = document.querySelector('.floating-native-chrome')
      const title = header?.querySelector('span')
      if (!header || !title) return null
      const a = header.getBoundingClientRect(); const b = title.getBoundingClientRect()
      return { text: title.textContent, left: b.left - a.left, right: a.right - b.right, height: a.height }
    })
    check('macOS 标题避开系统窗口按钮且在窗内居中', process.platform !== 'darwin' || (!!chrome && chrome.text === '顺便问' && chrome.left >= 80 && chrome.right >= 80), JSON.stringify(chrome))
    check('旁聊头部显示所属会话', (await btw.locator('.btw-context').textContent()).includes('Parser 重构'))

    // ── 追问:带上前一轮 ──
    const box = btw.locator('.btw-input textarea')
    await box.fill('把它倒过来拼')
    await box.press('Enter')
    await btw.locator('.btw-turn-a', { hasText: 'NOCLAF-ERUZA' }).waitFor({ timeout: 15000 })
    check('追问把第一轮往返带给引擎', asides[1]?.thread?.length === 1 && asides[1].thread[0].answer.includes('AZURE-FALCON'))
    const shortLayout = await panel.evaluate(() => {
      const body = document.querySelector('.btw-body')?.getBoundingClientRect()
      const last = document.querySelector('.btw-turn:last-child')?.getBoundingClientRect()
      const compose = document.querySelector('.btw-compose')?.getBoundingClientRect()
      return body && last && compose ? { gap: body.bottom - last.bottom, composeBottom: compose.bottom, viewport: innerHeight } : null
    })
    check('短旁聊贴近输入区且输入区留在窗口内', !!shortLayout && shortLayout.gap >= 0 && shortLayout.gap <= 16 && shortLayout.composeBottom <= shortLayout.viewport + 1, JSON.stringify(shortLayout))
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
    const menuBox = await win.locator('[data-testid="selection-bar"]').first().boundingBox()
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

    // ── 引用卡:再划一段点「引用」→ 两张卡并排挂着(不顶掉上一段),可以单独移除 ──
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
    const mainQuotes = win.locator('[data-chat-surface="chat"] .t2c-quote')
    await pickReply()
    await win.locator('[data-testid="selection-quote"]').first().click()
    await until(async () => (await mainQuotes.count()) === 2, 5000)
    const cardTexts = await mainQuotes.locator('.t2c-quote-text').allTextContents()
    check('再引用一段 → 输入框上方两张引用卡,先挂的那张还在', cardTexts.length === 2 && cardTexts[0].includes('NOCLAF-ERUZA') && cardTexts[1].includes('AZURE-FALCON'), JSON.stringify(cardTexts))
    await win.screenshot({ path: path.join(shots, 'quote-cards.png') })
    await mainQuotes.first().locator('.t2c-quote-x').click()
    await until(async () => (await mainQuotes.count()) === 1, 5000)
    check('单独移除一张,另一张留着', (await mainQuotes.locator('.t2c-quote-text').allTextContents()).join('|').includes('AZURE-FALCON') && (await mainQuotes.count()) === 1)
    const bubble = await win.evaluate(() => {
      const wrap = [...document.querySelectorAll('[data-chat-surface="chat"] .t2-user')].find((el) => el.textContent.includes('这两段是什么关系'))
      const cards = [...(wrap?.querySelectorAll('.t2-user-quote') || [])].map((el) => el.textContent)
      return { cards, body: [...(wrap?.childNodes || [])].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim(), raw: wrap?.textContent.includes('> ') }
    })
    check('已发消息开头的两段引用是两张卡,正文不再带「> 」', bubble.cards.length === 2 && bubble.cards[1].includes('还有第二行') && bubble.body === '这两段是什么关系?' && !bubble.raw, JSON.stringify(bubble))

    // ── 划线「在侧栏提问」:旁聊开在右侧栏 —— 不新开窗、不进主对话,问的仍是本会话 ──
    const winsBeforeSide = app.windows().length
    const runsBeforeSide = stub.seen.runs.length
    await pickReply()
    await win.locator('[data-testid="selection-ask-in-panel"]').first().click()
    const side = win.locator('.btw-panel[data-btw-session="sess-main"]')
    await side.waitFor({ timeout: 10000 })
    await side.locator('.btw-quote-chip').waitFor({ timeout: 5000 })
    check('「在侧栏提问」在主窗右侧栏开出旁聊,没有新开窗', app.windows().length === winsBeforeSide && (await side.locator('.btw-quote-chip').textContent()).includes('AZURE-FALCON'))
    check('选中的那段只进了侧栏旁聊,主对话的引用卡没变', (await mainQuotes.count()) === 1)
    const sideBox = side.locator('.btw-input textarea')
    const asidesBefore = asides.length
    await sideBox.fill('这句是谁说的?')
    await sideBox.press('Enter')
    await side.locator('.btw-turn-a').first().waitFor({ timeout: 15000 })
    const sideAsk = asides[asidesBefore]
    check('侧栏里问的走旁聊端点、带着引用,主对话没有起 run', sideAsk?.sessionId === 'sess-main' && sideAsk.question === '这句是谁说的?' && sideAsk.quote?.includes('AZURE-FALCON') && stub.seen.runs.length === runsBeforeSide, JSON.stringify(sideAsk))
    await win.screenshot({ path: path.join(shots, 'btw-sidebar.png') })
    await sideBox.fill('还没发出去的一句')
    await win.locator('text=另一条会话').first().click()
    await win.locator('.btw-panel[data-btw-session="sess-other"]').waitFor({ timeout: 10000 })
    check('切到别的会话 → 侧栏旁聊换成那个会话的(空的)', (await win.locator('.btw-panel[data-btw-session="sess-other"] .btw-turn').count()) === 0
      && (await win.locator('.btw-panel[data-btw-session="sess-other"] .btw-input textarea').inputValue()) === '')
    // 引用只属于挂它的那个会话:A 会话里挂着的那张卡,在 B 会话的输入框上方不显示(也就不会跟着 B 的消息发出去)
    check('切到别的会话 → 主对话输入框上方没有上一个会话的引用卡', (await mainQuotes.count()) === 0)
    await win.locator('text=Parser 重构').first().click()
    await side.waitFor({ timeout: 10000 })
    check('切回来 → 侧栏旁聊的线程和没发出去的草稿都还在', (await side.locator('.btw-turn').count()) === 1 && (await sideBox.inputValue()) === '还没发出去的一句')
    check('切回来 → 这个会话的引用卡还在', (await mainQuotes.count()) === 1)
    await sideBox.fill('')
    await until(async () => (await btwVisible(app, 'btw:sess-main')) === true)

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

    // ── 卫星窗(不带会话归属)再次打开同一扇旁聊窗:归属得保留,否则它从此不跟会话显隐 ──
    await panel.evaluate(() => window.tangu.openFloatingPanel({ id: 'btw:sess-main', title: 'btw', builtin: 'btw', params: { sessionId: 'sess-main', nonce: `sat-${Date.now()}` } }))
    await win.locator('text=另一条会话').first().click()
    check('卫星窗复用过的旁聊窗切走会话仍会隐藏(归属没被抹掉)', (await until(async () => (await btwVisible(app, 'btw:sess-main')) === false)) === true)
    await win.locator('text=Parser 重构').first().click()
    await until(async () => (await btwVisible(app, 'btw:sess-main')) === true)

    // ── 会话级面板不给最小化:进了 Dock 的窗在别的会话里也点得出来(Codex 评审 P2),干脆不让它进 Dock ──
    check('旁聊窗不可最小化(收起 = 切走会话)', (await btwWin(app, 'btw:sess-main'))?.minimizable === false)

    // ── Esc 关窗(关了线程就丢:与 Claude 一样只在内存) ──
    const closed = panel.waitForEvent('close')
    await box.focus()
    // keydown 就关窗:press 的 keyup 可能落在已关的页上而抛 —— 行为由下面的 close 事件与 isClosed 判,这里不当失败。
    await box.press('Escape').catch(() => {})
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
    const longTitle = 'Parser 重构：包含多阶段分析与多次工具调用的长期会话标题'
    await panel2.evaluate((title) => window.tangu.openFloatingPanel({ id: 'btw:sess-main', title: `By the way · ${title}`, builtin: 'btw', params: { sessionId: 'sess-main', title, nonce: `long-title-${Date.now()}` } }), longTitle)
    check('长会话名传到旁聊内容头部', await until(async () => (await panel2.locator('.btw-context strong').getAttribute('title')) === longTitle))
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('id=btw%3Asess-main'))?.setSize(380, 400)
    })
    const narrow = await panel2.evaluate(() => {
      const panel = document.querySelector('.btw-panel')?.getBoundingClientRect()
      const compose = document.querySelector('.btw-compose')?.getBoundingClientRect()
      const label = document.querySelector('.btw-context strong')
      const context = label?.getBoundingClientRect()
      return panel && compose && context && label ? { panelRight: panel.right, composeBottom: compose.bottom, contextRight: context.right, titleOverflow: label.scrollWidth > label.clientWidth && getComputedStyle(label).textOverflow === 'ellipsis', viewportW: innerWidth, viewportH: innerHeight, scrollW: document.documentElement.scrollWidth } : null
    })
    check('最小 macOS 窗口下长标题省略且输入区不越界', !!narrow && narrow.titleOverflow && narrow.panelRight <= narrow.viewportW + 1 && narrow.composeBottom <= narrow.viewportH + 1 && narrow.contextRight <= narrow.viewportW - 14 && narrow.scrollW <= narrow.viewportW + 1, JSON.stringify(narrow))
    await panel2.screenshot({ path: path.join(shots, 'btw-en-dark-narrow.png') })
    console.log(`${checks} checks passed. Screenshots: ${shots}`)
  } catch (error) {
    if (app) { for (const [i, w] of app.windows().entries()) await w.screenshot({ path: path.join(shots, `failure-${i}.png`) }).catch(() => {}) }
    console.error(`Evidence: ${home}`)
    throw error
  } finally { if (app) await app.close(); await stub.close() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
