/**
 * Human Desk(Human Task 方案第三轮,2026-11-23 用户定:两张卡各自独立、右边一次只展开一块)的真界面验收:
 * 真 Electron(已构建的 out/)× 隔离 home × 可编剧假引擎 × DOM 断言。方案页仓根 docs/ToBeImproved/HumanTask实时协作方案_2026-11-20/r3.html。
 * 载具照抄 desk-manual.check.cjs。
 *
 * 覆盖(每段一个 step,断言写在 check() 里;ONLY=a,b 只跑其中几段 —— 负对照用):
 *   a  两张卡:Human Desk 卡在 Agent Desk 卡上面;空的缺省收成卡头,点开 = 空态那句 + ＋
 *   b  放进来 ①:＋ → 新建笔记(智库里真多一篇)→ 右边切到 Human Desk、真编辑器、输入框挂「现场」引用
 *   c  放进来 ②:拖文件到 Human Desk 卡(收着时)/ 展开的 Human Desk 上,染色 + 换成它 + 切过去
 *   d  展开 / 切换 / 收起:切换件「你 / Agent」,任何时刻只有一块展开;Agent 段带 ✦
 *   e  放进来 ③:Agent Desk 格 ⋯「我来改」= 挪过来(Agent Desk 少一格);▾ 最近放过的换回笔记
 *   f  在看 → 引用:光标进第 3 节 → 引用写「第 3 节」、卡片写「你在第 3 节 · 明细」;发出去的消息里真带着;停止 / × 引用 → 不再带
 *   g  离开满时长自动暂停(台架把阈值调成 2.5s):切到 Agent / 收起 → 引用撤、眼睛灭;回来接着看
 *   h  Agent 不抢:Human Desk 展开时 desk_present wide / 写文件只在「Agent」段亮点(点在段内),右边不换、编辑器不换;切过去点灭
 *   i  两张卡都想开但放不下:最近碰过的那张开,另一张收成卡头;点卡头互换
 *   j  窄:切换件收成只留图标,两块的 ⋯ 和收起都在格内(紧凑阈值上下各量一档)
 *   k  两扇窗:换东西对面跟着;对面展开 Agent Desk,这扇的 Human Desk 不被换掉;对面没守着 → 不挂引用
 *   s  desk_screenshot 调查:Human Desk 展开时截到的是哪块(宽 / 窄窗各一次),只记事实不判
 *   shots 亮 / 暗各一张展开态 + 卡片态,与 r3 对照
 *
 * 跑(必须经 devlock):node <仓根>/.claude/hooks/devlock.cjs run --vehicle=e2e --what="Human Desk" --eta=8 -- npm run check:humandesk
 * 先 npm run build。截图与 result.json 写到 OUT(缺省系统临时目录下 human-desk-check/),不入库。
 */
const fs = require('fs'); const os = require('os'); const path = require('path')
const DESK = path.join(__dirname, '..')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const OUT = process.env.OUT || path.join(os.tmpdir(), 'human-desk-check'); fs.mkdirSync(OUT, { recursive: true })
const ONLY = (process.env.ONLY || '').split(',').map((x) => x.trim()).filter(Boolean)
const W = 1512, H = 950
const PAUSE_MS = 2500
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const filler = (tag) => Array.from({ length: 6 }, (_, i) => `${tag} 第 ${i + 1} 段:Alpha 12/30 · Beta 10/28 · Gamma 按量计费,年付折扣 17%–20%。`).join('\n\n')
const NOTE = ['# 定价调研', '', filler('导语'), '', '## 1. 背景', '', filler('背景'), '', '## 2. 结论', '', filler('结论'), '', '### 细节', '', filler('细节'), '',
  '## 3. 明细', '', filler('明细'), '', '## 4. 对我们的启发', '', filler('启发'), ''].join('\n')
