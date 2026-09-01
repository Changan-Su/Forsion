/**
 * 「主页 = 可拆卸的内置插件」的端到端契约(真 Electron)。
 *
 * Home Space + `homepage` 视图归内置插件 builtins/homepage,设置 → Forsion 插件 里可关。
 * 关掉必须**整条不见**:ribbon 图标、Space、视图、启动器里的入口;开回来必须原样回来;
 * 关着重启不能把用户卡在一个不存在的 Space 上(registerSpaces 的 fallback 会改写活动 Space 并落盘)。
 *
 * 开关走 storage 事件(= 设置页勾选框与跨窗同步走的同一条 applyBuiltin 路径)。
 *
 * 判据:
 *   1 默认开:ribbon 有主页图标,点进去主区是主页视图
 *   2 收纳架默认只露一排(6 项 + 全部),「全部」进入二级收纳层 = spaceRegistry 的完整投影
 *   3 输入区字面复用 ChatView 的 Composer2(模式/模型/附件/发送全在),旧浏览器搜索选择器完全不在
 *   4 切走后 space:home 命名布局里仍然只有 homepage、没有 chat
 *   5 收纳:坞 = ribbon 上区的**另一个投影** —— 造一份「收纳夹装着日历+编码」的 ribbon 存档,
 *     坞里就该出现夹子格、成员不再单独占格、点开二级应用层能切过去,且 ribbon 上是同一份分组
 *   6 ⚠️拖拽重排写回:坞上看不见主页那一格,但 `setZoneOrder('top', …)` 写的是**整条**上区顺序 ——
 *     基准序漏掉主页 = 它从持久数组里消失 → rankIds 把未列出的排最后 → 主页图标掉进 ribbon 的「…」
 *     释放时 DragOverlay 必须立即销毁,不能从指针处跨屏飞回落点;格子本身的让位动画仍保留。
 *   7 关掉:图标没了、主页视图不再可见、活动 Space 已切走、启动器里没有「主页」卡
 *   8 开回来:图标回来,还能再进去
 *   9 ⚠️别的 Space 的**命名布局**里留着主页面板时关插件 —— 切回去不许炸
 *     (applyNamed 的「视图均已注册」校验,与 builtin-calendar 的第 5 条同源)
 *  10 关着重启:启动即不注册(ribbon 无主页),应用照常起来
 *  11 ⚠️收纳 × 顺序的不变式(Codex 评审 high):持久的上区顺序里**永远不许**出现夹内成员,
 *     也不许出现重复 id。写回基准序不过滤夹内成员 → 成员被当顶层项写进 order,
 *     解散夹时 `removeFolder` 再把 items 原样 splice 回去 = 同一个 id 出现两次。
 *     本条按「重排 → 拖进夹 → 解散夹」整条走一遍,每步都验不变式。
 *  12 自定义壁纸:图片进 IndexedDB、偏好进 localStorage;reload 后仍恢复,且设置面板三种来源齐全。
 *  13 壁纸材质:Chatbox 文本区与模型/模式等控件共用聚焦景深;玻璃总开关关掉时回到不透明材质。
 *  14 Bing 壁纸经固定目标 Electron IPC 暴露,不重新引入浏览器搜索或任意 URL 代理。
 *  15 主题背景:四个随 token 变化的 Forsion 图形预设;右键空白直达紧凑、无重叠的二级收纳层。
 *  16 ⚠️主页视角固定:.hp-root 压根不是滚动容器(壁纸 scale(1.001) 曾撑出 1px → 四边滚动条);
 *     clip 之后放不下就是裁掉,所以矮窗口(1100×420,须先放开 minimumSize)下时钟/输入区/Spaces 坞必须仍在 root 内;
 *     且右键空白这个手势**双向**可用 —— 收纳层面板内右键空白必须原路退回主页。
 *
 * ⚠️ 量的是 out/ 里的产物,源码改了没 `npm run build` 就是白测。
 * 跑:npm run check:homepage          截图自查(亮/暗各一张):npm run check:homepage -- --shot
 * 报「启动失败」= 有 dev 版 Electron 占着单实例锁,先把它关掉(同 check:calendarplugin)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const SHOT = process.argv.includes('--shot')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-homeplugin-'))
const UD = path.join(home, 'userdata') // 同一份 user-data-dir = 同一份 localStorage,重启那程才谈得上「关着」
const WALLPAPER_FIXTURE = path.join(home, 'homepage-wallpaper.svg')
fs.writeFileSync(WALLPAPER_FIXTURE, `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#203149"/><stop offset=".52" stop-color="#7b6f8f"/><stop offset="1" stop-color="#d4a56d"/></linearGradient></defs>
  <rect width="1600" height="900" fill="url(#g)"/><circle cx="1240" cy="180" r="280" fill="#f5dcae" opacity=".38"/><path d="M0 720 Q420 500 840 690 T1600 610 V900 H0Z" fill="#172838" opacity=".72"/>
</svg>`)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const HOME_NAMES = ['主页', 'Home']
const COMPACT_TILE_LIMIT_FOR_TEST = 6

/** ribbon 上**全部** Space 名 = 上区条上的 + 「…」溢出浮层里的 + **主位槽里的那一个**。
 *  ⚠️主位槽(2026-08-28):被放进主位的 Space 从上区消失、改在中间那格 —— 只扫 `.rb-top` 会漏掉它,
 *  而缺省主位正是主页,于是「主页图标在不在」的判定会全线误红。
 *  ⚠️不能只数条上的 `.rb-space`:ribbon 装不下会把尾部收进「…」(实测 8 个 Space 时条上只剩 6 个)。
 *  更要命的是 `addRibbonIcon` 是**追加**:插件关掉再开,图标就排到区末尾、直接落进「…」——
 *  这是与内置日历同源的既有行为(槽位不保),不是本插件引入的,所以按并集判「回来了没有」。 */
