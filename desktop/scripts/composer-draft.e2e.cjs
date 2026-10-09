/**
 * 输入框草稿按会话存 —— 真 Electron × 真组件/store × 假引擎。
 *
 * 用户报的:在一个会话里打了没发的字,切到别的会话(或点「新对话」)被带了过去。钉住的契约:
 *  ① 切到别的会话 / 新对话,输入框是那边自己的(没写过就是空的);切回来,原先那份还在;
 *  ② 新对话的第一句发出去后,新对话那份清掉(会话是发送途中才建的,输入框那时已经换到新会话上);
 *  ③ 在草稿中间插字,光标不跳到末尾(草稿住在 store 里,输入框是受控的)。
 *
 * 需先 npm run build。用法:npm run e2e:composerdraft
 * 负对照:FORSION_E2E_ROOT=<没有这次改动的检出>/desktop node scripts/composer-draft.e2e.cjs —— ① ② 必须转红。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = process.env.FORSION_E2E_ROOT || path.join(__dirname, '..')
const SHOT = path.join(os.tmpdir(), 'forsion-composer-draft.png')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const session = (id, title) => ({
  id, title, summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/draft-demo', project_name: 'draft-demo',
  created_at: '2026-10-09 09:00:00', updated_at: '2026-10-09 09:00:00',
})

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error(`缺 ${ROOT}/out/main/main.js —— 先跑 npm run build`)
    process.exit(1)
  }
  const stub = await startStubEngine({
    sessions: [session('draft-a', '草稿甲'), session('draft-b', '草稿乙')], messages: [],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }],
  })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-composer-draft-'))
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
  })

  try {
    const win = await app.firstWindow({ timeout: 60_000 })
    await win.setViewportSize({ width: 1600, height: 900 })
    await win.waitForSelector('#root', { timeout: 30_000 })
    check('离开首启引导', await skipOnboarding(win))
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.evaluate((names) => {
      const b = [...document.querySelectorAll('button.rb-space')].find((x) => names.some((n) => (x.getAttribute('aria-label') || x.getAttribute('title') || x.textContent || '').includes(n)))
      if (b) b.click()
    }, ['Agent', 'Tangu'])
    await win.waitForTimeout(1500)
    if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) {
      await win.click('.dv-edge-left').catch(() => {})
      await win.waitForTimeout(700)
    }

    // 主区那个跟着侧栏走的聊天的输入框(侧栏聊天等别的承载面不算)
    const ta = win.locator('.t2-chat-view .t2c-ta:visible').first()
    const value = () => ta.inputValue({ timeout: 3000 })
    const open = async (title) => { await win.locator('.t2s-srow', { hasText: title }).first().click(); await win.waitForTimeout(500) }
    const newChat = async () => { await win.locator('[data-act="new-chat"]').first().click(); await win.waitForTimeout(500) }
    const type = async (text) => { await ta.click(); await ta.fill(text) }

    // ── ① 各会话各存各的 ──
    await open('草稿甲')
    await type('写给甲的半句')
    await open('草稿乙')
    check('切到另一个会话:输入框是空的', (await value()) === '', JSON.stringify(await value()))
    await type('乙的')
    await newChat()
    check('点「新对话」:输入框是空的', (await value()) === '', JSON.stringify(await value()))
    await type('新对话的第一句')
    await open('草稿甲')
    check('切回甲:半句还在', (await value()) === '写给甲的半句', JSON.stringify(await value()))

    // ── ③ 草稿中间插字,光标不跳 ──
    await ta.click()
    await ta.evaluate((el) => el.setSelectionRange(2, 2))
    await win.keyboard.type('XY')
    check('在草稿中间插字:落在光标处', (await value()) === '写给XY甲的半句', JSON.stringify(await value()))
    await win.screenshot({ path: SHOT })

    await open('草稿乙')
    check('切回乙:它那份还在', (await value()) === '乙的', JSON.stringify(await value()))
    await newChat()
    check('回到新对话:它那份还在', (await value()) === '新对话的第一句', JSON.stringify(await value()))

    // ── ② 新对话发第一句:会话发送途中才建,清的得是新对话那份 ──
    await ta.click()
    await win.keyboard.press('Enter')
    for (let t0 = Date.now(); !stub.seen.runs.length && Date.now() - t0 < 8000;) await win.waitForTimeout(150)
    check('第一句发出去了(建了会话、起了 run)', stub.seen.runs[0]?.message === '新对话的第一句', JSON.stringify(stub.seen.runs.map((r) => r.message)))
    await win.waitForTimeout(800)
    check('发完:新建的会话里输入框是空的', (await value()) === '', JSON.stringify(await value()))
    await newChat()
    check('再点「新对话」:没有把刚发的那句留在里面', (await value()) === '', JSON.stringify(await value()))
    await open('草稿甲')
    check('别的会话的草稿没被这次发送动到', (await value()) === '写给XY甲的半句', JSON.stringify(await value()))
  } finally {
    await app.close().catch(() => {})
    try { stub.close() } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过;截图 ${SHOT}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
