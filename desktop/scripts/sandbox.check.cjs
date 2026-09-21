/**
 * Sandbox = Coding Studio 里的**插件开发加载器**(不是隔离环境)的端到端契约(真 Electron)。
 *
 * 证的是这条链跑得通,且跑的是真东西:
 *   1 托管根里的「manifest.json + main.js」项目被判成插件 → 主区给插件占位屏(没有网页预览)
 *   2 打开 Sandbox →「在 Forsion 中加载」→ 状态变「已加载,正在运行」,且这个插件自己的
 *     console 标记出现在面板的输出列表里(= 真的在这个 Forsion 里跑起来了)
 *   3 改写 main.js 换一个标记 → 几秒内新标记出现(存盘即重载,项目开着才有)
 *   4 再改写成 setup 抛错 → 面板直接显示 setup 抛的那段原文
 *   5 卸载 → 状态回到「未加载」
 *   6 只有 main.js 的项目先按网页项目处理;**写出 manifest.json 之后当场变成插件项目**
 *     (真实主线:启动页只建空文件夹,manifest 是 agent 后写的。判型若被 sidecar 冻在首次扫盘的
 *      结果上,这一条会红 —— 那是宿主侧的语义问题,不是渲染层的)
 *   7 全程无渲染层异常
 *
 * ⚠️ 与 builtin-artificial.check.cjs 同款:本脚本**额外覆写 HOME**,因为产物的托管根是
 *   `defaultWorkspaceDir()/Project` = `<home>/Forsion-Dev/Project`(dev 态)。这是让夹具项目
 *   进到托管根、同时不碰用户真实 ~/Forsion-Dev 的唯一办法。Windows 上要改成覆写 USERPROFILE。
 *
 * ⚠️ 选择器一律走组件里的 data-* 锚点,不认中英文文案(界面语言变了不该把这套仪器测红):
 *   [data-sandbox-placeholder] / [data-sandbox-state] / [data-sandbox-state-label] /
 *   [data-action="sandbox-open|sandbox-load|sandbox-unload|sandbox-reload|sandbox-send|sandbox-clear"] /
 *   [data-sandbox-log] / [data-sandbox-error="setup|mount|action"]
 *
 * ⚠️ 量的是 out/ 里的产物,源码改了没 `npm run build` 就是白测。
 * 跑:npm run check:sandbox
 * 报「启动失败」= 有 dev 版 Electron 占着单实例锁,先把它关掉(同 check:artificial)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-sandbox-'))
const UD = path.join(home, 'userdata')
const VAULT = path.join(home, 'vault')
const PROJECTS = path.join(home, 'Forsion-Dev', 'Project') // = defaultWorkspaceDir()/Project(dev)
const FIXTURE_NAME = 'sandbox-fixture-plugin'
const FIXTURE = path.join(PROJECTS, FIXTURE_NAME)
const PLUGIN_ID = 'sandbox-fixture-plugin'
/** 第二个夹具:一开始只有 main.js(还不是插件),跑到第 6 条时才补 manifest.json。 */
const LATE_NAME = 'sandbox-fixture-late'
const LATE = path.join(PROJECTS, LATE_NAME)
const SPACE_NAMES = ['编码工作室', 'Coding Studio', 'Coding']

/** 裸 setup(ctx) 体:注册一个视图 + 打一条可识别的标记,末尾返回 disposer(热重载会反复 setup)。 */
const mainJs = (marker) => `console.log('${marker}')
ctx.registerView({
  id: 'sandbox-fixture-view',
  title: 'Sandbox fixture',
  mount(el) {
    const box = document.createElement('div')
    box.textContent = '${marker}'
    el.append(box)
    return () => { box.remove() }
  },
})
return () => { console.log('${marker}_DISPOSED') }
`
/** setup 当场抛错:面板必须把这段原文摆出来,而不是一句泛泛的「加载失败」。 */
const THROWING_MAIN = `throw new Error('SANDBOX_FIXTURE_SETUP_EXPLODED')\n`

const manifest = (id, name) => JSON.stringify({ id, name, version: '0.0.1', apiVersion: 1, main: 'main.js' }, null, 2)
function writeFixture(source) {
  fs.mkdirSync(FIXTURE, { recursive: true })
  fs.writeFileSync(path.join(FIXTURE, 'manifest.json'), manifest(PLUGIN_ID, 'Sandbox fixture plugin'))
  fs.writeFileSync(path.join(FIXTURE, 'main.js'), source)
}

