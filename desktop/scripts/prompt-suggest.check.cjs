/**
 * 输入建议(缺省开,2026-10-14 用户定)—— 真 Electron × 真组件/store × 可编剧假引擎。
 *
 * 钉住的产品契约:
 *  ① 缺省开:什么都没设过,一轮结束就向引擎拉一次(带上刚结束的 run),拿到的那句成了空输入框里的灰字(占位文字);
 *  ② 开关在 设置 → 高级 → 界面与会话,缺省勾着,「外观」页里没有它;取消勾选 → 已显示的灰字撤掉、
 *     下一轮一次都不拉;再勾上 → 照常;
 *  ③ Tab:那句进了输入框、没有发出去,光标在句尾;
 *  ④ 常驻(2026-10-13 用户定:和占位文字一样):Tab 采用后删空、打过字再删空、换 Space / 换会话 / 新开标签页再回来,
 *     灰字都还在;
 *  ⑤ 只有新一轮起跑才作废上一句;输入框里已经有字的那一轮照拉,删空就显示;
 *  ⑥ 这一轮跑着的时候切到别的会话,收尾照拉,切回来灰字在。
 *
 * 需先 npm run build。用法:npm run check:promptsuggest
 * 负对照:node scripts/prompt-suggest.check.cjs --nc(② 里关掉以后不再勾回来 → 之后「开着」的断言必须转红)。
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
  setting: path.join(os.tmpdir(), 'forsion-promptsuggest-setting.png'),
}
const SUGGESTION = '跑一下测试看看'
// 后两轮各回一句不一样的:证明显示的是「这一轮」的那句,不是上一轮留下的
const SUGGESTION_5 = '把结果贴给我'
const SUGGESTION_6 = '后台那一轮的下一句'
// 灰字末尾带「⇥ Tab」提示(10-23 用户:很多人不知道按 Tab 填入),与 tangu/messages.ts 的 input.suggestionTab 同步
const shown = (s) => `${s}　⇥ Tab 填入`
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const mkSession = (id, title) => ({
  id, title, summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/suggest-demo', project_name: 'suggest-demo',
  created_at: '2026-10-10 09:00:00', updated_at: '2026-10-10 09:00:00',
})
const SESSION = mkSession('suggest-s1', '输入建议验收')
const OTHER = mkSession('suggest-s2', '另一个会话')

async function waitFor(fn, ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

/** 点 Ribbon 上名字对得上(inAgent)/ 对不上(!inAgent)的第一个 Space。 */
async function clickSpace(win, inAgent) {
  await win.evaluate((want) => {
    const b = [...document.querySelectorAll('button.rb-space')].find((x) => /Agent|Tangu/.test(x.getAttribute('aria-label') || x.getAttribute('title') || x.textContent || '') === want)
    if (b) b.click()
  }, inAgent)
  await win.waitForTimeout(1500)
}

