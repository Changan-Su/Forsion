/** Real Electron + managed engine + disk; optional CU_BUNDLE uses the real Computer Use plugin. */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs')
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'outputs/plugin-secret')
async function until(check, label) {
  const end = Date.now() + 60000
  while (!await check()) { assert(Date.now() < end, `Timed out: ${label}`); await new Promise(r => setTimeout(r, 150)) }
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-plugin-secret-')), userData = path.join(home, 'userdata')
  const id = process.env.CU_BUNDLE ? 'computer-use' : 'secret-fixture'
  const dir = path.join(home, 'tangu/plugins', id)
  fs.mkdirSync(dir, { recursive: true })
  if (process.env.CU_BUNDLE) fs.cpSync(path.join(process.env.CU_BUNDLE, 'tangu-plugins/computer-use'), dir, { recursive: true })
  else {
    fs.writeFileSync(path.join(dir, 'tangu-plugin.json'), JSON.stringify({ id, name: 'Secret fixture', version: '1.0.0', apiVersion: 1, entry: 'index.mjs' }))
    const fields = [{ key: 'jev_api_url', type: 'text', label: 'Jev API 地址', labelEn: 'Jev API URL' }, { key: 'jev_api_key', type: 'text', secret: true, label: 'Jev API 密钥', labelEn: 'Jev API key' }]
    fs.writeFileSync(path.join(dir, 'index.mjs'), `export default {activate(ctx){ctx.registerPlugin(${JSON.stringify({ id, name: 'Secret fixture', description: 'Test', settings: { fields } })})}}`)
  }
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ plugins: { global: { [id]: { __enabled: true } } } }), { mode: 0o600 })
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
    const openSettings = async () => {
      await win.evaluate(id => window.tangu.openFloatingPanel({ id: 'settings', title: '设置', builtin: 'settings', params: { tab: `plugin:${id}`, nonce: Date.now() } }), id)
      let settings
      await until(async () => { settings = app.windows().find(w => !w.isClosed() && w.url().includes('window=floating')); return !!settings }, 'settings window')
      await settings.getByRole('textbox', { name: /^Jev API (地址|URL)$/ }).waitFor()
      return settings
    }
    const config = () => JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).plugins.global[id]
    let page = await openSettings()
    const url = 'https://api.typesafe.ai/v1/systemone', key = 'jev-e2e-dummy-key'
    await page.getByRole('textbox', { name: /^Jev API (地址|URL)$/ }).fill(url)
    await page.locator('input[type="password"]').fill(key)
    await page.locator('input[type="password"]').blur()
    await until(() => config().jev_api_key === key && config().jev_api_url === url, 'settings written to disk')
    assert.equal(await page.locator('input[type="password"]').count(), 1)
    assert(!(await page.locator('body').innerText()).includes(key), 'key must not appear in visible text')
    assert.equal(fs.statSync(path.join(home, 'config.json')).mode & 0o777, 0o600)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: path.join(OUT, 'computer-use-settings.png') })
    await page.close(); page = await openSettings()
    await until(async () => await page.locator('input[type="password"]').inputValue() === key, 'saved key reloaded')
    await page.locator('input[type="password"]').fill(''); await page.locator('input[type="password"]').blur()
    await until(() => config().jev_api_key === '', 'key cleared on disk')
    console.log('PASS actual settings form: manual API/key, password masking, engine persistence (0600), reopen and clear; no Jev network request')
  } catch (e) {
    for (const [i, page] of (app?.windows() || []).entries()) {
      await page.screenshot({ path: path.join(OUT, `failure-${i}.png`) }).catch(() => {})
      fs.writeFileSync(path.join(OUT, `failure-${i}.txt`), await page.locator('body').innerText().catch(() => 'closed'))
    }
    throw e
  } finally { await app?.close().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }) }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