const SHOT_DIR = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : null
/** `SHOT_DIR=<目录> npm run check:sandbox` 额外落真实截图(占位屏 / 已加载 / setup 抛错),DESIGN.md §8 的自查用。走原生合成器。 */
async function shoot(app, win, name) {
  if (!SHOT_DIR) return
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  await win.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await win.waitForTimeout(350)
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(SHOT_DIR, `sandbox-${name}.png`), Buffer.from(png, 'base64'))
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, ...(detail ? { detail } : {}) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
async function until(read, timeout = 15_000) {
  const end = Date.now() + timeout
  let value
  while (Date.now() < end) {
    try { value = await read(); if (value) return value } catch { /* 渲染 / 导航可能正在途中 */ }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}
/** 进编码工作室:ribbon 上区 / 主位槽 / 「…」溢出浮层 / 主页磁贴,四处都找(同 coding-studio.e2e)。 */
async function openCodingSpace(win) {
  // 按 title **或** .rb-label 文案认(收起态 ribbon 只有 title,展开态只有 label)—— 同 builtin-artificial.check 的 enterSpace。
  const click = (root) => `(() => {
    const b = [...document.querySelectorAll('${root} .rb-space')].find((x) =>
      ${JSON.stringify(SPACE_NAMES)}.includes(x.getAttribute('title') || x.querySelector('.rb-label')?.textContent || ''))
    if (b) { b.click(); return true }
    return false
  })()`
  if (await win.evaluate(click('.rb-top')) || await win.evaluate(click('.rb-home'))) return true
  const more = win.locator('.rb-top .rb-more').first()
  if (await more.count().catch(() => 0)) {
    await more.hover()
    await win.waitForTimeout(500)
    if (await win.evaluate(click('.rb-fly'))) return true
    await win.mouse.move(700, 700)
  }
  const tile = win.locator('.hp-tile').filter({ hasText: /编码工作室|Coding Studio/ }).first()
  if (await tile.isVisible().catch(() => false)) { await tile.click(); return true }
  return false
}
const logTexts = (win) => win.evaluate(() => [...document.querySelectorAll('[data-sandbox-log]')].map((row) => row.textContent || ''))

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  writeFixture(mainJs('SANDBOX_FIXTURE_MARK_ONE'))
  fs.mkdirSync(LATE, { recursive: true })
  fs.writeFileSync(path.join(LATE, 'main.js'), mainJs('SANDBOX_FIXTURE_LATE_MARK')) // manifest 稍后再补
  fs.mkdirSync(VAULT, { recursive: true })
  fs.mkdirSync(`${UD}-dev`, { recursive: true }) // dev 态的 userData 目录带 -dev 后缀
  fs.writeFileSync(path.join(`${UD}-dev`, 'amadeus-config.dev.json'), JSON.stringify({ localVault: VAULT, lastVault: VAULT }))
  const stub = await startStubEngine({ sessions: [] })
  const errs = []
  let app
  let win
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${UD}`, '--lang=zh-CN', ROOT],
      cwd: ROOT,
      // HOME 覆写见文件头的⚠️;后端指向假引擎,本题不跑任何模型。
      env: { ...process.env, HOME: home, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      timeout: 45_000,
    })
    win = await app.firstWindow()
    win.setDefaultTimeout(15_000)
    win.on('pageerror', (e) => errs.push(String((e && e.message) || e)))
    await win.waitForSelector('#root', { state: 'attached', timeout: 45_000 })
    await win.waitForTimeout(2500) // 首启引导是懒挂的:#root 一到就找「跳过」会扑空,引导层随后盖住整个工作台(.dv-groupview 永远 hidden)
    for (const label of ['跳过引导', 'Skip']) {
      const skip = win.locator(`text=${label}`).first()
      if (await skip.count().catch(() => 0)) { await skip.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 45_000 })
    await win.waitForTimeout(1500)
    if (!await openCodingSpace(win)) throw new Error('ribbon / 主页里都找不到编码工作室')
    await win.waitForSelector('.csl-launchpad', { timeout: 30_000 })
    // 夹具住在真正的托管根里,所以它就在启动页的项目列表里(不用文件选择器)。
    await win.locator('.csl-project').filter({ hasText: FIXTURE_NAME }).first().click()
    await win.waitForSelector('.csu-workspace', { timeout: 30_000 })

    const placeholder = await until(() => win.locator('[data-sandbox-placeholder]').isVisible().catch(() => false))
    await shoot(app, win, 'placeholder')
    check('1 manifest + main 的项目被判成插件:主区是插件占位屏,不是网页预览',
      placeholder && await win.locator('webview.csx-frame').count() === 0
      && await win.locator('.csu-tools .csu-device').count() === 0,
      JSON.stringify({ placeholder, guests: await win.locator('webview').count() }))
    if (!placeholder) throw new Error('插件占位屏没出来 —— 后面全是连带失败,先查 productsEnsure 的判型')

    await win.locator('[data-sandbox-placeholder] [data-action="sandbox-open"]').click()
    await win.waitForSelector('[data-sandbox-state]', { timeout: 20_000 })
    const before = await win.locator('[data-sandbox-state]').getAttribute('data-sandbox-state')
    await win.locator('[data-action="sandbox-load"]').click()
    const active = await until(async () => await win.locator('[data-sandbox-state]').getAttribute('data-sandbox-state') === 'active', 30_000)
    const markOne = await until(async () => (await logTexts(win)).some((text) => text.includes('SANDBOX_FIXTURE_MARK_ONE')), 30_000)
    await shoot(app, win, 'active')
    check('2 「在 Forsion 中加载」之后状态变 active,且插件自己的 console 标记出现在面板里',
      before === 'unloaded' && active && markOne,
      JSON.stringify({ before, active, logs: (await logTexts(win)).slice(-4) }))

    // 3 热重载:项目开着时存盘即重载。写的是真文件,等的是真的新标记。
    fs.writeFileSync(path.join(FIXTURE, 'main.js'), mainJs('SANDBOX_FIXTURE_MARK_TWO'))
    const markTwo = await until(async () => (await logTexts(win)).some((text) => text.includes('SANDBOX_FIXTURE_MARK_TWO')), 20_000)
    check('3 改写 main.js 后几秒内自动重载(新标记出现)', markTwo, JSON.stringify((await logTexts(win)).slice(-4)))

    // 4 setup 抛错:面板要给出抛的那段原文,而不是把插件静默吞掉。
    fs.writeFileSync(path.join(FIXTURE, 'main.js'), THROWING_MAIN)
    const failed = await until(async () => {
      const text = await win.locator('[data-sandbox-error="setup"]').textContent().catch(() => '')
      return (text || '').includes('SANDBOX_FIXTURE_SETUP_EXPLODED')
    }, 20_000)
    await shoot(app, win, 'failed')
    check('4 setup 抛错时,面板显示抛出的原文', failed,
      JSON.stringify({ state: await win.locator('[data-sandbox-state]').getAttribute('data-sandbox-state') }))

    await win.locator('[data-action="sandbox-unload"]').click()
    // 状态来自插件 store(重载一落定就翻),按钮来自产物的 devLoad(还要等上层重新读一次产物,多一趟 IPC)——
    // 两者一起等;状态翻了立刻数按钮会撞进这一趟 IPC 的空窗(实测 1/7 红)。
    const unloaded = await until(async () => await win.locator('[data-sandbox-state]').getAttribute('data-sandbox-state') === 'unloaded'
      && await win.locator('[data-action="sandbox-load"]').count() === 1
      && await win.locator('[data-action="sandbox-unload"]').count() === 0, 30_000)
    check('5 卸载之后回到「未加载」,并重新给出加载按钮', unloaded,
      JSON.stringify({ state: await win.locator('[data-sandbox-state]').getAttribute('data-sandbox-state'), load: await win.locator('[data-action="sandbox-load"]').count(), unload: await win.locator('[data-action="sandbox-unload"]').count() }))

    // 6 真实主线:启动页只建空文件夹,manifest.json 是后写的。判型必须跟着 manifest 的出现改口。
    await win.locator('.csu-project').click()
    await win.waitForSelector('.csl-launchpad', { timeout: 30_000 })
    await win.locator('.csl-project').filter({ hasText: LATE_NAME }).first().click()
    await win.waitForSelector('.csu-workspace', { timeout: 30_000 })
    const beforeManifest = await until(() => win.locator('.csu-first-page').isVisible().catch(() => false))
      && await win.locator('[data-sandbox-placeholder]').count() === 0
      && await win.locator('.csu-tool-nav [data-studio-tool="sandbox"]').count() === 0
    fs.writeFileSync(path.join(LATE, 'manifest.json'), manifest('sandbox-fixture-late', 'Sandbox fixture late'))
    const becomesPlugin = await until(async () => await win.locator('[data-sandbox-placeholder]').count() === 1
      && await win.locator('.csu-tool-nav [data-studio-tool="sandbox"]').count() === 1, 25_000)
    check('6 后写出的 manifest.json 会把项目当场改判成插件(Sandbox 入口随之出现)',
      beforeManifest && becomesPlugin,
      JSON.stringify({ beforeManifest, becomesPlugin, hint: '红在这里先查宿主 productsEnsure 是否把 kind 冻在首次扫盘的 sidecar 上' }))

    check('7 全程无渲染层异常', errs.length === 0, errs.join('; ').slice(0, 800))
  } catch (e) {
    check('端到端流程跑完', false, (e && e.stack) || String(e))
  } finally {
    if (app) await app.close().catch(() => {})
    stub.close()
  }

  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} 通过;夹具:${home}`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