/** 同 queued-commands.e2e:切到 Agent Space → 侧栏切「会话」→ 点会话行。 */
async function openChatSession(win, title = SESSION.title) {
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await win.waitForTimeout(1000)
  await clickSpace(win, true)
  if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) {
    // 短超时:侧栏本来就开着时没有这个把手,缺省要白等 30 秒 —— 那一轮挂着的 run 会被拖到别的时间点上去
    await win.click('.dv-edge-left', { timeout: 1500 }).catch(() => {})
    await win.waitForTimeout(700)
  }
  const row = win.locator('.t2s-srow', { hasText: title }).first()
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
  let reply = SUGGESTION
  const holding = new Set() // 挂着没收尾的 run
  const stub = await startStubEngine({
    sessions: [SESSION, OTHER], messages: [],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }],
    // 桩的在飞列表恒空;挂着的 run 得照真引擎那样报「还在跑」,否则桌面 30 秒一次的看门狗会把它当成
    // 「引擎已经不跑了」提前收掉,那一轮的 done 再到就没人理(⑥ 第一版就是这么假红的)。
    override: async ({ path: p, method, url }) => {
      if (method !== 'GET' || p !== '/agent/runs') return undefined
      const sid = url.searchParams.get('session_id')
      return { runs: stub.seen.runs.filter((r) => r.sessionId === sid && holding.has(r.runId)).map((r) => ({ id: r.runId, status: 'running', assistant_message_id: null })) }
    },
    handle: async ({ path: p, method, body }) => {
      if (method === 'POST' && /^\/agent\/sessions\/[^/]+\/suggest$/.test(p)) {
        asked.push(await body())
        return { suggestion: reply, usage: { prompt: 1000, cached: 950, completion: 6 } }
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

    const ta = win.locator('.t2c-ta:visible').first()
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

    // ── ① 缺省开:什么都没设过,一轮结束就拉 ──
    await turn('先看看有哪些文件', '有 a.ts 和 a.test.ts。要我跑一下测试吗?')
    await waitFor(() => asked.length > 0, 4000)
    check('缺省开:一轮结束拉一次,带上刚结束的 run', asked.length === 1 && asked[0].run_id === stub.seen.runs.at(-1)?.runId, JSON.stringify(asked))
    await waitFor(async () => (await placeholder()) === shown(SUGGESTION), 4000)
    check('那句成了空输入框里的灰字', (await placeholder()) === shown(SUGGESTION) && (await flagged()) === 'true' && (await ta.inputValue()) === '', JSON.stringify(await placeholder()))

    // ── ② 设置 → 高级 → 界面与会话:缺省勾着;取消 / 再勾上(真点) ──
    // 设置是一扇单独的浮窗(另一个渲染进程):开关写的是共用的 localStorage,主窗每次现读、经 storage 事件撤灰字。
    await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'advanced/a-ui' } }))
    let fl
    await waitFor(async () => { fl = app.windows().find((w) => w.url().includes('window=floating')); return !!fl }, 15000)
    const box = fl ? fl.locator('[data-setting-anchor="prompt-suggest"] [role="switch"]').first() : null
    const found = !!box && await box.waitFor({ timeout: 30000 }).then(() => true, () => false)
    check('设置 → 高级 → 界面与会话里有「输入建议」,缺省勾着', found && await box.isChecked())
    if (found) {
      await fl.locator('[data-setting-anchor="prompt-suggest"]').scrollIntoViewIfNeeded().catch(() => {})
      await fl.screenshot({ path: SHOTS.setting }).catch(() => {})
      await box.click()
    }
    check('取消勾选 → 关', found && !(await box.isChecked()))
    await waitFor(async () => (await placeholder()) === basePlaceholder, 3000)
    check('关掉:已显示的灰字撤掉', (await placeholder()) === basePlaceholder && !(await flagged()), JSON.stringify(await placeholder()))
    const askedOff = asked.length
    await turn('还有呢', '没有了。要我跑一下测试吗?')
    await win.waitForTimeout(600)
    check('关着:一轮结束一次都不拉,占位文字照旧', asked.length === askedOff && (await placeholder()) === basePlaceholder && !(await flagged()), `请求 ${askedOff} → ${asked.length}`)
    if (found && !NEGATIVE_CONTROL) await box.click()
    check('再勾上 → 开', NEGATIVE_CONTROL || (found && await box.isChecked()))
    // 挪走以后「外观」页里不该再有这一行(用外观页自己的「明暗」行确认真的切过去了)
    await fl?.locator('.settings-nav-list button', { hasText: '外观' }).first().click().catch(() => {})
    await fl?.waitForTimeout(600)
    const inTheme = fl ? await fl.locator('[data-setting-anchor="prompt-suggest"]').count() : -1
    const themeShown = fl ? await fl.locator('[data-setting-anchor="color-mode"]').count() : 0
    check('「外观」页里没有这一行', themeShown > 0 && inTheme === 0, JSON.stringify({ themeShown, inTheme }))
    await fl?.close().catch(() => {})
    await win.bringToFront().catch(() => {})
    await win.waitForTimeout(500)

    const askedOn = asked.length
    await turn('那 a.ts 里有什么', 'a.ts 导出了一个 add 函数。要我跑一下测试吗?')
    await waitFor(() => asked.length > askedOn, 4000)
    const lastRun = stub.seen.runs.at(-1)?.runId
    check('开着:一轮结束拉一次,带上刚结束的 run', asked.length === askedOn + 1 && asked.at(-1)?.run_id === lastRun, JSON.stringify({ asked: asked.slice(askedOn), lastRun }))
    await waitFor(async () => (await placeholder()) === shown(SUGGESTION), 4000)
    check('又成了空输入框里的灰字', (await placeholder()) === shown(SUGGESTION) && (await flagged()) === 'true' && (await ta.inputValue()) === '', JSON.stringify(await placeholder()))

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
    // ── ④ 常驻:和平常的占位文字一样,输入框空了就在 ──
    const still = async (want = SUGGESTION) => (await placeholder()) === shown(want) && (await flagged()) === 'true' && (await ta.inputValue()) === ''
    const askedSticky = asked.length
    await ta.fill('')
    await win.waitForTimeout(200)
    check('Tab 采用后删空:灰字还在', await still(), JSON.stringify(await placeholder()))
    await ta.click()
    await win.keyboard.type('a')
    await win.keyboard.press('Backspace')
    await win.waitForTimeout(200)
    check('打过字再删空:灰字还在', await still(), JSON.stringify(await placeholder()))
    await clickSpace(win, false)
    await clickSpace(win, true)
    check('换到别的 Space 再回来:灰字还在', await still(), JSON.stringify(await placeholder()))
    await openChatSession(win, OTHER.title)
    check('另一个会话里没有这句(按会话存)', (await placeholder()) === basePlaceholder && !(await flagged()), JSON.stringify(await placeholder()))
    await openChatSession(win)
    check('换到另一个会话再回来:灰字还在', await still(), JSON.stringify(await placeholder()))
    await win.keyboard.press('Meta+t')
    await win.waitForTimeout(1200)
    await win.locator('.dv-tab', { hasText: SESSION.title }).first().click().catch(() => {})
    await win.waitForTimeout(800)
    check('新开一个标签页再切回来:灰字还在', await still(), JSON.stringify(await placeholder()))
    check('这些来回都没有多拉一次', asked.length === askedSticky, `请求 ${askedSticky} → ${asked.length}`)

    // ── ⑤ 只有新一轮起跑才作废上一句;输入框里有字的那一轮照拉,删空就显示 ──
    const hold = async (text) => {
      stub.script([{ type: 'token', payload: { delta: '干活中…' } }, { type: '__hold' }])
      await ta.click()
      await ta.fill(text)
      await win.keyboard.press('Enter')
      await waitFor(() => win.locator('.t2c-stop').count().then((n) => n > 0))
      const id = stub.seen.runs.at(-1)?.runId
      holding.add(id)
      return id
    }
    const finish = (id, content) => { holding.delete(id); return stub.finish(id, [{ type: 'done', payload: { content } }]) }
    const askedBefore = asked.length
    const held = await hold('开始吧')
    await win.waitForTimeout(300)
    // 运行中本来就不显示灰字;「起跑即作废」那条路径由 promptSuggest.test.ts 直接钉(subscribeRun),这里只看界面
    check('新一轮跑着:不显示上一轮的那句', (await placeholder()) !== shown(SUGGESTION) && !(await flagged()) && (await ta.inputValue()) === '', JSON.stringify(await placeholder()))
    await ta.fill('我先打着下一句') // 这一轮还没结束,用户已经在打下一句
    reply = SUGGESTION_5
    finish(held, '干活中…干完了')
    await waitFor(() => win.locator('.t2c-stop').count().then((n) => n === 0))
    await waitFor(() => asked.length > askedBefore, 4000)
    await win.waitForTimeout(500)
    check('输入框里已经有字的那一轮照拉(有字时藏着)', asked.length === askedBefore + 1 && !(await flagged()), `请求 ${askedBefore} → ${asked.length}`)
    await ta.fill('')
    await win.waitForTimeout(200)
    check('把字删空:显示的是这一轮的那句', await still(SUGGESTION_5), JSON.stringify(await placeholder()))

    // ── ⑥ 这一轮跑着的时候切到别的会话:收尾照拉,切回来灰字在 ──
    const askedBg = asked.length
    const bgRun = await hold('后台跑一轮')
    await openChatSession(win, OTHER.title)
    reply = SUGGESTION_6
    check('切走以后那一轮还挂着(没被提前收掉)', finish(bgRun, '干活中…后台跑完了'))
    await waitFor(() => asked.length > askedBg, 5000)
    check('不在眼前的会话收尾也拉一次,带上那一轮的 run', asked.length === askedBg + 1 && asked.at(-1)?.run_id === bgRun, JSON.stringify({ n: asked.length - askedBg, last: asked.at(-1), bgRun }))
    await win.waitForTimeout(500)
    await openChatSession(win)
    check('切回来:灰字在,是后台那一轮的那句', await still(SUGGESTION_6), JSON.stringify(await placeholder()))
  } finally {
    await app.close().catch(() => {})
    try { stub.close() } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过` + (NEGATIVE_CONTROL ? '(负对照:关掉以后没再勾回,「开着」之后的断言应转红)' : `;截图 ${SHOTS.light} / ${SHOTS.dark}`))
  if (NEGATIVE_CONTROL) process.exit(failed.length >= 3 ? 0 : 1)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
