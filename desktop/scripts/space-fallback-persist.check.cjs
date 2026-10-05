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
 *  M 插件再也不回来(离线删了 / 单品变体存着别家的 id):盘上的活动 id 永远是个不存在的 Space,每一程都回落。
 *    回落 Space 自己的布局必须每程原样还原、照常存,两个命名槽都不许动
 *
 * 同一条路上的第二处(N 当对照):插件的视图比 Dockview 就绪得晚,onReady 那次还原落空,屏上摆的是回落 Space 的
 * 默认布局;补定位以前只换活动 id → 界面标着插件 Space、内容是 Tangu 的。现在补定位时把启动归档的现场补还原。
 *
 * 第三处(A / B 的后两条断言,2026-10-04 治):故障那一程把回落 Space 的默认布局存进了布局键,盘上的活动 id 却仍是
 * 插件 Space → 恢复那一程按活动 id 把它归档进 `space:<插件 Space>`,屏上也是它。正常启动里插件就位前那一两秒退出 /
 * 重载,盘上是同一个状态。治法:布局信封自己记着是给谁摆的(`space`,与布局同一次写盘),归档与补定位都按它认主;
 * 对不上的那份不进任何命名槽,目标 Space 回来时补还原它自己的归档。
 *
 * 第四处(P / H / Q / S / T / R / G,2026-10-04 实报):「启动时进入」**点名**了插件 Space(固定档,或主位档下把它放进了主位槽),启动时它还没
 * 注册 → 启动目标回落成产品默认 / 主页。以前这个回落值由 bootstrapEngine 的冷定位写了盘,补定位也拿它当目标:插件比第一趟
 * 配方装载晚装完的那一程(真 Electron 重载 60 次里 2 次,余量只有几毫秒),补定位对着回落 Space 结了案,插件 Space 随后注册上来也
 * 没人再把用户带过去 —— 窗口停在 Tangu,盘上的活动 Space = tangu。
 *  P 固定档点名插件 Space,插件比第一趟配方装载晚装完:回落不落盘,插件 Space 一就位就把人带过去
 *  H 同 P,但走的是缺省档(主位槽):主位槽里放着插件 Space
 *  Q 同 P,回落期间用户自己点了别的 Space:插件 Space 就位后不许把他拽走
 *  S 同 Q,但他切走之后又切回了回落 Space:照样不拽(用户接管过导航就不再补定位,不是只看他最后停在哪)
 *  T 同 S,但第一趟配方装载也慢:那一去一回都发生在第一趟补定位之前(从启动落在回落 Space 那一刻就得记,不能等第一趟)
 *  R 同 P,这一程插件 Space 的配方升了版本(要迁移重建),回落期间用户在回落 Space 里多开了一张标签:
 *    这张标签得存进回落 Space 自己的槽,不能跟着「清布局键 + 重建」一起丢
 *  G 固定档点名的插件再也不回来(同 M 的五条):每一程都回落,盘上的活动 id 不被回落值盖掉
 *
 * 需先 npm run build。用法:npm run check:spacefallback   只跑某几条:-- --only=A,C
 * 报「启动失败」= 有 dev 版 Electron 占着单实例锁(本仪器不代为 pkill)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { enterSpace, sleep } = require('./lib/uiux-electron.cjs')

const ROOT = path.join(__dirname, '..')
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean)
const BOARD = 'plugin:probe-plug:board'
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
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
  let owner = null
  try { owner = JSON.parse(localStorage.getItem('tangu2_layout_v4')).space ?? null } catch { /* 空 */ }
  return { active: localStorage.getItem('forsion_tangu_active_space'), owner, layoutKey, named, board: !!document.querySelector('.probe-board') }
})
const brief = (s) => JSON.stringify({ active: s.active, owner: s.owner, layoutKey: s.layoutKey, tangu: s.named['space:tangu'], probe: s.named['space:probe-space'], board: s.board })

