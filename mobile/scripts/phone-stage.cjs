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
const PORT = Number(process.env.STAGE_PORT || 5296) // clear of dev 5274 / boot 5279 / noteopen 5283 / editorbar 5285 / drawerdrag 5289 / spacetrap 5291
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
const SINCE_MIDNIGHT = T0 - new Date(T0).setHours(0, 0, 0, 0)
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
// A conversation with pauses in it, for what the chat page leaves out on a phone (st-7): a time is written only on a
// message more than five minutes after the one before it, the row of keys stays under the last answer only. Second
// pair: no pause. Third answer: it took eighteen minutes, so it carries a time without being the last. One answer has a
// code block (its copy key must not count as a tap on the message).
const QUIET_AT = 3 * DAY
const QUIET_MESSAGES = [
  { ...MESSAGES[0], id: 'st-q1', content: '帮我想三个年终总结的标题。', timestamp: T0 - QUIET_AT - 3 * HOUR },
  { ...MESSAGES[1], id: 'st-q2', content: '三个方向：\n\n- 做成了什么\n- 没做成什么\n- 明年只做哪三件', timestamp: T0 - QUIET_AT - 3 * HOUR + MIN },
  { ...MESSAGES[0], id: 'st-q3', content: '第二个再短一点。', timestamp: T0 - QUIET_AT - 40 * MIN },
  { ...MESSAGES[1], id: 'st-q4', content: ['改成「没做成的」。放进提纲是这样：', '', '```', '一、做成了什么', '二、没做成的', '三、明年只做三件', '```'].join('\n'), timestamp: T0 - QUIET_AT - 39 * MIN },
  { ...MESSAGES[0], id: 'st-q5', content: '好，就用这个。把每一部分要写的要点也列出来。', timestamp: T0 - QUIET_AT - 38 * MIN },
  { ...MESSAGES[1], id: 'st-q6', content: '每一部分三条要点，先按时间排，再按影响大小排。第一部分写上线的功能，第二部分写推迟的两件事和原因，第三部分只写目标，不写做法。', timestamp: T0 - QUIET_AT - 20 * MIN },
  { ...MESSAGES[0], id: 'st-q7', content: '可以，谢谢。', timestamp: T0 - QUIET_AT - 19 * MIN },
  { ...MESSAGES[1], id: 'st-q8', content: '不客气。写完发我，我帮你压到一页。', timestamp: T0 - QUIET_AT - 18 * MIN },
]
// The team's session (st-team): history stores each speaker as a first line, as the engine writes it.
const TEAM_AT = 2 * DAY
const TEAM_MESSAGES = [
  { ...MESSAGES[0], id: 'st-t1', content: '这周的周报谁来起草？', timestamp: T0 - TEAM_AT - 30 * MIN },
  { ...MESSAGES[1], id: 'st-t2', agent_slug: 'researcher', content: '**🗣 研究员**\n\n我来列这周的三件事，数据在周三的表里。', timestamp: T0 - TEAM_AT - 29 * MIN },
  { ...MESSAGES[1], id: 'st-t3', agent_slug: 'editor', content: '**🗣 编辑**\n\n我等研究员的提纲，再统一口吻，压到一页。', timestamp: T0 - TEAM_AT - 28 * MIN },
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

// The phone's inbox is the account's cloud inbox (2026-11-12, ca809c648): the bundled Extend provides the channel
// (`ctx.app.provideInboxChannel`) and reads `/brain/inbox/messages`; with that channel up the device-local list
// (localInbox.ts, `tangu_inbox_msgs`) is not read any more. The rows below are what the server sends — broadcasts, so every
// sender is Forsion (the server stamps each row server/forsion: on a phone the list is one sender group). One of each
// thing a row or the reader has to lay out: a markdown body, a reward with claim conditions, a subject too long for the
// line. (The feedback conversation is not offered on a phone — `feedbackThreadAvailable` — so a feedback notice is just a
// message here.) The order of groups and "a group with nothing unread starts folded" are pinned by
// desktop/frontend/src/views/inbox/inboxListSource.test.ts: a second sender cannot reach a phone's list.
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
]
/** The account's cloud inbox as the server keeps it (server/microserver/brain-api/cloudInbox.ts): empty until a scene
 *  seeds it (seedInbox), then read, archived and deleted through the same routes the channel calls. */
const cloudInbox = { rows: [] }
const toCloud = (m) => ({ ...m, id: `cloud:${m.id}`, origin_broadcast_id: m.id, sender_kind: 'server', sender_id: 'forsion', deleted_at: undefined })
const nowUtc = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
/** GET/PATCH/DELETE/POST under /brain/inbox/messages, answered like the server: `all` = not archived, newest first,
 *  ids `cloud:<broadcast id>`, an unread count whose revision moves with every change; a malformed filter or write is a
 *  400 and an unknown id a 404, so a write the app gets wrong fails here as it would there. Returns [status, body], or
 *  undefined for a route the server does not have. */
function cloudInboxAnswer(method, p, query, body) {
  const rows = cloudInbox.rows
  const live = rows.filter((m) => !m.archived_at)
  if (/\/brain\/inbox\/messages$/.test(p) && method === 'GET') {
    const filter = query.get('filter') || 'all'
    if (!['all', 'unread', 'archived'].includes(filter)) return [400, { detail: 'Invalid inbox filter' }]
    const out = filter === 'archived' ? rows.filter((m) => m.archived_at) : filter === 'unread' ? live.filter((m) => !m.read_at) : live
    return [200, { messages: [...out].sort((a, b) => b.created_at.localeCompare(a.created_at)), nextCursor: null }]
  }
  if (/\/brain\/inbox\/messages\/unread-count$/.test(p) && method === 'GET') {
    const latest = [...live].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
    return [200, { count: live.filter((m) => !m.read_at).length, latestId: latest?.id ?? null, latestCreatedAt: latest?.created_at ?? null, revision: rows.map((m) => `${m.id}:${m.read_at}:${m.archived_at}`).join('|') }]
  }
  if (/\/brain\/inbox\/messages\/read-all$/.test(p) && method === 'POST') { live.forEach((m) => { m.read_at = m.read_at || nowUtc() }); return [200, { ok: true }] }
  const one = p.match(/\/brain\/inbox\/messages\/([^/]+)$/)
  if (one && (method === 'PATCH' || method === 'DELETE')) {
    const raw = decodeURIComponent(one[1])
    if (!/^[0-9a-zA-Z-]{1,64}$/.test(raw)) return [400, { detail: 'Invalid message id' }]
    const keys = Object.keys(body || {})
    if (method === 'PATCH' && (!keys.length || keys.some((k) => !['read', 'archived'].includes(k) || typeof body[k] !== 'boolean'))) return [400, { detail: 'Expected read or archived booleans' }]
    const row = rows.find((m) => m.id === `cloud:${raw}`)
    if (!row) return [404, { detail: 'Message not found' }]
    if (method === 'DELETE') cloudInbox.rows = rows.filter((m) => m !== row)
    else {
      if ('read' in body) row.read_at = body.read ? nowUtc() : null
      if ('archived' in body) row.archived_at = body.archived ? nowUtc() : null
    }
    return [200, { ok: true }]
  }
  return undefined
}
/** Answers the API from the fixtures; anything it does not know is refused and listed at the end of the run. */
async function stubApi(page, unknown) {
  const configs = Object.fromEntries(SESSIONS.map((s) => [s.id, { ...s.agent_config }]))
  await page.route('**/*', (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const p = url.pathname
    if (url.origin === new URL(URL_).origin && !/^\/(api|auth|account|shared|oauth|shop|pay|legal)(\/|$)/.test(p)) return route.continue()
    const m = req.method()
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) })
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } })
    if (p.endsWith('/auth/me')) return json({ username: 'stage', id: 'stage' })
    if (p.endsWith('/health')) return json({ ok: true, sandbox: 'stage' })
    if (p.endsWith('/agent/special/config')) return json({})
    if (p.endsWith('/agent/agents') && m === 'GET') return json({ agents: AGENTS })
    if (p.endsWith('/agent/projects') && m === 'GET') return json({ projects: PROJECTS })
    if (p.endsWith('/agent/teams') && m === 'GET') return json({ teams: TEAMS })
    if (p.endsWith('/agent/engines') && m === 'GET') return json({ engines: [] })
    if (p.endsWith('/agent/agents-meta') && m === 'GET') return json({ order: AGENTS.map((a) => a.slug), defaultSlug: AGENTS[0].slug })
    if (p.endsWith('/agent/sessions') && m === 'GET') return json({ sessions: SESSIONS.filter((x) => !!x.archived === (url.searchParams.get('archived') === 'true')) })
    if (p.endsWith('/agent/runs')) return json({ runs: [] })
    if (p.endsWith('/agent/approvals/pending')) return json({ rev: 'stage', approvals: [] })
    if (p.endsWith('/agent/models') && m === 'GET') return json({ models: MODELS, directProviders: [], defaultModelId: MODELS[0].id })
    if (/\/market\/items$/.test(p)) return json({ items: [] })
    if (p.endsWith('/inbox/broadcasts')) return json({ broadcasts: [] })
    if (/\/brain\/inbox\/messages(\/|$)/.test(p)) {
      let body = {}
      try { body = JSON.parse(req.postData() || '{}') } catch { body = null }
      const answer = body === null ? [400, { detail: 'Invalid JSON' }] : cloudInboxAnswer(m, p, url.searchParams, body)
      if (answer) return json(answer[1], answer[0])
    }
    if (/\/agent\/sessions\/[^/]+\/checkpoints$/.test(p)) return json({ checkpoints: [] })
    const cfg = p.match(/\/agent\/sessions\/([^/]+)\/config$/)
    if (cfg) {
      const id = decodeURIComponent(cfg[1])
      if (m === 'PATCH' || m === 'PUT') configs[id] = { ...(m === 'PATCH' ? configs[id] : {}), ...JSON.parse(req.postData() || '{}') }
      return json({ agent_config: configs[id] || {} })
    }
    // a tap on a team's row asks the engine for that team's session (the one it has, or a new one)
    const team = p.match(/\/agent\/teams\/([^/]+)\/session\/open$/)
    if (team && m === 'POST') return json({ session: SESSIONS.find((x) => x.agent_config.teamSlug === decodeURIComponent(team[1])) || null, created: false })
    if (p.endsWith('/agent/link-preview')) return json({ preview: url.searchParams.get('url') === LINK_PR ? LINK_PREVIEW : null })
    if (/\/agent\/sessions\/[^/]+\/messages$/.test(p)) return json({ messages: p.includes('/st-1/') ? MESSAGES : p.includes('/st-3/') ? CHAT_MESSAGES : p.includes('/st-7/') ? QUIET_MESSAGES : p.includes('/st-team/') ? TEAM_MESSAGES : [] })
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
  // the first two are placed by the clock, not by age, so "today" and "yesterday" hold at any hour: 25 minutes ago is
  // yesterday just after midnight, and 27 hours ago is two days back until 03:00
  recents: [['项目/发版清单 2.13.md', Math.min(25 * MIN, SINCE_MIDNIGHT / 2)], ['读书笔记/《置身事内》第三章摘记.md', SINCE_MIDNIGHT + 3 * HOUR], ['十月计划.md', 3 * DAY], ['项目/信息架构草图.excalidraw.md', 4 * DAY], ['项目/会议纪要 9-30.md', 9 * DAY]],
}
async function seedNotes(page) {
  await page.evaluate(async ({ storeUrl, recentUrl, notes, now }) => {
    const { usePageStore } = await import(/* @vite-ignore */ storeUrl)
    const { useRecentViews } = await import(/* @vite-ignore */ recentUrl)
    usePageStore.setState({ vaultRoot: usePageStore.getState().vaultRoot || '/stage/vault', pages: notes.pages, folders: notes.folders, files: notes.files })
    useRecentViews.setState({ items: notes.recents.map(([id, ago]) => ({ key: `note:${id}`, kind: 'note', id, title: id, ts: now - ago })) })
  }, { storeUrl: moduleUrl('../desktop/frontend/src/amadeus/store/pageStore.ts'), recentUrl: moduleUrl('../desktop/frontend/src/recentViews.ts'), notes: NOTES, now: T0 })
}

/** The inbox rows go where a phone reads them from (the account's cloud inbox, through Extend's channel), then the store
 *  is asked to read them again. Without that channel the phone would read its old device-local list instead: not this
 *  app any more, so the scene stops there. */
