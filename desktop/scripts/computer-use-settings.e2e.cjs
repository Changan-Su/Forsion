/**
 * 「电脑操作」设置页好不好找(反馈 0c0cd24f:用户找不到严格后台开关):真 Electron + 托管引擎 + 真 Computer Use 引擎插件。
 * 钉住:它是「AI」组里紧挨「浏览器控制」的一级页、不再混在「扩展」组末尾;搜「严格后台」「Jev」直达;
 * 旧深链 plugin:computer-use 落到同一页;表单是插件自己的(看得到严格后台开关)。截图留在 outputs/computer-use-settings/。
 * Run: CU_BUNDLE=<Computer Use 捆绑包检出(先 npm run build)> npm run e2e:cusettings
 */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs')
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'outputs/computer-use-settings')
async function until(check, label, ms = 60000) {
  const end = Date.now() + ms
  while (!await check()) { assert(Date.now() < end, `Timed out: ${label}`); await new Promise(r => setTimeout(r, 150)) }
}
async function main() {
  const bundle = process.env.CU_BUNDLE
  assert(bundle && fs.existsSync(path.join(bundle, 'tangu-plugins/computer-use/dist/index.js')), 'CU_BUNDLE 要指向构建好的 Computer Use 捆绑包')
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-cu-settings-')), userData = path.join(home, 'userdata')
  fs.cpSync(path.join(bundle, 'tangu-plugins/computer-use'), path.join(home, 'tangu/plugins/computer-use'), { recursive: true })
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ plugins: { global: { 'computer-use': { __enabled: true } } } }), { mode: 0o600 })
  for (const ud of [userData, `${userData}-dev`]) {
    fs.mkdirSync(ud, { recursive: true })
    fs.writeFileSync(path.join(ud, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed', cloudUrl: 'http://127.0.0.1:9', unitHostEnabled: false }))
  }
  const env = { ...process.env, TANGU_HOME: home, TANGU_CLOUD_URL: 'http://127.0.0.1:9' }; delete env.TANGU_BACKEND_URL
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT, env, timeout: 60000 })
    const win = await app.firstWindow(); win.setDefaultTimeout(20000)
    await win.waitForSelector('#root'); await win.waitForTimeout(800)
    for (const label of ['跳过引导', 'Skip onboarding', 'Skip']) { const skip = win.getByRole('button', { name: label, exact: true }); if (await skip.count()) await skip.click() }
    await win.waitForSelector('.rb')
    await until(async () => (await win.evaluate(() => window.tangu.backendStatus())).state === 'ready', 'managed engine')
    const openSettings = async (tab, ready = true) => {
      for (const w of app.windows()) if (!w.isClosed() && w.url().includes('window=floating')) await w.close()
      await win.evaluate(tab => window.tangu.openFloatingPanel({ id: 'settings', title: '设置', builtin: 'settings', params: { tab, nonce: Date.now() } }), tab)
      let settings
      await until(async () => { settings = app.windows().find(w => !w.isClosed() && w.url().includes('window=floating')); return !!settings }, 'settings window')
      await settings.waitForSelector('.settings-nav-search input')
      if (ready) await settings.locator('.settings-body').getByText('严格后台（绝不抢前台）', { exact: true }).waitFor()
      return settings
    }
    const current = (page) => page.locator('.settings-nav-parent > button[aria-current="page"]').innerText()
    const navGroups = (page) => page.evaluate(() => [...document.querySelectorAll('.settings-nav-group')].map(g => ({
      head: g.querySelector('.settings-nav-grouphead')?.textContent?.trim(),
      items: [...g.querySelectorAll(':scope > .settings-nav-parent > button')].map(b => b.textContent.trim()),
    })))
    let page = await openSettings('computer-use')
    const groups = await navGroups(page)
    const ai = groups.find(g => g.head === 'AI'), ext = groups.find(g => g.head === '扩展')
    assert(ai && ai.items.indexOf('电脑操作') === ai.items.indexOf('浏览器控制') + 1, `「电脑操作」紧跟在 AI 组的「浏览器控制」后面:${JSON.stringify(groups)}`)
    assert(!ext?.items.includes('电脑操作') && !ext?.items.includes('Computer Use'), `「扩展」组里不再重复列一份:${JSON.stringify(ext)}`)
    assert.equal(await current(page), '电脑操作')
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: path.join(OUT, 'computer-use-page.png') })
    // 表单第一项就是严格后台(插件把常用项排在实验性的 Jev 前面)
    assert.equal((await page.locator('.settings-body .field').first().innerText()).split('\n')[0].trim(), '严格后台（绝不抢前台）')
    await page.locator('.settings-nav-parent > button[aria-current="page"]').evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.screenshot({ path: path.join(OUT, 'computer-use-nav.png') })
    // 设置搜索:从别的页搜具体设置项,点结果直达这一页
    for (const [query, id] of [['严格后台', 'strict-background'], ['Jev', 'jev']]) {
      page = await openSettings('general', false)
      await page.locator('.settings-nav-search input').fill(query)
      const row = page.locator(`[data-setting-result="${id}"]`)
      await row.waitFor()
      assert.match(await row.innerText(), /电脑操作/, '结果行写明在哪一页')
      if (id === 'strict-background') await page.screenshot({ path: path.join(OUT, 'search-strict-background.png') })
      await row.click()
      await page.locator('.settings-body').getByText('严格后台（绝不抢前台）', { exact: true }).waitFor()
      await page.locator('.settings-nav-search input').fill('')
      assert.equal(await current(page), '电脑操作', `搜「${query}」点结果落到电脑操作页`)
    }
    // 旧深链 plugin:computer-use(商店 / 插件列表的「打开设置」)落到同一个一级页
    page = await openSettings('plugin:computer-use')
    assert.equal(await page.locator('.settings-nav-parent > button[aria-current="page"]').innerText(), '电脑操作')
    console.log('PASS 电脑操作:AI 组紧挨浏览器控制的一级页;扩展组不重复;搜「严格后台」「Jev」直达;plugin:computer-use 深链落同一页')
  } catch (e) {
    for (const [i, page] of (app?.windows() || []).entries()) {
      await page.screenshot({ path: path.join(OUT, `failure-${i}.png`) }).catch(() => {})
      fs.writeFileSync(path.join(OUT, `failure-${i}.txt`), await page.locator('body').innerText().catch(() => 'closed'))
    }
    throw e
  } finally { await app?.close().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }) }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
