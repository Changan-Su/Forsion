/**
 * Agent Desk 伴随面(ctx.desk.registerCompanion)× agent 状态(ctx.tangu.agentStatus / onStatus)×
 * ctx.tangu.startChat 的**真 Electron** 仪器(2026-09-19)。
 *
 * 为什么要真 Electron:plugview 台架(plugin-view.e2e --companion)挂的是假探针、固定尺寸盒子,
 * 验不到「真 ChatView 里草稿态的卡片在不在」「草稿 → 真会话时伴随面重不重挂」「真 SSE 事件流推出来的
 * phase 序列」「desk_present 在 idle / always 两种模式下落不落状态」「startChat 真的开出对话、只给自家
 * 捆绑 Agent 直发」。这些都只在真应用 + 真 store + 真插件宿主里成立。
 *
 * 被测对象:本文件在隔离 TANGU_HOME 里**现生成**一个探针插件 desk-probe(不依赖任何外部插件仓):
 *  - registerCompanion 画一块 2D canvas(写着当前 phase),每次 mount / unmount、每个 onStatus 都记进
 *    window.__deskProbe(跨禁用→启用存活);
 *  - window.__deskProbeSetMode(m) → handle.update({mode}),window.__deskProbeStartChat(o) → ctx.tangu.startChat;
 *  - 捆绑 agents/probe-agent/{config.toml,SOUL.md} → bundle.agents 含它;隔离 TANGU_HOME 里按引擎播种的样子
 *    放好 tangu/agents/probe-agent/.bundle-origin = desk-probe(假引擎不播种,这里代写)→ send:true 对它放行;
 *  - 捆绑 agents/probe-foreign/ 但**没有**标记(= 同 slug 早已存在、引擎没覆盖的撞名形态)→ send:true 降级为预填。
 * 引擎 = scripts/lib/stub-engine.cjs 的可编剧假引擎(证渲染接线,不证模型)。
 *
 * 断言(PASS/FAIL 逐行):
 *  A  探针禁用时新对话草稿也有 Desk 卡(草稿修复本体)且没有伴随面槽 —— 兼作槽位检测的负对照
 *  1  草稿卡里有伴随面槽 + 非零 canvas;探针挂载时看到 idle / sessionId null
 *  2  发一条消息(剧本:llm_call → reasoning → token → write_file → token → done):phase 按序
 *     thinking…tool…speaking…done,~4s 后回 idle;草稿 → 真会话**不重挂**
 *     2e(2026-09-19 起恒红 = 已知宿主缺陷):appStore.ts `case 'done'` 先 patchMessage 把气泡标 done、
 *     之后才 endRun 清 runningBySession;两次 set 之间 agentStatusOf 找不到 streaming 气泡 → 落到 ⑤ 兜底
 *     thinking,订阅方在 done 之前收到一帧假 thinking(实测间隔 0–2ms)。宿主修好即绿,别加豁免。
 *  3  idle 模式 + desk_present:卡片演文件不演伴随面;「清空 Desk」请回伴随面;切会话往返后仍是空的
 *  4  always 模式:有条目也演伴随面;展开 → 侧板演伴随面、卡片退场(永不双显);desk_present 不落条目;
 *     切回 idle 恢复旧行为;零条目时切模式不重挂
 *  5  startChat:send:false → 预填 + 选中 Agent、不起 run;send:true 自家 Agent → run 的 agentSlug 对;
 *     send:true 别家 Agent → 只预填不起 run;未知 Agent → 报错;5e 清单里有但没有播种标记(撞名)→ 只预填
 *  6  截图(亮 / 暗):草稿卡 + 伴随面;always 模式展开侧板
 *  7  全程没有 [desk-companion] 控制台错误 / 渲染进程异常
 *  8  desk_screenshot × 伴随面(09-19 下午,用户实测 agent 看不到 Desk 上的形象):假引擎推 desk_capture_request,
 *     记下渲染层 POST 回来的图。idle 零条目 / always(先 desk_present 被吞)→ 截到形象且带 companion = 伴随面 key;
 *     idle + desk_present(view, half)→ 截到侧板里放上的东西、不带 companion。--plugin 时对真插件再截一张存 capture-<id>.png
 *
 * 可选:`--plugin <dir>` 额外把一个真插件**拷贝**(不是软链)进隔离家目录,探针禁用后给它拍同样两组截图
 * (always 模式 = 预写 <home>/plugins-data/<id>.json 的 {"mode":"always"},适配 Live3D 的数据形状;
 * 别的插件忽略这个文件即可)。只拷运行期文件:main.js / manifest.json / README / CHANGELOG / LICENSE /
 * icon.png / agents/ / skills/ —— 不搬 node_modules / src。
 *
 * 负对照:`--nc=remount` 让探针在「草稿 → 真会话」那一刻以同 key 换 mount 函数重注册(= 插件自己逼宿主重挂),
 * 期望第 2 组的「不重挂」断言转红。
 *
 * 需先 npm run build(跑的是 out/,对别人的 dev 实例 / HMR 免疫;隔离 --user-data-dir 不抢单实例锁)。
 * 用法:npm run check:deskcompanion [-- --plugin <dir>] [-- --shots <dir>] [-- --nc=remount]
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const argv = process.argv.slice(2)
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
const PLUGIN_SRC = argOf('--plugin') ? path.resolve(argOf('--plugin')) : null
const SHOT_DIR = path.resolve(argOf('--shots') || path.join(os.tmpdir(), 'forsion-deskcompanion-shots'))
const NC = (argv.find((a) => a.startsWith('--nc=')) || '').split('=')[1] || ''

const PROBE_ID = 'desk-probe'
const PROBE_KEY = `plugin:${PROBE_ID}:main`
const PROBE_AGENT = 'probe-agent'
/** 探针捆绑包里也有,但隔离家目录里没有本插件的播种标记(撞名:同 slug 早已存在,引擎没覆盖)。 */
const FOREIGN_AGENT = 'probe-foreign'
const DRAFT = '__draft__'
const T = { clear: ['清空 Desk', 'Clear Desk'], expand: ['展开', 'Expand'], collapse: ['收起为卡片', 'Collapse to card'] }
const btnSel = (scope, labels) => labels.map((l) => `${scope} button[title="${l}"]`).join(', ')

