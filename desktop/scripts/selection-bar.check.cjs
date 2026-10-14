/** Real Electron:划线菜单 —— 选中文字后浮出来的那一条(DESIGN §6「划线菜单」)。
 * 钉住:
 *   聊天 —— 条在选区上方居中、不越出视口,外壳是圆角矩形(不是胶囊);组成 = 引用 / 在侧栏提问 / 顺便问 / 翻译(+ ⋯);
 *           「引用」照旧挂卡;翻译开**只读**结果卡(没有「替换」),目标语言按界面语言定,缺省走目录里的机器翻译模型,
 *           卡上写明谁译的,卡头换语言重译,点卡外面收;自动选上的机器翻译模型失败时落回聊天模型;
 *           插件动作按 scope / when 进 ⋯;输入框里的选区不出;滚动 / 点到外面收。
 *   插件视图 —— ctx.ui.mountSelectionBar:自己的工具(颜色点 / 图标钮)+ 宿主的动作区;接管「问 Tangu」;source 交给动作;
 *           output:'none' 不出卡;show() / hide();输入框里不出;排法设置(工具在前 / 动作在前);dispose 后不再出。
 * 笔记那一半(格式工具栏里的动作区)在浏览器台架 `npm run check:editorai -- --group=H`。
 * npm run build && npm run check:selectionbar        ZOOM=1.1 再跑一遍(用户的开发版常年 110%)
 * 全程打隔离 loopback stub(引擎 /agent/inline 按剧本回 SSE),不碰真账号、不烧模型额度;对真的机器翻译接口这里证不了。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
const ZOOM = Number(process.env.ZOOM || 1)
let checks = 0
const failed = []
/** 红了记下来接着往下走(后面的步骤多半互不依赖;真依赖的会自己超时抛错),收尾时有一条红就非零退出。 */
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); checks++; return }
  failed.push(name)
  console.log(`FAIL ${name}${detail ? ` | ${detail}` : ''}`)
}
async function until(fn, ms = 8000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await new Promise((r) => setTimeout(r, 120)) } }

