/** Real Electron:旁聊(/btw)。10-18「挂点统一」起主窗里开在对话右边那块子会话面板(不弹浮窗),卫星窗才开原生浮窗。
 * 钉住:/btw 开在面板里且主对话里什么都不发;回答来自引擎旁聊端点、追问带上前一轮;切会话面板跟着换、切回来线程还在;
 * 划线「顺便问」挂在同一条回答上 → 接着同一段并挂上引用(「在侧栏提问」并进了它);「带回这里」把回答挂进主窗输入框;
 * 引用是卡片,可以挂多段、逐张移除,已发消息开头的引用块还原成卡片;⌘; 快捷键;Esc 关面板;英文 / 深色截图。
 * 10-24 方案 A:输入区是共用 Chat Box,「+」在模型胶囊左边;「+」/ 粘贴 / 拖入加图片和文件(磁贴),不支持的类型给提示;
 * 附件随这一问到引擎(图片带缩略图),发出后那一问上显示磁贴,追问不再带内容;拖进面板的文件不进主输入框;
 * 面板头列出挂在这条回答上存下来的几段(第一行「新的一段」),点一段载回接着问,点「新的一段」另起。
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
  { id: 'u0', role: 'user', content: '> 第一段引用\n\n↳ 先看这段\n\n> 第二段引用\n> 还有第二行\n\n这两段是什么关系?', timestamp: now - 700 },
  { id: 'a0', role: 'model', content: '它们说的是同一件事。', timestamp: now - 600 },
  { id: 'u1', role: 'user', content: '记住:项目代号是 AZURE-FALCON。', timestamp: now - 500 },
  { id: 'a1', role: 'model', content: '好的,代号 AZURE-FALCON 已记下。接下来重构解析器的词法阶段。', timestamp: now - 400 },
]
const sse = (events) => ({ __buffer: Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')), contentType: 'text/event-stream' })
// 160×100 的条纹 PNG(红 / 黄横条 + 蓝方块;真图:面板要能把它画成缩略图)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAYAAAABtjuPAAABVElEQVR4Ae3BMXFbAQAFwcubX4mBGLh2aBiJioBxISShYQbpxUCtTUIz92dyu7/+vb9/k0hGIhqJaCSikYhGIhqJaCSikYhGIjqu9yeJZSSikYhGIhqJaCSikYhGIhqJaCSi43G7kFhGIhqJaCSikYhGIhqJaCSikYhGIjqu9yc5j9+ffzmzrz8fvNJIRCMRjUQ0EtFIRCMRjUQ0EtFIRMfjdiEn8sapPW4XXmkkopGIRiIaiWgkopGIRiIaiWgkouN6f5IT+eTUrvcnrzQS0UhEIxGNRDQS0UhEIxGNRDQS0fG4XciJvHFqj9uFVxqJaCSikYhGIhqJaCSikYhGIhqJ6Ljen+Q8vvjgfzIS0UhEIxGNRDQS0UhEIxGNRDQS0fG4XUgsIxGNRDQS0UhEIxGNRDQS0UhEIxEd1/uTxDIS0UhEIxGNRDQS0UhEIxGNRDQS0Q+rFxoUaADOzQAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')
const THUMB = `data:image/png;base64,${PNG_B64}`
// 存下来的顺便问(GET /asides):两段挂在 a1 上(其中 x-sess-main 就是第一问答完引擎回的那段),一段挂在 a0 上(不该列出来)
const SAVED = [
  { id: 'x-sess-main', message_id: 'a1', turns: [{ question: '代号是什么?', answer: '项目代号是 **AZURE-FALCON**。' }], created_at: '', updated_at: '' },
  { id: 'saved-2', message_id: 'a1', turns: [{ question: '截图里是什么?', answer: '一个红色方块。', attachments: [{ name: 'old.png', mimeType: 'image/png', size: 70, thumb: THUMB }] }, { question: '什么颜色?', answer: '红色。' }], created_at: '', updated_at: '' },
  { id: 'on-a0', message_id: 'a0', turns: [{ question: '别处的一段', answer: '不该出现在 a1 的列表里' }], created_at: '', updated_at: '' },
]
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
      if (route === '/agent/sessions/sess-main/asides' && method === 'GET') return { asides: SAVED }
      const m = /^\/agent\/sessions\/([^/]+)\/aside$/.exec(route)
      if (m && method === 'POST') {
        const b = await body()
        asides.push({ sessionId: m[1], ...b })
        if (String(b.question).includes('慢')) await new Promise((r) => setTimeout(r, 2500)) // 让这一问在流里多待一会儿
        const atts = b.attachments || []
        const answer = atts.length ? `收到 ${atts.length} 个附件:${atts.map((a) => a.name).join('、')}。` : b.thread?.length ? '倒过来是 **NOCLAF-ERUZA**。' : b.quote ? `这段在说代号:\`${b.quote.slice(0, 12)}\`。` : '项目代号是 **AZURE-FALCON**。'
        // 同真引擎:没给挂点 → 挂到最近一条回答(a1),done 回记录 id 与挂点;带了附件就报 attached(新引擎才有)
        const attached = atts.length ? { attached: { images: atts.filter((a) => a.mimeType.startsWith('image/')).length, files: atts.filter((a) => !a.mimeType.startsWith('image/')).map((a) => a.name), transcribed: false } } : {}
        return sse([...answer.match(/.{1,6}/g).map((text) => ({ type: 'delta', text })), { type: 'done', content: answer, toolCallText: false, asideId: b.aside_id || `x-${m[1]}`, asideMessageId: b.message_id || 'a1', ...attached }])
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

    // ── 输入区是共用 Chat Box:「+」在模型胶囊左边,模型胶囊缺省跟当前会话(m1) ──
    await win.waitForTimeout(800) // 面板还在滑出:两个盒子要在同一帧里量
    const boxes = await btw.evaluate((el) => {
      const r = (sel) => { const b = el.querySelector(sel)?.getBoundingClientRect(); return b ? { x: Math.round(b.x), right: Math.round(b.right), y: Math.round(b.y) } : null }
      return { plus: r('[data-testid="btw-attach"]'), pill: r('.btw-compose .t2c-row .composer-chip'), card: r('.btw-compose .t2c-card[data-ui-component="chat-box"]') }
    })
    check('输入区换成共用 Chat Box,「+」在左下、模型胶囊在它右边', !!boxes.card && !!boxes.plus && !!boxes.pill && boxes.plus.right <= boxes.pill.x && boxes.plus.x - boxes.card.x < 40, JSON.stringify(boxes))
    check('模型胶囊缺省跟当前会话的模型', asides[0].model_id === 'm1', JSON.stringify(asides[0].model_id))

    // ── 追问:带上前一轮和记录 id ──
    const box = btw.locator('.btw-compose .t2c-ta')
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
    const taH = await box.evaluate((el) => el.getBoundingClientRect().height)
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
    // 就地回复框(Claude 的「Reply to Claude」):上面是引文,写一句回应回车,连引用带回应加进输入框
    const replyBox = win.locator('.quote-reply')
    await replyBox.waitFor({ timeout: 5000 })
    check('点「引用」先弹就地回复框,框里是选中的那段', (await replyBox.locator('.quote-reply-text').textContent()).includes('AZURE-FALCON'))
    await win.keyboard.type('这句是重点')
    await win.screenshot({ path: path.join(shots, 'quote-reply.png') })
    await win.keyboard.press('Enter')
    await until(async () => (await mainQuotes.count()) === 2, 5000)
    const cardTexts = await mainQuotes.locator('.att-tile-open').allTextContents()
    check('再引用一段 → 输入框上方两张引用卡,先挂的那张还在;新卡显示回应、第二行是引文', cardTexts.length === 2 && cardTexts[0].includes('NOCLAF-ERUZA') && (await mainQuotes.nth(1).locator('.att-tile-head').textContent()) === '这句是重点' && cardTexts[1].includes('AZURE-FALCON'), JSON.stringify(cardTexts))
    const focusAt = await win.evaluate(() => { const a = document.activeElement; return { inComposer: !!a?.closest('.composer-anchor'), tag: a?.tagName, cls: String(a?.className || '').slice(0, 80) } })
    check('回复框收起,焦点回到输入框', (await until(async () => (await replyBox.count()) === 0, 2000)) && focusAt.inComposer, JSON.stringify({ boxes: await replyBox.count(), focusAt }))
    // 点卡 → 全文窗里能改回应
    await mainQuotes.nth(1).locator('.att-tile-open').click()
    const note = win.locator('.quote-preview .quote-preview-note')
    await note.waitFor({ timeout: 5000 })
    check('输入框里的卡点开 = 引文 + 可改的回应', (await note.inputValue()) === '这句是重点' && (await win.locator('.quote-preview-body').textContent()).includes('AZURE-FALCON'))
    await note.fill('改过的回应')
    await win.keyboard.press('Escape')
    await until(async () => (await mainQuotes.nth(1).locator('.att-tile-head').textContent()) === '改过的回应', 5000)
    check('全文窗里改的回应回到卡上', (await mainQuotes.nth(1).locator('.att-tile-head').textContent()) === '改过的回应')
    await win.screenshot({ path: path.join(shots, 'quote-cards.png') })
    await mainQuotes.first().locator('.att-tile-x').click()
    await until(async () => (await mainQuotes.count()) === 1, 5000)
    check('单独移除一张,另一张留着', (await mainQuotes.locator('.att-tile-open').allTextContents()).join('|').includes('AZURE-FALCON') && (await mainQuotes.count()) === 1)
    const bubble = await win.evaluate(() => {
      const wrap = [...document.querySelectorAll('[data-chat-surface="chat"] .t2-userwrap')].find((el) => el.textContent.includes('这两段是什么关系'))
      const cards = [...(wrap?.querySelectorAll('.att-tile--quote .att-tile-head') || [])].map((el) => el.textContent)
      // 引用磁贴在气泡上方;正文在长提问折叠(UserFold)里面,不是气泡的直接文本节点:去掉按钮后取剩下的字
      const rest = wrap?.querySelector('.t2-user')?.cloneNode(true)
      rest?.querySelectorAll('button').forEach((el) => el.remove())
      return { cards, body: (rest?.textContent || '').trim(), raw: !!rest?.textContent.includes('> ') }
    })
    check('已发消息开头的两段引用是两张卡,正文不再带「> 」', bubble.cards.length === 2 && bubble.cards[1].includes('还有第二行') && bubble.body === '这两段是什么关系?' && !bubble.raw, JSON.stringify(bubble))
    check('两段引用之间那句是前一张卡的回应,卡上显示它', bubble.cards[0] === '先看这段', JSON.stringify(bubble.cards))
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
    check('关掉后焦点回到点开它的那颗磁贴', await win.evaluate(() => !!document.activeElement?.closest('#tocmsg-u0 .att-tile--quote')))
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

    // ── 附件(10-24 方案 A):「+」选文件 / 粘贴截图 / 拖进面板;磁贴与主输入框同一种;不支持的给提示 ──
    const tiles = btw.locator('[data-testid="btw-tiles"] .att-tile')
    await btw.locator('[data-testid="btw-file-input"]').setInputFiles([
      { name: 'stripes.png', mimeType: 'image/png', buffer: PNG },
      { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\nThe vault key is ORCHID-7.\n') },
      { name: 'pack.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\u0003\u0004') },
    ])
    await until(async () => (await tiles.count()) === 2, 5000)
    check('「+」选的图片和文本文件成了磁贴(图片是方块缩略图),压缩包被跳过并说明', (await tiles.count()) === 2 && (await btw.locator('[data-testid="btw-tiles"] .att-tile--img').count()) === 1 && (await btw.locator('.btw-att-hint').textContent()).includes('pack.zip'))
    // 粘贴截图:剪贴板里只有文件时进附件,不往输入框里贴字
    await box.evaluate((el, b64) => {
      const bin = atob(b64)
      const dt = new DataTransfer()
      dt.items.add(new File([Uint8Array.from(bin, (c) => c.charCodeAt(0))], 'image.png', { type: 'image/png' }))
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, PNG_B64)
    await until(async () => (await tiles.count()) === 3, 5000)
    check('粘贴截图 → 多一张图片磁贴,输入框里没有多出字', (await tiles.count()) === 3 && (await box.inputValue()) === '')
    // 拖进面板:文件只进顺便问,不顺带进主输入框(面板长在聊天区里,聊天区也是主输入框的落区)
    const mainTilesBefore = await win.locator('[data-chat-surface="chat"] .composer-anchor .att-tile').count()
    await btw.locator('.btw-body').evaluate((el) => {
      const dt = new DataTransfer()
      dt.items.add(new File(['a,b\n1,2\n'], 'table.csv', { type: 'text/csv' }))
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    })
    await until(async () => (await tiles.count()) === 4, 5000)
    await win.waitForTimeout(300)
    check('拖进面板的文件成了磁贴,主输入框一张没多', (await tiles.count()) === 4 && (await win.locator('[data-chat-surface="chat"] .composer-anchor .att-tile').count()) === mainTilesBefore)
    await box.fill('这几个附件说了什么?')
    await win.waitForTimeout(300)
    await btw.screenshot({ path: path.join(shots, 'btw-attach.png') })
    const sentBefore = asides.length
    await box.press('Enter')
    await btw.locator('.btw-turn-a', { hasText: '收到 4 个附件' }).waitFor({ timeout: 15000 })
    const sent = asides[sentBefore]
    const att = (name) => sent?.attachments?.find((a) => a.name === name)
    check('附件随这一问到了引擎:内容是 base64,图片带缩略图,文本文件没有缩略图', sent?.attachments?.length === 4 && att('stripes.png')?.data === PNG_B64 && /^data:image\/jpeg;base64,/.test(att('stripes.png')?.thumb || '') && att('notes.md')?.mimeType === 'text/markdown' && !att('notes.md')?.thumb && !!att('table.csv')?.data, JSON.stringify(sent?.attachments?.map((a) => ({ name: a.name, mime: a.mimeType, len: a.data?.length, thumb: (a.thumb || '').slice(0, 30) }))))
    check('发出后输入区的磁贴清空,那一问上方显示附过的磁贴', (await tiles.count()) === 0 && (await btw.locator('.btw-turn').last().locator('[data-testid="btw-turn-files"] .att-tile').count()) === 4 && (await btw.locator('.btw-turn').last().locator('.att-tile--img').count()) === 2)
    await btw.screenshot({ path: path.join(shots, 'btw-attach-sent.png') })
    await box.fill('再说一遍')
    await box.press('Enter')
    await until(async () => asides.length === sentBefore + 2, 10000)
    const follow = asides[sentBefore + 1]
    const prevTurn = follow?.thread?.[follow.thread.length - 1]
    check('追问不再带附件内容:本问没有 attachments,上一轮只剩名字 / 类型 / 大小', !follow?.attachments && prevTurn?.attachments?.length === 4 && prevTurn.attachments.every((a) => !a.data && !a.thumb && a.name), JSON.stringify(prevTurn?.attachments))
    await btw.locator('.btw-turn[data-status="streaming"]').waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})

    // ── 面板头的列表:挂在这条回答(a1)上存下来的几段;第一行「新的一段」;别的回答上的不列 ──
    const list = btw.locator('[data-testid="btw-aside-list"]')
    await list.waitFor({ timeout: 10000 })
    const rows = await list.locator('.btw-list-row').evaluateAll((els) => els.map((el) => ({ aside: el.dataset.aside || (el.hasAttribute('data-new') ? 'new' : '?'), current: el.getAttribute('aria-current') === 'true', text: el.textContent })))
    check('列表只列 a1 上的两段,第一行是「新的一段」,当前这段标着', JSON.stringify(rows.map((r) => r.aside)) === JSON.stringify(['new', 'x-sess-main', 'saved-2']) && rows[1].current && !rows[0].current && rows[0].text.includes('新的一段') && (await list.locator('.btw-list-head').textContent()).includes('2'), JSON.stringify(rows))
    await list.locator('.btw-list-row[data-aside="saved-2"]').click()
    await until(async () => (await btw.locator('.btw-turn').count()) === 2, 5000)
    check('点一段 → 载回那段(两轮,第一轮带着当时附的缩略图)', (await btw.locator('.btw-turn').count()) === 2 && (await btw.locator('.btw-turn').first().locator('.btw-turn-q').textContent()) === '截图里是什么?' && (await btw.locator('.btw-turn').first().locator('.att-tile--img img').count()) === 1)
    await box.fill('接着问一句')
    await box.press('Enter')
    await until(async () => asides.length === sentBefore + 3, 10000)
    check('接着问带的是那段的记录 id 和挂点', asides[sentBefore + 2]?.aside_id === 'saved-2' && asides[sentBefore + 2]?.message_id === 'a1', JSON.stringify({ aside: asides[sentBefore + 2]?.aside_id, msg: asides[sentBefore + 2]?.message_id }))
    await btw.locator('.btw-turn[data-status="streaming"]').waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})
    await list.locator('.btw-list-row[data-new]').click()
    await until(async () => (await btw.locator('.btw-turn').count()) === 0, 5000)
    await box.fill('新开一段')
    await box.press('Enter')
    await until(async () => asides.length === sentBefore + 4, 10000)
    check('「新的一段」→ 线程清空,下一问挂在同一条回答上、不带记录 id', (await btw.locator('.btw-turn').count()) === 1 && asides[sentBefore + 3]?.message_id === 'a1' && !asides[sentBefore + 3]?.aside_id && !asides[sentBefore + 3]?.thread?.length, JSON.stringify(asides[sentBefore + 3]))
    await btw.locator('.btw-turn[data-status="streaming"]').waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})
    await win.screenshot({ path: path.join(shots, 'btw-list.png') })

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