async function ribbonSpaces(win) {
  const read = (root) => `[...document.querySelectorAll('${root} .rb-space')].map((b) => b.getAttribute('title') || b.querySelector('.rb-label')?.textContent || '')`
  const bar = await win.evaluate(read('.rb-top'))
  const home = await win.evaluate(read('.rb-home'))
  const more = win.locator('.rb-top .rb-more').first()
  if (!(await more.count().catch(() => 0))) return [...bar, ...home]
  await more.hover()
  await win.waitForTimeout(500)
  const hidden = await win.evaluate(read('.rb-fly'))
  await win.mouse.move(700, 700) // 移开,否则浮层挡住后续点击
  await win.waitForTimeout(400)
  return [...bar, ...home, ...hidden]
}

/** ribbon 上的 Space 名 + 主页视图可见性 + 坞格子 + 活动 Space + 启动器卡片。 */
const SNAP = `(() => {
  const names = [...document.querySelectorAll('.rb-space')]
    .map((b) => b.getAttribute('title') || b.querySelector('.rb-label')?.textContent || '')
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.getBoundingClientRect().width > 0).length
  return {
    barSpaces: names,
    homeView: vis('.hp-root'),
    tiles: [...document.querySelectorAll('.hp-space-main .hp-tile:not(.hp-folder) .hp-tile-name')].map((e) => (e.textContent || '').trim()),
    folderTiles: [...document.querySelectorAll('.hp-space-main .hp-folder .hp-tile-name')].map((e) => (e.textContent || '').trim()),
    organizerTiles: [...document.querySelectorAll('.hp-organizer-grid > .hp-tile .hp-tile-name')].map((e) => (e.textContent || '').trim()),
    organizer: vis('.hp-organizer-stage'),
    ribbonFolders: document.querySelectorAll('.rb-top .rb-folder').length,
    brand: (document.querySelector('.hp-brand')?.textContent || '').trim(),
    flyRows: [...document.querySelectorAll('.hp-folder-app')].map((e) => (e.textContent || '').trim()),
    ribbonOrder: JSON.parse(localStorage.getItem('forsion_tangu_ribbon_order') || '[]'),
    totalTiles: Number(document.querySelector('.hp-spaces')?.getAttribute('data-total') || 0),
    more: vis('.hp-more'),
    composer: vis('.hp-composer .t2c-card'),
    legacySearch: vis('.hp-engine, .hp-picker, .hp-input'),
    active: localStorage.getItem('forsion_tangu_active_space'),
    launcher: [...document.querySelectorAll('.newtab-card-label')].map((e) => (e.textContent || '').trim()),
  }
})()`

