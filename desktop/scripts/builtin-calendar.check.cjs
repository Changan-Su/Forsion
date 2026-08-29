/**
 * 「日历 = 可拆卸的内置插件」的端到端契约(真 Electron)。
 *
 * 2026-08-27 起 Calendar Space 与它的三个视图(calendar / todo-list / calendar-config)
 * 归内置插件 builtins/calendar,设置 → Forsion 插件 里可关。关掉必须**整条不见**:
 * ribbon 图标、Space、三个视图、启动器里的入口;开回来必须原样回来;关着重启不能把用户
 * 卡在一个不存在的 Space 上(registerSpaces 的 fallback 会改写活动 Space 并落盘)。
 *
 * 开关走 storage 事件(= 设置页勾选框与跨窗同步走的同一条 applyBuiltin 路径)。
 *
 * 判据:
 *   1 默认开:ribbon 有日历图标,点进去主区是日历视图
 *   2 关掉:图标没了、日历视图不再可见、活动 Space 已切走、启动器里没有「日历/待办」卡
 *   3 开回来:图标回来,还能再进去
 *   4 关着重启:启动即不注册(ribbon 无日历),应用照常起来
 *   5 ⚠️别的 Space 的**命名布局**里留着日历面板时关插件 —— 切回去不许炸(Codex 评审 high:
 *     applyNamed 原本不做「视图均已注册」校验,fromJSON 会异步挂载已反注册的组件)
 *   6 ⚠️同上,但面板在**侧栏**:侧栏 panel 的 contentComponent 就是视图名(主区一律 '__frame'),
 *     反注册后 Dockview 的 components 表里根本没有它 —— 这条才是真会炸的那半。夹具用引擎自己
 *     产出的日历布局(含 todo-list/calendar-config 侧栏面板)搬进 space:tangu 的槽,不手搓 JSON。
 *   7 ⚠️**折叠侧栏的 stash**:6 那条靠「fromJSON 抛 → 回退 resetLayout」兜住,但 stash 不在
 *     dockview blob 里 —— 活体面板全已注册时 applyNamed 成功,未注册的 stash 项原样进 store,
 *     一展开侧栏就 openView 一个死视图。tryRestoreLayout 早有 .filter(known),applyNamed 没有。
 *
 * ⚠️ 量的是 out/ 里的产物,源码改了没 `npm run build` 就是白测。
 * 跑:npm run check:calendarplugin
 * 报「启动失败」= 有 dev 版 Electron 占着单实例锁,先把它关掉(同 check:spacerestart)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-calplugin-'))
const UD = path.join(home, 'userdata') // 同一份 user-data-dir = 同一份 localStorage,重启那程才谈得上「关着」

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** ribbon 上的 Space 名(折叠态在 title,展开态在 .rb-label)+ 日历视图可见性 + 活动 Space。 */
const SNAP = `(() => {
  const names = [...document.querySelectorAll('.rb-space')]
    .map((b) => b.getAttribute('title') || b.querySelector('.rb-label')?.textContent || '')
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.getBoundingClientRect().width > 0).length
  return {
    spaces: names,
    calIcon: names.filter((n) => n === '日历' || n === 'Calendar').length,
    calView: vis('.amx-cal'),
    active: localStorage.getItem('forsion_tangu_active_space'),
    launcher: [...document.querySelectorAll('.newtab-card-label')].map((e) => e.textContent),
  }
})()`

/** 开/关内置插件:与设置页勾选框、跨窗同步同一条路径(builtins/index 的 storage 监听 → applyBuiltin)。 */
const toggle = (on) => `(() => {
  localStorage.setItem('builtin.calendar.enabled', ${on ? "'1'" : "'0'"})
  window.dispatchEvent(new StorageEvent('storage', { key: 'builtin.calendar.enabled' }))
})()`