async function seedInbox(page, rows = INBOX) {
  cloudInbox.rows = rows.map(toCloud)
  await page.evaluate(async ({ storeUrl, ntfUrl, channelUrl }) => {
    if (!(await import(/* @vite-ignore */ channelUrl)).readInboxChannel()) throw new Error('no cloud inbox channel on this page: the bundled Extend did not provide it, so the phone reads its legacy local list')
    const { useInbox } = await import(/* @vite-ignore */ storeUrl)
    await useInbox.getState().refreshList()
    await useInbox.getState().refreshUnread()
    // rows that appear after the first poll count as new mail: the app puts a notification card up. Not what is looked at here.
    const { useNotifications } = await import(/* @vite-ignore */ ntfUrl)
    useNotifications.getState().dismissAll()
  }, { storeUrl: moduleUrl('../desktop/frontend/src/stores/inboxStore.ts'), ntfUrl: moduleUrl('../desktop/frontend/src/stores/notificationStore.ts'), channelUrl: moduleUrl('../desktop/frontend/src/services/inboxChannel.ts') })
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
/** What each message of the open chat shows: a name, a time, how many keys of its action row. A folded row is still in
 *  the page (a 1 px clipped box a screen reader reaches), so an element counts as shown only when neither it nor
 *  anything between it and its message is clipped or hidden. */
const messageChrome = (page) => page.evaluate((q) => {
  const shown = (el, msg) => {
    if (!el || !el.getClientRects().length) return false
    for (let a = el; a && a !== msg.parentElement; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.clipPath !== 'none') return false
    }
    return true
  }
  return [...document.querySelector(q).querySelectorAll('.t2-stream-inner > .t2-asst, .t2-stream-inner > .t2-userwrap')].map((m) => ({
    id: m.id.replace('tocmsg-st-', ''), quiet: m.getAttribute('data-quiet'), tapped: m.hasAttribute('data-tapped'),
    name: shown(m.querySelector('.t2-name, .t2-username'), m), time: shown(m.querySelector('.t2-msgtime'), m),
    keys: [...m.querySelectorAll('.t2-actions .t2-iconbtn')].filter((b) => shown(b, m)).length,
  }))
}, CHAT)
const idsOf = (rows, pick) => rows.filter(pick).map((r) => r.id).join(',')
/** The left side as the workspace store has it (not as the list level draws it): its views and the active one. */
const leftSide = (page) => page.evaluate(async (url) => {
  const ws = (await import(/* @vite-ignore */ url)).useWorkspace.getState()
  return { types: ws.leftLeaves.map((l) => l.type), active: ws.leftLeaves.find((l) => l.id === ws.leftActiveId)?.type ?? null }
}, moduleUrl('../lcl/engine/singleColumnStore.ts'))
/** Notes with tags, written through the app's own vault bridge (in a browser it keeps its files in IndexedDB), so the
 *  tag list and the tag search answer from a real index. */
/** Which way this stage can press system Back. A browser has no back key: Capacitor's web App plugin passes a
 *  `backButton` on through notifyListeners, but on a good share of page loads the listener MobileRoot registered sits on
 *  an instance a later first call replaced (measured in home-back.e2e.cjs) — and this stage is one load. So the key is
 *  tried once, swallowed at the first link of the chain (nothing moves). `key` = it arrives; `event` = it does not, and
 *  the list level is asked directly, the way MobileRoot's planBack asks it once every overlay has declined. */
const backPath = (page) => page.evaluate(async () => {
  const st = window.__stage
  if (st.backPath) return st.backPath
  let seen = 0
  const swallow = (e) => { seen++; e.preventDefault() }
  window.addEventListener('forsion:mobile-back', swallow, { capture: true, once: true })
  window.Capacitor?.Plugins?.App?.notifyListeners?.('backButton', { canGoBack: false })
  await new Promise((r) => setTimeout(r, 400))
  window.removeEventListener('forsion:mobile-back', swallow, true)
  return (st.backPath = seen ? 'key' : 'event')
})
/** One system Back (see backPath). Returns the way it was pressed. */
async function systemBack(page) {
  const via = await backPath(page)
  await page.evaluate((key) => {
    if (key) return void window.Capacitor.Plugins.App.notifyListeners('backButton', { canGoBack: false })
    if (!window.dispatchEvent(new CustomEvent('forsion:mobile-list-back', { cancelable: true, detail: { probe: true } }))) window.dispatchEvent(new Event('forsion:mobile-list-back', { cancelable: true }))
  }, via === 'key')
  await page.waitForTimeout(500)
  return via
}
/** Whether the list level says it has a layer of its own to close before Back leaves it (asked without closing it). */
const listHoldsBack = (page) => page.evaluate(() => !window.dispatchEvent(new CustomEvent('forsion:mobile-list-back', { cancelable: true, detail: { probe: true } })))
const shellSpace = (page) => page.evaluate(() => document.querySelector('.mb-shell')?.getAttribute('data-space') || '')

async function seedTags(page) {
  await page.evaluate(async (storeUrl) => {
    const a = window.amadeus
    await a.writeTextFile('标签样例/周报提纲.md', '周报提纲 #工作/周报\n\n- 三个部分 #待整理\n')
    await a.writeTextFile('标签样例/读书计划.md', '下半年的书单 #读书\n\n先读第三章 #工作/周报 里要引用\n')
    await a.writeTextFile('标签样例/灵感.md', '路上想到的 #待整理\n')
    await a.reindex()
    const { usePageStore } = await import(/* @vite-ignore */ storeUrl)
    usePageStore.setState((st) => ({ linkGraphVersion: (st.linkGraphVersion || 0) + 1 }))
  }, moduleUrl('../desktop/frontend/src/amadeus/store/pageStore.ts'))
  await page.waitForTimeout(300)
}

