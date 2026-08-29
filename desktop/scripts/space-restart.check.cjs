/**
 * 「重启回到上次退出的 Space + 当时开着的标签页」的端到端契约(真 Electron)。
 *
 * 2026-08-13:「设置 → Spaces → 启动时进入」的缺省由固定 Space(PRODUCT.defaultSpace)改成
 * 「上次退出时的 Space」。浏览器那支 check:spacerestore 守的是 Storage 层的交接语义,但它那里
 * **只有 tangu 一个 Space 注册**(inbox/amadeus/coding… 都要 host 桥)→ 跨 Space 这件事只能在这儿验。
 *
 * ⚠️2026-08-28:**缺省又改了** —— 变成「ribbon 主位槽指着的那个 Space」(用户要求,见 spaces.tsx
 * 的 startupSpacePref)。「上次退出」降级为**可选的一档**,不再是不设值时的行为。
 * 本脚本守的仍然是那一档的语义,所以现在必须**显式写 `forsion_default_space='__last__'`**
 * 再重启;不写的话第一程就被主位槽(默认=主页)接管,两条断言必红。
 *
 * 做法:切到第二个 Space → 再多开一张标签(让布局与该 Space 的**默认**不同,否则「还原」与「重建」
 * 长得一模一样、判不出来)→ 关掉进程 → 重开。
 *  1 活动 Space 还是退出时那个(旧缺省会被推回 tangu)
 *  2 主区面板还是那一批(含多开的那张;重建的话没有它)
 *
 * 需先 npm run build。用法:npm run check:spacerestart
 * 报「启动失败」= 有 dev 版 Electron 占着单实例锁,先 pkill -f "node_modules/electron/dist/Electron.app"。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-spacerestart-'))
const UD = path.join(home, 'userdata') // 同一份 user-data-dir = 同一份 localStorage,两程之间才谈得上「上次」

async function boot() {
  const app = await electron.launch({
    args: [`--user-data-dir=${UD}`, ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
  })
  const win = await app.firstWindow()
  await win.waitForSelector('#root', { timeout: 30000 })
  await win.waitForTimeout(2000)
  for (const label of ['跳过引导', 'Skip']) {
    const b = win.locator(`text=${label}`).first()
    if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
  }
  await win.waitForSelector('.wb-dockview, .dv-groupview', { timeout: 30000 })
  await win.waitForTimeout(2000)
  return { app, win }
}

/** 活动 Space + 布局键里的面板类型(panel 的 __type 随 dockview JSON 原样往返)。 */
const state = (win) => win.evaluate(() => ({
  active: localStorage.getItem('forsion_tangu_active_space'),
  panels: (() => {
    try { return Object.values(JSON.parse(localStorage.getItem('tangu2_layout_v4')).dockview.panels).map((p) => (p.params || {}).__type || p.contentComponent) } catch { return null }
  })(),
}))

;(async () => {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  let { app, win } = await boot()
  const spaces = win.locator('.rb-space')
  const n = await spaces.count()
  if (n < 2) { console.error(`ribbon 上只有 ${n} 个 Space,跨 Space 无从验起`); await app.close(); process.exit(1) }
  await spaces.nth(1).click()
  await win.waitForTimeout(2500)
  await win.locator('.dv-new-tab').first().click() // 多开一张 → 与该 Space 的默认布局不同
  await win.waitForTimeout(2500)
  // 显式选「上次退出」那一档(2026-08-28 起它不再是缺省;不写就走主位槽,验的就不是这条语义了)。
  await win.evaluate(() => localStorage.setItem('forsion_default_space', '__last__'))
  await win.waitForTimeout(300)
  const before = await state(win)
  await app.close()
  await new Promise((r) => setTimeout(r, 1500))

  ;({ app, win } = await boot())
  const after = await state(win)
  await app.close()

  const norm = (a) => JSON.stringify((a || []).slice().sort()) // panel 在 JSON 里的键序不稳定,按集合比
  const ok1 = !!after.active && after.active === before.active
  const ok2 = norm(after.panels) === norm(before.panels) && (before.panels || []).length > 0
  console.log(`${ok1 ? 'PASS' : 'FAIL'}  1 重启回到上次退出的 Space  | ${before.active} → ${after.active}`)
  console.log(`${ok2 ? 'PASS' : 'FAIL'}  2 主区面板还是上一程那批  | ${JSON.stringify(before.panels)} → ${JSON.stringify(after.panels)}`)
  console.log(ok1 && ok2 ? '\n2/2 通过' : '\n有失败')
  process.exit(ok1 && ok2 ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(1) })