const results = []
function check(name, ok, detail) {
  // `!!ok`:`a && a.b === x` 中途遇 null 会短路成 null —— 不强转就既不算过也不算败(plugin-seams 头注)。
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
class StopEarly extends Error {}

// ── 探针插件(裸 setup 体:外置插件经 new Function('ctx', code) 求值,没有 import)──────────────
const PROBE_MAIN = `
const P = (window.__deskProbe = window.__deskProbe || { setups: 0, mounts: 0, unmounts: 0, mountInfo: [], phases: [], log: [] })
P.setups++
P.hasDesk = !!(ctx.desk && ctx.desk.registerCompanion)
P.hasStartChat = !!(ctx.tangu && ctx.tangu.startChat)
P.hasAgentStatus = !!(ctx.tangu && ctx.tangu.agentStatus && ctx.tangu.subscribeAgentStatus)
const NC = ${JSON.stringify(NC)}
let mode = 'idle'
try { const m = localStorage.getItem('deskprobe.mode'); if (m === 'always' || m === 'idle') mode = m } catch (e) {}
P.mode = mode
const COLORS = { idle: '#7d8590', thinking: '#5b7cfa', speaking: '#23a26d', tool: '#d9922a', waiting: '#c04fc0', error: '#d9534f', done: '#2a9fb0' }
let handle = null
let reRegistered = false
let armed = false
const live = new Set()
function mountImpl(el, host) {
  P.mounts++
  live.add(host)
  const surface = host.surface
  const s0 = host.status()
  P.mountInfo.push({ surface: surface, sessionId: host.sessionId(), phase: s0.phase, statusSession: s0.sessionId == null ? null : s0.sessionId, t: Date.now() })
  P.log.push({ ev: 'mount', surface: surface, sessionId: host.sessionId(), t: Date.now() })
  const cv = document.createElement('canvas')
  cv.className = 'deskprobe-canvas'
  cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'
  el.appendChild(cv)
  let st = s0
  const draw = () => {
    const r = el.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr))
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h }
    const g = cv.getContext('2d')
    g.fillStyle = COLORS[st.phase] || '#888'
    g.fillRect(0, 0, w, h)
    g.fillStyle = '#fff'
    g.font = Math.round(22 * dpr) + 'px sans-serif'
    g.fillText(st.phase + (st.tool ? ' · ' + st.tool : ''), 14 * dpr, 36 * dpr)
    g.font = Math.round(13 * dpr) + 'px sans-serif'
    g.fillText(surface + ' · ' + (host.sessionId() || 'draft'), 14 * dpr, 58 * dpr)
  }
  const ro = new ResizeObserver(draw)
  ro.observe(el)
  const off = host.onStatus(function (s) {
    st = s
    P.phases.push({ surface: surface, phase: s.phase, sessionId: s.sessionId == null ? null : s.sessionId, tool: s.tool || null, t: Date.now() })
    draw()
    // 负对照:插件以同 key 换 mount 重注册 → 宿主必须重挂(第 2 组「不重挂」应转红)
    // 只在检查脚本 arm 之后(第 2 组发消息前)触发 —— 启动时应用可能先恢复一个旧会话,别在那一刻误触发。
    if (NC === 'remount' && armed && !reRegistered && s.sessionId && handle) { reRegistered = true; register() }
  })
  draw()
  return function () { live.delete(host); P.unmounts++; P.log.push({ ev: 'unmount', surface: surface, t: Date.now() }); off(); ro.disconnect() }
}
function register() {
  handle = ctx.desk.registerCompanion({ id: 'main', mode: mode, mount: function (el, host) { return mountImpl(el, host) } })
}
if (P.hasDesk) register()
window.__deskProbeSetMode = function (m) {
  if (!handle) return false
  mode = m
  handle.update({ mode: m })
  P.mode = m
  try { localStorage.setItem('deskprobe.mode', m) } catch (e) {}
  return true
}
window.__deskProbeArm = function () { armed = true }
/** 当前活着的挂载点此刻的拉取式快照(host.sessionId() / host.status())。 */
window.__deskProbeLive = function () {
  return Array.from(live).map(function (h) { const s = h.status(); return { surface: h.surface, sessionId: h.sessionId(), phase: s.phase, statusSession: s.sessionId == null ? null : s.sessionId } })
}
window.__deskProbeStartChat = function (o) {
  return P.hasStartChat ? ctx.tangu.startChat(o) : Promise.resolve({ ok: false, error: 'probe: no ctx.tangu.startChat' })
}
return function () { if (handle) handle.dispose() }
`

function writeProbe(pluginsDir) {
  const dir = path.join(pluginsDir, PROBE_ID)
  fs.mkdirSync(path.join(dir, 'agents', PROBE_AGENT), { recursive: true })
  fs.writeFileSync(path.join(dir, 'main.js'), PROBE_MAIN)
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: PROBE_ID, name: 'Desk Probe', version: '1.0.0', minAppVersion: '0.0.1',
    description: 'desk-companion.check 用的伴随面探针,不是产品插件',
  }, null, 2))
  // 捆绑 Agent:宿主只看 agents/<slug>/config.toml 在不在(collectBundleInfo)
  fs.writeFileSync(path.join(dir, 'agents', PROBE_AGENT, 'config.toml'), 'name = "Probe Agent"\ndescription = "Bundled agent of the desk-probe instrument plugin."\n')
  fs.writeFileSync(path.join(dir, 'agents', PROBE_AGENT, 'SOUL.md'), 'You are the desk-probe instrument agent. Reply briefly.\n')
  fs.mkdirSync(path.join(dir, 'agents', FOREIGN_AGENT), { recursive: true })
  fs.writeFileSync(path.join(dir, 'agents', FOREIGN_AGENT, 'config.toml'), 'name = "Probe Foreign (bundle copy)"\n')
}

/** 假引擎不播种:按 tangu-agent seedBundleAgents 的落盘形态代写 <tanguDataDir>/agents/<slug>/。
 *  tanguDataDir = forsionHomeDir()/tangu(TANGU_HOME=home 的目录名不是 tangu → forsionHomeDir = home)。
 *  probe-agent = 新播种,带 .bundle-origin = 插件目录名;probe-foreign = 早已存在的同名 agent,引擎不覆盖、不写标记。 */
function writeSeededAgents(home) {
  const agents = path.join(home, 'tangu', 'agents')
  fs.mkdirSync(path.join(agents, PROBE_AGENT), { recursive: true })
  fs.writeFileSync(path.join(agents, PROBE_AGENT, 'config.toml'), 'name = "Probe Agent"\n')
  fs.writeFileSync(path.join(agents, PROBE_AGENT, '.bundle-origin'), PROBE_ID)
  fs.mkdirSync(path.join(agents, FOREIGN_AGENT), { recursive: true })
  fs.writeFileSync(path.join(agents, FOREIGN_AGENT, 'config.toml'), 'name = "Probe Foreign (user\'s own)"\n')
}

/** 真插件只拷运行期文件(递归拷 agents/ skills/),绝不软链 —— 家目录会被删。 */
function installRealPlugin(pluginsDir, src) {
  const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'))
  const id = manifest.id || path.basename(src)
  const dest = path.join(pluginsDir, id)
  fs.mkdirSync(dest, { recursive: true })
  for (const f of ['main.js', 'manifest.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'icon.png']) {
    const p = path.join(src, f)
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dest, f))
  }
  for (const d of ['agents', 'skills', 'spaces', 'tangu-plugins']) {
    const p = path.join(src, d)
    if (fs.existsSync(p)) fs.cpSync(p, path.join(dest, d), { recursive: true, dereference: true })
  }
  return id
}

