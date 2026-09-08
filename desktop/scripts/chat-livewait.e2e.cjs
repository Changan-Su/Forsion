/**
 * 等模型实况行(LiveWaitLine)—— 真 Electron × 真组件/store × 可编剧假引擎。
 *
 * 钉住的产品契约(2026-09-06 取证:本机 52% 墙钟在等首帧,原来只有一行不动的 shimmer,用户报「卡住」):
 *  ① status:llm_call sending → 显示「正在发送上下文 N KB」;accepted → 换成「等待模型首帧」;
 *  ② 2 秒起带「已等待 N 秒」且每秒递增;
 *  ③ 首帧(token)到达即整行消失;done 后不残留。
 *
 * 需先 npm run build。用法:npm run e2e:livewait
 * 负对照:node scripts/chat-livewait.e2e.cjs --nc(剧本改发未知 phase,实况行不该出现 → 存在类断言必须转红)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const NEGATIVE_CONTROL = process.argv.includes('--nc')
const PHASE = NEGATIVE_CONTROL ? 'llm_call_bogus' : 'llm_call'
const SHOTS = {
  light: path.join(os.tmpdir(), 'forsion-chat-livewait-light.png'),
  dark: path.join(os.tmpdir(), 'forsion-chat-livewait-dark.png'),
  view: path.join(os.tmpdir(), 'forsion-chat-livewait-view.png'),
}
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const SESSION = {
  id: 'livewait-s1', title: 'LiveWait 验收', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/livewait-demo', project_name: 'livewait-demo',
  created_at: '2026-09-07 09:00:00', updated_at: '2026-09-07 09:00:00',
}

async function send(win, text) {
  const ta = win.locator('.t2c-ta').first()
  for (let i = 0; i < 40; i++) {
    if (await ta.isEnabled().catch(() => false)) break
    await win.waitForTimeout(500)
  }
  await ta.click()
  await ta.fill(text)
  await win.keyboard.press('Enter')
}

/** 启动缺省是主页 Space(spaces.tsx),会话列表在 Agent Space 里:先切 Space,再把侧栏切到「会话」,再点行。 */
async function openChatSession(win) {
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await win.waitForTimeout(1000)
  const clicked = await win.evaluate((names) => {
    const b = [...document.querySelectorAll('button.rb-space')].find((x) => names.some((n) => (x.getAttribute('title') || x.textContent || '').includes(n)))
    if (b) { b.click(); return (b.getAttribute('title') || b.textContent || '').trim() }
    return null
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
  const row = win.locator('.t2s-srow', { hasText: 'LiveWait 验收' }).first()
  if (!(await row.count().catch(() => 0))) {
    await win.screenshot({ path: path.join(os.tmpdir(), 'forsion-chat-livewait-nav-fail.png') })
    throw new Error(`没找到会话行(切到的 Space=${JSON.stringify(clicked)});截图 ${path.join(os.tmpdir(), 'forsion-chat-livewait-nav-fail.png')}`)
  }
  await row.click()
  await win.waitForTimeout(900)
}

const liveText = (win) => win.locator('.chat-thinking-live').first().textContent().catch(() => null)

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const stub = await startStubEngine({
    sessions: [SESSION],
    messages: [],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000, thinkingLevels: ['off', 'low'] }],
  })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-chat-livewait-'))
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

    // ── run 1:sending → accepted → 挂住(真引擎等首帧时就是这样) ──
    stub.script([
      { type: 'status', delay: 200, payload: { phase: PHASE, stage: 'sending', iteration: 0, bytes: 327_680 } },
      { type: 'status', delay: 1500, payload: { phase: PHASE, stage: 'accepted', iteration: 0, bytes: 327_680, uploadMs: 1400 } },
      { type: '__hold' },
    ])
    await send(win, '看看等模型时画什么')
    await win.waitForTimeout(700)
    const t1 = await liveText(win)
    check('sending 阶段显示「正在发送上下文 N KB」', !!t1 && t1.includes('正在发送上下文') && t1.includes('320 KB'), JSON.stringify(t1))
    await win.waitForTimeout(1500)
    const t2 = await liveText(win)
    check('accepted 阶段换成「等待模型首帧」', !!t2 && t2.includes('等待模型首帧'), JSON.stringify(t2))
    await win.waitForTimeout(1200)
    const t3 = await liveText(win)
    const secOf = (s) => Number((String(s || '').match(/已等待 (\d+) 秒/) || [])[1])
    check('2 秒起带「已等待 N 秒」', secOf(t3) >= 2, JSON.stringify(t3))
    await win.waitForTimeout(1100)
    const t4 = await liveText(win)
    check('秒数每秒递增', secOf(t4) > secOf(t3), `${secOf(t3)} → ${secOf(t4)}`)
    const probe = await win.evaluate(() => {
      const el = document.querySelector('.chat-thinking-live')
      const shimmer = el?.querySelector('.chat-run-shimmer-text')
      return { role: el?.getAttribute('role'), shimmerAnim: shimmer ? getComputedStyle(shimmer).animationName : null }
    })
    check('实况行 role=status 且阶段文案沿用 shimmer', probe.role === 'status' && probe.shimmerAnim === 'chat-run-shimmer', JSON.stringify(probe))
    if (!NEGATIVE_CONTROL) {
      await win.locator('.t2-chat-view').first().screenshot({ path: SHOTS.view })
      await win.locator('.chat-thinking-live').first().screenshot({ path: SHOTS.light })
      await win.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.dataset.mode = 'dark' })
      await win.waitForTimeout(200)
      await win.locator('.chat-thinking-live').first().screenshot({ path: SHOTS.dark })
      await win.evaluate(() => { document.documentElement.classList.remove('dark'); delete document.documentElement.dataset.mode })
    }
  } finally {
    await app.close().catch(() => {})
    try { await stub.close() } catch { /* ignore */ }
  }

  // ── run 2(新进程,免得被上面的 __hold 挂着):首帧到达即消失,done 后不残留 ──
  const stub2 = await startStubEngine({
    sessions: [SESSION], messages: [],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }],
  })
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-chat-livewait2-'))
  const app2 = await electron.launch({
    args: [`--user-data-dir=${path.join(home2, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home2, TANGU_BACKEND_URL: stub2.url },
  })
  try {
    const win = await app2.firstWindow()
    await win.setViewportSize({ width: 1600, height: 900 })
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await openChatSession(win)
    stub2.script([
      { type: 'status', delay: 200, payload: { phase: PHASE, stage: 'sending', iteration: 0, bytes: 4096 } },
      { type: 'token', delay: 1200, payload: { delta: '首帧到了。' } },
      { type: 'done', delay: 300, payload: { content: '首帧到了。' } },
    ])
    await send(win, '首帧后该消失')
    await win.waitForTimeout(700)
    const before = await win.locator('.chat-thinking-live').count()
    await win.waitForTimeout(1500)
    const after = await win.locator('.chat-thinking-live').count()
    check('首帧前实况行存在、首帧后消失', before === 1 && after === 0, `before=${before} after=${after}`)
  } finally {
    await app2.close().catch(() => {})
    try { await stub2.close() } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过` + (NEGATIVE_CONTROL ? '(负对照:存在类断言应转红)' : `;截图 ${SHOTS.view} / ${SHOTS.light} / ${SHOTS.dark}`))
  if (NEGATIVE_CONTROL) process.exit(failed.length >= 4 ? 0 : 1)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
