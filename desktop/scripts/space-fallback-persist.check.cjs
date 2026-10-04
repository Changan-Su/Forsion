/**
 * 「启动期的回落 Space 不落盘」的端到端契约(真 Electron 多程,同一份 user-data-dir)。
 *
 * 病(2026-10-03 用户 dev 现场,只读 CDP 探针):活动 Space 记成了 `tangu`,`space:tangu` 槽里却是
 * 视频工作室插件的面板 —— 重启后人在「Tangu」、看到的是插件的布局,Tangu 自己的布局丢了。
 * 根因:`registerSpaces()` 开机时把「此刻还没注册」的活动 id 归一成产品默认,并**写进了 localStorage**。
 * 插件 / 用户 Space 是异步注册的,正常由 settleAsyncStartupSpace 写回真 id;但只要写回没发生,
 * 盘上就留下「活动 id = tangu、布局键 = 插件 Space 的现场」,下次启动 adoptSpaceLayoutCold 把这份
 * 现场归档进 `space:tangu`。写回不发生的三种情形,各一条:
 *  A 某一程插件整个没装上(重装到一半 / 加载失败)
 *  B 某一程插件的视图注册了、Space 配方却没过闸(开发中的 space.json 写坏了)
 *  C 人在插件 Space 时开了设置(浮窗):卫星窗也跑 registerSpaces,那里没人写回 —— 不需要任何故障
 *  D 同 C,但「启动时进入」是缺省档(主位槽):落点没错,`space:tangu` 照样被写坏
 *  N 对照:什么故障都没有的正常重启(A/B/C 修好之后都应当收敛成它)
 *  E 重载后、插件 Space 还没就位的那一两秒里用户自己点了别的 Space:补定位不许再把他拽回去、拿归档盖掉他选的现场
 *
 * 同一条路上的第二处(N 当对照):插件的视图比 Dockview 就绪得晚,onReady 那次还原落空,屏上摆的是回落 Space 的
 * 默认布局;补定位以前只换活动 id → 界面标着插件 Space、内容是 Tangu 的。现在补定位时把启动归档的现场补还原。
 *
 * 还没治的(KNOWN,不计入结果;`--strict` 才算失败):A / B 故障那一程把回落 Space 的默认布局存进了布局键,
 * 盘上的活动 id 却仍是插件 Space → 恢复那一程把它归档进 `space:<插件 Space>`,屏上也是它。要治得让布局键自己
 * 记着「是给谁摆的」(或故障那一程收尾时正式落回回落 Space 并记下要回去的地方)。
 *
 * 需先 npm run build。用法:npm run check:spacefallback   只跑某几条:-- --only=A,C   连 KNOWN 一起算:-- --strict
 * 报「启动失败」= 有 dev 版 Electron 占着单实例锁(本仪器不代为 pkill)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { enterSpace, sleep } = require('./lib/uiux-electron.cjs')

const ROOT = path.join(__dirname, '..')
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean)
const STRICT = process.argv.includes('--strict')
const BOARD = 'plugin:probe-plug:board'
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
/** 已知没治的那半(见文件头):照样打印,`--strict` 才计入。 */
const known = (name, ok, detail) => {
  if (ok || STRICT) return check(name, ok, detail)
  console.log(`KNOWN ${name}${detail ? '  | ' + detail : ''}`)
}

/** 一个带视图 + 内嵌 Space 的最小插件。 */
function seed(home) {
  const write = (rel, data) => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data) }
  write('plugins/probe-plug/manifest.json', JSON.stringify({ id: 'probe-plug', name: 'Probe', version: '1.0.0', minAppVersion: '0.0.1' }))
  write('plugins/probe-plug/main.js', `ctx.registerView({ id: 'board', title: 'Probe board', mount(el) { el.innerHTML = '<div class="probe-board">probe board</div>' } })\n`)
  write('plugins/probe-plug/spaces/probe-space/space.json', JSON.stringify({
    id: 'probe-space', name: { zh: '探针空间', en: 'Probe space' }, icon: 'star', version: '1.0.0',
    layout: { main: [{ type: BOARD, pinned: true }], left: [], right: [] },
    requires: { views: [BOARD] },
  }))
}

