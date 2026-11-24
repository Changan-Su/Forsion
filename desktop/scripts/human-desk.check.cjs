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
 *   —— 第 1 步后半(11-24,标签栏互通:Human Desk 是拿走,卡留着指向主区那个标签)——
 *   m  ⋯ 四项(同 Agent Desk)= 拿到主区:卡写「在主区」、引用照旧、主区标签里算第几节;展开 = 占位,「放到 Human Desk」放回来、标签关掉
 *   n  名字胶囊拖到标签栏 = 拿走;标签看不见满时长 → 暂停;卡上「转到标签页」回去 → 接着看
 *   o  主区标签右键第一项「放到 Human Desk」:放回来、标签关掉;对话标签没有这一项
 *   p  把标签拖到 Human Desk 卡 / 展开的那块上:拆分提示让位(对照:拖到正文照常有)、现成淡染;换上它、旧的进最近、标签关掉;Agent Desk 不接
 *   r  向右拆分(对话窄过 760、摘要栏藏起):卡挪到主区对话顶上;标签右键放回
 *   q  Amadeus(对话在右栏、这扇窗里没有它的 Desk):标签右键 = 就地认领(标签留着、卡在右栏对话顶上);切 Space 不算关;关掉标签 = 拿掉
 *   m / o / p 各带一个「数据不丢」探针:打完字紧接着拿走 / 放回 / 换掉,读盘
 *   tabshots 亮 / 暗:在主区的卡、占位、标签右键、标签拖上来、窄对话顶上的卡、Amadeus 右栏的卡
 *   s  desk_screenshot 调查:Human Desk 展开时截到的是哪块(宽 / 窄窗各一次),只记事实不判
 *   v  Agent 给成笔记编辑器的 .db / 白板(#848 同口径):「我来改」挪到 Human Desk、Human Desk ⋯「在新标签页打开」都不进笔记编辑器,字节不变
 *   shots 亮 / 暗各一张展开态 + 卡片态,与 r3 对照
 *
 * 跑(必须经 devlock):node <仓根>/.claude/hooks/devlock.cjs run --vehicle=e2e --what="Human Desk" --eta=8 -- npm run check:humandesk
 * 先 npm run build。截图与 result.json 写到 OUT(缺省系统临时目录下 human-desk-check/),不入库。
 */
const fs = require('fs'); const os = require('os'); const path = require('path')
const DESK = path.join(__dirname, '..')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { enterSpace } = require('./lib/uiux-electron.cjs')
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
  // v 段:库里「不是笔记」的两份(Agent 会把它们给成笔记编辑器),同 check:deskmanual l 段的夹具
  const V = { db: path.join(vault, '数据', '任务.db'), board: path.join(vault, 'boards', '草图.excalidraw.md') }
  for (const p of Object.values(V)) fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(V.db, JSON.stringify({ version: 1, name: '任务', columns: [{ id: 'title', name: '标题', type: 'text' }], rows: [{ id: 'r1', cells: { title: '补 Gamma 阶梯价' } }], views: [] }))
  fs.writeFileSync(V.board, ['---', 'excalidraw-plugin: parsed', '---', '', '## Drawing', '```json',
    JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {} }), '```', '%%'].join('\n'))
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
    out.notes.pageErrors = []
    win.on('pageerror', (e) => out.notes.pageErrors.push(String(e && e.stack || e).slice(0, 600)))
    win.on('console', (m) => { if (m.type() === 'error') out.notes.pageErrors.push(`console: ${m.text().slice(0, 400)}`) })
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
          plus: !!q('button[title="放到 Human Desk"]', hc), resume: !!q('button[title="继续看"]', hc), editors: ce(hc), drop: hc.hasAttribute('data-drop'),
          out: hc.classList.contains('out'), inmain: q('.human-desk-inmain', hc)?.textContent || null, goTab: !!q('button[title="转到标签页"]', hc),
          titleW: Math.round(q('.human-desk-card-title', hc)?.getBoundingClientRect().width || 0), nameShown: !!q('.t2-card-title > .human-desk-card-name', hc)?.getClientRects().length } : null,
        hinmain: hb ? (q('.human-desk-name .human-desk-inmain', hb)?.textContent || null) : null,
        houtpane: hb ? (q('.human-desk-outpane', hb)?.textContent || null) : null,
        hside: (() => { const e = [...document.querySelectorAll('.human-desk-side')].find((x) => x.getClientRects().length); return e ? { text: (e.textContent || '').trim(), rect: R(e), titleW: Math.round(q('.human-desk-card-title', e)?.getBoundingClientRect().width || 0) } : null })(),
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
    // ── 第 1 步后半(拿到主区 / 放回来)用的 ──
    // 主区各组:前台标签(类型 + 名字)、组里所有标签;对话标签名是会话标题「竞品定价调研」,按名字找笔记标签时要排掉 chat
    const groups = (page = win) => page.evaluate(() => [...document.querySelectorAll('.dv-groupview')].map((g) => {
      const r = g.getBoundingClientRect(); const a = g.querySelector('.dv-tab.dv-active-tab .wb-tab')
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), frontType: a?.getAttribute('data-view-type') || null,
        frontName: (a?.querySelector('.wb-tab-name')?.textContent || '').trim(), tabs: [...g.querySelectorAll('.wb-tab')].map((t) => `${t.getAttribute('data-view-type')}:${(t.querySelector('.wb-tab-name')?.textContent || '').trim()}`) }
    }).filter((g) => g.w > 0))
    const fileTabs = (name, page = win) => page.evaluate((name) => [...document.querySelectorAll('.wb-tab')].filter((t) => t.getAttribute('data-view-type') !== 'chat' && (t.querySelector('.wb-tab-name')?.textContent || '').includes(name)).length, name)
    const tabByName = (name, page = win) => page.locator('.wb-tab:not([data-view-type="chat"])').filter({ has: page.locator('.wb-tab-name', { hasText: name }) }).first()
    const humanMore = async (name) => { await win.locator('.agent-desk.open .human-desk-body button[title="更多"]').first().click(); await sleep(400); if (name) await menuClick(name) }
    const menuItems = () => win.evaluate(() => [...document.querySelectorAll('.ctx-menu .ctx-item')].map((b) => (b.textContent || '').trim()))
    // 标签右键菜单只认 window 的 click 收起(Escape 不收、右键另一个标签也不收 —— LCL 原有行为):先点一下 body 收掉旧的,只读最后一个菜单
    const closeTabMenus = async () => { await win.evaluate(() => document.body.click()); await sleep(250) }
    const tabMenuActs = () => win.evaluate(() => { const ms = document.querySelectorAll('.ctx-menu'); const m = ms[ms.length - 1]; return m ? [...m.querySelectorAll('button[data-act]')].map((b) => ({ act: b.dataset.act, text: (b.textContent || '').trim() })) : [] })
    // 按坐标点标签(Playwright 的稳定性等待在标签上偶尔等不到:标签栏里有补间)
    const tabAt = (name) => win.evaluate((name) => {
      const t = [...document.querySelectorAll('.wb-tab')].find((x) => x.getAttribute('data-view-type') !== 'chat' && (x.querySelector('.wb-tab-name')?.textContent || '').includes(name) && x.getClientRects().length)
      if (!t) return null
      const b = t.getBoundingClientRect(); return { x: b.x + Math.min(b.width / 2, 40), y: b.y + b.height / 2 }
    }, name)
    const clickTab = async (name, button = 'left') => { await closeTabMenus(); const p = await tabAt(name); if (!p) throw new Error(`tab ${name} not found`); await win.mouse.click(p.x, p.y, { button }); await sleep(button === 'left' ? 600 : 400) }
    const tabMenu = async (loc) => { await closeTabMenus(); if (typeof loc === 'string') await clickTab(loc, 'right'); else { await loc.click({ button: 'right' }); await sleep(400) } }
    // 数据不丢的探针:在某个编辑器末尾打一串记号,紧接着做动作(不等存盘),之后读盘 / 读界面
    // dockview 的 always 渲染把面板内容放在组外的浮层里:按 .wb-view[data-leaf-id] 找,不能挂在 .dv-groupview 下
    const tabEditor = () => win.locator('.wb-view[data-leaf-id]:not(:has(.t2-chat-view)) [contenteditable="true"]:visible').last()
    const typeProbe = async (loc, mark) => { await loc.click(); await win.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'); await win.keyboard.press('End'); await win.keyboard.type(` ${mark}`); await sleep(150) }
    const onDisk = (file, mark) => fs.readFileSync(file, 'utf8').includes(mark)
    const shownIn = (sel, mark) => win.evaluate(({ sel, mark }) => [...document.querySelectorAll(sel)].some((e) => (e.textContent || '').includes(mark)), { sel, mark })
    // Amadeus 右栏那份对话(窗右半里看得见的 .t2-chat-view):顶上的卡、正文、输入框里的「现场」引用
    const rightChat = () => win.evaluate(() => {
      const cv = [...document.querySelectorAll('.t2-chat-view')].find((x) => x.getClientRects().length && x.getBoundingClientRect().x > innerWidth / 2)
      if (!cv) return null
      const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }
      const side = cv.querySelector('.human-desk-side')
      return { chat: r(cv), stream: r(cv.querySelector('.t2-stream')),
        side: side && side.getClientRects().length ? { ...r(side), text: (side.textContent || '').trim(), titleW: Math.round(side.querySelector('.human-desk-card-title')?.getBoundingClientRect().width || 0), eye: !!side.querySelector('.human-desk-eye') } : null,
        live: [...cv.querySelectorAll('.composer-anchor .attach-chip[data-live]')].map((c) => (c.textContent || '').trim()) }
    })
    // 进 Amadeus、右栏对话开着,在右栏发一句(空白新对话 → 建一条会话;Human Desk 的门:有过消息)
    const intoAmadeus = async () => {
      await enterSpace(win, 'amadeus'); await sleep(2500)
      if (!(await rightChat())) { await win.click('.dv-edge-right', { timeout: 10_000 }).catch(() => {}); await sleep(1500) }
      stub.script([{ type: 'done', payload: { content: '好的。' }, delay: 100 }])
      const ta = win.locator('.t2-chat-view:visible .t2c-ta').last()
      await ta.click(); await ta.fill('在笔记旁边聊两句'); await ta.press('Enter'); await sleep(2500)
    }
    // 左栏树里点一篇笔记(Amadeus):按叶子文字找、只认窗左三分之一里看得见的
    const openFromTree = async (name) => {
      const p = await win.evaluate((name) => {
        const own = (e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim()
        const el = [...document.querySelectorAll('body *')].find((e) => (own(e) === name || own(e) === `${name}.md`) && e.getClientRects().length && e.getBoundingClientRect().x < innerWidth / 3 && !e.closest('.wb-tab'))
        if (!el) return { miss: [...document.querySelectorAll('body *')].filter((e) => e.getClientRects().length && e.getBoundingClientRect().x < innerWidth / 3 && own(e)).map(own).slice(0, 40) }
        const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
      }, name)
      if (!p || p.miss) throw new Error(`tree row ${name} not found: ${JSON.stringify(p?.miss)}`)
      await win.mouse.click(p.x, p.y); await sleep(1800)
    }
    const setPause = (ms) => win.evaluate((ms) => localStorage.setItem('forsion.dev.humanDeskPauseMs', String(ms)), ms)
    // Human Desk 放上一样东西、展开(收起 → 拖文件到卡上;在主区的那样也一起换掉)
    const ensureOn = async (file) => { if ((await st()).side !== null) await collapseHere(); await dragOn('.human-desk-card', file, 'drop'); await sleep(1500) }
    // 合成拖拽(全程同一个 DataTransfer,挂在 window.__hd):起拖 → 经过 → 读落点提示;再一次调用松手或取消。
    // from = 'cap'(展开的 Human Desk 名字胶囊)或 { tab: 名字 }(主区标签);to = 'chatTab'(对话标签右缘 = 标签栏)/ 'body'(对话正文)/ CSS 选择器
    const dragStart = (from, to, page = win) => page.evaluate(async ({ from, to }) => {
      const src = from === 'cap' ? document.querySelector('.agent-desk.open .human-desk-name .desk-cap-pick')
        : [...document.querySelectorAll('.wb-tab')].find((t) => t.getAttribute('data-view-type') !== 'chat' && (t.querySelector('.wb-tab-name')?.textContent || '').includes(from.tab))
      if (!src) return { err: 'no source' }
      const dt = new DataTransfer()
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }))
      let x = 0, y = 0
      if (to === 'chatTab') { const r = document.querySelector('.wb-tab[data-view-type="chat"]').getBoundingClientRect(); x = r.right - 4; y = r.top + r.height / 2 }
      else if (to === 'body') { const r = document.querySelector('.t2-stream').getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height * 0.35 }
      else { const e = document.querySelector(to); if (!e) return { err: 'no target' }; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + Math.min(r.height / 2, 60) }
      const t = document.elementFromPoint(x, y)
      if (!t) { src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, composed: true, dataTransfer: dt })); return { err: 'nothing at point', x, y, vp: [innerWidth, innerHeight] } }
      const fire = (type, el) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: x, clientY: y }))
      fire('dragenter', t); fire('dragover', t)
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      window.__hd = { dt, src, t, x, y }
      const vis = (sel) => { const e = document.querySelector(sel); return !!e && getComputedStyle(e).display !== 'none' }
      const tgt = typeof to === 'string' && !['chatTab', 'body'].includes(to) ? document.querySelector(to) : null
      return { line: vis('.wb-drop-line'), zone: vis('.wb-drop-zone'), effect: dt.dropEffect, tint: !!tgt?.hasAttribute('data-drop'), anyTint: !!document.querySelector('[data-drop]') }
    }, { from, to })
    const dragEnd = (drop, page = win) => page.evaluate((drop) => {
      const h = window.__hd; if (!h) return false
      const fire = (type, el) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: h.dt, clientX: h.x, clientY: h.y }))
      if (drop) fire('drop', h.t)
      // 源被关掉(标签放回 Human Desk)时 dragend 到不了 window:改在 document 上补一发,同真拖拽
      fire('dragend', h.src.isConnected ? h.src : document)
      window.__hd = null
      return { tint: !!document.querySelector('[data-drop]'), zone: getComputedStyle(document.querySelector('.wb-drop-zone') || document.body).display !== 'none' && !!document.querySelector('.wb-drop-zone') }
    }, drop)

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

    // ══ m:⋯ 四项 = 拿到主区(拿走,卡留着指向它);主区那个标签里算第几节;展开 = 占位,放回来 ══
    await step('m', async () => {
      await ensureOn(F.N)
      const s0 = await st()
      check('m 前置:Human Desk = 定价调研.md,展开、在看', s0.side === 'human' && /定价调研/.test(s0.hname || '') && s0.live.length === 1, { side: s0.side, name: s0.hname, live: s0.live })
      await humanMore()
      const items = await menuItems()
      const want = ['在新标签页打开', '向右拆分', '向下拆分', '在新窗口中打开']
      const at = want.map((w) => items.indexOf(w))
      check('m ⋯ 四项打开按序都在(同 Agent Desk)', at.every((i, k) => i >= 0 && (k === 0 || i === at[k - 1] + 1)), items)
      check('m 没有「拿到主区」「在主区打开」「在 Amadeus 中打开」', !items.some((x) => /拿到主区|在主区打开|在 Amadeus 中打开/.test(x)), items)
      await shot('m-menu')
      await closeMenu()
      // 数据不丢 ①:在 Human Desk 上打字,紧接着拿到主区(原生编辑器从 Desk 卸下、换到标签里)
      await typeProbe(win.locator('.human-desk-body [contenteditable="true"]').last(), 'TAKEOUTPROBE1')
      // 向下拆分:对话栏不窄过 760,摘要栏(两张卡)还在;窄的那种(向右拆分)见 r
      await humanMore('向下拆分'); await sleep(1500)
      const s1 = await st(); const g1 = await groups()
      const noteG = g1.find((g) => g.frontType !== 'chat' && /定价调研/.test(g.frontName))
      const chatG = g1.find((g) => g.tabs.some((x) => x.startsWith('chat:')))
      check('m 向下拆分 = 拿走:Human Desk 收回,卡留着、卡头写「在主区」', s1.side === null && s1.hcard?.out && /在主区/.test(s1.hcard?.inmain || '') && !s1.hcard?.gone, { side: s1.side, card: s1.hcard })
      check('m 主区多一组、前台是定价调研;对话那组前台仍是对话', !!noteG && chatG?.frontType === 'chat', g1)
      check('m 卡头读作「你 定价调研.md · 在主区」:名字没被挤没(省掉 Human Desk 字样)', s1.hcard?.titleW > 24 && !s1.hcard?.nameShown, { w: s1.hcard?.titleW, nameShown: s1.hcard?.nameShown })
      check('m 摘要栏在场时对话顶上不再出那张卡', !s1.hside, s1.hside)
      check('m 卡头「展开」换成「转到标签页」', s1.hcard?.goTab && !(await win.locator('.human-desk-card button[title="展开"]').count()), s1.hcard)
      check('m 标签在前台 = 还在看:引用照旧挂着、卡上眼睛亮', s1.live.length === 1 && /定价调研/.test(s1.live[0]) && s1.hcard?.eye, { live: s1.live, eye: s1.hcard?.eye })
      check('m 一件事一张卡:Human Desk 卡里不再演它(没有编辑器)', !s1.hcard?.editors && s1.editorsInDesk === 0, { card: s1.hcard?.editors, desk: s1.editorsInDesk })
      // 在主区那个标签里光标进「3. 明细」→ 引用、卡片都跟着
      const h = win.locator('.wb-view[data-leaf-id] .page-view h2', { hasText: '明细' }).first()
      await h.scrollIntoViewIfNeeded().catch(() => {}); await h.click(); await win.keyboard.press('End'); await sleep(1200)
      const s2 = await st()
      check('m 主区标签里光标进第 3 节 → 引用写「第 3 节」', s2.live.length === 1 && /第 3 节/.test(s2.live[0]), s2.live)
      check('m 卡片写「你在第 3 节 · 明细」', /你在第 3 节 · 明细/.test(s2.hcard?.where || ''), s2.hcard?.where)
      await sleep(1200)
      check('m 数据不丢 ①:在 Desk 上刚打的字落了盘、主区标签里也有', onDisk(F.N, 'TAKEOUTPROBE1') && await shownIn('.wb-view[data-leaf-id] .page-view', 'TAKEOUTPROBE1'), { disk: onDisk(F.N, 'TAKEOUTPROBE1') })
      await shot('m-out-split')
      // 展开 Agent Desk 再切「你」:Human Desk 这块是占位(转到标签页 / 放到 Human Desk),不再挂原生编辑器
      await win.locator('.agent-desk-card button[title="展开"]').first().click(); await sleep(1200)
      await seg('你')
      const s3 = await st()
      check('m 东西在主区时展开 Human Desk = 占位那句,胶囊带「在主区」', s3.side === 'human' && /定价调研.*在主区的标签页里/.test(s3.houtpane || '') && /在主区/.test(s3.hinmain || ''), { side: s3.side, pane: s3.houtpane, inmain: s3.hinmain })
      check('m 占位上不挂编辑器(原生编辑器归主区那个标签)', s3.heditors === 0 && s3.hnative === 0, { ed: s3.heditors, native: s3.hnative })
      await humanMore()
      const items2 = await menuItems()
      check('m 在主区时 ⋯ = 转到标签页 + 放 / 拿掉,不再给四项', items2[0] === '转到标签页' && !items2.includes('向右拆分') && items2.includes('从 Human Desk 拿掉'), items2)
      await closeMenu()
      await shot('m-out-placeholder')
      await win.locator('.human-desk-outpane button', { hasText: '放到 Human Desk' }).first().click(); await sleep(1500)
      const s4 = await st()
      check('m 占位上「放到 Human Desk」→ 放回来:主区那个标签关掉、Human Desk 演回真编辑器', s4.side === 'human' && !s4.hinmain && !s4.houtpane && s4.heditors >= 1 && (await fileTabs('定价调研')) === 0, { side: s4.side, inmain: s4.hinmain, ed: s4.heditors, tabs: await groups() })
      check('m 放回来后笔记没丢', fs.readFileSync(F.N, 'utf8').includes('## 3. 明细'), null)
    })

    // ══ n:名字胶囊拖到标签栏 = 拿走;标签看不见满时长 → 暂停;卡上「转到标签页」回去 → 接着看 ══
    await step('n', async () => {
      const s0 = await st()
      if (s0.side !== 'human' || !/定价调研/.test(s0.hname || '') || s0.hinmain) await ensureOn(F.N)
      await setPause(PAUSE_MS)
      const t0 = await fileTabs('定价调研')
      const over = await dragStart('cap', 'chatTab')
      check('n 名字胶囊拖到标签栏:落点线出现、没有半屏高亮', over.line && !over.zone, over)
      await dragEnd(true); await sleep(1600)
      const s1 = await st(); const g1 = await groups()
      const chatG = g1.find((g) => g.tabs.some((x) => x.startsWith('chat:')))
      check('n 松手 = 拿走:对话那组多一个定价调研标签、在前台', (await fileTabs('定价调研')) === t0 + 1 && chatG?.frontType !== 'chat' && /定价调研/.test(chatG?.frontName || ''), { t0, g1 })
      check('n Human Desk 收回、卡写「在主区」', s1.side === null && s1.hcard?.out, { side: s1.side, card: s1.hcard })
      check('n 标签在前台 = 在看(引用还挂着)', s1.live.length === 1, s1.live)
      await shot('n-out-tab')
      await win.locator('.wb-tab[data-view-type="chat"]').first().click(); await sleep(800)
      check('n 切回对话(标签不在前台)、没到时长:还在看', (await st()).live.length === 1, (await st()).live)
      await sleep(PAUSE_MS + 900)
      const s2 = await st()
      check('n 标签看不见满时长 → 自动暂停:引用撤、卡上眼睛灭、给「继续看」', s2.live.length === 0 && !s2.hcard?.eye && s2.hcard?.resume, { live: s2.live, card: s2.hcard })
      const msg = await sendQuiet('先这样')
      check('n 暂停时发出去的消息不带它', !/定价调研/.test(msg), msg.slice(0, 200))
      await shot('n-out-paused')
      await win.locator('.human-desk-card button[title="转到标签页"]').first().click(); await sleep(1000)
      const g2 = await groups(); const chatG2 = g2.find((g) => g.tabs.some((x) => x.startsWith('chat:')))
      check('n 卡上「转到标签页」→ 定价调研标签回到前台', /定价调研/.test(chatG2?.frontName || '') && chatG2?.frontType !== 'chat', g2)
      check('n 回到标签 → 接着看(暂停解除)', (await st()).live.length === 1, (await st()).live)
      await win.locator('.wb-tab[data-view-type="chat"]').first().click(); await sleep(800)
      check('n 再切回对话:引用照旧(刚看过)', (await st()).live.length === 1, (await st()).live)
      await setPause(600_000)
    })

    // ══ o:主区标签右键第一项「放到 Human Desk」:放回来、那个标签关掉;对话标签没有这一项 ══
    await step('o', async () => {
      if (!(await fileTabs('定价调研'))) { await ensureOn(F.N); await humanMore('在新标签页打开'); await sleep(1200); await win.locator('.wb-tab[data-view-type="chat"]').first().click(); await sleep(600) }
      check('o 前置:定价调研在主区标签里、卡写「在主区」', (await fileTabs('定价调研')) >= 1 && (await st()).hcard?.out, await groups())
      await tabMenu(win.locator('.wb-tab[data-view-type="chat"]').first())
      const chatActs = (await tabMenuActs()).map((x) => x.act)
      check('o 对话标签右键:没有「放到 Human Desk」(没有文件的不收)', chatActs.length > 0 && !chatActs.includes('host-human-desk-put'), chatActs)
      // 数据不丢 ②:在主区标签里打字,紧接着放回 Human Desk(标签马上关掉)
      await clickTab('定价调研')
      await typeProbe(tabEditor(), 'PUTBACKPROBE2')
      await tabMenu('定价调研')
      const acts = await tabMenuActs()
      check('o 笔记标签右键:第一项 =「放到 Human Desk」', acts[0]?.act === 'host-human-desk-put' && acts[0]?.text === '放到 Human Desk', acts)
      await shot('o-tab-menu')
      await win.locator('.ctx-menu button[data-act="host-human-desk-put"]').last().click(); await sleep(1500)
      const s = await st()
      check('o 点了 → 主区那个标签关掉', (await fileTabs('定价调研')) === 0, await groups())
      await sleep(1500)
      check('o 数据不丢 ②:标签里刚打的字落了盘、Human Desk 上也有', onDisk(F.N, 'PUTBACKPROBE2') && await shownIn('.human-desk-body', 'PUTBACKPROBE2'), { disk: onDisk(F.N, 'PUTBACKPROBE2') })
      check('o 东西回到 Human Desk(不在主区了)、右边展开、真编辑器、在看', s.side === 'human' && /定价调研/.test(s.hname || '') && !s.hinmain && s.heditors >= 1 && s.live.length === 1, { side: s.side, name: s.hname, inmain: s.hinmain, ed: s.heditors, live: s.live })
    })

    // ══ p:把主区标签拖到 Human Desk 上(展开的那块 / 卡):拆分提示让位、用现成的淡染;换上它、旧的进「最近放过的」、标签关掉;Agent Desk 不接 ══
    await step('p', async () => {
      const s0 = await st()
      if (!/定价调研/.test(s0.hname || '') || s0.hinmain || s0.side !== 'human') await ensureOn(F.N)
      await collapseHere()
      // notes.txt 开在主区下面一组(经 Agent Desk ⋯「向下拆分」,Agent Desk 那格留着)
      await present([F.T], 'card', '把 notes 摆上来')
      await win.locator('.agent-desk-card button[title="展开"]').first().click(); await sleep(1200)
      const ni = (await st()).alabels.findIndex((x) => /notes\.txt/.test(x || ''))
      await win.locator('.agent-desk.open .agent-desk-body > .agent-desk-pane').nth(Math.max(0, ni)).locator('button[title="更多"]').first().click(); await sleep(400)
      await menuClick('向下拆分'); await sleep(1500)
      await collapseHere()
      check('p 前置:notes.txt 在主区标签里;两张卡都收着', (await fileTabs('notes.txt')) >= 1 && (await st()).side === null, { tabs: await groups(), side: (await st()).side })
      // 对照:同一个标签拖到对话正文 → 照常画「拆开」半屏高亮(说明下面「不画」是让位,不是根本没提示)
      const ctl = await dragStart({ tab: 'notes.txt' }, 'body'); await dragEnd(false)
      check('p 对照:标签拖到对话正文 → 有半屏高亮', ctl.zone, ctl)
      const ag = await dragStart({ tab: 'notes.txt' }, '.agent-desk-card'); await dragEnd(false)
      check('p Agent Desk 不接标签:拖到 Agent Desk 卡上不染色', !ag.err && !ag.tint, ag)
      // 展开 Human Desk(定价调研),打一串字,紧接着把 notes.txt 标签拖上来换掉它
      await expandHuman()
      await typeProbe(win.locator('.human-desk-body [contenteditable="true"]').last(), 'SWAPPROBE3')
      const over = await dragStart({ tab: 'notes.txt' }, '.agent-desk.open .human-desk-pane')
      check('p 标签拖到展开的 Human Desk 上:那块染色(现成的 data-drop),拆分提示让位(无半屏高亮 / 落点线)', over.tint && !over.zone && !over.line, over)
      await shot('p-tab-drag-pane')
      const end = await dragEnd(true); await sleep(1500)
      const s1 = await st()
      check('p 松手:Human Desk 换成 notes.txt;那个标签关掉;染色收了', s1.side === 'human' && /notes\.txt/.test(s1.hname || '') && (await fileTabs('notes.txt')) === 0 && !end.tint, { side: s1.side, name: s1.hname, tabs: await groups(), end })
      await sleep(1000)
      check('p 数据不丢 ③:被换下去的那篇刚打的字落了盘', onDisk(F.N, 'SWAPPROBE3'), null)
      await win.locator('.agent-desk.open .human-desk-name button.desk-cap-pick').first().click(); await sleep(450)
      const rows = await menuItems(); await closeMenu()
      check('p 原来那样(定价调研)进「最近放过的」', rows.some((x) => /定价调研/.test(x)), rows)
      // 在主区的那样(notes.txt)的标签拖回收着的卡上 = 放回来
      await humanMore('向下拆分'); await sleep(1500)
      check('p 前置:notes.txt 在主区、卡写「在主区」', (await fileTabs('notes.txt')) === 1 && (await st()).hcard?.out, { tabs: await groups() })
      const over2 = await dragStart({ tab: 'notes.txt' }, '.human-desk-card')
      check('p 标签拖到 Human Desk 卡上:卡染色、无拆分提示', over2.tint && !over2.zone && !over2.line, over2)
      await shot('p-tab-drag-card')
      await dragEnd(true); await sleep(1500)
      const s2 = await st()
      check('p 松手 = 放回来:标签关掉、不再「在主区」、右边展开 notes.txt', s2.side === 'human' && !s2.hinmain && /notes\.txt/.test(s2.hname || '') && (await fileTabs('notes.txt')) === 0, { side: s2.side, inmain: s2.hinmain, name: s2.hname })
    })

    // ══ r:向右拆分(对话窄过 760,摘要栏整列藏起):卡挪到主区对话顶上;标签右键放回 ══
    await step('r', async () => {
      const s0 = await st()
      if (!/定价调研/.test(s0.hname || '') || s0.hinmain || s0.side !== 'human') await ensureOn(F.N)
      await humanMore('向右拆分'); await sleep(1600)
      const s1 = await st(); const g1 = await groups()
      const chatG = g1.find((g) => g.tabs.some((x) => x.startsWith('chat:')))
      check('r 向右拆分 = 拿走;对话那组窄过 760', s1.hcard?.out && !!chatG && chatG.w < 760, { out: s1.hcard?.out, chatW: chatG?.w })
      check('r 摘要栏藏起时卡挪到对话顶上:「你 定价调研.md · 在主区」,名字看得见', !!s1.hside && /定价调研/.test(s1.hside.text) && /在主区/.test(s1.hside.text) && s1.hside.titleW > 24, s1.hside)
      check('r 引用照旧挂着', s1.live.length === 1, s1.live)
      await shot('r-narrow-side')
      await tabMenu('定价调研')
      out.notes.rActs = await tabMenuActs()
      await win.locator('.ctx-menu button[data-act="host-human-desk-put"]').last().click(); await sleep(1500)
      await shot('r-after-put')
      const s2 = await st()
      check('r 标签右键放回:标签关掉、对话顶上那张卡没了、右边展开', (await fileTabs('定价调研')) === 0 && !s2.hside && s2.side === 'human', { side: s2.side, hside: s2.hside, tabs: await groups() })
    })

    // ══ q:Amadeus(对话在右栏,这扇窗里没有它的 Desk):标签右键「放到 Human Desk」= 就地认领 —— 标签留着、记成在主区,
    //     卡在右栏对话顶上(r3 ⑦);切 Space 不算关;真的关掉标签 = 做完了 ══
    await step('q', async () => {
      await intoAmadeus()
      await openFromTree('定价调研')
      const a0 = await rightChat()
      check('q 前置:Amadeus 主区开着定价调研,右栏是对话', (await fileTabs('定价调研')) >= 1 && !!a0, { tabs: await groups(), chat: a0?.chat })
      await tabMenu('定价调研')
      const acts = await tabMenuActs()
      check('q 右栏对话有过消息 → 标签右键第一项也是「放到 Human Desk」', acts[0]?.act === 'host-human-desk-put', acts)
      await win.locator('.ctx-menu button[data-act="host-human-desk-put"]').last().click(); await sleep(1500)
      const a = await rightChat()
      check('q 这扇窗里没有它的 Desk → 就地认领:标签留着', (await fileTabs('定价调研')) >= 1, await groups())
      check('q 右栏对话顶上一张「你 定价调研.md · 在主区」,名字看得见', !!a?.side && /定价调研/.test(a.side.text) && /在主区/.test(a.side.text) && a.side.titleW > 24, a)
      check('q 卡在对话正文上面', !!a?.side && a.side.y <= a.stream.y + 4, a)
      // 右栏 280 宽时输入框把引用收成一颗钮,「现场」那枚不在 DOM 里;在看以卡上的眼睛为准
      check('q 标签在前台 = 在看:右栏那张卡带眼睛', !!a?.side?.eye, a?.side)
      await shot('q-amadeus-side')
      await enterSpace(win, 'tangu'); await sleep(2000); await enterSpace(win, 'amadeus'); await sleep(2500)
      const b = await rightChat()
      check('q 切到 Tangu 再回来:标签还在、卡还在(切 Space 不算关)', (await fileTabs('定价调研')) >= 1 && !!b?.side, { tabs: await groups(), side: b?.side })
      await tabMenu('定价调研')
      await win.locator('.ctx-menu button[data-act="close"]').last().click(); await sleep(1200)
      const c = await rightChat()
      check('q 关掉那个标签 = 做完了:右栏那张卡没了', !c?.side, c)
      await enterSpace(win, 'tangu'); await sleep(2000)
    })

    // ══ tabshots:亮 / 暗 —— 在主区的卡、占位、标签右键、标签拖上来、窄对话顶上的卡、Amadeus 右栏的卡 ══
    await step('tabshots', async () => {
      const putBack = async () => { await tabMenu('定价调研'); await win.locator('.ctx-menu button[data-act="host-human-desk-put"]').last().click(); await sleep(1300) }
      const pass = async (theme) => {
        await ensureOn(F.N); await humanMore('向下拆分'); await sleep(1500); await shot(`${theme}-out-card`)
        await win.locator('.agent-desk-card button[title="展开"]').first().click(); await sleep(1200); await seg('你'); await sleep(300); await shot(`${theme}-out-placeholder`); await collapseHere()
        await tabMenu('定价调研'); await shot(`${theme}-tab-menu`); await closeTabMenus()
        await dragStart({ tab: '定价调研' }, '.human-desk-card'); await shot(`${theme}-tab-drag-hover`); await dragEnd(false)
        await putBack()
        await humanMore('向右拆分'); await sleep(1500); await shot(`${theme}-out-narrow`); await putBack()
        await intoAmadeus(); await openFromTree('定价调研'); await putBack(); await shot(`${theme}-amadeus-side`)
        await tabMenu('定价调研'); await win.locator('.ctx-menu button[data-act="close"]').last().click(); await sleep(1000)
        await enterSpace(win, 'tangu'); await sleep(2000)
      }
      await pass('light')
      await win.evaluate(() => { localStorage.setItem('forsion_theme_pref', 'dark') })
      await win.reload({ waitUntil: 'domcontentloaded' }); await win.waitForSelector('.dv-groupview', { timeout: 40_000 }); await sleep(2500)
      await openSession(win)
      await pass('dark')
      check('tabshots 暗色这轮走完:Human Desk 上是定价调研、没有它的标签', /定价调研/.test((await st()).hname || '') && (await fileTabs('定价调研')) === 0, await groups())
      await win.evaluate(() => { localStorage.setItem('forsion_theme_pref', 'light') })
      await win.reload({ waitUntil: 'domcontentloaded' }); await win.waitForSelector('.dv-groupview', { timeout: 40_000 }); await sleep(2500)
      await openSession(win)
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

    // ══ v:Agent 给成笔记编辑器的 .db / 白板 → Human Desk 也按文件重新分派(#848 同口径),不进笔记编辑器 ══
    await step('v', async () => {
      const bytes = () => Object.fromEntries(Object.entries(V).map(([k, p]) => [k, fs.readFileSync(p).toString('base64')]))
      const before = bytes()
      const errs = []
      win.on('pageerror', (e) => errs.push(String(e && e.stack || e).slice(0, 400)))
      const crashed = () => win.evaluate(() => [...document.querySelectorAll('[data-view-error]')].map((e) => (e.querySelector('pre')?.textContent || '').slice(0, 300)))
      const chatTab = win.locator('.wb-tab[data-view-type="chat"]').first()
      if (await chatTab.count()) { await chatTab.click(); await sleep(900) }
      const ed = (notePath, name) => ({ type: 'view', view: 'amadeus-editor', params: { notePath }, name })
      stub.script([
        { type: 'status', payload: { phase: 'llm_call', stage: 'sending', iteration: 0 }, delay: 150 },
        { type: 'desk_present', payload: { views: [ed('数据/任务.db', '任务.db'), ed('boards/草图.excalidraw.md', '草图')], size: 'half' }, delay: 200 },
        { type: 'done', payload: { content: '' }, delay: 200 },
      ])
      await send('把任务库和草图摆上来'); await sleep(3500)
      out.notes.vPresent = { boom: await crashed(), errs: errs.slice(0, 4) }; await shot('v-after-present')
      const takeOver = async (re) => {
        if ((await st()).side !== 'agent') await seg('Agent')
        const labels = (await st()).alabels
        const i = labels.findIndex((x) => re.test(x || ''))
        if (i < 0) return { missing: labels }
        await win.locator('.agent-desk.open .agent-desk-body > .agent-desk-pane').nth(i).locator('button[title="更多"]').first().click(); await sleep(400)
        await menuClick('我来改'); await sleep(2500)
        return { labels }
      }
      const humanBody = () => win.evaluate(() => {
        const b = document.querySelector('.agent-desk.open .human-desk-body')
        return b ? { editor: !!b.querySelector('.amx-editor'), db: !!b.querySelector('.amx-dbview'), draw: !!b.querySelector('.amx-drawview'),
          preview: !!b.querySelector('.amx-drawpreview-open'), name: (b.querySelector('.human-desk-name')?.textContent || '').trim() } : null
      })
      const t1 = await takeOver(/草图/)
      const h1 = await humanBody()
      check('v 白板给成笔记编辑器 →「我来改」挪到 Human Desk:白板只读预览,没有笔记编辑器', !!h1 && h1.draw && h1.preview && !h1.editor && /草图/.test(h1.name), { t1, h1 })
      const t2 = await takeOver(/任务\.db/)
      const h2 = await humanBody()
      check('v .db 给成笔记编辑器 →「我来改」挪到 Human Desk:数据库视图,没有笔记编辑器', !!h2 && h2.db && !h2.editor && /任务/.test(h2.name), { t2, h2 })
      await shot('v-human-db')
      const tabs = () => win.evaluate(() => [...document.querySelectorAll('.wb-tab[data-view-type]')].map((t) => t.getAttribute('data-view-type')))
      const n = (xs, type) => xs.filter((x) => x === type).length
      const tb = await tabs()
      await win.locator('.agent-desk.open .human-desk-body button[title="更多"]').first().click(); await sleep(400)
      await menuClick('在新标签页打开'); await sleep(2500)
      const ta = await tabs()
      check('v Human Desk ⋯「在新标签页打开」(.db):主区多一个数据库标签,没开笔记编辑器', n(ta, 'amadeus-db') === n(tb, 'amadeus-db') + 1 && n(ta, 'amadeus-editor') === n(tb, 'amadeus-editor'), { tb, ta })
      await shot('v-main-db')
      if (await chatTab.count()) { await chatTab.click(); await sleep(900) }
      await sleep(3000) // 过了编辑器的存盘防抖再比字节
      const after = bytes()
      const changed = Object.keys(V).filter((k) => before[k] !== after[k])
      check('v .db / 白板的字节都没变', changed.length === 0, { changed })
      const boom = await crashed()
      check('v 没有塌成错误页、没有页面异常', boom.length === 0 && errs.length === 0, { boom, errs: errs.slice(0, 4) })
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