/** 第一程:进 Tangu(让 space:tangu 有一份它自己的存档作基线)→ 进插件 Space → 退出时人就在插件 Space 里。 */
async function firstRun(home, pref, homeSlot) {
  const { app, win } = await boot(home)
  try {
    if (pref) await win.evaluate((p) => localStorage.setItem('forsion_default_space', p), pref)
    if (homeSlot) await win.evaluate((p) => localStorage.setItem('forsion_home_slot_space', p), homeSlot)
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

/** 把主进程的一个 invoke 通道拖慢。拖「列外置插件」(plugins:list)→ 插件比第一趟 Space 配方装载晚装完,配方那一趟过不了
 *  「视图已注册」的闸:正常启动里两者只差几毫秒(实测余量 1–19ms),机器一忙就翻过来,这里把它钉成必然。拖「列 Space 配方」
 *  (spaces:list)→ 第一趟补定位来得晚。公开 API 拿不到已注册的 handler,只能走 Electron 内部的 handler 表 —— 表不在了就抛错,
 *  不装绿。主进程不随渲染层重载重启,所以拖慢对之后每次重载都生效。 */
const slowIpc = (app, channel, ms) => app.evaluate(({ ipcMain }, [ch, delay]) => {
  const table = ipcMain._invokeHandlers
  const real = table && table.get(ch)
  if (!real) throw new Error(`ipcMain._invokeHandlers 里没有 ${ch}:Electron 内部结构变了,得换个法子拖慢它`)
  table.set(ch, async (...a) => { await new Promise((r) => setTimeout(r, delay)); return real(...a) })
}, [channel, ms])
const PLUGIN_DELAY = 1500

/** 页面脚本跑之前挂上:这一程里每一次写盘上的活动 Space 都记下来(回落值有没有落过盘,事后看终值看不出来)。 */
const WATCH_ACTIVE = `(() => {
  const log = (window.__activeWrites = [])
  const set = Storage.prototype.setItem
  Storage.prototype.setItem = function (k, v) { if (k === 'forsion_tangu_active_space') log.push(String(v)); return set.apply(this, arguments) }
})()`

/** S / T:切去别的内置 Space,再切回回落的 Tangu,两下都赶在插件装完之前。S 里这一去一回在补定位第一趟(回落那一趟,实测
 *  开机后 0.2–0.45s)之后;T 把配方装载也拖慢,让它们落在第一趟之前。 */
const AWAY_AND_BACK = `(() => {
  let step = 0
  const tick = () => {
    const other = [...document.querySelectorAll('.rb-slot[data-id^="space:"]')]
      .find((el) => !['space:tangu', 'space:probe-space'].includes(el.dataset.id) && el.querySelector('.rb-space'))
    const tangu = document.querySelector('.rb-slot[data-id="space:tangu"] .rb-space')
    const t = performance.now()
    const late = !!document.querySelector('.probe-board')
    if (other && tangu && step === 0 && t >= 800) { step = 1; window.__earlySwitch = { to: other.dataset.id.slice(6), late }; other.querySelector('.rb-space').click() }
    else if (tangu && step === 1 && t >= 1300) { window.__earlySwitch.back = true; window.__earlySwitch.late = window.__earlySwitch.late || late; return tangu.click() }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`

/** R:回落期间(屏上是 Tangu 的布局)在主区多开一张标签。 */
const FALLBACK_TAB = `(() => {
  const tick = () => {
    const b = document.querySelector('.dv-new-tab')
    if (!b || performance.now() < 800) return requestAnimationFrame(tick)
    window.__earlySwitch = { tab: true, late: !!document.querySelector('.probe-board') }
    b.click()
  }
  requestAnimationFrame(tick)
})()`

/** P / H / Q / S / T / R:人在插件 Space 里 → 重载,这一程插件晚装完。 */
async function runLatePlugin(key, { title, pref, homeSlot, probe: probeScript, stays, bumpRecipe, delay = PLUGIN_DELAY, slowSpaces = 0 }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `forsion-spacefallback-${key}-`))
  seed(home)
  console.log(`\n── ${key} ${title}`)
  const { app, win, before } = await firstRun(home, pref, homeSlot)
  console.log(`  重载前  ${brief(before)}`)
  const baseline = JSON.stringify(before.named['space:tangu'])
  let after, writes, probe, registered
  try {
    if (bumpRecipe) { // 配方换版本 → 这一程注册时 migrateRecipeLayout 丢掉它的命名槽、记成待迁移
      const file = path.join(home, 'plugins/probe-plug/spaces/probe-space/space.json')
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), version: '1.0.1' }))
    }
    await slowIpc(app, 'plugins:list', delay)
    if (slowSpaces) await slowIpc(app, 'spaces:list', slowSpaces)
    await app.context().addInitScript(WATCH_ACTIVE)
    if (probeScript) await app.context().addInitScript(probeScript)
    await win.reload({ waitUntil: 'domcontentloaded' }) // 渲染层重载 = 一次冷启动(BOOT_ACTIVE_SPACE_ID 重新取快照),同 dev 里的 ⌘R
    await win.waitForSelector('.wb-dockview, .dv-groupview', { timeout: 30000 })
    await sleep(delay + 2 * slowSpaces + 4500) // 插件装完之后还有一趟配方装载
    after = await state(win)
    writes = await win.evaluate(() => window.__activeWrites || null)
    probe = await win.evaluate(() => window.__earlySwitch || null)
    // 「没被拽走」只有在插件 Space 这一程确实注册上来了才作数(它没来的话谁也拽不动):状态取完之后点进去验一下
    if (stays) registered = await enterSpace(win, 'probe-space', { timeout: 4000 })
  } finally {
    await app.close().catch(() => {})
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  console.log(`  重载后  ${brief(after)}  这一程写过的活动 Space=${JSON.stringify(writes)}${probeScript ? `  探针=${JSON.stringify(probe)}` : ''}`)

  // 插件拖慢了 1.5s 以上,探针没有理由赶不上 → 没赶上算红,不算「这一轮不作数」
  if (probeScript) check(`${key} 探针赶在插件 Space 就位之前动了手`, !!probe && !probe.late && (stays !== 'tangu' || probe.back), JSON.stringify(probe))
  if (stays) {
    const at = stays === 'tangu' ? 'tangu' : probe && probe.to
    check(`${key} 人留在自己选的 Space,没被拽去插件 Space`, after.active === at && !after.board, `该在 ${at} → active=${after.active} board=${after.board}`)
    check(`${key} 插件 Space 这一程确实注册上来了(上一条不是假绿)`, registered === true, `点得进去=${registered}`)
    check(`${key} space:probe-space 还是插件 Space 自己那份`, (after.named['space:probe-space'] || []).includes(BOARD), `space:probe-space=${JSON.stringify(after.named['space:probe-space'])}`)
    return
  }
  check(`${key} 插件 Space 就位后把人带了过去`, after.active === 'probe-space' && after.board, `active=${after.active} board=${after.board}`)
  check(`${key} 屏上是插件 Space 自己的面板`, (after.layoutKey || []).includes(BOARD) && after.owner === 'probe-space', `owner=${after.owner} layoutKey=${JSON.stringify(after.layoutKey)}`)
  check(`${key} 回落期间没把回落 Space 写盘`, !!writes && writes.every((w) => w === 'probe-space'), `这一程写过=${JSON.stringify(writes)}`)
  if (bumpRecipe) {
    check(`${key} 回落期间在 Tangu 里开的那张标签存进了 space:tangu`, (after.named['space:tangu'] || []).includes('launcher'), `space:tangu=${JSON.stringify(after.named['space:tangu'])} 基线=${baseline}`)
    return
  }
  check(`${key} space:tangu 还是 Tangu 自己那份`, JSON.stringify(after.named['space:tangu']) === baseline, `space:tangu=${JSON.stringify(after.named['space:tangu'])} 基线=${baseline}`)
  check(`${key} space:probe-space 还是插件 Space 自己那份`, (after.named['space:probe-space'] || []).includes(BOARD), `space:probe-space=${JSON.stringify(after.named['space:probe-space'])}`)
}
const LATE = {
  P: { title: '固定档点名插件 Space,插件比第一趟配方装载晚装完', pref: 'probe-space' },
  H: { title: '同 P,缺省档(主位槽里放着插件 Space)', pref: null, homeSlot: 'probe-space' },
  Q: { title: '同 P,回落期间用户自己点了别的 Space', pref: 'probe-space', probe: EARLY_SWITCH, stays: 'clicked' },
  S: { title: '同 Q,但他切走之后又切回了回落 Space', pref: 'probe-space', probe: AWAY_AND_BACK, stays: 'tangu', delay: 3000 },
  T: { title: '同 S,第一趟配方装载也慢(一去一回都在第一趟补定位之前)', pref: 'probe-space', probe: AWAY_AND_BACK, stays: 'tangu', delay: 3500, slowSpaces: 2000 },
  R: { title: '同 P,这一程插件 Space 的配方升了版本,回落期间用户在 Tangu 里多开了一张标签', pref: 'probe-space', probe: FALLBACK_TAB, bumpRecipe: true },
}

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

