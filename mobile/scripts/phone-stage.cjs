/**
 * Phone stage — `npm run stage:phone` (mobile dir). The Android app's page side in a desktop Chromium, for work on the
 * lists and Home without a build + install round trip on the emulator.
 *
 *   - vite dev (edits hot-reload; nothing is built), a 411 × 914 touch viewport = the emulator's screen in dp;
 *   - the backend answered from fixtures (a signed-in account, sessions with summaries, agents, projects);
 *   - a stand-in for the native chrome, installed from the page: the engine's own `installNativeChromeHost` (same module
 *     instance as the app, reached through the dev server's URL for that file) plus `applyChromeLayout` with the
 *     emulator's measurements. The shell then behaves as inside the app: no web top bar, two-level navigation, a dock
 *     the page keeps clear of. The capsules themselves are native and not drawn here — only their plates.
 *
 * What it is not: the real thing. Touch feedback, native sheets, the keyboard and the status bar are the emulator's
 * (`npm run emu:nativeshell`); anything that looks right here still gets one look there.
 *
 *   OUT=<dir>     where the screenshots go (default outputs/phone-stage)
 *   ONLY=a,b      scenes to shoot, by name (default: all)
 *   THEME=dark    dark appearance (default light)
 *   KEEP=1        leave the dev server up after the run (prints the URL)
 */
const http = require('http')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { chromium } = (() => {
  try { return require('playwright-core') } catch { /* borrow desktop's */ }
  return require(path.resolve(__dirname, '../../desktop/node_modules/playwright-core'))
})()

const ROOT = path.resolve(__dirname, '..')
const PORT = 5296 // clear of dev 5274 / boot 5279 / noteopen 5283 / editorbar 5285 / drawerdrag 5289 / spacetrap 5291
const URL_ = `http://localhost:${PORT}/`
const OUT = path.resolve(ROOT, process.env.OUT || 'outputs/phone-stage')
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean)
const DARK = process.env.THEME === 'dark'

// The emulator's screen and what its native layer reports (dp): status bar, the capsule row (58), the gesture bar, the
// dock's lane (80). Plates = where the two capsules and the dock sit.
const SCREEN = { width: 411, height: 914 }
const STATUS = 51.8, NAV = 24.2
const LAYOUT = {
  floating: true, status: STATUS, top: STATUS + 58, bottom: NAV + 80,
  plates: [
    { id: 'left', x: 12, y: STATUS + 6, w: 168, h: 46 },
    { id: 'right', x: SCREEN.width - 12 - 98, y: STATUS + 6, w: 98, h: 46 },
    { id: 'dock', x: 12, y: SCREEN.height - NAV - 6 - 68, w: SCREEN.width - 24, h: 68 },
  ],
}

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  for (const root of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]) {
    if (!fs.existsSync(root)) continue
    for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
      ]) { const e = path.join(root, d, rel); if (fs.existsSync(e)) return e }
  }
  for (const exe of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(exe)) return exe
  }
  throw new Error('no chromium found; set CHROMIUM_EXE')
}
const ping = () => new Promise((res) => {
  const req = http.get(URL_, (r) => { res(r.statusCode === 200); r.resume() })
  req.on('error', () => res(false)); req.setTimeout(1500, () => { req.destroy(); res(false) })
})

// ── fixtures: what a used account looks like (the lists are judged on real-looking rows, not on two placeholders) ──
const T0 = Date.now()
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR
const iso = (ago) => new Date(T0 - ago).toISOString()
const session = (id, title, ago, extra = {}) => ({
  id, title, summary: null, model_id: null, archived: false, emoji: null, agent_config: { execMode: 'host', approvalMode: 'auto-edit' },
  project_path: null, project_name: null, projectless: true, created_at: iso(ago + HOUR), updated_at: iso(ago), ...extra,
})
const inProject = (name) => ({ project_path: `/work/${name}`, project_name: name, projectless: false })
const SESSIONS = [
  session('st-1', '发版说明草稿', 4 * MIN, { emoji: '📝', summary: '把 2.13.2 的改动按「新功能 / 修复」分成两段，等你确认措辞。', ...inProject('Forsion-Genesis') }),
  session('st-2', '周末去哪儿', 38 * MIN, { emoji: '🧭', summary: '莫干山两天一夜：周六上午出发，民宿已经比了三家。' }),
  session('st-3', '登录页验证码不显示', 3 * HOUR, { emoji: '🐞', summary: '根因是图片地址拼了两次前缀，已经改好并补了一条测试。', ...inProject('server') }),
  session('st-4', '读书笔记：《置身事内》', 7 * HOUR, { summary: '第三章讲土地财政，摘了五条可以直接引用的原话。' }),
  session('st-5', '帮我看看这张体检单', DAY + 2 * HOUR, { emoji: '🩺' }),
  session('st-6', '官网文档中心的英文版', DAY + 5 * HOUR, { summary: '42 页里先翻「快速开始」这 6 页，术语表在第一条消息里。', ...inProject('Forsion-Website') }),
  session('st-7', '年终总结提纲', 3 * DAY, { emoji: '🗂️', summary: '三个部分：做成了什么、没做成什么、明年只做哪三件。' }),
  session('st-8', 'A very long English title that should be cut with an ellipsis at the end', 5 * DAY, { summary: 'Second line in English, also long enough that it has to be cut somewhere before the edge.' }),
  session('st-9', '租房合同里的坑', 9 * DAY, { emoji: '🏠', summary: '押金条款和提前退租那两条要改，改法写在最后一条里。' }),
  session('st-10', '给妈妈的生日礼物', 16 * DAY),
  session('st-11', '学 Rust 的第 12 天', 23 * DAY, { emoji: '🦀', summary: '生命周期标注还是没懂，明天从借用检查器的报错读起。', ...inProject('rust-notes') }),
  session('st-12', '搬家清单', 40 * DAY, { summary: '还差：网线、窗帘杆、两只收纳箱。' }),
  // a private chat with an agent and a team's session: they give those first-level rows a "last active" time
  session('st-solo', '研究员', 2 * HOUR, { agent_config: { execMode: 'host', approvalMode: 'auto-edit', soloAgentSlug: 'researcher' } }),
  session('st-team', '周报小组', 2 * DAY, { agent_config: { execMode: 'host', approvalMode: 'auto-edit', teamSlug: 'weekly', groupChat: true } }),
]
const MESSAGES = [
  { id: 'st-m1', role: 'user', content: '把这次的改动整理成发版说明。', reasoning: null, tool_calls: null, tool_results: null, attachments: null, timestamp: T0 - 6 * MIN, model_id: null, is_error: false },
  { id: 'st-m2', role: 'model', content: '好的。按「新功能」和「修复」分成两段，先给你一版草稿。', reasoning: null, tool_calls: null, tool_results: null, attachments: null, timestamp: T0 - 5 * MIN, model_id: null, is_error: false },
]
// A reply the way an agent writes one — a list inside a list, a numbered list that reaches two digits. The chat page is
// judged on it (st-3); st-1 keeps its two short lines for the scenes that need a conversation shorter than the screen.
const LINK_PR = 'https://github.com/Changan-Su/Forsion/pull/153'
// what the engine answers for that link (GET /agent/link-preview): the rich card's data
const LINK_PREVIEW = { source: 'github', kind: 'pr', repo: 'Changan-Su/Forsion', number: 153, title: 'Fix the asset URL prefix', state: 'merged', author: 'Changan-Su', at: new Date(T0 - DAY).toISOString(), additions: 9, deletions: 6, changedFiles: 2 }
const CHAT_MESSAGES = [
  { ...MESSAGES[0], id: 'st-c1', content: '登录页的验证码图片不显示了，帮我查一下原因。' },
  { ...MESSAGES[1], id: 'st-c2', content: ['先说结论：验证码不显示是因为图片地址被拼了两次前缀。', '', '- 开发环境走代理，前缀由 `BACKEND_URL` 决定', '  - 本机 dev', '  - 预览包', '- 生产环境同源，所以线上一直没事', '', '改法两步：', '', '9. 改 `shared/assetUrl.ts`', '10. 补一条测试', '', `同样的毛病在 [#153](${LINK_PR}) 里修过一次。`].join('\n') },
  { ...MESSAGES[0], id: 'st-c3', content: '把改了的三处列成表。', timestamp: T0 - 3 * MIN },
  // a table wider than the screen (five columns, one cell a sentence), one that fits (two columns), a code block,
  // and a reply that thought first: the "thinking" row
  { ...MESSAGES[1], id: 'st-c4', timestamp: T0 - 2 * MIN, reasoning: '用户要一张表。三处改动各一行：文件、改动、行数、风险、测试。',
    content: ['| 文件 | 改动 | 行数 | 风险 | 测试 |', '|---|---|---|---|---|', '| `auth/captcha.ts` | 返回相对路径，不带前缀 | +3 −5 | 低 | 新增 1 条 |', '| `shared/assetUrl.ts` | 已带前缀的地址不再重复拼，其余地址照旧按环境加前缀 | +6 −1 | 中，全站在用 | 已有 14 条全过 |', '| `auth/login.html` | 图片加载失败时给出「点击重试」 | +11 −0 | 低 | 手动点过 |', '',
      '两个环境的差别：', '', '| 环境 | 前缀 |', '|---|---|', '| 开发 | `/api` |', '| 生产 | 空 |', '',
      '```ts', "export const buildAssetUrl = (path: string, base = ''): string => path.startsWith(`${base}/api/`) ? path : `${base}/api/${path}`", '```'].join('\n') },
]
const AGENTS = [
  { slug: 'researcher', name: '研究员', description: '查资料、读长文、列出处' },
  { slug: 'editor', name: '编辑', description: '改稿、压字数、统一口吻' },
]
const TEAMS = [{ slug: 'weekly', name: '周报小组', description: '', lead: '', avatar: '', members: [{ slug: 'researcher', role: '' }, { slug: 'editor', role: '' }], createdAt: iso(30 * DAY), doc: '', libraryDir: '' }]
const PROJECTS = [{ name: 'Forsion-Genesis' }, { name: 'server' }, { name: 'Forsion-Website' }, { name: 'rust-notes' }]
const MODELS = [
  { id: 'stage-model-a', name: 'Stage Model A', provider: 'Stage', source: 'forsion', modelType: 'llm' },
  { id: 'stage-model-b', name: 'Stage Model B', provider: 'Stage', source: 'forsion', modelType: 'llm' },
]

