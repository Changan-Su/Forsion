/** Real Electron + disk plugin + IPC + restart. Run after build; FORSION_APP_ROOT can point at an isolated build. */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.resolve(__dirname, '..')
const APP_ROOT = process.env.FORSION_APP_ROOT || ROOT
const OUT = path.join(ROOT, 'outputs/startup-appearance')
let checks = 0
function check(name, value) { assert.ok(value, name); console.log(`PASS ${name}`); checks++ }
async function appearance(page) {
  await page.locator('.settings-main').waitFor({ timeout: 30000 })
  await page.locator('.settings-nav button').filter({ hasText: /^(主题|外观|Theme|Appearance)$/ }).first().click()
  await page.locator('#startup-icon').waitFor()
  await page.locator('.startup-appearance').scrollIntoViewIfNeeded()
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-startup-e2e-'))
  const userdata = path.join(home, 'userdata')
  fs.cpSync(path.join(ROOT, '../tangu-agent/skills/forsion-plugin/samples/forsion-sample-appearance'), path.join(home, 'plugins/forsion-sample-appearance'), { recursive: true })
  const stub = await startStubEngine({ sessions: [], messages: [], models: [] })
  for (const dir of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }))
  }
  let app, win, settings
  const launch = async () => {
    app = await electron.launch({ args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', APP_ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
    win = await app.firstWindow()
    await win.waitForSelector('#root')
  }
  const openSettings = async () => {
    await win.waitForTimeout(2200)
    for (const label of ['跳过引导', 'Skip']) {
      const skip = win.getByRole('button', { name: label, exact: true })
      if (await skip.isVisible().catch(() => false)) await skip.click()
    }
    await win.locator('.dv-groupview').first().waitFor({ timeout: 30000 })
    await win.screenshot({ path: path.join(OUT, 'before-settings.png') })
    const opened = app.waitForEvent('window', { timeout: 20000 }).catch(() => null)
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma')
    settings = await opened
    if (!settings) throw new Error('Settings window did not open')
    await appearance(settings)
  }
  const installedPlugins = async () => {
    const installed = settings.getByRole('button', { name: /^(已安装插件|Installed plugins)$/, exact: true })
    if (!await installed.isVisible()) await settings.locator('.settings-nav').getByRole('button', { name: /^(插件|Plugins)$/, exact: true }).click()
    await installed.click()
  }
  try {
    await launch()
    await win.evaluate(() => localStorage.setItem('forsion_default_space', 'tangu'))
    await win.reload()
    await openSettings()
    const key = 'plugin:forsion-sample-appearance:orbit'
    await settings.waitForFunction((key) => !!document.querySelector(`#startup-icon option[value="${key}"]`), key)
    check('disk plugin contributes a selectable preset', true)
    await app.evaluate(({ app }) => {
      global.__appearanceIcons = []
      if (app.dock) {
        const setIcon = app.dock.setIcon.bind(app.dock)
        app.dock.setIcon = (icon) => { global.__appearanceIcons.push(icon.toDataURL()); return setIcon(icon) }
      }
    })
    await settings.selectOption('#startup-icon', key)
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    await settings.selectOption('#startup-splash', key)
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    await settings.selectOption('#startup-motion', 'pulse')
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    const diskPath = path.join(`${userdata}-dev`, 'startup-appearance.json')
    const stored = JSON.parse(fs.readFileSync(diskPath, 'utf8'))
    check('selection persisted as PNG icon and animated SVG startup artwork', stored.icon.image.startsWith('data:image/png') && stored.splash.image.startsWith('data:image/svg+xml') && stored.animation === 'pulse')
    await win.waitForFunction(() => [...document.querySelectorAll('img.brand-logo')].some((img) => img.src.startsWith('data:image/png')))
    check('settings window updates the main-window brand without reload', true)
    if (process.platform === 'darwin') check('real macOS Dock API received the selected icon', await app.evaluate(() => global.__appearanceIcons.some((url) => url.startsWith('data:image/png'))))
    const openedProbe = app.waitForEvent('window')
    await app.evaluate(async ({ BrowserWindow }, preload) => {
      global.__appearanceProbe = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: false } })
      await global.__appearanceProbe.loadURL('about:blank')
    }, path.join(APP_ROOT, 'out/preload/preload.mjs'))
    const probe = await openedProbe
    await settings.selectOption('#startup-motion', 'spin')
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    const replayed = await probe.evaluate(() => {
      let latest
      const off = window.tangu.startupAppearance.subscribe((value) => { latest = value })
      off()
      return latest?.animation
    })
    check('late renderer subscribers receive updates buffered by real preload', replayed === 'spin')
    await app.evaluate(() => global.__appearanceProbe.destroy())
    await settings.selectOption('#startup-motion', 'pulse')
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    const layout = await settings.locator('.startup-appearance').evaluate((el) => {
      const rect = el.getBoundingClientRect()
      const fonts = document.querySelector('.settings-theme-fonts').getBoundingClientRect()
      const select = el.querySelector('#startup-icon').getBoundingClientRect()
      const upload = el.querySelector('.startup-appearance-upload').getBoundingClientRect()
      const uploadIcon = el.querySelector('.startup-appearance-upload > svg').getBoundingClientRect()
      return { width: rect.width, fontsWidth: fonts.width, height: rect.height, afterFonts: rect.top >= fonts.bottom, inlineUpload: Math.abs(select.top + select.height / 2 - upload.top - upload.height / 2) < 2, uploadIconRatio: uploadIcon.width / uploadIcon.height }
    })
    check('startup settings occupy the full appearance column after fonts', Math.abs(layout.width - layout.fontsWidth) < 2 && layout.afterFonts)
    check('compact settings keep upload beside its picker without squeezing its icon', layout.height < 440 && layout.inlineUpload && Math.abs(layout.uploadIconRatio - 1) < 0.01)
    await settings.screenshot({ path: path.join(OUT, 'zh-light-context.png') })
    await settings.locator('.startup-appearance').screenshot({ path: path.join(OUT, 'zh-light.png') })
    const showSplash = settings.getByRole('switch', { name: '显示开屏', exact: true })
    await showSplash.focus(); await showSplash.press('Space')
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    check('startup switch works from the keyboard and persists', JSON.parse(fs.readFileSync(diskPath, 'utf8')).showSplash === false)
    await showSplash.click()
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    const nativeIcon = settings.getByRole('switch', { name: '同步到 Dock／任务栏', exact: true })
    await nativeIcon.click()
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    check('native icon switch persists independently', JSON.parse(fs.readFileSync(diskPath, 'utf8')).nativeIcon === false && JSON.parse(fs.readFileSync(diskPath, 'utf8')).showSplash === true)
    await nativeIcon.click()
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    const help = settings.locator('.startup-appearance-help summary')
    await help.focus(); await help.press('Enter')
    check('format and platform details remain keyboard accessible with a visible focus ring', await settings.locator('.startup-appearance-help').evaluate((el) => el.open) && await help.evaluate((el) => getComputedStyle(el).outlineStyle === 'solid'))
    await help.press('Enter')
    await settings.getByRole('button', { name: '预览开屏', exact: true }).click()
    const frame = settings.frameLocator('.startup-appearance-preview iframe')
    await frame.locator('.forsion-startup-image').waitFor()
    await settings.locator('.startup-appearance-preview').screenshot({ path: path.join(OUT, 'preview.png') })
    check('preview runs the actual startup runtime in an isolated frame', await frame.locator('.forsion-startup-image').count() === 1)
    await settings.getByRole('button', { name: '关闭预览', exact: true }).click()
    // Upload and bad-image failure go through the real file input and image decoder.
    const input = settings.locator('input[type="file"]').first()
    await input.setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('broken') })
    await settings.locator('.startup-appearance-error').waitFor()
    check('bad uploads preserve the selected icon', JSON.parse(fs.readFileSync(diskPath, 'utf8')).icon.id === key)
    await input.setInputFiles({ name: 'uploaded.png', mimeType: 'image/png', buffer: Buffer.from(stored.icon.image.split(',')[1], 'base64') })
    await settings.waitForFunction(() => document.querySelector('#startup-icon').value === 'upload')
    check('uploaded icon uses the same persisted pipeline', true)
    await settings.selectOption('#startup-icon', key)
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    await settings.evaluate(() => { localStorage.setItem('tangu_locale', 'en'); localStorage.setItem('forsion_theme', 'dark') })
    await settings.reload(); await appearance(settings)
    await app.evaluate(({ BrowserWindow }, url) => { const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url); if (w) { w.setMinimumSize(420, 400); w.setSize(580, 820) } }, settings.url())
    await settings.locator('.startup-appearance').scrollIntoViewIfNeeded()
    await settings.screenshot({ path: path.join(OUT, 'en-dark-narrow-context.png') })
    await settings.locator('.startup-appearance').screenshot({ path: path.join(OUT, 'en-dark-narrow.png') })
    check('English narrow settings do not overflow horizontally', await settings.locator('.startup-appearance').evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
    await app.close(); app = null
    await launch()
    const initial = await win.evaluate(() => window.tangu.startupAppearance.initial)
    check('cold restart has the cached plugin appearance in preload', initial.icon.id === key && initial.splash.id === key)
    await openSettings()
    check('cold restart retains the selected plugin choices', await settings.inputValue('#startup-icon') === key)
    await installedPlugins()
    const pluginCard = settings.locator('.plugin-card--link').filter({ hasText: /开屏与图标示例|Startup appearance sample/ })
    await pluginCard.locator('input[type="checkbox"]').uncheck()
    await appearance(settings)
    await settings.waitForFunction(() => document.querySelector('#startup-icon').value === '')
    check('disabling the real plugin clears its selected icon and artwork', JSON.parse(fs.readFileSync(diskPath, 'utf8')).splash === null)
    await installedPlugins()
    await pluginCard.locator('input[type="checkbox"]').check()
    await appearance(settings)
    await settings.selectOption('#startup-icon', key)
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    await settings.selectOption('#startup-splash', key)
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    // Simulate an external uninstall while closed, then verify discovery clears the cache and native icon.
    await app.close(); app = null
    fs.rmSync(path.join(home, 'plugins/forsion-sample-appearance'), { recursive: true })
    await launch(); await openSettings()
    await settings.waitForFunction(() => document.querySelector('#startup-icon').value === '')
    check('removed plugin restores default artwork on discovery', JSON.parse(fs.readFileSync(diskPath, 'utf8')).icon === null)
    await settings.selectOption('#startup-motion', 'spin')
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    await settings.getByRole('button', { name: /^(恢复默认|Restore defaults)$/ }).click()
    await settings.waitForFunction(() => document.querySelector('#startup-motion').value === 'default')
    check('restore defaults persists the full default appearance', JSON.parse(fs.readFileSync(diskPath, 'utf8')).splash === null)
    console.log(`${checks} checks passed; screenshots: ${OUT}`)
  } catch (error) {
    if (settings && !settings.isClosed()) { await settings.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {}); console.error((await settings.locator('body').innerText().catch(() => '')).slice(0, 5000)) }
    if (win && !win.isClosed()) { await win.screenshot({ path: path.join(OUT, 'main-failure.png') }).catch(() => {}); console.error((await win.locator('body').innerText().catch(() => '')).slice(0, 2500)) }
    throw error
  } finally { if (app) await app.close(); await stub.close() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
