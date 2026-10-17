#!/usr/bin/env node
/**
 * 设置 → 模型 → 联网搜索(WebSearchSettings)的真 Electron 台架:与后台 core-models 夹具钉同一套语义。
 *   /agent/websearch* 由下面的有状态假引擎应答(PUT 按引擎的合并语义改状态、回脱敏配置;Key 'bad-key' 测试失败),
 *   其余 /agent/** 改道到桩引擎。钉:使用中按 order 排、↓ 一次 PUT 只带 {order, provider:'auto'}、撤销回原序、
 *   连接先拿草稿 Key 测(没过零 PUT、通过才写且插在 DuckDuckGo 前)、断开先 confirm。亮 / 暗两张截图。
 * 跑:npm run build && node ../../.claude/hooks/devlock.cjs run --vehicle=e2e -- npm run e2e:websearch
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = process.env.FORSION_E2E_ROOT || path.join(__dirname, '..')
const SHOT = (n) => path.join(os.tmpdir(), `forsion-websearch-${n}.png`)
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

// 假引擎:使用中 bocha → zhipu → DDG;DeepSeek 已连接但停用;Tavily 未连接
const ws = {
  provider: 'auto', bochaHasKey: true, tavilyHasKey: false, zhipuHasKey: true, deepseekHasKey: true, zhipuEngine: 'search_pro_quark',
  effectiveProvider: 'bocha', configured: true, order: ['bocha', 'zhipu', 'duckduckgo'],
  lastTests: { bocha: { ok: true, latencyMs: 412, resultCount: 3, at: 1 }, zhipu: { ok: false, latencyMs: 8000, error: 'timeout after 8s', at: 1 } },
}
const puts = [], tests = []
function wsPut(b) {
  puts.push(b)
  for (const p of ['bocha', 'tavily', 'zhipu', 'deepseek']) if (typeof b[p + 'ApiKey'] === 'string') ws[p + 'HasKey'] = b[p + 'ApiKey'] !== ''
  for (const k of ['provider', 'zhipuEngine']) if (b[k] !== undefined) ws[k] = b[k]
  if (Array.isArray(b.order)) ws.order = b.order
  ws.order = ws.order.filter((p) => p === 'duckduckgo' || ws[p + 'HasKey'])
  ws.effectiveProvider = ws.order[0] || 'none'
  return { success: true, config: structuredClone(ws) }
}
function wsTest(b) {
  tests.push(b)
  return b.apiKey === 'bad-key' ? { ok: false, provider: b.provider, latencyMs: 90, error: '401 invalid key' } : { ok: true, provider: b.provider, latencyMs: 123, resultCount: 5 }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error(`缺 ${ROOT}/out/main/main.js —— 先跑 npm run build`); process.exit(1) }
  const stub = await startStubEngine({ sessions: [], messages: [], models: [{ id: 'm1', name: 'Stub 甲', provider: 'stub', contextWindow: 128_000 }] })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-websearch-'))
  for (const dir of [path.join(home, 'userdata'), path.join(home, 'userdata-dev')]) {
    fs.mkdirSync(dir, { recursive: true })
    // ⚠️ 全新配置缺省是 external:设置里不出现「联网搜索」(本机端点才有)—— 必须显式 managed
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({
      mode: 'managed', backendUrl: stub.url, token: 'e2e', cloudUrl: 'http://127.0.0.1:9', sandbox: 'none', browserEnabled: false, modelId: 'm1', unitHostEnabled: false,
    }))
  }
  const fake = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      const out = req.url.startsWith('/agent/websearch/test') ? wsTest(body) : req.method === 'PUT' ? wsPut(body) : structuredClone(ws)
      const send = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)) }
      if (body.apiKey === 'slow-key') setTimeout(send, 800); else send() // 'slow-key':测试慢回,钉「测 Key 途中取消」
    })
  })
  await new Promise((r) => fake.listen(0, '127.0.0.1', r))
  const fakeUrl = `http://127.0.0.1:${fake.address().port}`
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_BROWSER_CDP: 'off', TANGU_HARNESS_QUIET: '1' },
  })
  try {
    // 设置是单独的窗口:路由挂在 context 上,两个窗口都吃。⚠️ 不能用 route.fulfill:在 Electron 的 file:// 渲染层里
    // 拿到的是 status 0(body 照有)→ request() 判 !ok 抛错,「联网搜索」小节不出现。改道到真 HTTP 假引擎(同桩引擎的走法)。
    await app.context().route('**/agent/**', async (route) => {
      const url = new URL(route.request().url())
      const to = url.pathname.startsWith('/agent/websearch') ? fakeUrl : stub.url
      await route.continue({ url: `${to}${url.pathname}${url.search}` })
    })
    const win = await app.firstWindow({ timeout: 60_000 })
    await win.waitForSelector('#root', { timeout: 30_000 })
    check('离开首启引导', await skipOnboarding(win))
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    const before = app.windows().length
    await win.locator('[title="设置"], [aria-label="设置"]').last().click()
    for (let i = 0; i < 40 && app.windows().length === before; i++) await win.waitForTimeout(250)
    const sw = app.windows().length > before ? app.windows()[app.windows().length - 1] : win
    await sw.waitForLoadState('domcontentloaded')
    if (process.env.WS_DEBUG) {
      sw.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 200)))
      sw.on('requestfailed', (r) => console.log('[reqfail]', r.url(), r.failure()?.errorText))
      console.log('[windows]', app.windows().length, sw === win ? 'same' : 'new', sw.url().slice(0, 100))
    }
    await sw.setViewportSize({ width: 1100, height: 900 }).catch(() => {})
    await sw.waitForTimeout(1200)
    const clicked = await sw.evaluate(() => {
      const el = [...document.querySelectorAll('button, [role="button"], a, li, div')].filter((e) => e.getBoundingClientRect().x < 300 && e.textContent.trim() === '模型').pop()
      if (el) { el.scrollIntoView({ block: 'center' }); el.click() }
      return !!el
    })
    const sub = sw.locator('.settings-nav-subitem', { hasText: '联网搜索' }).first()
    if (!(await sub.waitFor({ timeout: 15_000 }).then(() => true, () => false))) {
      await sw.screenshot({ path: SHOT('nav-miss') })
      const subs = await sw.evaluate(() => [...document.querySelectorAll('.settings-nav-subitem')].map((b) => b.textContent.trim()))
      throw new Error(`没出现「联网搜索」小节:clicked模型=${clicked} subs=${JSON.stringify(subs)} 截图 ${SHOT('nav-miss')}`)
    }
    await sub.click()
    await sw.waitForSelector('.wsc [data-ws-item]', { timeout: 10_000 })
    const list = () => sw.evaluate(() => ({
      use: [...document.querySelectorAll('.wsc [data-ws-item]')].map((x) => x.getAttribute('data-ws-item')).join(),
      off: [...document.querySelectorAll('.wsc [data-ws-off]')].map((x) => x.getAttribute('data-ws-off')).join(),
      undo: [...document.querySelectorAll('.wsc button')].some((b) => b.textContent.includes('撤销')),
    }))
    const l0 = await list()
    const stat = await sw.evaluate(() => ({ bocha: document.querySelector('.wsc [data-ws-item="bocha"] .wsc-stat').textContent, zhipu: document.querySelector('.wsc [data-ws-item="zhipu"] .wsc-stat').textContent }))
    check('载入:使用中按 order 排,未启用 = 已连接的 DeepSeek + 未连接的 Tavily,上次测试结果上屏', l0.use === 'bocha,zhipu,duckduckgo' && l0.off === 'tavily,deepseek' && stat.bocha.includes('412 ms') && stat.zhipu.includes('timeout'), JSON.stringify({ ...l0, ...stat }))
    await sw.locator('.wsc [data-ws-item="zhipu"] .wsc-row').hover()
    await sw.screenshot({ path: SHOT('rest') })

    await sw.locator('.wsc [data-ws-item="bocha"] [aria-label="下移"]').click()
    await sw.waitForFunction(() => document.querySelector('.wsc [data-ws-item]').getAttribute('data-ws-item') === 'zhipu', null, { timeout: 5000 }).catch(() => {})
    const l1 = await list()
    check('↓ 下移:一次 PUT,只带完整 order + provider:auto;列表换序并出现「撤销」', puts.length === 1 && JSON.stringify(puts[0]) === JSON.stringify({ order: ['zhipu', 'bocha', 'duckduckgo'], provider: 'auto' }) && l1.use === 'zhipu,bocha,duckduckgo' && l1.undo, JSON.stringify({ puts, ...l1 }))
    await sw.locator('.wsc button', { hasText: '撤销' }).click()
    await sw.waitForFunction(() => document.querySelector('.wsc [data-ws-item]').getAttribute('data-ws-item') === 'bocha', null, { timeout: 5000 }).catch(() => {})
    check('撤销:PUT 回原顺序', puts.length === 2 && JSON.stringify(puts[1].order) === JSON.stringify(['bocha', 'zhipu', 'duckduckgo']), JSON.stringify(puts[1]))

    // 测 Key 途中点取消:测试回来也不许写(Codex 评审 P2)
    await sw.locator('.wsc [data-ws-off="tavily"] button', { hasText: '连接' }).click()
    const key = sw.locator('.wsc [data-ws-off="tavily"] input[type="password"]')
    await key.fill('slow-key')
    await sw.locator('.wsc [data-ws-off="tavily"] button', { hasText: '连接并测试' }).click()
    await sw.waitForTimeout(150)
    await sw.locator('.wsc [data-ws-off="tavily"] button', { hasText: '取消' }).click()
    await sw.waitForTimeout(1200)
    check('测 Key 途中取消:测试回来也零 PUT,Tavily 仍未连接', puts.length === 2 && (await list()).off.includes('tavily'), JSON.stringify(puts.at(-1)))
    await sw.locator('.wsc [data-ws-off="tavily"] button', { hasText: '连接' }).click()
    await key.fill('bad-key')
    await sw.locator('.wsc [data-ws-off="tavily"] button', { hasText: '连接并测试' }).click()
    await sw.waitForSelector('.wsc [data-ws-off="tavily"] .wsc-err', { timeout: 5000 }).catch(() => {})
    const bad = await sw.evaluate(() => ({ err: (document.querySelector('.wsc [data-ws-off="tavily"] .wsc-err') || {}).textContent || '', val: document.querySelector('.wsc [data-ws-off="tavily"] input').value }))
    check('连接:草稿 Key 没通过 → 拿这个 Key 测 tavily、行内报原因 + 「仍然保存」、输入不丢、零 PUT', puts.length === 2 && tests.at(-1).provider === 'tavily' && tests.at(-1).apiKey === 'bad-key' && bad.err.includes('401') && bad.err.includes('仍然保存') && bad.val === 'bad-key', JSON.stringify(bad))
    await sw.screenshot({ path: SHOT('connect-fail') })
    await key.fill('tv-good')
    await sw.locator('.wsc [data-ws-off="tavily"] button', { hasText: '连接并测试' }).click()
    await sw.waitForSelector('.wsc [data-ws-item="tavily"]', { timeout: 5000 }).catch(() => {})
    check('连接:测试通过才写 —— PUT 带 Key + 插在 DuckDuckGo 前的 order + provider:auto', JSON.stringify(puts.at(-1)) === JSON.stringify({ tavilyApiKey: 'tv-good', order: ['bocha', 'zhipu', 'tavily', 'duckduckgo'], provider: 'auto' }), JSON.stringify(puts.at(-1)))

    await sw.locator('.wsc [data-ws-item="zhipu"] [aria-expanded]').click()
    const nPut = puts.length
    let dialog = ''
    sw.once('dialog', (d) => { dialog = d.message(); void d.dismiss() })
    await sw.locator('.wsc [data-ws-item="zhipu"] button', { hasText: '断开' }).click()
    await sw.waitForTimeout(300)
    check('断开先 confirm(点名智谱),拒绝即零 PUT', puts.length === nPut && dialog.includes('智谱'), dialog)
    await sw.screenshot({ path: SHOT('expand') })
    await sw.evaluate(() => { const r = document.documentElement; r.dataset.mode = 'dark'; r.classList.add('dark') })
    await sw.waitForTimeout(300)
    await sw.screenshot({ path: SHOT('expand-dark') })
  } finally {
    await app.close().catch(() => {})
    stub.close(); fake.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过;截图 ${SHOT('*')}`)
  process.exit(failed.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
