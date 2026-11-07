/**
 * 运行中插话直接上屏(2026-11-07 方案 A)—— 真 Electron × 真组件/store × 可编剧假引擎。
 *
 * 钉住的产品契约:
 *  ① run 在跑时发一句:立刻画进对话末尾(正在写的那段下面),输入框上方不再出等待区;气泡下一行「等 Agent 读取」;
 *  ② 连发两条:两个气泡,小字只挂在最后一条下面;
 *  ③ 悬停最后一条点「撤回」:引擎收到 DELETE,文字回到输入框,气泡消失;
 *  ④ 引擎 turn_boundary 读到第一条:小字没了,**同一个 DOM 节点**原地转正(不重挂),新一段回答接在它下面;
 *  ⑤ 亮 / 暗各拍一张。
 *
 * 需先 npm run build。用法:npm run e2e:steerinline
 * 负对照:node scripts/steer-inline.e2e.cjs --nc(运行中不发插话 → 上屏 / 撤回 / 转正类断言必须转红)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const NEGATIVE_CONTROL = process.argv.includes('--nc')
const SHOTS = {
  light: path.join(os.tmpdir(), 'forsion-steer-inline-light.png'),
  dark: path.join(os.tmpdir(), 'forsion-steer-inline-dark.png'),
  settled: path.join(os.tmpdir(), 'forsion-steer-inline-settled.png'),
}
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const SESSION = {
  id: 'steer-s1', title: '插话上屏验收', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/steer-demo', project_name: 'steer-demo',
  created_at: '2026-11-07 09:00:00', updated_at: '2026-11-07 09:00:00',
}

async function send(win, text) {
  const ta = win.locator('.t2c-ta').first()
  await ta.click()
  await ta.fill(text)
  await win.keyboard.press('Enter')
}

async function waitFor(fn, ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

async function openChatSession(win) {
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await win.waitForTimeout(1000)
  await win.evaluate((names) => {
    const b = [...document.querySelectorAll('button.rb-space')].find((x) => names.some((n) => (x.getAttribute('aria-label') || x.getAttribute('title') || x.textContent || '').includes(n)))
    if (b) b.click()
  }, ['Agent', 'Tangu'])
  await win.waitForTimeout(1500)
  if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) {
    await win.click('.dv-edge-left').catch(() => {})
    await win.waitForTimeout(700)
  }
  const row = win.locator('.t2s-srow', { hasText: '插话上屏验收' }).first()
  if (!(await row.count().catch(() => 0))) {
    const shot = path.join(os.tmpdir(), 'forsion-steer-inline-nav-fail.png')
    await win.screenshot({ path: shot })
    throw new Error(`没找到会话行;截图 ${shot}`)
  }
  await row.click()
  await win.waitForTimeout(900)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const steers = []
  const cancels = []
  const stub = await startStubEngine({
    sessions: [SESSION], messages: [],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }],
    handle: async ({ path: p, method, body }) => {
      if (method === 'POST' && /^\/agent\/runs\/[^/]+\/steer$/.test(p)) {
        const b = await body()
        if (b && b.flush) return { ok: true }
        steers.push(b)
        return { ok: true, userMessageId: `u-steer-${steers.length}` }
      }
      if (method === 'DELETE' && /^\/agent\/runs\/[^/]+\/steer\/[^/]+$/.test(p)) {
        cancels.push(decodeURIComponent(p.split('/').pop()))
        return { ok: true }
      }
      return undefined
    },
  })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-steer-inline-'))
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT, '-ApplePersistenceIgnoreState', 'YES'],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
  })

  try {
    const win = await app.firstWindow({ timeout: 60_000 })
    await win.setViewportSize({ width: 1400, height: 900 })
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await openChatSession(win)
    // 首条消息弹的成就浮层会盖住输入区一角,与被测无关
    await win.addStyleTag({ content: '.ach-toast{display:none!important}' })

    const pending = () => win.locator('.t2-stream .t2-userwrap--pending')
    const pendingTexts = () => win.locator('.t2-stream .t2-userwrap--pending .t2-user').allTextContents().catch(() => [])

    stub.script([{ type: 'token', payload: { delta: '第一周(10-01 至 10-07)主要是两件事:同步页简化,以及' } }, { type: '__hold' }])
    await send(win, '把 10 月的日志按周汇总')
    await waitFor(() => win.locator('.t2c-stop').count().then((n) => n > 0))
    await win.waitForTimeout(400)

    // ① 发一句 → 立刻上屏
    if (!NEGATIVE_CONTROL) await send(win, '只要 Genesis 相关的,server 那部分跳过')
    await waitFor(() => pending().count().then((n) => n > 0), 3000)
    const one = await pendingTexts()
    check('运行中发的话直接画进对话', one.length === 1 && one[0].includes('只要 Genesis'), JSON.stringify(one))
    check('输入框上方不再出等待区', (await win.locator('.t2c-steer').count()) === 0)
    const order = await win.evaluate(() => {
      const nodes = [...document.querySelectorAll('.t2-stream .t2-asst, .t2-stream .t2-userwrap')]
      const i = nodes.findIndex((n) => n.classList.contains('t2-userwrap--pending'))
      return { i, prev: i > 0 ? nodes[i - 1].className : null, total: nodes.length }
    })
    check('气泡在正在写的那段下面', order.i > 0 && /t2-asst/.test(order.prev || ''), JSON.stringify(order))
    const cap = await win.locator('.t2-pending-cap').first().textContent({ timeout: 1000 }).catch(() => null)
    check('小字写「等 Agent 读取 · ↑ 取回」', !!cap && cap.includes('等 Agent 读取') && cap.includes('↑ 取回'), JSON.stringify(cap))
    const ta0 = await win.locator('.t2c-ta').first().inputValue().catch(() => '?')
    check('发出后输入框清空', ta0 === '', JSON.stringify(ta0))

    // ② 再发一条
    if (!NEGATIVE_CONTROL) await send(win, '标题用「10 月开发月报」')
    await waitFor(() => pending().count().then((n) => n >= 2), 3000)
    check('连发两条 = 两个气泡', (await pending().count()) === 2, `n=${await pending().count()}`)
    check('小字只挂在最后一条下面', (await win.locator('.t2-pending-cap').count()) === 1 && (await pending().last().locator('.t2-pending-cap').count()) === 1)

    await win.waitForTimeout(900) // 等发送动效落定(新气泡从输入框飞上来,途中带 transform)
    // 两条待读气泡挨着:间距不该比普通消息大(第一条没有小字,那一行不能白占一截)
    const gaps = await win.evaluate(() => {
      const w = [...document.querySelectorAll('.t2-stream .t2-userwrap--pending')]
      if (w.length < 2) return null
      const a = w[0].getBoundingClientRect(), b = w[1].getBoundingClientRect()
      return { between: Math.round(b.top - a.bottom), firstH: Math.round(a.height) }
    })
    check('两条待读气泡之间不空出一截', !!gaps && gaps.between <= 30, JSON.stringify(gaps))
    if (!NEGATIVE_CONTROL) {
      await win.locator('.t2-stream').first().screenshot({ path: SHOTS.light })
      await win.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.dataset.mode = 'dark' })
      await win.waitForTimeout(250)
      await win.locator('.t2-stream').first().screenshot({ path: SHOTS.dark })
      await win.evaluate(() => { document.documentElement.classList.remove('dark'); delete document.documentElement.dataset.mode })
    }

    // ③ 悬停最后一条 → 撤回
    const last = pending().last()
    if (await last.count()) {
      await last.hover()
      await win.waitForTimeout(250)
      const opacity = await last.locator('.t2-pending-acts').evaluate((el) => getComputedStyle(el).opacity).catch(() => null)
      check('悬停才露出撤回 / 立即插话', opacity === '1', `opacity=${opacity}`)
      await last.locator('.t2-pending-btn', { hasText: '撤回' }).click()
    }
    await waitFor(() => pending().count().then((n) => n <= 1), 3000)
    await win.waitForTimeout(300)
    const ta1 = await win.locator('.t2c-ta').first().inputValue().catch(() => '?')
    check('撤回:引擎收到 DELETE', cancels.length === 1 && cancels[0] === 'u-steer-2', JSON.stringify(cancels))
    check('撤回:文字回到输入框、气泡消失', ta1 === '标题用「10 月开发月报」' && (await pending().count()) === 1, JSON.stringify({ ta1, n: await pending().count() }))
    await win.locator('.t2c-ta').first().fill('')

    // ④ 引擎读到第一条 → 原地转正
    await win.evaluate(() => { const n = document.querySelector('.t2-stream .t2-userwrap--pending'); if (n) n.__steerProbe = 1 })
    stub.emit('r1', [
      { type: 'turn_boundary', payload: { finalizedAssistantId: 'a-r1', newAssistantId: 'a-r1-b', userMessages: steers.slice(0, 1).map((_, i) => ({ id: `u-steer-${i + 1}`, content: steers[i].message })) } },
      { type: 'token', payload: { delta: '好,server 的部分跳过。' } },
    ])
    await waitFor(() => pending().count().then((n) => n === 0), 4000)
    const settled = await win.evaluate(() => {
      const u = [...document.querySelectorAll('.t2-stream .t2-userwrap')].find((n) => (n.textContent || '').includes('只要 Genesis'))
      if (!u) return null
      let next = u.nextElementSibling
      while (next && !next.matches('.t2-asst, .t2-userwrap') && !next.querySelector('.t2-asst')) next = next.nextElementSibling
      return { same: u.__steerProbe === 1, cap: !!u.querySelector('.t2-pending-cap'), next: next ? (next.textContent || '').slice(0, 80) : null }
    })
    check('读到后小字消失、仍是同一个节点', !!settled && settled.same && !settled.cap, JSON.stringify(settled))
    check('新一段回答接在它下面', !!settled && !!settled.next && settled.next.includes('server 的部分跳过'), JSON.stringify(settled))
    if (!NEGATIVE_CONTROL) await win.locator('.t2-stream').first().screenshot({ path: SHOTS.settled })

    stub.finish('r1', [{ type: 'done', payload: {} }])
    await win.waitForTimeout(500)
  } finally {
    await app.close().catch(() => {})
    try { stub.close() } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过` + (NEGATIVE_CONTROL ? '(负对照:上屏 / 撤回 / 转正类断言应转红)' : `;截图 ${SHOTS.light} / ${SHOTS.dark} / ${SHOTS.settled}`))
  if (NEGATIVE_CONTROL) process.exit(failed.length >= 6 ? 0 : 1)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