const now = Date.now()
const SESSIONS = [{ id: 'sess-main', title: 'Parser 重构', model_id: 'm1', created_at: now, updated_at: now, projectless: true }]
const REPLY = '好的,代号 AZURE-FALCON 已记下。接下来重构解析器的词法阶段,先把记号流和错误恢复拆开,再补一组边界用例。'
const MESSAGES = [
  { id: 'u1', role: 'user', content: '记住:项目代号是 AZURE-FALCON。', timestamp: now - 500 },
  { id: 'a1', role: 'model', content: `${REPLY}\n\nThe lexer should stay a pure function of its input.`, timestamp: now - 400 },
]
const sse = (events) => ({ __buffer: Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')), contentType: 'text/event-stream' })

const PLUGIN_MAIN = `
window.__selprobe = { ran: [], asked: [], tools: [], bar: null }
ctx.registerSelectionAction({ id: 'note-only', title: '只在笔记', run: function () { return 'x' } })
ctx.registerSelectionAction({ id: 'everywhere', title: '到处', scope: 'all', icon: 'bookmark', run: function (cx) { return 'E:' + cx.view + ':' + cx.editable + ':' + (cx.pagePath === undefined) + ':' + (cx.source && cx.source.title) } })
ctx.registerSelectionAction({ id: 'long', title: '长的才有', scope: ['chat'], when: function (cx) { return cx.length >= 15 }, run: function () { return 'x' } })
ctx.registerSelectionAction({ id: 'own', title: '只在自己的视图', scope: 'own', output: 'none', run: function (cx) { window.__selprobe.ran.push(cx.text + '|' + cx.view + '|' + (cx.source && cx.source.page)) } })
ctx.registerView({ id: 'reader', title: 'Sel Probe', mount: function (el) {
  el.innerHTML = '<div class="selprobe" style="height:100%;overflow:auto;padding:120px 60px;font-size:15px;line-height:1.7;color:var(--text)"><p id="selprobe-p">Plugin view paragraph for the selection bar check.</p><input id="selprobe-in" value="text inside an input" style="width:260px"/><div style="height:1600px"></div></div>'
  var bar = ctx.ui && ctx.ui.mountSelectionBar ? ctx.ui.mountSelectionBar(el, {
    view: 'reader',
    tools: [
      { id: 'yellow', title: 'Highlight', color: '#ffd400', run: function (sel) { window.__selprobe.tools.push('yellow:' + sel.text) } },
      { id: 'note', title: 'Annotate', icon: 'annotate', run: function (sel) { window.__selprobe.tools.push('note:' + sel.text); window.getSelection().removeAllRanges() } },
    ],
    source: function () { return { title: 'Probe doc', page: 7 } },
    ask: function (sel) { window.__selprobe.asked.push(sel.text) },
  }) : null
  window.__selprobe.bar = bar
  return function () { if (bar) bar.dispose() }
} })
window.__selprobe.open = function () { return ctx.openView('reader') }
`

/** 真鼠标拖选 `root` 里第一处 `text`(松手才出条)。返回选区外接矩形(视口 px)。 */
async function dragSelect(win, rootSel, text) {
  const r = await win.evaluate(({ rootSel, text }) => {
    for (const root of document.querySelectorAll(rootSel)) {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let n
      while ((n = w.nextNode())) {
        const i = n.data.indexOf(text)
        if (i < 0) continue
        n.parentElement.scrollIntoView({ block: 'center' })
        const a = document.createRange(); a.setStart(n, i); a.setEnd(n, i + 1)
        const b = document.createRange(); b.setStart(n, i + text.length - 1); b.setEnd(n, i + text.length)
        const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect()
        return { x0: ra.left + 1, y0: ra.top + ra.height / 2, x1: rb.right - 1, y1: rb.top + rb.height / 2 }
      }
    }
    return null
  }, { rootSel, text })
  if (!r) throw new Error(`text not found: ${text}`)
  await win.waitForTimeout(250) // scrollIntoView 引起的滚动先落定(滚动会把条收掉)
  const at = await win.evaluate(({ rootSel, text }) => {
    for (const root of document.querySelectorAll(rootSel)) {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let n
      while ((n = w.nextNode())) {
        const i = n.data.indexOf(text)
        if (i < 0) continue
        const a = document.createRange(); a.setStart(n, i); a.setEnd(n, i + 1)
        const b = document.createRange(); b.setStart(n, i + text.length - 1); b.setEnd(n, i + text.length)
        const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect()
        return { x0: ra.left + 1, y0: ra.top + ra.height / 2, x1: rb.right - 1, y1: rb.top + rb.height / 2 }
      }
    }
    return null
  }, { rootSel, text })
  await win.mouse.move(at.x0, at.y0)
  await win.mouse.down()
  await win.mouse.move((at.x0 + at.x1) / 2, (at.y0 + at.y1) / 2, { steps: 4 })
  await win.mouse.move(at.x1, at.y1, { steps: 4 })
  await win.mouse.up()
  await win.waitForTimeout(250)
  return win.evaluate(() => {
    const s = window.getSelection()
    if (!s || !s.rangeCount || s.isCollapsed) return null
    const b = s.getRangeAt(0).getBoundingClientRect()
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, text: s.toString() }
  })
}
/** 条的现状:位置、外壳、行里各枚按钮的 data-act(竖线记成 '|')。 */
const barState = (win) => win.evaluate(() => {
  const el = document.querySelector('[data-testid="selection-bar"]')
  if (!el) return null
  const b = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  return {
    left: b.left, right: b.right, top: b.top, bottom: b.bottom,
    view: el.getAttribute('data-view'), dense: el.hasAttribute('data-dense'), popover: el.classList.contains('ui-popover'),
    radius: parseFloat(cs.borderTopLeftRadius), position: cs.position, inBody: el.parentElement === document.body,
    row: [...el.querySelectorAll('.selbar-row > *')].map((x) => (x.classList.contains('selbar-sep') ? '|' : x.getAttribute('data-act') || '?')),
    vw: innerWidth, vh: innerHeight,
  }
})
const card = (win) => win.evaluate(() => {
  const el = document.querySelector('[data-testid="inline-ai-panel"]')
  if (!el) return null
  const b = el.getBoundingClientRect()
  return {
    phase: el.getAttribute('data-phase'), readonly: el.hasAttribute('data-readonly'), top: b.top, left: b.left, right: b.right, bottom: b.bottom,
    preview: el.querySelector('[data-testid="inline-ai-preview"]')?.textContent ?? null,
    acts: [...el.querySelectorAll('button[data-act]')].map((x) => x.getAttribute('data-act')),
    lang: el.querySelector('[data-testid="inline-ai-lang"]')?.value ?? null,
    hint: el.querySelector('[data-testid="inline-ai-hint"]')?.textContent ?? null,
    title: el.querySelector('.am-ai-title')?.textContent ?? null,
  }
})
const cardDone = (win) => until(async () => { const c = await card(win); return c && (c.phase === 'done' || c.phase === 'error') ? c : null }, 10000)
/** 点开 ⋯,返回里面的项;给了 id 就点它。 */
async function pickMore(win, id) {
  const btn = win.locator('[data-testid="selection-bar"] [data-act="more"]')
  if (!(await btn.count())) return []
  await btn.click()
  await win.locator('[data-testid="selbar-more"]').waitFor({ timeout: 3000 })
  const items = await win.evaluate(() => [...document.querySelectorAll('[data-testid="selbar-more"] [data-ai]')].map((b) => b.getAttribute('data-ai')))
  if (id) await win.locator(`[data-testid="selbar-more"] [data-ai="${id}"]`).click()
  return items
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-selbar-'))
  const shots = path.join(home, 'screenshots'); fs.mkdirSync(shots)
  const userdata = path.join(home, 'userdata'); fs.mkdirSync(userdata)
  const vault = path.join(home, 'vault'); fs.mkdirSync(vault)
  const plugin = path.join(home, 'plugins', 'selprobe'); fs.mkdirSync(plugin, { recursive: true })
  fs.writeFileSync(path.join(plugin, 'main.js'), PLUGIN_MAIN)
  fs.writeFileSync(path.join(plugin, 'manifest.json'), JSON.stringify({ id: 'selprobe', name: 'selprobe', version: '1.0.0', minAppVersion: '0.0.1', description: '台架用的划线条探针,不是产品插件' }))
  fs.writeFileSync(path.join(userdata, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  const inline = []
  let failMt = false
  const stub = await startStubEngine({
    sessions: SESSIONS,
    messages: MESSAGES,
    models: [{ id: 'm1', name: 'Stub Chat', provider: 'stub', contextWindow: 128_000 }],
    modelsMeta: { translateModels: [{ id: 'qwen-mt', name: 'Qwen MT Flash', provider: 'bailian', apiModelId: 'qwen-mt-flash' }] },
    handle: async ({ path: route, method, body }) => {
      if (route === '/agent/runs') return { runs: [] }
      if (route === '/api/brain/users/me') return { id: 'test-selbar', username: 'Selbar tester' }
      if (route === '/agent/inline' && method === 'POST') {
        const b = await body()
        inline.push(b)
        if (failMt && b.model_id === 'qwen-mt') return { __code: 500, body: { detail: 'mt upstream down' } }
        const answer = `译文<${b.language}>:${String(b.selection).slice(0, 8)}`
        return sse([...answer.match(/[\s\S]{1,5}/g).map((text) => ({ type: 'delta', text })), { type: 'done', content: answer, toolCallText: false }])
      }
    },
  })
  const token = ['test', Buffer.from(JSON.stringify({ sub: 'test-selbar', exp: Math.floor(Date.now() / 1000) + 86400 * 10 })).toString('base64url'), 'test'].join('.')
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ cloudUrl: stub.url, token }))
  fs.writeFileSync(path.join(userdata, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, cloudUrl: stub.url, token }))
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
    await win.waitForSelector('#root')
    await win.evaluate((zoom) => {
      localStorage.setItem('forsion_default_space', 'tangu'); localStorage.setItem('tangu_locale', 'zh')
      localStorage.removeItem('forsion_selection_bar_order')
      // 2.10.0 那次「缩放回到默认」的一次性迁移会清掉存着的缩放:应用首帧可能还没跑到它,这里先标成已迁移,不然重载时被清回 100%。
      if (zoom !== 1) { localStorage.setItem('forsion_ui_zoom_default_2_10_0', '1'); localStorage.setItem('forsion_ui_zoom', String(zoom)) }
    }, ZOOM)
    await win.reload({ waitUntil: 'domcontentloaded' })
    check('主窗离开首启引导', await skipOnboarding(win))
    const input = win.locator('.t2c-ta').first()
    await input.waitFor({ timeout: 30000 })
    await win.locator('text=Parser 重构').first().click()
    await win.locator('.t2-content', { hasText: 'AZURE-FALCON 已记下' }).first().waitFor({ timeout: 15000 })
    if (ZOOM !== 1) check(`界面缩放 ${ZOOM} 已生效`, Math.abs((await win.evaluate(() => document.body.currentCSSZoom || 1)) - ZOOM) < 0.01)
    const CHAT = '[data-chat-surface="chat"] .t2-content'
    // 先等探针插件装好:条上有没有 ⋯ 取决于它注册的动作
    check('探针插件已加载', (await until(() => win.evaluate(() => !!window.__selprobe), 15000)) === true)

    // ── 聊天:条的位置、外壳、组成 ──
    const sel1 = await dragSelect(win, CHAT, 'AZURE-FALCON 已记下')
    const bar1 = await until(() => barState(win), 5000)
    check('聊天里选中文字 → 划线条出现,挂在 body 下、fixed', !!sel1 && !!bar1 && bar1.inBody && bar1.position === 'fixed' && bar1.view === 'chat', JSON.stringify({ sel1, bar1 }))
    check('条在选区上方、水平居中(±2px)、不越出视口', bar1.bottom <= sel1.top + 1 && sel1.top - bar1.bottom < 16 && Math.abs((bar1.left + bar1.right) / 2 - (sel1.left + sel1.right) / 2) <= 2 && bar1.left >= 0 && bar1.right <= bar1.vw && bar1.top >= 0, JSON.stringify({ sel1, bar1 }))
    check('外壳是共用的 .ui-popover 圆角矩形(不是胶囊)', bar1.popover && bar1.radius > 0 && bar1.radius <= 14 && (await win.locator('.t2-quote-menu').count()) === 0, `radius=${bar1.radius}`)
    check('组成:引用 / 在侧栏提问 / 顺便问 / 翻译 / ⋯(聊天没有自己的工具,不画竖线)', bar1.row.join(',') === 'quote,ask-in-panel,btw,translate,more', bar1.row.join(','))
    await win.screenshot({ path: path.join(shots, 'chat-bar.png') })

    // ── 输入区里的选区不出;滚动 / 点到外面收 ──
    await win.locator('.t2-stream').first().evaluate((el) => { el.scrollTop = Math.max(0, el.scrollTop - 1); el.dispatchEvent(new Event('scroll')) })
    check('聊天区一滚动条就收', (await until(async () => !(await barState(win)), 3000)) === true)
    await dragSelect(win, CHAT, 'AZURE-FALCON 已记下')
    await until(() => barState(win), 5000)
    await input.click() // 输入框:在消息流外面,点了哪儿也不去
    check('点到聊天区外面条就收', (await until(async () => !(await barState(win)), 3000)) === true)
    await input.fill('输入框里的一段字')
    await input.focus()
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await input.dispatchEvent('mouseup')
    await win.waitForTimeout(300)
    check('输入框里的选区不出条', !(await barState(win)))
    await input.fill('')

    // ── 「引用」照旧:挂成输入框上方的引用卡,条收起、选区清掉 ──
    await dragSelect(win, CHAT, 'AZURE-FALCON 已记下')
    await win.locator('[data-testid="selection-quote"]').click()
    await win.locator('[data-chat-surface="chat"] .t2c-quote-text', { hasText: 'AZURE-FALCON' }).first().waitFor({ timeout: 5000 })
    check('「引用」挂卡后条收起、选区清掉', !(await barState(win)) && (await win.evaluate(() => window.getSelection().isCollapsed)))
    await win.locator('[data-chat-surface="chat"] .t2c-quote-x').first().click()

    // ── 翻译:只读结果卡;目标语言 = 界面语言之外的那种;缺省走目录里的机器翻译模型 ──
    const sel2 = await dragSelect(win, CHAT, '重构解析器的词法阶段')
    await win.locator('[data-testid="selection-translate"]').click()
    const c1 = await cardDone(win)
    const req1 = inline.at(-1)
    check('翻译请求:action=translate、选中的文字、中文界面下中文译成英文', req1?.action === 'translate' && req1.selection === '重构解析器的词法阶段' && req1.language === 'English', JSON.stringify(req1))
    check('没在设置里选过翻译模型 → 自动用目录里的机器翻译模型', req1?.model_id === 'qwen-mt', `model_id=${req1?.model_id}`)
    check('结果卡是只读的:复制 / 重试 / 关闭,没有「替换」「插入下方」', !!c1 && c1.readonly && c1.phase === 'done' && c1.acts.join(',') === 'copy,retry,discard' && c1.preview === '译文<English>:重构解析器的词法', JSON.stringify(c1))
    check('卡头:目标语言下拉 + 写明是机器翻译', c1.lang === 'English' && /机器翻译.*Qwen MT Flash/.test(c1.hint || '') && c1.title === '翻译', JSON.stringify(c1))
    check('卡贴着选区(下面放不下才翻到上面)、不越出视口;条已收起、选区还在', ((c1.top >= sel2.bottom - 1 && c1.top - sel2.bottom < 16) || (c1.bottom <= sel2.top + 1 && sel2.top - c1.bottom < 16)) && c1.left >= 0 && c1.right <= (await win.evaluate(() => innerWidth)) && !(await barState(win)) && !(await win.evaluate(() => window.getSelection().isCollapsed)), JSON.stringify({ c1, sel2 }))
    await win.screenshot({ path: path.join(shots, 'chat-translate-card.png') })
    await win.locator('[data-testid="inline-ai-lang"]').selectOption('Japanese')
    await until(async () => inline.length >= 2 && inline.at(-1).language === 'Japanese', 5000)
    const c2 = await cardDone(win)
    check('卡头换语言 = 重译一次', inline.at(-1)?.language === 'Japanese' && c2?.lang === 'Japanese' && c2.preview === '译文<Japanese>:重构解析器的词法', JSON.stringify({ last: inline.at(-1), c2 }))
    await input.click()
    check('点卡外面卡就收', (await until(async () => !(await card(win)), 3000)) === true)

    // 英文选区 → 界面语言
    await dragSelect(win, CHAT, 'pure function of its input')
    await win.locator('[data-testid="selection-translate"]').click()
    await cardDone(win)
    check('英文选区译成界面语言(简体中文)', inline.at(-1)?.language === 'Chinese (Simplified)', JSON.stringify(inline.at(-1)))
    await win.keyboard.press('Escape')
    check('Esc 关卡', (await until(async () => !(await card(win)), 3000)) === true)

    // 自动选上的机器翻译模型失败 → 落回聊天模型再来一次
    failMt = true
    const before = inline.length
    await dragSelect(win, CHAT, '重构解析器的词法阶段')
    await win.locator('[data-testid="selection-translate"]').click()
    const c3 = await cardDone(win)
    failMt = false
    check('机器翻译模型失败 → 落回聊天模型,卡上写的是真正译的那个', inline.length === before + 2 && inline.at(-2).model_id === 'qwen-mt' && inline.at(-1).model_id === 'm1' && c3?.phase === 'done' && c3.hint === 'Stub Chat', JSON.stringify({ models: inline.slice(before).map((x) => x.model_id), c3 }))
    await win.keyboard.press('Escape')
    await until(async () => !(await card(win)), 3000)

    // ── 插件动作:scope / when;结果进只读卡 ──
    await dragSelect(win, CHAT, '已记下')
    const short = await pickMore(win)
    check('⋯ 里只列认聊天的动作(只在笔记 / 只在自己视图 / 字数不够的不列)', short.join(',') === 'plugin:selprobe:everywhere', short.join(','))
    await win.screenshot({ path: path.join(shots, 'chat-more.png') })
    await input.click()
    await dragSelect(win, CHAT, '先把记号流和错误恢复拆开,再补一组边界用例')
    const longer = await pickMore(win, 'plugin:selprobe:everywhere')
    const c4 = await cardDone(win)
    check('when 按字数放行;run 拿到 view=chat、editable=false、没有 pagePath、带出处;结果进只读卡', longer.join(',') === 'plugin:selprobe:everywhere,plugin:selprobe:long' && c4?.readonly && c4.preview === 'E:chat:false:true:Parser 重构' && c4.lang === null && c4.title === '到处', JSON.stringify({ longer, c4 }))
    await win.keyboard.press('Escape')
    await until(async () => !(await card(win)), 3000)

    // ── 插件视图:ctx.ui.mountSelectionBar ──
    await dragSelect(win, CHAT, 'AZURE-FALCON 已记下')
    await until(() => barState(win), 5000)
    await win.evaluate(() => window.__selprobe.open())
    await win.locator('#selprobe-p').waitFor({ timeout: 10000 })
    check('切到别的视图(聊天被换到后台)→ 聊天那一条不留在屏上', (await until(async () => !(await barState(win)), 3000)) === true)
    check('插件视图挂上了宿主的划线条', await win.evaluate(() => !!window.__selprobe.bar && typeof window.__selprobe.bar.show === 'function'))
    const sel5 = await dragSelect(win, '.selprobe', 'paragraph for the selection')
    const bar5 = await until(() => barState(win), 5000)
    check('插件视图里:自己的工具在前(颜色点、图标钮),竖线,再是问 Tangu / 翻译 / ⋯', !!bar5 && bar5.view === 'selprobe:reader' && bar5.row.join(',') === 'yellow,note,|,ask,translate,more', JSON.stringify(bar5))
    check('位置同样在选区上方居中', bar5.bottom <= sel5.top + 1 && Math.abs((bar5.left + bar5.right) / 2 - (sel5.left + sel5.right) / 2) <= 2, JSON.stringify({ sel5, bar5 }))
    await win.screenshot({ path: path.join(shots, 'plugin-bar.png') })
    await win.locator('[data-testid="selection-bar"] [data-act="yellow"]').click()
    check('点工具 → 调到插件的 run(带选中的文字);没清选区条就还在', (await win.evaluate(() => window.__selprobe.tools.join(','))) === 'yellow:paragraph for the selection' && !!(await barState(win)))
    const more5 = await pickMore(win, 'plugin:selprobe:own')
    await win.waitForTimeout(300)
    check("scope:'own' 的动作只在这里列;output:'none' 不出卡,run 拿到视图 id 和出处页码", more5.join(',') === 'plugin:selprobe:everywhere,plugin:selprobe:own' && (await win.evaluate(() => window.__selprobe.ran.join(','))) === 'paragraph for the selection|selprobe:reader|7' && !(await card(win)), `${more5.join(',')} ${await win.evaluate(() => window.__selprobe.ran.join(','))}`)
    await dragSelect(win, '.selprobe', 'paragraph for the selection')
    await win.locator('[data-testid="selection-ask"]').click()
    check('插件接管了「问 Tangu」:走它自己的回调,条收起', (await win.evaluate(() => window.__selprobe.asked.join(','))) === 'paragraph for the selection' && !(await barState(win)))
    await dragSelect(win, '.selprobe', 'paragraph for the selection')
    await win.locator('[data-testid="selection-bar"] [data-act="note"]').click()
    check('工具在 run 里清了选区 → 条跟着收', (await until(async () => !(await barState(win)), 3000)) === true && (await win.evaluate(() => window.__selprobe.tools.at(-1))) === 'note:paragraph for the selection')
    await win.locator('#selprobe-in').click()
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await win.locator('#selprobe-in').dispatchEvent('mouseup')
    await win.waitForTimeout(300)
    check('插件视图的输入框里也不出条', !(await barState(win)))

    // 排法设置:动作在前
    await win.evaluate(() => localStorage.setItem('forsion_selection_bar_order', 'actions'))
    await dragSelect(win, '.selprobe', 'paragraph for the selection')
    const bar6 = await until(() => barState(win), 5000)
    check('设置换成「动作在前」→ 问 Tangu / 翻译 / ⋯ 打头,工具在后', bar6?.row.join(',') === 'ask,translate,more,|,yellow,note', bar6?.row.join(','))
    await win.screenshot({ path: path.join(shots, 'plugin-bar-actions-first.png') })
    await win.evaluate(() => { localStorage.removeItem('forsion_selection_bar_order'); window.getSelection().removeAllRanges() })
    await until(async () => !(await barState(win)), 3000)

    // show() / hide():自己报文字和位置
    await win.evaluate(() => window.__selprobe.bar.show({ text: 'manual text', rect: { left: 420, right: 620, top: 500, bottom: 520 } }))
    const bar7 = await until(() => barState(win), 5000)
    check('show({ text, rect }) → 条按给的矩形落位(视口 px,缩放由宿主抵消)', !!bar7 && Math.abs((bar7.left + bar7.right) / 2 - 520) <= 2 && bar7.bottom <= 501 && 500 - bar7.bottom < 16, JSON.stringify(bar7))
    await win.locator('[data-testid="selection-translate"]').click()
    await cardDone(win)
    check('自己报的选区一样能翻译', inline.at(-1)?.selection === 'manual text' && inline.at(-1)?.language === 'Chinese (Simplified)', JSON.stringify(inline.at(-1)))
    await win.keyboard.press('Escape')
    await until(async () => !(await card(win)), 3000)
    await win.evaluate(() => window.__selprobe.bar.show({ text: 'manual text', rect: { left: 420, right: 620, top: 500, bottom: 520 } }))
    await until(() => barState(win), 5000)
    await win.evaluate(() => window.__selprobe.bar.hide())
    check('hide() 收条', (await until(async () => !(await barState(win)), 3000)) === true)
    await win.evaluate(() => { window.__selprobe.bar.dispose(); window.__selprobe.bar.show({ text: 'after dispose', rect: { left: 420, right: 620, top: 500, bottom: 520 } }) })
    await win.waitForTimeout(300)
    check('dispose() 之后不再出条', !(await barState(win)))

    // ── 观感自查(DESIGN §8):回聊天,深色 + 英文各截一张,人看 ──
    await win.evaluate(() => { localStorage.setItem('forsion_theme_pref', 'dark'); localStorage.setItem('forsion_theme', 'dark'); localStorage.setItem('tangu_locale', 'en') })
    await win.reload({ waitUntil: 'domcontentloaded' })
    // 重载后先认会话行再点(恢复出来的活动标签可能是探针插件那个视图,这时没有输入框可等)
    await win.locator('text=Parser 重构').first().waitFor({ timeout: 30000 })
    await win.locator('text=Parser 重构').first().click()
    await win.locator(CHAT, { hasText: 'AZURE-FALCON' }).first().waitFor({ timeout: 15000 })
    await dragSelect(win, CHAT, '重构解析器的词法阶段')
    const barEn = await until(() => barState(win), 5000)
    const labels = await win.evaluate(() => [...document.querySelectorAll('[data-testid="selection-bar"] .selbar-row > button')].map((b) => b.textContent.trim()))
    check('英文界面:条上的字是英文(不是 key、不是中文)', !!barEn && labels.slice(0, 4).every((l) => /^[A-Za-z ]+$/.test(l)) && labels.includes('Translate'), labels.join(' | '))
    await win.screenshot({ path: path.join(shots, 'chat-bar-dark-en.png') })
    await win.locator('[data-testid="selection-translate"]').click()
    const cEn = await cardDone(win)
    check('英文界面:中文选区译成英文;卡上的按钮是英文', inline.at(-1)?.language === 'English' && !!cEn && (await win.evaluate(() => [...document.querySelectorAll('[data-testid="inline-ai-panel"] button[data-act]')].map((b) => b.textContent.trim()).join('|'))) === 'Copy|Try again|Close', JSON.stringify(cEn))
    await win.screenshot({ path: path.join(shots, 'chat-translate-card-dark-en.png') })

    console.log(`\n${checks} checks passed, ${failed.length} failed${ZOOM !== 1 ? ` (ZOOM=${ZOOM})` : ''}`)
    console.log(`SCREENSHOTS ${shots}`)
    if (failed.length) process.exitCode = 1
  } finally {
    if (app) await app.close().catch(() => {})
    await stub.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