/** 开/关内置插件:与设置页勾选框、跨窗同步同一条路径(builtins/index 的 storage 监听 → applyBuiltin)。 */
const toggle = (on) => `(() => {
  localStorage.setItem('builtin.home.enabled', ${on ? "'1'" : "'0'"})
  window.dispatchEvent(new StorageEvent('storage', { key: 'builtin.home.enabled' }))
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
  const click = (root) => `(() => {
    const b = [...document.querySelectorAll('${root} .rb-space')].find((x) =>
      ${JSON.stringify(names)}.includes(x.getAttribute('title') || x.querySelector('.rb-label')?.textContent || ''))
    if (b) { b.click(); return true }
    return false
  })()`
  let hit = await win.evaluate(click('.rb-top')) || await win.evaluate(click('.rb-home'))
  if (!hit) { // 条上没有 → 可能被收进「…」溢出浮层(见 ribbonSpaces 的注释)
    const more = win.locator('.rb-top .rb-more').first()
    if (await more.count().catch(() => 0)) {
      await more.hover()
      await win.waitForTimeout(500)
      hit = await win.evaluate(click('.rb-fly'))
    }
  }
  await win.waitForTimeout(1800)
  return hit
}
const enterHome = (win) => enterSpace(win, HOME_NAMES)

/** 开启动器并**确认它真的开出来了**:点击失败或没挂载就直接抛 —— 否则 launcher=[] 会让
 *  「入口没了」的断言空跑通过(builtin-calendar 里 Codex 评审抓过的同款假绿)。 */
async function openLauncher(win) {
  await win.click('.dv-new-tab')
  await win.waitForSelector('.newtab', { state: 'visible', timeout: 10_000 })
  await win.waitForTimeout(600)
}

/** 重新载入渲染进程(ribbon store 只在模块装载时读一次 localStorage,夹具必须靠 reload 生效)。 */
async function reload(win) {
  await win.reload({ waitUntil: 'domcontentloaded' })
  await win.waitForSelector('#root', { timeout: 30_000 })
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await win.waitForTimeout(2000)
}

/** 写一份 ribbon 上区存档(顺序 + 收纳夹);`folders` 为空则只写顺序。清空两键传 null。 */
const ribbonFixture = (order, folders) => order === null
  ? `(() => { localStorage.removeItem('forsion_tangu_ribbon_order'); localStorage.removeItem('forsion_tangu_ribbon_v2') })()`
  : `(() => {
    localStorage.setItem('forsion_tangu_ribbon_order', JSON.stringify(${JSON.stringify(order)}))
    localStorage.setItem('forsion_tangu_ribbon_v2', JSON.stringify({ bottomOrder: [], commandItems: [], commandIcons: {}, folders: ${JSON.stringify(folders)} }))
  })()`

async function openOrganizer(win) {
  if (await win.locator('.hp-organizer-stage').count().catch(() => 0)) return
  const more = win.locator('.hp-more').first()
  if (await more.count().catch(() => 0)) await more.click()
  else await win.evaluate(`document.querySelector('.hp-root')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 80 }))`)
  await win.waitForSelector('.hp-organizer-stage', { state: 'visible', timeout: 5000 })
  await win.waitForTimeout(350)
}

/** 真指针拖到相邻格并落盘:落下前量 overlay + layout transform(排斥/让位)。 */
async function probePointerMotion(win, fromId, toId) {
  await openOrganizer(win)
  const from = win.locator(`.hp-organizer-grid .hp-tile[data-id="${fromId}"]`)
  const to = win.locator(`.hp-organizer-grid .hp-tile[data-id="${toId}"]`)
  const a = await from.boundingBox()
  const b = await to.boundingBox()
  if (!a || !b) return { overlay: 0, shifted: 0, over: null, releaseOverlay: -1, releaseMs: -1 }
  await win.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await win.mouse.down()
  await win.mouse.move(a.x + a.width / 2 - 10, a.y + a.height / 2, { steps: 3 })
  await win.waitForTimeout(100)
  await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 })
  await win.waitForTimeout(180)
  const state = await win.evaluate(`(() => ({
    overlay: document.querySelectorAll('.hp-drag-overlay').length,
    over: document.querySelector('.hp-organizer-grid .hp-tile[data-over]')?.getAttribute('data-id') || null,
    shifted: [...document.querySelectorAll('.hp-organizer-grid .hp-tile[data-id]')].filter((e) =>
      e.getAttribute('data-id') !== ${JSON.stringify(fromId)} && e.style.transform && e.style.transform !== 'translate3d(0px, 0px, 0)'
    ).length,
  }))()`)
  const releaseAt = Date.now()
  await win.mouse.up()
  await win.waitForFunction(`document.querySelectorAll('.hp-drag-overlay').length === 0`, { timeout: 240 }).catch(() => {})
  state.releaseMs = Date.now() - releaseAt
  state.releaseOverlay = await win.locator('.hp-drag-overlay').count()
  await win.waitForTimeout(260)
  return state
}

/** 真指针完成落盘。二级层是 CSS grid,键盘坐标器会按几何邻近而不是数组顺序游走;
 *  这里直接验证用户实际使用的拖拽路径,键盘可达性由 useSortable attributes 保留。 */
async function dragTile(win, fromId, toId) {
  await openOrganizer(win)
  const from = win.locator(`.hp-organizer-grid .hp-tile[data-id="${fromId}"]`)
  const to = win.locator(`.hp-organizer-grid .hp-tile[data-id="${toId}"]`)
  const a = await from.boundingBox()
  const b = await to.boundingBox()
  if (!a || !b) throw new Error(`拖拽目标不可见: ${fromId} -> ${toId}`)
  await win.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await win.mouse.down()
  await win.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2, { steps: 3 })
  await win.waitForTimeout(100)
  if (!(await win.locator('.hp-drag-overlay').count())) throw new Error(`dnd-kit 未进入拖拽态: ${fromId}`)
  await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 14 })
  await win.waitForTimeout(180)
  const marked = await win.locator('.hp-organizer-grid .hp-tile[data-over]').first().getAttribute('data-id').catch(() => null)
  if (marked !== toId) {
    await win.keyboard.press('Escape')
    await win.mouse.up()
    throw new Error(`dnd-kit 无法到达目标: ${fromId} -> ${toId} | over=${marked}`)
  }
  await win.mouse.up()
  await win.waitForTimeout(500)
}

/** 把主区标签栏里名字命中的那张标签点到前台(主页被后开的浏览器标签盖住时用)。
 *  ⚠️必须走 Playwright 的**真点击**:Dockview 的标签切换听的是 pointerdown/mousedown,
 *  `el.click()` 只派发一个 click 事件 —— 命中了也不换 tab(探针实测,别改回 evaluate 版)。 */
async function activateTab(win, names) {
  for (const n of names) {
    const tab = win.locator(`.dv-tab:has(.wb-tab-name:text-is("${n}"))`).first()
    if (await tab.count().catch(() => 0)) {
      await tab.click()
      await win.waitForTimeout(900)
      return true
    }
  }
  return false
}

/** `space:<id>` 命名布局里的视图类型(主区面板 + 两侧 stash)。 */
const layoutTypes = (id) => `(() => {
  const m = JSON.parse(localStorage.getItem('tangu2_named_layouts') || '{}')
  const l = m['space:' + ${JSON.stringify(id)}]
  if (!l) return null
  const panels = Object.values(l.dockview?.panels || {}).map((p) => (p.params || {}).__type)
  const stash = ['left', 'right'].flatMap((s) => (l.sidebars?.[s]?.stash || []).map((v) => v.type))
  return [...panels, ...stash]
})()`

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  let { app, win } = await boot()
  const errs = []
  win.on('pageerror', (e) => errs.push(String(e && e.message ? e.message : e)))
  try {
    await enterHome(win)
    const s0 = await win.evaluate(SNAP)
    s0.spaces = await ribbonSpaces(win)
    const homeIcons = (l) => l.filter((n) => HOME_NAMES.includes(n)).length
    check(
      '1 默认开:ribbon 有主页图标 + 点进去是主页视图 + 标志性标题在场',
      homeIcons(s0.spaces) === 1 && s0.homeView === 1 && s0.brand === 'Forsion is All You Need',
      JSON.stringify({ spaces: s0.spaces, tiles: s0.tiles, homeView: s0.homeView, active: s0.active, brand: s0.brand }),
    )

    // 2 默认只露一排;二级收纳层 = spaceRegistry 完整投影,且主页自己不在坞里。
    //   ⚠️分母不能用**可见的** .rb-space:ribbon 装不下会把尾部收进收纳夹(实测只剩 6 个,坞里 7 个),
    //   拿它当等式两边只会得到一个恒红的断言。判据改成「展开后 ribbon 上看得见的(除主页)都在坞里」。
    const ribbonOthers = s0.spaces.filter((n) => !HOME_NAMES.includes(n))
    const compactOk = s0.tiles.length <= COMPACT_TILE_LIMIT_FOR_TEST + 1
      && s0.totalTiles === ribbonOthers.length
      && (s0.totalTiles <= COMPACT_TILE_LIMIT_FOR_TEST ? s0.more === 0 : s0.more === 1)
    await openOrganizer(win)
    const expanded = await win.evaluate(SNAP)
    const dockOk = ribbonOthers.length > 0 && expanded.organizer === 1 && expanded.organizerTiles.length === ribbonOthers.length
      && ribbonOthers.every((n) => expanded.organizerTiles.includes(n)) && !expanded.organizerTiles.some((n) => HOME_NAMES.includes(n))
    const jumped = await win.evaluate(`(() => {
      const t = [...document.querySelectorAll('.hp-organizer-grid .hp-tile')].find((x) =>
        (x.querySelector('.hp-tile-name')?.textContent || '').trim() === 'Tangu')
      if (!t) return false
      t.click(); return true
    })()`)
    await win.waitForTimeout(1800)
    const afterTile = await win.evaluate(SNAP)
    check(
      '2 收纳架只露一排,二级收纳层列全且点击能切 Space',
      compactOk && dockOk && jumped && afterTile.active === 'tangu',
      JSON.stringify({ compactTiles: s0.tiles, total: s0.totalTiles, more: s0.more, organizer: expanded.organizerTiles, spaces: s0.spaces, jumped, active: afterTile.active }),
    )

    // 3 首页不再养第二套输入框:直接出现 Composer2 本体,旧搜索引擎 UI 为 0。
    await enterHome(win)
    const composed = await win.evaluate(SNAP)
    const composerControls = await win.evaluate(`(() => ({
      textarea: document.querySelectorAll('.hp-composer .t2c-ta').length,
      add: document.querySelectorAll('.hp-composer .add-pill-wrap').length,
      mode: document.querySelectorAll('.hp-composer .mode-pill-wrap').length,
      send: document.querySelectorAll('.hp-composer .t2c-send').length,
    }))()`)
    check(
      '3 输入区复用 Composer2 完整控件,旧浏览器搜索 UI 已移除',
      composed.composer === 1 && composed.legacySearch === 0
        && composerControls.textarea === 1 && composerControls.add === 1 && composerControls.mode === 1 && composerControls.send === 1,
      JSON.stringify({ composer: composed.composer, legacySearch: composed.legacySearch, ...composerControls }),
    )

    // 4 切去 Tangu 不许污染主页命名布局。真发送由本台架的断网后端门控;
    //   发送强制 sessionId=null 由源码 + typecheck 钉住。
    await openOrganizer(win)
    await win.click('.hp-organizer-grid .hp-tile[data-id="space:tangu"]')
    await win.waitForTimeout(1200)
    const afterAsk = await win.evaluate(SNAP)
    await enterHome(win) // 回主页 = 顺手把 space:tangu 存档;主页布局本身在上一步切走时已存
    const homeLayout = await win.evaluate(layoutTypes('home'))
    check(
      '4 切到 Tangu 后 space:home 布局仍只保留主页,没被塞进聊天',
      afterAsk.active === 'tangu' && Array.isArray(homeLayout)
        && homeLayout.includes('homepage') && !homeLayout.includes('chat'),
      JSON.stringify({ active: afterAsk.active, homeLayout }),
    )

    // ── 5 收纳:坞 = ribbon 上区的另一个投影 ────────────────────────────────
    // 夹具直接写 ribbon 的两个持久键再 reload(store 只在模块装载时读一次),不靠合成拖拽建夹。
    await win.evaluate(ribbonFixture(
      ['space:home', 'folder:hpTest', 'space:tangu', 'space:amadeus'],
      [{ id: 'folder:hpTest', name: '工具箱', zone: 'top', items: ['space:calendar', 'space:coding'] }],
    ))
    await reload(win)
    await enterHome(win)
    const fold = await win.evaluate(SNAP)
    // 点开夹子 → 从图标原点展开成中央二级应用层 → 点第一个切过去
    await win.click('.hp-folder')
    await win.waitForTimeout(500)
    const flied = await win.evaluate(SNAP)
    const secondLevel = await win.evaluate(`(() => {
      const panel = document.querySelector('.hp-folder-panel')
      return { panel: panel ? 1 : 0, dx: panel?.style.getPropertyValue('--hp-folder-dx') || '', dy: panel?.style.getPropertyValue('--hp-folder-dy') || '' }
    })()`)
    if (SHOT) {
      const out = path.join(os.tmpdir(), 'forsion-homepage.folder.png')
      await win.screenshot({ path: out })
      console.log(`  截图 → ${out}`)
    }
    await win.click('.hp-folder-app')
    await win.waitForTimeout(1800)
    const jumpedIn = await win.evaluate(SNAP)
    check(
      '5 收纳:坞出现收纳夹格、成员不再单独占格、点开能切过去,ribbon 同一份分组',
      fold.folderTiles.includes('工具箱')
        && !fold.tiles.some((n) => ['日历', '编码工作室'].includes(n))
        && fold.ribbonFolders === 1
        && flied.flyRows.length === 2 && secondLevel.panel === 1 && !!secondLevel.dx && !!secondLevel.dy
        && jumpedIn.active === 'calendar',
      JSON.stringify({ folderTiles: fold.folderTiles, tiles: fold.tiles, ribbonFolders: fold.ribbonFolders, flyRows: flied.flyRows, secondLevel, active: jumpedIn.active }),
    )

    // ── 6 拖拽重排:写回整条上区顺序,主页那一格不许在过程中丢 ──────────────
    // ⚠️夹具必须是**空的持久顺序**(= 从没拖过的新用户)。写一份已含 `space:home` 的顺序就验不出东西:
    //   reorderBase = unionOrder(持久序, 可见项),持久序里已经有主页时,基准序漏不漏主页都一样 ——
    //   负对照实跑时这条曾经假绿(把基准序换成坞上过滤后的列表,它照样通过)。
    await win.evaluate(ribbonFixture([], []))
    await reload(win)
    await enterHome(win)
    const pointerMotion = await probePointerMotion(win, 'space:inbox', 'space:tangu') // 收件箱拖到 Tangu 之前
    const reordered = await win.evaluate(SNAP)
    const ord = reordered.ribbonOrder
    check(
      '6 坞里拖拽重排:顺序写回 ribbon,且主页没从持久顺序里掉出去',
      pointerMotion.overlay === 1 && pointerMotion.over === 'space:tangu' && pointerMotion.shifted > 0
        && pointerMotion.releaseOverlay === 0 && pointerMotion.releaseMs < 240
        && ord.includes('space:home')
        && ord.indexOf('space:inbox') < ord.indexOf('space:tangu')
        && reordered.organizerTiles.indexOf('收件箱') < reordered.organizerTiles.indexOf('Tangu'),
      JSON.stringify({ pointerMotion, ribbonOrder: ord, organizerTiles: reordered.organizerTiles }),
    )
    // 夹具清场:后面几条按「没有用户自定义排列」的默认态判定
    await win.evaluate(ribbonFixture(null))
    await reload(win)
    await enterHome(win)

    // 7 关掉(此刻正停在主页里 —— 顺带验「停在里面被关」不会把人卡住)
    await win.evaluate(toggle(false))
    await win.waitForTimeout(1500)
    await openLauncher(win)
    const off = await win.evaluate(SNAP)
    const offIcons = homeIcons(await ribbonSpaces(win))
    const noEntry = !off.launcher.some((n) => HOME_NAMES.includes(n))
    // 顺手钉一条通用的:启动器里不许出现**裸 i18n 键**(`view.calendar` 这种形状)。
    // 2026-08-28 实测捞到过一枚 —— 冷启动恢复布局跑在 LocaleProvider 之前,tr 还是 `(k)=>k`,
    // 「最近使用」把裸键当标题存了下来(修在 NewTabView:view 类标题改为按注册表实时求值)。
    const rawKeys = off.launcher.filter((n) => /^[a-z][A-Za-z0-9]*\.[a-zA-Z]/.test(n))
    check(
      '7 关掉:图标/视图/Space 全撤,启动器入口也没了(且没有裸 i18n 键漏进标题)',
      offIcons === 0 && off.homeView === 0 && off.active !== 'home' && noEntry && rawKeys.length === 0,
      JSON.stringify({ homeIcon: offIcons, homeView: off.homeView, active: off.active, noEntry, rawKeys, launcher: off.launcher }),
    )

    await win.evaluate(toggle(true))
    await win.waitForTimeout(1200)
    await enterHome(win)
    const onIcons = homeIcons(await ribbonSpaces(win))
    const on = await win.evaluate(SNAP)
    check('8 开回来:图标回来且还能进去', onIcons === 1 && on.homeView === 1, JSON.stringify({ homeIcon: onIcons, homeView: on.homeView }))

    // 9 别的 Space 的命名布局里留着主页面板:关插件后切回去不许炸。
    //   夹具全靠点击:Tangu Space → 启动器 →「主页」卡 = 在主区开一张主页,再切走(saveNamed)。
    await enterSpace(win, ['Tangu'])
    await openLauncher(win)
    const carded = await win.evaluate(`(() => {
      const c = [...document.querySelectorAll('.newtab-card')].find((x) =>
        ${JSON.stringify(HOME_NAMES)}.includes((x.querySelector('.newtab-card-label')?.textContent || '').trim()))
      if (c) { c.click(); return true }
      return false
    })()`)
    await win.waitForTimeout(1800)
    const planted = await win.evaluate(SNAP)
    await enterSpace(win, ['Amadeus'])
    await win.evaluate(toggle(false))
    await win.waitForTimeout(1500)
    errs.length = 0
    await enterSpace(win, ['Tangu']) // ← applyNamed 吃到含 homepage 的命名布局
    await win.waitForTimeout(1200)
    const back = await win.evaluate(SNAP)
    const alive = await win.evaluate(`(() => ({
      groups: document.querySelectorAll('.dv-groupview').length,
      spaces: document.querySelectorAll('.rb-space').length,
    }))()`)
    check(
      '9 别的 Space 命名布局里留着主页面板:关插件后切回去不炸',
      carded && planted.homeView === 1 && back.homeView === 0 && alive.groups > 0 && alive.spaces > 0 && errs.length === 0,
      JSON.stringify({ carded, planted: planted.homeView, back: back.homeView, ...alive, errs: errs.slice(0, 2) }),
    )

    // 10 关着退出 → 重启:启动那条声明式闸(spaces.tsx)也得不注册
    await win.evaluate(`localStorage.setItem('builtin.home.enabled', '0')`)
    await win.waitForTimeout(400)
    await app.close()
    ;({ app, win } = await boot())
    const restarted = await win.evaluate(SNAP)
    restarted.spaces = await ribbonSpaces(win)
    check(
      '10 关着重启:启动即不注册,应用照常起来',
      homeIcons(restarted.spaces) === 0 && restarted.spaces.length > 0 && restarted.active !== 'home',
      JSON.stringify({ spaces: restarted.spaces, active: restarted.active }),
    )
    // ── 11 收纳 × 顺序的不变式:全程 order 里不许有夹内成员、不许有重复 ──────────
    // 关着重启那程之后插件是关的,先开回来 + 装夹具。
    await win.evaluate(toggle(true))
    await win.waitForTimeout(1000)
    await win.evaluate(ribbonFixture(
      ['space:home', 'folder:hpInv', 'space:tangu', 'space:inbox', 'space:amadeus'],
      [{ id: 'folder:hpInv', name: '收纳测试', zone: 'top', items: ['space:calendar', 'space:coding'] }],
    ))
    await reload(win)
    await enterHome(win)
    const readOrder = async () => win.evaluate(`JSON.parse(localStorage.getItem('forsion_tangu_ribbon_order') || '[]')`)
    const dup = (a) => a.filter((x, i) => a.indexOf(x) !== i)
    const MEMBERS = ['space:calendar', 'space:coding']

    await dragTile(win, 'space:inbox', 'space:tangu')  // 重排
    const o1 = await readOrder()
    await dragTile(win, 'space:amadeus', 'folder:hpInv') // 拖进夹
    const o2 = await readOrder()
    await win.click('.hp-organizer-grid .hp-folder', { button: 'right' })   // 解散夹
    await win.waitForTimeout(500)
    await win.click('.ctx-menu button:has-text("解散")')
    await win.waitForTimeout(600)
    const o3 = await readOrder()
    check(
      '11 收纳 × 顺序不变式:重排/移入/解散全程,order 无夹内成员且无重复',
      dup(o1).length === 0 && !o1.some((x) => MEMBERS.includes(x))          // 重排没把成员写进去
        && dup(o2).length === 0 && !o2.includes('space:amadeus')            // 移入把它从顶层序摘掉了
        && dup(o3).length === 0                                             // 解散后没有重复
        && MEMBERS.every((m) => o3.filter((x) => x === m).length === 1),    // 成员各回来恰好一次
      JSON.stringify({ o1, o2, o3, dupes: [dup(o1), dup(o2), dup(o3)] }),
    )

    // 12–14 壁纸:真文件选择 → IndexedDB Blob + localStorage 偏好 → reload 恢复。
    await enterHome(win)
    if (await win.locator('.hp-organizer-stage').count().catch(() => 0)) {
      await win.click('.hp-organizer-head > button')
      await win.waitForTimeout(260)
    }
    await win.click('.hp-wallpaper-button')
    await win.waitForSelector('.hp-wallpaper-sheet')
    const wallpaperControls = await win.evaluate(`(() => ({
      sources: [...document.querySelectorAll('.hp-wallpaper-sources button')].map((e) => e.getAttribute('data-source')),
      bridge: typeof window.tangu?.wallpaperListBing,
    }))()`)
    await win.locator('.hp-wallpaper-file').setInputFiles(WALLPAPER_FIXTURE)
    await win.waitForTimeout(900)
    const custom = await win.evaluate(`(() => {
      const root = document.querySelector('.hp-root')
      const card = document.querySelector('.hp-composer .t2c-card')
      const prefs = JSON.parse(localStorage.getItem('forsion.homepage.wallpaper.v1') || '{}')
      return {
        wallpaper: root?.getAttribute('data-wallpaper') || '',
        image: document.querySelector('.hp-wallpaper')?.style.backgroundImage || '',
        source: prefs.source,
        backdrop: card ? getComputedStyle(card).backdropFilter : '',
        edgeBackdrop: getComputedStyle(document.querySelector('.hp-wallpaper-edge')).backdropFilter,
        edgeMask: getComputedStyle(document.querySelector('.hp-wallpaper-edge')).maskImage,
      }
    })()`)
    check(
      '12 自定义壁纸:三来源齐全,原图进入设备存储并立即成为主页舞台',
      JSON.stringify(wallpaperControls.sources) === JSON.stringify(['theme', 'bing', 'custom'])
        && custom.wallpaper === 'true' && custom.image.startsWith('url("blob:') && custom.source === 'custom'
        && custom.edgeBackdrop.includes('blur(') && custom.edgeMask.includes('gradient('),
      JSON.stringify({ wallpaperControls, custom }),
    )
    if (SHOT) {
      const out = path.join(os.tmpdir(), 'forsion-homepage.wallpaper-settings.png')
      await win.screenshot({ path: out })
      console.log(`  截图 → ${out}`)
      // --shot 是人工真机验收档,顺手走一次真实 Bing IPC + 目录 UI;网络不可用只跳过截图,不让离线 CI 假红。
      await win.click('.hp-wallpaper-sources button[data-source="bing"]')
      const bingReady = await win.waitForFunction(`(() => {
        const images = [...document.querySelectorAll('.hp-wallpaper-grid img')]
        return images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0)
          && (document.querySelector('.hp-wallpaper')?.style.backgroundImage || '').includes('bing.com')
      })()`, { timeout: 20_000 }).then(() => true).catch(() => false)
      if (bingReady) {
        await win.waitForTimeout(900) // 背景 UHD 解码 + 玻璃滤镜稳定后再截,避免只截到灰色占位。
        const bingOut = path.join(os.tmpdir(), 'forsion-homepage.bing-settings.png')
        await win.screenshot({ path: bingOut })
        console.log(`  截图 → ${bingOut}`)
      } else console.log('  Bing 真机截图跳过:当前网络未返回目录')
      await win.click('.hp-wallpaper-sources button[data-source="custom"]')
      await win.waitForTimeout(350)
    }

    await win.click('.hp-wallpaper-head > button')
    await win.waitForTimeout(320)
    // 台架故意把后端指向 127.0.0.1:1,textarea 因离线被 disabled,所以用真实 pointerdown 事件
    // 走 HomepageChatbox 的输入模式路径。模式按钮也应触发聚焦,内部切换不能闪退。
    await win.locator('.hp-composer button:not(:disabled)').first().focus()
    await win.waitForTimeout(120)
    const controlFocused = await win.locator('.hp-root').evaluate((root) => root.classList.contains('hp-composer-focused'))
    await win.locator('.hp-composer .t2c-ta').dispatchEvent('pointerdown')
    await win.waitForTimeout(420)
    const focused = await win.evaluate(`(() => {
      const root = document.querySelector('.hp-root')
      const paper = document.querySelector('.hp-wallpaper')
      const card = document.querySelector('.hp-composer .t2c-card')
      return {
        active: root?.classList.contains('hp-composer-focused') || false,
        filter: paper ? getComputedStyle(paper).filter : '',
        backdrop: card ? getComputedStyle(card).backdropFilter : '',
      }
    })()`)
    await win.evaluate(`document.documentElement.dataset.glass = 'off'`)
    const glassOff = await win.evaluate(`getComputedStyle(document.querySelector('.hp-composer .t2c-card')).backdropFilter`)
    await win.evaluate(`document.documentElement.dataset.glass = 'on'`)
    check(
      '13 Chatbox 文本区与相关控件共用聚焦景深,玻璃可可靠降级',
      controlFocused && focused.active && focused.filter.includes('blur(') && focused.backdrop.includes('blur(') && glassOff === 'none',
      JSON.stringify({ controlFocused, focused, glassOff }),
    )
    if (SHOT) {
      const focusOut = path.join(os.tmpdir(), 'forsion-homepage.input-focus.png')
      await win.screenshot({ path: focusOut })
      console.log(`  截图 → ${focusOut}`)
    }

    await reload(win)
    await enterHome(win)
    await win.waitForTimeout(900)
    const persisted = await win.evaluate(`(() => ({
      wallpaper: document.querySelector('.hp-root')?.getAttribute('data-wallpaper') || '',
      image: document.querySelector('.hp-wallpaper')?.style.backgroundImage || '',
      legacySearch: document.querySelectorAll('.hp-engine, .hp-picker, .hp-input').length,
    }))()`)
    check(
      '14 reload 后恢复自定义壁纸,Bing 走固定 IPC 且浏览器搜索没有回来',
      persisted.wallpaper === 'true' && persisted.image.startsWith('url("blob:')
        && wallpaperControls.bridge === 'function' && persisted.legacySearch === 0,
      JSON.stringify({ persisted, bridge: wallpaperControls.bridge }),
    )

    if (SHOT) {
      // 参考图对应态:真壁纸 + 空白右键 + 二级收纳层。
      await win.evaluate(`document.querySelector('.hp-root')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 90, clientY: 90 }))`)
      await win.waitForSelector('.hp-organizer-stage', { state: 'visible' })
      await win.waitForTimeout(700)
      const organizerOut = path.join(os.tmpdir(), 'forsion-homepage.organizer.png')
      await win.screenshot({ path: organizerOut })
      console.log(`  截图 → ${organizerOut}`)
      await win.click('.hp-organizer-head > button')
      await win.waitForTimeout(260)
    }

    // 15 关掉图片来源后,舞台有可选的 Forsion 图形预设;空白右键直达紧凑收纳层。
    await win.click('.hp-wallpaper-button')
    await win.waitForSelector('.hp-wallpaper-sheet')
    await win.click('.hp-wallpaper-sources button[data-source="theme"]')
    const themePresets = await win.evaluate(`(() => ({
      ids: [...document.querySelectorAll('.hp-theme-presets button')].map((e) => e.getAttribute('data-preset')),
      previews: [...document.querySelectorAll('.hp-theme-preview')].every((e) => getComputedStyle(e).backgroundImage.includes('gradient(')),
    }))()`)
    await win.click('.hp-theme-presets button[data-preset="topography"]')
    await win.click('.hp-wallpaper-head > button')
    await win.waitForTimeout(350)
    const themeStage = await win.evaluate(`(() => {
      const root = document.querySelector('.hp-root')
      const paper = document.querySelector('.hp-wallpaper')
      return {
        wallpaper: root?.getAttribute('data-wallpaper') || '',
        preset: root?.getAttribute('data-theme-preset') || '',
        inlineImage: paper?.style.backgroundImage || '',
        backgroundImage: paper ? getComputedStyle(paper).backgroundImage : '',
        art: getComputedStyle(document.querySelector('.hp-wallpaper-art')).backgroundImage,
      }
    })()`)
    // ⚠️ 主页永不滚:壁纸层的 scale(1.001) 曾把滚动溢出撑出 1px,mac 经典滚动条下就是四边各来一条。
    // 反向验证:把 homepage.css 的 .hp-root 改回 `overflow: auto` → 16 必红。
    const noScroll = await win.evaluate(`(() => {
      const r = document.querySelector('.hp-root')
      const cs = getComputedStyle(r)
      // 溢出**本来就消不掉**(壁纸恒 scale(1.001),开二级层时还会到 1.045/1.065),所以量的不是
      // scrollWidth 而是「能不能被滚动」—— 同 shell-noscroll:强写 scrollLeft/Top 后必须原地不动。
      r.scrollLeft = 9999
      r.scrollTop = 9999
      const moved = { x: Math.round(r.scrollLeft), y: Math.round(r.scrollTop) }
      r.scrollLeft = 0
      r.scrollTop = 0
      return { over: r.scrollWidth - r.clientWidth, moved, ox: cs.overflowX, oy: cs.overflowY }
    })()`)
    await win.evaluate(`document.querySelector('.hp-root')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 90, clientY: 90 }))`)
    await win.waitForSelector('.hp-organizer-stage', { state: 'visible' })
    await win.waitForTimeout(500)
    const rightClickOrganizer = await win.evaluate(`(() => {
      const grid = document.querySelector('.hp-organizer-grid')
      const head = document.querySelector('.hp-organizer-head')
      const panel = document.querySelector('.hp-organizer-panel')
      const first = grid?.querySelector('.hp-tile')
      const seed = first?.cloneNode(true)
      while (seed && grid.querySelectorAll('.hp-tile').length < 25) {
        const clone = seed.cloneNode(true)
        clone.removeAttribute('style')
        clone.setAttribute('data-id', 'dense:' + grid.querySelectorAll('.hp-tile').length)
        grid.appendChild(clone)
      }
      const hs = head?.getBoundingClientRect()
      const fs = first?.getBoundingClientRect()
      const ps = panel?.getBoundingClientRect()
      const style = grid ? getComputedStyle(grid) : null
      return {
        organizer: document.querySelectorAll('.hp-organizer-stage').length,
        blur: getComputedStyle(document.querySelector('.hp-wallpaper')).filter,
        panelWidth: ps?.width || 0,
        columns: style?.gridTemplateColumns.split(' ').filter(Boolean).length || 0,
        columnGap: Number.parseFloat(style?.columnGap || '99'),
        tileWidth: fs?.width || 0,
        headGap: fs && hs ? fs.top - hs.bottom : -1,
        gridHeight: grid?.clientHeight || 0,
        gridScrollHeight: grid?.scrollHeight || 0,
      }
    })()`)
    // ⚠️ 进来的手势必须出得去:收纳层里右键空白 = 原路退回主页(2026-08-30 用户实报「出不来」)。
    // 派发点刻意选**面板内部的空白**(时钟那块)而不是外圈遮罩 —— 打在遮罩上时,即使把
    // `.hp-organizer-panel` 重新写回排除表也照样绿(codex 评审指出的假绿口),打在面板里才真的钉住。
    await win.evaluate(`(() => {
      const el = document.querySelector('.hp-organizer-clock') || document.querySelector('.hp-organizer-stage')
      el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 }))
    })()`)
    await win.waitForTimeout(420)
    const backOut = await win.evaluate(`document.querySelectorAll('.hp-organizer-stage').length`)
    // ⚠️ clip 之后放不下就是**裁掉**、没有滚动条兜底 —— 所以矮窗口下关键控件必须仍在 root 里面。
    //    这条钉的是 homepage.css 末尾那两档按高度的覆盖块真的够矮(把 max-height:520px 那档删掉 → 必红)。
    // ⚠️ 必须先放开 minimumSize:主窗 minHeight=600(electron/main.ts),直接 setSize 会被静默钳住 ——
    //    量出来 h=546 看着像在测矮窗口,其实测的是桌面最小窗,520px 那档根本没跑到(实撞过一次假绿)。
    //    420 对应的是分离窗(minHeight 360)与手机横屏那一档。
    const winBounds = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      return { size: w.getSize(), min: w.getMinimumSize() }
    })
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.setMinimumSize(880, 360)
      w.setSize(1100, 420)
    })
    await win.waitForTimeout(600)
    const shortWindow = await win.evaluate(`(() => {
      const r = document.querySelector('.hp-root').getBoundingClientRect()
      const fits = (sel) => {
        const e = document.querySelector(sel)
        if (!e) return null
        const b = e.getBoundingClientRect()
        return b.top >= r.top - 0.5 && b.bottom <= r.bottom + 0.5
      }
      return { h: Math.round(r.height), clock: fits('.hp-clock'), composer: fits('.hp-composer'), spaces: fits('.hp-spaces') }
    })()`)
    if (SHOT) {
      const shortOut = path.join(os.tmpdir(), 'forsion-homepage.short-window.png')
      await win.screenshot({ path: shortOut })
      console.log(`  截图 → ${shortOut}`)
    }
    await app.evaluate(({ BrowserWindow }, b) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.setSize(b.size[0], b.size[1])
      w.setMinimumSize(b.min[0], b.min[1])
    }, winBounds)
    await win.waitForTimeout(500)
    check(
      '15 四套自适应主题图形可选,高密度收纳层紧凑且头部不重叠',
      themeStage.wallpaper === '' && themeStage.inlineImage === '' && themeStage.backgroundImage.includes('gradient(')
        && themeStage.preset === 'topography' && themeStage.art.includes('gradient(')
        && JSON.stringify(themePresets.ids) === JSON.stringify(['rings', 'topography', 'weave', 'horizon']) && themePresets.previews
        && rightClickOrganizer.organizer === 1 && rightClickOrganizer.blur.includes('blur(')
        && rightClickOrganizer.panelWidth <= 600 && rightClickOrganizer.columns === 6
        && rightClickOrganizer.columnGap <= 8 && rightClickOrganizer.tileWidth <= 80
        && rightClickOrganizer.headGap >= 4 && rightClickOrganizer.gridHeight <= 414,
      JSON.stringify({ themePresets, themeStage, rightClickOrganizer }),
    )
    check(
      '16 ⚠️主页视角固定(不滚)、矮窗口不裁关键控件、右键空白能原路退出收纳层',
      noScroll.moved.x === 0 && noScroll.moved.y === 0 && noScroll.ox === 'clip' && noScroll.oy === 'clip' && backOut === 0
        && shortWindow.clock === true && shortWindow.composer === true && shortWindow.spaces === true,
      JSON.stringify({ noScroll, backOut, shortWindow }),
    )
    if (SHOT) {
      const denseOut = path.join(os.tmpdir(), 'forsion-homepage.organizer-dense.png')
      await win.screenshot({ path: denseOut })
      console.log(`  截图 → ${denseOut}`)
    }
    // 上面那记右键通常已经把它关掉了;没关掉就走关闭钮,别把后续用例连坐。
    await win.click('.hp-organizer-head > button', { timeout: 1500 }).catch(() => {})
    await win.waitForTimeout(700)

    if (SHOT) {
      // 观感自查(DESIGN.md §8):无图片默认背景,亮/暗各一张。
      await win.click('.hp-wallpaper-button')
      await win.waitForSelector('.hp-wallpaper-sheet')
      await win.waitForTimeout(700)
      const presetsOut = path.join(os.tmpdir(), 'forsion-homepage.theme-presets.png')
      await win.screenshot({ path: presetsOut })
      console.log(`  截图 → ${presetsOut}`)
      await win.click('.hp-wallpaper-head > button')
      await win.waitForTimeout(700)
      for (const mode of ['light', 'dark']) {
        if (mode === 'dark') {
          await win.evaluate(`document.querySelector('.lucide-moon')?.closest('button')?.click()`)
          await win.waitForTimeout(900)
        }
        const out = path.join(os.tmpdir(), `forsion-homepage.${mode}.png`)
        await win.screenshot({ path: out })
        console.log(`  截图 → ${out}`)
      }
    }
  } finally {
    await app.close().catch(() => {})
  }

  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} 通过`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
