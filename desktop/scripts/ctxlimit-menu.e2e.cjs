/**
 * 聊天框模型菜单的「上下文上限」(09-22):引擎把自动识别出的窗口封顶 272k,1M 模型在「高级」与「模型」之间多一行,
 * 选「最大」= 写本机 modelOverrides(与设置页窗口输入框同一个 PUT)。桩引擎,无需真后端。
 *   npm run e2e:ctxlimit [-- <截图目录>]     需先 npm run build(读 out/main/main.js)
 * 断言:1M 模型露出该行且显示 272k、位置在高级与模型之间;选「最大」→ PUT {modelId, contextWindow:1000000} → 行变 1M、勾到最大;
 * 选「默认」→ PUT null 回 272k;窗口不超上限的模型不露该行。
 * 会话里:run 的 context_info 带 ctxWindowMax → 进度环弹层多一行「模型最大 1M,默认只用到 272k」;会话里开到最大 → 环分母当场变 1M;
 * run 在飞时改上限 → 环仍按这一轮开跑时的 272k(那轮的窗口 / 压缩线不会变);引擎报 modelOverridesWritable=false → 不露这一行。
 */
const fs = require('fs'), os = require('os'), path = require('path')
const ROOT = path.resolve(__dirname, '..')
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-ctxlimit-shots-'))
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const fails = []
const check = (name, ok, extra) => { console.log((ok ? '✓ ' : '✗ ') + name + (extra ? '  ' + extra : '')); if (!ok) fails.push(name) }

