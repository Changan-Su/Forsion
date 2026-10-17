/** 真 Electron × 假引擎：默认模型选择/保存(含「翻译」槽与云端的机器翻译模型)、设置分区、本地分组/可见性、云端只读与标签倍率。先 npm run build。 */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const electron = require('./lib/launch-electron.cjs')
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
  const stub = await startStubEngine({ models, modelsMeta: { translateModels: [{ id: 'qwen-mt', name: 'Qwen MT Flash', provider: 'bailian', apiModelId: 'qwen-mt-flash' }] }, sessions: [{ id: 'catalog-session', title: '模型目录验证', summary: '', model_id: 'cloud-pro', archived: false, emoji: null, agent_config: null, project_path: '/tmp', project_name: 'tmp', created_at: '2026-09-11 00:00:00', updated_at: '2026-09-11 00:00:00' }], handle: async ({ path: p }) => p.endsWith('/runs') ? { runs: [] } : undefined })
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
    const settings = async (sub = '模型库') => {
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
    await defaults.first().waitFor()
    // 方案 C(10-17):默认模型按对话 / 图像 / 语音 / 翻译四组,每槽一个选择器 + 来源标签;自选后行尾有「恢复跟随」
    const slotBtn = (name) => defaults.getByRole('button', { name, exact: true })
    const slots = ['聊天与任务', '后台任务', '图像识别', '图像生成', '朗读', '语音通话', '翻译']
    check('默认模型按四组列出各个槽', await defaults.count() === 4 && (await Promise.all(slots.map((l) => slotBtn(l).count()))).every((n) => n === 1) && await defaults.locator('.menu-item,.model-lib').count() === 0)
    const chatBtn = slotBtn('聊天与任务')
    check('聊天槽跟随时写明实际用的模型和来源', /跟随 ·\s*Cloud Preview/.test(await chatBtn.innerText()) && await chatBtn.locator('.model-tag[data-origin="cloud"]').count() === 1)
    const pickChat = async (name) => { await chatBtn.click(); await defaults.locator('.composer-menu').getByRole('button', { name, exact: true }).click(); await sp.waitForTimeout(300) }
    await pickChat('Local Alpha')
    check('选择主模型经 IPC 保存,按钮标出「自带 key」', /Local Alpha/.test(await chatBtn.innerText()) && await chatBtn.locator('.model-tag[data-origin="key"]').count() === 1)
    check('摘要条数出自选的项数', (await sp.locator('.model-defaults-summary').innerText()).includes('1 项自选'))
    await sp.getByRole('button', { name: '恢复跟随 · 聊天与任务', exact: true }).click()
    await sp.waitForTimeout(300)
    check('行尾按钮恢复跟随', /跟随 ·/.test(await chatBtn.innerText()) && await sp.getByRole('button', { name: '恢复跟随 · 聊天与任务', exact: true }).count() === 0)
    await pickChat('Local Alpha')
    await sp.locator('.model-defaults-summary').getByRole('button', { name: '全部恢复跟随', exact: true }).click()
    await sp.waitForTimeout(300)
    const afterReset = await chatBtn.innerText()
    await sp.locator('.model-defaults-summary').getByRole('button', { name: '撤销', exact: true }).click()
    await sp.waitForTimeout(300)
    check('全部恢复跟随可以撤销', /跟随 ·/.test(afterReset) && /Local Alpha/.test(await chatBtn.innerText()))
    await sp.getByRole('button', { name: '恢复跟随 · 聊天与任务', exact: true }).click()
    await sp.waitForTimeout(300)
    await chatBtn.click()
    check('选择器菜单底部能跳到模型库', await defaults.locator('.model-select-footer').getByRole('button', { name: '在模型库里管理' }).count() === 1)
    await sp.keyboard.press('Escape')
    // 「翻译」槽:不选 = 目录里有机器翻译模型就自动用它(没有才跟聊天模型);候选 = 对话模型 + 云端的机器翻译模型(后者只在这一行出现);选了落 config.json 的 models.translate
    const tr = slotBtn('翻译')
    check('翻译槽缺省 = 自动,写明是哪个机器翻译模型', /自动.*Qwen MT Flash/.test(await tr.innerText()))
    check('机器翻译模型不进对话模型的候选', await (async () => {
      await chatBtn.click()
      const n = await defaults.locator('.composer-menu').getByRole('button', { name: 'Qwen MT Flash', exact: true }).count()
      await sp.keyboard.press('Escape')
      return n === 0
    })())
    await tr.click()
    await sp.waitForTimeout(400)
    await sp.screenshot({ path: path.join(os.tmpdir(), 'forsion-model-defaults-translate-menu.png') })
    await defaults.locator('.composer-menu').getByRole('button', { name: 'Qwen MT Flash', exact: true }).click()
    await sp.waitForFunction(async () => (await window.tangu.getConfig()).translateModelId === 'qwen-mt')
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))
    check('翻译槽选中云端的机器翻译模型并落进 config.json 的 models.translate', /^Qwen MT Flash/.test(await tr.innerText()) && await tr.locator('.model-tag').innerText() === '翻译专用' && saved.models?.translate === 'qwen-mt')
    await sp.mouse.move(350, 80)
    await sp.waitForTimeout(400)
    await sp.screenshot({ path: path.join(os.tmpdir(), 'forsion-model-defaults.png') })
    await sp.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.setAttribute('data-mode', 'dark') })
    await sp.waitForTimeout(400)
    await sp.screenshot({ path: path.join(os.tmpdir(), 'forsion-model-defaults-dark.png') })
    await sp.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.setAttribute('data-mode', 'light') })
    await sp.locator('.settings-nav').getByRole('button', { name: '提供方', exact: true }).click()
    check('提供方专门管理连接，不包含分组编辑', await sp.getByText('API 连接', { exact: true }).isVisible() && await sp.locator('.model-lib,.model-defaults-panel').count() === 0)
    await sp.locator('.settings-nav').getByRole('button', { name: '语音', exact: true }).click()
    check('语音页只留本地识别模型,选模型在默认模型', await sp.getByText('本地语音识别', { exact: true }).isVisible() && await sp.locator('.model-defaults-panel').count() === 0)
    await sp.locator('.settings-nav').getByRole('button', { name: '模型库', exact: true }).click()
    let section = sp.locator('.model-lib')
    await section.waitFor()
    const kinds = section.locator('.model-lib-bar .seg button')
    check('模型库六类标签,对话类先显示', await kinds.count() === 6 && await section.locator('.model-lib-bar .seg button[aria-pressed="true"]').innerText().then((x) => x.startsWith('对话')))
    check('云端模型可以在本机隐藏但不能分组', await section.getByLabel('显示 Cloud Pro', { exact: true }).count() === 1 && await section.getByLabel('Cloud Pro 的分组').count() === 0)
    check('云端显示彩色标签和 0.00x', (await section.innerText()).includes('0.00x') && await section.locator('.model-tag[data-color="red"]').count() === 1)
    await section.getByRole('button', { name: '本地分组', exact: true }).click()
    await section.locator('form input').fill('写作')
    await section.getByRole('button', { name: '添加分组', exact: true }).click()
    const group = await section.getByLabel('Local Alpha 的分组').locator('option').last().getAttribute('value')
    await section.getByLabel('Local Alpha 的分组').selectOption(group)
    await section.getByLabel('显示 Local Beta', { exact: true }).click()
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
    section = sp.locator('.model-lib')   // 换窗口了,老 locator 绑在已关闭的 page 上
    await section.getByRole('button', { name: '本地分组', exact: true }).click()
    check('刷新后保留可见性与自定义分组', !(await section.getByLabel('显示 Local Beta', { exact: true }).isChecked()) && await section.locator('.model-catalog-group-editor input').inputValue() === '日常写作')
    const closed2 = sp.waitForEvent('close')
    await sp.locator('.settings-back').click()
    await closed2
    await win.waitForTimeout(1500)
    if (await win.locator('.t2s-srow', { hasText: '模型目录验证' }).count()) await win.locator('.t2s-srow', { hasText: '模型目录验证' }).first().click()
    await win.locator('.project-selector .project-pill:visible').first().click() // 同款药丸还有「运行位置」,只认项目那颗
    await win.waitForTimeout(300)
    // 项目菜单现在列的是引擎的项目表(假引擎没给),不一定有 tmp;没有就收起菜单接着测模型菜单
    const tmpItem = win.locator('.project-menu-item', { hasText: 'tmp' }).first()
    const localProject = (await tmpItem.count()) > 0
    if (localProject) await tmpItem.click(); else await win.keyboard.press('Escape')
    await win.screenshot({ path: path.join(os.tmpdir(), 'forsion-model-catalog-chat-entry.png') })
    await win.locator('.model-pill-btn:visible').first().click()
    await win.locator('.model-pill-wrap .cm-model-row:visible').first().click()
    const menu = win.locator('.cm-sub[data-pane="model"]')
    await menu.waitFor()
    const text = await menu.innerText()
    console.log('Model menu:', text)
    // 主页新对话没选本地项目 = 云端工作区,菜单只列云端模型(HomepageView 的既有规则);本地那半的隐藏 / 分组逻辑由 modelPickerPreferences.test 管
    if (localProject) check('选择器云端/本地分层、应用本地隐藏与分组', text.includes('Forsion 云端') && text.includes('本地') && text.includes('日常写作') && text.includes('Local Alpha') && !text.includes('Local Beta'))
    else console.log('SKIP 选择器云端/本地分层:项目菜单里没有 tmp,落在云端工作区')
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
