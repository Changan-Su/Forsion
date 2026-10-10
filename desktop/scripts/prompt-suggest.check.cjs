/**
 * 输入建议(默认关)—— 真 Electron × 真组件/store × 可编剧假引擎。
 *
 * 钉住的产品契约:
 *  ① 开关默认关:一轮结束后**一次**建议请求都不发,输入框还是平常的占位文字;
 *  ② 设置 → 外观里把「输入建议」打开(真点开关)后,一轮结束就向引擎拉一次(带上刚结束的 run),
 *     拿到的那句成了空输入框里的灰字(占位文字);
 *  ③ Tab:那句进了输入框、没有发出去,光标在句尾;
 *  ④ 动手打字 = 不要这句了:删空以后回到平常的占位文字;
 *  ⑤ 新一轮起跑,上一轮的建议作废;输入框里已经有字的那一轮不拉。
 *
 * 需先 npm run build。用法:npm run check:promptsuggest
 * 负对照:node scripts/prompt-suggest.check.cjs --nc(不开开关 → ②③ 的断言必须转红)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.join(__dirname, '..')
const NEGATIVE_CONTROL = process.argv.includes('--nc')
const SHOTS = {
  light: path.join(os.tmpdir(), 'forsion-promptsuggest-light.png'),
  dark: path.join(os.tmpdir(), 'forsion-promptsuggest-dark.png'),
}
const SUGGESTION = '跑一下测试看看'
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const SESSION = {
  id: 'suggest-s1', title: '输入建议验收', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/suggest-demo', project_name: 'suggest-demo',
  created_at: '2026-10-10 09:00:00', updated_at: '2026-10-10 09:00:00',
}

async function waitFor(fn, ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

/** 同 queued-commands.e2e:切到 Agent Space → 侧栏切「会话」→ 点会话行。 */
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
  const row = win.locator('.t2s-srow', { hasText: SESSION.title }).first()
  if (!(await row.count().catch(() => 0))) {
    const shot = path.join(os.tmpdir(), 'forsion-promptsuggest-nav-fail.png')
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
  const asked = []
  const stub = await startStubEngine({
    sessions: [SESSION], messages: [],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }],
    handle: async ({ path: p, method, body }) => {
      if (method === 'POST' && /^\/agent\/sessions\/[^/]+\/suggest$/.test(p)) {
        asked.push(await body())
        return { suggestion: SUGGESTION, usage: { prompt: 1000, cached: 950, completion: 6 } }
      }
      return undefined
    },
  })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-promptsuggest-'))
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
    check('离开首启引导', await skipOnboarding(win))
    await openChatSession(win)
    await win.addStyleTag({ content: '.ach-toast{display:none!important}' }) // 首条消息的「成就达成」浮层与被测无关

    const ta = win.locator('.t2c-ta').first()
    const placeholder = () => ta.getAttribute('placeholder', { timeout: 1000 }).catch(() => null)
    const flagged = () => ta.getAttribute('data-suggestion', { timeout: 1000 }).catch(() => null)
    const turn = async (text, reply) => {
      const before = stub.seen.runs.length
      stub.script([{ type: 'token', payload: { delta: reply } }, { type: 'done', payload: { content: reply } }])
      await ta.click()
      await ta.fill(text)
      await win.keyboard.press('Enter')
      await waitFor(() => stub.seen.runs.length > before)
      await waitFor(() => win.locator('.t2c-stop').count().then((n) => n === 0))
      await win.waitForTimeout(700)
    }
    const basePlaceholder = await placeholder()

    // ── ① 默认关:不发请求,占位文字照旧 ──
    await turn('先看看有哪些文件', '有 a.ts 和 a.test.ts。要我跑一下测试吗?')
    check('默认关:一轮结束不发建议请求', asked.length === 0, `请求 ${asked.length} 次`)
    check('默认关:占位文字照旧', (await placeholder()) === basePlaceholder && !(await flagged()), JSON.stringify(await placeholder()))

    // ── ② 在设置里真点开关 ──
    if (!NEGATIVE_CONTROL) {
      await win.keyboard.press('Meta+,')
      const sw = win.locator('[data-setting-anchor="prompt-suggest"] button[role="switch"]').first()
      if (!(await waitFor(() => sw.count().then((n) => n > 0), 4000))) {
        // 设置开在别的页:走搜索直达(与用户找这个开关的路一样)
        const search = win.locator('.settings-nav input, .settings-search input').first()
        await search.fill('输入建议').catch(() => {})
        await win.locator('text=输入建议').first().click().catch(() => {})
      }
      const found = await waitFor(() => sw.count().then((n) => n > 0), 4000)
      check('设置 → 外观里有「输入建议」开关,缺省是关', found && (await sw.getAttribute('aria-checked')) === 'false')
      if (found) { await sw.scrollIntoViewIfNeeded(); await sw.click() }
      check('点一下 → 开', found && (await sw.getAttribute('aria-checked')) === 'true')
      await win.keyboard.press('Escape')
      await win.waitForTimeout(400)
    }

    await turn('那 a.ts 里有什么', 'a.ts 导出了一个 add 函数。要我跑一下测试吗?')
    await waitFor(() => asked.length > 0, 4000)
    const lastRun = stub.seen.runs.at(-1)?.runId
    check('开着:一轮结束拉一次,带上刚结束的 run', asked.length === 1 && asked[0].run_id === lastRun, JSON.stringify({ asked, lastRun }))
    await waitFor(async () => (await placeholder()) === SUGGESTION, 4000)
    check('那句成了空输入框里的灰字', (await placeholder()) === SUGGESTION && (await flagged()) === 'true' && (await ta.inputValue()) === '', JSON.stringify(await placeholder()))

    if (!NEGATIVE_CONTROL) {
      const box = win.locator('.t2c-card, .t2c').first()
      await box.screenshot({ path: SHOTS.light }).catch(() => win.screenshot({ path: SHOTS.light }))
      await win.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.dataset.mode = 'dark' })
      await win.waitForTimeout(250)
      await box.screenshot({ path: SHOTS.dark }).catch(() => win.screenshot({ path: SHOTS.dark }))
      await win.evaluate(() => { document.documentElement.classList.remove('dark'); delete document.documentElement.dataset.mode })
    }

    // ── ③ Tab 采用:进输入框、不发送 ──
    const runsBeforeTab = stub.seen.runs.length
    await ta.click()
    await win.keyboard.press('Tab')
    await win.waitForTimeout(300)
    const caret = await ta.evaluate((el) => [el.selectionStart, el.selectionEnd, document.activeElement === el])
    check('Tab:那句进了输入框,没有发出去', (await ta.inputValue()) === SUGGESTION && stub.seen.runs.length === runsBeforeTab, JSON.stringify(await ta.inputValue()))
    check('Tab 之后焦点还在输入框、光标在句尾', caret[2] === true && caret[0] === SUGGESTION.length && caret[1] === SUGGESTION.length, JSON.stringify(caret))
    await ta.fill('')
    await win.waitForTimeout(200)
    check('采用过的那句不再当灰字出现', (await placeholder()) === basePlaceholder && !(await flagged()), JSON.stringify(await placeholder()))

    // ── ④ 动手打字 = 不要这句了 ──
    await turn('再看看 a.test.ts', '里面有两条用例。要我跑一下测试吗?')
    await waitFor(async () => (await placeholder()) === SUGGESTION, 4000)
    await ta.click()
    await win.keyboard.type('我')
    await win.keyboard.press('Backspace')
    await win.waitForTimeout(200)
    check('打过字再删空:回到平常的占位文字', (await placeholder()) === basePlaceholder && (await ta.inputValue()) === '', JSON.stringify(await placeholder()))

    // ── ⑤ 新一轮起跑作废旧建议;输入框里有字的那一轮不拉 ──
    await turn('好', '还有别的要看的吗?')
    await waitFor(async () => (await placeholder()) === SUGGESTION, 4000)
    const askedBefore = asked.length
    stub.script([{ type: 'token', payload: { delta: '干活中…' } }, { type: '__hold' }])
    await ta.click()
    await ta.fill('开始吧')
    await win.keyboard.press('Enter')
    await waitFor(() => win.locator('.t2c-stop').count().then((n) => n > 0))
    const held = stub.seen.runs.at(-1)?.runId
    await ta.fill('我先打着下一句') // 这一轮还没结束,用户已经在打下一句
    stub.finish(held, [{ type: 'done', payload: { content: '干活中…干完了' } }])
    await waitFor(() => win.locator('.t2c-stop').count().then((n) => n === 0))
    await win.waitForTimeout(900)
    check('输入框里已经有字的那一轮不拉建议', asked.length === askedBefore, `请求 ${askedBefore} → ${asked.length}`)
    await ta.fill('')
    await win.waitForTimeout(200)
    check('新一轮起跑后,上一轮的建议已作废', (await placeholder()) === basePlaceholder && !(await flagged()), JSON.stringify(await placeholder()))
  } finally {
    await app.close().catch(() => {})
    try { stub.close() } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过` + (NEGATIVE_CONTROL ? '(负对照:没开开关,「开着」之后的断言应转红)' : `;截图 ${SHOTS.light} / ${SHOTS.dark}`))
  if (NEGATIVE_CONTROL) process.exit(failed.length >= 3 ? 0 : 1)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