async function main() {
  const auto = { contextWindow: 272000, contextWindowSource: 'family' } // 封顶后的自动值(清覆盖时回到它)
  const models = [
    { id: 'claude-opus-5', name: 'Claude Opus 5', provider: 'external', source: 'forsion', modelType: 'llm', supportsVision: true, ...auto, maxContextWindow: 1000000 },
    { id: 'Auto', name: 'Auto', provider: 'siliconflow', source: 'forsion', modelType: 'llm', supportsVision: true, contextWindow: 200000, contextWindowSource: 'default', maxContextWindow: 200000 },
  ]
  const puts = []
  const modelsMeta = { contextWindowCap: 272000, modelOverridesWritable: true } // 桩按引用读:用例中途改它,下次拉 /agent/models 生效
  const SESSION = {
    id: 's1', title: '上下文上限会话', summary: '', model_id: 'claude-opus-5', archived: false, emoji: null,
    agent_config: null, project_path: '/tmp/demo', project_name: 'demo',
    created_at: '2026-09-22 09:00:00', updated_at: '2026-09-22 09:00:00',
  }
  const stub = await startStubEngine({
    sessions: [SESSION], messages: [], models, modelsMeta,
    handle: async ({ path: p, method, body }) => {
      if (p !== '/agent/models/overrides' || method !== 'PUT') return undefined
      body = typeof body === 'function' ? await body() : body
      if (typeof body === 'string') body = JSON.parse(body || '{}')
      puts.push(body)
      const m = models.find((x) => x.id === body.modelId)
      if (!m) return { __code: 400, body: { detail: 'unknown' } }
      Object.assign(m, body.contextWindow == null ? auto : { contextWindow: body.contextWindow, contextWindowSource: 'override' })
      return { overrides: {} }
    },
  })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-ctxlimit-'))
  const app = await electron.launch({ args: ['--user-data-dir=' + path.join(home, 'userdata'), '--lang=zh-CN', ROOT], cwd: ROOT, env: Object.assign({}, process.env, { TANGU_HOME: home, TANGU_BACKEND_URL: stub.url }) })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 40000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) { const b = win.locator('text=' + label).first(); if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break } }
    await win.waitForSelector('.dv-groupview', { timeout: 40000 })
    await win.waitForTimeout(1000)

    const pill = win.locator('.model-pill-btn:visible').first()
    const menu = win.locator('.composer-menu--model')
    const ctxRow = menu.locator('[data-pane-trigger="context"]')
    const open = async () => { if (!(await menu.count())) { await pill.click(); await menu.waitFor({ timeout: 5000 }) } }

    await open()
    // 只取主面板的直接子行:折叠的高级区(辅助 / 生图 / 识图槽)也在 DOM 里
    const rowOrder = await menu.locator(':scope > .cm-row').evaluateAll((els) => els.map((e) => e.dataset.paneTrigger || (e.classList.contains('cm-advanced-toggle') ? 'advanced' : '?')))
    check('T1 1M 模型露出「上下文上限」行,显示 272k', (await ctxRow.count()) === 1 && /272k/.test(await ctxRow.innerText()), await ctxRow.innerText().catch(() => '(none)'))
    check('T2 该行位于「高级」与「模型」之间', JSON.stringify(rowOrder) === JSON.stringify(['advanced', 'context', 'model']), JSON.stringify(rowOrder))
    await ctxRow.click()
    await win.locator('.cm-sub[data-pane="context"]').waitFor({ timeout: 5000 })
    await win.waitForTimeout(500) // 子面板有 pop 入场动画:立刻截图会抓到半透明的中间帧,看着像被主页时钟压住
    await win.screenshot({ path: path.join(OUT, 'ctxlimit-1-menu.png') })

    await win.locator('.cm-sub[data-pane="context"] .menu-item', { hasText: '1M' }).click()
    await win.waitForTimeout(1000)
    check('T3 选「最大」→ PUT {modelId:claude-opus-5, contextWindow:1000000}', puts.length === 1 && puts[0].modelId === 'claude-opus-5' && puts[0].contextWindow === 1000000, JSON.stringify(puts))
    await open()
    await ctxRow.click()
    const maxActive = await win.locator('.cm-sub[data-pane="context"] .menu-item.active').innerText().catch(() => '')
    check('T4 刷新后行显示 1M、勾在「最大」', /1M/.test(await ctxRow.innerText()) && /最大/.test(maxActive), `row=${await ctxRow.innerText()} active=${maxActive}`)
    await win.waitForTimeout(500)
    await win.screenshot({ path: path.join(OUT, 'ctxlimit-2-max.png') })

    await win.locator('.cm-sub[data-pane="context"] .menu-item', { hasText: '默认' }).click()
    await win.waitForTimeout(1000)
    await open()
    check('T5 选「默认」→ PUT contextWindow:null → 行回到 272k', puts.length === 2 && puts[1].contextWindow === null && /272k/.test(await ctxRow.innerText()), JSON.stringify(puts[1]))

    // 换到窗口不超上限的模型:该行不露
    await menu.locator('[data-pane-trigger="model"]').click()
    await win.locator('.cm-sub[data-pane="model"] .menu-item', { hasText: 'Auto' }).click()
    await win.waitForTimeout(500)
    await open()
    check('T6 窗口不超上限的模型不露该行', (await ctxRow.count()) === 0)
    await win.keyboard.press('Escape')

    // ── 会话里:进度环弹层的封顶说明 + 开到最大后分母当场换(会话列表在 Tangu space 的侧栏)
    await win.locator('.rb-btn.rb-space[aria-label="Tangu"]').first().click()
    await win.waitForTimeout(1200)
    await win.locator('.t2s-srow', { hasText: '上下文上限会话' }).first().click({ timeout: 10000 })
    await win.waitForTimeout(1200)
    stub.script([
      { type: 'status', payload: { phase: 'context_info', ctxWindow: 272000, ctxWindowSource: 'family', ctxWindowMax: 1000000, compactAt: 255616, compactionEnabled: true, sections: [], files: [], filesTruncated: false, historyCount: 0, historyTokens: 0, modelId: 'claude-opus-5' } },
      { type: 'usage', payload: { prompt: 60000, total: 200 } },
      { type: 'token', payload: { delta: '好。' } },
    ])
    const ta = win.locator('.t2c-ta').first()
    for (let i = 0; i < 40 && !(await ta.isEnabled().catch(() => false)); i++) await win.waitForTimeout(500)
    await ta.click(); await ta.fill('你好'); await win.keyboard.press('Enter')
    await win.waitForTimeout(1800)
    const ringPop = async () => {
      await win.locator('.t2c-ctxring-btn').first().click()
      await win.waitForTimeout(500)
      const text = await win.locator('.t2c-ctxring.is-open .t2c-ctxring-pop').first().innerText().catch(() => '')
      return text
    }
    const pop1 = await ringPop()
    check('T7 被封顶的 1M 模型:环弹层写明「模型最大 1M,默认只用到 272k」,分母 272k', /模型最大 1M，默认只用到 272k/.test(pop1) && /\/ 272k tokens/.test(pop1), JSON.stringify(pop1.slice(0, 200)))
    await win.screenshot({ path: path.join(OUT, 'ctxlimit-3-ring.png') })
    await win.locator('.t2c-ctxring-btn').first().click() // 收起
    await win.waitForTimeout(300)
    await win.locator('.model-pill-btn:visible').first().click()
    await menu.waitFor({ timeout: 5000 })
    await ctxRow.click()
    await win.locator('.cm-sub[data-pane="context"] .menu-item', { hasText: '1M' }).click()
    await win.waitForTimeout(1000)
    await win.keyboard.press('Escape') // 模型菜单开着时进度环按设计收起(t2c-collapse-on-capsule-open)
    await win.waitForTimeout(400)
    const pop2 = await ringPop()
    check('T8 会话里开到最大 → 环分母当场变 1M、封顶说明消失(不等下一条消息)', puts.length === 3 && puts[2].contextWindow === 1000000 && /\/ 1M tokens/.test(pop2) && !/模型最大/.test(pop2), JSON.stringify(pop2.slice(0, 200)))
    await win.locator('.t2c-ctxring-btn').first().click() // 收起

    // run 在飞时改上限:先回默认,再起一个挂住的 run(__hold = 不补 done、连接不关,runningBySession 一直有值)
    await win.locator('.model-pill-btn:visible').first().click()
    await menu.waitFor({ timeout: 5000 })
    await ctxRow.click()
    await win.locator('.cm-sub[data-pane="context"] .menu-item', { hasText: '默认' }).click()
    await win.waitForTimeout(1000)
    await win.keyboard.press('Escape')
    stub.script([
      { type: 'status', payload: { phase: 'context_info', ctxWindow: 272000, ctxWindowSource: 'family', ctxWindowMax: 1000000, compactAt: 255616, compactionEnabled: true, sections: [], files: [], filesTruncated: false, historyCount: 2, historyTokens: 100, modelId: 'claude-opus-5' } },
      { type: 'usage', payload: { prompt: 70000, total: 100 } },
      { type: 'token', payload: { delta: '处理中…' } },
      { type: '__hold' },
    ])
    await ta.click(); await ta.fill('再来一轮'); await win.keyboard.press('Enter')
    await win.waitForTimeout(1500)
    await win.locator('.model-pill-btn:visible').first().click()
    await menu.waitFor({ timeout: 5000 })
    await ctxRow.click()
    await win.locator('.cm-sub[data-pane="context"] .menu-item', { hasText: '1M' }).click()
    await win.waitForTimeout(1000)
    await win.keyboard.press('Escape')
    await win.waitForTimeout(400)
    const pop3 = await ringPop()
    check('T9 run 在飞时改到最大 → 已发 PUT,但环仍按这一轮的 272k(不换分母)', puts.length === 5 && puts[4].contextWindow === 1000000 && /\/ 272k tokens/.test(pop3), `puts=${puts.length} pop=${JSON.stringify(pop3.slice(0, 120))}`)
    await win.locator('.t2c-ctxring-btn').first().click() // 收起

    // 引擎说写不了(桌面连外部 / 云端 worker):下一次拉到的 /agent/models 带 false,这一行就不露。
    // 不用 win.reload() 触发重拉:台架里重载后迟迟连不上桩(胶囊一直禁用),与本功能无关;这里借「选默认」那次重拉。
    modelsMeta.modelOverridesWritable = false
    await win.locator('.model-pill-btn:visible').first().click()
    await menu.waitFor({ timeout: 5000 })
    await ctxRow.click()
    await win.locator('.cm-sub[data-pane="context"] .menu-item', { hasText: '默认' }).click()
    await win.waitForTimeout(1000)
    check('T10 引擎报 modelOverridesWritable=false → 1M 模型也不露「上下文上限」', puts.length === 6 && (await ctxRow.count()) === 0 && (await menu.locator('[data-pane-trigger="model"]').count()) === 1, `puts=${puts.length} row=${await ctxRow.count()}`)
  } finally {
    await app.close().catch(() => {})
    try { stub.close?.() } catch { /* ignore */ }
  }
  console.log(`\n截图:${OUT}`)
  if (fails.length) { console.log(`FAIL ${fails.length}: ${fails.join(' | ')}`); process.exit(1) }
  console.log('PASS')
}
main().catch((e) => { console.error(e); process.exit(1) })
