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
    const diskPath = path.join(`${userdata}-dev`, 'startup-appearance.json')
    const pixels = (src) => settings.evaluate(async (src) => {
      const img = new Image(); img.src = src; await img.decode()
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, c.width, c.height).data
      let edge
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0 && data[i] < 255) { edge = [...data.slice(i - 3, i + 1)]; break }
      return { width: c.width, height: c.height, edge, corner: [...ctx.getImageData(0, 0, 1, 1).data], center: [...ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data] }
    }, src)
    check('new installations still use the tree icon despite available built-in artwork', await settings.inputValue('#startup-icon') === '' && await settings.inputValue('#startup-splash') === '')
    // Two built-in scenes: the tree shadow is the default; the original animated mark stays selectable and stores no image.
    const sceneFrame = settings.frameLocator('.startup-appearance-preview iframe')
    await settings.locator('.startup-appearance').screenshot({ path: path.join(OUT, 'tree-shadow-settings-zh-light.png'), animations: 'disabled' })
    await settings.getByRole('button', { name: '预览开屏', exact: true }).click()
    await sceneFrame.locator('#tangu-splash .fts canvas').nth(2).waitFor()
    await settings.waitForTimeout(1500) // The scene emerges from the stage colour; the preview leaves at 2.4s.
    const version = require(path.join(APP_ROOT, 'package.json')).version
    check('the built page is stamped with the app version', fs.readFileSync(path.join(APP_ROOT, 'out/renderer/index.html'), 'utf8').includes(`<script>window.FORSION_APP_VERSION=${JSON.stringify(version)};`))
    check('the preview shows that version under the wordmark', await sceneFrame.locator('#tangu-splash .fts-ver').textContent() === version)
    await settings.locator('.startup-appearance-preview').screenshot({ path: path.join(OUT, 'tree-shadow-preview.png') })
    await sceneFrame.locator('#tangu-splash').waitFor({ state: 'detached', timeout: 8000 })
    check('default preview paints the tree shadow inside the sandboxed frame and leaves on the first frame', true)
    await settings.getByRole('button', { name: '关闭预览', exact: true }).click()
    await settings.selectOption('#startup-splash', 'classic')
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    const classicScene = JSON.parse(fs.readFileSync(diskPath, 'utf8'))
    check('the classic logo is a built-in scene stored without an image', classicScene.scene === 'classic' && classicScene.splash === null && await settings.inputValue('#startup-splash') === 'classic' && await settings.locator('#startup-splash optgroup[label="内置"] option[value="classic"]').count() === 1 && await settings.locator('#startup-icon option[value="classic"]').count() === 0)
    await settings.getByRole('button', { name: '预览开屏', exact: true }).click()
    await sceneFrame.locator('#tangu-splash .tangu-splash-logo').waitFor()
    check('classic preview shows the original animated tree mark', await sceneFrame.locator('#tangu-splash .fts').count() === 0)
    await settings.getByRole('button', { name: '关闭预览', exact: true }).click()
    await settings.selectOption('#startup-splash', '')
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    check('choosing Default returns to the tree shadow', JSON.parse(fs.readFileSync(diskPath, 'utf8')).scene === 'treeShadow')
    const legacyIcon = await settings.evaluate(() => {
      const c = document.createElement('canvas'); c.width = c.height = 64
      const ctx = c.getContext('2d'); ctx.fillStyle = '#4f8b77'; ctx.fillRect(0, 0, 64, 64)
      return c.toDataURL('image/png')
    })
    await settings.evaluate((image) => window.tangu.startupAppearance.update({ icon: { id: 'upload', label: 'Previously uploaded icon', image } }), legacyIcon)
    if (process.platform === 'darwin') {
      const nativePixels = await pixels(await app.evaluate(() => global.__appearanceIcons.at(-1)))
      check('previously saved square icons gain smooth native corners without changing their colours', nativePixels.corner[3] === 0 && nativePixels.center.join(',') === '79,139,119,255' && nativePixels.edge && nativePixels.edge.slice(0, 3).every((n, i) => Math.abs(n - nativePixels.center[i]) <= 4))
    }
    await settings.selectOption('#startup-icon', 'builtin:arioso')
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    await settings.selectOption('#startup-splash', 'builtin:arioso')
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    const builtin = JSON.parse(fs.readFileSync(diskPath, 'utf8'))
    const builtinPixels = await pixels(builtin.icon.image)
    check('compressed Arioso is selectable as a built-in icon and startup image without plugin ownership', builtin.icon.id === 'builtin:arioso' && builtin.splash.id === 'builtin:arioso' && !builtin.icon.pluginId && !builtin.splash.pluginId && builtin.icon.image.length < 200_000 && builtin.splash.image.startsWith('data:image/webp') && builtin.splash.poster === builtin.icon.image)
    check('built-in icon has real transparent rounded corners at 256px', builtinPixels.width === 256 && builtinPixels.corner[3] === 0 && builtinPixels.center[3] === 255)
    check('built-in option appears once in its own localized group', await settings.locator('#startup-icon optgroup[label="内置"] option[value="builtin:arioso"]').count() === 1 && await settings.locator('#startup-icon option[value="builtin:arioso"]').count() === 1)
    await settings.locator('.startup-appearance').screenshot({ path: path.join(OUT, 'arioso-zh-light.png'), animations: 'disabled' })
    await settings.getByRole('button', { name: '预览开屏', exact: true }).click()
    await settings.frameLocator('.startup-appearance-preview iframe').locator('.forsion-startup-image').waitFor()
    await settings.locator('.startup-appearance-preview').screenshot({ path: path.join(OUT, 'arioso-preview.png'), animations: 'disabled' })
    await settings.getByRole('button', { name: '关闭预览', exact: true }).click()
    await settings.selectOption('#startup-icon', key)
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    await settings.selectOption('#startup-splash', key)
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    await settings.selectOption('#startup-motion', 'pulse')
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
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
    // The import dialog is a draft: decode, crop and compress before touching persisted settings.
    const input = settings.locator('.startup-appearance input[type="file"]').first()
    const importDialog = settings.locator('.appearance-import')
    const applyImage = () => importDialog.getByRole('button', { name: /^(确认使用|Apply image)$/ }).click()
    const saved = () => JSON.parse(fs.readFileSync(diskPath, 'utf8'))
    const upload = { name: 'uploaded.png', mimeType: 'application/octet-stream', buffer: Buffer.from(stored.icon.image.split(',')[1], 'base64') }
    await input.setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]) })
    await settings.getByRole('alert').filter({ hasText: '无法读取这张图片' }).waitFor()
    check('decode failure is specific and preserves the selected icon', saved().icon.id === key)
    await input.setInputFiles({ name: 'unsupported.heic', mimeType: 'image/heic', buffer: Buffer.from('unsupported') })
    await settings.getByRole('alert').filter({ hasText: '不支持此图片格式' }).waitFor()
    await input.setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(20_000_001) })
    await settings.getByRole('alert').filter({ hasText: '原图超过 20 MB' }).waitFor()
    check('unsupported formats and source size failures explain the cause', true)
    await input.setInputFiles(upload)
    await importDialog.waitFor()
    check('generic MIME images decode without replacing the previous selection', saved().icon.id === key)
    await settings.keyboard.press('Escape')
    await importDialog.waitFor({ state: 'hidden' })
    check('cancel leaves the previous icon untouched', saved().icon.id === key)
    await input.setInputFiles(upload)
    await importDialog.waitFor()
    await app.evaluate(({ ipcMain }) => {
      global.__appearanceWriter = ipcMain._invokeHandlers.get('appearance:update')
      ipcMain.removeHandler('appearance:update')
      ipcMain.handle('appearance:update', () => { throw new Error('simulated disk full') })
    })
    try {
      await applyImage()
      await importDialog.getByRole('alert').filter({ hasText: '设置保存失败' }).waitFor()
      check('save failure keeps the draft open and preserves the old icon', saved().icon.id === key && await importDialog.isVisible())
    } finally {
      await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('appearance:update'); ipcMain.handle('appearance:update', global.__appearanceWriter); delete global.__appearanceWriter })
    }
    await applyImage()
    await importDialog.waitFor({ state: 'hidden' })
    check('confirmed upload uses the persisted pipeline after retry', saved().icon.id === 'upload')
    const largePng = await settings.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 1500; c.height = 900
      const ctx = c.getContext('2d'), pixels = ctx.createImageData(c.width, c.height)
      let seed = 42
      for (let i = 0; i < pixels.data.length; i += 4) {
        for (let channel = 0; channel < 3; channel++) { seed = (1664525 * seed + 1013904223) >>> 0; pixels.data[i + channel] = seed >>> 24 }
        pixels.data[i + 3] = 255
      }
      ctx.putImageData(pixels, 0, 0)
      return c.toDataURL('image/png').split(',')[1]
    })
    const largeBytes = Buffer.from(largePng, 'base64')
    assert.ok(largeBytes.length > 1_400_000 && largeBytes.length < 20_000_000)
    await input.setInputFiles({ name: 'large-photo.png', mimeType: 'image/png', buffer: largeBytes })
    await applyImage(); await importDialog.waitFor({ state: 'hidden' })
    check('image larger than the old 1.4 MB limit is automatically reduced', saved().icon.image.length < 800_000)
    const wide = { name: 'wide-artwork.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="2500"><path fill="#ce6d59" d="M0 0h2000v2500H0z"/><path fill="#4f8b77" d="M2000 0h1000v2500H2000z"/><path fill="#648ab5" d="M3000 0h2000v2500H3000z"/></svg>') }
    await input.setInputFiles(wide)
    await importDialog.getByRole('button', { name: '正方形裁剪', exact: true }).click()
    const stage = importDialog.locator('.appearance-import-stage')
    const zoom = importDialog.getByRole('slider', { name: '缩放', exact: true })
    await zoom.focus(); await zoom.press('End')
    const center = () => importDialog.locator('.appearance-import-stage canvas').evaluate((el) => [...el.getContext('2d').getImageData(256, 256, 1, 1).data])
    const beforeDrag = await center()
    const stageBox = await stage.boundingBox()
    await settings.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2)
    await settings.mouse.down(); await settings.mouse.move(stageBox.x + stageBox.width * 1.5, stageBox.y + stageBox.height / 2, { steps: 6 }); await settings.mouse.up()
    const afterDrag = await center()
    check('large non-square images support zoom and drag with a live crop', beforeDrag[1] > beforeDrag[0] && afterDrag[0] > afterDrag[1])
    const beforeKey = await importDialog.locator('.appearance-import-stage canvas').evaluate((el) => el.toDataURL())
    await stage.focus(); await stage.press('ArrowLeft')
    check('crop position supports keyboard adjustments', beforeKey !== await importDialog.locator('.appearance-import-stage canvas').evaluate((el) => el.toDataURL()))
    await stage.press('ArrowRight')
    check('import preview and thumbnail show transparent icon corners before saving', await importDialog.evaluate((el) => [...el.querySelectorAll('canvas')].every((c) => c.getContext('2d').getImageData(0, 0, 1, 1).data[3] === 0)))
    await settings.screenshot({ path: path.join(OUT, 'import-crop-zh.png'), animations: 'disabled' })
    await importDialog.screenshot({ path: path.join(OUT, 'import-dialog-zh.png'), animations: 'disabled' })
    await applyImage(); await importDialog.waitFor({ state: 'hidden' })
    const cropPixelsSource = saved().icon.image
    const cropPixels = await settings.evaluate(async (src) => {
      const img = new Image(); img.src = src; await img.decode()
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0)
      return { width: c.width, height: c.height, center: [...ctx.getImageData(128, 128, 1, 1).data] }
    }, saved().icon.image)
    check('saved 256px square pixels match the crop preview', cropPixels.width === 256 && cropPixels.height === 256 && Math.abs(cropPixels.center[0] - afterDrag[0]) < 3)
    check('uploaded crop stores transparent corners in the PNG itself', (await pixels(saved().icon.image)).corner[3] === 0)
    const formats = await settings.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 96; c.height = 160
      const ctx = c.getContext('2d'); ctx.fillStyle = '#4f8b77'; ctx.fillRect(20, 20, 56, 120)
      return ['image/png', 'image/jpeg', 'image/webp'].map((mime) => ({ mime, data: c.toDataURL(mime).split(',')[1] }))
    })
    for (const { mime, data } of formats) {
      await input.setInputFiles({ name: `portrait.${mime.split('/')[1]}`, mimeType: '', buffer: Buffer.from(data, 'base64') })
      await importDialog.waitFor()
      check(`${mime} with empty MIME imports in fit mode`, await importDialog.getByRole('button', { name: '完整显示', exact: true }).getAttribute('aria-pressed') === 'true')
      if (mime === 'image/png') {
        check('fit preserves transparent margins on portrait images', await importDialog.locator('.appearance-import-stage canvas').evaluate((el) => { const ctx = el.getContext('2d'); return ctx.getImageData(1, 256, 1, 1).data[3] === 0 && ctx.getImageData(256, 256, 1, 1).data[3] === 255 }))
      }
      await settings.keyboard.press('Escape')
    }
    await input.setInputFiles({ name: 'too-wide.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="2"/>') })
    await settings.getByRole('alert').filter({ hasText: '单边 16384 像素' }).waitFor()
    check('extreme dimensions report their limit without changing the selection', saved().icon.image === cropPixelsSource)
    const splashInput = settings.locator('.startup-appearance input[type="file"]').nth(1)
    await splashInput.setInputFiles({ name: 'large-startup.png', mimeType: 'image/png', buffer: largeBytes })
    await applyImage(); await importDialog.waitFor({ state: 'hidden' })
    check('large startup artwork is automatically compressed with a static poster', saved().splash.image.length <= 2_000_000 && saved().splash.poster.startsWith('data:image/png'))
    console.log(`Compression: ${largeBytes.length} source bytes -> ${Buffer.from(saved().splash.image.split(',')[1], 'base64').length} startup bytes`)
    await splashInput.setInputFiles({ name: 'animated-startup.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(stored.splash.image.split(',')[1], 'base64') })
    await importDialog.getByText('将保留原图动画。', { exact: true }).waitFor()
    check('transparent animation preview does not reveal a frozen frame underneath', await importDialog.locator('.appearance-import-stage canvas').evaluate((el) => getComputedStyle(el).visibility === 'hidden'))
    await importDialog.getByRole('button', { name: '正方形裁剪', exact: true }).click()
    await importDialog.getByText('本次处理将保存为静态图片。', { exact: true }).waitFor()
    await importDialog.getByRole('button', { name: '完整显示', exact: true }).click()
    await applyImage(); await importDialog.waitFor({ state: 'hidden' })
    check('animated originals stay animated in fit mode and disclose static crop output', saved().splash.image === stored.splash.image)
    await settings.selectOption('#startup-splash', key)
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    await settings.selectOption('#startup-icon', key)
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    await settings.evaluate(() => { localStorage.setItem('tangu_locale', 'en'); localStorage.setItem('forsion_theme', 'dark') })
    await settings.reload(); await appearance(settings)
    await app.evaluate(({ BrowserWindow }, url) => { const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url); if (w) { w.setMinimumSize(420, 400); w.setSize(580, 820) } }, settings.url())
    await settings.locator('.startup-appearance').scrollIntoViewIfNeeded()
    await settings.screenshot({ path: path.join(OUT, 'en-dark-narrow-context.png') })
    await settings.locator('.startup-appearance').screenshot({ path: path.join(OUT, 'en-dark-narrow.png') })
    check('English narrow settings do not overflow horizontally', await settings.locator('.startup-appearance').evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
    await settings.locator('.startup-appearance input[type="file"]').first().setInputFiles(wide)
    await importDialog.getByRole('button', { name: 'Square crop', exact: true }).click()
    await settings.screenshot({ path: path.join(OUT, 'import-crop-en-dark-narrow.png'), animations: 'disabled' })
    check('crop dialog stays within the narrow window', await importDialog.evaluate((el) => { const r = el.getBoundingClientRect(); return el.scrollWidth <= el.clientWidth + 1 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }))
    await importDialog.getByRole('button', { name: 'Cancel', exact: true }).last().click()

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
    await settings.selectOption('#startup-icon', 'builtin:arioso')
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    await settings.selectOption('#startup-splash', 'builtin:arioso')
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    await settings.locator('.startup-appearance').screenshot({ path: path.join(OUT, 'arioso-en-dark-narrow.png'), animations: 'disabled' })
    await app.close(); app = null
    await launch(); await openSettings()
    check('built-in choices persist across restart after the sample plugin is removed', await settings.inputValue('#startup-icon') === 'builtin:arioso' && await settings.inputValue('#startup-splash') === 'builtin:arioso' && await settings.locator('#startup-icon option[value="builtin:arioso"]').count() === 1)
    await settings.selectOption('#startup-motion', 'spin')
    await settings.waitForFunction(() => !document.querySelector('.startup-appearance-fields').disabled)
    await settings.getByRole('button', { name: /^(恢复默认|Restore defaults)$/ }).click()
    await settings.waitForFunction(() => document.querySelector('#startup-motion').value === 'default')
    check('restore defaults persists the full default tree appearance', JSON.parse(fs.readFileSync(diskPath, 'utf8')).splash === null && JSON.parse(fs.readFileSync(diskPath, 'utf8')).icon === null && JSON.parse(fs.readFileSync(diskPath, 'utf8')).scene === 'treeShadow')
    console.log(`${checks} checks passed; screenshots: ${OUT}`)
  } catch (error) {
    if (settings && !settings.isClosed()) { await settings.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {}); console.error((await settings.locator('body').innerText().catch(() => '')).slice(0, 5000)) }
    if (win && !win.isClosed()) { await win.screenshot({ path: path.join(OUT, 'main-failure.png') }).catch(() => {}); console.error((await win.locator('body').innerText().catch(() => '')).slice(0, 2500)) }
    throw error
  } finally { if (app) await app.close(); await stub.close() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
