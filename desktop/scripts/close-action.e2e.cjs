#!/usr/bin/env node
/**
 * 主窗关闭钮(config.closeAction,electron/closeAction.ts)的接线:替换 dialog.showMessageBox 按剧本作答,
 * 走真 BrowserWindow.close()。T1 取消 = 窗口留着;T2 后台运行 + 不再询问 = 隐藏且记住;T3 记住后再关不再问;
 * T4 设置页那一行在、截图;T5 改回每次询问后选退出 = 进程退出。
 * 用法:先 npm run build,再 node scripts/close-action.e2e.cjs(SHOT_DIR 指截图目录)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.resolve(__dirname, '..')
const SHOT_DIR = process.env.SHOT_DIR || os.tmpdir()
let fails = 0
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? `  (${extra})` : ''}`) }

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/ —— 先 electron-vite build'); process.exit(1) }
  const stub = await startStubEngine({ sessions: [], messages: [], models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }] })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-closeaction-'))
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
  })
  const exited = new Promise((r) => app.process().once('exit', r))
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    const url = win.url()
    const answer = (a) => app.evaluate(({ dialog }, a) => {
      globalThis.__closeAsked ??= []
      dialog.showMessageBox = async (_w, o) => { globalThis.__closeAsked.push(o); return a }
    }, a)
    const asked = () => app.evaluate(() => globalThis.__closeAsked || [])
    const close = () => app.evaluate(({ BrowserWindow }, u) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === u).close(), url)
    const visible = () => app.evaluate(({ BrowserWindow }, u) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === u)?.isVisible(), url)
    const show = () => app.evaluate(({ BrowserWindow }, u) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === u).show(), url)

    check('T0 缺省 closeAction 不是 quit', (await win.evaluate(() => window.tangu.getConfig())).closeAction !== 'quit')

    await answer({ response: 2, checkboxChecked: true })
    await close(); await win.waitForTimeout(600)
    const a1 = await asked()
    check('T1 取消:问了一次、窗口还在、没记住', a1.length === 1 && (await visible()) === true && (await win.evaluate(() => window.tangu.getConfig())).closeAction !== 'tray', `asked=${a1.length} buttons=${JSON.stringify(a1[0]?.buttons)}`)

    await answer({ response: 1, checkboxChecked: true })
    await close(); await win.waitForTimeout(600)
    check('T2 后台运行 + 不再询问:隐藏且记住', (await visible()) === false && (await win.evaluate(() => window.tangu.getConfig())).closeAction === 'tray')

    await show(); await win.waitForTimeout(300)
    await close(); await win.waitForTimeout(600)
    check('T3 记住后再关:不问、直接隐藏', (await asked()).length === 2 && (await visible()) === false)
    await show(); await win.waitForTimeout(300)

    const opened = app.waitForEvent('window')
    await win.keyboard.press('Meta+Comma')
    const sp = await opened
    await sp.waitForLoadState('domcontentloaded')
    const row = sp.locator('[data-setting-anchor="close-action"]')
    await row.waitFor({ timeout: 10_000 })
    await row.screenshot({ path: path.join(SHOT_DIR, 'close-action-setting.png') })
    check('T4 设置行显示「在后台运行」', (await row.locator('select').inputValue()) === 'tray')
    await row.locator('select').selectOption('ask')
    await sp.waitForTimeout(400)
    check('T4b 设置页改回每次询问', (await win.evaluate(() => window.tangu.getConfig())).closeAction === 'ask')

    await answer({ response: 0, checkboxChecked: false })
    await close()
    const code = await Promise.race([exited.then(() => 'exited'), new Promise((r) => setTimeout(() => r('timeout'), 15_000))])
    check('T5 选退出:进程退出', code === 'exited')
  } finally {
    await app.close().catch(() => {})
    stub.close?.()
  }
  console.log(fails ? `\n${fails} FAIL` : '\nALL PASS')
  process.exit(fails ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
