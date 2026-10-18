/**
 * Space 的默认主页(SpaceDefinition.mainPage / 配方 layout.main 条目的 "mainPage": true)端到端契约(真 Electron)。
 *
 * 2026-10-18 用户定:「home page 就应该默认打开 home page view,如果之前在 home page 打开了其他 view 再切回来,
 * 应该还是 home page。当然,space 默认还是上次打开的 view」。
 *
 *  1 主页里多开一个标签(新标签页,到前台)→ 切到 Tangu 再切回 → 前台是主页本体;多开的那个标签还在(只退到后台)
 *  2 人已在主页、前台是那个标签 → 再点一次主页图标 → 回到主页本体
 *  3 对照:Tangu 没声明默认主页 → 同样的往返后前台仍是上次那个标签(缺省「还原上次」没被波及)
 *  4 插件配方 Space(异步注册)写了 "mainPage": true → 同样的往返后前台是它
 *  5 前台停在那个标签上退出(启动档「上次退出」)→ 重启进主页,前台是主页本体,那个标签还在
 *
 * 需先 npm run build。用法:npm run check:spacemainpage
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')

const ROOT = path.join(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-spacemainpage-'))
const UD = path.join(home, 'userdata')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function boot() {
  const app = await electron.launch({
    args: [`--user-data-dir=${UD}`, '--lang=zh-CN', ROOT],
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
  await win.waitForTimeout(2500)
  return { app, win }
}

/** 主区(不带图标页签的组)的标签文字 + 前台那个 + 主页本体看不看得见。 */
const view = (win) => win.evaluate(() => {
  const groups = [...document.querySelectorAll('.dv-groupview')].filter((g) => g.getBoundingClientRect().height > 0 && !g.querySelector('.wb-tab--icon'))
  const tabs = groups.flatMap((g) => [...g.querySelectorAll('.dv-tab')].map((t) => (t.textContent || '').trim()))
  const front = groups.flatMap((g) => [...g.querySelectorAll('.dv-tab.dv-active-tab')].map((t) => (t.textContent || '').trim()))
  const hp = [...document.querySelectorAll('.hp-root')].some((el) => el.getBoundingClientRect().height > 0)
  return { active: localStorage.getItem('forsion_tangu_active_space'), tabs, front, hp }
})
const clickSpace = async (win, id) => {
  const ok = await win.evaluate((sid) => {
    const b = [...document.querySelectorAll(`.rb [data-space-id="${sid}"]`)].find((x) => x.getBoundingClientRect().height > 0)
    if (b) b.click()
    return !!b
  }, id)
  await sleep(1800)
  return ok
}
const newTab = async (win) => { await win.locator('.dv-new-tab').first().click(); await sleep(1500) }
/** 点主区里文字匹配的标签(切到后台的那个)。 */
const clickTab = async (win, text) => {
  await win.evaluate((t) => {
    const el = [...document.querySelectorAll('.dv-groupview')].filter((g) => !g.querySelector('.wb-tab--icon'))
      .flatMap((g) => [...g.querySelectorAll('.dv-tab')]).find((x) => (x.textContent || '').trim() === t)
    el?.click()
  }, text)
  await sleep(1200)
}

const results = []
const check = (name, ok, detail) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`) }

;(async () => {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  // 4 的夹具:纯数据配方 Space,主区是固定 + 默认主页的大纲,配方走异步 loadUserSpaces
  fs.mkdirSync(path.join(home, 'spaces', 'probe'), { recursive: true })
  fs.writeFileSync(path.join(home, 'spaces', 'probe', 'space.json'), JSON.stringify({
    id: 'probe-mainpage', name: { zh: '探针主页', en: 'Probe main page' }, icon: 'star', version: '1.0.0',
    layout: { main: [{ type: 'outline', pinned: true, mainPage: true }], left: [], right: [] },
  }), 'utf8')

  let { app, win } = await boot()
  try {
    // ── 1 主页:多开一个标签 → 切走 → 切回 ──
    check('0 ribbon 上有主页 / Tangu', await clickSpace(win, 'home') && (await view(win)).hp, JSON.stringify(await view(win)))
    await newTab(win)
    const opened = await view(win)
    const extra = opened.front[0]
    check('1a 主页里多开的标签到了前台(主页本体被盖住)', !opened.hp && opened.tabs.length === 2, JSON.stringify(opened))
    await clickSpace(win, 'tangu')
    await clickSpace(win, 'home')
    const back = await view(win)
    check('1b 切回主页 → 前台是主页本体,多开的标签还在', back.hp && back.tabs.length === 2 && back.tabs.includes(extra) && !back.front.includes(extra), JSON.stringify(back))

    // ── 2 人在主页里、前台是那个标签 → 再点一次主页 ──
    await clickTab(win, extra)
    const onExtra = await view(win)
    await clickSpace(win, 'home')
    const reclick = await view(win)
    check('2 再点一次主页图标 → 回到主页本体', !onExtra.hp && reclick.hp && reclick.active === 'home', JSON.stringify({ onExtra, reclick }))

    // ── 3 对照:Tangu 没有默认主页 → 还原上次的前台 ──
    await clickSpace(win, 'tangu')
    await newTab(win)
    const tBefore = await view(win)
    await clickSpace(win, 'home')
    await clickSpace(win, 'tangu')
    const tAfter = await view(win)
    check('3 对照:Tangu 往返后前台仍是上次那个标签', tBefore.front.length === 1 && JSON.stringify(tAfter.front) === JSON.stringify(tBefore.front) && tAfter.tabs.length === tBefore.tabs.length,
      JSON.stringify({ tBefore, tAfter }))

    // ── 4 插件配方的 "mainPage": true ──
    const entered = await clickSpace(win, 'probe-mainpage')
    const pFirst = await view(win)
    await newTab(win)
    const pOpened = await view(win)
    await clickSpace(win, 'home')
    await clickSpace(win, 'probe-mainpage')
    const pBack = await view(win)
    check('4 配方 Space 的 mainPage:往返后前台是它,多开的标签还在', entered && pFirst.front.length === 1 && JSON.stringify(pOpened.front) !== JSON.stringify(pFirst.front)
      && JSON.stringify(pBack.front) === JSON.stringify(pFirst.front) && pBack.tabs.length === 2, JSON.stringify({ pFirst, pOpened, pBack }))

    // ── 5 前台停在多开的标签上退出 → 重启 ──
    await clickSpace(win, 'home')
    await clickTab(win, extra)
    await win.evaluate(() => localStorage.setItem('forsion_default_space', '__last__'))
    const exitState = await view(win)
    await sleep(800)
    await app.close()
    await sleep(1500)
    ;({ app, win } = await boot())
    const cold = await view(win)
    check('5 前台停在别的标签上退出 → 重启进主页先看到主页本体,那个标签还在', !exitState.hp && cold.active === 'home' && cold.hp && cold.tabs.includes(extra),
      JSON.stringify({ exitState, cold }))
  } finally {
    await app.close().catch(() => {})
  }
  const pass = results.filter(Boolean).length
  console.log(`\n${pass}/${results.length} 通过`)
  process.exit(pass === results.length ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(1) })