/** M:故障那一程之后再来一程、插件仍然没有。第一程在回落 Space 里多开一张标签(与默认布局区分开),第二程必须原样回来。 */
async function runGone(M = 'M', pref = '__last__') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `forsion-spacefallback-${M}-`))
  seed(home)
  console.log(`\n── ${M} 插件再也不回来${pref === '__last__' ? '' : '(固定档点名的就是它)'}`)
  let { app, win, before } = await firstRun(home, pref)
  console.log(`  退出前  ${brief(before)}`)
  const baseline = JSON.stringify(before.named['space:tangu'])
  await app.close()
  await sleep(1500)
  fs.renameSync(path.join(home, 'plugins/probe-plug'), path.join(home, 'probe-plug.off'))
  const newTab = async () => { await win.locator('.dv-new-tab').first().click(); await sleep(2000) }
  ;({ app, win } = await boot(home))
  const built = await state(win)
  await newTab()
  const first = await state(win)
  console.log(`  第一程  ${brief(built)} → 多开一张 ${JSON.stringify(first.layoutKey)}`)
  await app.close()
  await sleep(1500)
  ;({ app, win } = await boot(home))
  const second = await state(win)
  await newTab()
  const third = await state(win)
  console.log(`  第二程  ${brief(second)} → 再开一张 ${JSON.stringify(third.layoutKey)}`)
  await app.close()
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }

  const grew = (a, b) => !!a && !!b && b.length === a.length + 1
  check(`${M} 盘上的活动 Space 始终没被回落值盖掉`, first.active === 'probe-space' && third.active === 'probe-space', `active=${first.active} → ${third.active}`)
  check(`${M} 布局键记着它是回落 Space 的`, first.owner === 'tangu' && third.owner === 'tangu', `owner=${first.owner} → ${third.owner}`)
  check(`${M} 回落 Space 的布局第二程原样还原(多开的那张还在,不是重建的默认)`, grew(built.layoutKey, first.layoutKey) && JSON.stringify(second.layoutKey) === JSON.stringify(first.layoutKey), `默认=${JSON.stringify(built.layoutKey)} 第一程=${JSON.stringify(first.layoutKey)} 第二程=${JSON.stringify(second.layoutKey)}`)
  check(`${M} 第二程里的改动照常存盘`, grew(second.layoutKey, third.layoutKey), `${JSON.stringify(second.layoutKey)} → ${JSON.stringify(third.layoutKey)}`)
  check(`${M} 两个命名槽都没被动`, JSON.stringify(third.named['space:tangu']) === baseline && (third.named['space:probe-space'] || []).includes(BOARD), `space:tangu=${JSON.stringify(third.named['space:tangu'])} space:probe-space=${JSON.stringify(third.named['space:probe-space'])}`)
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
  check(`${key} space:probe-space 还是插件 Space 自己那份`, (after.named['space:probe-space'] || []).includes(BOARD), `space:probe-space=${JSON.stringify(after.named['space:probe-space'])}`)
  if (pref === '__last__') {
    check(`${key} 回到插件 Space`, after.active === 'probe-space', `active=${after.active}`)
    check(`${key} 屏上是插件 Space 自己的面板`, after.board && (after.layoutKey || []).includes(BOARD), `board=${after.board} layoutKey=${JSON.stringify(after.layoutKey)}`)
  }
}

;(async () => {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  for (const key of Object.keys(SCENARIOS)) if (!ONLY.length || ONLY.includes(key)) await run(key)
  if (!ONLY.length || ONLY.includes('E')) await runEarlySwitch()
  if (!ONLY.length || ONLY.includes('M')) await runGone()
  for (const key of Object.keys(LATE)) if (!ONLY.length || ONLY.includes(key)) await runLatePlugin(key, LATE[key])
  if (!ONLY.length || ONLY.includes('G')) await runGone('G', 'probe-space')
  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} 通过`)
  process.exit(bad ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
