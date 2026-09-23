/** First-party theme handoff: real Electron, isolated data, screenshots and English copy.
 * Run after npm run build: npm run check:themeapp
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.resolve(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-theme-app-'))
const shots = process.env.THEME_APP_SHOTS || path.join(home, 'shots')
fs.mkdirSync(shots, { recursive: true })
const check = (name, condition, detail) => {
  assert.ok(condition, `${name}: ${JSON.stringify(detail)}`)
  console.log('PASS', name)
}

async function main() {
  check('renderer has been built', fs.existsSync(path.join(ROOT, 'out/renderer/index.html')))
  const stub = await startStubEngine({ sessions: [], messages: [], agents: [], engines: [] })
  const userdata = path.join(home, 'userdata')
  for (const dir of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }))
  }
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
    })
    const main = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860))
    await main.waitForSelector('#root', { timeout: 40000 })
    await skipOnboarding(main)
    await main.evaluate(() => localStorage.setItem('forsion_default_space', 'tangu'))

    const cases = [
      { lang: 'lovable', mode: 'light', radius: '12px', name: 'genesis-light' },
      { lang: 'soft', mode: 'light', radius: '14px', name: 'soft-light' },
      { lang: 'soft', mode: 'dark', radius: '14px', name: 'soft-dark' },
      { lang: 'genesis-glass', mode: 'light', radius: '12px', name: 'glass-light' },
    ]
    for (const item of cases) {
      await main.evaluate(({ lang, mode }) => {
        localStorage.setItem('forsion_theme_lang', lang)
        localStorage.setItem('forsion_theme_skin', 'coral')
        localStorage.setItem('forsion_theme_bg', 'teal')
        localStorage.setItem('forsion_theme_pref', mode)
        localStorage.removeItem('forsion_theme_forced_scheme')
      }, item)
      await main.reload({ waitUntil: 'domcontentloaded' })
      await skipOnboarding(main)
      await main.waitForFunction((lang) => document.documentElement.dataset.theme === lang, item.lang, { timeout: 20000 })
      await main.locator('.shell').waitFor({ timeout: 20000 })
      const actual = await main.evaluate(() => {
        const root = document.documentElement
        const shell = document.querySelector('.shell')
        const ribbon = document.querySelector('.rb')
        const css = getComputedStyle(root)
        return {
          lang: root.dataset.theme,
          mode: root.dataset.mode,
          radius: css.getPropertyValue('--radius-md').trim(),
          shellPad: getComputedStyle(shell).paddingTop,
          ribbonRadius: ribbon ? getComputedStyle(ribbon).borderTopLeftRadius : '',
          overflowX: root.scrollWidth - root.clientWidth,
          cssEnabled: Boolean(document.getElementById('forsion-theme-css-' + root.dataset.theme) && !document.getElementById('forsion-theme-css-' + root.dataset.theme)?.disabled),
        }
      })
      check(`${item.name} theme CSS loaded`, actual.cssEnabled && actual.lang === item.lang && actual.radius === item.radius, actual)
      check(`${item.name} no page overflow`, actual.overflowX <= 1, actual)
      if (item.lang === 'soft') check(`${item.name} floating shell geometry`, actual.shellPad === '8px' && actual.ribbonRadius === '18px', actual)
      await main.screenshot({ path: path.join(shots, `${item.name}.png`) })
    }

    const settingsOpened = app.waitForEvent('window', { timeout: 20000 }).catch(() => null)
    await main.keyboard.press('Meta+Comma')
    const settings = (await settingsOpened) || app.windows().at(-1)
    await settings.locator('.settings-nav').waitFor({ timeout: 30000 })
    await settings.locator('.settings-nav-list button').filter({ hasText: '外观' }).click()
    await settings.locator('.settings-theme-language .theme-card').first().waitFor()
    const names = await settings.locator('.settings-theme-language .theme-name').allTextContents()
    check('retired Zhi language absent; Genesis, Glass and Soft available', names.includes('Genesis') && names.includes('Glass') && names.includes('Soft') && !names.includes('知'), names)
    check('legacy blue palette is named Clear blue', (await settings.locator('.settings-theme-palette').innerText()).includes('晴蓝'))
    await settings.screenshot({ path: path.join(shots, 'settings-zh.png') })

    await settings.evaluate(() => localStorage.setItem('tangu_locale', 'en'))
    await settings.reload({ waitUntil: 'domcontentloaded' })
    await settings.locator('.settings-nav').waitFor({ timeout: 30000 })
    await settings.locator('.settings-nav-list button').filter({ hasText: 'Appearance' }).click()
    const taglines = await settings.locator('.settings-theme-language .theme-tagline').allTextContents()
    check('all bundled themes show English taglines', taglines.some((text) => text.includes('Classic paper')) && taglines.some((text) => text.includes('Native glass')) && taglines.some((text) => text.includes('Softly raised')) && taglines.every((text) => !/[\u3400-\u9fff]/u.test(text)), taglines)
    const options = await settings.locator('.settings-theme-language .theme-opts').innerText()
    check('Glass settings show English labels', options.includes('Shell opacity') && options.includes('Overlay blur'), options.slice(0, 400))
    await settings.screenshot({ path: path.join(shots, 'settings-en.png') })

    const zhiCandidate = path.resolve(ROOT, '../../Forsion-Instrumentality-Project/forsion-theme-zhi')
    if (fs.existsSync(path.join(zhiCandidate, 'theme.css'))) {
      const installed = path.join(home, 'themes', 'zhi')
      fs.mkdirSync(installed, { recursive: true })
      for (const name of ['theme.json', 'theme.css']) fs.copyFileSync(path.join(zhiCandidate, name), path.join(installed, name))
      await app.close()
      app = await electron.launch({
        args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
        env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
      })
      const installedMain = await app.firstWindow()
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860))
      await skipOnboarding(installedMain)
      for (const mode of ['light', 'dark']) {
        await installedMain.evaluate((value) => {
          localStorage.setItem('forsion_theme_lang', 'zhi')
          localStorage.setItem('forsion_theme_pref', value)
        }, mode)
        await installedMain.reload({ waitUntil: 'domcontentloaded' })
        await skipOnboarding(installedMain)
        await installedMain.waitForFunction(() => document.documentElement.dataset.theme === 'zhi', undefined, { timeout: 20000 })
        const actual = await installedMain.evaluate(() => ({
          radius: getComputedStyle(document.documentElement).getPropertyValue('--radius-md').trim(),
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          cssEnabled: Boolean(document.getElementById('forsion-theme-css-zhi') && !document.getElementById('forsion-theme-css-zhi')?.disabled),
        }))
        check(`installed Zhi ${mode} theme loaded without overflow`, actual.radius === '9px' && actual.overflowX <= 1 && actual.cssEnabled, actual)
        await installedMain.screenshot({ path: path.join(shots, `zhi-installed-${mode}.png`) })
      }
    }
    console.log('Theme app screenshots:', shots)
  } finally {
    await app?.close()
    stub.close()
  }
}
main().catch((error) => { console.error(error); console.error('Theme app screenshots:', shots); process.exitCode = 1 })