async function boot(home) {
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1', TANGU_HARNESS_QUIET: '1' },
  })
  const win = await app.firstWindow()
  await win.waitForSelector('#root', { timeout: 30000 })
  await sleep(2000)
  for (const label of ['跳过引导', 'Skip']) {
    const b = win.locator(`text=${label}`).first()
    if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
  }
  await win.waitForSelector('.wb-dockview, .dv-groupview', { timeout: 30000 })
  await sleep(4000) // 插件装载 + 异步 Space 就位 + 布局落盘
  return { app, win }
}

/** 活动 Space(盘上)+ 布局键与各命名槽里的面板类型 + 插件视图是否真挂在屏上。 */
const state = (win) => win.evaluate(() => {
  const panels = (blob) => { try { return Object.values(blob.dockview.panels).map((p) => (p.params || {}).__type || p.contentComponent).sort() } catch { return null } }
  const named = {}
  try { for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem('tangu2_named_layouts') || '{}'))) named[k] = panels(v) } catch { /* 坏值当空 */ }
  let layoutKey = null
  try { layoutKey = panels(JSON.parse(localStorage.getItem('tangu2_layout_v4'))) } catch { /* 空 */ }
  return { active: localStorage.getItem('forsion_tangu_active_space'), layoutKey, named, board: !!document.querySelector('.probe-board') }
})
const brief = (s) => JSON.stringify({ active: s.active, layoutKey: s.layoutKey, tangu: s.named['space:tangu'], probe: s.named['space:probe-space'], board: s.board })

/** 第一程:进 Tangu(让 space:tangu 有一份它自己的存档作基线)→ 进插件 Space → 退出时人就在插件 Space 里。 */
async function firstRun(home, pref) {
  const { app, win } = await boot(home)
  try {
    if (pref) await win.evaluate((p) => localStorage.setItem('forsion_default_space', p), pref)
    if (!(await enterSpace(win, 'tangu', { timeout: 8000 }))) throw new Error('进不了 Tangu Space')
    await sleep(1500)
    let entered = false
    for (let i = 0; i < 10 && !entered; i++) entered = await enterSpace(win, 'probe-space', { timeout: 2000 })
    if (!entered) throw new Error('插件 Space 没上 ribbon / 点不进去')
    await sleep(2000)
    return { app, win, before: await state(win) }
  } catch (e) {
    await app.close().catch(() => {}) // 漏关的话它占着单实例锁,后面每条都报「启动失败」
    throw e
  }
}

const SCENARIOS = {
  N: { title: '对照:什么故障都没有,正常重启' },
  A: { title: '某一程插件整个没装上', off: (home) => fs.renameSync(path.join(home, 'plugins/probe-plug'), path.join(home, 'probe-plug.off')), on: (home) => fs.renameSync(path.join(home, 'probe-plug.off'), path.join(home, 'plugins/probe-plug')) },
  B: { title: '某一程 Space 配方没过闸(视图照常注册)', off: (home) => fs.renameSync(path.join(home, 'plugins/probe-plug/spaces/probe-space/space.json'), path.join(home, 'space.json.off')), on: (home) => fs.renameSync(path.join(home, 'space.json.off'), path.join(home, 'plugins/probe-plug/spaces/probe-space/space.json')) },
  C: { title: '人在插件 Space 时开了设置浮窗', floating: true },
  D: { title: '同 C,「启动时进入」= 缺省(主位槽)', floating: true, pref: null },
}

/** E:页面脚本跑之前种一个探针 —— ribbon 一出现就点一个内置 Space(比插件装完早;不能点 Tangu,那一刻内存里的
 *  活动 Space 正是回落的 Tangu,点它是空操作),记下点了谁、点的那一刻插件视图挂没挂上。 */
const EARLY_SWITCH = `(() => {
  const tick = () => {
    const slot = [...document.querySelectorAll('.rb-slot[data-id^="space:"]')]
      .find((el) => !['space:tangu', 'space:probe-space'].includes(el.dataset.id) && el.querySelector('.rb-space'))
    if (!slot) return requestAnimationFrame(tick)
    window.__earlySwitch = { to: slot.dataset.id.slice(6), late: !!document.querySelector('.probe-board') }
    slot.querySelector('.rb-space').click()
  }
  requestAnimationFrame(tick)
})()`