// The phone's inbox is device-local (desktop/frontend/src/services/localInbox.ts): rows as the periodic pull stores them —
// broadcasts from the server, so every sender is Forsion. One of each thing a row or the reader has to lay out: a
// markdown body, a reward with claim conditions, a subject too long for the line. (The feedback conversation is not
// offered on a phone — `feedbackThreadAvailable` — so a feedback notice is just a message here.)
// The list groups mail by sender (2026-10-14), so one older, read system notice is here too: a second group, folded
// because nothing in it is unread.
const utc = (ago) => new Date(T0 - ago).toISOString().slice(0, 19).replace('T', ' ')
const mail = (id, title, body, ago, extra = {}) => ({
  id, title, body, sender_kind: 'server', sender_id: null, origin_broadcast_id: `b-${id}`, read_at: null, archived_at: null,
  deleted_at: null, created_at: utc(ago), ...extra,
})
const INBOX = [
  mail('ib-1', '2.13 更新了什么', ['这一版把收件箱翻新了一遍，列表里能直接看到正文的第一句。', '', '- 信件行改成两行：标题和时间，下面是发信人和正文第一句', '- 阅读面板里发信人在上，标题在下', '- 审批、任务、附件、反馈对话用同一种卡', '', '完整的改动见[更新日志](https://forsion.net/changelog)。'].join('\n'), 20 * MIN),
  mail('ib-2', '国庆更新奖励', '感谢更新到 2.13，附 100 积分和一张重置卡。', 3 * HOUR, {
    attachments: { items: [{ kind: 'points', amount: 100, label: { zh: '积分 ×100', en: '100 points' } }, { kind: 'reset_card', label: { zh: '重置卡 ×1', en: 'Reset card ×1' } }], claimed: false, requires: { minVersion: '99.0.0', tiers: ['plus', 'pro'] } },
  }),
  mail('ib-3', '你的反馈有新回复', '关于「登录页验证码不显示」：已经定位到原因，下个版本修复。', DAY + 2 * HOUR, { read_at: utc(DAY) }),
  mail('ib-4', '会员即将到期', '你的 Plus 会员将在 7 天后到期，续费后权益不中断。', 4 * DAY, { read_at: utc(3 * DAY) }),
  mail('ib-5', 'A long English subject line that has to be cut somewhere before the edge of the screen', 'First sentence in English, also long enough that it has to be cut with an ellipsis on a phone.', 9 * DAY, { read_at: utc(8 * DAY) }),
  mail('ib-6', '云端同步已恢复', '之前失败的 3 个文件已经补传。', 12 * DAY, { sender_kind: 'system', sender_id: 'sync', origin_broadcast_id: null, read_at: utc(11 * DAY) }),
]
/** Answers the API from the fixtures; anything it does not know is refused and listed at the end of the run. */
async function stubApi(page, unknown) {
  const configs = Object.fromEntries(SESSIONS.map((s) => [s.id, { ...s.agent_config }]))
  await page.route('**/*', (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const p = url.pathname
    if (url.origin === new URL(URL_).origin && !/^\/(api|auth|account|shared|oauth|shop|pay|legal)(\/|$)/.test(p)) return route.continue()
    const m = req.method()
    const json = (data) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) })
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } })
    if (p.endsWith('/auth/me')) return json({ username: 'stage', id: 'stage' })
    if (p.endsWith('/health')) return json({ ok: true, sandbox: 'stage' })
    if (p.endsWith('/agent/special/config')) return json({})
    if (p.endsWith('/agent/agents') && m === 'GET') return json({ agents: AGENTS })
    if (p.endsWith('/agent/projects') && m === 'GET') return json({ projects: PROJECTS })
    if (p.endsWith('/agent/teams') && m === 'GET') return json({ teams: TEAMS })
    if (p.endsWith('/agent/engines') && m === 'GET') return json({ engines: [] })
    if (p.endsWith('/agent/agents-meta') && m === 'GET') return json({ order: AGENTS.map((a) => a.slug), defaultSlug: AGENTS[0].slug })
    if (p.endsWith('/agent/sessions') && m === 'GET') return json({ sessions: url.searchParams.get('archived') === 'true' ? [] : SESSIONS })
    if (p.endsWith('/agent/runs')) return json({ runs: [] })
    if (p.endsWith('/agent/approvals/pending')) return json({ rev: 'stage', approvals: [] })
    if (p.endsWith('/agent/models') && m === 'GET') return json({ models: MODELS, directProviders: [], defaultModelId: MODELS[0].id })
    if (/\/market\/items$/.test(p)) return json({ items: [] })
    if (p.endsWith('/inbox/broadcasts')) return json({ broadcasts: [] })
    if (/\/agent\/sessions\/[^/]+\/checkpoints$/.test(p)) return json({ checkpoints: [] })
    const cfg = p.match(/\/agent\/sessions\/([^/]+)\/config$/)
    if (cfg) {
      const id = decodeURIComponent(cfg[1])
      if (m === 'PATCH' || m === 'PUT') configs[id] = { ...(m === 'PATCH' ? configs[id] : {}), ...JSON.parse(req.postData() || '{}') }
      return json({ agent_config: configs[id] || {} })
    }
    if (p.endsWith('/agent/link-preview')) return json({ preview: url.searchParams.get('url') === LINK_PR ? LINK_PREVIEW : null })
    if (/\/agent\/sessions\/[^/]+\/messages$/.test(p)) return json({ messages: p.includes('/st-1/') ? MESSAGES : p.includes('/st-3/') ? CHAT_MESSAGES : [] })
    const one = p.match(/\/agent\/sessions\/([^/]+)$/)
    if (one && m === 'PATCH') {
      const row = SESSIONS.find((x) => x.id === decodeURIComponent(one[1]))
      if (row) Object.assign(row, JSON.parse(req.postData() || '{}'))
      return json({ session: row })
    }
    unknown.add(`${m} ${p}`)
    return route.abort()
  })
}

/** The URL the app itself loaded a source file from. Reaching the app's own module instance (its stores, the engine's
 *  chrome seam) needs that exact URL: after an edit the dev server serves a changed module under `?t=<stamp>`, and
 *  the same file imported without it would be a second, empty copy. */
const loaded = new Map() // pathname → full URL, filled from the page's requests
const moduleUrl = (rel) => {
  const abs = path.resolve(ROOT, rel)
  const p = abs.startsWith(ROOT + path.sep) ? `/${path.relative(ROOT, abs).split(path.sep).join('/')}` : `/@fs/${abs.split(path.sep).join('/').replace(/^\/+/, '')}`
  return loaded.get(p) || p
}

/** Installs the stand-in native chrome and returns once the shell has taken it (no web top bar, list-first). */
async function installChrome(page) {
  await page.evaluate(async ({ engineUrl, hostUrl, layout }) => {
    const engine = await import(/* @vite-ignore */ engineUrl)
    const host = await import(/* @vite-ignore */ hostUrl)
    const stage = (window.__stage = { engine, state: null, renders: 0 })
    // like the plugin: the capsules float (and report where they are) only while the shell's own bar is up — a layer that
    // hides the bar (search, onboarding …) gets the plain layout: nothing over the page, nothing to keep clear of
    const plain = { floating: false, status: layout.status, top: 0, bottom: 0, plates: [] }
    // one level down (an item is open: the capsule's left button is "back") the dock is away, as on the device —
    // the plugin then reports no room at the bottom and the page runs to the screen's end
    const detail = { ...layout, bottom: 0, plates: layout.plates.filter((p) => p.id !== 'dock') }
    engine.installNativeChromeHost({ spaces: true, render(state) { stage.state = state; stage.renders++; host.applyChromeLayout(state.mode !== 'shell' ? plain : state.leftBack ? detail : layout) } })
    host.applyChromeLayout(layout)
  }, { engineUrl: moduleUrl('../lcl/engine/nativeChrome.ts'), hostUrl: moduleUrl('src/nativeChrome.ts'), layout: LAYOUT })
  await page.waitForFunction(() => document.querySelector('.mb-shell')?.hasAttribute('data-native-chrome') && !!window.__stage?.state, null, { timeout: 10_000 })
    .catch(() => { throw new Error('the shell did not take the stand-in chrome: the engine module reached from the page is not the app\'s instance') })
  // the capsules are native; here only their plates exist — tint them so a screenshot shows where they are
  await page.addStyleTag({ content: '.nc-plate { background: color-mix(in srgb, var(--surface, #fff) 55%, transparent); outline: 1px solid var(--border, rgba(0,0,0,.1)); }' })
}

// Notes are put straight into the page store (in a browser there is no vault behind it): enough to lay the lists out.
// Drawings go in `files`, never in `pages` — both vault managers list them that way (a drawing parsed as a page
// would be rewritten). With them under `pages` this stage once passed a whiteboards tab that was empty on a device.
const NOTES = {
  folders: ['项目', '读书笔记'],
  pages: ['十月计划.md', '项目/发版清单 2.13.md', '项目/会议纪要 9-30.md', '读书笔记/《置身事内》第三章摘记.md', '读书笔记/《枪炮、病菌与钢铁》.md'],
  files: ['项目/信息架构草图.excalidraw.md', '流程图.excalidraw.md'],
  recents: [['项目/发版清单 2.13.md', 25 * MIN], ['读书笔记/《置身事内》第三章摘记.md', DAY + 3 * HOUR], ['十月计划.md', 3 * DAY], ['项目/信息架构草图.excalidraw.md', 4 * DAY], ['项目/会议纪要 9-30.md', 9 * DAY]],
}
async function seedNotes(page) {
  await page.evaluate(async ({ storeUrl, recentUrl, notes, now }) => {
    const { usePageStore } = await import(/* @vite-ignore */ storeUrl)
    const { useRecentViews } = await import(/* @vite-ignore */ recentUrl)
    usePageStore.setState({ vaultRoot: usePageStore.getState().vaultRoot || '/stage/vault', pages: notes.pages, folders: notes.folders, files: notes.files })
    useRecentViews.setState({ items: notes.recents.map(([id, ago]) => ({ key: `note:${id}`, kind: 'note', id, title: id, ts: now - ago })) })
  }, { storeUrl: moduleUrl('../desktop/frontend/src/amadeus/store/pageStore.ts'), recentUrl: moduleUrl('../desktop/frontend/src/recentViews.ts'), notes: NOTES, now: T0 })
}

/** The inbox rows go where the app keeps them on a phone (localStorage), then the store is asked to read them again. */
async function seedInbox(page, rows = INBOX) {
  await page.evaluate(async ({ storeUrl, ntfUrl, rows }) => {
    localStorage.setItem('tangu_inbox_msgs', JSON.stringify(rows))
    const { useInbox } = await import(/* @vite-ignore */ storeUrl)
    await useInbox.getState().refreshList()
    await useInbox.getState().refreshUnread()
    // rows that appear after the first poll count as new mail: the app puts a notification card up. Not what is looked at here.
    const { useNotifications } = await import(/* @vite-ignore */ ntfUrl)
    useNotifications.getState().dismissAll()
  }, { storeUrl: moduleUrl('../desktop/frontend/src/stores/inboxStore.ts'), ntfUrl: moduleUrl('../desktop/frontend/src/stores/notificationStore.ts'), rows })
  await page.waitForTimeout(400)
}

const stage = {
  state: (page) => page.evaluate(() => window.__stage.state),
  /** Switches Space the way a tap on its dock cell does. */
  space: async (page, id) => { await page.evaluate((x) => window.__stage.engine.dispatchNativeChromeSpace(x), id); await page.waitForTimeout(700) },
  /** A tap on one of the capsule's buttons (`search`, `more`, `back`, `title` …). */
  action: async (page, name) => { await page.evaluate((x) => window.__stage.engine.dispatchNativeChromeAction(x), name); await page.waitForTimeout(500) },
  nav: (page) => page.evaluate(() => document.querySelector('.mb-shell')?.getAttribute('data-nav') || ''),
}

