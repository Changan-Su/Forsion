/** Real Electron settings + IPC in an isolated home. */
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'outputs', 'core-plugins')
const lang = process.argv.includes('--en') ? 'en' : 'zh'
const labels = lang === 'zh' ? { core: '核心插件', installed: '已安装插件', search: '搜索插件', check: '检查所有更新', about: '关于' } : { core: 'Core plugins', installed: 'Installed plugins', search: 'Search plugins', check: 'Check all updates', about: 'About' }
;(async () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'out/main/main.js')), 'Run npm run build first')
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-core-plugins-'))
  const plugin = path.join(home, 'plugins', 'market-probe'); fs.mkdirSync(plugin, { recursive: true })
  fs.writeFileSync(path.join(plugin, 'manifest.json'), JSON.stringify({ id: 'market-probe', name: 'Market Probe', version: '1.2.0', apiVersion: 1, description: 'Local installed plugin fixture' }))
  fs.writeFileSync(path.join(plugin, 'main.js'), 'ctx.registerSetting({ key: "probe", label: "Probe setting", type: "boolean", default: true })')
  const stub = await startStubEngine({ models: [{ id: 'test', name: 'Test', provider: 'stub', contextWindow: 128000, thinkingLevels: ['off'] }] })
  let app, panel
  try {
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, `--lang=${lang === 'zh' ? 'zh-CN' : 'en-US'}`, ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url }, timeout: 60000 })
    const win = await app.firstWindow()
    await win.waitForSelector('#root')
    await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'amadeus-plugins', n: Date.now() } }))
    for (let i = 0; i < 60 && !panel; i++) {
      for (const w of app.windows()) if (w.url().includes('window=floating') && await w.locator('.settings-page').count().catch(() => 0)) panel = w
      if (!panel) await win.waitForTimeout(250)
    }
    assert.ok(panel, 'settings panel opens'); panel.setDefaultTimeout(10000)
    await panel.locator('[data-plugin-section="core"]').waitFor()
    await panel.locator('[data-plugin-id="forsion-extend"]').waitFor()
    assert.equal(await panel.locator('[data-plugin-id="market-probe"]').count(), 0)
    assert.equal(await panel.locator('[data-plugin-id="amadeus-core"]').count(), 1)
    const initial = await panel.evaluate(() => window.tangu.getCorePluginUpdates())
    assert.ok(initial.items.some((item) => item.id === 'forsion-extend'))
    await panel.getByRole('button', { name: labels.check, exact: true }).click()
    const state = await panel.evaluate(() => window.tangu.getCorePluginUpdates())
    assert.ok(state.items.every((item) => item.phase === 'development'))
    for (const mode of ['light', 'dark']) {
      await panel.evaluate((mode) => { document.documentElement.dataset.mode = mode; document.documentElement.classList.toggle('dark', mode === 'dark') }, mode)
      await panel.screenshot({ path: path.join(OUT, `${lang}-core-${mode}.png`) })
    }
    await panel.getByRole('button', { name: labels.installed, exact: true }).click()
    await panel.locator('[data-plugin-id="market-probe"]').waitFor()
    assert.equal(await panel.locator('[data-plugin-id="forsion-extend"]').count(), 0)
    const search = panel.getByRole('searchbox', { name: labels.search })
    await search.fill('missing fixture')
    assert.equal(await panel.locator('[data-plugin-id="market-probe"]').count(), 0)
    await search.fill('Market Probe')
    await panel.locator('[data-plugin-id="market-probe"]').focus(); await panel.keyboard.press('Enter')
    await panel.locator('[data-plugin-detail="market-probe"]').waitFor()
    assert.ok(await panel.getByText('Probe setting', { exact: true }).count())
    await panel.locator('[data-plugin-back]').click(); await search.fill('')
    await panel.screenshot({ path: path.join(OUT, `${lang}-installed-dark.png`) })
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('window=floating')); w.setMinimumSize(420, 500); w.setSize(640, 720) })
    await panel.getByRole('button', { name: labels.core, exact: true }).click()
    await panel.locator('[data-plugin-section="core"]').waitFor()
    const overflow = await panel.evaluate(() => { const e = document.querySelector('.settings-main'); return { w: innerWidth, client: e.clientWidth, scroll: e.scrollWidth } })
    assert.ok(overflow.scroll <= overflow.client + 1, JSON.stringify(overflow))
    await panel.screenshot({ path: path.join(OUT, `${lang}-core-narrow.png`) })
    await panel.getByRole('button', { name: labels.about, exact: true }).click()
    await panel.locator('.core-plugin-updates').waitFor()
    console.log(`PASS ${lang}: classification, search, keyboard details, update IPC, about status and narrow layout; screenshots: ${OUT}`)
  } catch (e) {
    if (panel) { await panel.screenshot({ path: path.join(OUT, `${lang}-failure.png`) }).catch(() => {}); fs.writeFileSync(path.join(OUT, `${lang}-failure.txt`), await panel.locator('body').innerText().catch(() => '')) }
    throw e
  } finally { if (app) await app.close(); await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
})().catch((e) => { console.error(e); process.exitCode = 1 })
