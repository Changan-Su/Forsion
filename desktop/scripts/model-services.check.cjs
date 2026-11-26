/**
 * check:modelservices —— 设置 › 模型 › 模型与服务(2026-11-26 方案 C2:提供方 + 模型库 + 联网搜索并成一页)的真 Electron 仪器。
 * 取代 check:providerpresets(旧「提供方」页的预设下拉随页一起没了;预设本身改在「添加连接」弹窗里,见 S4)。
 *
 *  S1 旧深链 model/m-providers 落到「模型与服务」;左栏「模型」下不再有「提供方」「联网搜索」;页顶有来源胶囊。
 *  S2 旧深链 model/m-websearch 落到同一页的「联网搜索」标签。
 *  S3 点连接胶囊开浮层:地址、Key 尾号、模型数;「重新检测」走 /agent/providers/test,状态变「已连接」。
 *  S4 「添加连接」:默认 OpenAI,名称被占用时顺延 openai-2;换 Anthropic 填好地址与原生协议、先前粘的 Key 清空不外发;粘 Key 后自动拉清单并检测。
 *  S5 下一步进「添加模型」:模型多时缺省「常用」;勾两个、点添加 → 连接和两个模型一起写进 config.json。
 *  S6 每行 ⋯:自带 Key 的对话模型有设默认 / 能看图 / 类型 / 移除;移除写盘;对话名单只剩一个时「移除」不可点。
 *  S7 英文界面:胶囊、弹窗没有中文残留。
 *  S8 设置搜索「脱敏」落到本页页底的脱敏卡(原在提供方页)。
 *
 * 跑:npx electron-vite build 之后 `npm run check:modelservices`。截图落 MSVC_SHOTS(缺省临时目录),交付前看一眼。
 * 隔离 userData / TANGU_HOME / HOME(导入本机配置会扫 ~/.claude、~/.codex、~/.cc-switch)+ 假引擎,不碰真实配置。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.resolve(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-model-services-'))
const shots = process.env.MSVC_SHOTS || path.join(home, 'shots')
fs.mkdirSync(shots, { recursive: true })
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  | ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeout = 8000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    try { if (await fn()) return true } catch { /* retry */ }
    await pause(80)
  }
  return false
}

