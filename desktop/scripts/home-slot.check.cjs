/**
 * Ribbon「主位槽」+「启动时进入」三档的端到端契约(真 Electron)。2026-08-28 用户要求的两件事:
 *   · ribbon 竖条**正中**一个固定图标格,默认放主页 Space,右键可换成别的;
 *   · 启动缺省 = 主位槽指着的那个 Space;另两档 = 上次退出的 Space / 指定 Space。
 *
 * 判据:
 *   1 主位槽在场,且**垂直居中**在 Spaces 组与命令组之间(不是贴着某一组)
 *   2 ⚠️同一个 Space 不在条上出现两次:主页只在主位槽里,上区没有它
 *   3 ⚠️右键换主位:新的进槽、旧的回上区、**回到它在用户排的序里原来那一格**,
 *     且 `forsion_tangu_ribbon_order` 一个字都没变 —— 换法必须是 addRibbonIcon 改 side,
 *     不能 removeRibbonIcon(那会把 id 从持久顺序里抹掉,换回来的图标掉到区末尾 =
 *     每换一次主位就打乱一次用户排的序)。
 *     ⚠️夹具**必须先种一份非空的持久顺序**:顺序为空(从没拖过 ribbon)时「顺序没变」恒真,
 *     removeRibbonIcon 那条错法照样通过 —— 第一版就假绿在这儿。
 *   4 启动档「主位槽」(缺省,不写键):重启后落在主位所指的 Space
 *   5 启动档「上次退出」:重启后落在退出时那个
 *   6 启动档「指定 Space」:重启后落在指定那个
 *   7 主位指向的 Space 被停用(关掉主页内置插件):主位回落到别的 Space,不空槽、不炸
 *
 * ⚠️ 量的是 out/ 里的产物,源码改了没 `npm run build` 就是白测。
 * 跑:npm run check:homeslot        截图自查:npm run check:homeslot -- --shot
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const SHOT = process.argv.includes('--shot')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-homeslot-'))
const UD = path.join(home, 'userdata') // 同一份 user-data-dir = 同一份 localStorage,才谈得上「重启」

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const SNAP = `(() => {
  const names = (sel) => [...document.querySelectorAll(sel)]
    .map((b) => b.getAttribute('title') || b.querySelector('.rb-label')?.textContent || '')
  const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, mid: r.top + r.height / 2, h: r.height } }
  return {
    top: names('.rb-top .rb-space'),
    slot: names('.rb-home .rb-space'),
    active: localStorage.getItem('forsion_tangu_active_space'),
    order: JSON.parse(localStorage.getItem('forsion_tangu_ribbon_order') || '[]'),
    slotPref: localStorage.getItem('forsion_home_slot_space'),
    geom: { topG: box('.rb-top'), homeG: box('.rb-home'), botG: box('.rb-bottom') },
  }
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
  await win.waitForTimeout(1800)
  return { app, win }
}

/** 重载渲染进程(ribbon store 只在模块装载时读一次 localStorage,种顺序必须靠 reload 生效)。 */
async function reload(win) {
  await win.reload({ waitUntil: 'domcontentloaded' })
  await win.waitForSelector('#root', { timeout: 30_000 })
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await win.waitForTimeout(1800)
}

