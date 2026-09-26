/** Real Electron, isolated home + stub model catalog. No login or permission grants. */
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.join(__dirname, '..')
const OUT = process.env.ONBOARDING_SHOTS || '/tmp/forsion-onboarding-review'
const results = []
async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-onboarding-'))
  const models = [
    ...Array.from({ length: 14 }, (_, i) => ({ id: `cloud-${i}`, name: ['GPT-5.4', 'Claude Sonnet 4.6', 'Gemini 3.1 Pro', 'Qwen 3.5', 'DeepSeek V3.2', 'GPT-5 mini'][i % 6] + (i > 5 ? ` · ${i}` : ''),
      provider: i < 7 ? 'OpenAI' : 'Anthropic', source: 'forsion', groupId: i < 7 ? 'daily' : 'reasoning', groupName: i < 7 ? '日常对话 / Everyday' : '深入思考 / Reasoning', groupSortOrder: i < 7 ? 0 : 1, modelType: 'llm' })),
    { id: 'local/qwen', name: 'Qwen local', provider: 'Ollama', source: 'direct', modelType: 'llm' },
    { id: 'local/hidden', name: 'Hidden model', provider: 'Ollama', source: 'direct', modelType: 'llm' },
    { id: 'image', name: 'Image-only model', provider: 'Image', source: 'forsion', modelType: 'image_gen' },
  ]
  const stub = await startStubEngine({ models })
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_CLOUD_URL: stub.url }, timeout: 45000 })
    const win = await app.firstWindow()
    win.setDefaultTimeout(15000)
    await win.waitForSelector('.ob-flow')
    const errors = []
    win.on('pageerror', (e) => errors.push(e.message))
    await win.evaluate(() => localStorage.setItem('forsion_model_picker_v1', JSON.stringify({ groups: [{ id: 'local', name: '本机模型 / Local' }], assignments: { 'local/qwen': 'local' }, hidden: ['local/hidden'] })))
    await win.reload()
    await win.waitForSelector('.ob-flow')
    async function size(width, height) {
      await app.evaluate(({ BrowserWindow }, dimensions) => { const w = BrowserWindow.getAllWindows().find((w) => w.isVisible()); w.setMinimumSize(360, 400); w.setContentSize(...dimensions) }, [width, height])
    }
    async function geometry(name, screenshot = true) {
      await win.locator('.ob-content').evaluate((el) => el.getAnimations().forEach((a) => a.finish()))
      const state = await win.evaluate(() => {
        const shell = document.querySelector('.ob-flow'), content = document.querySelector('.ob-content'), footer = document.querySelector('.ob-footer')
        const r = footer.getBoundingClientRect()
        return { step: shell.dataset.step, contentH: content.clientHeight, scrollH: content.scrollHeight, contentW: content.clientWidth, scrollW: content.scrollWidth,
          footerVisible: r.bottom <= innerHeight + 1 && r.top >= 0, shellOverflow: shell.scrollWidth > shell.clientWidth + 1 }
      })
      if (screenshot) await win.screenshot({ path: path.join(OUT, `${name}.png`) })
      results.push({ name, ...state })
      assert(state.footerVisible, `${name}: footer outside viewport`)
      assert(!state.shellOverflow && state.scrollW <= state.contentW + 1, `${name}: horizontal overflow ${JSON.stringify(state)}`)
      assert(state.scrollH <= state.contentH + 1, `${name}: page needs scrolling ${JSON.stringify(state)}`)
      console.log(`PASS ${name} (${state.contentH}px, no page scroll)`)
    }
    async function next() {
      const previous = await win.locator('.ob-flow').getAttribute('data-step')
      await win.locator('.ob-footer .btn.primary').click()
      await win.waitForFunction((step) => document.querySelector('.ob-flow')?.getAttribute('data-step') !== step, previous)
    }
    for (const locale of ['zh', 'en']) {
      await win.locator('.locale-seg button').nth(locale === 'zh' ? 0 : 1).click()
      for (const dimensions of [[1280, 800], [1024, 720], [900, 640]]) {
        await size(...dimensions)
        const prefix = `${locale}-${dimensions.join('x')}`
        await win.evaluate(() => { localStorage.removeItem('forsion_tangu_onboarding_done'); localStorage.removeItem('forsion_tangu_onboarding_version') })
        await win.reload(); await win.waitForSelector('.ob-flow')
        await geometry(`${prefix}-welcome`)
        await next(); await geometry(`${prefix}-connect`)
        await win.locator('.ob-connect-option').last().click(); await geometry(`${prefix}-byok`)
        await next(); await win.waitForSelector('.ob-model-choice')
        await geometry(`${prefix}-models`)
        assert.equal(await win.locator('.ob-model-groups button').count(), 4)
        await win.locator('.ob-model-groups button').last().click()
        assert.equal(await win.locator('.ob-model-option').count(), 1)
        assert.match(await win.locator('.ob-model-option').innerText(), /Qwen local/)
        await win.locator('.ob-model-option').click()
        await win.locator('.ob-model-search input').fill('does-not-exist')
        assert.equal(await win.locator('.ob-model-option').count(), 0)
        assert.match(await win.locator('.ob-model-selection').innerText(), /Qwen local/)
        await win.locator('.ob-model-search input').fill('')
        await next()
        assert.equal(await win.evaluate(() => window.tangu.getConfig().then((c) => c.modelId)), 'local/qwen')
        await geometry(`${prefix}-appearance`)
        await win.locator('.ob-sections button').nth(1).click(); await geometry(`${prefix}-colors`)
        await win.locator('.ob-sections button').nth(2).click(); await geometry(`${prefix}-font`)
        await next(); await geometry(`${prefix}-workspace`)
        await next()
        // 本机环境:探测是真跑 node/git/docker --version,等行出来再量 —— 量「检测中…」空态会假绿。
        await win.waitForSelector('.ob-env-tools .env-probe-row')
        assert((await win.locator('.env-probe-row').count()) >= 5, 'env step lists the probed tools')
        await geometry(`${prefix}-env`)
        if (locale === 'zh' && dimensions[0] === 1280) {
          // 换源即存盘,再重挂检测区(安装命令按检测时的源生成);存盘前选中态不许先翻过去。
          const china = win.locator('.ob-env-option').nth(1)
          await china.click()
          await win.waitForFunction(() => document.querySelectorAll('.ob-env-option')[1]?.getAttribute('aria-checked') === 'true')
          assert.equal(await win.evaluate(() => window.tangu.getConfig().then((c) => c.mirror)), 'china')
          await win.waitForSelector('.ob-env-tools .env-probe-row')
          await geometry(`${prefix}-env-china`)
          await win.locator('.ob-env-option').first().click()
          await win.waitForFunction(() => document.querySelectorAll('.ob-env-option')[0]?.getAttribute('aria-checked') === 'true')
          assert.equal(await win.evaluate(() => window.tangu.getConfig().then((c) => c.mirror)), 'default')
        }
        await next()
        if (await win.locator('.ob-flow[data-step="permissions"]').count()) {
          await win.waitForSelector('.desktop-permissions-section')
          await geometry(`${prefix}-permissions`)
          await win.locator('.ob-sections button').nth(1).click(); await geometry(`${prefix}-media`)
          await next()
        }
        await geometry(`${prefix}-done`)
      }
    }
    // Dark mode and narrow responsive surface, through the real preference path.
    await size(1024, 720)
    await win.reload(); await win.waitForSelector('.ob-flow'); await next(); await next(); await win.waitForSelector('.ob-model-choice'); await next()
    await win.locator('.ob-sections button').first().click()
    await win.locator('.ob-appearance-options .seg button').nth(1).click()
    await geometry('en-dark-appearance')
    await win.locator('.ob-footer .btn.ghost').first().click(); await win.waitForSelector('.ob-model-choice'); await geometry('en-dark-models')
    await win.locator('.ob-model-default').click(); await next()
    assert.equal(await win.evaluate(() => window.tangu.getConfig().then((c) => c.modelId)), '')
    await size(390, 844)
    await geometry('en-narrow-appearance')
    await win.locator('.ob-footer .btn.ghost').first().click(); await win.waitForSelector('.ob-model-choice'); await geometry('en-narrow-models')
    await size(1024, 720)
    await next(); await next(); await next()
    await win.waitForSelector('.ob-env-tools .env-probe-row')
    await size(390, 844)
    await geometry('en-narrow-env')
    await size(1024, 720)
    await next()
    if (await win.locator('.ob-flow[data-step="permissions"]').count()) await next()
    await next()
    await win.waitForSelector('.ob-flow', { state: 'detached' })
    assert.equal(await win.evaluate(() => localStorage.getItem('forsion_tangu_onboarding_done')), '1')
    assert.equal(errors.length, 0, errors.join('\n'))
    // 完成页指向「设置 → 常规设置 → 本机运行环境」:这个子页必须真的存在,且工具清单排在最前(2.11.4 埋在「连接」页底部没人找得到)。
    await win.locator('.ntf-close').evaluateAll((bs) => bs.forEach((b) => b.click())).catch(() => {})
    const opened = app.waitForEvent('window')
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma')
    const settings = await opened
    await settings.waitForLoadState('domcontentloaded')
    await settings.waitForSelector('.settings-main', { timeout: 30000 })
    const nav = settings.locator('.settings-nav')
    const runtimeLabel = await settings.evaluate(() => document.documentElement.lang?.startsWith('zh') ? '本机运行环境' : 'Local runtime')
    let entry = nav.getByRole('button', { name: runtimeLabel, exact: true })
    if (!(await entry.count())) await nav.getByRole('button', { name: /^(常规设置|General)$/ }).first().click()
    entry = nav.getByRole('button', { name: runtimeLabel, exact: true })
    await entry.first().click()
    await settings.waitForSelector('.settings-tools-panel .env-probe-row', { timeout: 30000 })
    const layout = await settings.evaluate(() => {
      const panels = [...document.querySelectorAll('.settings-sub .settings-panel')]
      return { first: panels[0]?.classList.contains('settings-tools-panel'), rows: document.querySelectorAll('.settings-tools-panel .env-probe-row').length,
        connProbe: !!document.querySelector('.settings-runtime-panel .env-probe') }
    })
    assert(layout.first && layout.rows >= 5 && !layout.connProbe, `settings runtime page: ${JSON.stringify(layout)}`)
    await settings.screenshot({ path: path.join(OUT, 'settings-runtime.png') })
    console.log(`PASS settings → general → ${runtimeLabel}: tools panel first (${layout.rows} rows)`)
    console.log(`PASS finish + persistence + no renderer errors; ${results.length} layout cases`)
  } finally {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))
    if (app) await app.close().catch(() => {})
    await stub.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