const SCENES = {
  home: async (page) => {
    await stage.space(page, 'home')
    await seedNotes(page)
    await page.waitForTimeout(400)
    const HOME = '.mb-view[data-view="homepage"]'
    const pill = await rect(page, `${HOME} .hp-pill`)
    const rows = await page.evaluate((q) => [...document.querySelectorAll(q)].map((el) => ({ key: el.getAttribute('data-continue'), name: el.querySelector('.hp-continue-name').textContent, when: el.querySelector('.hp-continue-when')?.textContent ?? '' })), `${HOME} .hp-continue-row`)
    const card = await rect(page, `${HOME} .hp-continue`)
    const greet = await rect(page, `${HOME} .hp-greet`)
    const composerShown = () => page.evaluate((q) => { const el = document.querySelector(q); return !!el && el.getBoundingClientRect().height > 0 }, `${HOME} .hp-composer`)
    const before = await composerShown()
    const st = await stage.state(page)
    return [
      ['the greeting leads, below the capsules', !!greet && greet.y >= LAYOUT.top, JSON.stringify(greet && { y: greet.y })],
      // 方向 E:卡片换成「继续」—— 最近三项,对话和笔记混排、新的在前(会话 4 / 38 分钟前,笔记 25 分钟前);没有卡片了
      ['Continue: the three most recent, chats and notes mixed, newest first; no cards any more', rows.map((r) => r.name).join() === '发版说明草稿,发版清单 2.13,周末去哪儿' && rows.every((r) => r.when) && !(await page.locator(`${HOME} .hp-card`).count()), JSON.stringify(rows)],
      ['the input is one pill above the dock, below Continue; the full composer hidden', !!pill && near(pill.h, 54) && pill.bottom <= DOCK_TOP - 6 && !!card && pill.y > card.bottom && !before, JSON.stringify({ pill, card: card && card.bottom, before })],
      ['top right holds only search (chats, notes, files); no "more", no avatar (Me is a dock cell)', st.search === '搜索对话、笔记、文件' && st.more === false && !st.right, JSON.stringify({ search: st.search, more: st.more, right: st.right })],
    ]
  },
  // 手机五格 Dock(方向 E 第 1 步):主页 · 对话 · 笔记 · 应用 · 我,固定;Tangu 的列表层标题叫「对话」;别的 Space 算「应用」那格
  'dock-five': async (page) => {
    await stage.space(page, 'home')
    const cells = (st) => (st.spaces || []).map((c) => `${c.id}:${c.label}${c.active ? '*' : ''}${c.pinned ? '' : '?'}`).join(' ')
    const atHome = await stage.state(page)
    await stage.space(page, 'tangu')
    const atChats = await stage.state(page)
    await stage.space(page, 'calendar')
    const atCal = await stage.state(page)
    const calSpace = await shellSpace(page)
    await stage.space(page, 'home')
    return [
      ['five fixed cells, all pinned (≤ five: an older native build draws every cell and no "all" cell)', cells(atHome) === 'home:主页* tangu:对话 amadeus:笔记 @apps:应用 @me:我', cells(atHome)],
      ['the Chats cell is Tangu: its list level is called 对话 and the cell is selected there', atChats.title === '对话' && cells(atChats).includes('tangu:对话*'), `${atChats.title} | ${cells(atChats)}`],
      ['a Space reached through Apps (calendar) lights the Apps cell', calSpace === 'calendar' && cells(atCal).includes('@apps:应用*'), `${calSpace} | ${cells(atCal)}`],
    ]
  },
  'apps-page': async (page) => {
    await stage.space(page, 'home')
    await stage.space(page, '@apps')
    const PAGE = '.mb-phonepage[data-phone-page="apps"]'
    const shown = await page.locator(PAGE).count()
    const st = await stage.state(page)
    const sections = await page.evaluate((q) => [...document.querySelectorAll(`${q} .pp-section`)].map((sec) => ({
      title: sec.querySelector('.pp-section-title')?.textContent ?? '',
      tiles: [...sec.querySelectorAll('.pp-tile')].map((t) => t.getAttribute('data-space')),
      rows: [...sec.querySelectorAll('.pp-row')].map((r) => r.getAttribute('data-row')),
    })), PAGE)
    const frequent = sections.find((x) => x.title === '常用')?.tiles ?? []
    const all = sections.find((x) => x.title === '全部')?.tiles ?? []
    const rows = sections.flatMap((x) => x.rows)
    const box = await rect(page, PAGE)
    const lastApps = await page.evaluate((q) => { const p = document.querySelector(q); p.scrollTop = p.scrollHeight; const rows = p.querySelectorAll('[data-row]'); const r = rows[rows.length - 1]; return r ? { id: r.dataset.row, bottom: r.getBoundingClientRect().bottom } : null }, PAGE)
    await page.evaluate((q) => { document.querySelector(q).scrollTop = 0 }, PAGE)
    await page.screenshot({ path: path.join(OUT, `apps-page-open${DARK ? '-dark' : ''}.png`) })
    // 点「全部」里的一格:收起这一页、进那个 Space,Dock 上亮的仍是「应用」
    const target = all[0] || frequent[0]
    await page.locator(`${PAGE} .pp-tile[data-space="${target}"]`).tap()
    await page.waitForTimeout(700)
    const after = await stage.state(page)
    const gone = !(await page.locator('.mb-phonepage').count())
    const landed = await shellSpace(page)
    // 再开一次,按系统返回:回主页。按不到返回键的这一趟(backPath = event,只问得到列表层)不判,真返回键在模拟器上验
    await stage.space(page, '@apps')
    const via = await systemBack(page)
    const backTo = await shellSpace(page)
    const closed = !(await page.locator('.mb-phonepage').count())
    if (via !== 'key') await stage.space(page, 'home')
    return [
      ['the Apps page covers the first level between the capsules and the dock; title 应用, no left button / ⋯ / search', shown === 1 && st.title === '应用' && !st.left && st.more === false && !st.search && (st.spaces || []).find((c) => c.active)?.id === '@apps' && !!box && near(box.h, SCREEN.height), JSON.stringify({ shown, title: st.title, left: st.left, more: st.more })],
      ['first row 常用 = calendar and inbox, then list order (nothing chosen yet); 全部 = the rest; no Home / Chats / Notes on the page', frequent.slice(0, 2).join() === 'calendar,inbox' && frequent.length <= 4 && ![...frequent, ...all].some((id) => id === 'home' || id === 'tangu' || id === 'amadeus') && !all.some((id) => frequent.includes(id)), JSON.stringify({ frequent, all })],
      ['the store is the first row under the grids; the last row chooses the frequent ones', rows[0] === 'rb-market' && rows[rows.length - 1] === 'choose-frequent', rows.join()],
      ['scrolled to its end, the last row ends above the dock', !!lastApps && lastApps.id === 'choose-frequent' && lastApps.bottom <= DOCK_TOP, JSON.stringify({ lastApps, dockTop: DOCK_TOP })],
      ['a tile closes the page and enters that Space; the dock lights Apps', gone && landed === target && (after.spaces || []).find((c) => c.active)?.id === '@apps', `${target} → ${landed} gone=${gone}`],
      [`system Back on the Apps page goes Home (${via === 'key' ? 'key' : 'no back key on this load — checked on the emulator'})`, via !== 'key' || (closed && backTo === 'home'), `${backTo} closed=${closed}`],
    ]
  },
  'me-page': async (page) => {
    await stage.space(page, 'home')
    await stage.space(page, '@me')
    const PAGE = '.mb-phonepage[data-phone-page="me"]'
    await page.waitForFunction((q) => !document.querySelector(`${q} [data-row="account-loading"]`), PAGE, { timeout: 8000 }).catch(() => {})
    const st = await stage.state(page)
    const rows = await page.evaluate((q) => [...document.querySelectorAll(`${q} [data-row]`)].map((r) => r.getAttribute('data-row')), PAGE)
    const name = await page.evaluate((q) => document.querySelector(`${q} .pp-me-name strong`)?.textContent ?? '', PAGE)
    // 滚到底:最后一行(退出)整行在 Dock 之上
    const lastMe = await page.evaluate((q) => { const p = document.querySelector(q); p.scrollTop = p.scrollHeight; const rows = p.querySelectorAll('[data-row]'); const r = rows[rows.length - 1]; return r ? { id: r.dataset.row, bottom: r.getBoundingClientRect().bottom } : null }, PAGE)
    await page.evaluate((q) => { document.querySelector(q).scrollTop = 0 }, PAGE)
    await page.screenshot({ path: path.join(OUT, `me-page-open${DARK ? '-dark' : ''}.png`) })
    // 设置盖上来、关掉之后,「我」还在
    await page.locator(`${PAGE} [data-row="rb-settings"]`).tap()
    await page.waitForTimeout(800)
    const app = (await page.evaluate(async (url) => { const { useApp } = await import(/* @vite-ignore */ url); return { open: useApp.getState().settingsOpen } }, moduleUrl('../desktop/frontend/src/stores/appStore.ts')))
    const covered = (await stage.state(page)).mode !== 'shell'
    await page.evaluate(async (url) => { const { useApp } = await import(/* @vite-ignore */ url); useApp.getState().closeSettings() }, moduleUrl('../desktop/frontend/src/stores/appStore.ts'))
    await page.waitForTimeout(700)
    const still = await page.locator(PAGE).count()
    await systemBack(page)
    return [
      ['the Me page: title 我, the Me cell lit, no avatar and no ⋯ in the capsules', st.title === '我' && (st.spaces || []).find((c) => c.active)?.id === '@me' && st.more === false, JSON.stringify({ title: st.title, more: st.more })],
      ['account head, then quota / backpack / invite / upgrade (what the avatar menu had), settings, where it runs, dark mode, command palette, achievements, feedback, sign out', name === 'stage' && ['rb-settings', 'rb-units-mobile', 'rb-mode', 'rb-cmd', 'rb-achievements'].every((id) => rows.includes(id)) && rows.indexOf('rb-settings') < rows.indexOf('rb-achievements'), `${name} | ${rows.join()}`],
      ['settings covers the page and closing it returns to Me', app.open && covered && still === 1, JSON.stringify({ ...app, covered, still })],
      ['scrolled to its end, the last row (sign out) ends above the dock', !!lastMe && lastMe.id === 'logout' && lastMe.bottom <= DOCK_TOP, JSON.stringify({ lastMe, dockTop: DOCK_TOP })],
    ]
  },
  // 主页「继续」点一行 → 直接到那条对话;返回(顶栏左钮 / 系统返回)回主页,不经 Tangu 的列表;
  // 先在列表里看过另一条(甲)再回主页点乙,返回也不翻出甲(listTrips 只在列表层起算的那条坑)
  'continue-trip': async (page) => {
    await openChat(page, '周末去哪儿')
    await stage.action(page, 'left')
    await stage.space(page, 'home')
    const row = '.mb-view[data-view="homepage"] .hp-continue-row[data-continue="chat:st-1"]'
    await page.locator(row).tap()
    await page.waitForFunction(() => document.querySelector('.mb-shell')?.getAttribute('data-nav') === 'detail', null, { timeout: 6000 }).catch(() => {})
    await page.waitForTimeout(600)
    const inChat = { space: await shellSpace(page), nav: await stage.nav(page), title: (await stage.state(page)).title }
    await stage.action(page, 'left')
    const byButton = await shellSpace(page)
    await page.locator(row).tap()
    await page.waitForFunction(() => document.querySelector('.mb-shell')?.getAttribute('data-nav') === 'detail', null, { timeout: 6000 }).catch(() => {})
    await page.waitForTimeout(600)
    const via = await systemBack(page)
    const bySystem = await shellSpace(page)
    if (via !== 'key') await stage.action(page, 'left')
    // 笔记那一行:走的是另一条路(openNote 是异步的、去的是笔记 Space),返回同样回主页
    await seedNotes(page)
    const noteRow = '.mb-view[data-view="homepage"] .hp-continue-row[data-continue^="note:"]'
    const noteTrip = []
    for (const how of ['capsule', 'system']) {
      await page.locator(noteRow).first().tap()
      await page.waitForFunction(() => document.querySelector('.mb-shell')?.getAttribute('data-nav') === 'detail', null, { timeout: 6000 }).catch(() => {})
      await page.waitForTimeout(900)
      const at = { space: await shellSpace(page), nav: await stage.nav(page) }
      let via = how
      if (how === 'capsule') await stage.action(page, 'left')
      else { via = await systemBack(page); if (via !== 'key') await stage.action(page, 'left') }
      await page.waitForTimeout(500)
      noteTrip.push({ how: via, at, back: await shellSpace(page) })
    }
    // 从列表点进去的照旧回列表
    await openChat(page, '周末去哪儿')
    await stage.action(page, 'left')
    const fromList = { space: await shellSpace(page), nav: await stage.nav(page) }
    await stage.space(page, 'home')
    return [
      ['a Continue row opens that chat directly (Tangu, second level)', inChat.space === 'tangu' && inChat.nav === 'detail' && inChat.title === '发版说明草稿', JSON.stringify(inChat)],
      ['back from there (capsule) goes Home, not to the list — and not to the chat seen before', byButton === 'home', byButton],
      [`system Back goes Home too (${via === 'key' ? 'key' : 'no back key on this load — checked on the emulator'})`, via !== 'key' || bySystem === 'home', bySystem],
      ['a note row opens the note itself (Notes, second level); back from it is Home too', noteTrip.every((t) => t.at.space === 'amadeus' && t.at.nav === 'detail' && t.back === 'home'), JSON.stringify(noteTrip)],
      ['a chat opened from the list still goes back to the list', fromList.space === 'tangu' && fromList.nav === 'list', JSON.stringify(fromList)],
    ]
  },
  'home-open': async (page) => {
    const HOME = '.mb-view[data-view="homepage"]'
    await page.locator(`${HOME} .hp-pill`).tap()
    await page.waitForTimeout(500)
    const focused = await page.evaluate(() => document.activeElement?.matches('.hp-composer .t2c-ta') ?? false)
    const shown = await page.evaluate((q) => { const el = document.querySelector(q); return !!el && el.getBoundingClientRect().height > 0 }, `${HOME} .hp-composer`)
    return [['a tap on the pill opens the full composer with the caret in it; Continue makes room', shown && focused && !(await rect(page, `${HOME} .hp-continue`))?.h, `focused=${focused}`]]
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
  'tangu-fab': async (page) => {
    // 6.20 A (walkthrough round 6): scrolling down by more than 8 dp moves the main button out of the way, scrolling back
    // up by more than 8 dp (or to the top) brings it back; a nudge either way does nothing
    const sc = `${LIST} .t2s-scroll`
    const at = async (y) => { await page.evaluate(([q, v]) => { document.querySelector(q).scrollTop = v }, [sc, y]); await page.waitForTimeout(350); return page.evaluate((q) => document.querySelector(q)?.hasAttribute('data-away'), `${LIST} .pl-fab`) }
    const seen = { nudge: await at(5), down: await at(160) }
    fs.writeFileSync(path.join(OUT, `tangu-fab-down${DARK ? '-dark' : ''}.png`), await page.screenshot())
    seen.smallUp = await at(155)
    seen.up = await at(140)
    seen.downAgain = await at(200)
    seen.top = await at(0)
    return [['the main button leaves while scrolling down and comes back on a scroll up or at the top', JSON.stringify(seen) === JSON.stringify({ nudge: false, down: true, smallUp: true, up: false, downAgain: true, top: false }), JSON.stringify(seen)]]
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
      // the thinking is the head of the answer's process row since 10-17 (b16e945ed): one row for thinking and tools
      const heads = root.querySelectorAll('.t2-asst .tool-group-head'); const think = heads.length === 1 ? heads[0] : null
      const copy = root.querySelector('.t2-asst .t2-content pre ~ .icon-btn')
      return { heads: heads.length, think: think && [takes(think, 0, -22), takes(think, 0, 22)], copy: copy && [takes(copy, 0, 23), takes(copy, -23, 0)] }
    }, CHAT)
    const d = JSON.stringify(m)
    return [
      ['the thinking row (the process row\'s head) takes a touch 22 dp above and below its middle', !!m.think && m.think.every((x) => x.ok), d],
      ['the copy key of a code block takes a touch 23 dp below and beside its middle', !!m.copy && m.copy.every((x) => x.ok), d],
    ]
  },
  // What the chat page leaves out on a phone: the user's own name; the agent's name while one agent answers; a time
  // unless the message comes more than five minutes after the one before; the row of keys except under the last answer.
  // A tap on a message brings its time and its row out, a second tap or a tap elsewhere puts them back.
  'chat-quiet': async (page) => {
    await openChat(page, '年终总结提纲')
    await page.waitForSelector(`${CHAT} #tocmsg-st-q1`, { timeout: 10_000 }) // the earlier messages are mounted in idle time
    await page.waitForTimeout(400)
    const text = (id) => page.locator(`${CHAT} #tocmsg-st-${id} :is(.t2-content p, .t2-user)`).first()
    const tap = async (target) => { await target.tap(); await page.waitForTimeout(250); return messageChrome(page) }
    const rest = await messageChrome(page)
    // the answer that carries a time without being the last (it is on screen at the conversation's end: the shot)
    const onTimed = await tap(text('q6'))
    await page.screenshot({ path: path.join(OUT, `chat-quiet-tapped${DARK ? '-dark' : ''}.png`) })
    const onAnswer = await tap(text('q2'))
    const onQuestion = await tap(text('q5'))
    const again = await tap(text('q5'))
    const onKey = await tap(page.locator(`${CHAT} #tocmsg-st-q4 .t2-content pre ~ .icon-btn`).first())
    await page.evaluate((q) => getSelection().selectAllChildren(document.querySelector(q)), `${CHAT} #tocmsg-st-q6 .t2-content p`)
    const onSelected = await tap(text('q4'))
    await page.evaluate(() => getSelection().removeAllRanges())
    const elsewhere = [await tap(text('q2')), await tap(page.locator(`${CHAT} .t2c-ta`).first())]
    await page.evaluate(() => document.activeElement?.blur())
    // What follows the last answer, put straight into the app's store (ids st-q9 … are taken away again at the end):
    const app = moduleUrl('../desktop/frontend/src/stores/appStore.ts')
    const follow = async (extra) => {
      await page.evaluate(async ([url, more]) => {
        const { useApp } = await import(/* @vite-ignore */ url)
        useApp.setState((s) => {
          const sid = Object.keys(s.messagesBySession).find((k) => s.messagesBySession[k].some((m) => m.id === 'st-q1'))
          return { messagesBySession: { ...s.messagesBySession, [sid]: [...s.messagesBySession[sid].filter((m) => !/^st-q(9|1\d)$/.test(m.id)), ...more] } }
        })
      }, [app, extra])
      if (extra.length) await page.waitForSelector(`${CHAT} #tocmsg-${extra[extra.length - 1].id}`, { timeout: 5000 })
      await page.waitForTimeout(400)
      return messageChrome(page)
    }
    // an answer on its way with nothing written yet: its name row (and the dot in it) is left out like any other, so the
    // line that says it is thinking is what tells the answer is coming; the keys stay under the answer before it
    const whileComing = await follow([{ id: 'st-q9', role: 'assistant', content: '', status: 'streaming', timestamp: T0 }])
    const coming = await page.evaluate((q) => {
      const m = document.querySelector(q), line = m.querySelector('.chat-thinking-live')
      return { quiet: m.getAttribute('data-quiet'), name: getComputedStyle(m.querySelector('.t2-name')).display, line: line ? line.textContent.trim() : null, h: line ? line.getBoundingClientRect().height : 0 }
    }, `${CHAT} #tocmsg-st-q9`)
    await page.screenshot({ path: path.join(OUT, `chat-quiet-coming${DARK ? '-dark' : ''}.png`) })
    // a run that failed: its row is the error with "retry", it has no keys of its own — the answer before it keeps them
    const afterFailure = await follow([{ id: 'st-q9', role: 'assistant', content: '', status: 'error', error: 'stage: the run failed', timestamp: T0 }])
    // an answer stopped before a word was written has no text to tap: its row stays out, though it is not the last one
    const withBare = await follow([
      { id: 'st-q9', role: 'assistant', content: '', status: 'stopped', timestamp: T0 },
      { id: 'st-q10', role: 'user', content: '继续。', status: 'done', timestamp: T0 + MIN },
      { id: 'st-q11', role: 'assistant', content: '好，接着写第二部分。', status: 'done', timestamp: T0 + 2 * MIN },
    ])
    await page.screenshot({ path: path.join(OUT, `chat-quiet-bare${DARK ? '-dark' : ''}.png`) })
    await follow([])
    await page.evaluate((q) => { const el = document.querySelector(q); el.scrollTop = el.scrollHeight }, `${CHAT} .t2-stream`)
    const of = (rows, id) => rows.find((r) => r.id === id) || {}
    const brief = (rows) => JSON.stringify(rows.map((r) => `${r.id}[${r.quiet}]${r.name ? ' name' : ''}${r.time ? ' time' : ''}${r.keys ? ` keys=${r.keys}` : ''}${r.tapped ? ' tapped' : ''}`))
    return [
      ['one agent: no name over the answers, none over the user\'s own messages', rest.length === 8 && rest.every((r) => !r.name), brief(rest)],
      ['a time on the first message, on each one five minutes or more after the one before, and in the last answer\'s row', idsOf(rest, (r) => r.time) === 'q1,q3,q6,q8', brief(rest)],
      ['the row of keys stays under the last answer only', idsOf(rest, (r) => r.keys > 0) === 'q8' && of(rest, 'q8').keys >= 2, brief(rest)],
      ['an earlier answer that carries a time shows the time alone; a tap brings its keys out beside it', !of(rest, 'q6').keys && of(onTimed, 'q6').keys >= 2 && of(onTimed, 'q6').time && idsOf(onTimed, (r) => r.tapped) === 'q6', brief(onTimed)],
      ['a tap on another earlier answer brings out its keys and its time, and puts the first one back', of(onAnswer, 'q2').keys >= 2 && of(onAnswer, 'q2').time && idsOf(onAnswer, (r) => r.tapped) === 'q2' && idsOf(onAnswer, (r) => r.keys > 0) === 'q2,q8', brief(onAnswer)],
      ['a tap on a question brings out its time (its keys stay behind the long-press) and puts the answer back', of(onQuestion, 'q5').time && !of(onQuestion, 'q5').keys && idsOf(onQuestion, (r) => r.tapped) === 'q5' && !of(onQuestion, 'q2').keys && !of(onQuestion, 'q2').time, brief(onQuestion)],
      ['a second tap puts it back', idsOf(again, (r) => r.tapped) === '' && idsOf(again, (r) => r.time) === 'q1,q3,q6,q8', brief(again)],
      ['a tap on a code block\'s copy key is not a tap on the message', idsOf(onKey, (r) => r.tapped) === '', brief(onKey)],
      ['with text selected a tap only drops the selection', idsOf(onSelected, (r) => r.tapped) === '', brief(onSelected)],
      ['a tap elsewhere (the input) puts the message back', idsOf(elsewhere[0], (r) => r.tapped) === 'q2' && idsOf(elsewhere[1], (r) => r.tapped) === '', brief(elsewhere[1])],
      ['an answer still on its way: no name row, the line that says it is thinking shows; the row of keys stays under the answer before it', /\bsolo\b/.test(coming.quiet || '') && !/\blast\b/.test(coming.quiet || '') && coming.name === 'none' && coming.line === '思考中' && coming.h > 0 && of(whileComing, 'q8').keys >= 2 && idsOf(whileComing, (r) => r.keys > 0) === 'q8', JSON.stringify({ coming, rows: JSON.parse(brief(whileComing)) })],
      ['a run that failed has no keys of its own: the answer before it keeps them', of(afterFailure, 'q8').keys >= 2 && !of(afterFailure, 'q9').keys && idsOf(afterFailure, (r) => r.keys > 0) === 'q8', brief(afterFailure)],
      ['an answer with nothing written (stopped before a word) keeps its row out, though it is not the last; the last answer has the keys', /\bbare\b/.test(of(withBare, 'q9').quiet || '') && of(withBare, 'q9').keys >= 1 && !of(withBare, 'q8').keys && of(withBare, 'q11').keys >= 2 && idsOf(withBare, (r) => r.tapped) === '', brief(withBare)],
    ]
  },
  'chat-quiet-team': async (page) => {
    await openChat(page, '周报小组')
    await page.waitForSelector(`${CHAT} #tocmsg-st-t1`, { timeout: 10_000 })
    await page.waitForTimeout(400)
    const rows = await messageChrome(page)
    const names = await texts(page, `${CHAT} .t2-stream-inner > .t2-asst .t2-name`)
    const brief = JSON.stringify({ names, rows: rows.map((r) => `${r.id}[${r.quiet}]${r.name ? ' name' : ''}${r.time ? ' time' : ''}${r.keys ? ` keys=${r.keys}` : ''}`) })
    return [
      ['a team\'s conversation keeps each speaker\'s name; the user\'s own is still not written', names.join() === '研究员,编辑' && idsOf(rows, (r) => r.name) === 't2,t3', brief],
      ['times and keys follow the same rule there', idsOf(rows, (r) => r.time) === 't1,t3' && idsOf(rows, (r) => r.keys > 0) === 't3', brief],
    ]
  },
  'chat-leave': async (page) => {
    await stage.action(page, 'left')
    return [['back on the list', (await stage.nav(page)) === 'list', await stage.nav(page)]]
  },
  // On a phone "more" holds only what belongs to the page on screen. First-level pages (Home, a Space's list) have no
  // button; a conversation has its own rows (pin, rename, archive, find) and nothing app-wide. The app-wide entries are in
  // the avatar's menu (settings, theme mode, command palette) and in the all-Spaces sheet (store, achievements…), once
  // each. No back / forward row on top of a page: system Back walks the same history. The menus are native — a stand-in
  // presenter records what is asked for and answers, as in chat-card.
  'page-more': async (page) => {
    const rows = []
    if ((await stage.nav(page)) === 'detail') await stage.action(page, 'left')
    await page.evaluate(async (url) => {
      const st = window.__stage; st.menus = []; st.answer = null
      st.offSheet = (await import(/* @vite-ignore */ url)).installNativeSheetPresenter(async (payload) => { st.menus.push(payload); const a = st.answer; st.answer = null; return a })
    }, moduleUrl('../lcl/engine/nativeSheet.ts'))
    const ask = async (action, answer = null) => {
      await page.evaluate((a) => { window.__stage.answer = a }, answer)
      const before = await page.evaluate(() => window.__stage.menus.length)
      await stage.action(page, action)
      await page.waitForFunction((n) => window.__stage.menus.length > n, before, { timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(400)
      return page.evaluate((n) => window.__stage.menus[n] || null, before)
    }
    const sections = (menu) => (menu?.sections || []).map((x) => x.items.map((i) => i.id))
    const navRows = () => page.evaluate(() => document.querySelectorAll('.lcl-viewnav-fallback').length)
    const TITLE = '发版说明草稿'

    // first level: Home, then a Space's list
    await stage.space(page, 'home')
    const home = await stage.state(page)
    rows.push(['Home: no "more" button and no back / forward row', home.more === false && (await navRows()) === 0, JSON.stringify({ more: home.more, navRows: await navRows() })])
    await stage.space(page, 'tangu'); await chip(page, 'all')
    const list = await stage.state(page)
    rows.push(["a Space's list: no \"more\" button", list.more === false, `more=${list.more}`])

    // where the app-wide entries went: no sheet any more —「全部」那一格换成了「应用」页,头像菜单换成了「我」页(方向 E,phonePageItems)
    const before = await page.evaluate(() => window.__stage.menus.length)
    await stage.action(page, 'spacesAll')
    await page.waitForTimeout(500)
    const sheets = await page.evaluate((n) => window.__stage.menus.length - n, before)
    const appsPage = await page.locator('.mb-phonepage[data-phone-page="apps"]').count()
    const appsRows = await page.evaluate(() => [...document.querySelectorAll('.mb-phonepage [data-row]')].map((r) => r.getAttribute('data-row')))
    rows.push(['"all" opens the Apps page, not a sheet: the store and the other launchers are rows there', sheets === 0 && appsPage === 1 && appsRows[0] === 'rb-market', JSON.stringify({ sheets, appsPage, appsRows })])
    await stage.space(page, '@me')
    const meRows = await page.evaluate(() => [...document.querySelectorAll('.mb-phonepage [data-row]')].map((r) => r.getAttribute('data-row')))
    const avatar = await page.evaluate(async (url) => (await import(/* @vite-ignore */ url)).accountMenuRows().map((r) => r.id), moduleUrl('../lcl/engine/SingleColumnHost.tsx'))
    const at = (id) => meRows.indexOf(id)
    rows.push(['what the avatar menu had is on the Me page: settings first, then theme mode and the command palette, achievements after; no avatar menu rows left', avatar.length === 0 && at('rb-settings') >= 0 && at('rb-settings') < at('rb-mode') && at('rb-mode') < at('rb-cmd') && at('rb-cmd') < at('rb-achievements'), JSON.stringify({ avatar, meRows })])
    await stage.space(page, 'tangu')

    // a conversation: its own rows only
    await openChat(page, TITLE)
    const chat = await stage.state(page)
    const menu = await ask('more')
    rows.push(['a conversation: "more" is there, titled with the conversation', chat.more !== false && menu?.title === TITLE, JSON.stringify({ more: chat.more, title: menu?.title })])
    rows.push(['its rows: pin, rename, archive, then find — nothing app-wide, no "new tab"', JSON.stringify(sections(menu)) === JSON.stringify([['page:pin', 'page:rename', 'page:archive'], ['page:find']]), JSON.stringify(sections(menu))])
    const top = await page.evaluate((q) => {
      const stream = document.querySelector(`${q} .t2-stream`)
      const probe = document.createElement('div'); probe.style.cssText = 'position:absolute;visibility:hidden;height:var(--mb-top)'
      stream.parentElement.appendChild(probe)
      const out = { pad: parseFloat(getComputedStyle(stream).paddingTop), mbTop: probe.getBoundingClientRect().height / (stream.getBoundingClientRect().width / stream.offsetWidth || 1), navrow: stream.closest('.mb-view').hasAttribute('data-navrow') }
      probe.remove()
      return out
    }, CHAT)
    rows.push(['no back / forward row: the stream starts right under the capsule row (no 40 kept for it)', (await navRows()) === 0 && !top.navrow && near(top.pad, top.mbTop, 1), JSON.stringify(top)])
    await page.screenshot({ path: path.join(OUT, `page-more-chat${DARK ? '-dark' : ''}.png`) })

    // pin from the page: stored, the list re-reads, the row turns into "unpin"
    await ask('more', { id: 'page:pin' })
    const pinned = sections(await ask('more'))[0]?.[0]
    const stored = await page.evaluate(() => localStorage.getItem('forsion_orbits_pinned_entries_v1'))
    await stage.action(page, 'left')
    const first = (await texts(page, `${LIST} [data-timeline] .t2s-srow-title`))[0]
    const secs = await texts(page, `${LIST} [data-timeline] .pl-sec`)
    rows.push(['pinning from the page: the row reads "unpin" next time and the list shows it pinned without a reload', pinned === 'page:unpin' && first === TITLE && secs[0] === '置顶', JSON.stringify({ pinned, stored, first, secs: secs.slice(0, 2) })])
    await openChat(page, TITLE)
    await ask('more', { id: 'page:unpin' })

    // rename asks for the new name with the current one filled in (closed without a change here)
    const prompt = await (async () => {
      await page.evaluate(() => { window.__stage.answer = { id: 'page:rename' } })
      const before = await page.evaluate(() => window.__stage.menus.length)
      await stage.action(page, 'more')
      await page.waitForFunction((n) => window.__stage.menus.length > n + 1, before, { timeout: 5000 }).catch(() => {})
      return page.evaluate((n) => window.__stage.menus[n + 1] || null, before)
    })()
    rows.push(['rename: a prompt with the current name', prompt?.kind === 'prompt' && prompt.initial === TITLE, JSON.stringify({ kind: prompt?.kind, initial: prompt?.initial })])

    // find opens the find bar on this page
    await ask('more', { id: 'page:find' })
    const bar = await rect(page, '.amx-findbar')
    const zoom = await page.evaluate(() => Number(getComputedStyle(document.body).zoom) || 1)
    const placed = (b) => !!b && near(b.y, LAYOUT.top + 8 * zoom, 2) && near(SCREEN.width - b.right, 8 * zoom, 1.5) && b.x >= 0
    rows.push(['find: the find bar opens right under the capsule row, 8 from the right edge, inside the screen', placed(bar), JSON.stringify({ bar, capsulesEnd: LAYOUT.top, zoom })])
    await page.screenshot({ path: path.join(OUT, `page-more-find${DARK ? '-dark' : ''}.png`) })
    // system Back closes the bar first and stays on the conversation (the bar listens to Esc only; a phone has no such key)
    // (asked only on a load where this stage's Back key reaches MobileRoot's chain — see backPath; the emulator suite asks it always)
    if ((await backPath(page)) === 'key') {
      await systemBack(page)
      await page.waitForTimeout(250)
      rows.push(['find: system Back closes the bar and stays on the conversation', !(await rect(page, '.amx-findbar')) && (await stage.nav(page)) === 'detail', JSON.stringify({ bar: await rect(page, '.amx-findbar'), nav: await stage.nav(page) })])
    } else {
      console.log('(page-more: the Back key does not reach the chain on this load — "Back closes the find bar" not asked)')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    }
    // leaving the page by the top-left button takes the bar with it (both levels stay mounted: nothing unmounts to close it)
    await ask('more', { id: 'page:find' })
    const again = await rect(page, '.amx-findbar')
    await stage.action(page, 'left')
    await page.waitForFunction(() => document.querySelector('.mb-shell')?.getAttribute('data-nav') === 'list', null, { timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(250)
    rows.push(['find: going back to the list closes the bar', !!again && !(await rect(page, '.amx-findbar')) && (await stage.nav(page)) === 'list', JSON.stringify({ opened: !!again, bar: await rect(page, '.amx-findbar'), nav: await stage.nav(page) })])
    // opened on the list level (the command palette's "find in page"): the same place — the list sits in a drawer that
    // has a zoom of its own and already starts below the capsule row; going into a conversation closes it
    await page.evaluate(async (url) => { (await import(/* @vite-ignore */ url)).openFindBar() }, moduleUrl('../desktop/frontend/src/findInPage.tsx'))
    await page.waitForTimeout(250)
    const onList = await rect(page, '.amx-findbar')
    // a whole page (settings) coming up over the list takes the bar away: it would float above that page otherwise
    const appUrl = moduleUrl('../desktop/frontend/src/stores/appStore.ts')
    await page.evaluate(async (url) => { (await import(/* @vite-ignore */ url)).useApp.getState().openSettings() }, appUrl)
    await page.waitForTimeout(300)
    const underPage = await rect(page, '.amx-findbar')
    await page.evaluate(async (url) => { (await import(/* @vite-ignore */ url)).useApp.getState().closeSettings() }, appUrl)
    await page.waitForTimeout(300)
    rows.push(['find on the list level: opening settings over it closes the bar', !!onList && !underPage, JSON.stringify({ opened: !!onList, bar: underPage })])
    await page.evaluate(async (url) => { (await import(/* @vite-ignore */ url)).openFindBar() }, moduleUrl('../desktop/frontend/src/findInPage.tsx'))
    await page.waitForTimeout(250)
    // (the bar floats over the row of chips, as a find bar does: the conversation's own row below it is tapped)
    await page.locator(`${LIST} [data-timeline] .t2s-srow`, { hasText: TITLE }).first().tap()
    await page.waitForFunction(() => document.querySelector('.mb-shell')?.getAttribute('data-nav') === 'detail', null, { timeout: 6000 }).catch(() => {})
    await page.waitForTimeout(600)
    rows.push(['find on the list level: the same place; opening a conversation closes it', placed(onList) && !(await rect(page, '.amx-findbar')) && (await stage.nav(page)) === 'detail', JSON.stringify({ onList, bar: await rect(page, '.amx-findbar'), nav: await stage.nav(page) })])
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    if (await rect(page, '.amx-findbar')) await page.evaluate(async (url) => { (await import(/* @vite-ignore */ url)).closeFindBar() }, moduleUrl('../desktop/frontend/src/findInPage.tsx'))

    // archive from the page: once it is stored the page has nothing left to do — back on the list, the row gone from it
    await ask('more', { id: 'page:archive' })
    await page.waitForFunction(() => document.querySelector('.mb-shell')?.getAttribute('data-nav') === 'list', null, { timeout: 6000 }).catch(() => {})
    await page.waitForTimeout(400)
    const gone = { nav: await stage.nav(page), rows: await texts(page, `${LIST} [data-timeline] .t2s-srow .t2s-srow-title`) }
    rows.push(['archive: back on the list, and the conversation is no longer in it', gone.nav === 'list' && gone.rows.length > 0 && !gone.rows.includes(TITLE), JSON.stringify(gone)])
    // (put it back for the scenes after this one)
    await page.evaluate(async (url) => { await (await import(/* @vite-ignore */ url)).useApp.getState().archiveSession('st-1', false) }, moduleUrl('../desktop/frontend/src/stores/appStore.ts'))
    await page.waitForTimeout(400)
    await openChat(page, TITLE)

    await page.evaluate(() => { window.__stage.offSheet(); delete window.__stage.offSheet })
    await stage.action(page, 'left')
    return rows
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
    const chips = await texts(page, `${LIST} .pl-chips button`)
    const switcher = await page.evaluate((q) => !!document.querySelector(`${q} .mb-drawer-bar, ${q} select`), LIST)
    const left = await leftSide(page)
    return [
      ['four chips, tags last; no view switcher over the list, though the Space still has its three left views', chips.join() === '最近,文件夹,白板,标签' && !switcher && left.types.join() === 'workspace,amadeus-search,amadeus-tags', JSON.stringify({ chips, switcher, left })],
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
  // Tags are the fourth chip: the tag tree in place of the list, in the list's own scroller. A tag's notes (the vault's
  // full-text search with a tag condition) are shown in the list as well — that level draws one left view, so the left
  // search view the tap activates is not on screen; the search row's heading leads back.
  'notes-tags': async (page) => {
    await seedTags(page)
    await chip(page, 'tags')
    await page.waitForSelector(`${LIST} .amx-tags-inlist .amx-tagtree-row`, { timeout: 6000 }).catch(() => {})
    const TAGS = `${LIST} .t2s-scroll .amx-tags-inlist`
    const tags = await page.evaluate((q) => [...document.querySelectorAll(`${q} .amx-tagtree-row`)].map((row) => { const r = row.getBoundingClientRect(); return { name: row.querySelector('.amx-tag-name').textContent, count: row.querySelector('.amx-tag-count').textContent, h: r.height, x: row.querySelector('.amx-tag-name').getBoundingClientRect().left } }), TAGS)
    const chrome = await page.evaluate((q) => ({ on: document.querySelector(`${q} .pl-chips .on`)?.textContent, head: !!document.querySelector(`${q} .amx-panel-head`), filter: !!document.querySelector(`${q} .amx-tags-inlist-bar .amx-tagtree-search input`), sort: [...document.querySelectorAll(`${q} .amx-tags-inlist-bar .amx-tagtree-sort button`)].map((b) => b.textContent.trim() + (b.classList.contains('on') ? '*' : '')), tree: !!document.querySelector(`${q} .t2s-group, ${q} [data-timeline]`), switcher: !!document.querySelector(`${q} .mb-drawer-bar, ${q} select`), stored: localStorage.getItem('forsion_notes_phone_tab') }), LIST)
    const fab = await rect(page, `${LIST} .pl-fab`)
    await page.screenshot({ path: path.join(OUT, `notes-tags${DARK ? '-dark' : ''}.png`) })
    // the filter narrows the tree as it is typed in; the sort keys change the order (count ↔ name) — put back afterwards
    const names = () => texts(page, `${TAGS} .amx-tagtree-row .amx-tag-name`)
    const byCount = await names()
    await page.locator(`${TAGS} .amx-tags-inlist-bar .amx-tagtree-sort button`, { hasText: '名称' }).tap()
    await page.waitForTimeout(300)
    const byName = await names()
    await page.locator(`${TAGS} .amx-tags-inlist-bar .amx-tagtree-sort button`, { hasText: '数量' }).tap()
    await page.waitForTimeout(300)
    await page.locator(`${TAGS} .amx-tags-inlist-bar input`).fill('读')
    await page.waitForTimeout(300)
    const filtered = await names()
    const bar = await rect(page, `${TAGS} .amx-tags-inlist-bar`)
    await page.screenshot({ path: path.join(OUT, `notes-tags-filter${DARK ? '-dark' : ''}.png`) })
    await page.locator(`${TAGS} .amx-tags-inlist-bar input`).fill('')
    await page.evaluate(() => document.activeElement?.blur())
    await page.waitForTimeout(300)
    // a nested tag opens in place
    await page.locator(`${TAGS} .amx-tagtree-chev`).first().tap()
    await page.waitForTimeout(400)
    const open = await texts(page, `${TAGS} .amx-tag-name`)
    // a tag's notes
    await page.locator(`${TAGS} .amx-tag`, { hasText: '待整理' }).first().tap()
    await page.waitForSelector(`${LIST} .t2s-scroll .amx-panel--inlist .amx-taghit-file`, { timeout: 6000 }).catch(() => {})
    await page.waitForTimeout(300)
    const PANE = `${LIST} .t2s-scroll .amx-panel--inlist`
    const hits = await page.evaluate((q) => ({ query: document.querySelector(`${q} input`)?.value, files: [...document.querySelectorAll(`${q} .amx-taghit-file .amx-tag-name`)].map((el) => el.textContent), focused: document.activeElement?.tagName, scrolls: getComputedStyle(document.querySelector(q)).overflowY, chips: document.querySelectorAll('.mb-drawer--left .pl-chips button').length }), PANE)
    const side = await leftSide(page)
    const nav = await stage.nav(page)
    await page.screenshot({ path: path.join(OUT, `notes-tag-hits${DARK ? '-dark' : ''}.png`) })
    // into a note and back: the hits are still there; the heading row returns to the tags
    await page.locator(`${PANE} .amx-taghit-file`).first().tap()
    await page.waitForFunction(() => document.querySelector('.mb-shell')?.getAttribute('data-nav') === 'detail', null, { timeout: 6000 }).catch(() => {})
    const opened = await stage.nav(page)
    await stage.action(page, 'left')
    const kept = await page.evaluate((q) => document.querySelectorAll(`${q} .amx-taghit-file`).length, PANE)
    await page.locator(`${PANE} .amx-panel-back`).tap()
    await page.waitForTimeout(300)
    const listLook = () => page.evaluate((q) => ({ pane: !!document.querySelector(`${q} .amx-panel--inlist`), tags: document.querySelectorAll(`${q} .amx-tags-inlist .amx-tagtree-row`).length }), LIST)
    const back = await listLook()
    // system Back with a tag's notes open: the notes close and the tags are back, still on the list; the Back after
    // that is the one that leaves the level. With something above the list holding Back (a sheet), the notes stay.
    await page.locator(`${TAGS} .amx-tag`, { hasText: '待整理' }).first().tap()
    await page.waitForSelector(`${PANE} .amx-taghit-file`, { timeout: 6000 }).catch(() => {})
    const held = await listHoldsBack(page)
    let under = null
    if ((await backPath(page)) === 'key') {
      await page.evaluate(() => { window.__stage.sheetBack = (e) => e.preventDefault(); window.addEventListener('forsion:mobile-back', window.__stage.sheetBack) })
      await systemBack(page)
      under = await listLook()
      await page.evaluate(() => { window.removeEventListener('forsion:mobile-back', window.__stage.sheetBack); delete window.__stage.sheetBack })
    }
    const via = await systemBack(page)
    const first = { ...(await listLook()), nav: await stage.nav(page), space: await shellSpace(page), holds: await listHoldsBack(page) }
    await systemBack(page)
    const second = { space: await shellSpace(page) }
    if (second.space !== 'amadeus') await stage.space(page, 'amadeus')
    return [
      ['Tags: the tag tree in the list with its filter and its sort keys in one row — no heading of its own, no folder tree, the main button stays', chrome.on === '标签' && chrome.stored === 'tags' && !chrome.head && chrome.filter && chrome.sort.join() === '按数量*,按名称' && !chrome.tree && !chrome.switcher && !!fab && tags.map((t) => `${t.name}=${t.count}`).sort().join() === ['工作=2', '待整理=2', '读书=1'].sort().join(), JSON.stringify({ chrome, tags })],
      ['the sort keys reorder the tags (by count, by name); typing in the filter narrows them; the row fits the screen', byCount.length === 3 && byName.length === 3 && byName.join() === byCount.slice().sort((a, b) => a.localeCompare(b, 'zh')).join() && byName.join() !== byCount.join() && filtered.join() === '读书' && !!bar && bar.x >= 0 && bar.right <= SCREEN.width, JSON.stringify({ byCount, byName, filtered, bar })],
      ['a row is a touch target (48 dp) and starts where the list\'s rows do', tags.length === 3 && tags.every((t) => near(t.h, 48, 1) && t.x >= 16 && t.x <= 60), JSON.stringify(tags)],
      ['a parent tag opens to its nested tags in place', open.length === 4 && open.indexOf('周报') === open.indexOf('工作') + 1, open.join()],
      ['a tap on a tag lists its notes in the list (still the list level, chips above), without raising the keyboard', nav === 'list' && hits.query === 'tag:#待整理' && hits.files.slice().sort().join() === '周报提纲,灵感' && hits.focused !== 'INPUT' && hits.scrolls === 'visible' && hits.chips === 4, JSON.stringify({ nav, hits })],
      ['the store still has the three left views (the search one now active); only what the list level draws changed', side.types.length === 3 && side.active === 'amadeus-search', JSON.stringify(side)],
      ['a hit opens its note; back returns to the hits; the heading row returns to the tags', opened === 'detail' && kept === 2 && !back.pane && back.tags >= 3, JSON.stringify({ opened, kept, back })],
      ['system Back with a tag\'s notes open closes them and stays on the list (a sheet above the list takes Back first); only the Back after that leaves the level', held && (under === null || under.pane) && !first.pane && first.tags >= 3 && first.nav === 'list' && first.space === 'amadeus' && !first.holds && (via === 'key' ? second.space === 'home' : second.space === 'amadeus'), JSON.stringify({ via, held, under, first, second })],
    ]
  },
  // Full-text search has its own way in on the phone (the capsule's search finds by name): a row at the foot of the
  // list, and the search command. Both open it in the list with nothing typed and the caret in the field.
  'notes-fulltext': async (page) => {
    if ((await stage.nav(page)) === 'detail') await stage.action(page, 'left')
    await stage.space(page, 'amadeus')
    await chip(page, 'recent')
    const PANE = `${LIST} .t2s-scroll .amx-panel--inlist`
    const look = async () => ({ ...(await page.evaluate((q) => { const pane = document.querySelector(q), input = pane?.querySelector('input'); return { pane: !!pane, query: input ? input.value : null, caret: !!input && document.activeElement === input } }, PANE)), nav: await stage.nav(page) })
    const foot = await texts(page, `${LIST} .t2s-foot .t2s-special-title`)
    await page.locator(`${LIST} .t2s-foot .amx-fulltext-entry`).tap()
    await page.waitForSelector(PANE, { timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(300)
    const opened = await look()
    await page.screenshot({ path: path.join(OUT, `notes-fulltext-open${DARK ? '-dark' : ''}.png`) })
    await page.keyboard.type('书单')
    await page.waitForSelector(`${PANE} .amx-list-item`, { timeout: 6000 }).catch(() => {})
    const found = await texts(page, `${PANE} .amx-list-item`)
    await page.evaluate(() => document.activeElement?.blur())
    const via = await systemBack(page)
    const closed = await look()
    // the search command, from inside a note: back on the list, the search open, nothing typed, the caret in the field
    await page.locator(`${LIST} [data-timeline] .t2s-srow`).first().tap()
    await page.waitForFunction(() => document.querySelector('.mb-shell')?.getAttribute('data-nav') === 'detail', null, { timeout: 6000 }).catch(() => {})
    const inNote = await stage.nav(page)
    await page.evaluate(async (url) => { (await import(/* @vite-ignore */ url)).useCommandStore.getState().run('amadeus-search') }, moduleUrl('../lcl/engine/commandRegistry.ts'))
    await page.waitForSelector(PANE, { timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(500)
    const byCommand = await look()
    // another vault: the search does not come along, and coming back does not bring it up again
    const store = moduleUrl('../desktop/frontend/src/amadeus/store/pageStore.ts')
    const setRoot = async (to) => { const was = await page.evaluate(async ([url, root]) => { const { usePageStore } = await import(/* @vite-ignore */ url); const old = usePageStore.getState().vaultRoot; usePageStore.setState({ vaultRoot: root ?? `${old}-other` }); return old }, [store, to]); await page.waitForTimeout(400); return was }
    const root = await setRoot(null)
    const otherVault = await look()
    await setRoot(root)
    const sameVault = await look()
    await page.evaluate(() => document.activeElement?.blur())
    return [
      ['a "full-text search" row leads the two at the foot of the list; a tap opens the search in the list, nothing typed, the caret in the field', foot[0] === '全文搜索' && foot.length === 3 && opened.pane && opened.query === '' && opened.caret && opened.nav === 'list', JSON.stringify({ foot, opened })],
      ['what is typed there is searched in the notes\' text', found.length === 1 && /读书计划/.test(found[0]), JSON.stringify(found)],
      ['system Back closes the search and stays on the list', !closed.pane && closed.nav === 'list', JSON.stringify({ via, closed })],
      ['the search command inside a note returns to the list with the search open, nothing typed, the caret in the field', inNote === 'detail' && byCommand.nav === 'list' && byCommand.pane && byCommand.query === '' && byCommand.caret, JSON.stringify({ inNote, byCommand })],
      ['another vault opened: the search is not carried over, and is not brought up again on the way back', !otherVault.pane && !sameVault.pane, JSON.stringify({ otherVault, sameVault })],
    ]
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
  // Only a Space that asks for it draws its first left view alone: another Space with a second view on its left side
  // keeps the switcher over its list. (A view is added to Tangu's left side for the look, then closed again.)
  'left-switcher': async (page) => {
    const store = moduleUrl('../lcl/engine/singleColumnStore.ts')
    await stage.space(page, 'tangu')
    const id = await page.evaluate(async (url) => (await import(/* @vite-ignore */ url)).useWorkspace.getState().openView('amadeus-tags', {}, 'left')?.id ?? null, store)
    await page.waitForTimeout(400)
    const options = await page.evaluate((q) => [...document.querySelectorAll(`${q} .mb-drawer-select option`)].length, LIST)
    await page.evaluate(async ([url, leaf]) => { (await import(/* @vite-ignore */ url)).useWorkspace.getState().closeLeaf(leaf, true) }, [store, id])
    await page.waitForTimeout(400)
    const after = { bar: await page.evaluate((q) => !!document.querySelector(`${q} .mb-drawer-bar`), LIST), left: await leftSide(page) }
    return [['Tangu with a second left view: the switcher lists both; closed again, the list is as before', !!id && options === 2 && !after.bar && after.left.types.length === 1, JSON.stringify({ id, options, after })]]
  },
  // The other first-level lists keep their own rows; what they share with the two above is the one main button.
  'agents-list': async (page) => {
    await stage.space(page, 'agents')
    const fab = await rect(page, `${LIST} .pl-fab`)
    // the roster's rows top to bottom: "me" first (the human/ profile, named after the account — 905d5100b), then the agents
    const names = await texts(page, `${LIST} .agents-roster-item strong`)
    const me = await texts(page, `${LIST} [data-roster-me] .agents-roster-item strong`)
    const link = await rect(page, `${LIST} .agents-roster-create`)
    return [['Agents: "me" on top, then the roster, and "create" is the main button (no link at the foot)', (await stage.nav(page)) === 'list' && names.join('|') === 'stage|研究员|编辑' && me.join('|') === 'stage' && !link && !!fab && near(fab.w, 58) && near(SCREEN.width - fab.right, 16) && fab.bottom <= DOCK_TOP - 6, JSON.stringify({ names, me, link, fab })]]
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
  // A cloud vault's row at the end of the notes list opens a small card of the account's vaults (walk 2026-11-19, d:
  // it ran off the right edge — its width was taken from 100vw inside the page's zoom). The card is on the screen,
  // its close button too. (A cloud vault is put on here: the side flag and the collab seam the card reads.)
  'vault-card': async (page) => {
    if ((await stage.nav(page)) === 'detail') await stage.action(page, 'left')
    await stage.space(page, 'amadeus')
    const store = moduleUrl('../desktop/frontend/src/amadeus/store/pageStore.ts')
    const side = await page.evaluate(async (u) => {
      // the list's shared sections ask the same seam (nothing shared here)
      window.amadeusCollab = { listVaults: async () => [{ id: 'v1', name: '我的库' }, { id: 'v2', name: 'A team vault with a rather long English name' }], activeVaultId: async () => 'v1', switchVault: () => {}, sharedWithMe: async () => [], listAllShares: async () => [], publishes: async () => [] }
      const { usePageStore } = await import(/* @vite-ignore */ u)
      const was = usePageStore.getState().vaultSide
      usePageStore.setState({ vaultSide: 'cloud' })
      return was
    }, store)
    await page.waitForTimeout(400)
    await page.locator(`${LIST} .t2s-foot .t2s-special`).last().tap()
    await page.waitForSelector('.amxc-panel .amxc-row', { timeout: 4000 }).catch(() => {})
    await page.waitForTimeout(400)
    const card = await rect(page, '.amxc-panel')
    const close = await rect(page, '.amxc-panel .amxc-x')
    const rows = await texts(page, '.amxc-panel .amxc-row')
    await page.screenshot({ path: path.join(OUT, `vault-card-open${DARK ? "-dark" : ""}.png`) })
    // system Back closes the card and nothing under it: the list stays, in the notes Space. Without the back key (see
    // backPath) the overlays are asked first, the way MobileRoot's planBack does, then the list level.
    if ((await backPath(page)) === 'key') await systemBack(page)
    else {
      const taken = await page.evaluate(() => {
        const taken = !window.dispatchEvent(new CustomEvent('forsion:mobile-back', { cancelable: true, detail: { probe: true } }))
        if (taken) window.dispatchEvent(new Event('forsion:mobile-back', { cancelable: true }))
        return taken
      })
      if (!taken) await systemBack(page)
    }
    await page.waitForTimeout(400)
    const back = await page.evaluate(() => ({ card: !!document.querySelector('.amxc-panel'), space: document.querySelector('.mb-shell')?.dataset.space, nav: document.querySelector('.mb-shell')?.dataset.nav }))
    await page.locator('.amxc-panel .amxc-x').tap({ timeout: 1000 }).catch(() => {})
    await page.evaluate(async ([u, was]) => { delete window.amadeusCollab; (await import(/* @vite-ignore */ u)).usePageStore.setState({ vaultSide: was }) }, [store, side])
    await page.waitForTimeout(300)
    return [
      ['the cloud vault\'s card lists the vaults and stays on the screen, with a margin; its close button is on it too', rows.length === 2 && !!card && card.x >= 8 && card.right <= SCREEN.width - 8 && card.bottom <= SCREEN.height && !!close && close.x >= 0 && close.right <= SCREEN.width, JSON.stringify({ rows, card, close })],
      ['system Back closes the card and only the card: the notes list stays', !back.card && back.space === 'amadeus' && back.nav === 'list', JSON.stringify(back)],
    ]
  },
  // The editor's floating capsule, "⋯" while typing (walk 2026-11-19, e): the sheet came up with the keyboard still up,
  // squeezed into what was left above it (7 of 13 rows, the capsule over the rest). "⋯" sends the keyboard away first,
  // as "+" does. The keyboard here: the page made shorter by its height at the same width — what the app's WebView does.
  'note-more-keyboard': async (page) => {
    if ((await stage.nav(page)) === 'detail') await stage.action(page, 'left')
    await stage.space(page, 'amadeus')
    const fixtureTitle = '键盘菜单台架'
    const fixturePath = `${fixtureTitle}.md`
    const pages = await newNote(page, fixtureTitle)
    const inBody = () => page.evaluate(() => !!document.activeElement?.closest?.('.ProseMirror'))
    const typing = await inBody()
    await page.setViewportSize({ width: SCREEN.width, height: SCREEN.height - 300 })
    await page.waitForTimeout(500)
    const more = page.locator('.amx-mbar button[title="更多操作"]')
    const found = await more.count()
    if (found) await more.tap()
    await page.waitForTimeout(500)
    const caret = await inBody()
    const open = await page.evaluate(() => !!document.querySelector('.mb-sheet'))
    await page.setViewportSize(SCREEN) // the keyboard gone
    await page.waitForTimeout(500)
    // rows wholly in sight (the sheet has a height cap and scrolls past it: that is how it is without a keyboard too)
    const sheet = await page.evaluate(() => { const s = document.querySelector('.mb-sheet'); if (!s) return null; const r = s.getBoundingClientRect(); const rows = [...s.querySelectorAll('.mb-sheet-row')]; return { top: Math.round(r.top), bottom: Math.round(r.bottom), rows: rows.length, seen: rows.filter((x) => { const q = x.getBoundingClientRect(); return q.top >= r.top - 1 && q.bottom <= Math.min(r.bottom, innerHeight) + 1 }).length } })
    await page.screenshot({ path: path.join(OUT, `note-more-keyboard-open${DARK ? '-dark' : ''}.png`) })
    await page.locator('.mb-sheet-scrim').tap({ position: { x: 200, y: 40 } }).catch(() => {})
    await page.waitForTimeout(300)
    await stage.action(page, 'left')
    // Leave the next note scene a fresh draft to create and rename.
    if (pages.includes(fixturePath)) await page.evaluate(async ([url, notePath]) => {
      await (await import(/* @vite-ignore */ url)).usePageStore.getState().deletePage(notePath)
    }, [moduleUrl('../desktop/frontend/src/amadeus/store/pageStore.ts'), fixturePath])
    return [
      ['typing in a new note, the floating capsule has its "⋯"', typing && found === 1, JSON.stringify({ typing, found })],
      ['"⋯" with the keyboard up takes the caret out of the note (the keyboard goes) and opens the sheet', open && !caret, JSON.stringify({ open, caret })],
      ['with the keyboard gone the sheet has the screen\'s height to show its rows in (the device showed 7 with the keyboard left up)', !!sheet && sheet.top >= 0 && sheet.bottom <= SCREEN.height + 1 && sheet.seen >= 10, JSON.stringify(sheet)],
    ]
  },
  // The command panel on a phone (walk 2026-11-19, f): no keyboard to press, so no shortcut chips on the rows and no
  // key legend in the foot (the count of commands stays). On a desktop both stay — not looked at here.
  'palette-touch': async (page) => {
    if ((await stage.nav(page)) === 'detail') await stage.action(page, 'left')
    await stage.space(page, 'home')
    await page.evaluate(async (u) => (await import(/* @vite-ignore */ u)).openCommandPalette(), moduleUrl('../lcl/engine/commandRegistry.ts'))
    await page.waitForSelector('.cmd-panel', { timeout: 4000 }).catch(() => {})
    await page.waitForTimeout(300)
    const look = await page.evaluate(() => ({ open: !!document.querySelector('.cmd-panel'), rows: document.querySelectorAll('.cmd-panel .cmd-item').length, chips: document.querySelectorAll('.cmd-panel .cmd-hotkey').length, keys: document.querySelectorAll('.cmd-panel .cmd-foot kbd').length, count: document.querySelector('.cmd-panel .cmd-foot-count')?.textContent || '' }))
    await page.screenshot({ path: path.join(OUT, `palette-touch-open${DARK ? '-dark' : ''}.png`) })
    await page.evaluate(async (u) => (await import(/* @vite-ignore */ u)).useCommandStore.getState().setPaletteOpen(false), moduleUrl('../lcl/engine/commandRegistry.ts'))
    await page.waitForTimeout(300)
    return [['the command panel on a phone: rows without shortcut chips, no key legend in the foot, the count stays', look.open && look.rows > 5 && look.chips === 0 && look.keys === 0 && /\d/.test(look.count), JSON.stringify(look)]]
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
      ['an empty inbox says what lands here, with the shared empty state in the list', words[0] === '收件箱是空的' && words[1] === 'Agent 的汇报和等你批准的请求会送到这里。' && !bare.length, JSON.stringify({ words, bare })],
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
    // the sender's group folds on a tap and opens again on the next (the scenes after this one start from it open)
    await page.locator(HEAD, { hasText: 'Forsion' }).tap(); await page.waitForTimeout(250)
    const folded = `${await heads()} rows=${(await texts(page, `${ROW} .t2s-srow-title`)).length}`
    await page.locator(HEAD, { hasText: 'Forsion' }).tap(); await page.waitForTimeout(250)
    const opened = `${await heads()} rows=${(await texts(page, `${ROW} .t2s-srow-title`)).length}`
    await page.screenshot({ path: path.join(OUT, `inbox-groups${DARK ? '-dark' : ''}.png`) })
    return [
      ['the inbox opens on a phone list: no toolbar, no filter menu, no row buttons; search is on the capsule', (await stage.nav(page)) === 'list' && !desk.length && !!st.search, `nav=${await stage.nav(page)} desktop parts=${desk.join(',') || 'none'} search=${st.search}`],
      ['its categories are chips: senders are groups now, not filters', chips.join('|') === '全部|未读|已归档', chips.join('|')],
      ['mail is grouped by sender (on a phone all of it is Forsion\'s); a group with unread mail is open and says how many', headsAtFirst === 'Forsion:true:2', headsAtFirst],
      ['a group head is the workspace\'s first-level row at touch size: 52 dp on a 40 dp lead, 16 from the edge', !!head && near(head.h, 52) && !!headLead && near(headLead.w, 40) && near(headLead.h, 40) && near(headLead.x, 16), JSON.stringify({ head: head?.h, lead: headLead })],
      ['rows inside a group carry no icon block: the unread dot only, the title under the sender\'s name', subs.length === 5 && dots === 'dot,dot,empty,empty,empty' && !!title && !!headName && near(title.x, headName.x) && !!row && row.h >= 59 && row.h <= 68, JSON.stringify({ rows: subs.length, dots, title: title?.x, name: headName?.x, row: row?.h, lead: lead && [lead.w, lead.h] })],
      ['second line: the first sentence, on one line (the sender is on the head)', subs[0] === '这一版把收件箱翻新了一遍，列表里能直接看到正文的第一句。' && !!sub && sub.h < 24, `«${subs[0]}» ${JSON.stringify(sub)}`],
      ['a tap on a group\'s head folds it, the next tap opens it again', folded === 'Forsion:false:2 rows=0' && opened === 'Forsion:true:2 rows=5', `${folded} → ${opened}`],
      ['the time sits on the title\'s line; the second line runs the full width under it', !!sub && !!time && !!title && time.y < sub.y && near(sub.right, time.right) && sub.w > title.w + 40, JSON.stringify({ sub, time, title })],
      ['a title too long for the line is cut before the time', !!long && !!longTime && long.right <= longTime.x, JSON.stringify({ long, longTime })],
      ['unread rows carry a heavier title, read ones do not', unread.join() === 'true:650,true:650,false:500,false:500,false:500', unread.join()],
      ['the source\'s usual action is the main button: 58 dp, right 16, clear of the dock', !!fab && fabName === '拉取新消息' && near(fab.w, 58) && near(fab.h, 58) && near(SCREEN.width - fab.right, 16) && fab.bottom <= DOCK_TOP - 6, `${fabName} ${JSON.stringify(fab)}`],
    ]
  },
  'inbox-swipe': async (page) => {
    // the gesture itself (a pointer drag on the row's track, since 10-14 — dca6414cb) is pushed in as pointer events, as
    // in tangu-swipe; then the buttons are used
    const ROW = `${LIST} .t2sw-plug-item .t2s-srow`
    const sw = `${LIST} .t2sw-plug-item .pl-swipe`
    const rested = (q) => page.evaluate((s) => [...document.querySelectorAll(s)].every((el) => !el.hasAttribute('data-open') && ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(el.firstElementChild).transform)), q)
    await page.evaluate(([q, i]) => window.__swipeOpen(document.querySelectorAll(q)[i]), [sw, 1])
    await page.waitForTimeout(700)
    const acts = await page.evaluate((q) => [...document.querySelectorAll(q)[1].querySelectorAll('.pl-swipe-act')].map((b) => { const r = b.getBoundingClientRect(); return { id: b.dataset.act, name: b.getAttribute('aria-label'), x: r.left, right: r.right, w: r.width, h: r.height, text: b.textContent.trim(), svg: !!b.querySelector('svg'), danger: b.classList.contains('danger') } }), sw)
    await page.screenshot({ path: path.join(OUT, `inbox-swipe-open${DARK ? '-dark' : ''}.png`) })
    await page.locator(`${sw} >> nth=1`).locator('[data-act="read"]').tap()
    await page.waitForTimeout(500)
    const unread = await page.evaluate((q) => [...document.querySelectorAll(q)].map((el) => el.classList.contains('is-unread')), ROW)
    const closed = await rested(sw)
    await chip(page, 'g:unread')
    const onlyUnread = await texts(page, `${ROW} .t2s-srow-title`)
    await chip(page, '__all')
    // archive the last one: it leaves the list and turns up under its own chip
    await page.evaluate(([q, i]) => window.__swipeOpen(document.querySelectorAll(q)[i]), [sw, 4])
    await page.waitForTimeout(700)
    await page.locator(`${sw} >> nth=4`).locator('[data-act="archive"]').tap()
    await page.waitForTimeout(600)
    const left = (await texts(page, `${ROW} .t2s-srow-title`)).length
    await chip(page, 'g:archived')
    const archived = await texts(page, `${ROW} .t2s-srow-title`)
    await chip(page, '__all')
    // both taps reached the account's inbox (the server's copy), not only the list on screen
    const stored = cloudInbox.rows.map((m) => `${m.id.slice(6)}:${m.read_at ? 'read' : 'unread'}${m.archived_at ? ':archived' : ''}`).join()
    return [
      ['a row slides left onto mark read / archive / delete, all on screen', acts.map((a) => a.id).join(',') === 'read,archive,delete' && acts.every((a) => a.x >= 0 && a.right <= SCREEN.width), JSON.stringify(acts)],
      ['the actions are round 44 dp buttons with an icon only, each named for a screen reader; delete is the warning one', acts.every((a) => near(a.w, 44) && near(a.h, 44) && a.svg && !a.text && !!a.name) && acts.map((a) => a.name).join('|') === '标为已读|归档|删除' && acts[2]?.danger && !acts[0]?.danger, JSON.stringify(acts.map((a) => [a.name, a.w, a.danger]))],
      ['mark read: the row loses its unread mark, the tray closes, the unread chip lists one less', unread.join() === 'true,false,false,false,false' && closed && onlyUnread.join('|') === '2.13 更新了什么', `${unread.join()} closed=${closed} unread chip: ${onlyUnread.join('|')}`],
      ['archive: the row leaves the list and is found under the archived chip', left === 4 && archived.length === 1 && archived[0].startsWith('A long English'), `left=${left} archived=${archived.join('|')}`],
      ['both changes are written to the account\'s cloud inbox', stored === 'ib-1:unread,ib-2:read,ib-3:read,ib-4:read,ib-5:read:archived', stored],
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
    await stage.space(page, 'tangu')
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
  // Notifications on a phone (2026-11-15): one banner at a time. In the app the native layer draws it over the capsule
  // row; this stage has the native chrome's stand-in but no native banner, which is the page's fallback (a broken bridge):
  // the page draws the same banner right below the capsules — it cannot cover them — and below the call bar during a call.
  // The calendar used to keep its cards at the bottom (the dock on a phone): the banner is at the top there too.
  'notify-card': async (page) => {
    if ((await stage.nav(page)) === 'detail') await stage.action(page, 'left')
    // first: the fallback banner sits on the page's first row (here the list's chips) while it is up
    await stage.space(page, 'tangu'); await chip(page, 'all')
    await page.evaluate(async (url) => {
      const { useNotifications } = await import(/* @vite-ignore */ url)
      useNotifications.getState().dismissAll()
      useNotifications.getState().notify({ force: true, sticky: true, title: 'Forsion', text: '2.13.3 已经可以更新了', action: { label: '查看', run() {} } })
      useNotifications.getState().notify({ force: true, sticky: true, text: 'a newer sticky one' }) // a sticky card makes way for the next one
    }, moduleUrl('../desktop/frontend/src/stores/notificationStore.ts'))
    const plates = LAYOUT.plates.map((p) => ({ ...p, right: p.x + p.w, bottom: p.y + p.h }))
    const clear = (c) => !!c && c.x >= 0 && c.right <= SCREEN.width && plates.every((p) => c.bottom <= p.y || c.y >= p.bottom || c.right <= p.x || c.x >= p.right)
    const card = async () => { await page.waitForTimeout(700); const c = await rect(page, '.ntf-banner-wrap .ntf-banner'); return c && Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * 10) / 10])) }
    const zoom = await page.evaluate(() => Number(getComputedStyle(document.body).zoom) || 1)
    const rows = []
    await stage.space(page, 'calendar')
    const cal = await card()
    rows.push(['the calendar: the banner is at the top here too, clear of the capsules and of the dock', clear(cal) && cal.bottom < SCREEN.height / 2, JSON.stringify(cal)])
    await page.screenshot({ path: path.join(OUT, `notify-calendar${DARK ? '-dark' : ''}.png`) })
    await stage.space(page, 'tangu')
    await callBar(page, true)
    const bar = await rect(page, '.vc-bar')
    const during = await card()
    rows.push(['during a call: the banner is below the call bar (its hang-up key stays in reach)', !!bar && !!during && during.y >= bar.bottom, JSON.stringify({ card: during, barBottom: bar && Math.round(bar.bottom) })])
    await callBar(page, false)
    const c = await card()
    rows.push(['the banner: right below the capsule row, 10 from each side, 54 high (zoomed with the page)',
      clear(c) && near(c.y, LAYOUT.top + 4 * zoom, 2) && near(c.x, 10 * zoom, 1.5) && near(SCREEN.width - c.right, 10 * zoom, 1.5) && near(c.h, 54 * zoom, 1.5), JSON.stringify({ card: c, capsulesEnd: LAYOUT.top, zoom })])
    const shown = await page.evaluate(() => ({ cards: document.querySelectorAll('.ntf-banner').length, more: !!document.querySelector('.ntf-more'), stack: !!document.querySelector('.ntf-wrap') }))
    rows.push(['one at a time: the second waits, no "+N", no desktop stack', shown.cards === 1 && !shown.more && !shown.stack, JSON.stringify(shown)])
    await page.screenshot({ path: path.join(OUT, `notify-banner${DARK ? '-dark' : ''}.png`) })
    return rows
  },
  // A card with a button raised inside the user's own tap — an older plugin's "Undo" without `undo: true` (the bundled
  // calendar's to-do completion) — is not throttled on a phone; the same card raised from a timer after the tap is
  // (2026-11-15). Judged on real touches here: only a browser makes trusted events, a unit test cannot.
  'notify-gesture': async (page) => {
    const url = moduleUrl('../desktop/frontend/src/stores/notificationStore.ts')
    await page.evaluate(async (url) => {
      const m = await import(/* @vite-ignore */ url)
      m.useNotifications.getState().dismissAll(); m.resetNotificationThrottle()
      // what pluginStore turns an old plugin's ctx.notify(text, { key, action }) into
      const card = (text) => m.notifyApp({ text, event: 'plugin:probe', sourceLabel: 'Probe', dedupeKey: 'plugin:probe:undo', replace: true, durationMs: 8000, action: { label: '撤销', run() {} } })
      const first = card('timed out'); m.useNotifications.getState().dismiss(first, 'timeout') // the source now cools down
      const mk = (id, top, fn) => { const b = document.createElement('button'); b.id = id; b.textContent = id; b.style.cssText = `position:fixed;left:20px;top:${top}px;width:200px;height:56px;z-index:99999`; b.onclick = fn; document.body.append(b) }
      window.__ng = []
      mk('ng-later', 480, () => { setTimeout(() => window.__ng.push(['later', card('from a timer')]), 30) })
      mk('ng-sync', 560, () => { window.__ng.push(['sync', card('deleted A')]) })
    }, url)
    await page.locator('#ng-later').tap()
    await page.waitForTimeout(300)
    await page.locator('#ng-sync').tap()
    await page.waitForTimeout(600)
    const r = await page.evaluate(() => ({ calls: window.__ng, banner: document.querySelector('.ntf-banner-wrap .ntf-banner-text')?.textContent ?? null }))
    await page.screenshot({ path: path.join(OUT, `notify-gesture${DARK ? '-dark' : ''}.png`) })
    await page.evaluate(async (url) => {
      for (const id of ['ng-later', 'ng-sync']) document.getElementById(id)?.remove()
      const m = await import(/* @vite-ignore */ url)
      m.useNotifications.getState().dismissAll(); m.resetNotificationThrottle()
    }, url)
    const got = (k) => r.calls.find((c) => c[0] === k)
    return [
      ['a card with a button raised in a real tap is not throttled (an older plugin\'s Undo)', !!got('sync') && got('sync')[1] !== null && r.banner === 'deleted A', JSON.stringify(r)],
      ['the same card raised from a timer after the tap is throttled', !!got('later') && got('later')[1] === null, JSON.stringify(r)],
    ]
  },
  // The agent picker of a new chat: the recipient chip in the composer's toolbar (same chip as the desktop, 11-02 plan A).
  // Without a native host the chip opens a web bottom sheet (names only, ticks, team order); with one, the Android
  // checklist — ticked in order, applied when it closes (docs/ToBeImproved/窄栏Agent选择器方案_2026-10-23, chosen 10-24).
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
      ['web sheet: tapping the scrim closes it, the chip reads "first 等 N 位"', sheetGone && sheetTeam === '编辑 等 2 位', sheetTeam],
      ['native host: a checklist of names, no web sheet', sent?.kind === 'checklist' && items.map((i) => i.label).join('、') === '研究员、编辑' && items.every((i) => !i.detail) && noWebSheet, JSON.stringify(sent && { kind: sent.kind, items: items.map((i) => [i.label, i.detail]) })],
      ['native host: the ticks come back in tick order', nativeTeam === '研究员 等 2 位', nativeTeam],
    ]
  },
  // Home again, with something going on in each of what the four cards used to show: a session, a note opened last, an
  // agent's appointment tomorrow, unread mail. The stores are filled directly — the stage answers neither the schedule nor
  // the unread count — so this looks at where each shows now, not at how those stores get their data.
  'home-status': async (page) => {
    if ((await stage.nav(page)) === 'detail') await stage.action(page, 'left')
    await stage.space(page, 'home')
    await seedNotes(page) // the note opened last (recent views carry its time); on its own this scene has no vault yet
    const day = new Date(T0 + DAY)
    const at = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}T14:00`
    await page.evaluate(async ([prefs, schedule, when]) => {
      ;(await import(/* @vite-ignore */ prefs)).useAmadeusPrefs.setState({ recents: ['项目/发版清单 2.13.md'] })
      ;(await import(/* @vite-ignore */ schedule)).useAgentSchedules.setState({ loaded: true, ok: true, schedules: [{ slug: 'researcher', name: '研究员', db: { columns: [{ id: 'name', name: '名称', type: 'text' }, { id: 'when', name: '时间', type: 'calendarDate' }], rows: [{ id: 'r1', cells: { name: '周会', when } }] } }] })
    }, [moduleUrl('../desktop/frontend/src/amadeusPrefs.ts'), moduleUrl('../desktop/frontend/src/stores/agentScheduleStore.ts'), at])
    // two unread letters in the account's inbox (the fixture as first seeded), read back the way the app reads them: a
    // count set straight into the store would be overwritten by the next poll, which gets real answers from the stub
    await seedInbox(page)
    await page.waitForTimeout(600)
    // Since 2026-11-19 a phone Home has no Space cards: what their status lines said lives elsewhere. The last session and
    // the last note are Continue rows; unread mail is the unread dot on the Apps cell (the inbox is reached through Apps);
    // the next appointment is not on Home any more (it is in Calendar).
    const HOME = '.mb-view[data-view="homepage"]'
    const cards = await page.evaluate((q) => document.querySelectorAll(q).length, `${HOME} .hp-card`)
    const rows = await page.evaluate((q) => [...document.querySelectorAll(q)].map((el) => el.getAttribute('data-continue')), `${HOME} .hp-continue-row`)
    // the dots are added by the host on their way to the native bar (the stage records the engine's state, before that):
    // ask the host's own rule, with the cells the engine sent
    const apps = await page.evaluate(async ({ hostUrl, spacesUrl }) => {
      const host = await import(/* @vite-ignore */ hostUrl)
      const { useSpaceStore } = await import(/* @vite-ignore */ spacesUrl)
      const dots = host.dockBadges(window.__stage.state.spaces || [], host.spaceBadges(), useSpaceStore.getState().spaces.map((x) => x.id))
      return { id: '@apps', badge: dots['@apps'] ?? null }
    }, { hostUrl: moduleUrl('src/nativeChrome.ts'), spacesUrl: moduleUrl('../lcl/engine/spaceRegistry.ts') })
    return [
      ['no Space cards (and no card status lines) on a phone Home', cards === 0, String(cards)],
      ['the last session and the last note are Continue rows', rows.some((k) => /^chat:/.test(k)) && rows.includes('note:项目/发版清单 2.13.md'), JSON.stringify(rows)],
      ['unread mail is the unread dot on the Apps cell (the inbox is not in the dock)', apps?.badge?.kind === 'unread', JSON.stringify(apps)],
    ]
  },
  // A new note named from its title, then system Back (walk 2026-11-19, b): Back goes to the list — never to the note
  // under the name it was born with («当前库里没有这篇笔记「untitled.md」»). The history keeps the note under its new path.
  // Home's note card names it, and stops naming it once it is deleted (h: the card read the first "recent" path as is —
  // the dead `untitled.md` that the wrong Back had opened, or a deleted note).
  'notes-rename-back': async (page) => {
    if ((await stage.nav(page)) === 'detail') await stage.action(page, 'left')
    await stage.space(page, 'amadeus')
    const notes = await newNote(page, '购物清单')
    const before = await noteHistory(page)
    const via = await detailBack(page)
    const after = { nav: await stage.nav(page), missing: await page.evaluate(() => /当前库里没有这篇笔记/.test(document.querySelector('.mb-shell')?.innerText || '')), history: await noteHistory(page) }
    await stage.space(page, 'home')
    const card = () => page.evaluate(() => [...document.querySelectorAll('.mb-view[data-view="homepage"] .hp-card')].find((el) => el.dataset.spaceId === 'amadeus')?.querySelector('.hp-card-status')?.textContent ?? null)
    const named = await card()
    await page.evaluate(async (u) => { await (await import(/* @vite-ignore */ u)).usePageStore.getState().deletePage('购物清单.md') }, moduleUrl('../desktop/frontend/src/amadeus/store/pageStore.ts'))
    await page.waitForTimeout(600)
    const deleted = await card()
    await stage.space(page, 'amadeus')
    return [
      ['the title renames the new note (the file follows it)', notes.includes('购物清单.md') && !notes.some((p) => /^untitled/.test(p)), JSON.stringify(notes)],
      ['the history holds the note once, under its new path — not under the name it was born with', before.includes('amadeus:购物清单.md') && !before.some((k) => k.includes('untitled')), JSON.stringify(before)],
      ['system Back from the renamed note goes to the list, not to a note that is not there', after.nav === 'list' && !after.missing && !after.history.some((k) => k.includes('untitled')), JSON.stringify({ via, ...after })],
      ['Home\'s note card names the renamed note, and no longer names it once it is deleted', named === '购物清单' && deleted !== '购物清单', JSON.stringify({ named, deleted })],
    ]
  },
  // What is written in a note reaches the tag list and the full-text search without reopening the vault (walk
  // 2026-11-19, c: the local vault's index skipped the editor's own saves — only the title matched). No reindex, no
  // version bump by hand here: the app's own save has to do it.
  'notes-edit-index': async (page) => {
    if ((await stage.nav(page)) === 'detail') await stage.action(page, 'left')
    await stage.space(page, 'amadeus')
    await newNote(page, '采购单')
    await page.keyboard.press('Enter') // title → body
    await page.waitForTimeout(500)
    await page.keyboard.type('牛奶 #待买 全文探针词')
    await page.waitForTimeout(2500) // the editor's save is debounced
    const disk = await page.evaluate(async () => window.amadeus.readTextFile('采购单.md'))
    await page.evaluate(() => document.activeElement?.blur())
    await stage.action(page, 'left')
    await chip(page, 'tags')
    await page.waitForSelector(`${LIST} .amx-tags-inlist .amx-tagtree-row`, { timeout: 4000 }).catch(() => {})
    const tags = await texts(page, `${LIST} .amx-tags-inlist .amx-tag-name`)
    await chip(page, 'recent')
    await page.locator(`${LIST} .t2s-foot .amx-fulltext-entry`).tap()
    const PANE = `${LIST} .t2s-scroll .amx-panel--inlist`
    await page.waitForSelector(`${PANE} input`, { timeout: 5000 }).catch(() => {})
    await page.keyboard.type('全文探针词')
    await page.waitForSelector(`${PANE} .amx-list-item`, { timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(400)
    const found = await texts(page, `${PANE} .amx-list-item`)
    await page.evaluate(() => document.activeElement?.blur())
    await page.locator(`${PANE} .amx-panel-back`).tap().catch(() => {})
    await chip(page, 'recent')
    return [
      ['the body was saved', /全文探针词/.test(disk || ''), JSON.stringify(disk)],
      ['its tag is in the tag list right away', tags.includes('待买'), tags.join('、')],
      ['the full-text search finds it by a word of its body', found.some((t) => /采购单/.test(t)), JSON.stringify(found)],
    ]
  },
}

/** The list's main button, then a title typed into the new note (Enter commits it = the file is renamed). Returns the
 *  vault's pages afterwards. Leaves the caret in the note. */
async function newNote(page, title) {
  await page.locator(`${LIST} .pl-fab`).tap()
  await page.waitForFunction(() => document.querySelector('.mb-shell')?.getAttribute('data-nav') === 'detail', null, { timeout: 6000 }).catch(() => {})
  await page.waitForTimeout(800)
  await page.keyboard.type(title)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
  return page.evaluate(async (u) => (await import(/* @vite-ignore */ u)).usePageStore.getState().pages, moduleUrl('../desktop/frontend/src/amadeus/store/pageStore.ts'))
}
/** The note entries of every View's history (`amadeus:<path>`). */
const noteHistory = (page) => page.evaluate(async (u) => Object.values((await import(/* @vite-ignore */ u)).useNav.getState().stacks).flatMap((s) => s.entries.map((e) => e.key)).filter((k) => k.startsWith('amadeus:')), moduleUrl('../lcl/engine/navStore.ts'))
/** One system Back in the main area (see backPath). Where the key does not arrive, what MobileRoot's planBack does there
 *  once nothing above the page takes Back: back through this trip's pages, else to the list. Returns the way it went. */
async function detailBack(page) {
  const via = await backPath(page)
  await page.evaluate(async ([key, navUrl, wsUrl]) => {
    document.activeElement?.blur?.()
    if (key) return void window.Capacitor.Plugins.App.notifyListeners('backButton', { canGoBack: false })
    const { useNav } = await import(/* @vite-ignore */ navUrl)
    const ws = (await import(/* @vite-ignore */ wsUrl)).useWorkspace.getState()
    const tab = ws.mainTabs.find((t) => t.active)
    const st = tab && useNav.getState().stacks[tab.id]
    if (st && st.idx > 0) useNav.getState().back(tab.id)
    else ws.toggleSidebar('left')
  }, [via === 'key', moduleUrl('../lcl/engine/navStore.ts'), moduleUrl('../lcl/engine/singleColumnStore.ts')])
  await page.waitForTimeout(1200)
  return via
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
  const unknown = new Set()
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
      // a scene that throws is one red row, not the end of the run: the scenes after it still report (they start from
      // wherever it left the page, so read the first red first). Until 11-19 a throw here hid every later scene.
      let rows
      try { rows = await go(page) } catch (e) { rows = [['the scene ran to its end', false, String(e && e.message || e).split('\n').slice(0, 3).join(' ')]] }
      await page.waitForTimeout(600)
      const file = path.join(OUT, `${name}${DARK ? '-dark' : ''}.png`)
      await page.screenshot({ path: file }).catch((e) => rows.push(['its screenshot was taken', false, String(e && e.message || e).split('\n')[0]]))
      console.log(`── ${name} → ${path.relative(ROOT, file)}`)
      for (const [what, ok, detail] of rows) {
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  | ' + detail : ''}`)
        if (!ok) fails.push(`${name}: ${what} | ${detail}`)
      }
    }
  } catch (e) {
    fails.push(String(e && e.stack || e))
  } finally {
    // printed on an aborted run too: an API the stub does not answer is often why a scene is red
    if (unknown.size) console.log(`unanswered API calls (refused):\n  ${[...unknown].sort().join('\n  ')}`)
    await browser?.close().catch(() => {})
    stop()
  }
  if (process.env.KEEP && !fails.length) console.log(`dev server left up at ${URL_}`)
  if (fails.length) console.error(`FAIL\n${fails.join('\n')}`); else console.log('ok')
  process.exit(fails.length ? 1 : 0) // a dev server left up (KEEP) would otherwise hold the process open
}
module.exports = { stubApi, installChrome, stage, moduleUrl, loaded, SCREEN, LAYOUT }
if (require.main === module) main()
