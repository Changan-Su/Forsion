/**
 * Agent Desk 两格手动控制(2026-11-23 用户选方案 A)的真界面验收:真 Electron(已构建的 out/)× 隔离 home × 可编剧假引擎 × DOM 断言。
 * 方案页 docs/ToBeImproved/AgentDesk手动控制方案_2026-11-20/(仓根);载具照抄那里 instrument/verify-fix.cjs。
 *
 * 覆盖(每段一个 step,断言写在 check() 里):
 *   a  两格一样高(原来差 46px:md 格的胶囊让位在自己的滚动区里,另一格是外层 padding)
 *   b  拖上下分界:悬停变色 + row-resize;拖到 64% → 上格占 64%;双击回各半;界面缩放 110% 下拖到 30% 仍是 30%
 *   c  下格 ▾ 列「最近放过的」(选择菜单 224px、这一格灰、另一格标「在另一格」),换成 report → 下格钉住(图钉)
 *   d  钉住后 Agent 流式写 data.csv:直播进没钉的上格、下格不动;落盘后上格 = data.csv
 *   e  两格都钉:Agent 写 draft.md → 两格不动、▾ 上亮点;打开 ▾ 顶上「Agent 刚放的」;Agent 流式写 → 不上直播、只亮点
 *   f  把文件拖到下格:那一格染色(聊天区不染、输入框不亮),松手 → 下格换成它并钉住,输入框里没有多出引用
 *   g  ⋯ 只看这一格 / 恢复两格(胶囊里的 Rows2 图标)、⋯ 在新标签页打开(原「在主区打开」;主区多一个标签)
 *   h  ⋯ 从 Desk 拿掉,拿到一样不剩 = 空 Desk(卡片回空态,不是关掉)
 *   i  同一条会话开在两扇窗:一扇摆了(▾ 换内容 / Agent 摆东西),另一扇跟着变
 *   j  Desk 视图与标签栏互通(11-23):胶囊图标跟种类走(引用放上来的也不是星)、⋯ 四项打开按序、向下拆分(对话仍在前台、Desk 还在)、
 *      在新窗口中打开(Desk 两格留着)
 *   k  名字胶囊拖出去(合成拖拽事件,同 f):标签栏 = 落点线 + 在那开、同一份拖两次只一个标签;输入框 = 引用;另一格 = 对调并钉住;
 *      自己那格不接;没有文件的视图拖到对话正文不画「拆开对话组」;拖出窗外 = 交主进程 window:dropView(被别的程序接走就不交)
 *   l  防毁档(11-23):Agent 直接给出笔记编辑器(desk_present {type:'view', view:'amadeus-editor'})却指着 .db / 白板 / .csv ——
 *      格子按文件重新分派(数据库视图 / 白板只读预览 / 通用预览),没有笔记编辑器,文件字节不变;真笔记照旧进编辑器。
 *      插件文件类型(.mindmap.md)这里没装插件,覆盖在单测 agentDesk.viewReroute.test.ts
 *   shots 亮 / 暗各一张两格 + 钉住的整窗,与方案图 v-a-light / v-a-dark 对照
 *
 * 跑(必须经 devlock):node <仓根>/.claude/hooks/devlock.cjs run --vehicle=e2e --what="Desk 手动控制" --eta=6 -- npm run check:deskmanual
 * 只跑某几段:ONLY=l npm run check:deskmanual(逗号分隔;段与段之间有前后依赖的,自己挑齐)
 * 先 npm run build。截图写到 OUT(缺省系统临时目录下 desk-manual-check/),不入库。
 */
const fs = require('fs'); const os = require('os'); const path = require('path')
const DESK = path.join(__dirname, '..')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const OUT = process.env.OUT || path.join(os.tmpdir(), 'desk-manual-check'); fs.mkdirSync(OUT, { recursive: true })
const W = 1512, H = 950
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const REPORT = ['# 竞品定价调研', '', '## 结论', '- 三家都把「团队版」定在个人版的 2.5–3 倍', '- 年付折扣集中在 17%–20%', '',
  '## 明细', '', '| 产品 | 个人版 | 团队版 |', '|---|---|---|', '| Alpha | $12 | $30 |', '| Beta | $10 | $28 |', ''].join('\n')
