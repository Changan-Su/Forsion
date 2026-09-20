/** 真 Electron × 假引擎：默认模型选择/保存、设置分区、本地分组/可见性、云端只读与标签倍率。先 npm run build。 */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.resolve(__dirname, '..')
const models = [
  { id: 'cloud-free', name: 'Cloud Preview', source: 'forsion', provider: 'openai', groupId: 'preview', groupName: '预览模型', groupSortOrder: 0, multiplier: 0, tags: [{ text: '限时免费', color: 'red' }] },
  { id: 'cloud-pro', name: 'Cloud Pro', source: 'forsion', provider: 'anthropic', groupId: 'pro', groupName: '常用模型', groupSortOrder: 1, multiplier: 0.79, tags: [{ text: '夜间折扣', color: 'blue' }] },
  { id: 'local/a', name: 'Local Alpha', source: 'direct', provider: 'Local API' },
  { id: 'local/b', name: 'Local Beta', source: 'direct', provider: 'Local API' },
].map(m => ({ ...m, modelType: 'llm', contextWindow: 128000 }))
const results = []
const check = (name, ok) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`) }
async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-model-catalog-'))
  const stub = await startStubEngine({ models, sessions: [{ id: 'catalog-session', title: '模型目录验证', summary: '', model_id: 'cloud-pro', archived: false, emoji: null, agent_config: null, project_path: '/tmp', project_name: 'tmp', created_at: '2026-09-11 00:00:00', updated_at: '2026-09-11 00:00:00' }], handle: async ({ path: p }) => p.endsWith('/runs') ? { runs: [] } : undefined })
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
    const win = await app.firstWindow()
    win.setDefaultTimeout(10000)
    const errors = []
    win.on('pageerror', e => errors.push(e.message))
    await win.setViewportSize({ width: 1440, height: 1000 })
    await win.waitForSelector('#root')
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) { const b = win.getByText(label, { exact: true }).first(); if (await b.count()) { await b.click(); break } }
    await win.evaluate(backendUrl => window.tangu.setConfig({ mode: 'external', backendUrl, token: 'model-catalog-fixture' }), stub.url)
    await win.reload()
    await win.waitForTimeout(1500)
    // 设置画在独立浮窗里(Floating Panel 化 2026-09-20):主窗只负责敲热键,面板 locator 一律走浮窗 page(sp)。
    // 主进程按面板 id 复用窗口 —— 已经开着时再敲热键**不会**有新 window 事件,所以先找现成的,别干等。
    let sp
    const settings = async (sub = '分组与显示') => {
      const live = app.windows().find((p) => !p.isClosed() && p.url().includes('window=floating'))
      const opened = live ? null : app.waitForEvent('window')
      await win.keyboard.press('Meta+Comma')
      sp = live || await opened
      await sp.waitForLoadState('domcontentloaded')
      if (!live) { sp.setDefaultTimeout(10000); sp.on('pageerror', e => errors.push(e.message)) }
      await sp.locator('.settings-nav').getByRole('button', { name: '模型', exact: true }).click()
      await sp.locator('.settings-nav').getByRole('button', { name: sub, exact: true }).click()
    }
    await settings('默认模型')
    const defaults = sp.locator('.model-defaults-panel')
    await defaults.waitFor()
    check('默认模型按用途使用四个紧凑选择器', await defaults.locator('.model-select-btn').count() === 4 && await defaults.locator('.menu-item,.model-group-body,.model-catalog-settings').count() === 0)
    await defaults.getByRole('button', { name: '对话与任务', exact: true }).click()
    await defaults.locator('.composer-menu').getByRole('button', { name: 'Local Alpha', exact: true }).click()
    await sp.waitForFunction(async () => (await window.tangu.getConfig()).modelId === 'local/a')
    check('选择主模型经 IPC 保存', await defaults.getByRole('button', { name: '对话与任务', exact: true }).innerText() === 'Local Alpha')
    await defaults.getByRole('button', { name: '对话与任务', exact: true }).click()
    await sp.waitForTimeout(600)
    await sp.screenshot({ path: path.join(os.tmpdir(), 'forsion-model-defaults-menu.png') })
    await defaults.locator('.composer-menu').getByRole('button', { name: /跟随服务默认/ }).click()
    await sp.waitForFunction(async () => !(await window.tangu.getConfig()).modelId)
    check('可恢复跟随服务默认', (await defaults.getByRole('button', { name: '对话与任务', exact: true }).innerText()).includes('跟随服务默认'))
    await sp.mouse.move(350, 80)
    await sp.waitForTimeout(400)
    await sp.screenshot({ path: path.join(os.tmpdir(), 'forsion-model-defaults.png') })
    await sp.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.setAttribute('data-mode', 'dark') })
    await sp.waitForTimeout(400)
    await sp.screenshot({ path: path.join(os.tmpdir(), 'forsion-model-defaults-dark.png') })
    await sp.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.setAttribute('data-mode', 'light') })
    await sp.locator('.settings-nav').getByRole('button', { name: '提供方', exact: true }).click()
    check('提供方专门管理连接，不包含分组编辑', await sp.getByText('API 连接', { exact: true }).isVisible() && await sp.locator('.model-catalog-settings,.model-defaults-panel').count() === 0)
    await sp.locator('.settings-nav').getByRole('button', { name: '语音', exact: true }).click()
    check('语音输入归入语音设置', await sp.getByText('语音输入用哪个模型', { exact: true }).isVisible())
    await sp.locator('.settings-nav').getByRole('button', { name: '分组与显示', exact: true }).click()
    await sp.waitForSelector('.model-catalog-settings')
    let section = sp.locator('.model-catalog-settings')
    await section.locator('details summary').click()
    // 「只读」= 不能改分组/可见性。⚠️ 09-11 起云端行**有**一个上下文窗口覆盖框(见 e2e:ctxwindow),
    // 所以不能再断言「一个 input 都没有」,只能要求所有 input 都是那个覆盖框、且没有下拉。
    const cloudInputs = await section.locator('.model-catalog-cloud input').count()
    const cloudCtxInputs = await section.locator('.model-catalog-cloud .model-catalog-ctx input').count()
    check('云端名册只读(除上下文窗口覆盖外无可编辑控件)且显示两个模型', await section.locator('.model-catalog-cloud .model-catalog-model').count() === 2 && await section.locator('.model-catalog-cloud select').count() === 0 && cloudInputs === cloudCtxInputs)
    check('云端显示彩色标签和 0.00x', (await section.locator('.model-catalog-cloud').innerText()).includes('0.00x') && await section.locator('.model-tag[data-color="red"]').count() === 1)
    await section.locator('form input').fill('写作')
    await section.getByRole('button', { name: '添加分组', exact: true }).click()
    const group = await section.locator('select').first().locator('option').last().getAttribute('value')
    await section.getByLabel('Local Alpha 的分组').selectOption(group)
    await section.getByLabel('显示 Local Beta', { exact: true }).uncheck()
    await section.locator('.model-catalog-group-editor input').fill('日常写作')
    await section.locator('form input').click()
    check('本地筛选和分组立即保存', await sp.evaluate(() => { const p = JSON.parse(localStorage.getItem('forsion_model_picker_v1')); return p.hidden.includes('local/b') && p.groups[0].name === '日常写作' && p.assignments['local/a'] === p.groups[0].id }))
    await sp.screenshot({ path: path.join(os.tmpdir(), 'forsion-model-catalog-settings.png') })
    const closed = sp.waitForEvent('close')   // 「返回应用」= closeSelf(),浮窗真的关掉;下一轮要重新开
    await sp.locator('.settings-back').click()
    await closed
    await win.reload()
    await win.waitForTimeout(2000)
    await settings()
    section = sp.locator('.model-catalog-settings')   // 换窗口了,老 locator 绑在已关闭的 page 上
    check('刷新后保留可见性与自定义分组', !(await section.getByLabel('显示 Local Beta', { exact: true }).isChecked()) && await section.locator('.model-catalog-group-editor input').inputValue() === '日常写作')
    const closed2 = sp.waitForEvent('close')
    await sp.locator('.settings-back').click()
    await closed2
    await win.waitForTimeout(1500)
    if (await win.locator('.t2s-srow', { hasText: '模型目录验证' }).count()) await win.locator('.t2s-srow', { hasText: '模型目录验证' }).first().click()
    await win.locator('.project-pill:visible').first().click()
    await win.locator('.project-menu-item', { hasText: 'tmp' }).first().click()
    await win.screenshot({ path: path.join(os.tmpdir(), 'forsion-model-catalog-chat-entry.png') })
    await win.locator('.model-pill-btn:visible').first().click()
    await win.locator('.model-pill-wrap .cm-model-row:visible').first().click()
    const menu = win.locator('.cm-sub[data-pane="model"]')
    await menu.waitFor()
    const text = await menu.innerText()
    console.log('Model menu:', text)
    check('选择器云端/本地分层、应用本地隐藏与分组', text.includes('Forsion 云端') && text.includes('本地') && text.includes('日常写作') && text.includes('Local Alpha') && !text.includes('Local Beta'))
    check('两个云端模型始终保留且倍率显示两位', text.includes('Cloud Preview') && text.includes('Cloud Pro') && text.includes('0.00x') && text.includes('0.79x'))
    check('倍率位于勾选之前', await menu.locator('.menu-item').first().evaluate(el => { const r = el.querySelector('.model-multiplier'), c = el.querySelector('.mi-check'); return !!r && !!c && !!(r.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) }))
    await win.waitForTimeout(600)
    await win.screenshot({ path: path.join(os.tmpdir(), 'forsion-model-catalog-picker.png') })
    await win.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.setAttribute('data-mode', 'dark') })
    await win.waitForTimeout(600)
    await win.screenshot({ path: path.join(os.tmpdir(), 'forsion-model-catalog-picker-dark.png') })
    check('无未捕获页面错误', errors.length === 0)
    if (errors.length) console.log(errors)
  } finally { if (app) await app.close().catch(() => {}); stub.close() }
  console.log(`${results.filter(r => r.ok).length}/${results.length} passed`)
  process.exitCode = results.some(r => !r.ok) ? 1 : 0
}
main().catch(e => { console.error(e); process.exitCode = 1 })