const direct = (id, provider) => ({ id: `${provider}/${id}`, name: id, provider, source: 'direct', modelType: 'llm', contextWindow: 272000, contextWindowSource: 'model' })
const MODELS = [
  { id: 'Auto', name: 'Auto', provider: 'forsion', source: 'forsion', modelType: 'llm', groupId: 'auto', groupName: 'Auto', multiplier: 1 },
  direct('gpt-6.1', 'openai'), direct('gpt-6.1-mini', 'openai'), direct('deepseek-v4-pro', 'deepseek'),
]
const PROVIDERS = [
  { providerId: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-demo-openai-0001', modelIds: ['gpt-6.1', 'gpt-6.1-mini'] },
  { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-demo-deepseek-9a7c', modelIds: ['deepseek-v4-pro'], noVisionModelIds: ['deepseek-v4-pro'] },
]
// 「拉取模型」回 60 个(过了 40 个的门槛 → 弹窗缺省「常用」)
const UPSTREAM = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', ...Array.from({ length: 57 }, (_, i) => `claude-legacy-${i}`)]

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npx electron-vite build')
    process.exit(2)
  }
  const seen = { tests: [], fetches: [] }
  const stub = await startStubEngine({
    models: MODELS, modelsMeta: { defaultModelId: 'Auto', modelOverridesWritable: true, forsion: { status: 'ok' } },
    directProviders: PROVIDERS.map(({ apiKey, ...p }) => p),
    handle: async ({ path: p, body }) => {
      if (p === '/agent/providers/fetch-models') { seen.fetches.push(await body()); return { models: UPSTREAM.map((id) => ({ id })) } }
      if (p === '/agent/providers/test') { seen.tests.push(await body()); return { success: true, message: 'ok' } }
      // 脱敏卡挪到了本页页底:引擎报可写它才画,S8 核设置搜索能落到它
      if (p === '/agent/masking') return { writable: true, settings: { secrets: true, personal: false, action: 'mask' }, allow: [], recent: { values: 0, sessions: 0 } }
      return undefined
    },
  })
  const userdata = path.join(home, 'userdata')
  for (const dir of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }))
  }
  for (const d of ['fakehome', 'claude', 'codex']) fs.mkdirSync(path.join(home, d), { recursive: true })
  const cfgPath = path.join(home, 'config.json')
  fs.writeFileSync(cfgPath, JSON.stringify({ sandbox: 'auto', workspace: path.join(home, 'ws'), providers: PROVIDERS }))
  const savedProviders = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8')).providers || []
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, HOME: path.join(home, 'fakehome'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex'), TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
    })
    const main = await app.firstWindow()
    await main.waitForSelector('#root', { timeout: 40000 })
    check('前置 主窗已离开首启引导', await skipOnboarding(main))

    const floating = () => app.windows().filter((w) => !w.isClosed() && w.url().includes('window=floating')).pop()
    const look = async (mode, lang) => {
      await main.evaluate(([m, l]) => { localStorage.setItem('forsion_theme_pref', m); localStorage.setItem('tangu_locale', l) }, [mode, lang])
      const fl = floating()
      if (fl) await fl.close().catch(() => {})
      await main.reload({ waitUntil: 'domcontentloaded' })
      await main.waitForSelector('#root', { timeout: 30000 })
      await pause(1200)
    }
    const open = async (tab) => {
      const old = floating()
      if (old) { await old.close().catch(() => {}); await pause(300) }
      await main.evaluate((p) => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: p }), { tab, n: Date.now() })
      let fl
      await waitFor(async () => { fl = floating(); return !!fl && (await fl.locator('.settings-sub[data-settings-sub="m-display"]').count()) > 0 }, 30000)
      if (!fl) throw new Error('settings floating window missing')
      await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('window=floating')) w.setContentSize(1180, 860) })
      await fl.locator('.msvc-sources').waitFor({ timeout: 10000 })
      await pause(400)
      return fl
    }

    await look('light', 'zh')
    let fl = await open('model/m-providers')
    const nav = await fl.evaluate(() => [...document.querySelectorAll('.settings-nav-subitem')].map((b) => b.textContent.trim()))
    const chips = await fl.evaluate(() => [...document.querySelectorAll('.msvc-sources .msvc-chip')].map((b) => b.textContent.trim()))
    check('S1 旧深链 model/m-providers → 模型与服务;左栏没有提供方 / 联网搜索;有来源胶囊',
      nav.includes('模型与服务') && !nav.includes('提供方') && !nav.includes('联网搜索') && chips.includes('openai') && chips.includes('deepseek') && chips.some((c) => c.includes('添加连接')), { nav, chips })
    await fl.screenshot({ path: path.join(shots, 'page-light-zh.png') })

    // S3 连接浮层
    await fl.locator('.msvc-chip[data-provider="openai"]').click()
    await fl.locator('.msvc-pop [data-connection="openai"]').waitFor({ timeout: 5000 })
    const pop = (await fl.locator('.msvc-pop').innerText()) + ' ' + (await fl.locator('.msvc-pop input[type="password"]').getAttribute('placeholder'))
    const before = seen.tests.length
    await fl.locator('.msvc-pop button', { hasText: '重新检测' }).click()
    const tested = await waitFor(async () => (await fl.locator('.msvc-pop .msvc-stat.is-ok').count()) > 0, 6000)
    check('S3 连接浮层:地址 / Key 尾号 / 模型数;重新检测走引擎并变已连接',
      pop.includes('api.openai.com/v1') && pop.includes('0001') && pop.includes('2 个模型') && tested && seen.tests.length === before + 1 && seen.tests.at(-1)?.modelId === 'gpt-6.1',
      { pop: pop.replace(/\s+/g, ' ').slice(0, 160), lastTest: seen.tests.at(-1) })
    await fl.screenshot({ path: path.join(shots, 'popover-light-zh.png') })
    const dotOk = await fl.locator('.msvc-chip[data-provider="openai"] .msvc-dot.is-ok').count()
    check('S3b 检测通过后胶囊变绿点', dotOk === 1)
    await fl.keyboard.press('Escape'); await pause(200)

    // S4 添加连接
    await fl.locator('.msvc-chip-add').click()
    const dlg = fl.locator('.msvc-dialog')
    await dlg.waitFor({ timeout: 5000 })
    await dlg.locator('.msvc-adv').click()
    const nameOf = () => dlg.locator('.msvc-adv-fields input').first().inputValue()
    check('S4a 默认 OpenAI,名称被占用时顺延 openai-2', (await nameOf()) === 'openai-2', await nameOf())
    // 评审 P1:在 OpenAI 下粘的 Key 换到别家时要清掉,不能 700ms 后发给新的那家
    const fetchesBefore = seen.fetches.length
    await dlg.locator('input[type="password"]').fill('sk-openai-not-real')
    await dlg.locator('.msvc-pick .msvc-chip', { hasText: 'Anthropic' }).click(); await pause(1100)
    check('S4p 换服务时清空 Key,旧 Key 不发给新服务', (await dlg.locator('input[type="password"]').inputValue()) === '' && !seen.fetches.slice(fetchesBefore).some((f) => f.apiKey === 'sk-openai-not-real'), seen.fetches.slice(fetchesBefore))
    const anth = await dlg.evaluate((el) => ({ url: el.querySelectorAll('.msvc-adv-fields input')[1]?.value, proto: el.querySelector('.msvc-adv-fields select')?.value }))
    check('S4b 换 Anthropic:地址与原生协议', anth.url === 'https://api.anthropic.com/v1' && anth.proto === 'anthropic-messages', anth)
    await dlg.locator('input[type="password"]').fill('sk-ant-demo-not-real')
    const found = await waitFor(async () => (await dlg.locator('.msvc-stat.is-ok').count()) > 0, 8000)
    const lastFetch = seen.fetches.at(-1)
    check('S4c 粘 Key 后自动拉清单并检测(带原生协议)', found && lastFetch?.protocol === 'anthropic-messages' && seen.tests.at(-1)?.modelId === 'claude-opus-5-5', { lastFetch, lastTest: seen.tests.at(-1) })
    await fl.screenshot({ path: path.join(shots, 'add-connection-light-zh.png') })
    await dlg.locator('button', { hasText: '下一步' }).click()

    // S5 添加模型
    const md = fl.locator('.msvc-dialog')
    await md.locator('.msvc-models').waitFor({ timeout: 5000 })
    const rows = await md.locator('.msvc-model').count()
    const activeFilter = await md.locator('.seg button.active').nth(1).innerText()
    check('S5a 60 个模型时缺省「常用」,只列认得的 3 个', activeFilter.trim() === '常用' && rows === 3, { activeFilter, rows })
    await md.locator('.msvc-model', { hasText: 'claude-opus-5-5' }).locator('input').check()
    await md.locator('.msvc-model', { hasText: 'claude-sonnet-5-5' }).locator('input').check()
    await fl.screenshot({ path: path.join(shots, 'add-models-light-zh.png') })
    await md.locator('.msvc-dialog-foot button.primary').click()
    const wrote = await waitFor(() => savedProviders().some((p) => p.providerId === 'anthropic'), 8000)
    const anthSaved = savedProviders().find((p) => p.providerId === 'anthropic')
    check('S5b 连接和两个模型一起写盘(协议、Key 都在)', wrote && JSON.stringify(anthSaved?.modelIds) === JSON.stringify(['claude-opus-5-5', 'claude-sonnet-5-5']) && anthSaved?.protocol === 'anthropic-messages' && anthSaved?.apiKey === 'sk-ant-demo-not-real' && anthSaved?.baseUrl === 'https://api.anthropic.com/v1', anthSaved)

    // S6 每行 ⋯
    fl = await open('model/m-display')
    const rowMenu = async (name) => {
      const row = fl.locator('.model-lib-row', { has: fl.locator(`[title="openai/${name}"]`) })
      await row.locator('.model-lib-more').click()
      await fl.locator('.capability-menu').waitFor({ timeout: 4000 })
      return fl.evaluate(() => [...document.querySelectorAll('.capability-menu-items > button')].map((b) => ({ label: b.getAttribute('aria-label'), disabled: b.disabled })))
    }
    let items = await rowMenu('gpt-6.1-mini')
    const labels = items.map((i) => i.label)
    check('S6a 自带 Key 的对话模型:设默认 / 能看图 / 四种类型 / 移除', ['设为默认对话模型', '能看图', '类型：对话', '类型：朗读', '从 openai 移除'].every((l) => labels.includes(l)), labels)
    await pause(400) // 菜单淡入走完再拍
    await fl.screenshot({ path: path.join(shots, 'row-menu-light-zh.png') })
    await fl.locator('.capability-menu-items > button[aria-label="从 openai 移除"]').click()
    const removed = await waitFor(() => JSON.stringify(savedProviders().find((p) => p.providerId === 'openai')?.modelIds) === '["gpt-6.1"]', 8000)
    check('S6b 移除只改 openai 的对话名单', removed, savedProviders().find((p) => p.providerId === 'openai'))
    await pause(800)
    items = await rowMenu('gpt-6.1')
    const rm = items.find((i) => i.label === '从 openai 移除')
    check('S6c 对话名单只剩一个时「移除」不可点(空名单 = 任意模型放行)', rm?.disabled === true, rm)
    await fl.keyboard.press('Escape'); await pause(200)

    // S2 联网搜索标签(假引擎没有 /agent/websearch 时这一标签不出现,两种情况分别核)
    fl = await open('model/m-websearch')
    const wsTab = await fl.locator('.model-lib-bar [data-kind="websearch"]').count()
    if (wsTab) {
      const active = await fl.locator('.model-lib-bar [data-kind="websearch"].active').count()
      check('S2 旧深链 model/m-websearch → 联网搜索标签', active === 1 && (await fl.locator('.model-lib-websearch').count()) === 1)
      await fl.screenshot({ path: path.join(shots, 'websearch-light-zh.png') })
    } else {
      const llmActive = await fl.locator('.model-lib-bar .seg button.active').innerText()
      check('S2 引擎不报联网搜索时:深链落在模型与服务、不出空白标签', llmActive.includes('对话'), llmActive)
    }

    // S8 设置搜索「脱敏」→ 落到本页页底的脱敏卡(原在提供方页)
    fl = await open('model/m-display')
    await fl.locator('.settings-body').evaluate((el) => { el.scrollTop = 0 })
    await fl.locator('.settings-nav-search input').fill('脱敏')
    await fl.locator('[data-setting-result="masking"]').click()
    const maskSeen = await waitFor(() => fl.evaluate(() => {
      const el = document.querySelector('[data-setting-anchor="masking"]'), body = document.querySelector('.settings-body')
      if (!el || !body) return false
      const r = el.getBoundingClientRect(), b = body.getBoundingClientRect()
      return r.height > 0 && r.top < b.bottom && r.bottom > b.top
    }), 4000)
    const maskWhere = await fl.evaluate(() => ({ sub: document.querySelector('.settings-sub')?.getAttribute('data-settings-sub'), tall: document.querySelector('.settings-body').scrollHeight > document.querySelector('.settings-body').clientHeight + 40, top: document.querySelector('.settings-body').scrollTop }))
    check('S8 搜「脱敏」落到模型与服务页底的脱敏卡,卡在可视区', maskSeen && maskWhere.sub === 'm-display', maskWhere)
    await fl.locator('.settings-nav-search input').fill('')

    await look('dark', 'en')
    fl = await open('model/m-display')
    await fl.locator('.msvc-chip-add').click()
    await fl.locator('.msvc-dialog').waitFor({ timeout: 5000 })
    await fl.screenshot({ path: path.join(shots, 'add-connection-dark-en.png') })
    const text = (await fl.locator('.msvc-sources').innerText()) + (await fl.locator('.msvc-dialog').innerText()) + (await fl.locator('.model-lib-bar').innerText())
    check('S7 英文界面:胶囊、类型标签、添加连接弹窗没有中文', !/[一-鿿]/.test(text), text.replace(/\s+/g, ' ').slice(0, 200))
    await fl.keyboard.press('Escape'); await pause(200)
    await fl.screenshot({ path: path.join(shots, 'page-dark-en.png') })
  } catch (e) {
    check('运行', false, String(e && e.stack || e).slice(0, 600))
  } finally {
    await app?.close().catch(() => {})
    stub.close?.()
  }
  console.log(`\nshots: ${shots}`)
  const bad = results.filter((r) => !r.ok)
  console.log(bad.length ? `${bad.length} FAIL` : 'ALL PASS')
  process.exit(bad.length ? 1 : 0)
}
main()
