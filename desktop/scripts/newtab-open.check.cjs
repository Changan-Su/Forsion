/**
 * 「＋ 新标签页里开东西,就该开在这个标签」的端到端契约(真 Electron)。
 *
 * 用户实报(2026-08-16):「开着 chat A 的情况下 new tab,然后选新对话或者别的会话,
 * 他们都会直接替换 A chatview,而不是在第二个 new tab 里面打开。」
 * 根因:所有「新对话」入口都写 `openView('chat', {followActive:true, reuseKey:'primary'})`,
 * 而 singleton 的复用分支会直接 setActive 到已有的主聊天 —— 你站在哪个标签它根本不看,
 * 于是空白标签一直空着,老聊天反被 updateParameters 清成新对话。
 *
 * 判据(修复前的实测:③ 三个标签、「新建标签页」还在、聊天数 1 —— 即老聊天被顶掉、新标签白开):
 *   1 点 ＋ 之后确实有一张可见的空白启动器
 *   2 在里面点「新对话」→ 启动器不再占着一个标签(它自己变成了聊天)
 *   3 聊天在场且可见,且主区标签没有净增(不留一个没人用的空白标签)
 *
 * 启动器的分段(2026-10-09 起:搜索 / 最近使用 / 新建 / 打开 / 侧栏面板,一个 Space 一格):
 *   A 四段都在;「新建」里的项不可拖,「打开」里的格子可拖;Tangu 自己不出格子
 *   B 侧栏面板那一行没有重名(原先两张都叫「工作区」)
 *   C 搜索行点开的是快速查找
 *   D 日历那一格的箭头展开出「日历 / 待办清单 / 进入 Space」;选「待办清单」→ 这个标签自己变成待办。
 *     先多开一张空白页、回到前一张里操作:就地打开时待办落在前一张的位置;另开标签会跑到末尾(空白页随后自己关掉,
 *     只开一张时这两种结果长得一样,分不出来)
 *   E 启动器整页不出横向滚动,格子里的字没有被截断
 *   F 「打开」里每一格点下去,这个标签都就地变成那个视图(不留空白启动器、不出错误面板)—— 格子是按 Space 定义
 *     推出来的,新加一个 Space 就会多一格,这里替它把关
 * SHOT_DIR=<目录> 时顺带存亮 / 暗两张整窗截图(观感自查用)。
 *
 * ⚠️ 量的是 out/ 里的产物,源码改了没 `npm run build` 就是白测(同 check:chatside)。
 * ⚠️ 入口按 `[data-act="new-chat"]` 找,别按文案:09-17 侧栏换成 OrbitsView 后按钮字变「新会话」,
 *    按「新对话」找的旧写法在第 2 项之前就超时(假红)。
 * 跑:npm run check:newtab
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const SNAP = `(() => {
  const tabs = [...document.querySelectorAll('.wb-tab')].map((t) => t.querySelector('.wb-tab-name')?.textContent || '')
  return {
    tabs,
    chatVisible: [...document.querySelectorAll('.t2-chat-view')].filter((e) => e.getBoundingClientRect().width > 0).length,
    launcherTabs: tabs.filter((n) => n === '新建标签页' || n === 'New tab').length,
    launcherVisible: [...document.querySelectorAll('.newtab')].filter((e) => e.getBoundingClientRect().width > 0).length,
  }
})()`

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-newtab-'))
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.waitForTimeout(1500)
    // ⚠️钉住启动 Space:2026-08-28 起「启动时进入」的缺省是 ribbon 主位槽(=主页 Space),
    // 主页既没有侧栏也没有聊天面板 —— 本脚本验的是 Tangu Space 的形态,不钉就一路等超时。
    await win.evaluate(`localStorage.setItem('forsion_default_space', 'tangu')`)
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.waitForTimeout(2000)

    const before = await win.evaluate(SNAP)
    await win.click('.dv-new-tab')
    await win.waitForTimeout(900)
    const blank = await win.evaluate(SNAP)
    check(
      '1 点 ＋ 开出一张可见的空白启动器',
      blank.launcherVisible === 1 && blank.launcherTabs === 1,
      JSON.stringify(blank),
    )

    // ── 启动器的分段 ──────────────────────────────────────────────────────
    const LAYOUT = `(() => {
      const root = [...document.querySelectorAll('.newtab')].find((e) => e.getBoundingClientRect().width > 0)
      const labels = (sel) => [...root.querySelectorAll(sel + ' .newtab-card-label')].map((e) => (e.textContent || '').trim())
      const cut = [...root.querySelectorAll('.nt-tilebtn .newtab-card-label, .nt-chip .newtab-card-label')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent)
      return {
        search: !!root.querySelector('.nt-search'),
        sections: [...root.querySelectorAll('.newtab-sec-title')].map((e) => e.firstChild?.textContent || ''),
        create: labels('.nt-chips'), createDraggable: [...root.querySelectorAll('.nt-chip')].filter((b) => b.draggable).length,
        tiles: labels('.nt-tiles'), tilesNotDraggable: [...root.querySelectorAll('.nt-tilebtn')].filter((b) => !b.draggable).map((b) => b.textContent),
        side: labels('.nt-side'), cut, overflowX: root.scrollWidth > root.clientWidth + 1,
      }
    })()`
    const lay = await win.evaluate(LAYOUT)
    const hasCal = lay.tiles.some((x) => /^(日历|Calendar)$/.test(x))
    check(
      'A 搜索行、「新建」「打开」两段都在;新建项不可拖、视图格子可拖;Tangu 自己不出格子',
      lay.search && lay.sections.length >= 2 && lay.create.length >= 1 && lay.createDraggable === 0
        && lay.tiles.length >= 2 && hasCal && !lay.tiles.includes('Tangu') && lay.tilesNotDraggable.every((x) => /后台 Agent|Background agents/.test(x)),
      JSON.stringify(lay),
    )
    check('B 侧栏面板那一行没有重名', lay.side.length >= 2 && new Set(lay.side).size === lay.side.length, JSON.stringify(lay.side))
    check('E 启动器不出横向滚动,格子 / 按钮里的字没有被截断', !lay.overflowX && lay.cut.length === 0, JSON.stringify({ overflowX: lay.overflowX, cut: lay.cut }))

    if (process.env.SHOT_DIR) {
      fs.mkdirSync(process.env.SHOT_DIR, { recursive: true })
      for (const mode of ['light', 'dark']) {
        await win.evaluate((m) => { const r = document.documentElement; r.dataset.mode = m; r.classList.toggle('dark', m === 'dark') }, mode)
        await win.waitForTimeout(300)
        await win.screenshot({ path: path.join(process.env.SHOT_DIR, `launcher-${mode}.png`) })
      }
      await win.evaluate(() => { const r = document.documentElement; r.dataset.mode = 'light'; r.classList.remove('dark') })
    }

    await win.click('.newtab .nt-search')
    await win.waitForTimeout(500)
    const palette = await win.evaluate(`!!document.querySelector('.amx-qf-input')`)
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)
    check('C 搜索行点开的是快速查找', palette && (await win.evaluate(SNAP)).launcherVisible === 1, `palette=${palette}`)

    const LAUNCHER_TAB = /新建标签页|New tab/
    await win.click('.dv-new-tab')
    await win.waitForTimeout(700)
    await win.locator('.wb-tab', { hasText: LAUNCHER_TAB }).first().click()
    await win.waitForTimeout(500)
    const slot = (await win.evaluate(SNAP)).tabs.findIndex((n) => LAUNCHER_TAB.test(n))
    const calTile = win.locator('.newtab .nt-tile:visible', { hasText: /^(日历|Calendar)$/ }).first()
    await calTile.locator('.nt-more').click()
    await win.waitForTimeout(400)
    const menuItems = await win.evaluate(`[...document.querySelectorAll('.ctx-menu button')].map((b) => (b.textContent || '').trim())`)
    if (process.env.SHOT_DIR) await win.screenshot({ path: path.join(process.env.SHOT_DIR, 'launcher-menu.png') })
    const todo = menuItems.find((x) => /^(待办清单|To-?do list|Todo|To-dos)$/i.test(x)) || menuItems[1]
    const tabsBefore = (await win.evaluate(SNAP)).tabs.length
    await win.locator('.ctx-menu button', { hasText: todo }).first().click()
    await win.waitForTimeout(1200)
    const afterTodo = await win.evaluate(SNAP)
    check(
      'D 日历那一格展开出「日历 / 待办 / 进入 Space」;选待办 → 这个标签自己变成待办',
      menuItems.length === 3 && /Space/.test(menuItems[2]) && afterTodo.launcherVisible === 0 && afterTodo.launcherTabs === 1 && afterTodo.tabs.length === tabsBefore && afterTodo.tabs[slot] === todo,
      JSON.stringify({ menuItems, slot, afterTodo }),
    )
    // 回到「主区里有一张空白启动器」的起点(D 多开的那张还在),接着走原来的 2 / 3
    await win.locator('.wb-tab', { hasText: LAUNCHER_TAB }).first().click()
    await win.waitForTimeout(900)

    // 侧栏新建入口(OrbitsView 顶行,走 openNewChat);左栏折叠时先展开(折叠态可能还挂在 DOM 里,故看可见而非 count)。
    const newChat = win.locator('[data-act="new-chat"]').first()
    if (!(await newChat.isVisible().catch(() => false))) {
      await win.click('.dv-edge-left').catch(() => {})
      await win.waitForTimeout(800)
    }
    await newChat.click()
    await win.waitForTimeout(1200)
    const after = await win.evaluate(SNAP)

    check(
      '2 在空白标签里点「新对话」→ 这个标签自己变成聊天(不再是空白启动器)',
      after.launcherTabs === 0 && after.launcherVisible === 0,
      JSON.stringify(after) + '(修复前:launcherTabs=1 —— 空白标签还在,内容跑去顶掉老聊天了)',
    )
    check(
      '3 聊天可见,且主区标签没有净增(没留下没人用的空白标签)',
      after.chatVisible === 1 && after.tabs.length <= before.tabs.length + 2, // +1 = D 留下的待办标签
      `标签 ${before.tabs.length} → ${blank.tabs.length} → ${after.tabs.length};可见聊天 ${after.chatVisible}`,
    )

    // ── F 每一格都开得出来 ────────────────────────────────────────────────
    const broken = []
    for (const name of lay.tiles) {
      await win.click('.dv-new-tab')
      await win.waitForSelector('.newtab .nt-tilebtn', { state: 'visible', timeout: 10_000 })
      await win.locator('.newtab .nt-tilebtn', { hasText: name }).first().click()
      await win.waitForTimeout(1300)
      const st = await win.evaluate(`({ ...${SNAP}, err: [...document.querySelectorAll('.sk-error, [data-error-boundary]')].map((e) => (e.textContent || '').slice(0, 160)) })`)
      if (st.launcherVisible !== 0 || st.launcherTabs !== 0 || st.err.length) broken.push({ name, launcher: st.launcherVisible, err: st.err })
    }
    check(`F 「打开」里 ${lay.tiles.length} 格逐个点开,都就地变成视图、不出错误面板`, lay.tiles.length >= 2 && broken.length === 0, JSON.stringify(broken))

    const bad = results.filter((r) => !r.ok)
    console.log(bad.length ? `\n${bad.length} 项失败` : `\n${results.length}/${results.length} 通过`)
    process.exitCode = bad.length ? 1 : 0
  } finally {
    await app.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