const REPORT = ['# 竞品定价报告', '', '## 结论', '- 三家都把「团队版」定在个人版的 2.5–3 倍', ''].join('\n')

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-humandesk-'))
  const userData = path.join(home, 'userdata'); const vault = path.join(home, 'vault'); const proj = path.join(home, 'pricing')
  for (const d of [userData, `${userData}-dev`, vault, proj]) fs.mkdirSync(d, { recursive: true })
  const F = { N: path.join(vault, '定价调研.md'), R: path.join(proj, 'pricing-report.md'), T: path.join(proj, 'notes.txt'), C: path.join(proj, 'prices.csv'), D: path.join(proj, 'draft.md') }
  fs.writeFileSync(F.N, NOTE); fs.writeFileSync(F.R, REPORT); fs.writeFileSync(F.T, 'line 1\nline 2\n'); fs.writeFileSync(F.C, 'product,personal,team\nAlpha,12,30\n')
  const S = { id: 'hd-s1', title: '竞品定价调研', summary: '', archived: false, model_id: 'm1', project_path: proj, project_name: 'pricing', projectless: false,
    agent_config: { execMode: 'host', cwd: proj }, created_at: '2026-11-23 10:00:00', updated_at: '2026-11-23 10:00:00' }
  const HISTORY = [
    { id: 'h1', role: 'user', content: '帮我调研一下三家竞品的定价', created_at: S.created_at },
    { id: 'h2', role: 'assistant', content: '好,我先整理一份报告。', created_at: S.created_at },
  ]
  const captures = []
  const stub = await startStubEngine({
    sessions: [S], messages: [],
    override: async ({ path: route, method, body }) => {
      if (route === '/agent/runs' && method === 'GET') return { runs: [] }
      if (/^\/agent\/sessions\/[^/]+\/messages$/.test(route) && method === 'GET') return { messages: HISTORY }
      if (/^\/agent\/runs\/[^/]+\/captures\/[^/]+$/.test(route) && method === 'POST') {
        const b = (await body()) || {}
        captures.push({ shotId: route.split('/').pop(), mode: b.mode || null, error: b.error || null, bytes: String(b.dataUrl || '').length })
        return { ok: true }
      }
      return undefined
    },
  })
  for (const dir of [userData, `${userData}-dev`]) {
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }))
    fs.writeFileSync(path.join(dir, 'amadeus-config.dev.json'), JSON.stringify({ localVault: vault, lastVault: vault }))
  }
  const app = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=zh-CN', DESK], cwd: DESK,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1' },
  })
  const out = { checks: [], errors: [], shots: [], notes: {} }
  const save = () => fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2))
  const check = (name, ok, got) => { out.checks.push({ name, ok: !!ok, got }); console.log(ok ? 'PASS' : 'FAIL', name, JSON.stringify(got ?? null).slice(0, 300)) }
  try {
    const win = await app.firstWindow()
    const size = async (w, h, page = null) => {
      await app.evaluate(({ BrowserWindow }, s) => {
        const ws = BrowserWindow.getAllWindows()
        const t = s.detached ? ws.find((x) => /window=detached/.test(x.webContents.getURL())) : ws.find((x) => !/window=detached/.test(x.webContents.getURL()))
        t?.setContentSize(s.w, s.h)
      }, { w, h, detached: !!page })
      await sleep(700)
    }
    await size(W, H)
    await win.waitForSelector('#root', { timeout: 40_000 }); await sleep(2500)
    for (const l of ['跳过引导', 'Skip']) { const b = win.locator(`text=${l}`).first(); if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break } }
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    await win.evaluate((ms) => {
      localStorage.setItem('forsion_default_space', 'tangu'); localStorage.setItem('forsion_theme_pref', 'light')
      localStorage.setItem('forsion.dev.humanDeskPauseMs', String(ms))
    }, 600_000)
    await win.reload({ waitUntil: 'domcontentloaded' }); await win.waitForSelector('.dv-groupview', { timeout: 40_000 }); await sleep(2000)
    const openSession = async (page) => {
      for (let i = 0; i < 25; i++) {
        const row = page.locator('.t2s-srow, .t2o-row').filter({ hasText: S.title }).first()
        if (await row.count().catch(() => 0)) { await row.click().catch(() => {}); break }
        await sleep(400)
      }
      await sleep(1500)
    }
    await openSession(win)
    win.setDefaultTimeout(4000)

    const shot = async (name, page = win) => { await page.mouse.move(150, 800).catch(() => {}); await sleep(450); const p = path.join(OUT, `${name}.png`); await page.screenshot({ path: p }); out.shots.push(p) }
    const step = async (name, fn) => {
      if (ONLY.length && !ONLY.includes(name)) return
      try { await fn() } catch (e) { out.errors.push({ step: name, err: String(e && e.stack || e).slice(0, 700) }); console.log('ERROR', name, String(e && e.message || e).slice(0, 300)) }
      save()
    }
    // 一次取全:哪块展开、两张卡、切换件(段 / 点 / 紧凑)、输入框里的引用、编辑器个数
    const st = (page = win) => page.evaluate(() => {
      const q = (s, r = document) => r.querySelector(s)
      const R = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) } }
      const ce = (el) => (el ? el.querySelectorAll('[contenteditable="true"]').length : 0)
      // 原生 Amadeus 编辑器(认领当前页的那种);库外文件的阅读面是 .amx-reading-surface,不算
      const nv = (el) => (el ? el.querySelectorAll('.page-view:not(.amx-reading-surface)').length : 0)
      const hc = q('.human-desk-card'); const ac = q('.agent-desk-card')
      const hb = q('.agent-desk.open .human-desk-body'); const ab = q('.agent-desk.open .agent-desk-body')
      const chips = [...document.querySelectorAll('.composer-anchor .attach-chip')].map((c) => ({ live: c.hasAttribute('data-live'), text: (c.textContent || '').trim() }))
      const sw = q('.agent-desk.open .desk-switch')
      const segs = sw ? [...sw.querySelectorAll('.lcl-vmode-pill > button')] : []
      return {
        side: hb ? 'human' : ab ? 'agent' : null,
        bothBodies: !!q('.human-desk-body') && !!q('.agent-desk-body'),
        hcard: hc ? { gone: hc.classList.contains('gone'), empty: hc.classList.contains('empty'), open: hc.open, rect: R(hc), title: q('.human-desk-card-title', hc)?.textContent || null,
          eye: !!q('.human-desk-eye', hc), where: q('.human-desk-where', hc)?.textContent || null, emptyText: q('.human-desk-card-empty', hc)?.textContent || null,
          plus: !!q('button[title="放到 Human Desk"]', hc), resume: !!q('button[title="继续看"]', hc), editors: ce(hc), drop: hc.hasAttribute('data-drop') } : null,
        acard: ac ? { gone: ac.classList.contains('gone'), open: ac.open, rect: R(ac), editors: ce(ac) } : null,
        hname: hb ? (q('.human-desk-name', hb)?.textContent || '').trim() : null,
        heye: hb ? !!q('.human-desk-name .human-desk-eye', hb) : null,
        hstop: hb ? q('.human-desk-stop', hb)?.getAttribute('title') : null,
        hempty: hb ? (q('.human-desk-empty', hb)?.textContent || null) : null,
        heditors: ce(hb), aeditors: ce(ab),
        editorsInDesk: nv(q('.agent-desk')) + nv(hc) + nv(ac), hnative: nv(hb),
        chips, live: chips.filter((c) => c.live).map((c) => c.text),
        segs: segs.map((b) => ({ label: b.getAttribute('aria-label'), on: b.classList.contains('on'), rect: R(b), spark: !!b.querySelector('.desk-seg-spark'), eye: !!b.querySelector('.desk-seg-eye') })),
        dot: sw ? R(q('.desk-switch-dot', sw)) : null,
        compact: sw ? !!q('.lcl-vmode[data-compact]', sw) : null,
        alabels: [...document.querySelectorAll('.agent-desk.open .agent-desk-body > .agent-desk-pane')].map((p) => p.querySelector('.desk-cap-label')?.textContent || null),
      }
    })
    const send = async (text, page = win) => { const ta = page.locator('.t2c-ta').first(); await ta.click(); await ta.fill(text); await ta.press('Enter'); await sleep(1800) }
    const lastMsg = () => String(stub.seen.runs[stub.seen.runs.length - 1]?.message || '')
    const sendQuiet = async (text) => { stub.script([{ type: 'done', payload: { content: '好的。' }, delay: 100 }]); await send(text); return lastMsg() }
    const closeMenu = async (page = win) => { await page.keyboard.press('Escape'); await sleep(250) }
    const menuClick = async (name, page = win) => { await page.locator('.ctx-menu .ctx-item', { hasText: name }).first().click({ timeout: 2500 }); await sleep(1000) }
    const dump = (page = win) => page.evaluate(() => {
      const R = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), vis: cs.visibility, disp: cs.display, op: cs.opacity } }
      return { desks: [...document.querySelectorAll('.agent-desk')].map((d) => ({ cls: d.className, r: R(d) })), sw: [...document.querySelectorAll('.desk-switch')].map(R),
        you: [...document.querySelectorAll('.desk-switch button[aria-label="你"]')].map(R), hcard: R(document.querySelector('.human-desk-card')), expand: R(document.querySelector('.human-desk-card button[title="展开"]')),
        menus: document.querySelectorAll('.ctx-menu').length, win: [innerWidth, innerHeight] }
    })
    const seg = async (label, page = win) => {
      try { await page.locator(`.agent-desk.open .desk-switch .lcl-vmode-pill > button[aria-label="${label}"]`).first().click() } catch (e) { console.log('DUMP seg', label, JSON.stringify(await dump(page))); throw e }
      await sleep(900)
    }
    const collapseHere = async (page = win) => { await page.locator('.agent-desk.open button[title="收起为卡片"]').first().click(); await sleep(900) }
    const openHumanCard = async (page = win) => { const s = await st(page); if (!s.hcard?.open) { await page.locator('.human-desk-card > summary').first().click(); await sleep(700) } }
    const expandHuman = async (page = win) => {
      try { await page.locator('.human-desk-card button[title="展开"]').first().click() } catch (e) { console.log('DUMP expand', JSON.stringify(await dump(page))); throw e }
      await sleep(1200)
    }
    const present = async (paths, size, text) => {
      stub.script([
        { type: 'status', payload: { phase: 'llm_call', stage: 'sending', iteration: 0 }, delay: 150 },
        { type: 'desk_present', payload: { views: paths.map((p) => ({ type: 'file', path: p, name: path.basename(p) })), size }, delay: 200 },
        { type: 'done', payload: { content: '' }, delay: 200 },
      ])
      await send(text); await sleep(1200)
    }
    const agentWrites = async (id, file, body, text) => {
      stub.script([
        { type: 'status', payload: { phase: 'llm_call', stage: 'sending', iteration: 0 }, delay: 150 },
        { type: 'tool_call', payload: { id, name: 'write_file', arguments: JSON.stringify({ path: file, content: body }) }, delay: 200 },
        { type: 'tool_result', payload: { id, result: 'ok', isError: false }, delay: 200 },
        { type: 'done', payload: { content: '' }, delay: 200 },
      ])
      fs.writeFileSync(file, body)
      await send(text); await sleep(1600)
    }
    const dragOn = (sel, file, phase, page = win) => page.evaluate(({ sel, file, phase }) => {
      const p = document.querySelector(sel); if (!p) return { missing: true }
      const r = p.getBoundingClientRect()
      const dt = new DataTransfer(); dt.setData('application/x-tangu-paths', JSON.stringify([file]))
      const x = r.left + r.width / 2; const y = r.top + Math.min(r.height / 2, 18)
      const target = document.elementFromPoint(x, y) || p
      const fire = (type) => target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: x, clientY: y }))
      if (phase === 'over') { fire('dragenter'); fire('dragover') } else fire('drop')
      return { drop: p.hasAttribute('data-drop') }
    }, { sel, file, phase })
    const inside = (a, b, pad = 0) => !!a && !!b && a.x >= b.x - pad && a.y >= b.y - pad && a.r <= b.r + pad && a.b <= b.b + pad && a.w > 0 && a.h > 0

    // ══ a:两张卡 ══
    await step('a', async () => {
      await present([F.R, F.T], 'card', '整理成报告放到 Desk 上')
      const s = await st()
      check('a Human Desk 卡在场、在 Agent Desk 卡正上方', s.hcard && !s.hcard.gone && s.acard && !s.acard.gone && s.hcard.rect.b <= s.acard.rect.y + 2, { h: s.hcard?.rect, a: s.acard?.rect })
      check('a 空的 Human Desk 卡缺省收成卡头', s.hcard?.empty && !s.hcard.open, s.hcard)
      check('a 卡头空着时有 ＋', !!s.hcard?.plus, s.hcard)
      await openHumanCard()
      const s2 = await st()
      check('a 点开空卡 = 空态那句', /Agent 会跟着看/.test(s2.hcard?.emptyText || ''), s2.hcard?.emptyText)
      await shot('a-cards-empty')
    })

    // ══ b:＋ → 新建笔记 ══
    await step('b', async () => {
      const before = new Set(fs.readdirSync(vault))
      await win.locator('.human-desk-card button[title="放到 Human Desk"]').first().click(); await sleep(450)
      const items = await win.evaluate(() => [...document.querySelectorAll('.ctx-menu .ctx-item')].map((b) => (b.textContent || '').trim()))
      check('b ＋ 菜单 = 新建笔记 / 选一个文件(没有新建白板)', items.includes('新建笔记') && items.includes('选一个文件') && !items.some((x) => /白板/.test(x)), items)
      await closeMenu()
      await win.locator('.human-desk-card button[title="放到 Human Desk"]').first().click(); await sleep(450)
      await menuClick('新建笔记'); await sleep(1200)
      const added = fs.readdirSync(vault).filter((f) => !before.has(f))
      const s = await st()
      check('b 智库里真多了一篇笔记', added.length === 1 && /\.md$/.test(added[0]), added)
      check('b 放进来 → 右边切到 Human Desk', s.side === 'human' && !s.bothBodies, s.side)
      check('b 真编辑器(原生 Amadeus,可编辑)', s.heditors >= 1, s.heditors)
      check('b 输入框挂上「现场」引用 = 这篇笔记', s.live.length === 1 && added[0] && s.live[0].includes(added[0].replace(/\.md$/, '')), s.chips)
      check('b 名字胶囊带眼睛(在看)', s.heye === true, s.hname)
      out.notes.newNote = added[0]
      await shot('b-new-note')
      // 新建的「未命名」改标题 = 改文件名:Human Desk 跟到新路径,之后打的字落进改了名的那篇(Codex 评审 data-loss 那条)
      const title = win.locator('.human-desk-body textarea.amx-title-input').first()
      if (await title.count()) {
        await title.click(); await win.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await win.keyboard.type('会议记录'); await win.keyboard.press('Enter'); await sleep(2200)
        const sr = await st()
        check('b 改标题 → 文件改名,Human Desk 跟到新名字、引用也跟', fs.existsSync(path.join(vault, '会议记录.md')) && /会议记录/.test(sr.hname || '') && sr.live.some((x) => /会议记录/.test(x)), { files: fs.readdirSync(vault), name: sr.hname, live: sr.live })
        const body = win.locator('.human-desk-body [contenteditable="true"]').last()
        await body.click(); await win.keyboard.type('改名后接着写的一句 RENAMEPROBE42'); await sleep(2500)
        const disk = fs.existsSync(path.join(vault, '会议记录.md')) ? fs.readFileSync(path.join(vault, '会议记录.md'), 'utf8') : ''
        check('b 改名后接着打的字落进改了名的那篇(没丢)', disk.includes('RENAMEPROBE42'), disk.slice(0, 200))
      } else check('b 新笔记有标题框可改名', false, null)
      // ⋯ 里也有 ＋ 那两项;「选一个文件」走系统选择框(台架把主进程的 showOpenDialog 换成直接回 prices.csv)
      await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }) }, F.C)
      await win.locator('.agent-desk.open .human-desk-body button[title="更多"]').first().click(); await sleep(400)
      await menuClick('选一个文件'); await sleep(900)
      const s2 = await st()
      check('b ⋯ →「选一个文件」→ 换成选中的 prices.csv,还在 Human Desk', s2.side === 'human' && /prices\.csv/.test(s2.hname || '') && s2.live.some((x) => x.includes('prices.csv')), { side: s2.side, name: s2.hname, live: s2.live })
    })

    // ══ c:拖文件放进来(卡上 / 展开的 Human Desk 上) ══
    await step('c', async () => {
      await collapseHere()
      check('c 前置:收起后两块都没展开', (await st()).side === null, (await st()).side)
      const over = await dragOn('.human-desk-card', F.T, 'over')
      const s0 = await st()
      check('c 拖到卡上:卡片染色(data-drop)', over.drop && s0.hcard?.drop, over)
      await sleep(200); await shot('c-drop-card-hover')
      await dragOn('.human-desk-card', F.T, 'drop'); await sleep(1200)
      const s1 = await st()
      check('c 松手:Human Desk = notes.txt,右边切到 Human Desk', s1.side === 'human' && /notes\.txt/.test(s1.hname || ''), { side: s1.side, name: s1.hname })
      check('c 不是笔记 → 引用 = 文件名', s1.live.length === 1 && s1.live[0].includes('notes.txt'), s1.live)
      const o2 = await dragOn('.human-desk-pane', F.N, 'over')
      check('c 拖到展开的 Human Desk 上:那块染色', o2.drop, o2)
      await dragOn('.human-desk-pane', F.N, 'drop'); await sleep(1500)
      const s2 = await st()
      check('c 松手:换成 定价调研.md(真编辑器)', /定价调研/.test(s2.hname || '') && s2.heditors >= 1, { name: s2.hname, ed: s2.heditors })
      const marks = await win.evaluate(() => ({ drop: !!document.querySelector('[data-drop]'), deskdrop: !!document.querySelector('.t2-chat-view[data-deskdrop]') }))
      check('c 松手后标记都收了', !marks.drop && !marks.deskdrop, marks)
    })

    // ══ d:展开 / 切换 / 收起 ══
    await step('d', async () => {
      const s0 = await st()
      check('d 切换件两段 = 你 / Agent,Human Desk 展开时「你」亮', s0.segs.length === 2 && s0.segs[0].label === '你' && s0.segs[1].label === 'Agent' && s0.segs[0].on, s0.segs)
      check('d 「Agent」段带 Agent Desk 卡头同一个 ✦', s0.segs[1]?.spark, s0.segs)
      await seg('Agent')
      const s1 = await st()
      check('d 切到 Agent → Agent Desk 展开、Human Desk 收回(只一块)', s1.side === 'agent' && !s1.bothBodies, { side: s1.side, both: s1.bothBodies })
      check('d Agent Desk 展开态左上也有同一个切换件,「Agent」亮', s1.segs.length === 2 && s1.segs[1].on, s1.segs)
      check('d 切走了还在看 → 「你」段带小眼睛', s1.segs[0]?.eye, s1.segs)
      await shot('d-agent-side')
      await seg('你')
      const s2 = await st()
      check('d 切回「你」→ Human Desk', s2.side === 'human' && !s2.bothBodies, s2.side)
      await collapseHere()
      const s3 = await st()
      check('d 收起 → 两块都没展开、两张卡都在', s3.side === null && s3.hcard && !s3.hcard.gone && s3.acard && !s3.acard.gone, { side: s3.side })
      await expandHuman()
      check('d 卡上「展开」→ Human Desk', (await st()).side === 'human', (await st()).side)
    })

    // ══ e:Agent Desk 格 ⋯「我来改」+ ▾ 换回 ══
    await step('e', async () => {
      await seg('Agent')
      const before = (await st()).alabels
      const i = before.findIndex((x) => x === 'pricing-report.md')
      await win.locator('.agent-desk.open .agent-desk-body > .agent-desk-pane').nth(Math.max(0, i)).locator('button[title="更多"]').first().click(); await sleep(400)
      const items = await win.evaluate(() => [...document.querySelectorAll('.ctx-menu .ctx-item')].map((b) => (b.textContent || '').trim()))
      check('e Agent Desk 格 ⋯ 里有「我来改」', items.includes('我来改'), items)
      await menuClick('我来改'); await sleep(800)
      const s = await st()
      check('e 「我来改」→ 右边切到 Human Desk、放的是 pricing-report.md', s.side === 'human' && /pricing-report\.md/.test(s.hname || ''), { side: s.side, name: s.hname })
      await seg('Agent')
      const after = (await st()).alabels
      check('e 是挪不是复制:Agent Desk 上没有 pricing-report.md 了', !after.includes('pricing-report.md') && before.includes('pricing-report.md'), { before, after })
      await seg('你')
      await win.locator('.agent-desk.open .human-desk-name button.desk-cap-pick').first().click(); await sleep(450)
      const rows = await win.evaluate(() => [...document.querySelectorAll('.ctx-menu .ctx-item')].map((b) => (b.textContent || '').trim()))
      check('e ▾ = 最近放过的(含 定价调研.md / notes.txt)', rows.some((x) => /定价调研/.test(x)) && rows.some((x) => /notes\.txt/.test(x)), rows)
      await menuClick('定价调研'); await sleep(1200)
      check('e ▾ 换回 定价调研.md', /定价调研/.test((await st()).hname || ''), (await st()).hname)
    })

    // ══ f:在看 → 引用(第几节);停止;× 引用 ══
    await step('f', async () => {
      const h = win.locator('.human-desk-body h2', { hasText: '明细' }).first()
      await h.scrollIntoViewIfNeeded().catch(() => {}); await h.click(); await win.keyboard.press('End'); await sleep(900)
      const s = await st()
      check('f 光标进「3. 明细」→ 引用写「第 3 节」', s.live.length === 1 && /定价调研/.test(s.live[0]) && /第 3 节/.test(s.live[0]), s.live)
      await shot('f-section-chip')
      const msg = await sendQuiet('帮我看看这节的数字对不对')
      check('f 发出去的消息里真带着这篇笔记', /定价调研/.test(msg), msg.slice(0, 200))
      const s1 = await st()
      check('f 发完引用还在(在看 = 一直挂着)', s1.live.length === 1, s1.live)
      await win.locator('.human-desk-body .human-desk-stop[title="停止"]').first().click(); await sleep(700)
      const s2 = await st()
      check('f 停止 → 引用撤掉、眼睛灭、按钮变「继续看」', s2.live.length === 0 && !s2.heye && s2.hstop === '继续看', { live: s2.live, eye: s2.heye, stop: s2.hstop })
      const msg2 = await sendQuiet('先不用管那篇')
      check('f 停止后发出去的消息里不带它', !/定价调研/.test(msg2), msg2.slice(0, 200))
      await win.locator('.human-desk-body .human-desk-stop[title="继续看"]').first().click(); await sleep(700)
      check('f 继续看 → 引用回来', (await st()).live.length === 1, (await st()).live)
      // 引用上的 × = 停止(眼睛与引用保持一致)
      const chip = win.locator('.composer-anchor .attach-chip[data-live]').first()
      await chip.hover(); await sleep(200)
      await chip.locator('button').last().click(); await sleep(700)
      const s3 = await st()
      check('f 点引用上的 × = 停止', s3.live.length === 0 && s3.hstop === '继续看', { live: s3.live, stop: s3.hstop })
      await win.locator('.human-desk-body .human-desk-stop[title="继续看"]').first().click(); await sleep(700)
      await collapseHere()
      const s4 = await st()
      check('f 收起后卡片写「你在第 3 节 · 明细」', /你在第 3 节 · 明细/.test(s4.hcard?.where || ''), s4.hcard?.where)
      await shot('f-card-where')
      await expandHuman()
    })

    // ══ g:离开满时长自动暂停 ══
    await step('g', async () => {
      await win.evaluate((ms) => localStorage.setItem('forsion.dev.humanDeskPauseMs', String(ms)), PAUSE_MS)
      await seg('Agent'); await sleep(PAUSE_MS / 3)
      await seg('你')
      await sleep(PAUSE_MS)
      check('g 切走又很快回来 → 不暂停', (await st()).live.length === 1, (await st()).live)
      await seg('Agent')
      check('g 刚切到 Agent:还在看(引用还在)', (await st()).live.length === 1, (await st()).live)
      await sleep(PAUSE_MS + 900)
      const s1 = await st()
      check('g 切到 Agent 满时长 → 自动暂停:引用撤、「你」段眼睛灭', s1.live.length === 0 && !s1.segs[0]?.eye, { live: s1.live, segs: s1.segs })
      const msg = await sendQuiet('报告怎么样了')
      check('g 暂停时发出去的消息不带它', !/定价调研/.test(msg), msg.slice(0, 200))
      await seg('你')
      check('g 回来(展开 Human Desk)→ 接着看', (await st()).live.length === 1 && (await st()).heye, (await st()).live)
      await collapseHere(); await sleep(PAUSE_MS + 900)
      const s2 = await st()
      check('g 收起满时长 → 也暂停;卡上眼睛灭、给「继续看」', s2.live.length === 0 && !s2.hcard?.eye && s2.hcard?.resume, { live: s2.live, card: s2.hcard })
      await expandHuman()
      check('g 展开回来 → 接着看', (await st()).live.length === 1, (await st()).live)
      await win.evaluate(() => localStorage.setItem('forsion.dev.humanDeskPauseMs', '600000'))
    })

    // ══ h:Agent 不抢 ══
    await step('h', async () => {
      const h = win.locator('.human-desk-body h2', { hasText: '结论' }).first()
      await h.scrollIntoViewIfNeeded().catch(() => {}); await h.click(); await sleep(600)
      const s0 = await st()
      await present([F.C], 'wide', '把价格表摆出来给我看')
      const s1 = await st()
      check('h desk_present wide:右边仍是 Human Desk、东西没换', s1.side === 'human' && s1.hname === s0.hname, { side: s1.side, name: s1.hname })
      check('h 只在「Agent」段亮点,点在那一段里', !!s1.dot && inside(s1.dot, s1.segs[1]?.rect, 1), { dot: s1.dot, seg: s1.segs[1]?.rect })
      check('h 编辑器没被换掉(还在这一节,引用照旧)', s1.heditors >= 1 && /第 2 节/.test(s1.live[0] || ''), { ed: s1.heditors, live: s1.live })
      check('h 一扇窗里原生编辑器只一处(在 Human Desk 上)', s1.editorsInDesk === 1 && s1.hnative === 1, { all: s1.editorsInDesk, human: s1.hnative })
      await shot('h-agent-dot')
      await agentWrites('t-draft', F.D, '# 草稿\n\n第一版。\n', '再起个草稿')
      const s2 = await st()
      check('h Agent 写文件自动上台:右边仍是 Human Desk', s2.side === 'human' && s2.hname === s0.hname && !!s2.dot, { side: s2.side, dot: !!s2.dot })
      await seg('Agent')
      const s3 = await st()
      check('h 切过去:Agent Desk 上有 prices.csv / draft.md,点灭', s3.side === 'agent' && s3.alabels.some((x) => /prices\.csv|draft\.md/.test(x || '')) && !s3.dot, { labels: s3.alabels, dot: s3.dot })
      await seg('你'); await sleep(600)
      const s4 = await st()
      check('h 切回来点不再亮', !s4.dot, s4.dot)
      check('h 切走又切回:还是第 2 节(编辑器重挂不把你挪到顶上那一节)', /第 2 节/.test(s4.live[0] || ''), s4.live)
    })

    // ══ i:两张卡都想开但放不下 ══
    await step('i', async () => {
      await collapseHere()
      await size(W, 760); await sleep(600)
      // 两张都点开(Agent 后碰)
      const open = async (sel) => { const o = await win.evaluate((s) => document.querySelector(s)?.open, sel); if (!o) { await win.locator(`${sel} > summary`).first().click(); await sleep(900) } }
      await open('.human-desk-card'); await open('.agent-desk-card')
      const s1 = await st()
      check('i 放不下:最近碰的 Agent Desk 卡开着,Human Desk 卡收成卡头', s1.acard?.open && !s1.hcard?.open, { h: s1.hcard?.open, a: s1.acard?.open, hr: s1.hcard?.rect, ar: s1.acard?.rect })
      await shot('i-squeezed')
      // 点卡头「Human Desk」那几个字(卡头中间是名字 ▾,点它是开「最近放过的」菜单,不是开合)
      await win.locator('.human-desk-card .human-desk-card-name').first().click(); await sleep(1000)
      const s2 = await st()
      check('i 点 Human Desk 卡头 → 互换', s2.hcard?.open && !s2.acard?.open, { h: s2.hcard?.open, a: s2.acard?.open })
      check('i 卡片态原生编辑器只一处', s2.editorsInDesk <= 1, s2.editorsInDesk)
      await win.locator('.agent-desk-card .agent-desk-card-title, .agent-desk-card .t2-card-title').first().click(); await sleep(1000)
      const s2b = await st()
      check('i 再点 Agent Desk 卡头 → 换回来', !s2b.hcard?.open && s2b.acard?.open, { h: s2b.hcard?.open, a: s2b.acard?.open })
      // 放得下 → 两张都开:窗口拉到屏幕放得下的最高;屏幕太矮就只记下来,不判
      const work = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workAreaSize)
      const tall = Math.min(work.height - 40, 1400)
      await size(W, tall); await sleep(900)
      const room = await win.evaluate(() => {
        const t = document.querySelector('.t2-tsum'); const h = document.querySelector('.human-desk-card'); const a = document.querySelector('.agent-desk-card')
        return { stack: t ? t.clientHeight : 0, cards: [...(t?.children || [])].filter((c) => c !== h && c !== a).reduce((n, c) => n + c.getBoundingClientRect().height + 10, 0) }
      })
      const need = room.cards + 440 + 440 // 两张开着各约 430(上面量到的)+ 间距
      const s3 = await st()
      out.notes.bothOpen = { work, tall, room, need }
      if (room.stack >= need) check('i 窗口放得下了 → 两张都开', s3.hcard?.open && s3.acard?.open, { h: s3.hcard?.open, a: s3.acard?.open, room })
      else console.log('NOTE i 屏幕不够高,两张都开那半没法量', JSON.stringify(out.notes.bothOpen))
      check('i 卡片态原生编辑器只一处(拉高后)', s3.editorsInDesk <= 1, s3.editorsInDesk)
      await shot('i-tall')
      await size(W, H); await sleep(800)
    })

    // ══ j:窄(窗口窄到 Desk 整块藏起之前的几档 + 拖 Desk 左缘到最窄 25%,同 r3 的窄图) ══
    await step('j', async () => {
      const rows = []
      const measure = async (tag) => {
        for (const side of ['你', 'Agent']) {
          if ((await st()).side === null) await expandHuman()
          await seg(side); await sleep(300)
          const r = await win.evaluate(() => {
            const R = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom } }
            const pane = document.querySelector('.agent-desk.open .human-desk-pane') || document.querySelector('.agent-desk.open .agent-desk-body > .agent-desk-pane')
            const caps = pane?.querySelector('.desk-caps')
            return { pane: R(pane), caps: caps ? Math.round(caps.getBoundingClientRect().width) : null, more: R(pane?.querySelector('button[title="更多"]')), collapse: R(document.querySelector('.agent-desk.open button[title="收起为卡片"]')),
              compact: !!document.querySelector('.agent-desk.open .desk-switch .lcl-vmode[data-compact]'), desk: Math.round(document.querySelector('.agent-desk.open')?.getBoundingClientRect().width || 0) }
          })
          const ok = inside(r.more, r.pane, 0.5) && inside(r.collapse, r.pane, 0.5)
          const geo = ok ? undefined : await win.evaluate(() => [...document.querySelectorAll('.agent-desk.open .desk-caps .desk-cap, .agent-desk.open .desk-caps-left')].map((el) => { const b = el.getBoundingClientRect(); return `${el.className}:${Math.round(b.x)}+${Math.round(b.width)}` }))
          rows.push({ tag, side, desk: r.desk, caps: r.caps, compact: r.compact, ok, ...(geo ? { geo, pane: r.pane, more: r.more, collapse: r.collapse } : {}) })
        }
      }
      if ((await st()).side === null) await expandHuman()
      for (const w of [1512, 1320, 1180]) { await size(w, H); await measure(`window ${w}`) }
      await size(W, H)
      const grip = async (frac) => {
        if ((await st()).side === null) await expandHuman()
        const g = await win.locator('.agent-desk.open .agent-desk-grip').boundingBox()
        const host = await win.evaluate(() => { const r = document.querySelector('.agent-desk.open').parentElement.getBoundingClientRect(); return { right: r.right, width: r.width } })
        const x = host.right - frac * host.width
        await win.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await sleep(100)
        await win.mouse.down(); await win.mouse.move((g.x + x) / 2, g.y + g.height / 2, { steps: 4 }); await win.mouse.move(x, g.y + g.height / 2, { steps: 6 }); await win.mouse.up(); await sleep(500)
      }
      for (const f of [0.4, 0.34, 0.25]) { await grip(f); await measure(`desk ${Math.round(f * 100)}%`) }
      out.notes.narrow = rows
      check('j 各宽度、两块:⋯ 和收起都在格内', rows.every((x) => x.ok), rows.filter((x) => !x.ok))
      check('j 胶囊条 < 420 → 切换件只留图标;≥ 420 → 带字', rows.every((x) => x.caps == null || x.compact === (x.caps < 420)), rows.map((x) => [x.tag, x.side, x.caps, x.compact]))
      check('j 紧凑阈值上下两档都量到了', rows.some((x) => x.compact) && rows.some((x) => !x.compact), rows.map((x) => x.compact))
      await seg('你')
      await shot('j-narrow-human')
      await seg('Agent'); await shot('j-narrow-agent'); await seg('你')
      await grip(0.46)
    })

    // ══ shots:亮 / 暗 ══
    await step('shots', async () => {
      if ((await st()).side !== 'human') await expandHuman()
      await shot('light-human-open')
      await collapseHere(); await shot('light-cards')
      await win.evaluate(() => { localStorage.setItem('forsion_theme_pref', 'dark') })
      await win.reload({ waitUntil: 'domcontentloaded' }); await win.waitForSelector('.dv-groupview', { timeout: 40_000 }); await sleep(2500)
      await openSession(win)
      const s = await st()
      check('shots 重载后 Human Desk 上还是那样东西(快照),收着、算暂停', /定价调研/.test(s.hcard?.title || '') && s.side === null && s.live.length === 0, { title: s.hcard?.title, side: s.side, live: s.live })
      await shot('dark-cards')
      await expandHuman()
      check('shots 重载后展开 → 接着看', (await st()).live.length === 1, (await st()).live)
      await shot('dark-human-open')
      await win.evaluate(() => { localStorage.setItem('forsion_theme_pref', 'light') })
      await win.reload({ waitUntil: 'domcontentloaded' }); await win.waitForSelector('.dv-groupview', { timeout: 40_000 }); await sleep(2500)
      await openSession(win)
    })

    // ══ k:两扇窗 ══
    await step('k', async () => {
      if ((await st()).side !== 'human') await expandHuman()
      const tab = await win.evaluate((title) => {
        const t = [...document.querySelectorAll('.wb-tab')].find((x) => (x.querySelector('.wb-tab-name')?.textContent || '').includes(title))
        if (!t) return null
        const b = t.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
      }, S.title)
      if (!tab) throw new Error('chat tab not found')
      await win.mouse.click(tab.x, tab.y, { button: 'right' }); await sleep(500)
      const acts = await win.evaluate(() => [...document.querySelectorAll('button[data-act]')].map((b) => b.dataset.act))
      const act = acts.includes('open-window') ? 'open-window' : 'move-window'
      const [w2] = await Promise.all([app.waitForEvent('window', { timeout: 20_000 }), win.click(`button[data-act="${act}"]`)])
      await w2.waitForSelector('#root', { timeout: 30_000 }); await sleep(4000)
      w2.setDefaultTimeout(4000)
      await size(1300, 850, w2)
      const a = await st(w2)
      check('k 独立窗:Human Desk 卡上是同一样东西', /定价调研/.test(a.hcard?.title || ''), a.hcard?.title)
      check('k 独立窗没守着 → 不挂引用', a.live.length === 0, a.live)
      // 主窗 ▾ 换成 notes.txt → 独立窗跟着
      await win.locator('.agent-desk.open .human-desk-name button.desk-cap-pick').first().click(); await sleep(450)
      await menuClick('notes.txt'); await sleep(1200)
      const b = await st(w2)
      check('k 主窗换成 notes.txt → 独立窗的卡跟着', /notes\.txt/.test(b.hcard?.title || ''), b.hcard?.title)
      check('k 独立窗仍不挂引用(只在守着的那扇窗里在看)', b.live.length === 0, b.live)
      // 独立窗展开 Agent Desk → 主窗不被换掉
      await w2.locator('.agent-desk-card button[title="展开"]').first().click(); await sleep(1500)
      const m = await st(); const s2 = await st(w2)
      check('k 独立窗展开 Agent Desk → 主窗仍是 Human Desk', s2.side === 'agent' && m.side === 'human' && !m.bothBodies, { main: m.side, w2: s2.side })
      check('k 主窗照旧在看', m.live.length === 1 && /notes\.txt/.test(m.live[0]), m.live)
      // 独立窗「停止」→ 主窗跟着停(停止是跨窗的)
      await w2.locator('.human-desk-card > summary').first().click().catch(() => {}); await sleep(500)
      const stopBtn = w2.locator('.human-desk-card button[title="停止"]').first()
      if (await stopBtn.count()) {
        await stopBtn.click(); await sleep(1000)
        check('k 独立窗点停止 → 主窗也停', (await st()).live.length === 0 && (await st()).hstop === '继续看', (await st()).live)
        await win.locator('.human-desk-body .human-desk-stop[title="继续看"]').first().click(); await sleep(600)
      } else {
        check('k 独立窗卡上有「停止」(没守着时按钮是「继续看」也算)', await w2.locator('.human-desk-card button[title="继续看"]').count() > 0, null)
      }
      await shot('k-detached', w2)
      await w2.close().catch(() => {}); await sleep(800)
    })

    // ══ s:desk_screenshot 调查(只记事实) ══
    await step('s', async () => {
      if ((await st()).side !== 'human') await expandHuman()
      const shootOnce = async (id) => {
        stub.script([
          { type: 'status', payload: { phase: 'llm_call', stage: 'sending', iteration: 0 }, delay: 150 },
          { type: 'desk_capture_request', payload: { shotId: id }, delay: 200 },
          { type: 'done', payload: { content: '' }, delay: 2500 },
        ])
        await send('看看 Desk 上现在是什么'); await sleep(2500)
        const c = captures.find((x) => x.shotId === id)
        const dom = await win.evaluate(() => {
          const card = document.querySelector('.agent-desk-card:not(.gone) .agent-desk-card-body')
          const b = card?.getBoundingClientRect()
          return { openBody: !!document.querySelector('.agent-desk.open .agent-desk-body'), cardBody: b ? { w: Math.round(b.width), h: Math.round(b.height) } : null,
            railOff: !!document.querySelector('.t2-rail[data-off]'), chatCol: Math.round(document.querySelector('.t2-chat-col')?.getBoundingClientRect().width || 0) }
        })
        return { capture: c || null, ...dom }
      }
      // ① 缺省宽度(Desk 46%):聊天栏 < 760,摘要栏整列藏起(今天展开任一块 Desk 都这样)
      const wide = await shootOnce('shot-default')
      // ② Desk 拖到最窄 25%:聊天栏够宽,摘要栏回来,Agent Desk 卡在栏里(打开它)
      const g = await win.locator('.agent-desk.open .agent-desk-grip').boundingBox()
      const host = await win.evaluate(() => { const r = document.querySelector('.agent-desk.open').parentElement.getBoundingClientRect(); return { right: r.right, width: r.width } })
      await win.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await win.mouse.down(); await win.mouse.move(host.right - 0.25 * host.width, g.y + g.height / 2, { steps: 8 }); await win.mouse.up(); await sleep(800)
      if (!(await win.evaluate(() => document.querySelector('.agent-desk-card')?.open))) { await win.locator('.agent-desk-card .t2-card-title').first().click().catch(() => {}); await sleep(900) }
      const cardVisible = await shootOnce('shot-card')
      // ③ 窗口窄到 Desk 整块藏起
      await size(1000, H)
      const narrow = await shootOnce('shot-narrow')
      await size(W, H)
      out.notes.screenshot = { wide, cardVisible, narrow }
      console.log('NOTE desk_screenshot with Human Desk expanded:', JSON.stringify(out.notes.screenshot))
      check('s 截图请求都有回执(不让引擎干等)', !!wide.capture && !!cardVisible.capture && !!narrow.capture, out.notes.screenshot)
      check('s Human Desk 展开时右边那块从不被截(截的只可能是 Agent Desk 卡)', [wide, cardVisible, narrow].every((x) => !x.capture || x.capture.mode !== 'open'), out.notes.screenshot)
    })
  } finally {
    save()
    await app.close().catch(() => {}); stub.close(); fs.rmSync(home, { recursive: true, force: true })
  }
  const failed = out.checks.filter((c) => !c.ok)
  console.log(`checks: ${out.checks.length - failed.length}/${out.checks.length} passed; errors: ${out.errors.length}; shots → ${OUT}`)
  process.exit(failed.length || out.errors.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
