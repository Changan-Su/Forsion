/**
 * Chat View 等待期信息 —— 真 Electron × 真组件/store × 可编剧假引擎。
 *
 * 钉住两处产品契约:
 *  ① 最后一条助手气泡末尾一行 run 统计「耗时 · N tokens · 思考 Xs」:运行中逐秒走、思考中显示「思考中」,
 *     done / 用户停止后冻结(不再走),tokens 取 usage.total。
 *  ② 运行中输入框占位换成「小贴士:…」并定时轮换;run 结束回到默认占位。
 *
 * 需先 npm run build。用法:npm run e2e:runstats
 * 负对照:node scripts/chat-runstats.e2e.cjs --nc(CSS 隐藏统计行 + 撤掉窄框两行撑高 + 加回流式光标:统计行可见性、「小贴士不被裁」、「没有闪烁光标」必须转红;
 *        轮换 / 回默认占位这几条无 CSS 可破坏,不在负对照内)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const NEGATIVE_CONTROL = process.argv.includes('--nc')
const SHOTS = {
  liveLight: path.join(os.tmpdir(), 'forsion-runstats-live-light.png'),
  liveDark: path.join(os.tmpdir(), 'forsion-runstats-live-dark.png'),
  done: path.join(os.tmpdir(), 'forsion-runstats-done.png'),
  narrow: path.join(os.tmpdir(), 'forsion-runstats-narrow-composer.png'),
}
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const SESSION = {
  id: 'runstats-s1', title: 'RunStats 验收', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/runstats-demo', project_name: 'runstats-demo',
  created_at: '2026-09-16 09:00:00', updated_at: '2026-09-16 09:00:00',
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

/** 同 chat-shimmer:启动缺省是 Home Space,先切 Agent Space,再把侧栏切到会话列表。 */
async function openChatSession(win) {
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await win.waitForTimeout(1000)
  await win.evaluate((names) => {
    const button = [...document.querySelectorAll('button.rb-space')]
      .find((item) => names.some((name) => (item.getAttribute('title') || item.textContent || '').includes(name)))
    button?.click()
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
  const row = win.locator('.t2s-srow', { hasText: 'RunStats 验收' }).first()
  if (!(await row.count().catch(() => 0))) {
    const shot = path.join(os.tmpdir(), 'forsion-runstats-nav-fail.png')
    await win.screenshot({ path: shot })
    throw new Error(`没找到会话行;截图 ${shot}`)
  }
  await row.click()
  await win.waitForTimeout(900)
}

const probe = (win) => win.evaluate(() => {
  const line = [...document.querySelectorAll('.t2-runstats')]
  const ta = document.querySelector('.t2c-ta')
  return {
    lines: line.length,
    visible: !!line[0] && line[0].getBoundingClientRect().height > 0,
    state: line[0]?.getAttribute('data-run-stats') ?? null,
    text: line[0]?.textContent ?? '',
    inLastAssistant: !!line[0] && line[0].closest('.t2-asst') === [...document.querySelectorAll('.t2-asst')].pop(),
    placeholder: ta?.getAttribute('placeholder') ?? '',
    // 空输入框里占位折行被一行高裁掉:scrollHeight 会算上占位(Chromium 实测)
    tipClipped: !!ta && !ta.value && ta.scrollHeight > ta.clientHeight + 2,
    tipTall: ta?.hasAttribute('data-tip-tall') ?? false,
    taW: ta?.clientWidth ?? -1,
    // 流式正文末尾的闪烁光标已按用户要求去掉:任何正文块上都不许有 ::after 光标 / streaming-caret
    caret: [...document.querySelectorAll('.t2-asst .t2-content')].some((el) => el.classList.contains('streaming-caret') || /▍/.test(getComputedStyle(el, '::after').content)),
  }
})

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-runstats-'))
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
  })

  try {
    const win = await app.firstWindow()
    await win.setViewportSize({ width: 1400, height: 900 })
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await openChatSession(win)
    const idlePlaceholder = (await probe(win)).placeholder
    if (NEGATIVE_CONTROL) {
      await win.addStyleTag({ content: ".t2-runstats{display:none!important} .t2c-ta[data-tip-tall]{min-height:0!important} .t2-asst .t2-content::after{content:'▍'}" })
    }

    const waitText = (re, timeout) => win.waitForFunction((src) => new RegExp(src).test(document.querySelector('.t2-runstats')?.textContent || ''), re.source, { timeout }).catch(() => {})

    // run 1:思考 ~3.2s → 正文 → usage → 长静默(等小贴士轮换)→ 再一段正文 → done
    stub.script([
      { type: 'reasoning', delay: 200, payload: { delta: '先看看' } },
      ...Array.from({ length: 8 }, () => ({ type: 'reasoning', delay: 400, payload: { delta: '…' } })),
      { type: 'token', delay: 0, payload: { delta: '好的,' } },
      { type: 'usage', delay: 100, payload: { prompt: 12000, completion: 345, total: 12345 } },
      { type: 'token', delay: 12000, payload: { delta: '做完了。' } },
      { type: 'done', delay: 200, payload: {} },
    ])
    const sentAt = Date.now()
    await send(win, '看看等待期信息')
    await waitText(/思考中 \d+s/, 5000)
    const thinking = await probe(win)
    const tipA = thinking.placeholder
    check('运行中最后一条助手气泡末尾出现统计行', thinking.lines === 1 && thinking.visible && thinking.inLastAssistant && thinking.state === 'live', JSON.stringify(thinking))
    check('思考中显示「思考中」段', thinking.visible && /思考中 \d+s/.test(thinking.text), thinking.text)
    check('运行中占位换成小贴士', tipA.startsWith('小贴士') && tipA !== idlePlaceholder, tipA)

    await waitText(/tokens/, 6000)
    const t1 = await probe(win)
    await win.waitForTimeout(3100)
    const t2 = await probe(win)
    const sec = (s) => { const m = /^(?:(\d+)m )?(\d+)s/.exec(s); return m ? Number(m[1] || 0) * 60 + Number(m[2]) : -1 }
    check('运行中耗时逐秒走', t2.visible && sec(t1.text) >= 0 && sec(t2.text) - sec(t1.text) >= 2, `${t1.text} → ${t2.text}`)
    check('流式输出末尾没有闪烁光标', t1.lines === 1 && t1.state === 'live' && !t1.caret, JSON.stringify({ state: t1.state, caret: t1.caret }))
    check('出正文后思考结算、tokens 取 usage.total', /12\.3k tokens/.test(t2.text) && /思考 [34]s/.test(t2.text) && !/思考中/.test(t2.text), t2.text)
    check('小贴士不随渲染乱换(8s 内保持同一条)', Date.now() - sentAt < 7800 && t1.placeholder === tipA && t2.placeholder === tipA, `${tipA} / ${t1.placeholder} / ${t2.placeholder} @${Date.now() - sentAt}ms`)

    if (!NEGATIVE_CONTROL) await win.locator('.t2-chat-col').first().screenshot({ path: SHOTS.liveLight }).catch(() => win.screenshot({ path: SHOTS.liveLight }))
    await win.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.dataset.mode = 'dark' })
    if (!NEGATIVE_CONTROL) await win.locator('.t2-chat-col').first().screenshot({ path: SHOTS.liveDark }).catch(() => win.screenshot({ path: SHOTS.liveDark }))
    await win.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.dataset.mode = 'light' })

    await win.waitForTimeout(Math.max(0, 10_500 - (Date.now() - sentAt))) // 过了 8s 换条点
    const rotated = await probe(win)
    check('小贴士定时轮换', rotated.placeholder.startsWith('小贴士') && rotated.placeholder !== tipA, `${tipA} → ${rotated.placeholder}`)

    await win.waitForSelector('.t2-runstats[data-run-stats="done"]', { timeout: 10_000 }).catch(() => {})
    const done1 = await probe(win)
    await win.waitForTimeout(2100)
    const done2 = await probe(win)
    check('done 后统计冻结', done2.visible && done1.state === 'done' && done1.text === done2.text && /12\.3k tokens · 思考 [34]s/.test(done2.text), `${done1.text} | ${done2.text}`)
    check('done 后占位回到默认', done2.placeholder === idlePlaceholder, done2.placeholder)
    if (!NEGATIVE_CONTROL) await win.locator('.t2-asst').last().screenshot({ path: SHOTS.done })

    // run 2(窄窗):思考中被用户停止。引擎式停止 = 流上先来 error{aborted},UI 缓存后在确认时重放。
    await win.setViewportSize({ width: 620, height: 900 })
    await win.waitForTimeout(600)
    stub.script([
      { type: 'reasoning', delay: 200, payload: { delta: '想想' } },
      { type: '__hold' },
    ])
    await send(win, '再来一次然后停止')
    await waitText(/思考中 \d+s/, 5000)
    const beforeStop = await probe(win)
    check('新 run 从头计时并挂到新气泡', beforeStop.state === 'live' && beforeStop.inLastAssistant && sec(beforeStop.text) <= 4 && !/tokens/.test(beforeStop.text), beforeStop.text)
    check('窄输入框里小贴士不被裁成半句', beforeStop.placeholder.startsWith('小贴士') && !beforeStop.tipClipped, JSON.stringify({ placeholder: beforeStop.placeholder, tipClipped: beforeStop.tipClipped, tall: beforeStop.tipTall, taW: beforeStop.taW }))
    if (!NEGATIVE_CONTROL) await win.locator('.t2c-card, .t2c-inner').first().screenshot({ path: SHOTS.narrow }).catch(() => {})
    await win.locator('.t2c-stop').first().click()
    await win.waitForSelector('.t2-runstats[data-run-stats="done"]', { timeout: 8000 }).catch(() => {})
    const stopped1 = await probe(win)
    await win.waitForTimeout(2100)
    const stopped2 = await probe(win)
    check('停止后统计冻结、思考段结算', stopped1.state === 'done' && stopped1.text === stopped2.text && /思考 \d+s/.test(stopped2.text) && !/思考中/.test(stopped2.text) && (stub.seen.aborts || []).length === 1, `${stopped1.text} | ${stopped2.text}`)
    check('停止后占位回到默认、两行撑高撤掉', stopped2.placeholder === idlePlaceholder && !stopped2.tipTall, JSON.stringify({ placeholder: stopped2.placeholder, tall: stopped2.tipTall }))
  } finally {
    await app.close().catch(() => {})
    try { stub.close?.() } catch { /* best-effort test cleanup */ }
    fs.rmSync(home, { recursive: true, force: true })
  }

  const failed = results.filter((r) => !r.ok)
  if (NEGATIVE_CONTROL) {
    console.log(failed.length ? `\n负对照 OK:${failed.length} 条如期转红` : '\n负对照失败:注入破坏后仍全绿')
    process.exit(failed.length ? 0 : 1)
  }
  console.log(failed.length ? `\n${failed.length} FAIL` : `\nALL PASS\n截图:${Object.values(SHOTS).join('\n     ')}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
