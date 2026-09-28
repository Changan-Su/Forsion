/** 作品卡(```forsion-creation)的真 Electron 仪器:真组件 / store × 可编剧假引擎 × 主进程造物 IPC 换桩
 *  (台架的托管根是真实的 ~/Forsion(-Dev)/Project,不能往那里建东西)。钉住:
 *  ① 无 path 的卡「做成作品」→ products:create(名字)→ PATCH 会话 project_path / project_name + 会话配置 cwd 指过去
 *     → 替用户发「接着做」(POST /agent/runs,同一会话)→ 卡片完成态;围栏原文不进正文;
 *  ② 有 path 的卡「加入造物」→ products:register(工作目录内的绝对路径, within = 工作目录)→ **原地**加入(不复制)
 *     → 会话工作目录切到那个文件夹本身,不替用户发消息;完成态由 products:isCreation 判;
 *  ③ path 爬出工作目录 → 没有按钮,只有说明;
 *  ④ 截图(观感自查)。先 npm run build,再 npm run check:creationcard;--nc = 负对照(围栏换成 text,卡片不该出现 → 全红)。 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
// macOS:一个 Electron 实例被强杀后,系统会在下一次启动时先弹「是否恢复窗口」的模态框(崩溃历史,所有未打包的 Electron 共用 com.github.Electron),
// ready 永远等不到、firstWindow 超时。按进程关掉窗口恢复(Cocoa 的参数域,只作用于这个进程),台架不受上一次被杀的实例连累。
const NO_RESTORE = process.platform === 'darwin' ? ['-ApplePersistenceIgnoreState', 'YES'] : []
const FENCE = process.argv.includes('--nc') ? 'text' : 'forsion-creation'
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const agentDef = (slug, name) => ({ slug, name, description: '', tools: [], model: '', thinkingLevel: '', maxIterations: null, approvalMode: '', createdBy: 'user', createdAt: '2026-09-01', systemPrompt: `You are ${name}.`, soul: '', libraryDir: `/tmp/cc-lib/${slug}/Library` })
const card = (lines) => ['```' + FENCE, ...lines, '```'].join('\n')
const MESSAGES = {
  'cc-create': [
    { id: 'u1', role: 'user', content: '帮我做一个番茄钟网页', timestamp: 1000 },
    { id: 'a1', role: 'assistant', content: `好的，做一个番茄钟网页。点击下面的按钮后，我就开始搭建：\n\n${card(['name: 番茄钟'])}`, timestamp: 2000 },
  ],
  'cc-add': [
    { id: 'u2', role: 'user', content: '把刚才做的放进造物', timestamp: 1000 },
    { id: 'a2', role: 'assistant', content: `在 pomodoro 文件夹里，点下面的按钮就能放进造物：\n\n${card(['name: Pomodoro', 'path: pomodoro'])}`, timestamp: 2000 },
  ],
  'cc-outside': [
    { id: 'u3', role: 'user', content: '把上一级的东西也放进去', timestamp: 1000 },
    { id: 'a3', role: 'assistant', content: `试试这个：\n\n${card(['name: Secrets', 'path: ../secrets'])}`, timestamp: 2000 },
  ],
}

async function openSession(win, title, id) {
  for (let i = 0; i < 20; i++) {
    const row = win.locator('.t2s-srow, .t2o-row').filter({ hasText: title }).first()
    if (await row.count().catch(() => 0)) { await row.click().catch(() => {}); break }
    await sleep(400)
  }
  await win.waitForSelector(`[data-chat-surface="chat"][data-session-id="${id}"]`, { timeout: 20_000 })
  await sleep(600)
}

async function run(app, win, stub, seen, home, work, root) {
  win.setDefaultTimeout(15_000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 950))
  await win.waitForSelector('#root', { timeout: 30_000 })
  await win.waitForTimeout(2000)
  for (const label of ['跳过引导', 'Skip']) {
    const b = win.getByText(label, { exact: true })
    if (await b.count().catch(() => 0)) { await b.first().click().catch(() => {}); break }
  }
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await win.evaluate(() => { localStorage.setItem('forsion_default_space', 'tangu'); localStorage.removeItem('forsion_tangu_session_mode') })
  await win.reload({ waitUntil: 'domcontentloaded' })
  await win.waitForSelector('.t2sw, .t2s-side', { timeout: 30_000 })
  await sleep(1200)
  await app.evaluate(({ ipcMain }, dir) => {
    globalThis.__creations = { create: [], register: [], registered: [] }
    for (const ch of ['products:create', 'products:register', 'products:isCreation']) ipcMain.removeHandler(ch)
    ipcMain.handle('products:create', (_e, name) => { globalThis.__creations.create.push({ name }); return { dir: `${dir}/${name}`, name, product: {} } })
    // 原地加入:回的目录就是来源本身(不复制)
    ipcMain.handle('products:register', (_e, source, within, strict) => {
      globalThis.__creations.register.push({ source, within, strict }); globalThis.__creations.registered.push(source)
      return { ok: true, dir: source, name: source.split('/').pop(), product: {} }
    })
    ipcMain.handle('products:isCreation', (_e, d) => d.startsWith(`${dir}/`) || globalThis.__creations.registered.includes(d))
  }, root)
  const calls = () => app.evaluate(() => globalThis.__creations)
  const shots = {}

  // ── ① 做成作品 ─────────────────────────────────────────────────────────
  await openSession(win, '番茄钟对话', 'cc-create')
  const createCard = win.locator('[data-creation-card="create"]')
  await createCard.waitFor({ timeout: 8_000 }).catch(() => {})
  const leak = await win.evaluate(() => [...document.querySelectorAll('.t2-content')].some((el) => (el.textContent || '').includes('forsion-creation')))
  const createTitle = (await createCard.locator('.t2-taskcard-head').textContent().catch(() => '')) || ''
  check('1 无 path 的卡渲染成「做成作品：番茄钟」+ 一颗按钮,围栏原文不进正文', /做成作品：番茄钟/.test(createTitle) && await createCard.locator('[data-creation-accept]').count() === 1 && !leak, JSON.stringify({ createTitle, leak }))
  await win.screenshot({ path: shots.createCard = path.join(home, 'creation-card-create-zh-light.png') })
  const runsBefore = stub.seen.runs.length
  await createCard.locator('[data-creation-accept]').click().catch(() => {})
  await createCard.locator('[data-creation-done]').waitFor({ timeout: 8_000 }).catch(() => {})
  await sleep(800)
  const target = `${root}/番茄钟`
  const created = await calls()
  const patch = seen.patches.find((p) => p.id === 'cc-create')
  const cfg = stub.seen.configs.filter((c) => c.sessionId === 'cc-create').at(-1)
  const cont = stub.seen.runs.slice(runsBefore).find((r) => r.sessionId === 'cc-create')
  // 会话配置走按键 PATCH:只发变了的 cwd(execMode 本来就是 host);续跑那一轮带的整份配置里两样都得对
  check('1a 点「做成作品」→ products:create(番茄钟)→ PATCH 会话 project_path/project_name → 会话配置 cwd = 作品文件夹(host)',
    created.create.length === 1 && created.create[0].name === '番茄钟' && patch?.body.project_path === target && patch?.body.project_name === '番茄钟' && patch?.body.projectless === false && cfg?.config.cwd === target && cont?.agentConfig?.cwd === target && cont?.agentConfig?.execMode === 'host',
    JSON.stringify({ created, patch, cfg }))
  check('1b 替用户发「接着做」(同一会话),卡片进入完成态 + 两个去处按钮',
    /作品文件夹「番茄钟」已经建好/.test(cont?.message || '') && /已在造物里：番茄钟/.test((await createCard.locator('[data-creation-done]').textContent().catch(() => '')) || '') && await createCard.locator('[data-creation-done] button').count() === 2,
    JSON.stringify({ cont }))
  await win.screenshot({ path: shots.createDone = path.join(home, 'creation-card-done-zh-light.png') })

  // ── ② 加入造物(有 path)─────────────────────────────────────────────────
  await openSession(win, '加入已有对话', 'cc-add')
  const addCard = win.locator('[data-creation-card="add"]')
  await addCard.waitFor({ timeout: 8_000 }).catch(() => {})
  const addText = (await addCard.textContent().catch(() => '')) || ''
  check('2 有 path 的卡:「加入造物：Pomodoro」,说明里点名那个文件夹、说清原地加入', /加入造物：Pomodoro/.test(addText) && /「pomodoro」原地加入造物/.test(addText), addText.slice(0, 160))
  const runsBeforeAdd = stub.seen.runs.length
  await addCard.locator('[data-creation-accept]').click().catch(() => {})
  await addCard.locator('[data-creation-done]').waitFor({ timeout: 8_000 }).catch(() => {})
  await sleep(600)
  const added = await calls()
  const addPatch = seen.patches.find((p) => p.id === 'cc-add')
  const pomodoro = path.join(work, 'pomodoro')
  check('2a 点「加入造物」→ products:register(工作目录/pomodoro, within = 工作目录)→ 会话工作目录切到那个文件夹本身(原地,不是复制品);不替用户发消息;卡片完成态',
    added.register.length === 1 && added.register[0].source === pomodoro && added.register[0].within === work && added.register[0].strict === false && addPatch?.body.project_path === pomodoro && stub.seen.runs.length === runsBeforeAdd
      && /已在造物里/.test((await addCard.locator('[data-creation-done]').textContent().catch(() => '')) || ''),
    JSON.stringify({ added, addPatch, runs: stub.seen.runs.length - runsBeforeAdd }))
  await win.screenshot({ path: shots.addDone = path.join(home, 'creation-card-add-done-zh-light.png') })

  // ── ③ path 爬出工作目录 ───────────────────────────────────────────────────
  await openSession(win, '越界卡对话', 'cc-outside')
  const outCard = win.locator('[data-creation-card="add"]')
  await outCard.waitFor({ timeout: 8_000 }).catch(() => {})
  const outText = (await outCard.textContent().catch(() => '')) || ''
  check('3 path 爬出工作目录 → 没有按钮,只有说明;什么都没加入', await outCard.count() === 1 && await outCard.locator('[data-creation-accept]').count() === 0 && /不在这条对话的工作目录里/.test(outText) && (await calls()).register.length === 1, outText.slice(0, 160))
  await win.screenshot({ path: shots.outside = path.join(home, 'creation-card-outside-zh-light.png') })
  return shots
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out', 'main', 'main.js'))) { console.error('先跑 npm run build(仪器跑的是 out/ 产物)'); process.exit(1) }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-creationcard-'))
  const userData = path.join(home, 'userData')
  const vault = path.join(home, 'vault')
  const work = path.join(home, 'Sketches')
  const root = path.join(home, 'Creations')
  for (const dir of [userData, `${userData}-dev`, vault, path.join(work, 'pomodoro'), root]) fs.mkdirSync(dir, { recursive: true })
  const base = { summary: '', archived: false, model_id: 'm1', created_at: '2026-09-27 09:00:00', projectless: false, project_path: work, project_name: 'Sketches' }
  const sessions = [
    { ...base, id: 'cc-create', title: '番茄钟对话', updated_at: '2026-09-27 11:00:00', agent_config: { agentSlug: 'xyra', execMode: 'host', cwd: work } },
    { ...base, id: 'cc-add', title: '加入已有对话', updated_at: '2026-09-27 10:00:00', agent_config: { agentSlug: 'xyra', execMode: 'host', cwd: work } },
    { ...base, id: 'cc-outside', title: '越界卡对话', updated_at: '2026-09-27 09:30:00', agent_config: { agentSlug: 'xyra', execMode: 'host', cwd: work } },
  ]
  const seen = { patches: [] }
  const stub = await startStubEngine({ agents: [agentDef('xyra', 'Xyra')], sessions, messages: [], handle: async ({ path: route }) => {
    if (route === '/agent/teams') return { teams: [] }
    if (route === '/agent/special/config') return { config: { historian: { enabled: false }, muse: { enabled: false } } }
    return undefined
  }, override: async ({ path: route, method, url, body }) => {
    if (route === '/agent/sessions' && method === 'GET' && url.searchParams.get('archived') === 'true') return { sessions: [] }
    const m = /^\/agent\/sessions\/([^/]+)\/messages$/.exec(route)
    if (m) return { messages: MESSAGES[decodeURIComponent(m[1])] || [] }
    const s = /^\/agent\/sessions\/([^/]+)$/.exec(route)
    if (s && method === 'PATCH') {
      const id = decodeURIComponent(s[1]), b = await body()
      seen.patches.push({ id, body: b })
      const row = sessions.find((x) => x.id === id)
      if (row) Object.assign(row, b)
      return { session: row }
    }
    return undefined
  } })
  for (const dir of [userData, `${userData}-dev`]) {
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }), 'utf8')
    fs.writeFileSync(path.join(dir, 'amadeus-config.dev.json'), JSON.stringify({ localVault: vault, lastVault: vault }), 'utf8')
  }
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT, ...NO_RESTORE], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, FORSION_E2E_TRASH_DIR: path.join(home, 'e2e-trash') } })
  const errors = []
  let shots = null
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => { errors.push(String(e && e.stack || e).slice(0, 400)) })
    shots = await run(app, win, stub, seen, home, work, root)
    check('4 渲染进程零 pageerror', errors.length === 0, errors.join(' || ').slice(0, 300))
  } catch (e) {
    console.error(e); check('runner 未捕获异常', false, String((e && e.message) || e))
    try { await (await app.firstWindow()).screenshot({ path: path.join(home, 'failure.png') }) } catch { /* ignore */ }
  } finally {
    await app.close().catch(() => {})
    try { stub.close() } catch { /* ignore */ }
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  console.log('ARTIFACTS ' + home)
  if (shots) console.log('SHOTS ' + JSON.stringify(shots))
  process.exit(failed.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