async function runEarlySwitch() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-spacefallback-E-'))
  seed(home)
  console.log('\n── E 补定位之前用户自己切了 Space')
  const { app, win, before } = await firstRun(home, '__last__')
  console.log(`  重载前  ${brief(before)}`)
  await app.context().addInitScript(EARLY_SWITCH)
  await win.reload({ waitUntil: 'domcontentloaded' }) // 渲染层重载 = 一次冷启动(BOOT_ACTIVE_SPACE_ID 重新取快照),同 dev 里的 ⌘R
  await win.waitForSelector('.wb-dockview, .dv-groupview', { timeout: 30000 })
  await sleep(6000)
  const after = await state(win)
  const probe = await win.evaluate(() => window.__earlySwitch || null)
  console.log(`  重载后  ${brief(after)}  探针=${JSON.stringify(probe)}`)
  await app.close()
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
  if (!probe || probe.late) return console.log(`SKIP  E 探针没赶在插件 Space 就位之前点到(${JSON.stringify(probe)}),这一轮不作数`)
  check('E 人留在自己点的 Space,没被拽回插件 Space', after.active === probe.to && !after.board, `点了 ${probe.to} → active=${after.active} board=${after.board}`)
  check('E 屏上不是插件 Space 的归档', !!after.layoutKey && !after.layoutKey.includes(BOARD), `layoutKey=${JSON.stringify(after.layoutKey)}`)
  check('E space:probe-space 还是插件 Space 自己那份', (after.named['space:probe-space'] || []).includes(BOARD), `space:probe-space=${JSON.stringify(after.named['space:probe-space'])}`)
}

async function run(key) {
  const sc = SCENARIOS[key]
  const pref = 'pref' in sc ? sc.pref : '__last__'
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `forsion-spacefallback-${key}-`))
  seed(home)
  console.log(`\n── ${key} ${sc.title}`)
  let { app, win, before } = await firstRun(home, pref)
  console.log(`  退出前  ${brief(before)}`)
  const baseline = JSON.stringify(before.named['space:tangu'])
  if (sc.floating) {
    await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: '设置', builtin: 'settings', params: { tab: null } }))
    await sleep(4000)
    const during = await state(win)
    console.log(`  开浮窗后  ${brief(during)}`)
    check(`${key} 卫星窗启动不改写盘上的活动 Space`, during.active === 'probe-space', `active=${during.active}`)
  }
  await app.close()
  await sleep(1500)
  if (sc.off) {
    sc.off(home)
    ;({ app, win } = await boot(home))
    const broken = await state(win)
    console.log(`  故障那一程  ${brief(broken)}`)
    check(`${key} 故障那一程不把回落 Space 写成「上次退出」`, broken.active === 'probe-space', `active=${broken.active}`)
    await app.close()
    await sleep(1500)
    sc.on(home)
  }
  ;({ app, win } = await boot(home))
  const after = await state(win)
  console.log(`  恢复后  ${brief(after)}`)
  await app.close()
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }

  const tangu = after.named['space:tangu']
  check(`${key} space:tangu 还是 Tangu 自己那份(没混进插件面板)`, !!tangu && !tangu.includes(BOARD) && JSON.stringify(tangu) === baseline, `space:tangu=${JSON.stringify(tangu)} 基线=${baseline}`)
  // 有故障那一程的两条(A / B):插件 Space 自己的槽与屏上内容还没治,见文件头
  const slot = sc.off ? known : check
  slot(`${key} space:probe-space 还是插件 Space 自己那份`, (after.named['space:probe-space'] || []).includes(BOARD), `space:probe-space=${JSON.stringify(after.named['space:probe-space'])}`)
  if (pref === '__last__') {
    check(`${key} 回到插件 Space`, after.active === 'probe-space', `active=${after.active}`)
    slot(`${key} 屏上是插件 Space 自己的面板`, after.board && (after.layoutKey || []).includes(BOARD), `board=${after.board} layoutKey=${JSON.stringify(after.layoutKey)}`)
  }
}

;(async () => {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  for (const key of Object.keys(SCENARIOS)) if (!ONLY.length || ONLY.includes(key)) await run(key)
  if (!ONLY.length || ONLY.includes('E')) await runEarlySwitch()
  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} 通过`)
  process.exit(bad ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