// ── 引擎剧本 ───────────────────────────────────────────────────────────────────────────
// write_file 的参数**不带 path**:带了的话本机会话里 tool_result 会经 deskAutoShow 往 Desk 放一格,
// idle 伴随面当场让位、订阅随卸载而停,后面的 speaking / done / idle 就看不到了(那是另一条行为,第 3 组单独验)。
const RUN_MAIN = [
  { type: 'status', payload: { phase: 'llm_call', stage: 'sending', iteration: 0 }, delay: 300 },
  { type: 'reasoning', payload: { delta: '先想一想。' }, delay: 600 },
  { type: 'reasoning', payload: { delta: '再想一想。' }, delay: 300 },
  { type: 'token', payload: { delta: '我来写个文件。' }, delay: 600 },
  { type: 'tool_call', payload: { id: 'dc-tool-1', name: 'write_file', arguments: '{"content":"probe"}' }, delay: 600 },
  { type: 'tool_result', payload: { id: 'dc-tool-1', result: 'ok', isError: false }, delay: 800 },
  { type: 'usage', payload: { total: 1234 }, delay: 200 },
  { type: 'token', payload: { delta: '写好了。' }, delay: 500 },
  { type: 'token', payload: { delta: '完成。' }, delay: 300 },
  { type: 'done', payload: { content: '我来写个文件。写好了。完成。' }, delay: 600 },
]
const presentRun = (file, name) => [
  { type: 'desk_present', payload: { views: [{ type: 'file', path: file, name }], size: 'card', note: 'probe' }, delay: 300 },
  { type: 'token', payload: { delta: '放上 Desk 了。' }, delay: 300 },
  { type: 'done', payload: { content: '放上 Desk 了。' }, delay: 300 },
]
const QUICK_RUN = [{ type: 'token', payload: { delta: '好。' }, delay: 200 }, { type: 'done', payload: { content: '好。' }, delay: 200 }]

// ── DOM 探针 ──────────────────────────────────────────────────────────────────────────
const DESK = `(() => {
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' }
  const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  const cards = [...document.querySelectorAll('.agent-desk-card:not([data-team-desk])')].map((c) => {
    const slot = c.querySelector('[data-companion]')
    const cv = slot && slot.querySelector('canvas')
    return {
      session: c.dataset.deskSession, gone: c.classList.contains('gone'), visible: vis(c),
      title: ((c.querySelector('.agent-desk-card-title') || {}).textContent || '').trim(),
      companion: slot ? slot.dataset.companion : null, surface: slot ? slot.dataset.surface : null,
      canvas: cv ? { w: cv.width, h: cv.height, css: rect(cv) } : null, body: rect(c.querySelector('.agent-desk-card-body')),
      clearBtn: !!c.querySelector('button[title="清空 Desk"], button[title="Clear Desk"]'),
      expandBtn: !!c.querySelector('button[title="展开"], button[title="Expand"]'),
      filePanes: c.querySelectorAll('.agent-desk-pane:not(.agent-desk-companion)').length,
      rect: rect(c),
    }
  })
  const panels = [...document.querySelectorAll('.agent-desk')].map((p) => {
    const slot = p.querySelector('[data-companion]')
    const cv = slot && slot.querySelector('canvas')
    return {
      session: p.dataset.deskSession, open: p.classList.contains('open'), visible: vis(p),
      companion: slot ? slot.dataset.companion : null, surface: slot ? slot.dataset.surface : null,
      canvas: cv ? { w: cv.width, h: cv.height, css: rect(cv) } : null,
      filePanes: p.querySelectorAll('.agent-desk-pane:not(.agent-desk-companion)').length,
      text: (p.innerText || '').slice(0, 400),
    }
  })
  const slots = [...document.querySelectorAll('[data-companion]')].map((s) => ({ key: s.dataset.companion, surface: s.dataset.surface, visible: vis(s) }))
  const ta = document.querySelector('.t2c-ta')
  return { cards, panels, slots, composer: ta ? ta.value : null }
})()`
const SNAP = `(() => {
  const k = Object.keys(localStorage).find((x) => x.includes('forsion.deskBySession'))
  if (!k) return {}
  try { return JSON.parse(localStorage.getItem(k) || '{}') } catch (e) { return { __bad: true } }
})()`

const deskState = (win) => win.evaluate(DESK)
const probeState = (win) => win.evaluate(() => (window.__deskProbe ? JSON.parse(JSON.stringify(window.__deskProbe)) : null))

async function waitFor(win, fn, arg, timeout = 15_000) {
  return win.waitForFunction(fn, arg, { timeout, polling: 150 }).then(() => true, () => false)
}

async function dismissToasts(win) {
  for (let i = 0; i < 8; i += 1) {
    const btn = win.locator('.ntf-close').first()
    if (!(await btn.count().catch(() => 0))) break
    await btn.click({ timeout: 2_000 }).catch(() => {})
    await sleep(150)
  }
}

async function shoot(win, shots, name) {
  await dismissToasts(win)
  await win.mouse.move(700, 20).catch(() => {})
  await sleep(500)
  const p = path.join(SHOT_DIR, `${name}.png`)
  await win.screenshot({ path: p })
  shots[name] = p
}

async function send(win, text) {
  const ta = win.locator('.t2c-ta').first()
  for (let i = 0; i < 40; i++) {
    if (await ta.isEnabled().catch(() => false)) break
    await sleep(250)
  }
  await ta.click()
  await ta.fill(text)
  await ta.press('Enter')
}

/** 回到新对话草稿:启动若恢复了某个会话,点侧栏「新对话」。 */
async function ensureDraft(win) {
  await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
  for (let i = 0; i < 40; i++) {
    if (await win.locator(`.agent-desk-card[data-desk-session="${DRAFT}"]`).count().catch(() => 0)) return true
    if (i === 8 || i === 20) {
      const b = win.locator('button[data-act="new-chat"]').first()
      if (await b.count().catch(() => 0)) await b.click().catch(() => {})
    }
    await sleep(400)
  }
  return false
}

async function openSessionRow(win, title, sid) {
  for (let i = 0; i < 20; i++) {
    const row = win.locator('.t2s-srow, .t2o-row').filter({ hasText: title }).first()
    if (await row.count().catch(() => 0)) { await row.click().catch(() => {}); break }
    await sleep(400)
  }
  const ok = await waitFor(win, (s) => !!document.querySelector(`.agent-desk-card[data-desk-session="${s}"]`), sid, 10_000)
  if (!ok) {
    const rows = await win.evaluate(() => [...document.querySelectorAll('.t2s-srow, .t2o-row, [data-session-id]')].map((e) => `${e.className}|${e.getAttribute('data-session-id') || ''}|${(e.textContent || '').trim().slice(0, 40)}`)).catch(() => [])
    console.log(`(诊断)找不到会话行「${title}」;侧栏行:${JSON.stringify(rows.slice(0, 30))}`)
    await win.screenshot({ path: path.join(SHOT_DIR, 'diag-session-row.png') }).catch(() => {})
  }
  return ok
}

async function reloadApp(win) {
  await win.reload({ waitUntil: 'domcontentloaded' })
  await win.waitForSelector('#root', { timeout: 40_000 })
}

/** 按连续去重后的 phase 列表找有序子序列。 */
function orderedSubsequence(list, want) {
  let i = 0
  for (const x of list) if (x === want[i]) i += 1
  return i === want.length
}
const dedupe = (arr) => arr.filter((x, i) => i === 0 || x !== arr[i - 1])

