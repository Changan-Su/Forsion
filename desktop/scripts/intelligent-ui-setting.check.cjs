/** Intelligent UI 的档位(自动 / 少一点 / 关闭)住在 设置 → 模型 → 默认模型,不在「外观」(2026-10-14 用户定)。
 * 真 Electron × 隔离用户数据 × 假引擎:这一行在模型页、三档齐全、改了落到 `forsion_tangu_visuals`
 * (每次 run 的 ui_settings 快照读的那个键)、搜索深链 `visuals` 落在这一页、外观页不再有它。
 * 需先 npm run build。用法:npm run check:intelligent-ui-setting [--shot=<png>] */
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const ROOT = path.resolve(__dirname, '..')
const SHOT = process.argv.find((s) => s.startsWith('--shot='))?.slice(7) || path.join(ROOT, 'outputs/intelligent-ui-setting.png')
let failed = 0
const check = (name, ok, detail) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`) }

async function main() {
  const stub = await startStubEngine({ sessions: [], messages: [], models: [{ id: 'm1', name: 'Stub', provider: 'stub', contextWindow: 128000 }] })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-iui-setting-'))
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT, '-ApplePersistenceIgnoreState', 'YES'],
    cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
  })
  try {
    const win = await app.firstWindow({ timeout: 60000 })
    await win.waitForSelector('#root', { timeout: 30000 })
    check('离开首启引导', await skipOnboarding(win))
    const openSettings = async (tab) => {
      await win.evaluate((t) => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: t } }), tab)
      let fl
      for (let i = 0; i < 100 && !fl; i++) { fl = app.windows().find((w) => w.url().includes('window=floating')); if (!fl) await win.waitForTimeout(150) }
      await fl.waitForSelector('.settings-nav', { timeout: 30000 })
      return fl
    }
    const fl = await openSettings('model/m-models')
    const row = fl.locator('[data-setting-anchor="visuals"]').first()
    const select = row.locator('select')
    const found = await select.waitFor({ timeout: 15000 }).then(() => true, () => false)
    check('设置 → 模型 → 默认模型 里有 Intelligent UI 这一行', found)
    if (found) {
      check('三档:自动 / 少一点 / 关闭,缺省是自动', (await select.locator('option').allInnerTexts()).join('/') === '自动/少一点/关闭' && await select.inputValue() === 'auto')
      const hintBefore = await row.locator('small').innerText()
      await select.selectOption('less')
      check('选「少一点」→ 落到 run 快照读的那个键', await win.evaluate(() => localStorage.getItem('forsion_tangu_visuals')) === 'less')
      check('说明跟着档位换', (await row.locator('small').innerText()) !== hintBefore)
      await select.selectOption('auto')
      check('选回「自动」→ 不留键(缺省)', await win.evaluate(() => localStorage.getItem('forsion_tangu_visuals')) === null)
      await row.scrollIntoViewIfNeeded()
      fs.mkdirSync(path.dirname(SHOT), { recursive: true }); await fl.screenshot({ path: SHOT })
    }
    await fl.locator('.settings-nav-list button').filter({ hasText: '外观' }).first().click()
    await fl.locator('.settings-theme-behavior, [data-setting-anchor="ui-zoom"]').first().waitFor({ timeout: 15000 })
    check('外观页不再有这一行', await fl.locator('[data-setting-anchor="visuals"]').count() === 0)
    console.log(failed ? `${failed} FAILED` : `all passed. Screenshot: ${SHOT}`)
  } finally {
    await app.close().catch(() => {}); stub.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