/** 重启:写完 localStorage 再关,新一程才读得到。 */
async function restart(app) {
  await app.close()
  await new Promise((r) => setTimeout(r, 1200))
  return boot()
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
    const s0 = await win.evaluate(SNAP)
    if (SHOT) {
      // 观感自查(DESIGN.md §8):ribbon 竖条本身 + 右键换主位的菜单(唯一一块新画的界面)。
      const bar = path.join(os.tmpdir(), 'forsion-homeslot.png')
      await win.screenshot({ path: bar, clip: { x: 0, y: 0, width: 260, height: 900 } })
      console.log(`  截图(ribbon 区) → ${bar}`)
      await win.click('.rb-home .rb-space', { button: 'right' })
      await win.waitForTimeout(500)
      const menu = path.join(os.tmpdir(), 'forsion-homeslot-menu.png')
      await win.screenshot({ path: menu, clip: { x: 0, y: 200, width: 520, height: 700 } })
      console.log(`  截图(右键菜单) → ${menu}`)
      await win.keyboard.press('Escape')
      await win.evaluate(`document.body.click()`)
      await win.waitForTimeout(400)
    }
    // 1 居中:主位格中心 ≈ (上区底 + 命令区顶) / 2。两组之间的空当由它一个人的两个 auto 外边距均分。
    const g = s0.geom
    const want = g.topG && g.botG ? (g.topG.bottom + g.botG.top) / 2 : NaN
    const dy = g.homeG ? Math.abs(g.homeG.mid - want) : NaN
    check(
      '1 主位槽在场且垂直居中于 Spaces 组与命令组之间',
      s0.slot.length === 1 && Number.isFinite(dy) && dy <= 2 && g.homeG.top > g.topG.bottom && g.homeG.bottom < g.botG.top,
      JSON.stringify({ slot: s0.slot, mid: g.homeG?.mid, want, dy }),
    )
    check('2 同一个 Space 不出现两次:主页只在主位槽,上区没有它', s0.slot[0] === '主页' && !s0.top.includes('主页'), JSON.stringify({ slot: s0.slot, top: s0.top }))

    // 3 右键换主位 → 再换回来;全程持久顺序一个字都不许变,且主页回到它原来那一格。
    //   先种一份**非空**顺序(把主页放中间),否则「顺序没变」是空断言。
    const SEED = ['space:tangu', 'space:inbox', 'space:home', 'space:amadeus', 'space:calendar', 'space:coding', 'space:automation', 'space:public']
    await win.evaluate(`localStorage.setItem('forsion_tangu_ribbon_order', ${JSON.stringify(JSON.stringify(SEED))})`)
    await reload(win)
    const seeded = await win.evaluate(SNAP)
    const order0 = JSON.stringify(seeded.order)
    await win.click('.rb-home .rb-space', { button: 'right' })
    await win.waitForTimeout(500)
    await win.click('.ctx-menu button:has-text("Tangu")')
    await win.waitForTimeout(900)
    const swapped = await win.evaluate(SNAP)
    await win.click('.rb-home .rb-space', { button: 'right' })
    await win.waitForTimeout(500)
    await win.click('.ctx-menu button:has-text("主页")')
    await win.waitForTimeout(900)
    const back = await win.evaluate(SNAP)
    // 种的序里主页排在 收件箱 之后、Amadeus 之前 —— 换 Tangu 进槽后,主页必须**回到那一格**,
    // 而不是掉到末尾(掉末尾 = 用了 removeRibbonIcon 那条错法)。
    const homeAt = swapped.top.indexOf('主页')
    check(
      '3 右键换主位:新的进槽/旧的回上区且回到原格,持久顺序一个字没变',
      swapped.slot[0] === 'Tangu' && !swapped.top.includes('Tangu') && swapped.slotPref === 'tangu'
        && homeAt === swapped.top.indexOf('收件箱') + 1 && homeAt === swapped.top.indexOf('Amadeus') - 1
        && back.slot[0] === '主页' && back.top.includes('Tangu') && !back.top.includes('主页')
        && JSON.stringify(swapped.order) === order0 && JSON.stringify(back.order) === order0
        && seeded.order.length === SEED.length,
      JSON.stringify({ swappedTop: swapped.top, homeAt, backSlot: back.slot, backTop: back.top, orderStable: JSON.stringify(back.order) === order0 }),
    )

    // 4 启动档「主位槽」= 缺省(不写 forsion_default_space)。先把主位换成 Amadeus,重启应落 amadeus。
    await win.evaluate(`(() => { localStorage.removeItem('forsion_default_space'); localStorage.setItem('forsion_home_slot_space', 'amadeus') })()`)
    await win.waitForTimeout(300)
    ;({ app, win } = await restart(app))
    const b4 = await win.evaluate(SNAP)
    check('4 启动档「主位槽」(缺省):重启落在主位所指的 Space', b4.active === 'amadeus' && b4.slot[0] === 'Amadeus', JSON.stringify({ active: b4.active, slot: b4.slot }))

    // 5 启动档「上次退出」:切到 Tangu 再重启,应回 Tangu(而不是主位的 Amadeus)
    await win.evaluate(`localStorage.setItem('forsion_default_space', '__last__')`)
    await win.click('.rb-top .rb-space[title="Tangu"]')
    await win.waitForTimeout(1800)
    ;({ app, win } = await restart(app))
    const b5 = await win.evaluate(SNAP)
    check('5 启动档「上次退出」:重启落在退出时那个(不是主位)', b5.active === 'tangu', JSON.stringify({ active: b5.active }))

    // 6 启动档「指定 Space」:钉 inbox,从 Tangu 退出后重启应落 inbox
    await win.evaluate(`localStorage.setItem('forsion_default_space', 'inbox')`)
    await win.waitForTimeout(300)
    ;({ app, win } = await restart(app))
    const b6 = await win.evaluate(SNAP)
    check('6 启动档「指定 Space」:重启落在指定那个', b6.active === 'inbox', JSON.stringify({ active: b6.active }))

    // 7 主位指向的 Space 被停用:关掉主页内置插件(此时主位设的是 amadeus,先改回 home 再关)
    await win.evaluate(`(() => {
      localStorage.setItem('forsion_home_slot_space', 'home')
      localStorage.setItem('builtin.home.enabled', '0')
    })()`)
    await win.waitForTimeout(300)
    errs.length = 0
    ;({ app, win } = await restart(app))
    const b7 = await win.evaluate(SNAP)
    check(
      '7 主位指向的 Space 被停用:回落到别的 Space,不空槽不炸',
      b7.slot.length === 1 && b7.slot[0] !== '主页' && !b7.top.includes(b7.slot[0]) && errs.length === 0,
      JSON.stringify({ slot: b7.slot, top: b7.top, errs: errs.slice(0, 2) }),
    )
  } finally {
    await app.close().catch(() => {})
  }

  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} 通过`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