async function run(app, win, stub, env) {
  const shots = {}
  win.setDefaultTimeout(20_000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960))
  await win.waitForSelector('#root', { timeout: 40_000 })
  await sleep(2500)
  for (const label of ['跳过引导', 'Skip']) {
    const b = win.locator(`text=${label}`).first()
    if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
  }
  await win.waitForSelector('.dv-groupview', { timeout: 40_000 })

  // ── A 探针禁用:纯草稿修复 ──────────────────────────────────────────────────────────
  await win.evaluate((id) => {
    localStorage.setItem('forsion_default_space', 'tangu')
    localStorage.removeItem('forsion_tangu_session_mode')
    localStorage.setItem('forsion_theme_pref', 'light')
    localStorage.setItem('amadeus.plugins.disabled', JSON.stringify([id]))
    localStorage.removeItem('deskprobe.mode')
  }, PROBE_ID)
  await reloadApp(win)
  const draftA = await ensureDraft(win)
  await sleep(1200)
  let st = await deskState(win)
  let pr = await probeState(win)
  let card = st.cards.find((c) => c.session === DRAFT)
  check('A 探针禁用:新对话草稿有 Desk 卡(在场、未退场)且没有伴随面槽',
    draftA && !!card && card.visible && !card.gone && st.slots.length === 0 && (!pr || pr.setups === 0),
    JSON.stringify({ draft: draftA, card: card && { visible: card.visible, gone: card.gone, title: card.title }, slots: st.slots.length, probeSetups: pr && pr.setups }))
  if (!draftA || !card) throw new StopEarly('草稿态没有 Desk 卡 —— 后面全部依赖它')

  // ── 1 探针启用:草稿卡里的伴随面 ─────────────────────────────────────────────────────
  await win.evaluate(() => localStorage.setItem('amadeus.plugins.disabled', '[]'))
  await reloadApp(win)
  await ensureDraft(win)
  const slotReady = await waitFor(win, ([d, k]) => !!document.querySelector(`.agent-desk-card[data-desk-session="${d}"] [data-companion="${k}"] canvas`), [DRAFT, PROBE_KEY], 20_000)
  await sleep(600)
  st = await deskState(win)
  pr = await probeState(win)
  if (!pr) throw new StopEarly('探针插件没装上(window.__deskProbe 不存在)')
  check('1a 探针拿到 ctx.desk / ctx.tangu.agentStatus / ctx.tangu.startChat', pr.hasDesk && pr.hasAgentStatus && pr.hasStartChat,
    JSON.stringify({ hasDesk: pr.hasDesk, hasAgentStatus: pr.hasAgentStatus, hasStartChat: pr.hasStartChat }))
  card = st.cards.find((c) => c.session === DRAFT)
  const cv = card && card.canvas
  check('1 草稿卡含伴随面槽(data-companion=plugin:desk-probe:main, surface=desk-card)且 canvas 非零',
    slotReady && !!card && !card.gone && card.companion === PROBE_KEY && card.surface === 'desk-card' && cv && cv.w > 0 && cv.h > 0 && cv.css.w > 0 && cv.css.h > 0,
    JSON.stringify({ companion: card && card.companion, surface: card && card.surface, canvas: cv, body: card && card.body }))
  // 读活着的挂载点此刻的 host.sessionId() / host.status():启动时应用偶尔先恢复一个旧会话、再被 ensureDraft
  // 切回草稿(同一个卡片实例、不重挂),所以「挂载那一刻」的快照不一定是草稿 —— 断言草稿态下的现值。
  const liveNow = await win.evaluate(() => window.__deskProbeLive())
  const mi = liveNow.find((x) => x.surface === 'desk-card')
  check('1b 草稿态下 host.sessionId() = null、host.status() = idle(sessionId null)', liveNow.length === 1 && !!mi && mi.phase === 'idle' && mi.sessionId === null && mi.statusSession === null,
    JSON.stringify({ live: liveNow, mounts: pr.mountInfo }))
  check('1c 伴随面格撑满卡片正文(canvas 与正文同尺寸,±2px)',
    !!(cv && card.body) && Math.abs(cv.css.w - card.body.w) <= 2 && Math.abs(cv.css.h - card.body.h) <= 2,
    JSON.stringify({ canvas: cv && cv.css, body: card && card.body }))
  await shoot(win, shots, 'probe-draft-light')

  // ── 2 一轮 run:phase 序列 + 草稿 → 真会话不重挂 ─────────────────────────────────────
  const m0 = pr.mounts
  const u0 = pr.unmounts
  const ph0 = pr.phases.length
  const runs0 = stub.seen.runs.length
  stub.script(RUN_MAIN)
  if (NC === 'remount') await win.evaluate(() => window.__deskProbeArm())
  await send(win, '伴随面探针:第一轮')
  const gotSession = await waitFor(win, () => !!document.querySelector('.agent-desk-card[data-desk-session^="dc-s"]'), null, 15_000)
  st = await deskState(win)
  const sid = (st.cards.find((c) => /^dc-s/.test(c.session || '')) || {}).session || null
  const doneSeen = await waitFor(win, (n) => (window.__deskProbe.phases.slice(n).some((p) => p.phase === 'done')), ph0, 20_000)
  const idleSeen = await waitFor(win, (n) => {
    const ps = window.__deskProbe.phases.slice(n)
    const d = ps.findIndex((p) => p.phase === 'done')
    return d >= 0 && ps.slice(d + 1).some((p) => p.phase === 'idle')
  }, ph0, 9_000)
  pr = await probeState(win)
  const newPhases = pr.phases.slice(ph0).filter((p) => p.surface === 'desk-card')
  const seq = dedupe(newPhases.filter((p) => p.sessionId === sid).map((p) => p.phase))
  check('2 新会话建出,Desk 卡换成真会话键(同一张卡)', gotSession && !!sid && stub.seen.runs.length === runs0 + 1, JSON.stringify({ sid, runs: stub.seen.runs.length - runs0 }))
  check('2a phase 有序经过 thinking → tool → speaking → done', doneSeen && orderedSubsequence(seq, ['thinking', 'tool', 'speaking', 'done']), JSON.stringify(seq))
  // 收尾那一刻:appStore 的 'done' 分支先把气泡标 done(patchMessage)、后 endRun 清 running —— 两次 set 之间
  // runningBySession 仍在、却已没有 streaming 气泡 → agentStatusOf 落到 ⑤ 兜底 thinking,订阅方收到一帧假 thinking。
  const lastSpeak = seq.lastIndexOf('speaking')
  const tail = newPhases.filter((p) => p.sessionId === sid)
  const tDone = (tail.find((p) => p.phase === 'done') || {}).t
  const tFlash = ([...tail].reverse().find((p) => p.phase === 'thinking' && tDone != null && p.t <= tDone) || {}).t
  check('2e 收尾不闪回 thinking(最后一个 speaking 之后直接 done)', lastSpeak >= 0 && seq[lastSpeak + 1] === 'done',
    `${JSON.stringify(seq.slice(Math.max(0, lastSpeak)))}${tFlash != null && tDone != null ? `  thinking→done 间隔 ${tDone - tFlash}ms` : ''}`)
  const dI = newPhases.findIndex((p) => p.phase === 'done')
  const iI = dI >= 0 ? newPhases.findIndex((p, i) => i > dI && p.phase === 'idle') : -1
  const hold = dI >= 0 && iI >= 0 ? newPhases[iI].t - newPhases[dI].t : null
  check('2b done 余韵约 4s 后回 idle(3.5s–6s)', idleSeen && hold != null && hold >= 3500 && hold <= 6000, `hold=${hold}ms`)
  check('2c 工具阶段带工具名 write_file', newPhases.some((p) => p.phase === 'tool' && p.tool === 'write_file'), '')
  check('2d 草稿 → 真会话**不重挂**(mount / unmount 计数不变)', pr.mounts === m0 && pr.unmounts === u0,
    `mounts ${m0}→${pr.mounts}, unmounts ${u0}→${pr.unmounts}${NC ? `  (负对照 --nc=${NC}:期望这里 FAIL)` : ''}`)
  if (!sid) throw new StopEarly('没拿到新会话 id')
  const sidTitle = (env.created.find((s) => s.id === sid) || {}).title || ''

  // ── 3 idle 模式 + Desk 条目 ────────────────────────────────────────────────────────
  const m3 = pr.mounts
  const u3 = pr.unmounts
  stub.script(presentRun(env.fileA, 'desk-a.md'))
  await send(win, '把 desk-a 放上 Desk')
  const itemShown = await waitFor(win, (s) => {
    const c = document.querySelector(`.agent-desk-card[data-desk-session="${s}"]`)
    return !!c && /desk-a\.md/.test(c.textContent || '') && !c.querySelector('[data-companion]')
  }, sid, 12_000)
  await sleep(500)
  st = await deskState(win)
  pr = await probeState(win)
  card = st.cards.find((c) => c.session === sid)
  check('3 idle + desk_present:卡片演文件(desk-a.md),伴随面让位', itemShown && !!card && !card.gone && card.title === 'desk-a.md' && card.companion === null && card.filePanes >= 1 && pr.unmounts === u3 + 1,
    JSON.stringify({ title: card && card.title, companion: card && card.companion, filePanes: card && card.filePanes, unmounts: `${u3}→${pr.unmounts}` }))
  check('3a 卡片头有「清空 Desk」', !!card && card.clearBtn, '')
  await win.locator(btnSel(`.agent-desk-card[data-desk-session="${sid}"]`, T.clear)).first().click().catch(() => {})
  const back = await waitFor(win, ([s, k]) => !!document.querySelector(`.agent-desk-card[data-desk-session="${s}"] [data-companion="${k}"] canvas`), [sid, PROBE_KEY], 6_000)
  await sleep(700) // persistDeskSoon 500ms 防抖
  st = await deskState(win)
  pr = await probeState(win)
  card = st.cards.find((c) => c.session === sid)
  let snap = await win.evaluate(SNAP)
  check('3b 点「清空 Desk」→ 伴随面回场(重新 mount 一次)、条目清空', back && !!card && card.companion === PROBE_KEY && !/desk-a/.test(card.title) && pr.mounts === m3 + 1 && !(snap[sid] && snap[sid].items && snap[sid].items.length),
    JSON.stringify({ companion: card && card.companion, title: card && card.title, mounts: `${m3}→${pr.mounts}`, snapItems: snap[sid] ? snap[sid].items.length : 0 }))
  const wentOther = await openSessionRow(win, '另一个会话', 'dc-other')
  const cameBack = wentOther && await openSessionRow(win, sidTitle, sid)
  await sleep(800)
  st = await deskState(win)
  card = st.cards.find((c) => c.session === sid)
  snap = await win.evaluate(SNAP)
  if (!wentOther || !cameBack) {
    check('3c 切会话往返后条目仍是空的(伴随面在)', false, `侧栏切会话失败 other=${wentOther} back=${cameBack} title=${sidTitle}`)
  } else {
    check('3c 切会话往返后条目仍是空的(伴随面在)', !!card && card.companion === PROBE_KEY && card.filePanes === 0 && !/desk-a/.test(card.title) && !(snap[sid] && snap[sid].items && snap[sid].items.length),
      JSON.stringify({ companion: card && card.companion, filePanes: card && card.filePanes, snap: snap[sid] || null }))
  }

  // ── 4 always 模式 ─────────────────────────────────────────────────────────────────
  pr = await probeState(win)
  const m4 = pr.mounts
  const u4 = pr.unmounts
  await win.evaluate(() => window.__deskProbeSetMode('always'))
  await sleep(500)
  await win.evaluate(() => window.__deskProbeSetMode('idle'))
  await sleep(500)
  pr = await probeState(win)
  st = await deskState(win)
  card = st.cards.find((c) => c.session === sid)
  check('4d 零条目时 idle ↔ always 切模式不重挂', pr.mounts === m4 && pr.unmounts === u4 && !!card && card.companion === PROBE_KEY, `mounts ${m4}→${pr.mounts}, unmounts ${u4}→${pr.unmounts}`)

  stub.script(presentRun(env.fileA, 'desk-a.md'))
  await send(win, '再把 desk-a 放上 Desk')
  await waitFor(win, (s) => /desk-a\.md/.test((document.querySelector(`.agent-desk-card[data-desk-session="${s}"]`) || {}).textContent || ''), sid, 12_000)
  await sleep(700)
  await win.evaluate(() => window.__deskProbeSetMode('always'))
  const alwaysCard = await waitFor(win, ([s, k]) => !!document.querySelector(`.agent-desk-card[data-desk-session="${s}"] [data-companion="${k}"] canvas`), [sid, PROBE_KEY], 6_000)
  await sleep(400)
  st = await deskState(win)
  card = st.cards.find((c) => c.session === sid)
  snap = await win.evaluate(SNAP)
  const itemsKept = snap[sid] && snap[sid].items ? snap[sid].items.map((it) => it.name) : []
  check('4 always:Desk 有条目(desk-a 仍在快照里)卡片也演伴随面、无「清空 Desk」', alwaysCard && !!card && card.companion === PROBE_KEY && card.filePanes === 0 && !card.clearBtn && itemsKept.includes('desk-a.md'),
    JSON.stringify({ companion: card && card.companion, filePanes: card && card.filePanes, clearBtn: card && card.clearBtn, snapItems: itemsKept }))
  await win.locator(btnSel(`.agent-desk-card[data-desk-session="${sid}"]`, T.expand)).first().click().catch(() => {})
  const panelUp = await waitFor(win, ([s, k]) => !!document.querySelector(`.agent-desk.open[data-desk-session="${s}"] [data-companion="${k}"][data-surface="desk-panel"] canvas`), [sid, PROBE_KEY], 6_000)
  await sleep(900) // flex-basis 0.45s 过渡走完再量
  st = await deskState(win)
  card = st.cards.find((c) => c.session === sid)
  const panel = st.panels.find((p) => p.session === sid)
  const visSlots = st.slots.filter((s) => s.visible)
  check('4a 展开 → 侧板演伴随面(surface=desk-panel,canvas 非零),卡片退场;可见伴随面恰好 1 个',
    panelUp && !!panel && panel.open && panel.companion === PROBE_KEY && panel.surface === 'desk-panel' && panel.canvas && panel.canvas.w > 0 && panel.canvas.h > 0 && panel.filePanes === 0
      && !!card && card.gone && !card.companion && visSlots.length === 1 && visSlots[0].surface === 'desk-panel',
    JSON.stringify({ panel: panel && { open: panel.open, surface: panel.surface, canvas: panel.canvas, filePanes: panel.filePanes }, cardGone: card && card.gone, visibleSlots: visSlots }))
  await shoot(win, shots, 'probe-always-panel-light')
  pr = await probeState(win)
  const runsBefore4b = stub.seen.runs.length
  stub.script(presentRun(env.fileB, 'desk-b.md'))
  await send(win, '把 desk-b 放上 Desk')
  await waitFor(win, (n) => window.__deskProbe.phases.slice(n).some((p) => p.phase === 'done' && p.surface === 'desk-panel'), pr.phases.length, 10_000)
  await sleep(800)
  st = await deskState(win)
  snap = await win.evaluate(SNAP)
  const names4b = snap[sid] && snap[sid].items ? snap[sid].items.map((it) => it.name) : []
  const panel4b = st.panels.find((p) => p.session === sid)
  check('4b always 下 agent 的 desk_present 不落条目(快照仍只有 desk-a)、侧板仍是伴随面',
    stub.seen.runs.length === runsBefore4b + 1 && !names4b.includes('desk-b.md') && names4b.includes('desk-a.md') && !!panel4b && panel4b.companion === PROBE_KEY && !/desk-b/.test(panel4b.text),
    JSON.stringify({ snapItems: names4b, panelCompanion: panel4b && panel4b.companion }))
  await win.locator(btnSel(`.agent-desk[data-desk-session="${sid}"]`, T.collapse)).first().click().catch(() => {})
  await sleep(900)
  await win.evaluate(() => window.__deskProbeSetMode('idle'))
  const idleBack = await waitFor(win, (s) => {
    const c = document.querySelector(`.agent-desk-card[data-desk-session="${s}"]`)
    return !!c && !c.classList.contains('gone') && /desk-a\.md/.test(c.textContent || '') && !c.querySelector('[data-companion]')
  }, sid, 6_000)
  st = await deskState(win)
  card = st.cards.find((c) => c.session === sid)
  check('4c 收起并切回 idle → 恢复旧行为:卡片演 desk-a、有「清空 Desk」、没有伴随面', idleBack && !!card && card.title === 'desk-a.md' && card.clearBtn && !card.companion,
    JSON.stringify({ title: card && card.title, clearBtn: card && card.clearBtn, companion: card && card.companion }))

  // ── 5 startChat ──────────────────────────────────────────────────────────────────
  const PROMPT_A = '探针预填:请识别这个模型'
  const PROMPT_B = '探针直发:请识别这个模型'
  const PROMPT_C = '别家 Agent:只该预填'
  let r0 = stub.seen.runs.length
  let res = await win.evaluate((o) => window.__deskProbeStartChat(o), { agent: PROBE_AGENT, prompt: PROMPT_A, send: false })
  await waitFor(win, (p) => (document.querySelector('.t2c-ta') || {}).value === p, PROMPT_A, 6_000)
  await sleep(1000)
  st = await deskState(win)
  check('5 send:false(自家 Agent)→ 回 ok、主区回到草稿、输入框预填、不起 run',
    res && res.ok && !res.sessionId && st.composer === PROMPT_A && st.cards.some((c) => c.session === DRAFT) && stub.seen.runs.length === r0,
    JSON.stringify({ res, composer: st.composer, runs: stub.seen.runs.length - r0, cards: st.cards.map((c) => c.session) }))
  stub.script(QUICK_RUN)
  await win.locator('.t2c-ta').first().click()
  await win.locator('.t2c-ta').first().press('Enter')
  for (let i = 0; i < 40 && stub.seen.runs.length === r0; i++) await sleep(200)
  let rn = stub.seen.runs[r0]
  check('5a 预填后按回车 → run 的 agent_config.agentSlug = probe-agent(证明 Agent 已选中)',
    !!rn && rn.message === PROMPT_A && rn.agentConfig && rn.agentConfig.agentSlug === PROBE_AGENT,
    JSON.stringify(rn ? { message: rn.message, agentSlug: rn.agentConfig && rn.agentConfig.agentSlug } : null))
  await sleep(1200)

  r0 = stub.seen.runs.length
  stub.script(QUICK_RUN)
  res = await win.evaluate((o) => window.__deskProbeStartChat(o), { agent: PROBE_AGENT, prompt: PROMPT_B, send: true })
  for (let i = 0; i < 40 && stub.seen.runs.length === r0; i++) await sleep(200)
  rn = stub.seen.runs[r0]
  check('5b send:true(自家捆绑 Agent)→ 直接起 run,agentSlug = probe-agent,回新会话 id',
    res && res.ok && typeof res.sessionId === 'string' && /^dc-s/.test(res.sessionId) && !!rn && rn.message === PROMPT_B && rn.agentConfig && rn.agentConfig.agentSlug === PROBE_AGENT && rn.sessionId === res.sessionId,
    JSON.stringify({ res, run: rn ? { message: rn.message, sessionId: rn.sessionId, agentSlug: rn.agentConfig && rn.agentConfig.agentSlug } : null }))
  await sleep(1200)

  r0 = stub.seen.runs.length
  res = await win.evaluate((o) => window.__deskProbeStartChat(o), { agent: 'xyra', prompt: PROMPT_C, send: true })
  await waitFor(win, (p) => (document.querySelector('.t2c-ta') || {}).value === p, PROMPT_C, 6_000)
  await sleep(1500)
  st = await deskState(win)
  check('5c send:true(别家 Agent xyra)→ 降级为预填,不起 run',
    res && res.ok && !res.sessionId && stub.seen.runs.length === r0 && st.composer === PROMPT_C,
    JSON.stringify({ res, runs: stub.seen.runs.length - r0, composer: st.composer }))
  res = await win.evaluate((o) => window.__deskProbeStartChat(o), { agent: 'no-such-agent', prompt: 'x', send: true })
  check('5d 未知 Agent → ok:false「unknown agent」,不起 run', res && res.ok === false && /unknown agent/.test(res.error || '') && stub.seen.runs.length === r0, JSON.stringify(res))
  const PROMPT_E = '撞名 Agent:只该预填'
  r0 = stub.seen.runs.length
  res = await win.evaluate((o) => window.__deskProbeStartChat(o), { agent: FOREIGN_AGENT, prompt: PROMPT_E, send: true })
  await waitFor(win, (p) => (document.querySelector('.t2c-ta') || {}).value === p, PROMPT_E, 6_000)
  await sleep(1500)
  st = await deskState(win)
  check('5e send:true(自家清单里有、但没有本插件的播种标记 = 撞名)→ 降级为预填,不起 run',
    res && res.ok && !res.sessionId && stub.seen.runs.length === r0 && st.composer === PROMPT_E,
    JSON.stringify({ res, runs: stub.seen.runs.length - r0, composer: st.composer }))
  await win.locator('.t2c-ta').first().fill('').catch(() => {})

  // ── 8 desk_screenshot × 伴随面(09-19 用户实测:agent 看不到 Desk 上渲染出来的形象)──────────────
  // 剧本照搬那次真对话的工具序列:desk_present {view, size:half} → desk_screenshot。伴随面在场时截到的必须是
  // 形象本身(带 companion 标注,让模型知道这不是它放上来的东西),不是报错。
  const shot = (label, events) => deskShot(win, stub, label, events)
  stub.script(QUICK_RUN)
  await send(win, '截图用的会话 8')
  await waitFor(win, () => !!document.querySelector('.agent-desk-card[data-desk-session^="dc-s"] [data-companion]'), null, 12_000)
  await sleep(1500)
  let cap = await shot('8a', [])
  if (cap && cap.png) fs.writeFileSync(path.join(SHOT_DIR, 'capture-8a-probe.png'), cap.png)
  check('8a idle 零条目:截到伴随面(卡片态),回图带 companion 标注而不是报错', !!cap && !!cap.dataUrl && cap.mode === 'card' && cap.companion === PROBE_KEY && !cap.error, JSON.stringify({ ...cap, png: undefined }))
  cap = await shot('8b', [{ type: 'desk_present', payload: { views: [{ type: 'view', view: 'live3d' }], size: 'half', note: '查看模型' }, delay: 300 }])
  check('8b idle + desk_present(view, half) → 截到展开侧板里放上的东西,不再标 companion', !!cap && !!cap.dataUrl && cap.mode === 'open' && !cap.companion && !cap.error, JSON.stringify({ ...cap, png: undefined }))
  const sid8 = await win.evaluate(() => (document.querySelector('.agent-desk[data-desk-session^="dc-s"].open') || document.querySelector('.agent-desk-card[data-desk-session^="dc-s"]') || {}).dataset?.deskSession || null)
  await win.locator(btnSel(`.agent-desk[data-desk-session="${sid8}"]`, T.collapse)).first().click().catch(() => {})
  await sleep(900)
  await win.evaluate(() => window.__deskProbeSetMode('always'))
  await sleep(600)
  cap = await shot('8c', [{ type: 'desk_present', payload: { views: [{ type: 'view', view: 'live3d' }], size: 'half' }, delay: 300 }])
  check('8c always + desk_present(不落条目)→ 截到伴随面,带 companion 标注', !!cap && !!cap.dataUrl && cap.companion === PROBE_KEY && !cap.error, JSON.stringify({ ...cap, png: undefined }))
  await win.evaluate(() => window.__deskProbeSetMode('idle'))
  await sleep(400)

  // ── 6 暗色截图(重载后:草稿卡 → 起一个会话 → always 展开)────────────────────────────
  await win.evaluate(() => { localStorage.setItem('forsion_theme_pref', 'dark'); localStorage.setItem('deskprobe.mode', 'idle') })
  await reloadApp(win)
  await ensureDraft(win)
  await waitFor(win, ([d, k]) => !!document.querySelector(`.agent-desk-card[data-desk-session="${d}"] [data-companion="${k}"] canvas`), [DRAFT, PROBE_KEY], 20_000)
  await sleep(800)
  await shoot(win, shots, 'probe-draft-dark')
  await shotAlwaysPanel(win, stub, shots, 'probe-always-panel-dark', PROBE_KEY, true)

  // ── D 真插件(--plugin)─────────────────────────────────────────────────────────────
  if (PLUGIN_SRC) {
    const id = installRealPlugin(env.pluginsDir, PLUGIN_SRC)
    fs.mkdirSync(path.join(env.home, 'plugins-data'), { recursive: true })
    fs.writeFileSync(path.join(env.home, 'plugins-data', `${id}.json`), JSON.stringify({ mode: 'always', active: null, pending: {} }))
    for (const theme of ['light', 'dark']) {
      await win.evaluate(([pid, th]) => {
        localStorage.setItem('amadeus.plugins.disabled', JSON.stringify([pid]))
        localStorage.setItem('forsion_theme_pref', th)
      }, [PROBE_ID, theme])
      await reloadApp(win)
      await ensureDraft(win)
      const prefix = `plugin:${id}:`
      const up = await waitFor(win, ([d, p]) => {
        const s = document.querySelector(`.agent-desk-card[data-desk-session="${d}"] [data-companion^="${p}"]`)
        return !!s && !!s.querySelector('canvas')
      }, [DRAFT, prefix], 30_000)
      await sleep(3500) // 模型 / 球体首帧
      st = await deskState(win)
      card = st.cards.find((c) => c.session === DRAFT)
      check(`D-${theme} 真插件 ${id}:草稿卡挂上它的伴随面且 canvas 非零`, up && !!card && (card.companion || '').startsWith(prefix) && card.canvas && card.canvas.w > 0 && card.canvas.h > 0,
        JSON.stringify({ companion: card && card.companion, canvas: card && card.canvas }))
      await shoot(win, shots, `${id}-draft-${theme}`)
      await shotAlwaysPanel(win, stub, shots, `${id}-always-panel-${theme}`, prefix, false)
      if (theme === 'light') {
        // 用户实测那条路:always 模式 + agent 先 desk_present(被吞)再 desk_screenshot → 截到的是真插件的形象
        await win.locator(btnSel('.agent-desk.open', T.collapse)).first().click().catch(() => {})
        await sleep(1200)
        const c = await deskShot(win, stub, `D-${id}`, [{ type: 'desk_present', payload: { views: [{ type: 'view', view: id }], size: 'half' }, delay: 300 }])
        if (c && c.png) fs.writeFileSync(path.join(SHOT_DIR, `capture-${id}.png`), c.png)
        check(`D-capture 真插件 ${id}:always + desk_present → desk_screenshot 截到它的伴随面(带 companion),图非空`,
          !!c && !!c.png && c.png.length > 5000 && (c.companion || '').startsWith(prefix) && !c.error, JSON.stringify(c ? { ...c, png: c.png ? c.png.length : 0 } : null))
      }
    }
  }
  return shots
}

