/**
 * 设置 → 模型 → 分组与显示:每模型「上下文窗口」本机覆盖(2026-09-11)。桩引擎,无需真后端。
 *   npm run e2e:ctxwindow [-- <截图目录>]     需先 npm run build(读 out/main/main.js)
 * 断言:云端/本地行都有输入框;占位符=引擎解析值、悬浮标出来源;填值 → PUT /agent/models/overrides →
 * 刷新后持有值;填 272(把 K 当 token)只报行内错不打后端;清空 → PUT null 回自动;直连模型按完整 id 覆盖;无横向溢出。
 * 截图落到 <截图目录>(缺省 os.tmpdir()/forsion-ctxwindow-shots),交付前看一眼 ctxwindow-1-initial.png。
 */
const fs = require('fs'), os = require('os'), path = require('path')
const ROOT = path.resolve(__dirname, '..')
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-ctxwindow-shots-'))
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const fails = []
const check = (name, ok, extra) => { console.log((ok ? '✓ ' : '✗ ') + name + (extra ? '  ' + extra : '')); if (!ok) fails.push(name) }

async function main() {
  const auto = {} // modelId -> {contextWindow, contextWindowSource} 自动识别值(清除覆盖时回到它)
  const mk = (id, name, provider, win, src, extra = {}) => { auto[id] = { contextWindow: win, contextWindowSource: src }; return { id, name, provider, source: 'forsion', modelType: 'llm', contextWindow: win, contextWindowSource: src, supportsVision: true, ...extra } }
  const models = [
    mk('pr-4cbcb1891e630b889b329a3dd0a77df84c2406e0babae76e', 'GPT-6-Astra', 'external', 272000, 'family', { groupName: 'ChatGPT', groupSortOrder: 3, multiplier: 5.25 }),
    mk('claude-opus-5', 'Claude Opus 5', 'external', 1000000, 'family', { groupName: 'Claude', groupSortOrder: 1 }),
    mk('Auto', 'Auto', 'siliconflow', 272000, 'default'),
    mk('qwen3.8-flash', 'qwen3.8-flash', 'external', 272000, 'default'),
  ]
  const direct = { ...mk('codex/gpt-5.6-sol', 'gpt-5.6-sol', 'codex', 272000, 'family'), source: 'direct' }
  models.push(direct)
  const puts = []
  const stub = await startStubEngine({
    sessions: [], messages: [], models,
    directProviders: [{ providerId: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', modelIds: ['gpt-5.6-sol'] }],
    handle: async ({ path: p, method, body }) => {
      if (p === '/agent/models/overrides' && method === 'PUT') {
        body = typeof body === 'function' ? await body() : body
        if (typeof body === 'string') body = JSON.parse(body || '{}')
        puts.push(body)
        const m = models.find((x) => x.id === body.modelId)
        if (!m) return { __code: 400, body: { detail: 'unknown' } }
        if (body.contextWindow == null) Object.assign(m, auto[m.id])
        else if (!(body.contextWindow >= 4000)) return { __code: 400, body: { detail: 'contextWindow is in tokens: minimum 4000' } }
        else Object.assign(m, { contextWindow: body.contextWindow, contextWindowSource: 'override' })
        return { overrides: Object.fromEntries(models.filter((x) => x.contextWindowSource === 'override').map((x) => [x.id, { contextWindow: x.contextWindow }])) }
      }
    },
  })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-ctxwin-'))
  const app = await electron.launch({ args: ['--user-data-dir=' + path.join(home, 'userdata'), '--lang=zh-CN', ROOT], cwd: ROOT, env: Object.assign({}, process.env, { TANGU_HOME: home, TANGU_BACKEND_URL: stub.url }) })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 40000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) { const b = win.locator('text=' + label).first(); if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break } }
    await win.waitForSelector('.dv-groupview', { timeout: 40000 })
    await win.waitForTimeout(1000)
    await win.keyboard.press('Meta+Comma')
    await win.waitForSelector('.settings-nav', { timeout: 10000 })
    const navText = await win.locator('.settings-nav-list').innerText().catch(() => '')
    const parent = win.locator('.settings-nav-parent > button', { hasText: /^\s*模型/ }).first()
    if (!(await parent.count())) throw new Error('nav has no 模型 parent; nav text=\n' + navText)
    await parent.click()
    await win.waitForTimeout(500)
    await win.locator('.settings-nav-subitem', { hasText: '分组与显示' }).first().click()
    await win.waitForTimeout(900)
    await win.locator('.model-catalog-cloud summary').first().click() // 展开云端模型
    await win.waitForTimeout(500)
    const rows = win.locator('.model-catalog-model')
    check('T1 云端 + 本地模型行都渲染了窗口输入框', (await win.locator('.model-catalog-ctx input').count()) === 5, 'count=' + (await win.locator('.model-catalog-ctx input').count()))
    const astra = win.locator('.model-catalog-ctx input[aria-label*="GPT-6-Astra"]').first()
    check('T2 未覆盖时占位符 = 自动识别值 272000、值为空', (await astra.getAttribute('placeholder')) === '272000' && (await astra.inputValue()) === '', 'ph=' + (await astra.getAttribute('placeholder')))
    check('T3 悬浮标题标出来源(族表推断)', /族/.test((await astra.locator('..').getAttribute('title')) || ''), 'title=' + (await astra.locator('..').getAttribute('title')))
    await win.screenshot({ path: path.join(OUT, 'ctxwindow-1-initial.png') })
    // 填 500000 回车 → PUT → 刷新后输入框持有值
    await astra.fill('500000'); await astra.press('Enter'); await win.waitForTimeout(1200)
    check('T4 保存发了 PUT {modelId, contextWindow:500000}', puts.length === 1 && puts[0].modelId.startsWith('pr-4cbc') && puts[0].contextWindow === 500000, JSON.stringify(puts))
    const astra2 = win.locator('.model-catalog-ctx input[aria-label*="GPT-6-Astra"]').first()
    check('T5 刷新后输入框显示覆盖值 500000、来源=override', (await astra2.inputValue()) === '500000' && (await astra2.getAttribute('data-source')) === 'override', 'val=' + (await astra2.inputValue()))
    await win.screenshot({ path: path.join(OUT, 'ctxwindow-2-overridden.png') })
    // 负例:填 272 → 本地报错、不发请求
    const opus = win.locator('.model-catalog-ctx input[aria-label*="Claude Opus 5"]').first()
    await opus.fill('272'); await opus.press('Enter'); await win.waitForTimeout(600)
    check('T6 填 272(把 K 当 token)→ 行内报错且不打后端', puts.length === 1 && (await win.locator('.model-catalog-ctx small[role="alert"]').count()) === 1, 'puts=' + puts.length)
    await win.screenshot({ path: path.join(OUT, 'ctxwindow-3-invalid.png') })
    // 清空 → PUT null → 回到自动值
    await astra2.fill(''); await astra2.press('Enter'); await win.waitForTimeout(1200)
    const astra3 = win.locator('.model-catalog-ctx input[aria-label*="GPT-6-Astra"]').first()
    check('T7 清空 → PUT contextWindow:null → 占位符回到 272000、值空', puts.length === 2 && puts[1].contextWindow === null && (await astra3.inputValue()) === '' && (await astra3.getAttribute('data-source')) === 'family', JSON.stringify(puts[1]))
    // 本地(direct)模型也可覆盖
    const sol = win.locator('.model-catalog-ctx input[aria-label*="gpt-5.6-sol"]').first()
    await sol.fill('1050000'); await sol.press('Enter'); await win.waitForTimeout(1200)
    check('T8 直连模型按完整 id 覆盖', puts.length === 3 && puts[2].modelId === 'codex/gpt-5.6-sol' && puts[2].contextWindow === 1050000, JSON.stringify(puts[2]))
    // 视觉:输入框不把行撑破(行高、无横向溢出)
    const box = await win.locator('.model-catalog-settings').first().boundingBox()
    const sw = await win.evaluate(() => { const el = document.querySelector('.model-catalog-settings'); return el ? el.scrollWidth - el.clientWidth : -1 })
    check('T9 设置区无横向溢出', sw <= 0, 'overflow=' + sw + ' box=' + JSON.stringify(box))
  } catch (e) {
    console.error('BODY ERROR:', e && e.stack || e); fails.push('body threw')
  } finally {
    await app.close().catch(() => {})
    try { await stub.close?.() } catch {}
  }
  console.log('screenshots →', OUT)
  console.log(fails.length ? `\n${fails.length} 项失败` : '\n全部通过')
  process.exit(fails.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
