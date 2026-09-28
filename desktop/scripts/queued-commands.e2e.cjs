/**
 * 运行中排队(/compact 等命令对齐 Codex)—— 真 Electron × 真组件/store × 可编剧假引擎。
 *
 * 钉住的产品契约:
 *  ① run 在跑时发 /compact <关注点>:不撞引擎(不发压缩请求),进输入框上方等待区,提示换成「排队项…」,不露「立即插话」;
 *  ② 之后再发的消息排在它后面:不 steer 进当前 run、不起新 run;
 *  ③ run 正常收尾 → 先发压缩(带关注点),压完再起新 run 发那条消息,等待区清空;
 *  ④ 用户点停止 → 排着的 /compact 照跑(刻意决定:显式排的、可 × 删)。
 *
 * 需先 npm run build。用法:npm run e2e:queue
 * 负对照:node scripts/queued-commands.e2e.cjs --nc(不敲 /compact → 排队 / 压缩类存在断言必须转红)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const NEGATIVE_CONTROL = process.argv.includes('--nc')
const SHOTS = {
  light: path.join(os.tmpdir(), 'forsion-queue-light.png'),
  dark: path.join(os.tmpdir(), 'forsion-queue-dark.png'),
}
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const SESSION = {
  id: 'queue-s1', title: '排队验收', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/queue-demo', project_name: 'queue-demo',
  created_at: '2026-09-28 09:00:00', updated_at: '2026-09-28 09:00:00',
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

/** 同 chat-livewait:切到 Agent Space → 侧栏切「会话」→ 点会话行。 */
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
  const picker = win.locator('.t2sw-mode-picker').first()
  if (await picker.count().catch(() => 0)) {
    await picker.locator('.t2sw-mode-trigger').click().catch(() => {})
    await picker.locator('[data-workspace-mode="sessions"]').click().catch(() => {})
    await win.waitForTimeout(1000)
  }
  const row = win.locator('.t2s-srow', { hasText: '排队验收' }).first()
  if (!(await row.count().catch(() => 0))) {
    const shot = path.join(os.tmpdir(), 'forsion-queue-nav-fail.png')
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
  const compacts = []
  const steers = []
  const stub = await startStubEngine({
    sessions: [SESSION], messages: [],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }],
    handle: async ({ path: p, method, body }) => {
      if (method === 'POST' && /^\/agent\/sessions\/[^/]+\/compact$/.test(p)) {
        compacts.push(await body())
        return { ok: true, summarizedCount: 2, contextTokens: 1200 }
      }
      // 兜底路由对 steer 也回 ok —— 不单独记下来的话,错插进当前 run 的消息看起来一样「被接受」
      if (method === 'POST' && /^\/agent\/runs\/[^/]+\/steer$/.test(p)) {
        steers.push(await body())
        return { ok: true, userMessageId: `u-steer-${steers.length}` }
      }
      return undefined
    },
  })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-queue-'))
  const app = await electron.launch({
    // -ApplePersistenceIgnoreState YES 放在 ROOT 之后:跳过 macOS 崩溃恢复模态框(台架共用 Electron.app)
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT, '-ApplePersistenceIgnoreState', 'YES'],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
  })

  try {
    const win = await app.firstWindow({ timeout: 60_000 })
    await win.setViewportSize({ width: 1600, height: 900 })
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await openChatSession(win)

    const items = () => win.locator('.t2c-steer-item .t2c-steer-text').allTextContents().catch(() => [])

    // ── 场景 1:run 挂住 → 排 /compact + 消息 → 正常收尾后按序执行 ──
    stub.script([{ type: 'token', payload: { delta: '干活中…' } }, { type: '__hold' }])
    await send(win, '先干活')
    await waitFor(() => win.locator('.t2c-stop').count().then((n) => n > 0))

    if (!NEGATIVE_CONTROL) await send(win, '/compact 保留接口约定')
    await win.waitForTimeout(500)
    const afterCompact = await items()
    check('运行中的 /compact 进等待区,不发压缩请求', afterCompact.length === 1 && afterCompact[0] === '/compact 保留接口约定' && compacts.length === 0, JSON.stringify({ afterCompact, compacts: compacts.length }))
    // 取值一律短超时:缺省会等满 30s,正好撞上 run 看门狗(桩的在飞列表恒空 → 判 run 已结束)
    const hint = await win.locator('.t2c-steer-hint').first().textContent({ timeout: 1000 }).catch(() => null)
    check('等待区提示换成排队文案', !!hint && hint.includes('本轮结束后依次执行'), JSON.stringify(hint))
    check('只有排队项时不露「立即插话」', (await win.locator('.t2c-steer-now').count()) === 0)

    await send(win, '继续写测试')
    await win.waitForTimeout(600)
    const both = await items()
    check('命令后面的消息跟着排,不 steer、不起新 run', both.length === 2 && both[1] === '继续写测试' && steers.length === 0 && stub.seen.runs.length === 1,
      JSON.stringify({ both, steers: steers.length, runs: stub.seen.runs.length }))

    if (!NEGATIVE_CONTROL) {
      // 首条消息会弹「成就达成」浮层,恰好盖在等待区上 —— 与被测无关,拍照前藏掉
      await win.addStyleTag({ content: '.ach-toast{display:none!important}' })
      const box = win.locator('.t2c-steer').first()
      await box.screenshot({ path: SHOTS.light })
      await win.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.dataset.mode = 'dark' })
      await win.waitForTimeout(250)
      await box.screenshot({ path: SHOTS.dark })
      await win.evaluate(() => { document.documentElement.classList.remove('dark'); delete document.documentElement.dataset.mode })
    }

    stub.finish('r1', [{ type: 'done', payload: { content: '干活中…干完了' } }])
    await waitFor(() => compacts.length > 0)
    check('本轮收尾后先压缩,且带上关注点', compacts.length === 1 && compacts[0].instructions === '保留接口约定', JSON.stringify(compacts))
    check('压缩进行中不起新 run', stub.seen.runs.length === 1, `runs=${stub.seen.runs.length}`)
    await waitFor(() => stub.seen.runs.length >= 2, 6000)
    check('压完再起新 run 发排队的消息', stub.seen.runs[1]?.message === '继续写测试', JSON.stringify(stub.seen.runs.map((r) => r.message)))
    await win.waitForTimeout(800)
    check('等待区清空', (await items()).length === 0)

    // ── 场景 2:点停止,排着的 /compact 照跑 ──
    stub.script([{ type: 'token', payload: { delta: '第二轮…' } }, { type: '__hold' }])
    await send(win, '再干一轮')
    await waitFor(() => stub.seen.runs.length >= 3)
    await waitFor(() => win.locator('.t2c-stop').count().then((n) => n > 0))
    if (!NEGATIVE_CONTROL) await send(win, '/compact 第二次')
    await win.waitForTimeout(400)
    await win.locator('.t2c-stop').first().click()
    await waitFor(() => compacts.length >= 2, 12_000)
    check('用户停止后排着的 /compact 照跑', compacts.length === 2 && compacts[1].instructions === '第二次', JSON.stringify(compacts))
  } finally {
    await app.close().catch(() => {})
    try { stub.close() } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过` + (NEGATIVE_CONTROL ? '(负对照:排队 / 压缩类断言应转红)' : `;截图 ${SHOTS.light} / ${SHOTS.dark}`))
  if (NEGATIVE_CONTROL) process.exit(failed.length >= 4 ? 0 : 1)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