// ── scenes: name → put the app there, look at it (returns [what, ok, detail] rows), then it is shot. ──
const DOCK_TOP = SCREEN.height - NAV - 6 - 68
/** Rectangles are read in viewport px = dp on this stage (the page's own zoom is already inside them). */
const rect = (page, sel, nth = 0) => page.evaluate(([q, i]) => {
  const el = document.querySelectorAll(q)[i]
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height, bottom: r.bottom, right: r.right }
}, [sel, nth])
const texts = (page, sel) => page.evaluate((q) => [...document.querySelectorAll(q)].map((el) => el.textContent.trim()), sel)
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol
const LIST = '.mb-drawer--left'
const CHAT = '.mb-view[data-view="chat"]'
/** From wherever the stage is: Tangu's list, then into the session with that title (rows move: an earlier scene pins one). */
const openChat = async (page, title) => {
  if ((await stage.nav(page)) === 'detail') await stage.action(page, 'left')
  await stage.space(page, 'tangu'); await chip(page, 'all')
  await page.locator(`${LIST} [data-timeline] .t2s-srow`, { hasText: title }).first().tap()
  await page.waitForFunction(() => document.querySelector('.mb-shell')?.getAttribute('data-nav') === 'detail', null, { timeout: 6000 })
  await page.waitForTimeout(600)
}
const chip = async (page, id) => { await page.locator(`${LIST} .pl-chips [data-filter="${id}"]`).tap(); await page.waitForTimeout(400) }

