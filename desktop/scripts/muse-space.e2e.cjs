/**
 * 任务卡(```forsion-task)× Muse Space —— 真 Electron × 真组件/store × 可编剧假引擎。
 *
 * 钉住:
 *  ① 助手消息里的 forsion-task 围栏渲染成卡片(标题/摘要/四个落点),围栏原文不进正文;track:true 的卡主按钮是「交给 Muse 追踪」;
 *  ② 「新会话执行」把任务书原样当首条消息发出(POST /agent/runs.message === prompt);
 *  ③ 「交给 Muse 追踪」写一条 muse 日程(repeat 1d / auto / name=标题)+ 一条 [feedback] 行;
 *  ④ Muse Space 可进:主视图列出 Library/Journal 文件并渲染内容,右栏待批清单能「批准并执行」(POST …/approve)。
 * 截图:/tmp/forsion-muse-taskcard.png(聊天)/ /tmp/forsion-muse-space.png(Space)。
 *
 * 需先 npm run build。用法:npm run e2e:musespace
 * 负对照:node scripts/muse-space.e2e.cjs --nc(围栏名改成普通代码块 → ① 必须转红)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const NEGATIVE_CONTROL = process.argv.includes('--nc')
const SHOT_CHAT = path.join(os.tmpdir(), 'forsion-muse-taskcard.png')
const SHOT_SPACE = path.join(os.tmpdir(), 'forsion-muse-space.png')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const SESSION = {
  id: 'muse-s1', title: 'Muse 验收', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/muse-demo', project_name: 'muse-demo',
  created_at: '2026-09-10 09:00:00', updated_at: '2026-09-10 09:00:00',
}
const FENCE = NEGATIVE_CONTROL ? 'text' : 'forsion-task'
const PROMPT_A = '在 desktop/frontend/src/… 里,direct provider 把 image 类 slug 也当聊天模型渲染进选择器。\n复现:设置 → 模型 → xAI。'
const PROMPT_B = '每天看一眼 build-desktop 工作流最近 5 次的结果,失败率上升就告诉我。'
const TRACK_PREFIX = 'Track this task; report to the user only when something changed, and remove this entry when it is done. '
const ASSISTANT = [
  '顺手发现两件事,不该塞进这轮:',
  '',
  '```' + FENCE,
  'title: 修生图 slug 被当聊天模型',
  'tldr: grok-imagine 混进了聊天模型选择器',
  '---',
  PROMPT_A,
  '```',
  '',
  '```' + FENCE,
  'title: 盯着 build-desktop 的失败率',
  'track: true',
  '---',
  PROMPT_B,
  '```',
  '',
  '```forsion-suggest',
  '提醒我 9月11日 10:00 复查这两件事',
  '```',
].join('\n')

async function openChatSession(win) {
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await win.waitForTimeout(1000)
  await win.evaluate((names) => {
    const button = [...document.querySelectorAll('button.rb-space')]
      .find((item) => names.some((name) => (item.getAttribute('title') || item.textContent || '').includes(name)))
    if (button) button.click()
  }, ['Agent', 'Tangu'])
  await win.waitForTimeout(1500)
  if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) {
    await win.click('.dv-edge-left').catch(() => {})
    await win.waitForTimeout(700)
  }
  const picker = win.locator('.t2sw-mode-picker').first()
  if (await picker.count().catch(() => 0)) {
    await picker.locator('.t2sw-mode-trigger').click().catch(() => {})
    await picker.locator('[data-workspace-mode="sessions"]').click().catch(() => {})
    await win.waitForTimeout(1000)
  }
  const row = win.locator('.t2s-srow', { hasText: 'Muse 验收' }).first()
  if (!(await row.count().catch(() => 0))) throw new Error('没找到会话行')
  await row.click()
  await win.waitForTimeout(900)
}

async function dismissNotifications(win) {
  const close = win.locator('.ntf-close')
  await close.evaluateAll((buttons) => buttons.forEach((button) => button.click())).catch(() => {})
  await win.waitForTimeout(250)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-muse-space-'))
  const lib = path.join(home, 'agents', 'muse', 'Library')
  fs.mkdirSync(path.join(lib, 'Journal'), { recursive: true })
  fs.writeFileSync(path.join(lib, 'Journal', '2026-09-10.md'), '# 2026-09-10\n\n- 09:15 · ask · heartbeat · tokens 1234 · files 1 · done · 整理了下载文件夹的草稿\n', 'utf8')
  fs.writeFileSync(path.join(lib, 'Home.md'), '# Muse\n\n这里是 Muse 的工作区。\n', 'utf8')

  const seen = { schedule: [], feedback: [], approve: [] }
  const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) return [{ path: r, size: 0, mtime: 0, dir: true }, ...walk(path.join(dir, e.name), r)]
    const st = fs.statSync(path.join(dir, e.name))
    return [{ path: r, size: st.size, mtime: st.mtimeMs, dir: false }]
  })
  const stub = await startStubEngine({
    sessions: [SESSION],
    messages: [
      { id: 'm-u1', role: 'user', content: '帮我看看模型选择器', timestamp: 1000 },
      { id: 'm-a1', role: 'assistant', content: ASSISTANT, timestamp: 2000 },
    ],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000, thinkingLevels: ['off', 'low'] }],
    handle: async ({ path: p, method, body }) => {
      if (p === '/agent/special/muse/status') return { status: { enabled: true, hasModel: true, running: false, restartsThisWindow: 0, maxRestartsPerWindow: 3, lastCycleAt: null, lastError: null, sessionId: null, mode: 'ask', heartbeatMinutes: 120, pendingApprovals: 1, libraryDir: lib } }
      if (p === '/agent/special/muse/library') return { root: lib, files: walk(lib) }
      if (p === '/agent/special/approvals') return { approvals: [{ id: 'apv-1', session_id: 'S', run_id: 'R', agent_slug: 'muse', tool: 'write_file', args: '{}', preview: 'write ~/Documents/notes/todo.md (120 chars)', reason: '{"kind":"escalate","mode":"auto-edit"}', cwd: lib, status: 'pending', decided_by: null, note: null, result: null, created_at: '2026-09-10 09:20:00', decided_at: null }] }
      if (/^\/agent\/special\/approvals\/[^/]+\/(approve|reject)$/.test(p)) { seen.approve.push({ id: p.split('/')[4], decision: p.split('/')[5], method }); return { ok: true, status: 'approved', result: 'wrote todo.md (120 chars)' } }
      if (p === '/agent/special/muse/todos') return { todos: [{ id: 't1', title: '把 README 的安装章节补上 Windows 步骤', detail: '现在只有 mac/linux', status: 'pending', source_session_id: null, created_at: '2026-09-10 09:00:00' }] }
      if (p === '/agent/special/muse/triggers') return { triggers: [] }
      if (p === '/agent/special/schedule' && method === 'GET') return { schedules: [{ slug: 'muse', name: 'Muse', db: { version: 1, name: 'SCHEDULE', columns: [], rows: [] }, entries: [{ id: 's-1', name: '盯着 CI 失败率', date: '2026-09-11T10:00', repeat: '1d', auto: true, prompt: 'p', description: 'd', todo: true, lastRun: '' }] }] }
      if (p === '/agent/special/schedule/muse/entries' && method === 'POST') { const b = await body(); seen.schedule.push(b); return { entry: { id: 's-2', ...b, lastRun: '' }, created: true } }
      if (p === '/agent/special/muse/feedback' && method === 'POST') { seen.feedback.push((await body()).text); return { ok: true } }
      return undefined
    },
  })
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
  })

  try {
    const win = await app.firstWindow()
    await win.setViewportSize({ width: 1600, height: 900 })
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await openChatSession(win)
    await win.waitForTimeout(1200)
    await dismissNotifications(win)

    // ① 卡片渲染
    const cards = await win.locator('.t2-taskcard').count()
    const chips = await win.locator('.t2-suggest-chip').count()
    const leak = await win.evaluate(() => [...document.querySelectorAll('.t2-content')].some((el) => (el.textContent || '').includes('forsion-task')))
    check('两张任务卡 + 一颗芯片渲染在消息底部,围栏原文不进任何一段正文', cards === 2 && chips === 1 && !leak, JSON.stringify({ cards, chips, leak }))
    // 任务书默认折叠但可展开(点下去发的是它,用户必须能看见)。负对照下没有卡,点击会超时中止 → 直接判红。
    const toggle = win.locator('.t2-taskcard').nth(0).locator('.t2-taskcard-toggle')
    if (await toggle.count()) await toggle.click()
    const promptShown = await win.locator('.t2-taskcard').nth(0).locator('.t2-taskcard-prompt').textContent().catch(() => '')
    check('任务书可展开且是原文', promptShown === PROMPT_A, JSON.stringify(promptShown?.slice(0, 40)))

    const probe = await win.evaluate(() => [...document.querySelectorAll('.t2-taskcard')].map((c) => ({
      title: c.querySelector('.t2-taskcard-head b')?.textContent,
      tldr: c.querySelector('.t2-taskcard-tldr')?.textContent,
      tag: c.querySelector('.t2-taskcard-tag')?.textContent,
      buttons: [...c.querySelectorAll('.t2-taskcard-actions button')].map((b) => ({ text: b.textContent.trim(), primary: b.classList.contains('primary') })),
    })))
    check('卡一:标题/摘要/四个落点,主按钮=在此执行', probe[0]?.title === '修生图 slug 被当聊天模型' && probe[0]?.tldr?.includes('grok-imagine') && probe[0]?.buttons?.length === 4 && probe[0]?.buttons?.[0]?.primary && probe[0]?.buttons?.[0]?.text.includes('在此执行'), JSON.stringify(probe[0]))
    check('卡二:track 标签 + 主按钮=交给 Muse 追踪', probe[1]?.tag === '追踪' && probe[1]?.buttons?.[0]?.primary && probe[1]?.buttons?.[0]?.text.includes('Muse'), JSON.stringify(probe[1]))
    if (!NEGATIVE_CONTROL) await win.locator('.t2-chat-view').first().screenshot({ path: SHOT_CHAT })
    if (NEGATIVE_CONTROL) {
      // 负对照只证一件事:围栏名不对就不该长出卡片。上面三条已经该红了;后面的落点步骤没有卡可点,直接结算。
      const failed = results.filter((r) => !r.ok)
      console.log(`\n负对照:${failed.length} 条转红(预期 ≥3)`)
      await app.close().catch(() => {})
      stub.close()
      process.exit(failed.length >= 3 ? 1 : 2)
    }

    // ② 新会话执行:任务书原样成为首条消息
    const runsBefore = stub.seen.runs.length
    await win.locator('.t2-taskcard').nth(0).locator('button', { hasText: '新会话执行' }).click()
    await win.waitForTimeout(1500)
    const run = stub.seen.runs[runsBefore]
    check('「新会话执行」发出的首条消息 = 任务书原文,且落在**新**会话(不是当前会话)', !!run && run.message === PROMPT_A && run.sessionId && run.sessionId !== SESSION.id, JSON.stringify({ n: stub.seen.runs.length, sessionId: run?.sessionId, message: run?.message?.slice(0, 60) }))

    // ③ 交给 Muse 追踪:写 muse 日程 + 反馈行
    await openChatSession(win).catch(() => {})
    await win.waitForTimeout(800)
    const trackBtn = win.locator('.t2-taskcard').nth(1).locator('button', { hasText: 'Muse' }).first()
    if (await trackBtn.count()) await trackBtn.click()
    await win.waitForTimeout(1200)
    // 两张卡都点过(卡一「新会话」导航走了又切回来,组件重挂):定格要靠模块级记录活下来,否则第二次点=第二条日程
    check('两张卡都定格为「已…」且不再有按钮(切走再切回也不复活)', (await win.locator('.t2-taskcard.done').count()) === 2 && (await win.locator('.t2-taskcard .t2-taskcard-actions').count()) === 0)
    const sched = seen.schedule[0]
    check('「交给 Muse 追踪」写了一条 muse 日程(repeat 1d / auto / 名=标题 / prompt=前缀+完整任务书,不截断)', !!sched && sched.repeat === '1d' && sched.auto === true && sched.name === '盯着 build-desktop 的失败率' && sched.prompt === TRACK_PREFIX + PROMPT_B && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(sched.date)), JSON.stringify(sched))
    check('落点回执进 Muse LOG([feedback] 行)', seen.feedback.some((x) => x.includes('handed to Muse')) && seen.feedback.some((x) => x.includes('new session')), JSON.stringify(seen.feedback))

    // ④ Muse Space
    const clicked = await win.evaluate(() => {
      const button = [...document.querySelectorAll('button.rb-space')].find((item) => (item.getAttribute('title') || item.textContent || '').trim() === 'Muse')
      if (button) { button.click(); return true }
      return false
    })
    check('ribbon 上有 Muse Space 图标', clicked)
    await win.waitForTimeout(2500)
    await dismissNotifications(win)
    const lib1 = await win.evaluate(() => {
      const rows = [...document.querySelectorAll('.file-row .file-name')].map((x) => x.textContent.trim())
      const body = document.body.textContent || ''
      return { rows, previewText: body.includes('整理了下载文件夹的草稿') && body.includes('heartbeat'), base64Leak: /IyAyMDI2/.test(body) }
    })
    check('主视图列出 Journal 文件并渲染当日日志(Journal 置顶;UTF-8 解码,不是 base64 原文)', lib1.rows.includes('Journal/2026-09-10.md') && lib1.rows.includes('Home.md') && lib1.rows.indexOf('Journal/2026-09-10.md') < lib1.rows.indexOf('Home.md') && lib1.previewText && !lib1.base64Leak, JSON.stringify(lib1))

    const panel = await win.evaluate(() => ({
      pending: !!document.body.textContent.includes('1 项待批'),
      approveBtn: !![...document.querySelectorAll('button')].find((b) => b.textContent.includes('批准并执行')),
      track: !!document.body.textContent.includes('盯着 CI 失败率'),
      todo: !!document.body.textContent.includes('Windows 步骤'),
    }))
    check('右栏 Muse 面板:待批 pill / 批准按钮 / 追踪中 / TODO 都在', panel.pending && panel.approveBtn && panel.track && panel.todo, JSON.stringify(panel))
    if (!NEGATIVE_CONTROL) await win.screenshot({ path: SHOT_SPACE })
    await win.locator('button', { hasText: '批准并执行' }).first().click()
    await win.waitForTimeout(1000)
    check('「批准并执行」打到 POST /agent/special/approvals/:id/approve', seen.approve.length === 1 && seen.approve[0].id === 'apv-1' && seen.approve[0].decision === 'approve' && seen.approve[0].method === 'POST', JSON.stringify(seen.approve))

  } finally {
    await app.close().catch(() => {})
    stub.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过` + (NEGATIVE_CONTROL ? '(负对照:①/卡片断言应转红)' : `;截图 ${SHOT_CHAT} / ${SHOT_SPACE}`))
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