const NOTES = Array.from({ length: 60 }, (_, i) => `line ${i + 1}: Alpha 12/30 · Beta 10/28 · Gamma usage-based`).join('\n') + '\n'

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-deskmanual-'))
  const userData = path.join(home, 'userdata'); const vault = path.join(home, 'vault'); const proj = path.join(home, 'pricing')
  for (const d of [userData, `${userData}-dev`, vault, proj]) fs.mkdirSync(d, { recursive: true })
  const F = { A: path.join(proj, 'pricing-report.md'), B: path.join(proj, 'notes.txt'), T: path.join(proj, 'todo.md'), D: path.join(proj, 'data.csv'), E: path.join(proj, 'draft.md'), G: path.join(proj, 'draft2.md') }
  fs.writeFileSync(F.A, REPORT); fs.writeFileSync(F.B, NOTES); fs.writeFileSync(F.T, '- [ ] 补 Gamma 阶梯价\n- [ ] 对照三档套餐\n')
  // l 段:库里的几份「不是笔记」的文件(+ 一篇真笔记做对照)
  const V = { db: path.join(vault, '数据', '任务.db'), board: path.join(vault, 'boards', '草图.excalidraw.md'), csv: path.join(vault, '数据', '表.csv'), note: path.join(vault, 'notes', '会议.md') }
  for (const p of Object.values(V)) fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(V.db, JSON.stringify({ version: 1, name: '任务', columns: [{ id: 'title', name: '标题', type: 'text' }], rows: [{ id: 'r1', cells: { title: '补 Gamma 阶梯价' } }], views: [] }))
  fs.writeFileSync(V.board, ['---', 'excalidraw-plugin: parsed', '---', '', '## Drawing', '```json',
    JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {} }), '```', '%%'].join('\n'))
  fs.writeFileSync(V.csv, 'product,personal,team\nAlpha,12,30\nBeta,10,28\n')
  fs.writeFileSync(V.note, '# 会议\n\n- 定价对齐\n')
  const S = { id: 'dm-s1', title: '竞品定价调研', summary: '', archived: false, model_id: 'm1', project_path: proj, project_name: 'pricing', projectless: false,
    agent_config: { execMode: 'host', cwd: proj }, created_at: '2026-11-23 10:00:00', updated_at: '2026-11-23 10:00:00' }
  const HISTORY = [
    { id: 'h1', role: 'user', content: '帮我调研一下三家竞品的定价', created_at: S.created_at },
    { id: 'h2', role: 'assistant', content: `原始数据在 [[${F.B}#L5]]。`, created_at: S.created_at },
  ]
  const stub = await startStubEngine({
    sessions: [S], messages: [],
    override: async ({ path: route, method }) => {
      if (route === '/agent/runs' && method === 'GET') return { runs: [] }
      if (/^\/agent\/sessions\/[^/]+\/messages$/.test(route) && method === 'GET') return { messages: HISTORY }
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
  const out = { checks: [], errors: [], shots: [], ran: [] }
  const save = () => fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2))
  const check = (name, ok, got) => { out.checks.push({ name, ok: !!ok, got }); console.log(ok ? 'PASS' : 'FAIL', name, JSON.stringify(got ?? null).slice(0, 300)) }
  try {
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.W, s.H), { W, H })
    await win.waitForSelector('#root', { timeout: 40_000 }); await sleep(2500)
    for (const l of ['跳过引导', 'Skip']) { const b = win.locator(`text=${l}`).first(); if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break } }
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    await win.evaluate(() => { localStorage.setItem('forsion_default_space', 'tangu'); localStorage.setItem('forsion_theme_pref', 'light') })
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
    const only = process.env.ONLY ? process.env.ONLY.split(',') : null // ONLY=l 只跑这几段(负对照 / 单段复跑用)
    const step = async (name, fn) => {
      if (only && !only.includes(name)) return
      out.ran.push(name)
      try { await fn() } catch (e) { out.errors.push({ step: name, err: String(e && e.stack || e).slice(0, 700) }); console.log('ERROR', name, String(e && e.message || e).slice(0, 300)) }
      save()
    }
    const info = (page = win) => page.evaluate(() => {
      const d = document.querySelector('.agent-desk')
      const body = d?.querySelector('.agent-desk-body')
      const panes = d ? [...d.querySelectorAll('.agent-desk-body > .agent-desk-pane')] : []
      const br = body?.getBoundingClientRect()
      return {
        open: !!(d && d.classList.contains('open')),
        body: br ? { top: br.top, height: br.height } : null,
        panes: panes.map((p) => {
          const r = p.getBoundingClientRect()
          return { label: p.querySelector('.desk-cap-label')?.textContent || null, live: !!p.querySelector('.agent-desk-livepane'), pin: !!p.querySelector('.desk-cap-pin'),
            dot: !!p.querySelector('.desk-cap-dot'), drop: p.hasAttribute('data-drop'), top: r.top, height: r.height, text: (p.textContent || '').slice(0, 200) }
        }),
      }
    })
    const L = (st) => st.panes.map((x) => `${x.label}${x.live ? '(live)' : ''}${x.pin ? '📌' : ''}`)
    const labels = async (page = win) => L(await info(page))
    const send = async (text) => { const ta = win.locator('.t2c-ta').first(); await ta.click(); await ta.fill(text); await ta.press('Enter') }
    const lastRun = () => stub.seen.runs[stub.seen.runs.length - 1]?.runId
    const closeMenu = async (page = win) => { await page.keyboard.press('Escape'); await sleep(250) }
    const pane = (i, page = win) => page.locator('.agent-desk .agent-desk-body > .agent-desk-pane').nth(i)
    const pickIn = async (i, name, page = win) => {
      await pane(i, page).locator('button.desk-cap-pick').click(); await sleep(400)
      await page.locator('.ctx-menu.desk-pick-menu .ctx-item', { hasText: name }).first().click({ timeout: 2000 }); await sleep(900)
    }
    const moreIn = async (i, name, page = win) => {
      await pane(i, page).locator('button[title="更多"]').first().click(); await sleep(400)
      await page.locator('.ctx-menu .ctx-item', { hasText: name }).first().click({ timeout: 2000 }); await sleep(900)
    }
    const expand = async (page = win) => { if (!(await info(page)).open) { await page.locator('.agent-desk-card button[title="展开"]').first().click(); await sleep(1500) } return (await info(page)).open }
    const chunks = (id, tool, s, from, to, n = 10) => {
      const ev = []
      for (let k = from; k < to; k += n) ev.push({ type: 'tool_stream', payload: { id, name: tool, delta: s.slice(k, Math.min(k + n, to)) }, delay: 30 })
      return ev
    }
    const agentWrites = async (id, file, body, text) => {
      stub.script([
        { type: 'status', payload: { phase: 'llm_call', stage: 'sending', iteration: 0 }, delay: 150 },
        { type: 'tool_call', payload: { id, name: 'write_file', arguments: JSON.stringify({ path: file, content: body }) }, delay: 200 },
        { type: 'tool_result', payload: { id, result: 'ok', isError: false }, delay: 200 },
        { type: 'done', payload: { content: '' }, delay: 200 },
      ])
      fs.writeFileSync(file, body)
      await send(text); await sleep(3200)
    }
    // 流式写:停在正文中段(路径已闭合);返回 { finish() }
    const startStream = async (id, file, body, text) => {
      const args = JSON.stringify({ path: file, content: body })
      const hold = args.indexOf(file) + file.length + 30
      stub.script([{ type: 'status', payload: { phase: 'llm_call', stage: 'sending', iteration: 0 }, delay: 100 }, ...chunks(id, 'write_file', args, 0, hold), { type: '__hold' }])
      await send(text); await sleep(2600)
      const run = lastRun()
      return {
        finish: async () => {
          fs.writeFileSync(file, body)
          stub.emit(run, [{ type: 'tool_stream', payload: { id, name: 'write_file', delta: args.slice(hold) } }]); await sleep(300)
          stub.finish(run, [{ type: 'tool_call', payload: { id, name: 'write_file', arguments: args } }, { type: 'tool_result', payload: { id, result: 'ok', isError: false } }, { type: 'done', payload: { content: '' } }])
          await sleep(2600)
        },
      }
    }
    const present = async (paths, text) => {
      stub.script([
        { type: 'status', payload: { phase: 'llm_call', stage: 'sending', iteration: 0 }, delay: 150 },
        { type: 'desk_present', payload: { views: paths.map((p) => ({ type: 'file', path: p, name: path.basename(p) })), size: 'half', note: '报告在上,原始记录在下' }, delay: 200 },
        { type: 'done', payload: { content: '' }, delay: 200 },
      ])
      await send(text); await sleep(2600)
    }

    // ══ a:Agent 摆两格,展开;两格一样高 ══
    await step('a', async () => {
      await present([F.A, F.B], '整理成报告放到 Desk 上')
      await expand()
      const st = await info()
      check('a 两格 = [pricing-report.md, notes.txt]', JSON.stringify(L(st)) === JSON.stringify(['pricing-report.md', 'notes.txt']), L(st))
      const [p0, p1] = st.panes
      check('a 两格一样高(差 ≤ 2px;原来差 46px)', p0 && p1 && Math.abs(p0.height - p1.height) <= 2, st.panes.map((x) => Math.round(x.height)))
      await shot('a-two-cells')
    })

    // ══ b:拖上下分界(100% 与 110% 缩放) ══
    const dragSplit = async (frac) => {
      const g = await win.locator('.agent-desk-split').boundingBox()
      const st = await info()
      const y = st.body.top + st.body.height * frac
      await win.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await sleep(150)
      await win.mouse.down(); await win.mouse.move(g.x + g.width / 2, (g.y + y) / 2, { steps: 4 }); await win.mouse.move(g.x + g.width / 2, y, { steps: 6 }); await win.mouse.up(); await sleep(400)
      const after = await info()
      return { ratio: (after.panes[0].height + 0) / after.body.height, heights: after.panes.map((x) => Math.round(x.height)) }
    }
    await step('b', async () => {
      const g = win.locator('.agent-desk-split')
      check('b 分界存在(两格时)', await g.count() === 1, await g.count())
      const idle = await g.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, cursor: getComputedStyle(el).cursor }))
      await g.hover(); await sleep(250)
      const hov = await g.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, op: getComputedStyle(el).opacity, cursor: getComputedStyle(el).cursor }))
      check('b 平时不画,悬停变色、光标 row-resize', /rgba\(0, 0, 0, 0\)|transparent/.test(idle.bg) && !/rgba\(0, 0, 0, 0\)/.test(hov.bg) && hov.cursor === 'row-resize', { idle, hov })
      await shot('b-hover')
      const r64 = await dragSplit(0.64)
      check('b 拖到 64% → 上格占 64%(±2%)', Math.abs(r64.ratio - 0.64) < 0.02, r64)
      await shot('b-released-64')
      await g.dblclick(); await sleep(400)
      const st = await info()
      check('b 双击分界 → 回到各半', Math.abs(st.panes[0].height / st.body.height - 0.5) < 0.02, st.panes.map((x) => Math.round(x.height)))
      await win.evaluate(() => { document.body.style.zoom = '1.1' }); await sleep(600)
      const z = await dragSplit(0.30)
      check('b 界面缩放 110% 下拖到 30% → 上格占 30%(±2%)', Math.abs(z.ratio - 0.30) < 0.02, z)
      const zst = await info()
      check('b 110% 下两格边界仍对齐分界(高度和 = 盒高)', Math.abs(zst.panes[0].height + zst.panes[1].height - zst.body.height) <= 2, zst.panes.map((x) => Math.round(x.height)))
      await g.dblclick(); await sleep(300)
      await win.evaluate(() => { document.body.style.zoom = '' }); await sleep(600)
    })

    // ══ c:Agent 写 todo(进上格);下格 ▾ 换成 report → 钉住 ══
    await step('c', async () => {
      await agentWrites('t-todo', F.T, '- [ ] 补 Gamma 阶梯价\n- [ ] 对照三档套餐\n- [ ] 年付折扣\n', '把待办也列一下')
      check('c 前置:Agent 写的进上格 = [todo.md, notes.txt]', JSON.stringify(await labels()) === JSON.stringify(['todo.md', 'notes.txt']), await labels())
      await pane(1).locator('button.desk-cap-pick').click(); await sleep(450)
      const menu = await win.evaluate(() => {
        const m = document.querySelector('.ctx-menu.desk-pick-menu')
        if (!m) return null
        return { width: m.getBoundingClientRect().width, heads: [...m.querySelectorAll('.ctx-head')].map((x) => x.textContent),
          rows: [...m.querySelectorAll('.ctx-item')].map((b) => ({ label: b.querySelector('.desk-pick-label')?.textContent, hint: b.querySelector('.desk-pick-hint')?.textContent || null, disabled: b.disabled })) }
      })
      check('c 下格有 ▾,是选择菜单(宽 224)', !!menu && Math.abs(menu.width - 224) <= 2, menu && menu.width)
      const row = (n) => menu?.rows.find((r) => r.label === n)
      check('c 这一格灰着、标「这一格」;另一格标「在另一格」;第 3 样 report 也在', row('notes.txt')?.disabled && row('notes.txt')?.hint === '这一格' && row('todo.md')?.hint === '在另一格' && !!row('pricing-report.md'), menu)
      await shot('c-recent-menu')
      await win.locator('.ctx-menu.desk-pick-menu .ctx-item', { hasText: 'pricing-report.md' }).first().click(); await sleep(900)
      const st = await labels()
      check('c 换好:下格 = pricing-report.md 且钉住(图钉)', JSON.stringify(st) === JSON.stringify(['todo.md', 'pricing-report.md📌']), st)
      await shot('c-switched-pinned')
    })

    // ══ d:钉住后 Agent 流式写 data.csv → 直播进没钉的上格 ══
    await step('d', async () => {
      const s = await startStream('t-data', F.D, 'product,personal,team\nAlpha,12,30\nBeta,10,28\nGamma,usage,usage\n', '把数据整理成 csv')
      const mid = await labels()
      check('d 直播进没钉的上格,下格不动', JSON.stringify(mid) === JSON.stringify(['正在编辑 data.csv(live)', 'pricing-report.md📌']), mid)
      await s.finish()
      const end = await labels()
      check('d 落盘:上格 = data.csv,下格仍钉着 report', JSON.stringify(end) === JSON.stringify(['data.csv', 'pricing-report.md📌']), end)
      await shot('d-agent-into-unpinned')
    })

    // ══ e:两格都钉 → Agent 的新东西只亮点 ══
    await step('e', async () => {
      await pickIn(0, 'todo.md')
      check('e 前置:两格都钉 [todo.md📌, pricing-report.md📌]', JSON.stringify(await labels()) === JSON.stringify(['todo.md📌', 'pricing-report.md📌']), await labels())
      await agentWrites('t-draft', F.E, '# 草稿\n\n第一版。\n', '写个草稿')
      const st = await info()
      check('e Agent 写 draft.md:两格不动', JSON.stringify(L(st)) === JSON.stringify(['todo.md📌', 'pricing-report.md📌']), L(st))
      check('e ▾ 上亮点(只亮在上格那颗 ▾ 上)', st.panes[0]?.dot && !st.panes[1]?.dot, st.panes.map((p) => p.dot))
      await pane(0).locator('button.desk-cap-pick').click(); await sleep(450)
      const menu = await win.evaluate(() => {
        const m = document.querySelector('.ctx-menu.desk-pick-menu')
        const head = [...(m?.querySelectorAll('.ctx-head') || [])].find((x) => x.textContent === 'Agent 刚放的')
        let n = head?.nextElementSibling
        while (n && !n.classList.contains('ctx-item')) n = n.nextElementSibling
        return m ? { heads: [...m.querySelectorAll('.ctx-head')].map((x) => x.textContent), first: n?.querySelector('.desk-pick-label')?.textContent, hasDot: !!n?.querySelector('.desk-pick-dot') } : null
      })
      check('e 打开 ▾:顶上「Agent 刚放的」= draft.md,带点', menu?.heads?.[0] === 'Agent 刚放的' && menu.first === 'draft.md' && menu.hasDot, menu)
      await shot('e-both-pinned-menu')
      await closeMenu()
      check('e 打开过 ▾ → 点撤掉', !(await info()).panes.some((p) => p.dot), (await info()).panes.map((p) => p.dot))
      const s = await startStream('t-d2', F.G, '# 草稿 2\n\n' + 'x'.repeat(200) + '\n', '再起一份草稿')
      const mid = await info()
      check('e 两格都钉时流式写:不上直播,只亮点', !mid.panes.some((p) => p.live) && mid.panes[0]?.dot, L(mid))
      await s.finish()
      check('e 落盘后两格仍不动', JSON.stringify(await labels()) === JSON.stringify(['todo.md📌', 'pricing-report.md📌']), await labels())
    })

    // ══ f:把文件拖到下格 ══
    await step('f', async () => {
      const drag = async (phase) => win.evaluate(({ phase, file }) => {
        const p = document.querySelectorAll('.agent-desk .agent-desk-body > .agent-desk-pane')[1]
        const r = p.getBoundingClientRect()
        const dt = new DataTransfer()
        dt.setData('application/x-tangu-paths', JSON.stringify([file]))
        const target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) || p
        const fire = (type) => target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }))
        if (phase === 'over') { fire('dragenter'); fire('dragover') } else fire('drop')
        const cv = p.closest('.t2-chat-view')
        return { drop: p.hasAttribute('data-drop'), deskdrop: cv?.hasAttribute('data-deskdrop') || false, refdrop: cv?.classList.contains('refdrop') || false,
          wash: cv ? getComputedStyle(cv, '::after').content : null }
      }, { phase, file: F.B })
      const over = await drag('over')
      check('f 悬停:下格染色;聊天区不染(落点让给 Desk)', over.drop && over.deskdrop && (over.wash === 'none' || over.wash === 'normal'), over)
      await sleep(200); await shot('f-drop-hover')
      await drag('drop'); await sleep(900)
      const st = await labels()
      check('f 松手:下格 = notes.txt 且钉住', JSON.stringify(st) === JSON.stringify(['todo.md📌', 'notes.txt📌']), st)
      const chips = await win.evaluate(() => (document.querySelector('.composer-anchor')?.textContent || '').includes('notes.txt'))
      check('f 输入框里没有多出 notes.txt 的引用', !chips, chips)
      const marks = await win.evaluate(() => ({ drop: !!document.querySelector('.agent-desk-pane[data-drop]'), deskdrop: !!document.querySelector('.t2-chat-view[data-deskdrop]') }))
      check('f 松手后标记都收了', !marks.drop && !marks.deskdrop, marks)
    })

    // ══ g:只看这一格 / 恢复两格;在新标签页打开 ══
    await step('g', async () => {
      await moreIn(1, '只看这一格')
      const st = await info()
      const restore = await win.locator('.agent-desk button[title="恢复两格"]').count()
      check('g 只看这一格:只剩一格、胶囊里多一颗「恢复两格」', st.panes.length === 1 && st.panes[0].label === 'notes.txt' && restore === 1, { panes: L(st), restore })
      await shot('g-solo')
      await pane(0).locator('button[title="更多"]').first().click(); await sleep(400)
      const items = await win.evaluate(() => [...document.querySelectorAll('.ctx-menu .ctx-item')].map((b) => b.textContent))
      check('g 只看一格时 ⋯ 第一项是「恢复两格」', items[0] === '恢复两格', items)
      await closeMenu()
      await win.locator('.agent-desk button[title="恢复两格"]').first().click(); await sleep(600)
      check('g 点胶囊里的「恢复两格」→ 两格', (await info()).panes.length === 2, await labels())
      const tabsBefore = await win.evaluate(() => [...document.querySelectorAll('.wb-tab .wb-tab-name')].map((x) => x.textContent))
      await moreIn(1, '在新标签页打开'); await sleep(1200)
      const tabsAfter = await win.evaluate(() => [...document.querySelectorAll('.wb-tab .wb-tab-name')].map((x) => x.textContent))
      check('g 在新标签页打开:主区多一个 notes.txt 标签', tabsAfter.length === tabsBefore.length + 1 && tabsAfter.some((x) => /notes\.txt/.test(x || '')), { tabsBefore, tabsAfter })
      // 回到聊天标签
      const chatTab = win.locator('.wb-tab').filter({ hasText: S.title }).first()
      if (await chatTab.count()) { await chatTab.click(); await sleep(1200) }
    })

    // ══ shots:亮 / 暗两格 + 钉住整窗 ══
    await step('shots', async () => {
      await expand()
      await shot('light-two-pinned')
      await win.evaluate(() => { localStorage.setItem('forsion_theme_pref', 'dark') })
      await win.reload({ waitUntil: 'domcontentloaded' }); await win.waitForSelector('.dv-groupview', { timeout: 40_000 }); await sleep(2500)
      await openSession(win); await expand()
      const st = await labels()
      check('shots 重载后摆法与钉住还在(快照)', JSON.stringify(st) === JSON.stringify(['todo.md📌', 'notes.txt📌']), st)
      await shot('dark-two-pinned')
      await win.evaluate(() => { localStorage.setItem('forsion_theme_pref', 'light') })
      await win.reload({ waitUntil: 'domcontentloaded' }); await win.waitForSelector('.dv-groupview', { timeout: 40_000 }); await sleep(2500)
      await openSession(win); await expand()
    })

    // ══ i:两扇窗同步 ══
    await step('i', async () => {
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
      await app.evaluate(({ BrowserWindow }, s) => { const w = BrowserWindow.getAllWindows().find((x) => /window=detached/.test(x.webContents.getURL())); w?.setContentSize(s.W, s.H) }, { W: 1100, H: 800 })
      await sleep(800); await expand(w2)
      const w2a = await labels(w2)
      check('i 独立窗打开时摆法 = 主窗', JSON.stringify(w2a) === JSON.stringify(await labels()), { main: await labels(), w2: w2a })
      // 主窗:取消下格钉住,▾ 换上格(对调)
      await pane(1).locator('.desk-cap-pin').click(); await sleep(300)
      await pickIn(0, 'notes.txt'); await sleep(800)
      const m1 = await labels(); const s1 = await labels(w2)
      check('i 主窗 ▾ 对调 → 独立窗跟着变', JSON.stringify(m1) === JSON.stringify(s1) && JSON.stringify(m1) === JSON.stringify(['notes.txt📌', 'todo.md📌']), { main: m1, w2: s1 })
      // 独立窗:⋯ 只看这一格 → 主窗跟着
      await moreIn(1, '只看这一格', w2); await sleep(800)
      check('i 独立窗「只看这一格」→ 主窗也只剩一格', (await info()).panes.length === 1 && (await info(w2)).panes.length === 1, { main: await labels(), w2: await labels(w2) })
      await w2.locator('.agent-desk button[title="恢复两格"]').first().click(); await sleep(800)
      // 主窗里 Agent 写文件(独立窗收不到那次 run 的事件)→ 独立窗经快照跟上。先取消上格钉住,让它进上格
      await pane(0).locator('.desk-cap-pin').click(); await sleep(300)
      await agentWrites('t-x', F.D, 'a,b\n1,2\n', '再更新一下 data.csv')
      await sleep(1200)
      const m2 = await labels(); const s2 = await labels(w2)
      check('i 主窗 Agent 写 data.csv → 独立窗跟着变', JSON.stringify(m2) === JSON.stringify(s2) && m2[0] === 'data.csv', { main: m2, w2: s2 })
      await shot('i-detached', w2)
    })

    // ══ h:拿掉到空 ══
    await step('h', async () => {
      await moreIn(1, '从 Desk 拿掉')
      check('h 拿掉下格 → 只剩一格', (await info()).panes.length === 1, await labels())
      await moreIn(0, '从 Desk 拿掉'); await sleep(900)
      const st = await win.evaluate(() => ({
        panel: !!document.querySelector('.agent-desk.open .agent-desk-pane'),
        card: (() => { const c = document.querySelector('.agent-desk-card'); return c ? { gone: c.classList.contains('gone'), empty: c.classList.contains('empty') } : null })(),
      }))
      check('h 一样不剩 = 空 Desk:侧板没了、卡片回空态(没关掉)', !st.panel && st.card && !st.card.gone && st.card.empty, st)
      await shot('h-empty')
    })

    // ══ j:Desk 视图与标签栏互通(11-23 方案,用户定全部按建议):胶囊图标、⋯ 四项打开、向下拆分、新窗口 ══
    await step('j', async () => {
      const groups = () => win.evaluate(() => [...document.querySelectorAll('.dv-groupview')].map((g) => {
        const r = g.getBoundingClientRect()
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
          front: g.querySelector('.dv-tab.dv-active-tab .wb-tab')?.getAttribute('data-view-type') || null,
          tabs: [...g.querySelectorAll('.wb-tab')].map((t) => t.getAttribute('data-view-type')) }
      }).filter((g) => g.w > 0))
      const icons = () => win.evaluate(() => [...document.querySelectorAll('.agent-desk-body > .agent-desk-pane')].map((p) => {
        const ic = p.querySelector('.desk-caps .desk-cap-ic')
        return { label: p.querySelector('.desk-cap-label')?.textContent || '', icon: ic ? ([...ic.classList].find((c) => c.startsWith('lucide-')) || ic.className) : null }
      }))
      await present([F.A, F.D], '报告和数据放上来'); await expand()
      const ic1 = await icons()
      check('j 胶囊图标:表格是表格、md 是纸,不是星', ic1.some((x) => x.label === 'data.csv' && x.icon === 'lucide-file-spreadsheet') && ic1.every((x) => x.icon && x.icon !== 'lucide-sparkles'), ic1)
      // 点聊天里的行号引用 → 这一格按视图放上来(原来一律给星)
      await win.locator('.t2-chat-view a.wikilink[data-wiki*="notes.txt"]').first().click(); await sleep(1800)
      const ic2 = await icons()
      check('j 行号引用放上来的那格:按文件给图标(txt = 纸),不是星', ic2.some((x) => /notes\.txt/.test(x.label) && x.icon === 'lucide-file-text') && ic2.every((x) => x.icon !== 'lucide-sparkles'), ic2)
      await shot('j-icons')
      await pane(0).locator('button[title="更多"]').first().click(); await sleep(400)
      const items = await win.evaluate(() => [...document.querySelectorAll('.ctx-menu .ctx-item')].map((b) => (b.textContent || '').trim()))
      const want = ['在新标签页打开', '向右拆分', '向下拆分', '在新窗口中打开']
      const at = want.map((w) => items.indexOf(w))
      check('j ⋯ 四项打开按序都在,没有「在主区打开」', at.every((i, k) => i >= 0 && (k === 0 || i === at[k - 1] + 1)) && !items.includes('在主区打开'), items)
      await shot('j-menu')
      await closeMenu()
      const name0 = (await info()).panes[0]?.label || ''
      const g0 = await groups()
      await moreIn(0, '向下拆分'); await sleep(1500)
      const g1 = await groups()
      const chatG = g1.find((g) => g.tabs.includes('chat'))
      const below = chatG && g1.find((g) => g !== chatG && g.y > chatG.y + 10 && Math.abs(g.x - chatG.x) < 4 && Math.abs(g.w - chatG.w) < 4)
      const deskVis = await win.evaluate(() => { const d = document.querySelector('.agent-desk.open'); return !!d && d.getBoundingClientRect().width > 0 })
      check('j 向下拆分:对话那组正下方多一组,对话仍在前台,Desk 还在', g1.length === g0.length + 1 && !!below && chatG.front === 'chat' && deskVis, { g0, g1, deskVis })
      check('j 拆出去后 Desk 那格还在(A 留着)', (await info()).panes.some((x) => x.label === name0), await labels())
      await shot('j-split-down')
      if (below) { // 收回:关掉下面那组的标签
        const t = win.locator(`.wb-tab[data-view-type="${below.tabs[0]}"]`).last()
        await t.click({ button: 'right' }); await sleep(300)
        await win.locator('button[data-act="close"]').first().click().catch(() => {}); await sleep(900)
      }
      check('j 关掉拆出来的那组 → 回到原样', (await groups()).length === g0.length, await groups())
      const wp = app.waitForEvent('window', { timeout: 15000 })
      await moreIn(0, '在新窗口中打开')
      const w3 = await wp.catch(() => null)
      let t3 = null
      if (w3) { await w3.waitForSelector('.wb-tab', { timeout: 20000 }).catch(() => {}); await sleep(1500); t3 = await w3.evaluate(() => [...document.querySelectorAll('.wb-tab .wb-tab-name')].map((x) => x.textContent || '')) }
      check('j 在新窗口中打开:新窗口里就是这一份,主窗 Desk 两格还在', !!t3 && t3.some((x) => x.includes(name0.replace(/:\d+$/, ''))) && (await info()).panes.length === 2, { t3, name0, desk: await labels() })
      if (w3) await w3.close().catch(() => {})
    })

    // ══ k:名字胶囊拖出去(11-23 方案 ①;合成拖拽事件,真 OS 拖出窗外这一段只验到交给主进程) ══
    await step('k', async () => {
      // 起拖 → 经过某处(dragenter + dragover)→ 读落点提示 → 可选松手 → dragend。全程同一个 DataTransfer(window.__dk)。
      const drag = (from, to, opt = {}) => win.evaluate(async ({ from, to, opt }) => {
        const panes = [...document.querySelectorAll('.agent-desk .agent-desk-body > .agent-desk-pane')]
        const src = panes[from]?.querySelector('.desk-cap-pick')
        if (!src) return { err: 'no source' }
        const dt = new DataTransfer()
        src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }))
        const box = (sel) => { const e = typeof sel === 'string' ? document.querySelector(sel) : sel; return e ? e.getBoundingClientRect() : null }
        let r = null, x = 0, y = 0
        if (to === 'tab') { r = box('.wb-tab[data-view-type="chat"]'); x = r.right - 4; y = r.top + r.height / 2 }
        else if (to === 'composer') { r = box('.t2c-card'); x = r.left + r.width / 2; y = r.top + r.height / 2 }
        else if (to === 'body') { r = box('.t2-stream'); x = r.left + r.width / 2; y = r.top + r.height * 0.35 }
        else { r = panes[to].getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2 }
        const t = document.elementFromPoint(x, y)
        const fire = (type, el = t) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: x, clientY: y }))
        fire('dragenter'); fire('dragover')
        // 输入框亮起是 React 状态(dragover 是连续事件,批到下一帧才提交):等两帧再读
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        const vis = (sel) => { const e = document.querySelector(sel); return !!e && getComputedStyle(e).display !== 'none' }
        const cv = document.querySelector('.t2-chat-view')
        const seen = { line: vis('.wb-drop-line'), zone: vis('.wb-drop-zone'), cells: panes.map((p) => p.hasAttribute('data-drop')), refdrop: !!cv?.classList.contains('refdrop'),
          effect: dt.dropEffect, faded: !!document.querySelector('.desk-cap-name.desk-cap-dragging') }
        if (opt.drop) fire('drop')
        src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: opt.outside ? -40 : x, clientY: opt.outside ? 120 : y }))
        return seen
      }, { from, to, opt })
      const tabsNamed = (re) => win.evaluate((src) => [...document.querySelectorAll('.wb-tab .wb-tab-name')].filter((x) => new RegExp(src).test(x.textContent || '')).length, re)
      const backToChat = async () => { const c = win.locator('.wb-tab[data-view-type="chat"]').first(); if (await c.count()) { await c.click(); await sleep(1200) } }
      await expand()
      const start = await labels()
      check('k 前置:两格 = [notes.txt, data.csv]', start.length === 2 && /notes\.txt/.test(start[0]) && /data\.csv/.test(start[1]), start)
      // 标签栏
      const n0 = await tabsNamed('notes\\.txt')
      const overTab = await drag(0, 'tab', { drop: true }); await sleep(1500)
      const n1 = await tabsNamed('notes\\.txt')
      check('k 拖到标签栏:落点线出现、源胶囊变淡,松手后多一个 notes.txt 标签(或切到已开着的那份)', overTab.line && !overTab.zone && overTab.faded && n1 >= n0 && n1 <= n0 + 1, { overTab, n0, n1 })
      await backToChat()
      await drag(0, 'tab', { drop: true }); await sleep(1500)
      const n2 = await tabsNamed('notes\\.txt')
      check('k 同一份拖两次:不开第二个标签', n2 === n1, { n1, n2 })
      await backToChat()
      check('k 拖进标签栏后 Desk 那格还在(A 留着)、胶囊不再淡', JSON.stringify(await labels()) === JSON.stringify(start) && !(await win.evaluate(() => !!document.querySelector('.desk-cap-dragging'))), await labels())
      // 输入框
      const overComp = await drag(0, 'composer', { drop: true }); await sleep(800)
      const chip = await win.evaluate(() => (document.querySelector('.composer-anchor')?.textContent || ''))
      check('k 拖到输入框:输入框亮起,松手成一枚引用;没有落点线 / 半屏高亮', overComp.refdrop && !overComp.line && !overComp.zone && /notes\.txt/.test(chip), { overComp, chip: chip.slice(0, 80) })
      // 另一格 / 自己那格
      const overOther = await drag(0, 1, { drop: true }); await sleep(900)
      const afterSwap = await labels()
      check('k 拖到另一格:那格染色、无落点线;松手两格对调,拖过去的那样钉住', overOther.cells[1] && !overOther.cells[0] && !overOther.line && !overOther.zone && /data\.csv/.test(afterSwap[0]) && /notes\.txt.*📌/.test(afterSwap[1]), { overOther, afterSwap })
      const overSelf = await drag(1, 1)
      check('k 拖回自己那格:不染色、不接、无落点提示', !overSelf.cells.some(Boolean) && !overSelf.line && !overSelf.zone && overSelf.effect === 'none', overSelf)
      // 没有文件的视图(活动日志):对话正文不画「拆开对话组」
      stub.script([
        { type: 'status', payload: { phase: 'llm_call', stage: 'sending', iteration: 0 }, delay: 150 },
        { type: 'desk_present', payload: { views: [{ type: 'view', view: 'activity-log' }], size: 'half' }, delay: 200 },
        { type: 'done', payload: { content: '' }, delay: 200 },
      ])
      await send('把活动日志摆上来'); await sleep(2600)
      const st3 = await info()
      const vi = st3.panes.findIndex((p) => !/notes\.txt|data\.csv/.test(p.label || ''))
      const icon = vi >= 0 ? await win.evaluate((i) => { const ic = document.querySelectorAll('.agent-desk .agent-desk-body > .agent-desk-pane')[i]?.querySelector('.desk-cap-ic'); return ic ? [...ic.classList].find((c) => c.startsWith('lucide-')) : null }, vi) : null
      check('k 插件 / 内置视图放上来:胶囊用它注册的图标(活动日志),不是星', vi >= 0 && icon && icon !== 'lucide-sparkles', { panes: L(st3), icon })
      if (vi >= 0) {
        const overBody = await drag(vi, 'body')
        check('k 没有文件的拖到对话正文:不画拆开对话组、输入框不亮', !overBody.zone && !overBody.line && !overBody.refdrop, overBody)
        const overTab2 = await drag(vi, 'tab')
        check('k 没有文件的拖到标签栏照样有落点线', overTab2.line, overTab2)
      }
      // 拖出窗外:主进程收到 window:dropView(view)。换掉主进程的处理器只记下来,不真开窗(真 OS 光标位置这里控制不了)。
      // 「被别的程序接走(dropEffect≠none)就不交」这一档合成事件验不到:脚本自己 new 的 DataTransfer 改不了 dropEffect。
      await app.evaluate(({ ipcMain }) => { globalThis.__dkDrops = []; ipcMain.removeHandler('window:dropView'); ipcMain.handle('window:dropView', (_e, v) => { globalThis.__dkDrops.push(v); return { routed: false } }) })
      const ni = (await info()).panes.findIndex((p) => /notes\.txt/.test(p.label || ''))
      await drag(ni, 'composer', { outside: true }); await sleep(800)
      const d1 = await app.evaluate(() => globalThis.__dkDrops)
      check('k 拖出窗外:交给主进程开新窗口,带的就是这一份的视图', d1.length === 1 && d1[0]?.type === 'wsfile' && /notes\.txt/.test(JSON.stringify(d1[0]?.params || {})), d1)
      // 在窗里松手(标签栏接住了)之后哪怕 dragend 报的坐标在窗外,也不交:窗里收尾时已清掉
      await drag(ni, 'tab', { drop: true, outside: true }); await sleep(800)
      check('k 窗里松手的不交主进程', (await app.evaluate(() => globalThis.__dkDrops.length)) === 1, await app.evaluate(() => globalThis.__dkDrops.length))
      await shot('k-after')
    })

    // ══ l:防毁档 —— Agent 给的笔记编辑器指着不是笔记的文件,格子按文件重新分派 ══
    await step('l', async () => {
      const bytes = () => Object.fromEntries(Object.entries(V).map(([k, p]) => [k, fs.readFileSync(p).toString('base64')]))
      const before = bytes()
      // 先清空 Desk:k 段留下了钉住的一格,present 会绕开钉住的格
      for (let i = 0; i < 4 && (await info()).panes.length; i++) await moreIn(0, '从 Desk 拿掉')
      const presentViews = async (views, text) => {
        stub.script([
          { type: 'status', payload: { phase: 'llm_call', stage: 'sending', iteration: 0 }, delay: 150 },
          { type: 'desk_present', payload: { views, size: 'half' }, delay: 200 },
          { type: 'done', payload: { content: '' }, delay: 200 },
        ])
        await send(text); await sleep(4000)
      }
      const ed = (notePath, name) => ({ type: 'view', view: 'amadeus-editor', params: { notePath }, name })
      const cells = () => win.evaluate(() => [...document.querySelectorAll('.agent-desk .agent-desk-body > .agent-desk-pane')].map((p) => ({
        label: p.querySelector('.desk-cap-label')?.textContent || null, editor: !!p.querySelector('.amx-editor'), db: !!p.querySelector('.amx-dbview'),
        draw: !!p.querySelector('.amx-drawview'), preview: !!p.querySelector('.amx-drawpreview-open'), wsfile: !!p.querySelector('.wsfile-tab .wsfile-table'),
      })))
      const cellOf = (xs, re) => xs.find((c) => re.test(c.label || ''))
      await presentViews([ed('数据/任务.db', '任务.db'), ed('boards/草图.excalidraw.md', '草图')], '把任务库和草图摆上来')
      const c1 = await cells()
      const db = cellOf(c1, /任务\.db/), board = cellOf(c1, /草图/)
      check('l .db 给成笔记编辑器:格子挂数据库视图,没有笔记编辑器', !!db && db.db && !db.editor, c1)
      check('l 白板给成笔记编辑器:格子挂白板只读预览,没有笔记编辑器', !!board && board.draw && board.preview && !board.editor, c1)
      await shot('l-db-board')
      await presentViews([ed('数据/表.csv', '表.csv'), ed('notes/会议.md', '会议')], '把表格和会议记录摆上来')
      const c2 = await cells()
      const csv = cellOf(c2, /表\.csv/), note = cellOf(c2, /会议/)
      check('l 认不出的(.csv)给成笔记编辑器:回落通用预览(表格),没有笔记编辑器', !!csv && csv.wsfile && !csv.editor, c2)
      check('l 真笔记照旧进笔记编辑器(对照)', !!note && note.editor, c2)
      await sleep(3000) // 过了编辑器的存盘防抖再比字节
      const after = bytes()
      const changed = ['db', 'board', 'csv'].filter((k) => before[k] !== after[k])
      check('l .db / 白板 / .csv 的字节都没变', changed.length === 0, { changed })
      await shot('l-after')
    })
  } finally {
    save()
    await app.close().catch(() => {}); stub.close(); fs.rmSync(home, { recursive: true, force: true })
  }
  const failed = out.checks.filter((c) => !c.ok)
  // ONLY 写错了段名 = 一段没跑、0/0 也不能算过
  const missed = process.env.ONLY ? process.env.ONLY.split(',').filter((n) => !out.ran.includes(n)) : []
  console.log(`checks: ${out.checks.length - failed.length}/${out.checks.length} passed; errors: ${out.errors.length}; shots → ${OUT}${missed.length ? `; ONLY 里没跑到的段: ${missed.join(',')}` : ''}`)
  process.exit(failed.length || out.errors.length || missed.length || !out.checks.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