const SCENES = {
  home: async (page) => {
    await stage.space(page, 'home')
    const HOME = '.mb-view[data-view="homepage"]'
    const pill = await rect(page, `${HOME} .hp-pill`)
    const cards = await page.evaluate((q) => [...document.querySelectorAll(q)].map((el) => { const r = el.getBoundingClientRect(); return { name: el.querySelector('.hp-card-name').textContent, status: el.querySelector('.hp-card-status').textContent, w: r.width, h: r.height, bottom: r.bottom } }), `${HOME} .hp-card`)
    const greet = await rect(page, `${HOME} .hp-greet`)
    const composerShown = () => page.evaluate((q) => { const el = document.querySelector(q); return !!el && el.getBoundingClientRect().height > 0 }, `${HOME} .hp-composer`)
    const before = await composerShown()
    return [
      ['the greeting leads, below the capsules', !!greet && greet.y >= LAYOUT.top, JSON.stringify(greet && { y: greet.y })],
      ['four cards, two to a row, the first with what was last worked on', cards.length === 4 && cards.every((c) => c.h >= 103 && near(c.w, cards[0].w)) && cards[0].status === '继续：发版说明草稿', JSON.stringify(cards.map((c) => [c.name, c.status, Math.round(c.h)]))],
      ['the input is one pill above the dock, the full composer hidden', !!pill && near(pill.h, 54) && pill.bottom <= DOCK_TOP - 6 && pill.y > cards[cards.length - 1]?.bottom && !before, JSON.stringify({ pill, before })],
    ]
  },
  'home-open': async (page) => {
    const HOME = '.mb-view[data-view="homepage"]'
    await page.locator(`${HOME} .hp-pill`).tap()
    await page.waitForTimeout(500)
    const focused = await page.evaluate(() => document.activeElement?.matches('.hp-composer .t2c-ta') ?? false)
    const shown = await page.evaluate((q) => { const el = document.querySelector(q); return !!el && el.getBoundingClientRect().height > 0 }, `${HOME} .hp-composer`)
    return [['a tap on the pill opens the full composer with the caret in it; the cards make room', shown && focused && !(await rect(page, `${HOME} .hp-card`))?.h, `focused=${focused}`]]
  },
  'home-closed': async (page) => {
    // something typed, then a touch outside the composer: it folds back into the pill, which now reads what was typed
    await page.keyboard.type('周报草稿')
    await page.touchscreen.tap(200, 200)
    await page.waitForTimeout(400)
    const pill = await rect(page, '.mb-view[data-view="homepage"] .hp-pill')
    const text = (await texts(page, '.mb-view[data-view="homepage"] .hp-pill-text'))[0]
    return [['a touch elsewhere folds the composer back into the pill, which shows the draft', !!pill?.h && text === '周报草稿', `${JSON.stringify(pill)} "${text}"`]]
  },
  'tangu-list': async (page) => {
    await stage.space(page, 'tangu')
    await chip(page, 'all')
    const st = await stage.state(page)
    const row = await rect(page, `${LIST} [data-timeline] .t2s-srow`)
    const lead = await rect(page, `${LIST} [data-timeline] .t2s-srow > .t2s-lead`)
    const fab = await rect(page, `${LIST} .pl-fab`)
    const secs = await texts(page, `${LIST} .pl-sec`)
    const titles = await texts(page, `${LIST} [data-timeline] .t2s-srow-title`)
    const scroller = await page.evaluate((q) => { const el = document.querySelector(q); el.scrollTop = el.scrollHeight; const last = [...el.querySelectorAll('.t2s-srow')].pop().getBoundingClientRect(); el.scrollTop = 0; return { lastBottom: last.bottom } }, `${LIST} .t2s-scroll`)
    return [
      ['list level, with a search button on the capsule', (await stage.nav(page)) === 'list' && !!st.search, `nav=${await stage.nav(page)} search=${st.search}`],
      ['rows are 68 dp, on a 44 dp icon block', !!row && near(row.h, 68) && !!lead && near(lead.w, 44) && near(lead.h, 44), JSON.stringify({ row: row?.h, lead: lead && [lead.w, lead.h] })],
      ['one list by time: sections in order, newest first', secs.join('|') === '今天|昨天|这一周|更早' && titles[0] === '发版说明草稿', `${secs.join('|')} / ${titles.slice(0, 3).join('、')}`],
      ['agents and teams sit in the same list, by their last session', titles.indexOf('研究员') === 2 && titles.includes('周报小组'), String(titles.indexOf('研究员'))],
      ['main button: 58 dp, right 16, clear of the dock', !!fab && near(fab.w, 58) && near(fab.h, 58) && near(SCREEN.width - fab.right, 16) && fab.bottom <= DOCK_TOP - 6, JSON.stringify(fab)],
      ['the last row scrolls clear of the dock and of the main button', scroller.lastBottom <= (fab?.y ?? 0), `last row bottom ${Math.round(scroller.lastBottom)} / button top ${Math.round(fab?.y ?? 0)}`],
    ]
  },
  'tangu-swipe': async (page) => {
    // the gesture itself (a pointer drag on the row's track) is pushed in as pointer events; then the buttons are used
    const sw = `${LIST} [data-timeline] .pl-swipe`
    await page.evaluate(([q, i]) => window.__swipeOpen(document.querySelectorAll(q)[i]), [sw, 1])
    await page.waitForTimeout(700)
    const acts = await page.evaluate((q) => [...document.querySelectorAll(q)[1].querySelectorAll('.pl-swipe-act')].map((b) => { const r = b.getBoundingClientRect(); const cs = getComputedStyle(b); return { id: b.dataset.act, x: r.left, right: r.right, w: r.width, h: r.height, text: b.textContent.trim(), name: b.getAttribute('aria-label') || '', round: parseFloat(cs.borderRadius) >= r.width / 2 - 1, shown: cs.opacity === '1' && (cs.scale === 'none' || cs.scale === '1') } }), sw)
    const shot = await page.screenshot()
    fs.writeFileSync(path.join(OUT, `tangu-swipe-open${DARK ? '-dark' : ''}.png`), shot)
    await page.locator(`${sw} >> nth=1`).locator('[data-act="pin"]').tap()
    await page.waitForTimeout(500)
    const secs = await texts(page, `${LIST} .pl-sec`)
    const first = (await texts(page, `${LIST} [data-timeline] .t2s-srow-title`))[0]
    const closed = await page.evaluate((q) => [...document.querySelectorAll(q)].every((el) => !el.hasAttribute('data-open') && ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(el.firstElementChild).transform)), sw)
    return [
      ['a row slides left onto pin / rename / archive, all on screen', acts.map((a) => a.id).join(',') === 'pin,rename,archive' && acts.every((a) => a.x >= 0 && a.right <= SCREEN.width), JSON.stringify(acts)],
      ['the actions are round 44 dp buttons with an icon only; each has a name for a screen reader; all fully shown once the row rests', acts.every((a) => near(a.w, 44) && near(a.h, 44) && a.round && !a.text && !!a.name && a.shown) && near(SCREEN.width - acts[2].right, 16), JSON.stringify(acts)],
      ['pin: the row moves to a pinned section on top, the tray closes', secs[0] === '置顶' && first === '周末去哪儿' && closed, `${secs[0]} / ${first} / closed=${closed}`],
    ]
  },
  'tangu-search': async (page) => {
    // the capsule's search button (a pull on the list runs the same thing): the palette takes the whole page —
    // the native bar is told to leave (mode hidden), the sheet runs edge to edge under the status bar, no key hints
    await stage.action(page, 'search')
    const st = await stage.state(page)
    const box = await rect(page, '.amx-qf')
    const foot = await rect(page, '.amx-qf-foot')
    const rows = [['search: the palette covers the page and sends the native bar away', st.mode === 'hidden' && !!box && box.w >= SCREEN.width - 24 && box.y <= 12 && !foot, JSON.stringify({ mode: st.mode, box, foot })]]
    await page.screenshot({ path: path.join(OUT, `tangu-search-open${DARK ? '-dark' : ''}.png`) })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    rows.push(['closing it brings the bar back', (await stage.state(page)).mode === 'shell' && !(await rect(page, '.amx-qf')), `mode=${(await stage.state(page)).mode}`])
    return rows
  },
  'tangu-pull': async (page) => {
    // pulling the list down at the top = search, on release only. A pull the system takes over (touchcancel: the
    // notification shade, a back swipe from the edge) opens nothing.
    const pull = (last) => page.evaluate(async ([q, end]) => {
      const el = document.querySelector(q).parentElement // the hint is the scroller's first child
      const at = (y) => [new Touch({ identifier: 1, target: el, clientX: 200, clientY: y })]
      const fire = (type, touches) => el.dispatchEvent(new TouchEvent(type, { touches, changedTouches: at(0), bubbles: true, cancelable: true }))
      fire('touchstart', at(300))
      for (const y of [340, 400, 470]) fire('touchmove', at(y))
      const armed = el.hasAttribute('data-pull-armed')
      fire(end, [])
      await new Promise((r) => setTimeout(r, 400))
      return { armed, open: !!document.querySelector('.amx-qf'), left: el.hasAttribute('data-pull-armed') || !!el.style.getPropertyValue('--pl-pull') }
    }, [`${LIST} [data-timeline] .pl-pull`, last])
    const cancelled = await pull('touchcancel')
    const released = await pull('touchend')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    return [
      ['a pull that is taken away opens nothing and leaves no hint behind', cancelled.armed && !cancelled.open && !cancelled.left, JSON.stringify(cancelled)],
      ['the same pull, let go, opens search', released.armed && released.open, JSON.stringify(released)],
    ]
  },
  'tangu-agent': async (page) => {
    await chip(page, 'agent')
    const titles = await texts(page, `${LIST} [data-timeline] .t2s-srow-title`)
    return [['Agent chip: only the agents', titles.join('、') === '研究员、编辑', titles.join('、')]]
  },
  'tangu-project': async (page) => {
    await chip(page, 'project')
    const groups = await texts(page, `${LIST} .t2s-group-label`)
    const flat = await page.evaluate((q) => !!document.querySelector(q), `${LIST} [data-timeline]`)
    return [['Projects chip: grouped by project as before', !flat && groups.includes('Forsion-Genesis'), groups.join('、')]]
  },
  // The chat page (detail level). Two things a phone does to it that a desktop column never meets. The column is so
  // narrow that the avatars are left out, and a list's bullets and numbers used to hang where the avatars stood — now off
  // the screen. And the keyboard makes the page a third shorter, which used to flip the column's layout: avatars back,
  // the text pushed right and re-wrapped, a short conversation jumping from the input up to the top.
  'chat-lists': async (page) => {
    await openChat(page, '登录页验证码不显示')
    await page.waitForSelector(`${CHAT} .t2-asst .t2-content li`, { timeout: 10_000 })
    const m = await page.evaluate((q) => {
      const root = document.querySelector(q)
      const em = parseFloat(getComputedStyle(root.querySelector('.t2-asst .t2-content')).fontSize) * (Number(getComputedStyle(document.body).zoom) || 1)
      const depth = (el) => { const up = el.parentElement.closest('li'); return up ? depth(up) + 1 : 0 }
      return { em, items: [...root.querySelectorAll('.t2-asst .t2-content li')].map((li) => ({ text: li.textContent.trim().slice(0, 6), left: li.getBoundingClientRect().left, depth: depth(li) })) }
    }, CHAT)
    const top = m.items.filter((i) => !i.depth), inner = m.items.filter((i) => i.depth)
    const brief = JSON.stringify({ em: m.em, items: m.items.map((i) => [i.text, Math.round(i.left * 10) / 10, i.depth]) })
    return [
      // a bullet takes about 1 em before the text, "10." about 1.6 em
      ['every list item leaves its bullet or number room on the screen (text starts 1.7 em in or more)', m.items.length === 6 && m.items.every((i) => i.left >= 1.7 * m.em), brief],
      ['a list inside a list is set further in', inner.length === 2 && inner.every((i) => i.left >= top[0].left + m.em), brief],
    ]
  },
  'chat-keyboard': async (page) => {
    await openChat(page, '发版说明草稿')
    await page.waitForSelector(`${CHAT} .t2-asst .t2-content`, { timeout: 10_000 })
    const look = () => page.evaluate((q) => {
      const root = document.querySelector(q)
      const shown = (el) => el.getClientRects().length > 0
      const last = [...root.querySelectorAll('.t2-stream-inner > .t2-asst, .t2-stream-inner > .t2-userwrap')].pop().getBoundingClientRect()
      return { avatars: [...root.querySelectorAll('.t2-avatar')].filter(shown).length, textLeft: root.querySelector('.t2-asst .t2-content').getBoundingClientRect().left, gap: root.querySelector('.t2c').getBoundingClientRect().top - last.bottom, height: innerHeight }
    }, CHAT)
    const rest = await look()
    // the keyboard: on the device the WebView ends at its top edge, so the page gets that much shorter
    await page.setViewportSize({ width: SCREEN.width, height: SCREEN.height - 300 })
    await page.waitForTimeout(500)
    const up = await look()
    await page.screenshot({ path: path.join(OUT, `chat-keyboard-up${DARK ? '-dark' : ''}.png`) })
    await page.setViewportSize(SCREEN)
    await page.waitForTimeout(400)
    const detail = JSON.stringify({ rest, up })
    return [
      ['at rest the narrow column draws no avatars', rest.avatars === 0, detail],
      ['keyboard up: still none, and the reply\'s text has not moved sideways', up.height === SCREEN.height - 300 && up.avatars === 0 && near(up.textLeft, rest.textLeft, 0.5), detail],
      ['keyboard up: a short conversation still ends at the input, as at rest', near(up.gap, rest.gap, 2), detail],
    ]
  },
  // The input card on a phone: the send key sits beside the text; the row below holds + / model / microphone. The mode
  // key is gone — the model key opens ONE native menu where model, thinking effort and mode each have a page of their
  // own. The menu is native; a stand-in presenter takes its place here, for this scene only (with one installed every
  // other menu of the app goes native too). The composer reads "is there a presenter" when it draws, so the chat is
  // opened after the stand-in is in.
  'chat-card': async (page) => {
    if ((await stage.nav(page)) === 'detail') await stage.action(page, 'left')
    await page.evaluate(async (url) => {
      const st = window.__stage; st.menus = []; st.answer = null
      st.offSheet = (await import(/* @vite-ignore */ url)).installNativeSheetPresenter(async (payload) => {
        st.menus.push(payload)
        const a = st.answer; st.answer = null
        if (a === 'refuse') throw new Error('stage: the host cannot present')
        return a
      })
    }, moduleUrl('../lcl/engine/nativeSheet.ts'))
    await openChat(page, '发版说明草稿')
    await page.waitForSelector(`${CHAT} .t2c-field`, { timeout: 10_000 })
    const look = () => page.evaluate((q) => {
      const root = document.querySelector(q)
      const r = (sel) => { const b = root.querySelector(sel)?.getBoundingClientRect(); return b ? { x: b.left, y: b.top, w: b.width, h: b.height, right: b.right, bottom: b.bottom } : null }
      // does a touch `dy` dp above / below the key's middle still land on the key
      const takes = (sel, dy) => { const el = root.querySelector(sel); const b = el.getBoundingClientRect(); const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2 + dy); return !!at && el.contains(at) }
      const chip = root.querySelector('.model-pill-btn'); const wrap = chip.closest('.model-pill-wrap')
      return {
        modeKey: !!root.querySelector('.mode-pill-btn'), icon: !!chip.querySelector('svg.lucide-bot'), name: chip.querySelector('.pill-marquee')?.textContent || '',
        nameCut: chip.querySelector('.pill-marquee').scrollWidth > chip.querySelector('.pill-marquee').clientWidth + 1,
        danger: wrap.classList.contains('is-danger'), plan: wrap.classList.contains('is-plan'),
        ta: r('.t2c-ta'), send: r('.t2c-field > .t2c-send'), sendInRow: !!root.querySelector('.t2c-row .t2c-send'), row: r('.t2c-row'),
        add: r('.add-pill-btn'), chip: r('.model-pill-btn'), mic: r('.t2c-mic-control'), card: r('.t2c-card'),
        touch: { add: takes('.add-pill-btn', 23) && takes('.add-pill-btn', -23), chip: takes('.model-pill-btn', 23) && takes('.model-pill-btn', -23), mic: takes('.t2c-mic-control', 23) && takes('.t2c-mic-control', -23) },
      }
    }, CHAT)
    const pick = async (answer) => {
      await page.evaluate((a) => { window.__stage.answer = a }, answer)
      const before = await page.evaluate(() => window.__stage.menus.length)
      await page.locator(`${CHAT} .model-pill-btn`).tap()
      await page.waitForFunction((n) => window.__stage.menus.length > n, before, { timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(500)
      return page.evaluate((n) => window.__stage.menus[n] || null, before)
    }
    const shoot = (name) => page.screenshot({ path: path.join(OUT, `${name}${DARK ? '-dark' : ''}.png`) })
    const rest = await look()
    await shoot('chat-card-empty')
    await page.locator(`${CHAT} .t2c-ta`).fill('好，那就今天合。合之前再跑一遍登录相关的测试，把结果贴给我')
    await page.waitForTimeout(300)
    const typed = await look()
    await shoot('chat-card-typed')
    await page.locator(`${CHAT} .t2c-ta`).fill('')
    // the menu the model key opens
    const menu = await pick(null) // null = the user closed it
    const root = (menu?.sections || []).flatMap((x) => x.items)
    const page2 = (id) => (root.find((i) => i.id === id)?.children || []).flatMap((x) => x.items)
    const ids = (items) => items.map((i) => i.id)
    const modeRow = root.find((i) => i.id === 'mode')
    // picks go through the app's own setters: full access turns the model key red, plan mode tints it, a model renames it
    await pick({ id: 'approval:full-auto' }); const full = await look()
    await pick({ id: 'approval:auto-edit' })
    await pick({ id: 'plan-mode' }); const plan = await look()
    await pick({ id: 'plan-mode' })
    await pick({ id: 'model:0:1' }); const other = await look()
    await pick({ id: 'model:0:0' }); const back = await look()
    // a host that cannot present: the mode key comes back (the mode is never out of reach) and the same touch goes on
    // to the model menu the app had before
    await pick('refuse'); await page.waitForTimeout(300)
    const refused = { ...(await look()), modelMenu: await page.evaluate((q) => !!document.querySelector(`${q} .composer-menu--model`), CHAT) }
    await page.keyboard.press('Escape')
    await page.evaluate(() => { window.__stage.offSheet(); delete window.__stage.offSheet })
    const d = (o) => JSON.stringify(o, (k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v))
    return [
      ['no mode key; the model key has no icon and shows the name in full', !rest.modeKey && !rest.icon && rest.name.includes('Stage Model A') && !rest.nameCut, d({ modeKey: rest.modeKey, icon: rest.icon, name: rest.name, nameCut: rest.nameCut })],
      ['the send key sits beside the text, not in the row below; 48 dp', !!rest.send && !rest.sendInRow && rest.send.x >= rest.ta.right && rest.send.bottom <= rest.row.y + 0.5 && rest.send.w >= 47.5 && rest.send.h >= 47.5, d({ ta: rest.ta, send: rest.send, row: rest.row })],
      ['a draft of two lines: the send key stays at the text\'s last line', typed.ta.h > rest.ta.h + 10 && near(typed.send.bottom, typed.ta.bottom, 4), d({ ta: typed.ta, send: typed.send })],
      ['the row below is + · model · microphone: keys 44 dp, the model key 40 dp to the eye in a 48 dp box', rest.add.x < rest.chip.x && rest.chip.right <= rest.mic.x && rest.add.w >= 43.5 && rest.add.h >= 43.5 && rest.mic.w >= 43.5 && rest.mic.h >= 43.5 && rest.chip.h >= 47.5, d({ add: rest.add, chip: rest.chip, mic: rest.mic })],
      ['each key of the row takes a touch 23 dp above and below its middle', rest.touch.add && rest.touch.chip && rest.touch.mic, d(rest.touch)],
      ['the model key opens one menu: model, thinking effort, mode — each a row with its current value', menu?.kind === 'menu' && ids(root).slice(0, 3).join() === 'field:model,field:thinking,mode' && root[0].detail === 'Stage Model A' && !!root[1].detail && modeRow?.detail === '替我批准', d({ title: menu?.title, rows: root.map((i) => [i.id, i.label, i.detail]) })],
      ['the model page lists the catalog with a search field; the mode page holds plan mode and the approval tiers', page2('field:model').map((i) => i.label).join() === 'Stage Model A,Stage Model B' && !!root[0].search && ['plan-mode', 'approval:readonly', 'approval:auto-edit', 'approval:full-auto'].every((id) => ids(page2('mode')).includes(id)), d({ model: page2('field:model').map((i) => [i.id, i.label, !!i.checked]), mode: ids(page2('mode')) })],
      ['full access picked there turns the model key red; plan mode tints it; both go back', full.danger && !full.plan && plan.plan && !plan.danger && !back.danger && !back.plan, d({ full: [full.danger, full.plan], plan: [plan.danger, plan.plan], back: [back.danger, back.plan] })],
      ['a model picked there is the one in use', other.name.includes('Stage Model B') && back.name.includes('Stage Model A'), d({ other: other.name, back: back.name })],
      ['a host that cannot present the menu: the mode key is back, and that touch opened the model menu instead', refused.modeKey && refused.modelMenu, d({ modeKey: refused.modeKey, modelMenu: refused.modelMenu })],
    ]
  },
  // A table wider than the screen scrolls sideways in its own box (cells that fit on a line are not broken; a cell that
  // is a sentence still wraps); a table that fits stays as it was. Before, five columns were squeezed into the width.
  'chat-table': async (page) => {
    await openChat(page, '登录页验证码不显示')
    await page.waitForSelector(`${CHAT} .t2-asst .t2-content table`, { timeout: 10_000 })
    const m = await page.evaluate((q) => {
      const root = document.querySelector(q)
      const [wide, small] = [...root.querySelectorAll('.t2-asst .t2-content table')]
      wide.scrollIntoView({ block: 'center' })
      // lines of text in a cell (its box is as tall as the row, so the text itself is measured): tops more than 8 dp apart
      const lines = (el) => { const r = document.createRange(); r.selectNodeContents(el); const tops = [...r.getClientRects()].map((b) => b.top).sort((a, b) => a - b); return tops.filter((t, i) => !i || t - tops[i - 1] > 8).length }
      const cells = [...wide.querySelectorAll('td')]
      const col = root.querySelector('.t2-asst .t2-content').getBoundingClientRect()
      const mask = getComputedStyle(wide).maskImage || getComputedStyle(wide).webkitMaskImage
      return {
        wide: { scrollW: wide.scrollWidth, clientW: wide.clientWidth, h: wide.getBoundingClientRect().height, right: wide.getBoundingClientRect().right, colRight: col.right,
          short: cells.filter((c) => !c.hasAttribute('data-long')).map(lines), long: cells.filter((c) => c.hasAttribute('data-long')).map((c) => ({ lines: lines(c), text: c.textContent.length })) },
        small: { scrollW: small.scrollWidth, clientW: small.clientWidth }, timelines: CSS.supports('animation-timeline', 'scroll()'), fade: getComputedStyle(wide).getPropertyValue('--t2-table-fade-r').trim(), smallFade: getComputedStyle(small).getPropertyValue('--t2-table-fade-r').trim(), mask: (mask || '').slice(0, 24),
      }
    }, CHAT)
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(OUT, `chat-table-start${DARK ? '-dark' : ''}.png`) })
    const end = await page.evaluate(async (q) => {
      const wide = document.querySelector(`${q} .t2-asst .t2-content table`)
      wide.scrollLeft = wide.scrollWidth; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      return { left: wide.scrollLeft, l: getComputedStyle(wide).getPropertyValue('--t2-table-fade-l').trim(), r: getComputedStyle(wide).getPropertyValue('--t2-table-fade-r').trim() }
    }, CHAT)
    const d = JSON.stringify(m)
    return [
      ['the wide table scrolls sideways inside the column instead of being squeezed', m.wide.scrollW > m.wide.clientW + 40 && m.wide.right <= m.wide.colRight + 0.5, d],
      ['its short cells each stay on one line; the cell that is a sentence wraps', m.wide.short.length >= 12 && m.wide.short.every((n) => n === 1) && m.wide.long.length >= 1 && m.wide.long.every((c) => c.lines >= 2), d],
      ['the table that fits does not scroll', m.small.scrollW <= m.small.clientW + 1, d],
      // an engine without scroll-driven animations has no fade at all (nothing to check then); one that has them must show it
      ['where the engine has scroll-driven animations: the side with more to see fades, the other does not', !m.timelines || (m.mask.includes('gradient') && m.fade === '28px' && end.left > 0 && end.l === '28px' && end.r === '0px' && m.smallFade === '0px'), JSON.stringify({ timelines: m.timelines, mask: m.mask, start: m.fade, end, small: m.smallFade })],
    ]
  },
  // Two small keys a finger has to find: the "thinking" row (22 dp tall) and a code block's copy key (28 dp). They look
  // the same; a touch a little outside them still lands.
  'chat-touch': async (page) => {
    await openChat(page, '登录页验证码不显示')
    await page.waitForSelector(`${CHAT} .t2-asst .t2-content pre`, { timeout: 10_000 })
    const m = await page.evaluate((q) => {
      const root = document.querySelector(q)
      const takes = (el, dx, dy) => { el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); const at = document.elementFromPoint(b.left + b.width / 2 + dx, b.top + b.height / 2 + dy); return { ok: !!at && el.contains(at), h: b.height, w: b.width } }
      const think = root.querySelector('.t2-think-head'); const copy = root.querySelector('.t2-asst .t2-content pre ~ .icon-btn')
      return { think: think && [takes(think, 0, -22), takes(think, 0, 22)], copy: copy && [takes(copy, 0, 23), takes(copy, -23, 0)] }
    }, CHAT)
    const d = JSON.stringify(m)
    return [
      ['the thinking row takes a touch 22 dp above and below its middle', !!m.think && m.think.every((x) => x.ok), d],
      ['the copy key of a code block takes a touch 23 dp below and beside its middle', !!m.copy && m.copy.every((x) => x.ok), d],
    ]
  },
  'chat-leave': async (page) => {
    await stage.action(page, 'left')
    return [['back on the list', (await stage.nav(page)) === 'list', await stage.nav(page)]]
  },
  'notes-list': async (page) => {
    await stage.space(page, 'tangu'); await chip(page, 'all')
    await stage.space(page, 'amadeus')
    await seedNotes(page)
    await page.waitForTimeout(400)
    const st = await stage.state(page)
    const on = await texts(page, `${LIST} .pl-chips .on`)
    const titles = await texts(page, `${LIST} [data-timeline] .t2s-srow-title`)
    const subs = await texts(page, `${LIST} [data-timeline] .t2s-srow-sub`)
    const secs = await texts(page, `${LIST} .pl-sec`)
    const fab = await rect(page, `${LIST} .pl-fab`)
    const search = await rect(page, `${LIST} .t2s-search`)
    return [
      ['the capsule carries search and the open vault', st.search === '搜索笔记' && !!st.titleSub, `search=${st.search} sub=${st.titleSub}`],
      ['"recent" leads: what was opened last, newest first, in day sections, each with its folder', on.join() === '最近' && titles[0] === '发版清单 2.13' && subs[0] === '项目' && secs.join('|') === '今天|昨天|这一周|更早', `${on.join()} / ${titles.join('、')} / ${secs.join('|')}`],
      ['no search box or "new" rows in the list; one main button above the dock', !search && !!fab && fab.bottom <= DOCK_TOP - 6, JSON.stringify({ search, fab })],
    ]
  },
  'notes-tree': async (page) => {
    await chip(page, 'tree')
    const flat = await page.evaluate((q) => !!document.querySelector(q), `${LIST} [data-timeline]`)
    const groups = await texts(page, `${LIST} .t2s-group-label`)
    const foot = await page.evaluate((q) => { const el = document.querySelector(q); if (!el) return null; el.scrollTop = el.scrollHeight; const f = el.querySelector('.t2s-foot'); const r = f?.getBoundingClientRect(); el.scrollTop = 0; return r ? { bottom: r.bottom } : null }, `${LIST} .t2s-scroll`)
    return [
      ['Folders: the tree as before', !flat && groups.includes('项目') && groups.includes('读书笔记'), groups.join('、')],
      ['trash and vault rows end the list and scroll clear of the dock', !!foot && foot.bottom <= DOCK_TOP, JSON.stringify(foot)],
    ]
  },
  'notes-boards': async (page) => {
    await chip(page, 'boards')
    const titles = await texts(page, `${LIST} [data-timeline] .t2s-srow-title`)
    return [['Whiteboards: only the whiteboards', titles.join('、') === '流程图、信息架构草图', titles.join('、')]]
  },
  'notes-star': async (page) => {
    await chip(page, 'recent')
    const sw = `${LIST} [data-timeline] .pl-swipe`
    const label = async () => {
      await page.evaluate((q) => window.__swipeOpen(document.querySelector(q)), sw)
      await page.waitForTimeout(700)
      return page.evaluate((q) => document.querySelector(q).querySelector('[data-act="star"]')?.getAttribute('aria-label') ?? null, sw) // no text on the button: the name is its label
    }
    const use = async () => { await page.locator(`${sw} >> nth=0`).locator('[data-act="star"]').tap(); await page.waitForTimeout(400) }
    const before = await label()
    await use()
    const after = await label()
    await use() // back to how it was
    const again = await label()
    return [['the star action names what it will do, also right after it was used', !!before && !!after && before !== after && again === before, `${before} → ${after} → ${again}`]]
  },
  'notes-reset': async (page) => { await chip(page, 'recent'); return [] },
  // The other first-level lists keep their own rows; what they share with the two above is the one main button.
  'agents-list': async (page) => {
    await stage.space(page, 'agents')
    const fab = await rect(page, `${LIST} .pl-fab`)
    const names = await texts(page, `${LIST} .agents-roster-item strong`)
    const link = await rect(page, `${LIST} .agents-roster-create`)
    return [['Agents: the roster, and "create" is the main button (no link at the foot)', (await stage.nav(page)) === 'list' && names.length === 2 && !link && !!fab && near(fab.w, 58) && near(SCREEN.width - fab.right, 16) && fab.bottom <= DOCK_TOP - 6, JSON.stringify({ names, link, fab })]]
  },
  // An agent's run settings on a touch screen (10-25 round 4 · 4.3): no native selects; the approval names are the composer's.
  'agent-config': async (page) => {
    if ((await stage.nav(page)) === 'detail') await stage.action(page, 'left')
    await stage.space(page, 'agents')
    await page.locator(`${LIST} .agents-roster-item`, { hasText: '研究员' }).first().tap()
    await page.waitForFunction(() => document.querySelector('.mb-shell')?.getAttribute('data-nav') === 'detail', null, { timeout: 6000 }).catch(() => {})
    await page.waitForTimeout(500)
    const nav = await stage.nav(page)
    const RUN = '.mb-view [data-agent-profile] .profile-config-group'
    await page.waitForSelector(RUN, { timeout: 8000 }).catch(() => {})
    const selects = await page.evaluate((q) => document.querySelector(q)?.querySelectorAll('select').length ?? -1, RUN)
    await page.locator(`${RUN} [data-profile-field="approval"] .profile-model-trigger`).first().tap()
    await page.waitForTimeout(300)
    const opts = await texts(page, `${RUN} [data-profile-field="approval"] [role="option"]`)
    await page.screenshot({ path: path.join(OUT, `agent-config-open${DARK ? '-dark' : ''}.png`) })
    await page.locator(`${RUN} [data-profile-field="approval"] .profile-model-trigger`).first().tap()
    await stage.action(page, 'left')
    return [['run settings (the profile page, one level down): no native selects, approval names are the composer\'s', nav === 'detail' && selects === 0 && opts.join('|') === '跟随默认（替我批准）|询问我批准|替我批准|完全放行|自定义（config.json）', JSON.stringify({ nav, selects, opts })]]
  },
  'images-list': async (page) => {
    await stage.space(page, 'image-studio')
    await page.waitForSelector(`${LIST} .ims-nav`, { timeout: 15_000 })
    await page.waitForTimeout(600)
    const fab = await rect(page, `${LIST} .pl-fab`)
    const items = await texts(page, `${LIST} .ims-nav .csn-item`)
    const heads = await texts(page, `${LIST} .ims-nav .csn-heading`)
    return [['Image studio: "new project" is the main button; the list starts with "my projects"', (await stage.nav(page)) === 'list' && items[0] === '我的项目' && !heads.includes('创建') && !!fab && fab.bottom <= DOCK_TOP - 6, JSON.stringify({ items, heads, fab })]]
  },
  // A call is on. Its bar belongs to the app, not to the chat: it stays up on every page, right under the capsules, so
  // every page starts below it (the shell's top room grows by the bar, see voiceCall.css). Checked page by page.
  // An empty inbox (10-25 round 4 · 4.1): the list is the page on a phone, so the shared EmptyState sits in the list —
  // the same component as the desktop's reader, a bit above the middle — instead of a bare "nothing here yet".
  'inbox-empty': async (page) => {
    if ((await stage.nav(page)) === 'detail') await stage.action(page, 'left')
    await seedInbox(page, [])
    await stage.space(page, 'inbox')
    await page.waitForSelector(`${LIST} .empty-state`, { timeout: 6000 }).catch(() => {})
    const title = await rect(page, `${LIST} .empty-state .empty-state-title`)
    const words = await texts(page, `${LIST} .empty-state .empty-state-title, ${LIST} .empty-state .empty-state-line`)
    const bare = await texts(page, `${LIST} .t2sw-empty`)
    const box = await page.evaluate((q) => { const el = document.querySelector(q); if (!el) return null; const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return { jc: cs.justifyContent, pt: cs.paddingTop, top: r.top, h: r.height, parent: getComputedStyle(el.parentElement).display, ph: el.parentElement.getBoundingClientRect().height } }, `${LIST} .empty-state`)
    await page.screenshot({ path: path.join(OUT, `inbox-empty-list${DARK ? '-dark' : ''}.png`) })
    return [
      ['an empty inbox says what lands here, with the shared empty state in the list', words[0] === '收件箱是空的' && !!words[1] && !bare.length, JSON.stringify({ words, bare })],
      ['it sits above the middle of the screen, below the capsules, centred across', !!title && title.y > LAYOUT.top && title.y + title.h / 2 < SCREEN.height / 2 && near(title.x + title.w / 2, SCREEN.width / 2, 24), JSON.stringify({ title, box })],
    ]
  },
  'inbox-list': async (page) => {
    if ((await stage.nav(page)) === 'detail') await stage.action(page, 'left')
    await seedInbox(page)
    await stage.space(page, 'inbox')
    const ROW = `${LIST} .t2sw-plug-item .t2s-srow`
    const HEAD = `${LIST} .t2sw-plug-ghead`
    const st = await stage.state(page)
    const desk = await page.evaluate((q) => ['.t2sw-plug-toolbar', '.t2sw-plug-filterbar', '.t2sw-plug-row-menu', '.t2sw-plug-row-quick'].filter((c) => document.querySelector(`${q} ${c}`)), LIST)
    const chips = await texts(page, `${LIST} .pl-chips > button`)
    // the senders, top to bottom: name : open or not : the unread count at the end of the head
    const heads = () => page.evaluate((q) => [...document.querySelectorAll(q)].map((h) => `${h.querySelector('.t2o-name').textContent}:${h.getAttribute('aria-expanded')}:${h.querySelector('.t2s-count')?.textContent ?? ''}`).join(' '), HEAD)
    const headsAtFirst = await heads()
    const head = await rect(page, HEAD)
    const headLead = await rect(page, `${HEAD} .t2o-lead`)
    const headName = await rect(page, `${HEAD} .t2o-name`)
    const row = await rect(page, ROW)
    const lead = await rect(page, `${ROW} > .t2s-lead`)
    const dots = await page.evaluate((q) => [...document.querySelectorAll(q)].map((el) => (el.querySelector('.t2s-lead > .t2sw-plug-udot') ? 'dot' : el.querySelector('.t2s-lead').childElementCount ? 'icon' : 'empty')).join(), ROW)
    const subs = await texts(page, `${ROW} .t2s-srow-sub`)
    const sub = await rect(page, `${ROW} .t2s-srow-sub`)
    const title = await rect(page, `${ROW} .t2s-srow-title`)
    const time = await rect(page, `${ROW} .t2s-srow-time`)
    const long = await rect(page, `${ROW} .t2s-srow-title`, 4)
    const longTime = await rect(page, `${ROW} .t2s-srow-time`, 4)
    const unread = await page.evaluate((q) => [...document.querySelectorAll(q)].map((el) => [el.classList.contains('is-unread'), getComputedStyle(el.querySelector('.t2s-srow-title')).fontWeight].join(':')), ROW)
    const fab = await rect(page, `${LIST} .pl-fab`)
    const fabName = await page.evaluate((q) => document.querySelector(q)?.getAttribute('aria-label') || '', `${LIST} .pl-fab`)
    // the folded sender opens on a tap and folds again on the next
    await page.locator(HEAD, { hasText: '系统' }).tap(); await page.waitForTimeout(250)
    const opened = `${await heads()} rows=${(await texts(page, `${ROW} .t2s-srow-title`)).length}`
    await page.locator(HEAD, { hasText: '系统' }).tap(); await page.waitForTimeout(250)
    const folded = `${await heads()} rows=${(await texts(page, `${ROW} .t2s-srow-title`)).length}`
    await page.screenshot({ path: path.join(OUT, `inbox-groups${DARK ? '-dark' : ''}.png`) })
    return [
      ['the inbox opens on a phone list: no toolbar, no filter menu, no row buttons; search is on the capsule', (await stage.nav(page)) === 'list' && !desk.length && !!st.search, `nav=${await stage.nav(page)} desktop parts=${desk.join(',') || 'none'} search=${st.search}`],
      ['its categories are chips: senders are groups now, not filters', chips.join('|') === '全部|未读|已归档', chips.join('|')],
      ['mail is grouped by sender, the one who wrote last on top; a group with unread mail is open and says how many', headsAtFirst === 'Forsion:true:2 系统:false:', headsAtFirst],
      ['a group head is the workspace\'s first-level row at touch size: 52 dp on a 40 dp lead, 16 from the edge', !!head && near(head.h, 52) && !!headLead && near(headLead.w, 40) && near(headLead.h, 40) && near(headLead.x, 16), JSON.stringify({ head: head?.h, lead: headLead })],
      ['rows inside a group carry no icon block: the unread dot only, the title under the sender\'s name', subs.length === 5 && dots === 'dot,dot,empty,empty,empty' && !!title && !!headName && near(title.x, headName.x) && !!row && row.h >= 59 && row.h <= 68, JSON.stringify({ rows: subs.length, dots, title: title?.x, name: headName?.x, row: row?.h, lead: lead && [lead.w, lead.h] })],
      ['second line: the first sentence, on one line (the sender is on the head)', subs[0] === '这一版把收件箱翻新了一遍，列表里能直接看到正文的第一句。' && !!sub && sub.h < 24, `«${subs[0]}» ${JSON.stringify(sub)}`],
      ['a tap on a folded group opens it, the next tap folds it', opened === 'Forsion:true:2 系统:true: rows=6' && folded === 'Forsion:true:2 系统:false: rows=5', `${opened} → ${folded}`],
      ['the time sits on the title\'s line; the second line runs the full width under it', !!sub && !!time && !!title && time.y < sub.y && near(sub.right, time.right) && sub.w > title.w + 40, JSON.stringify({ sub, time, title })],
      ['a title too long for the line is cut before the time', !!long && !!longTime && long.right <= longTime.x, JSON.stringify({ long, longTime })],
      ['unread rows carry a heavier title, read ones do not', unread.join() === 'true:650,true:650,false:500,false:500,false:500', unread.join()],
      ['the source\'s usual action is the main button: 58 dp, right 16, clear of the dock', !!fab && fabName === '拉取新消息' && near(fab.w, 58) && near(fab.h, 58) && near(SCREEN.width - fab.right, 16) && fab.bottom <= DOCK_TOP - 6, `${fabName} ${JSON.stringify(fab)}`],
    ]
  },
  'inbox-swipe': async (page) => {
    // the gesture itself is the browser's horizontal scroll: here it is scrolled, then the buttons are used
    const ROW = `${LIST} .t2sw-plug-item .t2s-srow`
    const sw = `${LIST} .t2sw-plug-item .pl-swipe`
    await page.evaluate((q) => { const el = document.querySelectorAll(q)[1]; el.scrollLeft = el.scrollWidth }, sw)
    await page.waitForTimeout(350)
    const acts = await page.evaluate((q) => [...document.querySelectorAll(q)[1].querySelectorAll('.pl-swipe-act')].map((b) => { const r = b.getBoundingClientRect(); return { id: b.dataset.act, name: b.getAttribute('aria-label'), x: r.left, right: r.right, w: r.width, h: r.height, text: b.textContent.trim(), svg: !!b.querySelector('svg'), danger: b.classList.contains('danger') } }), sw)
    await page.screenshot({ path: path.join(OUT, `inbox-swipe-open${DARK ? '-dark' : ''}.png`) })
    await page.locator(`${sw} >> nth=1`).locator('[data-act="read"]').tap()
    await page.waitForTimeout(500)
    const unread = await page.evaluate((q) => [...document.querySelectorAll(q)].map((el) => el.classList.contains('is-unread')), ROW)
    const closed = await page.evaluate((q) => [...document.querySelectorAll(q)].every((el) => el.scrollLeft < 2), sw)
    await chip(page, 'g:unread')
    const onlyUnread = await texts(page, `${ROW} .t2s-srow-title`)
    await chip(page, '__all')
    // archive the last one: it leaves the list and turns up under its own chip
    await page.evaluate((q) => { const el = document.querySelectorAll(q)[4]; el.scrollLeft = el.scrollWidth }, sw)
    await page.waitForTimeout(350)
    await page.locator(`${sw} >> nth=4`).locator('[data-act="archive"]').tap()
    await page.waitForTimeout(600)
    const left = (await texts(page, `${ROW} .t2s-srow-title`)).length
    await chip(page, 'g:archived')
    const archived = await texts(page, `${ROW} .t2s-srow-title`)
    await chip(page, '__all')
    return [
      ['a row slides left onto mark read / archive / delete, all on screen', acts.map((a) => a.id).join(',') === 'read,archive,delete' && acts.every((a) => a.x >= 0 && a.right <= SCREEN.width), JSON.stringify(acts)],
      ['the actions are round 44 dp buttons with an icon only, each named for a screen reader; delete is the warning one', acts.every((a) => near(a.w, 44) && near(a.h, 44) && a.svg && !a.text && !!a.name) && acts.map((a) => a.name).join('|') === '标为已读|归档|删除' && acts[2]?.danger && !acts[0]?.danger, JSON.stringify(acts.map((a) => [a.name, a.w, a.danger]))],
      ['mark read: the row loses its unread mark, the tray closes, the unread chip lists one less', unread.join() === 'true,false,false,false,false' && closed && onlyUnread.join('|') === '2.13 更新了什么', `${unread.join()} closed=${closed} unread chip: ${onlyUnread.join('|')}`],
      ['archive: the row leaves the list and is found under the archived chip', left === 4 && archived.length === 1 && archived[0].startsWith('A long English'), `left=${left} archived=${archived.join('|')}`],
    ]
  },
  'inbox-search': async (page) => {
    const ROW = `${LIST} .t2sw-plug-item .t2s-srow`
    const before = !!(await rect(page, `${LIST} .t2sw-plug-toolbar`))
    await stage.action(page, 'search')
    const field = await rect(page, `${LIST} .t2sw-plug-toolbar .t2s-search`)
    const focused = await page.evaluate(() => document.activeElement?.matches('.t2sw-plug-toolbar .t2s-search input') ?? false)
    await page.keyboard.type('会员')
    await page.waitForTimeout(400)
    const hits = await texts(page, `${ROW} .t2s-srow-title`)
    await page.screenshot({ path: path.join(OUT, `inbox-search-open${DARK ? '-dark' : ''}.png`) })
    // the keyboard put away (the field loses the caret), then the search button once more: the caret is back
    await page.evaluate(() => document.activeElement?.blur())
    await stage.action(page, 'search')
    const again = await page.evaluate(() => document.activeElement?.matches('.t2sw-plug-toolbar .t2s-search input') ?? false)
    await page.locator(`${LIST} .t2sw-plug-toolbar .t2s-search button`).tap()
    await page.waitForTimeout(400)
    const after = !!(await rect(page, `${LIST} .t2sw-plug-toolbar`))
    const back = (await texts(page, `${ROW} .t2s-srow-title`)).length
    return [
      ['the capsule\'s search button brings a search line up with the caret in it; it filters the list in place', !before && !!field && field.x >= 12 && field.right <= SCREEN.width - 12 && focused && hits.join('|') === '会员即将到期', JSON.stringify({ before, field, focused, hits })],
      ['the search button a second time puts the caret back in the field', again, `focused=${again}`],
      ['its cross clears the text and takes the line away again', !after && back === 4, `line=${after} rows=${back}`],
    ]
  },
  'inbox-open': async (page) => {
    await page.locator(`${LIST} .t2s-srow`, { hasText: '2.13 更新了什么' }).first().tap()
    await page.waitForFunction(() => document.querySelector('.mb-shell')?.getAttribute('data-nav') === 'detail', null, { timeout: 6000 }).catch(() => {})
    await page.waitForTimeout(800)
    const meta = await rect(page, '.ibx-reader-meta')
    const title = await rect(page, '.ibx-reader-title')
    const first = await rect(page, '.ibx-reader-body p')
    const btns = await page.evaluate(() => [...document.querySelectorAll('.ibx-reader-actions .ibx-iconbtn')].map((el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, right: r.right } }))
    const font = await page.evaluate(() => getComputedStyle(document.querySelector('.ibx-reader-title')).fontSize)
    return [
      ['the message: one level down, the sender\'s line below the capsules, the title under it', (await stage.nav(page)) === 'detail' && !!meta && !!title && meta.y >= LAYOUT.top && title.y >= meta.bottom, JSON.stringify({ nav: await stage.nav(page), meta: meta && [meta.y, meta.bottom], title: title?.y })],
      ['the title is the 24px document title; the text follows closely', font === '24px' && !!first && !!title && first.y - title.bottom >= 8 && first.y - title.bottom <= 40, `${font} gap=${first && title ? Math.round(first.y - title.bottom) : '?'}`],
      ['the reader\'s buttons are finger-sized (44 dp) and on screen', btns.length === 3 && btns.every((b) => b.w >= 43 && b.h >= 43 && b.right <= SCREEN.width), JSON.stringify(btns)],
    ]
  },
  'inbox-reward': async (page) => {
    await stage.action(page, 'left')
    await page.locator(`${LIST} .t2s-srow`, { hasText: '国庆更新奖励' }).first().tap()
    await page.waitForFunction(() => !!document.querySelector('.ibx-reader .ibx-attach'), null, { timeout: 6000 }).catch(() => {})
    await page.waitForTimeout(600)
    const card = await rect(page, '.ibx-reader .ibx-attach')
    const chips = await page.evaluate(() => [...document.querySelectorAll('.ibx-attach :is(.ibx-attach-chip, .ibx-req-chip)')].map((el) => { const r = el.getBoundingClientRect(); return { t: el.textContent.trim(), x: r.left, right: r.right, svg: !!el.querySelector('svg') } }))
    const claim = await rect(page, '.ibx-attach .ibx-claim-btn')
    return [
      ['a reward: the attachments card fits the screen, every chip inside it', !!card && card.x >= 0 && card.right <= SCREEN.width && chips.length === 4 && chips.every((c) => c.x >= card.x && c.right <= card.right), JSON.stringify({ card, chips })],
      ['items carry line icons (no emoji); the claim button is inside the card', chips.slice(0, 2).every((c) => c.svg) && !!claim && !!card && claim.right <= card.right && claim.bottom <= card.bottom, JSON.stringify(claim)],
    ]
  },
  'call-bar': async (page) => {
    await stage.space(page, 'tangu'); await chip(page, 'all')
    await callBar(page, true)
    const rows = []
    const look = async (name, what) => {
      await page.waitForTimeout(500)
      const hit = await underCallBar(page)
      rows.push([`${what}: nothing to tap or to read lies under the call bar`, !!hit.bar && near(hit.bar.y, LAYOUT.top + 6 * hit.zoom, 2) && !hit.covered.length, JSON.stringify(hit)])
      await page.screenshot({ path: path.join(OUT, `call-${name}${DARK ? '-dark' : ''}.png`) })
    }
    await look('tangu-list', 'the session list')
    // and a finger gets through: the chips are the row the bar used to lie on
    const tapped = await page.locator(`${LIST} .pl-chips [data-filter="agent"]`).tap({ timeout: 3000 }).then(() => '', (e) => String(e.message).split('\n').find((l) => l.includes('intercepts')) || String(e.message).split('\n')[0])
    await page.waitForTimeout(300)
    const on = (await texts(page, `${LIST} .pl-chips .on`)).join()
    rows.push(['the session list: a category chip takes a tap during the call', !tapped && on === 'Agent', tapped.trim() || `on=${on}`])
    if (!tapped) await chip(page, 'all')
    await stage.space(page, 'home')
    await look('home', 'Home')
    await stage.space(page, 'amadeus'); await seedNotes(page)
    await look('notes-list', 'the notes list')
    await stage.space(page, 'calendar')
    await look('calendar', 'the calendar')
    await stage.space(page, 'agents')
    await look('agents-list', 'the agents roster')
    // one level down, the chat: its first message starts below the bar, as it did when only the chat made room
    await stage.space(page, 'tangu')
    await page.locator(`${LIST} [data-timeline] .t2s-srow`, { hasText: '发版说明草稿' }).first().tap() // the session with messages; not always the first row (an earlier scene pins another)
    await page.waitForFunction(() => document.querySelector('.mb-shell')?.getAttribute('data-nav') === 'detail', null, { timeout: 6000 }).catch(() => {})
    await look('chat', 'the chat')
    const first = await rect(page, '.mb-view[data-view="chat"] .t2-stream [id^="tocmsg-"]')
    const bar = await rect(page, '.vc-bar')
    rows.push(['the chat: the first message is below the bar', (await stage.nav(page)) === 'detail' && !!first && !!bar && first.y >= bar.bottom, JSON.stringify({ nav: await stage.nav(page), first: first && Math.round(first.y), barBottom: bar && Math.round(bar.bottom) })])
    await callBar(page, false)
    await page.waitForTimeout(300)
    const back = await page.evaluate(() => getComputedStyle(document.querySelector('.mb-shell')).getPropertyValue('--mb-top-extra').trim())
    rows.push(['the call over: the pages take the room back', !(await rect(page, '.vc-bar')) && (back === '' || back === '0px'), `--mb-top-extra «${back}»`])
    return rows
  },
  // A link in an answer: a long press shows the card a hover shows on the desktop (here the rich one: the engine answers
  // for that PR); lifting the finger closes it and does not open the link. Shot while held: linkcard-held.png.
  linkcard: async (page) => {
    await openChat(page, '登录页验证码不显示')
    const a = page.locator(`${CHAT} a.citelink`).first()
    await a.scrollIntoViewIfNeeded()
    const box = await a.boundingBox()
    const at = [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }]
    const card = () => page.evaluate(() => { const el = document.querySelector('body > .chat-link-card'); return el ? { text: el.textContent, rich: !!el.querySelector('.chat-link-card-rich') } : null })
    const cdp = await page.context().newCDPSession(page)
    const url = page.url()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at })
    await page.waitForTimeout(250)
    const early = await card()
    await page.waitForTimeout(900)
    const held = await card()
    await page.screenshot({ path: path.join(OUT, `linkcard-held${DARK ? '-dark' : ''}.png`) })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(500)
    const after = await card()
    const stayed = page.url() === url && (await page.locator('.mb-shell').count()) === 1
    await cdp.detach()
    return [
      ['a long press: nothing at a quarter second', early === null, JSON.stringify(early)],
      ['a long press: the rich card once held', !!held?.rich && /已合并/.test(held.text) && /#153/.test(held.text), JSON.stringify(held)],
      ['lifting the finger closes it and does not open the link', after === null && stayed, JSON.stringify({ after, stayed })],
    ]
  },
  // The notification stack is mounted outside the shell (MobileRoot's last child): none of the shell's room-keeping
  // reaches it. The capsules and the dock are native — drawn over the page — so a card under one of them is cut off.
  'notify-card': async (page) => {
    if ((await stage.nav(page)) === 'detail') await stage.action(page, 'left')
    await page.evaluate(async (url) => {
      const { useNotifications } = await import(/* @vite-ignore */ url)
      useNotifications.getState().dismissAll()
      useNotifications.getState().notify({ force: true, sticky: true, title: 'Forsion', text: '2.13.3 已经可以更新了', action: { label: '查看', run() {} } })
    }, moduleUrl('../desktop/frontend/src/stores/notificationStore.ts'))
    const plates = LAYOUT.plates.map((p) => ({ ...p, right: p.x + p.w, bottom: p.y + p.h }))
    const clear = (c) => !!c && c.x >= 0 && c.right <= SCREEN.width && plates.every((p) => c.bottom <= p.y || c.y >= p.bottom || c.right <= p.x || c.x >= p.right)
    const card = async () => { await page.waitForTimeout(700); const c = await rect(page, '.ntf-wrap .ntf'); return c && Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * 10) / 10])) }
    const rows = []
    // the calendar keeps its cards at the bottom on a desktop — on the phone that is where the dock is
    await stage.space(page, 'calendar')
    const cal = await card()
    rows.push(['the calendar: the card is at the top here too, clear of the capsules and of the dock', clear(cal) && cal.bottom < SCREEN.height / 2, JSON.stringify(cal)])
    await page.screenshot({ path: path.join(OUT, `notify-calendar${DARK ? '-dark' : ''}.png`) })
    await stage.space(page, 'tangu'); await chip(page, 'all')
    await callBar(page, true)
    const bar = await rect(page, '.vc-bar')
    const during = await card()
    rows.push(['during a call: the card is below the call bar (its hang-up key stays in reach)', !!bar && !!during && during.y >= bar.bottom, JSON.stringify({ card: during, barBottom: bar && Math.round(bar.bottom) })])
    await callBar(page, false)
    const zoom = await page.evaluate(() => Number(getComputedStyle(document.body).zoom) || 1)
    const c = await card()
    rows.push(['a notification: the card starts right below the capsule row, inside the screen', clear(c) && near(c.y, LAYOUT.top + 6 * zoom, 2), JSON.stringify({ card: c, capsulesEnd: LAYOUT.top })])
    return rows
  },
  // The agent picker of a new chat. The phone's column is narrow, so the strip folds into one chip. Without a native host
  // the chip opens a web bottom sheet (names only, ticks, team order); with one, the Android checklist — ticked in order,
  // applied when it closes (docs/ToBeImproved/窄栏Agent选择器方案_2026-10-23, chosen 10-24).
  'agent-picker': async (page) => {
    if ((await stage.nav(page)) === 'detail') await stage.action(page, 'left')
    await stage.space(page, 'tangu'); await chip(page, 'all')
    await page.locator(`${LIST} [data-act="list-fab"], ${LIST} [data-act="new-chat"]`).first().tap()
    await page.waitForFunction(() => document.querySelector('.mb-shell')?.getAttribute('data-nav') === 'detail', null, { timeout: 6000 })
    await page.waitForTimeout(600)
    const pickerChip = page.locator('.agent-select-strip .compact-chat-picker').filter({ visible: true }).first()
    const chipName = () => pickerChip.locator('.compact-chat-picker-name').textContent()
    // web sheet
    await pickerChip.tap()
    await page.waitForSelector('.chat-pick-sheet')
    const names = await texts(page, '.chat-pick-sheet .chat-pick-name')
    const sheetText = await page.locator('.chat-pick-sheet').textContent()
    await page.locator('.chat-pick-sheet [data-pick-id="agent:editor"]').tap()
    await page.locator('.chat-pick-sheet [data-pick-id="agent:researcher"]').tap()
    await page.waitForTimeout(400)
    const order = await page.evaluate(() => [...document.querySelectorAll('.chat-pick-sheet .chat-pick-index')]
      .map((el) => `${el.closest('[data-pick-id]').dataset.pickId}=${el.textContent}`).sort((a, b) => a.split('=')[1] - b.split('=')[1]))
    await page.screenshot({ path: path.join(OUT, `agent-picker-sheet${DARK ? '-dark' : ''}.png`) })
    await page.locator('.chat-pick-scrim').tap({ position: { x: 40, y: 80 } })
    await page.waitForTimeout(300)
    const sheetTeam = await chipName()
    const sheetGone = !(await page.locator('.chat-pick-sheet').count())
    await pickerChip.tap()
    await page.locator('.chat-pick-sheet [data-pick-id=""]').tap()
    await page.waitForTimeout(300)
    // native checklist (a stand-in presenter, as in chat-card): the host answers with the ticks in tick order
    await page.evaluate(async (url) => {
      const st = window.__stage; st.menus = []; st.answer = { checked: ['agent:researcher', 'agent:editor'] }
      st.offSheet = (await import(/* @vite-ignore */ url)).installNativeSheetPresenter(async (payload) => { st.menus.push(payload); const a = st.answer; st.answer = null; return a })
    }, moduleUrl('../lcl/engine/nativeSheet.ts'))
    await pickerChip.tap()
    await page.waitForFunction(() => window.__stage.menus.length > 0, null, { timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(500)
    const sent = await page.evaluate(() => window.__stage.menus[0] || null)
    const nativeTeam = await chipName()
    const noWebSheet = !(await page.locator('.chat-pick-sheet').count())
    await page.evaluate(() => { window.__stage.offSheet(); delete window.__stage.offSheet })
    const items = sent?.items || []
    return [
      ['web sheet: names only, the descriptions stay out of the rows', names.includes('研究员') && names.includes('编辑') && !sheetText.includes('改稿、压字数'), JSON.stringify(names)],
      ['web sheet: two picks = a team, numbered in pick order', order.join(',') === 'agent:editor=1,agent:researcher=2', order.join(',')],
      ['web sheet: tapping the scrim closes it, the chip names both', sheetGone && sheetTeam === '编辑、研究员', sheetTeam],
      ['native host: a checklist of names, no web sheet', sent?.kind === 'checklist' && items.map((i) => i.label).join('、') === '研究员、编辑' && items.every((i) => !i.detail) && noWebSheet, JSON.stringify(sent && { kind: sent.kind, items: items.map((i) => [i.label, i.detail]) })],
      ['native host: the ticks come back in tick order', nativeTeam === '研究员、编辑', nativeTeam],
    ]
  },
}

/** Puts the app's own call bar up (or takes it down) through the store the composer's call key writes to. No call is
 *  placed — there are no run parameters — so the bar stands idle: same box, no status line. The call itself (socket,
 *  microphone, typed text) is `npm run e2e:voicecall` and the emulator's "voice call" check. */
async function callBar(page, on) {
  await page.evaluate(async ([url, show]) => {
    const { openCallLayer } = await import(/* @vite-ignore */ url)
    openCallLayer(show ? { sessionId: 'st-1', agentSlug: '' } : null)
  }, [moduleUrl('../desktop/frontend/src/services/realtimeCall.ts'), on])
  await page.waitForFunction((show) => !!document.querySelector('.vc-bar') === show, on, { timeout: 5000 })
  await page.waitForTimeout(400) // the bar's enter animation; the pages' new top room
}

/** What the page has under the call bar: controls a finger could no longer reach and text nobody could read.
 *  Controls: the bar is sampled on a grid; at each point the hit is whatever would take the touch if the bar were not
 *  there. Text: every shown text node of the shell whose box reaches under the bar — not by hit test, text that takes no
 *  touches (`pointer-events: none`, an empty state's title) is read all the same. A box cut off by a scroller is not there. */
const underCallBar = (page) => page.evaluate(() => {
  const bar = document.querySelector('.vc-bar')
  if (!bar) return { bar: null, covered: ['no call bar'] }
  const b = bar.getBoundingClientRect()
  const covered = new Set()
  const name = (el) => `${el.tagName.toLowerCase()}${el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : ''}`
  const under = (r) => r.bottom > b.top + 1 && r.top < b.bottom - 1 && r.right > b.left + 1 && r.left < b.right - 1
  for (let y = b.top + 3; y < b.bottom; y += 6) {
    for (let x = b.left + 6; x < b.right; x += 10) {
      const control = document.elementsFromPoint(x, y).find((e) => !bar.contains(e))?.closest('button, a[href], input, select, textarea, [role="tab"], [role="button"], [contenteditable="true"]')
      if (control) covered.add(`control ${name(control)} «${(control.getAttribute('aria-label') || control.textContent || '').trim().slice(0, 16)}»`)
    }
  }
  /** The part of `r` its scrolling / clipping ancestors leave in sight still reaches under the bar. */
  const inSight = (el, r) => {
    let box = { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
      const c = a.getBoundingClientRect()
      box = { top: Math.max(box.top, c.top), bottom: Math.min(box.bottom, c.bottom), left: Math.max(box.left, c.left), right: Math.min(box.right, c.right) }
      if (box.bottom <= box.top || box.right <= box.left) return false
    }
    return under(box)
  }
  const walker = document.createTreeWalker(document.querySelector('.mb-shell') || document.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement
    if (!n.textContent.trim() || !el || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
    const range = document.createRange()
    range.selectNodeContents(n)
    if ([...range.getClientRects()].some((r) => under(r) && inSight(el, r))) covered.add(`text ${name(el)} «${n.textContent.trim().slice(0, 16)}»`)
  }
  return { bar: { y: Math.round(b.top), bottom: Math.round(b.bottom) }, zoom: Number(getComputedStyle(document.body).zoom) || 1, covered: [...covered] }
})

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const up = await ping()
  const vite = up ? null : spawn('npx', ['vite'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BACKEND_URL: 'http://127.0.0.1:9' }, stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  let viteErr = ''
  vite?.stderr.on('data', (d) => { viteErr += String(d) })
  const stop = () => { if (vite && !process.env.KEEP) { try { process.kill(-vite.pid, 'SIGTERM') } catch { /* gone */ } } }
  let browser = null
  const fails = []
  try {
    for (let i = 0; i < 120 && !(await ping()); i++) await new Promise((r) => setTimeout(r, 500))
    if (!(await ping())) throw new Error(`vite dev did not come up\n${viteErr.slice(-600)}`)
    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })
    const ctx = await browser.newContext({ viewport: SCREEN, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale: 'zh-CN', colorScheme: DARK ? 'dark' : 'light' })
    await ctx.addInitScript((dark) => {
      try {
        localStorage.setItem('forsion_tangu_onboarding_done', '1')
        localStorage.setItem('forsion_token', 'stage')
        localStorage.setItem('amadeus_vault_mode', 'local')
        if (dark) localStorage.setItem('forsion_theme', 'dark')
      } catch { /* private mode */ }
      // a left swipe on a list row, as the pointer events a finger sends (the row's track follows them; phoneList.tsx)
      // (one move a frame, as a finger's come: their timestamps are what the release speed is taken from)
      window.__swipeOpen = async (el) => {
        const r = el.getBoundingClientRect()
        const y = r.top + r.height / 2
        const ev = (type, x) => el.dispatchEvent(new PointerEvent(type, { pointerId: 7, isPrimary: true, pointerType: 'touch', clientX: x, clientY: y, bubbles: true }))
        const frame = () => new Promise((done) => setTimeout(done, 16))
        ev('pointerdown', r.right - 20)
        for (let i = 1; i <= 8; i++) { await frame(); ev('pointermove', r.right - 20 - i * 24) }
        ev('pointerup', r.right - 20 - 8 * 24)
      }
    }, DARK)
    // A context's first page sometimes comes up without touch emulation (see editor-capsule.e2e.cjs): the app then lays
    // itself out as on a desktop — no phone zoom — and every size below is off. A second page of the same context has it.
    let page = await ctx.newPage()
    if (!(await page.evaluate(() => navigator.maxTouchPoints))) {
      console.log('(the first page has no touch emulation: opening another)')
      const first = page; page = await ctx.newPage(); await first.close()
    }
    if (!(await page.evaluate(() => navigator.maxTouchPoints))) throw new Error('stage: the browser gave this page no touch emulation (maxTouchPoints=0); the sizes below cannot be trusted')
    const unknown = new Set()
    await stubApi(page, unknown)
    page.on('pageerror', (e) => fails.push(`uncaught: ${e.message}`))
    page.on('request', (r) => { const u = new URL(r.url()); if (/\.(tsx?|jsx?)$/.test(u.pathname)) loaded.set(u.pathname, u.pathname + u.search) })
    await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    // the first load after a dependency change re-bundles and reloads the page once or twice
    await page.waitForSelector('.mb-shell', { timeout: 180_000 })
    await page.waitForTimeout(1500)
    await installChrome(page)
    const st = await stage.state(page)
    console.log(`chrome: mode=${st.mode} nav=${await stage.nav(page)} spaces=${(st.spaces || []).map((s) => s.id + (s.pinned ? '*' : '')).join(',')}`)

    for (const [name, go] of Object.entries(SCENES)) {
      if (ONLY.length && !ONLY.includes(name)) continue
      const rows = await go(page)
      await page.waitForTimeout(600)
      const file = path.join(OUT, `${name}${DARK ? '-dark' : ''}.png`)
      await page.screenshot({ path: file })
      console.log(`── ${name} → ${path.relative(ROOT, file)}`)
      for (const [what, ok, detail] of rows) {
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  | ' + detail : ''}`)
        if (!ok) fails.push(`${name}: ${what} | ${detail}`)
      }
    }
    if (unknown.size) console.log(`unanswered API calls (refused):\n  ${[...unknown].sort().join('\n  ')}`)
  } catch (e) {
    fails.push(String(e && e.stack || e))
  } finally {
    await browser?.close().catch(() => {})
    stop()
  }
  if (process.env.KEEP && !fails.length) console.log(`dev server left up at ${URL_}`)
  if (fails.length) console.error(`FAIL\n${fails.join('\n')}`); else console.log('ok')
  process.exit(fails.length ? 1 : 0) // a dev server left up (KEEP) would otherwise hold the process open
}
module.exports = { stubApi, installChrome, stage, moduleUrl, loaded, SCREEN, LAYOUT }
if (require.main === module) main()
