// 真 Electron：临时笔记库 × 生产构建 × 深浅色/英文/窄窗口截图。
// 先 npm run build，再 node scripts/toggle-block.electron.cjs。
const fs = require('fs'), os = require('os'), path = require('path')
const assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
const SHOTS = process.env.TOGGLE_SHOTS || path.join(os.tmpdir(), 'amadeus-toggle-electron')
const NOTE = 'Toggle interaction'
const seed = [
  '把细节收进折叠块，让笔记更容易阅读。', '',
  '> [!fold]+ 项目计划 · Project plan', '>',
  '> 点击标题直接编辑，左侧三角控制展开与收起。', '>',
  '> - 整理需求与参考', '> - 验证鼠标和键盘操作', '>',
  '> > [!fold]- 更多细节 · Details', '> >', '> > 嵌套折叠保持独立状态。', '',
  '> [!fold]- 很长的标题会自然换行，左侧的展开按钮始终与第一行对齐', '>', '> 隐藏的正文。', '',
  '> [!fold]+', '', '折叠块之后继续写正文。', '',
].join('\n')
let checks = 0
function check(name, condition) { assert.ok(condition, name); checks++; console.log('PASS', name) }
async function main() {
  check('生产构建存在', fs.existsSync(path.join(ROOT, 'out/main/main.js')))
  fs.mkdirSync(SHOTS, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-toggle-'))
  const vault = path.join(home, 'vault')
  const userdata = path.join(home, 'userdata')
  const file = path.join(vault, `${NOTE}.md`)
  fs.mkdirSync(vault, { recursive: true })
  fs.writeFileSync(file, seed)
  const stub = await startStubEngine({ sessions: [], messages: [], agents: [], engines: [] })
  for (const dir of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }))
  }
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
    })
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 40000 })
    await skipOnboarding(win)
    const open = async (mode, locale, width) => {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width)
      await win.evaluate(({ mode, locale }) => {
        localStorage.setItem('forsion_default_space', 'amadeus')
        localStorage.setItem('forsion_theme_lang', 'lovable')
        localStorage.setItem('forsion_theme_pref', mode)
        localStorage.setItem('tangu_locale', locale)
        localStorage.removeItem('forsion_theme_forced_scheme')
      }, { mode, locale })
      await win.reload({ waitUntil: 'domcontentloaded' })
      await skipOnboarding(win)
      await win.waitForSelector('.am-app', { timeout: 40000 })
      const row = win.locator('.t2s-srow', { hasText: NOTE }).first()
      if (!await row.isVisible()) await win.locator('.dv-edge-left').click().catch(() => {})
      await row.click({ timeout: 20000 })
      await win.waitForSelector('.unified-body .callout-fold', { timeout: 20000 })
      await win.evaluate(() => document.fonts.ready)
      await win.mouse.move(12, 12)
      await win.waitForTimeout(350)
      check(`${mode}/${locale} 使用真实主题`, await win.evaluate((mode) => document.documentElement.dataset.mode === mode, mode))
    }
    await open('light', 'zh', 1280)
    const arrow = win.locator('.unified-body .ProseMirror > .callout-fold > p > .callout-chevron').first()
    check('生产笔记显示四枚 SVG 折叠按钮', await win.locator('.unified-body .callout-chevron svg').count() === 4)
    check('只读打开不改文件', fs.readFileSync(file, 'utf8') === seed)
    await win.screenshot({ path: path.join(SHOTS, 'light-zh.png') })
    await arrow.click()
    await win.waitForTimeout(1400)
    check('点击后真实落盘折叠状态与完整子内容', fs.readFileSync(file, 'utf8').includes('[!fold]- 项目计划') && fs.readFileSync(file, 'utf8').includes('嵌套折叠保持独立状态'))
    await open('dark', 'zh', 1280)
    check('重开保留折叠状态', await arrow.getAttribute('aria-expanded') === 'false')
    await arrow.click()
    await win.waitForTimeout(1400)
    await win.mouse.move(12, 12)
    await win.screenshot({ path: path.join(SHOTS, 'dark-zh.png') })
    await open('light', 'en', 1280)
    check('英文空块提示', await win.getByRole('button', { name: 'Empty toggle. Click to add content.' }).isVisible())
    await win.screenshot({ path: path.join(SHOTS, 'light-en.png') })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(620, 900))
    await win.waitForTimeout(350)
    await win.screenshot({ path: path.join(SHOTS, 'narrow-en.png') })
    check('窄窗口文档无横向溢出', await win.locator('.unified-body').evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
    console.log(`${checks} checks passed; screenshots: ${SHOTS}`)
  } finally {
    await app?.close().catch(() => {})
    await stub.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