/** 让假引擎发一次 desk_capture_request(可先带别的事件),等渲染层回图。回图的 dataUrl 截短后再返回(打日志用),
 *  原图另存 cap.png。**等 run 收尾**再返回:下一句若在 run 进行中发出,只会进队列、不起新 run,剧本就串了。 */
async function deskShot(win, stub, label, events) {
  const n0 = stub.captures.length
  stub.script([...events, { type: 'desk_capture_request', payload: { shotId: `dc-shot-${label}` }, delay: 300 }, { type: 'token', payload: { delta: '看过了。' }, delay: 300 }, { type: 'done', payload: { content: '看过了。' }, delay: 200 }])
  await send(win, `截图 ${label}`)
  for (let i = 0; i < 60 && stub.captures.length === n0; i++) await sleep(200)
  await sleep(1500)
  const c = stub.captures[n0]
  if (!c) return null
  return { ...c, png: c.dataUrl ? Buffer.from(c.dataUrl.split(',')[1], 'base64') : null, dataUrl: c.dataUrl ? `${c.dataUrl.slice(0, 22)}…(${c.dataUrl.length})` : undefined }
}

/** 起一个会话(草稿里发一句)→ 伴随面(探针:切 always;真插件:数据文件已是 always)→ 展开 → 截图。 */
async function shotAlwaysPanel(win, stub, shots, name, keyOrPrefix, isProbe) {
  stub.script(QUICK_RUN)
  await send(win, '截图用的会话')
  const ok = await waitFor(win, () => !!document.querySelector('.agent-desk-card[data-desk-session^="dc-s"]'), null, 12_000)
  if (!ok) { check(`${name} 起会话`, false, '没建出会话'); return }
  await sleep(1500)
  if (isProbe) await win.evaluate(() => window.__deskProbeSetMode('always'))
  await sleep(400)
  // 新会话零条目 + always = U-18 小坞:头行(含「展开」钮)被 CSS 藏掉,点它必然落空(原来 .catch 吞掉 → 本条恒红)。
  // 小坞本身是 role=button(uiux-g):走键盘 —— 聚焦小坞按 Enter 放大,顺带钉住「键盘够得到放大」。
  const cardSel = '.agent-desk-card[data-desk-session^="dc-s"]'
  const headBtn = win.locator(btnSel(cardSel, T.expand)).first()
  if (await headBtn.isVisible().catch(() => false)) await headBtn.click().catch(() => {})
  else {
    const dock = win.locator(`${cardSel}[data-idle][role="button"][tabindex="0"]`).first()
    const dockOk = (await dock.count()) > 0 && !!(await dock.getAttribute('aria-label'))
    check(`6k ${name}:零条目小坞是可聚焦的按钮(role=button、tabindex=0、有可访问名)`, dockOk)
    if (dockOk) {
      await dock.focus()
      await sleep(200)
      await shoot(win, shots, `${name}-dock-focus`) // 焦点环画在盒内(outline-offset:-2px),车道不裁
      await win.keyboard.press('Enter')
    }
  }
  const sel = isProbe ? `[data-companion="${keyOrPrefix}"]` : `[data-companion^="${keyOrPrefix}"]`
  const up = await waitFor(win, (s) => !!document.querySelector(`.agent-desk.open ${s}[data-surface="desk-panel"] canvas`), sel, 10_000)
  await sleep(isProbe ? 900 : 3500)
  const st = await deskState(win)
  const p = st.panels.find((x) => x.open)
  check(`6 ${name}:侧板伴随面在场(canvas 非零),卡片退场`, up && !!p && p.canvas && p.canvas.w > 0 && p.canvas.h > 0 && st.slots.filter((s) => s.visible).length === 1,
    JSON.stringify({ panelCanvas: p && p.canvas, visibleSlots: st.slots.filter((s) => s.visible).length }))
  await shoot(win, shots, name)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  if (PLUGIN_SRC && !fs.existsSync(path.join(PLUGIN_SRC, 'manifest.json'))) {
    console.error(`--plugin ${PLUGIN_SRC} 下没有 manifest.json`)
    process.exit(1)
  }
  if (NC) console.log(`⚠️ 负对照模式 --nc=${NC}:期望相关断言变红\n`)
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-deskcompanion-'))
  const userData = path.join(home, 'userData')
  const vault = path.join(home, 'vault')
  const projectDir = path.join(home, 'Desk Project')
  const pluginsDir = path.join(home, 'plugins')
  for (const dir of [userData, `${userData}-dev`, vault, projectDir, pluginsDir]) fs.mkdirSync(dir, { recursive: true })
  const fileA = path.join(projectDir, 'desk-a.md')
  const fileB = path.join(projectDir, 'desk-b.md')
  fs.writeFileSync(fileA, '# desk-a\n\nDesk companion instrument file A.\n')
  fs.writeFileSync(fileB, '# desk-b\n\nDesk companion instrument file B.\n')
  writeProbe(pluginsDir)
  writeSeededAgents(home)

  const created = []
  let stubRef = null
  const OTHER = {
    id: 'dc-other', title: '另一个会话', summary: '', archived: false, model_id: 'm1', project_path: projectDir, project_name: 'Desk Project',
    projectless: false, agent_config: { execMode: 'host', cwd: projectDir }, created_at: '2026-09-18 09:00:00', updated_at: '2026-09-18 09:00:00',
  }
  const stub = await startStubEngine({
    agents: [
      { slug: 'xyra', name: 'Xyra', description: 'General assistant', createdBy: 'user' },
      { slug: PROBE_AGENT, name: 'Probe Agent', description: 'Bundled agent of the desk-probe instrument plugin', createdBy: 'user' },
      { slug: FOREIGN_AGENT, name: 'Probe Foreign', description: 'Pre-existing agent whose slug collides with the probe bundle', createdBy: 'user' },
    ],
    sessions: [OTHER],
    messages: [],
    override: async ({ path: route, method, body }) => {
      if (route === '/agent/runs' && method === 'GET') return { runs: [] }
      // desk_screenshot 的回图(第 8 组):记下渲染层 POST 回来的 { dataUrl?, mode?, companion?, error? }
      if (/^\/agent\/runs\/[^/]+\/captures\/[^/]+$/.test(route) && method === 'POST') {
        const b = await body()
        stubRef.captures.push({ shotId: route.split('/').pop(), ...b })
        return { ok: true }
      }
      if (route === '/agent/sessions' && method === 'POST') {
        const b = await body()
        const n = created.length + 1
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
        // 新会话一律落进「Desk Project」组(与「另一个会话」同组):第 3 组要在侧栏里点它切回来,
        // 默认工作区 / 无根会话在侧栏里的归组随模式变,不稳定。
        const s = {
          id: `dc-s${n}`, title: `伴随面会话 ${n}`, summary: '', archived: false, model_id: b.model_id || 'm1',
          project_path: projectDir, project_name: 'Desk Project', projectless: false,
          agent_config: { ...(b.agent_config || {}), execMode: 'host', cwd: projectDir }, created_at: now, updated_at: now,
        }
        created.push({ ...s, requested: { project_path: b.project_path || null, projectless: !!b.projectless } })
        stubRef.state.sessions = [s, ...stubRef.state.sessions]
        return { session: s }
      }
      return undefined
    },
  })
  stubRef = stub
  stub.captures = []
  for (const dir of [userData, `${userData}-dev`]) {
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }), 'utf8')
    fs.writeFileSync(path.join(dir, 'amadeus-config.dev.json'), JSON.stringify({ localVault: vault, lastVault: vault }), 'utf8')
  }

  let app
  let shots = null
  const consoleErrors = []
  const pageErrors = []
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
  } catch (e) {
    console.error('隔离 Electron 启动失败;不碰现有应用实例。')
    try { stub.close() } catch { /* ignore */ }
    throw e
  }
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => { pageErrors.push(String((e && e.message) || e).slice(0, 300)); console.error('[renderer pageerror]', String((e && e.stack) || e).slice(0, 600)) })
    win.on('console', (m) => {
      if (m.type() !== 'error') return
      const t = m.text()
      if (/desk-companion|deskprobe|desk-probe/i.test(t)) consoleErrors.push(t.slice(0, 300))
    })
    shots = await run(app, win, stub, { created, fileA, fileB, home, pluginsDir })
    check('7 全程没有 [desk-companion] 控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '))
    if (pageErrors.length) console.log(`(信息)渲染进程 pageerror ${pageErrors.length} 条:${pageErrors.slice(0, 3).join(' || ')}`)
  } catch (e) {
    if (e instanceof StopEarly) { console.error(`STOP  ${e.message}`); check('脚本跑完', false, e.message) }
    else { console.error(e); check('runner 未捕获异常', false, String((e && e.message) || e)) }
  } finally {
    if (app) await app.close().catch(() => {})
    try { stub.close() } catch { /* ignore */ }
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (shots) console.log('SHOTS ' + JSON.stringify(shots, null, 1))
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
