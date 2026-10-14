/**
 * 新对话输入卡上方那一栏(项目胶囊 / 额外文件夹 / 开场那一行)—— 真 Electron(managed)× 真组件 / store × 假引擎。
 *
 * 用户 2026-10-13 报的三件事,钉住的契约:
 *  ① 这一栏最左的胶囊(桌面 = 运行位置胶囊,项目胶囊排在它后面)左缘与输入卡左缘是同一条线 —— 三种宽度都量(宽窗、≤1040 断点、聊天列 ≤520 的容器断点)外加 110% 缩放。
 *     这一栏的盒子是照抄 .t2c-inner 的数写的(base.css .newchat-projectbar),改了一边忘了另一边就在这里红。
 *  ② 开场那一行(「上次之后,X 在后台记住了 N 件事」)不夹在项目胶囊和输入卡之间:放得下时与胶囊同一行、靠右;
 *     放不下时(聊天列夹到 320)折到胶囊**上面**。
 *  ③ 「添加文件夹」:项目不变,加进来的文件夹排成胶囊、可移除;第一条消息建会话时随 agent_config.extraRoots 落库、
 *     随 run 的 agentConfig 发给引擎(引擎据此放行读写并写进环境说明);会话建成后草稿里那份清掉,不带进下一个新对话。
 *
 * 需先 npm run build,且本检出有 tangu-agent/dist(managed 模式要起真引擎进程;请求由 route 改道到假引擎)。
 * 用法:npm run e2e:projectbar            截图落在临时目录,路径打在最后一行
 * 负对照:FORSION_E2E_ROOT=<没有这次改动的检出>/desktop node scripts/newchat-projectbar.e2e.cjs —— ① ② 必须转红,③ 找不到按钮。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = process.env.FORSION_E2E_ROOT || path.join(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error(`缺 ${ROOT}/out/main/main.js —— 先跑 npm run build`)
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-projectbar-'))
  const userData = path.join(home, 'userdata')
  const workspace = path.join(home, 'workspace')
  const extra = path.join(home, 'reference-docs')
  for (const d of [workspace, extra]) fs.mkdirSync(d, { recursive: true })

  const created = []
  const sessions = []
  const stub = await startStubEngine({
    sessions,
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }],
    override: async ({ path: p, method, body }) => {
      if (p === '/agent/sessions' && method === 'POST') {
        const input = await body()
        created.push(input)
        const session = { id: `s-${created.length}`, title: 'New Chat', summary: '', archived: false, emoji: null, ...input, app_id: 'tangu', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
        sessions.unshift(session)
        return { session }
      }
      const config = /^\/agent\/sessions\/([^/]+)\/config$/.exec(p)
      if (config && method === 'GET') return { agent_config: sessions.find((s) => s.id === config[1])?.agent_config || {} }
      if (/^\/agent\/sessions\/[^/]+\/messages$/.test(p) && method === 'GET') return { messages: [] }
      if (p === '/agent/special/config') return { config: { muse: { enabled: false }, historian: { enabled: false } } }
      // 开场那一行的两份数据:「上次看到哪」之后,记忆整理在后台记下了一条
      if (p.endsWith('/memory') && method === 'GET') return { version: 'v1', content: 'Prefers short answers.', tombstones: [], updatedAt: 1, entries: [{ id: 'm-bg', content: 'Prefers short answers.', source: { kind: 'dream' }, evidenceIds: [], createdAt: Date.UTC(2026, 8, 20), updatedAt: Date.UTC(2026, 8, 20) }] }
      if (/^\/agent\/agents\/[^/]+\/harness$/.test(p) && method === 'GET') return { entries: [], journal: [], candidates: [], candidateItems: [] }
    },
  })
  stub.script([{ type: 'token', payload: { text: '好的。' } }, { type: 'done', payload: { content: '好的。' } }])
  for (const dir of [userData, `${userData}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({
      mode: 'managed', backendUrl: stub.url, token: 'e2e', cloudUrl: 'http://127.0.0.1:9',
      sandbox: 'none', browserEnabled: false, defaultWorkspaceDir: workspace, modelId: 'm1', unitHostEnabled: false,
    }))
  }

  const app = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_BROWSER_CDP: 'off', TANGU_HARNESS_QUIET: '1' },
  })
  const shot = (name) => path.join(home, name)
  try {
    const win = await app.firstWindow({ timeout: 60_000 })
    await app.context().route('**/agent/**', async (route) => {
      const url = new URL(route.request().url())
      await route.continue({ url: `${stub.url}${url.pathname}${url.search}` })
    })
    const resize = async (w, h = 900) => { await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]); await win.waitForTimeout(350) }
    const zoom = async (f) => { await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(f), f); await win.waitForTimeout(350) }
    await resize(1600)
    await win.waitForSelector('#root', { timeout: 40_000 })
    check('离开首启引导', await skipOnboarding(win))
    await win.waitForFunction(async () => (await window.tangu.getConfig()).backendState?.state === 'ready', null, { timeout: 40_000 })
    // 「上次看到哪」记成一个过去的时刻(第一次遇到一个 Agent 只记时刻、不显示);进会话 Space 的新对话
    const slugs = await win.evaluate(async () => {
      const r = await fetch(`${(await window.tangu.getConfig()).backendUrl}/agent/agents`).then((x) => x.json()).catch(() => ({}))
      return [...new Set(['xyra', ...(r.agents || []).map((a) => a.slug), r.defaultSlug].filter(Boolean))]
    })
    await win.evaluate((slugs) => {
      localStorage.setItem('forsion.selfSeen', JSON.stringify(Object.fromEntries(slugs.map((x) => [x, Date.UTC(2026, 8, 1)]))))
      localStorage.setItem('forsion_default_space', 'tangu')
    }, slugs)
    await win.reload({ waitUntil: 'domcontentloaded' })
    await skipOnboarding(win, 600)
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.locator('[data-ribbon-id="space:tangu"], [data-id="space:tangu"]').first().click().catch(() => {})

    const view = win.locator('.t2-chat-view:visible').first()
    const pill = view.locator('.newchat-projectbar .project-selector:not(.runloc) > .project-pill')
    // 这一栏最左边那一枚:桌面主窗口上是运行位置胶囊(「这台电脑」,10-14 起恒在),项目胶囊排在它后面 —— 对齐量的是最左那一枚
    const lead = view.locator('.newchat-projectbar .project-selector > .project-pill').first()
    const card = view.locator('.t2c-card')
    const opening = view.locator('[data-self-opening]')
    await pill.waitFor({ timeout: 20_000 })
    const box = async (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } })
    const near = (a, b) => Math.abs(a - b) <= 1

    // ── ① 胶囊左缘 == 输入卡左缘 ──
    const aligned = async (label) => {
      const [l, p, c] = [await box(lead), await box(pill), await box(card)]
      check(`${label}:这一栏最左的胶囊与输入卡左缘对齐`, near(l.left, c.left), { pill: +l.left.toFixed(1), card: +c.left.toFixed(1), diff: +(l.left - c.left).toFixed(1) })
      check(`${label}:项目胶囊贴在输入卡上方`, p.bottom <= c.top + 1 && c.top - p.bottom < 24, { gap: +(c.top - p.bottom).toFixed(1) })
    }
    check('这是默认项目(本机),项目胶囊写着它', /Tangu 默认项目/.test(await pill.innerText()), await pill.innerText())
    await aligned('宽窗 1600')

    // ── ② 开场那一行不夹在胶囊和输入卡之间 ──
    await opening.waitFor({ timeout: 15_000 }).catch(() => {})
    check('开场那一行出现了', await opening.count() === 1, await opening.count() ? await opening.innerText() : '没有')
    if (await opening.count()) {
      const [o, p, c] = [await box(opening), await box(pill), await box(card)]
      check('宽窗:开场与项目胶囊同一行(不单占一行排在胶囊下面)', o.top < p.bottom && o.bottom > p.top, { opening: [o.top, o.bottom].map(Math.round), pill: [p.top, p.bottom].map(Math.round) })
      check('宽窗:开场靠右,右缘与输入卡右缘对齐', near(o.right, c.right), { opening: +o.right.toFixed(1), card: +c.right.toFixed(1) })
    }
    await zoom(1.1)
    await aligned('宽窗 110% 缩放')
    await view.locator('.composer-anchor').screenshot({ path: shot('bar-wide-110.png') })
    fs.writeFileSync(shot('window-wide-110.png'), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')), 'base64')) // 缩放后 playwright 的整页截图会裁掉右边和下边
    await zoom(1)

    await resize(1000)
    check('窗口 1000:落在 ≤1040 断点里', await win.evaluate(() => window.matchMedia('(max-width: 1040px)').matches))
    await aligned('窗口 1000(≤1040 断点)')
    await view.locator('.composer-anchor').screenshot({ path: shot('bar-1000.png') })

    // 聊天列 ≤520 的容器断点:真窗口缩不到这么窄(有侧栏),把视图自己夹到 460 —— 容器查询量的是它的实宽。
    await resize(1600)
    await view.evaluate((el) => { el.style.maxWidth = '460px' })
    await win.waitForTimeout(350)
    await aligned('聊天列 460(≤520 容器断点)')
    const rows = async () => { const [o, p] = [await box(opening), await box(pill)]; return { o, p, detail: { opening: [o.top, o.bottom].map(Math.round), pill: [p.top, p.bottom].map(Math.round) } } }
    if (await opening.count()) {
      const { o, p, detail } = await rows()
      check('聊天列 460:开场不在项目胶囊下面(同一行或在上面)', o.top < p.bottom, detail)
    }
    await view.locator('.composer-anchor').screenshot({ path: shot('bar-narrow-460.png') })
    // 再窄到一行放不下:开场得折到胶囊**上面**,胶囊仍贴着输入卡
    await view.evaluate((el) => { el.style.maxWidth = '320px' })
    await win.waitForTimeout(350)
    await aligned('聊天列 320')
    if (await opening.count()) {
      const { o, p, detail } = await rows()
      check('聊天列 320:开场放不下,折到项目胶囊上面', o.bottom <= p.top + 1, detail)
    }
    await view.locator('.composer-anchor').screenshot({ path: shot('bar-narrow-320.png') })
    await view.evaluate((el) => { el.style.maxWidth = '' })
    await win.waitForTimeout(350)

    // ── ③ 添加文件夹 ──
    const pickNext = (dir) => app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: !dir, filePaths: dir ? [dir] : [] }) }, dir)
    const add = view.locator('[data-extra-folder-add]')
    const chips = view.locator('[data-extra-folder]')
    check('项目胶囊后面有「添加文件夹」', await add.count() === 1 && (await add.getAttribute('aria-label')) === '添加文件夹', await add.count())
    if (await add.count()) {
      const [a, p] = [await box(add), await box(pill)]
      check('「添加文件夹」与项目胶囊同一行、等高', near(a.top, p.top) && near(a.bottom, p.bottom) && a.left >= p.right, { add: [a.top, a.bottom].map(Math.round), pill: [p.top, p.bottom].map(Math.round) })
      await pickNext(extra)
      await add.click()
      await chips.first().waitFor({ timeout: 5000 }).catch(() => {})
      check('选了一个文件夹:多出一枚胶囊,写着文件夹名', await chips.count() === 1 && (await chips.first().innerText()).trim() === 'reference-docs', await chips.allInnerTexts())
      check('项目没变:仍是默认项目', /Tangu 默认项目/.test(await pill.innerText()), await pill.innerText())
      await add.click()
      await win.waitForTimeout(300)
      check('同一个文件夹再加一次:不重复', await chips.count() === 1, await chips.count())
      await pickNext(workspace)
      await add.click()
      await win.waitForTimeout(300)
      check('选的就是项目目录:不加', await chips.count() === 1, await chips.count())
      await chips.first().getByRole('button', { name: '移除 reference-docs', exact: true }).click()
      await win.waitForTimeout(200)
      check('点 ×:那一枚没了', await chips.count() === 0, await chips.count())
      await pickNext(extra)
      await add.click()
      await chips.first().waitFor({ timeout: 5000 }).catch(() => {})
      await aligned('加了文件夹之后')
      await zoom(1.1)
      await view.locator('.composer-anchor').screenshot({ path: shot('bar-with-folder-110.png') })
      await zoom(1)

      const ta = view.locator('.t2c-ta:visible').first()
      await ta.click()
      await ta.fill('看一下参考资料')
      await win.keyboard.press('Enter')
      for (let t0 = Date.now(); !stub.seen.runs.length && Date.now() - t0 < 10_000;) await win.waitForTimeout(150)
      const init = created[0]?.agent_config || {}
      check('建会话:项目目录还是默认项目', created[0]?.project_path === workspace && init.cwd === workspace && init.execMode === 'host', { project_path: created[0]?.project_path, cwd: init.cwd, execMode: init.execMode })
      check('建会话:额外文件夹随初始配置落库', Array.isArray(init.extraRoots) && init.extraRoots.includes(extra), init.extraRoots)
      check('起 run:额外文件夹发给了引擎(读写放行与环境说明都认它)', (stub.seen.runs[0]?.agentConfig?.extraRoots || []).includes(extra), stub.seen.runs[0]?.agentConfig?.extraRoots)
      await win.waitForTimeout(800)
      await win.locator('[data-act="new-chat"]').first().click()
      await pill.waitFor({ timeout: 10_000 })
      await win.waitForTimeout(400)
      check('再开新对话:上一个会话加的文件夹没有带过来', await chips.count() === 0 && await add.count() === 1, { chips: await chips.count(), add: await add.count() })
    }
  } finally {
    await app.close().catch(() => {})
    try { stub.close() } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过;截图在 ${home}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