async function boot() {
  const app = await electron.launch({
    args: [`--user-data-dir=${UD}`, ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
  })
  const win = await app.firstWindow()
  await win.waitForSelector('#root', { timeout: 30_000 })
  await win.waitForTimeout(2500)
  for (const label of ['跳过引导', 'Skip']) {
    const b = win.locator(`text=${label}`).first()
    if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
  }
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await win.waitForTimeout(1500)
  return { app, win }
}

/** 点 ribbon 上某个 Space(折叠/展开两种形态都认),等 lazy 分块到位。 */
async function enterSpace(win, names) {
  const hit = await win.evaluate(`(() => {
    const b = [...document.querySelectorAll('.rb-space')].find((x) =>
      ${JSON.stringify(names)}.includes(x.getAttribute('title') || x.querySelector('.rb-label')?.textContent || ''))
    if (b) { b.click(); return true }
    return false
  })()`)
  await win.waitForTimeout(1800)
  return hit
}
const enterCalendar = (win) => enterSpace(win, ['日历', 'Calendar'])

/** 开启动器并**确认它真的开出来了**:点击失败或没挂载就直接判失败 ——
 *  否则 launcher=[] 会让「入口没了」的断言空跑通过(Codex 评审 medium 抓的假绿)。 */
async function openLauncher(win) {
  await win.click('.dv-new-tab')
  await win.waitForSelector('.newtab', { state: 'visible', timeout: 10_000 })
  await win.waitForTimeout(600)
}

/** 点启动器里某张卡(按标签文字)。 */
async function clickCard(win, names) {
  const hit = await win.evaluate(`(() => {
    const c = [...document.querySelectorAll('.newtab-card')].find((x) =>
      ${JSON.stringify(names)}.includes((x.querySelector('.newtab-card-label')?.textContent || '').trim()))
    if (c) { c.click(); return true }
    return false
  })()`)
  await win.waitForTimeout(1800)
  return hit
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  let { app, win } = await boot()
  const errs = []
  win.on('pageerror', (e) => errs.push(String(e && e.message ? e.message : e)))
  try {
    await enterCalendar(win)
    const s0 = await win.evaluate(SNAP)
    check('1 默认开:ribbon 有日历图标 + 点进去是日历视图', s0.calIcon === 1 && s0.calView === 1, JSON.stringify(s0))

    // 关掉(此刻正停在日历里 —— 顺带验「停在里面被关」不会把人卡住)
    await win.evaluate(toggle(false))
    await win.waitForTimeout(1500)
    await openLauncher(win) // 开启动器,看入口有没有一起消失(开不出来 = 直接抛,不许空跑)
    const off = await win.evaluate(SNAP)
    const noEntry = !off.launcher.some((n) => ['日历', 'Calendar', '待办清单', 'To-Do List'].includes(n))
    check(
      '2 关掉:图标/视图/Space 全撤,启动器入口也没了',
      off.calIcon === 0 && off.calView === 0 && off.active !== 'calendar' && noEntry,
      JSON.stringify(off),
    )

    await win.evaluate(toggle(true))
    await win.waitForTimeout(1200)
    await enterCalendar(win)
    const on = await win.evaluate(SNAP)
    check('3 开回来:图标回来且还能进去', on.calIcon === 1 && on.calView === 1, JSON.stringify(on))

    // 5 别的 Space 的**命名布局**里留着日历面板:关插件后切回去不许炸。
    //   造夹具全靠点击(不合成拖拽):Tangu Space → 启动器 → 「日历」卡 = 在主区开一张日历,
    //   再切走(切走即 saveNamed('space:tangu'),那份布局里就带着 calendar 面板了)。
    await enterSpace(win, ['Tangu'])
    await openLauncher(win)
    const carded = await clickCard(win, ['日历', 'Calendar'])
    const planted = await win.evaluate(SNAP)
    await enterSpace(win, ['Amadeus'])
    await win.evaluate(toggle(false))
    await win.waitForTimeout(1500)
    errs.length = 0
    await enterSpace(win, ['Tangu']) // ← applyNamed 吃到含 calendar 的命名布局
    await win.waitForTimeout(1200)
    const back = await win.evaluate(SNAP)
    const aliveNow = await win.evaluate(`(() => ({
      groups: document.querySelectorAll('.dv-groupview').length,
      spaces: document.querySelectorAll('.rb-space').length,
    }))()`)
    check(
      '5 别的 Space 命名布局里留着日历面板:关插件后切回去不炸',
      carded && planted.calView === 1 && back.calView === 0 && aliveNow.groups > 0 && aliveNow.spaces > 0 && errs.length === 0,
      JSON.stringify({ carded, planted: planted.calView, back: back.calView, ...aliveNow, errs: errs.slice(0, 2) }),
    )
    await win.evaluate(toggle(true))
    await win.waitForTimeout(1000)

    // 6 侧栏面板那半:把引擎刚存下的 space:calendar 布局(左 todo-list / 右 calendar-config)
    //   搬进 space:tangu 的命名槽 —— 真实 blob,不手搓;再关插件、切回 Tangu 让 applyNamed 吃它。
    await enterCalendar(win)
    await enterSpace(win, ['Amadeus']) // 切走 = saveNamed('space:calendar')
    const cloned = await win.evaluate(`(() => {
      const KEY = 'tangu2_named_layouts'
      const m = JSON.parse(localStorage.getItem(KEY) || '{}')
      const cal = m['space:calendar']
      if (!cal) return { ok: false, keys: Object.keys(m) }
      const sideTypes = ['left', 'right'].flatMap((s) => (cal.sidebars?.[s]?.stash || []).map((v) => v.type))
      const panelTypes = Object.values(cal.dockview?.panels || {}).map((p) => (p.params || {}).__type)
      m['space:tangu'] = cal
      localStorage.setItem(KEY, JSON.stringify(m))
      return { ok: true, panelTypes, sideTypes }
    })()`)
    await win.evaluate(toggle(false))
    await win.waitForTimeout(1500)
    errs.length = 0
    await enterSpace(win, ['Tangu'])
    await win.waitForTimeout(1500)
    const side = await win.evaluate(SNAP)
    const aliveSide = await win.evaluate(`(() => ({
      groups: document.querySelectorAll('.dv-groupview').length,
      spaces: document.querySelectorAll('.rb-space').length,
      panels: document.querySelectorAll('.dv-tab').length,
    }))()`)
    check(
      '6 侧栏面板版:同上,切回去仍不炸(applyNamed 必须挡掉未注册视图)',
      cloned.ok && (cloned.panelTypes || []).includes('calendar')
        && side.calView === 0 && aliveSide.groups > 0 && aliveSide.spaces > 0 && errs.length === 0,
      JSON.stringify({ cloned, calView: side.calView, ...aliveSide, errs: errs.slice(0, 2) }),
    )
    await win.evaluate(toggle(true))
    await win.waitForTimeout(1000)

    // 7 stash 那半:造一份「活体面板全已注册、但 stash 里是日历视图」的布局 ——
    //   进日历 → 收起两侧(todo-list/calendar-config 入 stash)→ 关掉主区那张日历 tab → 切走存档。
    await enterCalendar(win)
    // ⚠️两侧收起钮的类名不对称:左 = `.dv-edge-toggle`(**没有** .dv-edge-left 这个类,别照抄
    // newtab-open.check 里那句 `.dv-edge-left` —— 它被 .catch 吞掉了,实际一直是空转)。
    // 不吞错:选择器变了要当场红,不能悄悄跳过让夹具半成品混过断言。
    await win.click('.dv-edge-toggle:not(.dv-edge-right)') // 收左栏 → todo-list 入 stash
    await win.waitForTimeout(1200)
    await win.click('.dv-edge-right') // 收右栏 → calendar-config 入 stash
    await win.waitForTimeout(1200)
    // 主区那张日历**关掉**(不是收起):活体面板里不能再留未注册视图,否则 fromJSON 抛 →
    // 回退 resetLayout 会把 stash 这条路整个盖住,验不到东西。
    await win.evaluate(`(() => {
      for (const t of document.querySelectorAll('.wb-tab')) {
        if (['日历', 'Calendar'].includes((t.querySelector('.wb-tab-name')?.textContent || '').trim())) t.querySelector('.wb-tab-close')?.click()
      }
    })()`)
    await win.waitForTimeout(1500)
    await enterSpace(win, ['Amadeus'])
    const stashFix = await win.evaluate(`(() => {
      const KEY = 'tangu2_named_layouts'
      const m = JSON.parse(localStorage.getItem(KEY) || '{}')
      const cal = m['space:calendar']
      if (!cal) return { ok: false }
      const panelTypes = Object.values(cal.dockview?.panels || {}).map((p) => (p.params || {}).__type)
      const sideTypes = ['left', 'right'].flatMap((s) => (cal.sidebars?.[s]?.stash || []).map((v) => v.type))
      m['space:tangu'] = cal
      localStorage.setItem(KEY, JSON.stringify(m))
      return { ok: true, panelTypes, sideTypes }
    })()`)
    const CAL_TYPES = ['calendar', 'todo-list', 'calendar-config']
    const fixtureOk = stashFix.ok
      && !(stashFix.panelTypes || []).some((t) => CAL_TYPES.includes(t)) // 活体全已注册
      && (stashFix.sideTypes || []).some((t) => CAL_TYPES.includes(t))   // stash 里有日历视图
    await win.evaluate(toggle(false))
    await win.waitForTimeout(1500)
    errs.length = 0
    await enterSpace(win, ['Tangu'])   // applyNamed 成功(活体都在),stash 悄悄带着死视图
    await win.waitForTimeout(1200)
    await win.click('.dv-edge-right') // ← 展开:stash 里的死视图会被 openView
    await win.waitForTimeout(1500)
    const afterExpand = await win.evaluate(`(() => ({
      groups: document.querySelectorAll('.dv-groupview').length,
      spaces: document.querySelectorAll('.rb-space').length,
      deadTabs: [...document.querySelectorAll('.wb-tab-name')].filter((e) =>
        ['日历', 'Calendar', '待办清单', 'To-Do List', '日历设置', 'Calendar Settings'].includes((e.textContent || '').trim())).length,
    }))()`)
    check(
      '7 折叠侧栏 stash 里的日历视图:关插件后展开侧栏不许开出死视图',
      fixtureOk && afterExpand.deadTabs === 0 && afterExpand.groups > 0 && afterExpand.spaces > 0 && errs.length === 0,
      JSON.stringify({ fixtureOk, stashFix, ...afterExpand, errs: errs.slice(0, 2) }),
    )
    await win.evaluate(toggle(true))
    await win.waitForTimeout(1000)

    // 关着退出 → 重启:启动那条声明式闸(spaces.tsx)也得不注册
    await win.evaluate(`localStorage.setItem('builtin.calendar.enabled', '0')`)
    await win.waitForTimeout(400)
    await app.close()
    ;({ app, win } = await boot())
    const restarted = await win.evaluate(SNAP)
    check(
      '4 关着重启:启动即不注册,应用照常起来',
      restarted.calIcon === 0 && restarted.spaces.length > 0 && restarted.active !== 'calendar',
      JSON.stringify(restarted),
    )
  } finally {
    await app.close().catch(() => {})
  }

  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} 通过`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
