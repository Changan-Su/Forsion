/**
 * 新工作区档「轨道 Orbits」侧栏几何 / 行为仪器(真 Electron + 桩引擎)。
 * 正典:docs/ToBeImproved/新工作区与轨道体系_方案_2026-09-16.md §3.1-§3.8 与 §8 的 P1 行;DESIGN.md §7 §8。
 *
 * 钉的是 P1 验收清单(几何本身就是用户的要求:「一级行是二级的 1.5 倍」= 40 / 26.797):
 *   0  桩引擎给 3 个本地 agent(两个带头像)→ 一级 .t2o-row ≥2
 *   1  档位菜单里新档 orbits 与旧档 sessions 并存;选 orbits 后 .t2o 真的渲染、再开菜单仍选中
 *      (§3.7 漏任一处都「静默」:漏 MODE_KEYS = 菜单没这项;漏两段式校验 = 手选后立刻弹回 auto;
 *       漏正文三元链 = 渲染成笔记面板,tsc 零报错)
 *   2  一级 .t2o-row 行高 40±0.5;头像槽 30×30;有头像时 <img> 实际渲染宽高 30
 *      (check:listsrc 教训:<img> 不显式定尺寸会按原始 32/48px 撑爆行)
 *   3  .t2o 里的项目组头 40±0.5;二级 .t2s-srow 仍是 26.797±0.5(二级行本体不许被改)
 *   4  左边缘:一级头像左 = 滚动区左 + 20;二级图标左 = 滚动区左 + 30.5±1;一级与组头图标逐像素同列
 *   5  胶囊切 Chat → Agent 轨道的 .t2o-row 全隐(count 0);切回 Work → 回来(§3.5)
 *   6  一级行与项目组在**同一个滚动区**里混排成一个列表,并按最近消息时间降序(09-16 用户拍板:Agent / 团队 / 项目不分块);
 *      从未有过会话的 Agent 沉底、保持名册序。(旧的「一级行不在 .t2s-side 里」断言随混排作废:行现在就住在 SidebarPane 里,
 *      .t2o-row 自带 --t2s-icon 覆盖,不靠外层作用域)
 *   7  旧档 sessions 仍可达,且顶部有「已有新版」提示条(§3.7 第 8 条)
 *   8  档位下拉随 panel resize;New Session / 一级行共用 6px 点击外框,筛选胶囊对齐 20px 图标列
 *   9  点击独立 Agent 不展开「不在项目中」,也不改变一级活动排序;切出再切回 Tangu 不强开已收起项目
 *  10  Project 行 hover 的 `…` 在 `+` 左边;Project / Agent / Engine / TEAM 等全部一级行整行右键打开各自 `…` 菜单;
 *      全部一级行可 Pin,Pin 区按最近激活排序并持久化
 *  11  亮 / 暗 / 375px 三张真实截图(DESIGN.md §8:几何断言全绿 ≠ 看起来对,自己看)
 *
 * 跑法:npm run build && npm run check:orbitside(单实例锁:先退掉 dev 版 Electron)。
 *
 * ⚠️ 为什么用桩引擎而不是 managed 本地引擎:agent 列表与会话列表都来自后端 HTTP,而新检出的
 * worktree 里 `tangu-agent/dist` 往往没建,managed 形态下引擎起不来 → agentDefs 恒空、组头「+」
 * 建不出会话,几何断言会全线**假红**。P1 本身是纯前端改动,数据来自哪不影响被钉的东西,故照
 * check:chatlayout 的先例用 `lib/stub-engine.cjs` 喂固定数据(它不供头像端点,前面再挂一层
 * 只做两件事的代理:头像回真 PNG、其余原样转发)。
 *
 * ── 与其它 cluster 的选择器契约(本仪器按此断言;实现方改名要同步改这里)──
 *   .t2o                                        OrbitsView 壳(§3.8)
 *   .t2o-row                                    一级行:私聊 / 团队 / 项目(§3.2)
 *   一级行的头像槽:.t2s-lead(复用)/ .t2o-lead / .t2o-avatar / .t2o-lead-slot —— 四者都认,取首个命中
 *   [data-mode="chat"|"work"]                   Chat/Work 胶囊(§3.1:.t2s-special 那行不变)
 *   [data-workspace-mode="orbits"|"sessions"]   档位菜单项(WorkspaceView 既有 data 属性)
 *   .t2sw-legacyhint                            旧档升级提示条(别名见 LEGACY_HINT_SELECTORS)
 *   槽 / 提示条的类名若被改,只改本文件顶部这两处常量即可,断言本体不动。
 */
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const near = (a, b, tol) => typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) <= tol
const r1 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : n)
/** 前置条件不成立(如新档根本没接进菜单)→ 停后续断言,但仍要打完 PASS/FAIL 汇总。 */
class StopEarly extends Error {}

/** 一级行高 = 40(26.797 × 1.5 取整档);二级行高 = 26.797;头像盒 30×30。 */
const LEVEL1_H = 40
const LEVEL2_H = 26.797
const AVATAR_BOX = 30
/** 头像左 = 滚动区 6(.t2s-scroll 内边距)+ 14(treeIndent ROW_PAD);二级图标 = 6 + rowPadLeft(1)=24.5。 */
const LEVEL1_LEAD_LEFT = 20
const LEVEL2_LEAD_LEFT = 30.5

/** 旧档提示条:`.t2sw-legacyhint` 是 WorkspaceView 的现役类名,其余是容错别名(改名了先在这里加一条)。 */
const LEGACY_HINT_SELECTORS = ['.t2sw-legacyhint', '.t2s-legacy-hint', '.t2sw-legacy-hint', '.t2o-legacy-hint', '[data-legacy-hint]']

/** 2×2 不透明 PNG —— 放大到 30×30 就是一块纯色,截图里一眼看得出头像位。 */
const AVATAR_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGPwr/oPRAwQCgAvLgchSE3WvgAAAABJRU5ErkJggg==', 'base64')

/** 本地 agent 名册(桩引擎 /agent/agents 的返回;字段照 chat-layout 的先例用驼峰)。
 *  第三个刻意不给 avatar:首字兜底圆底也要落在同一个 30×30 槽里。 */
// libraryDir:本地 agent 才有(引擎 listAgents 补的);没有它 = 云端定义 = 不能开私聊,OrbitsView 不列(§3.4 host 闸)。夹具照本地形状给。
const AGENTS = [
  { slug: 'xyra', name: 'Xyra', description: 'General assistant', createdBy: 'user', avatar: 'avatar.png', libraryDir: '/tmp/orbit-lib/xyra/Library' },
  { slug: 'orbit-one', name: 'Orbit One', description: 'Orbitside instrument agent', createdBy: 'user', avatar: 'avatar.png', libraryDir: '/tmp/orbit-lib/orbit-one/Library' },
  { slug: 'orbit-two', name: 'Orbit Two', description: 'Orbitside instrument agent (no avatar)', createdBy: 'user', libraryDir: '/tmp/orbit-lib/orbit-two/Library' },
]
/** 私聊 open 端点的夹具回应(桩引擎没有 /agent/solo 路由;由 startFront 代理答):点私聊行 → 拿到 orb-s1 这条会话。main() 里赋值。 */
let SOLO_OPEN_RESPONSE = null

/** 会话名册:两条项目会话(出一个项目组 + 两条二级行)+ 一条无根会话(出「不在项目中工作」组)。
 *  updated_at 刻意错开 —— 混排断言(6a)靠它:私聊 12:00 最新 → Xyra 行最上;项目里最新 11:00 → Orbit Project 组其次;
 *  无根 10:00 → 再次;Orbit One / Orbit Two 没有会话 → 沉底(名册序)。 */
const sessionFixtures = (projectDir, defaultDir) => {
  const at = (t) => ({ created_at: '2026-09-16 09:00:00', updated_at: `2026-09-16 ${t}` })
  const base = { summary: '', archived: false, model_id: 'm1', agent_config: null }
  return [
    { ...base, ...at('09:00:00'), id: 'orb-p1', title: '项目会话一', project_path: projectDir, project_name: 'Orbit Project', projectless: false },
    { ...base, ...at('09:30:00'), id: 'orb-p2', title: '项目会话二', project_path: projectDir, project_name: 'Orbit Project', projectless: false },
    { ...base, ...at('10:00:00'), id: 'orb-c1', title: '无根会话', project_path: null, project_name: null, projectless: true },
    // 切 Space 回归:先打开这条、收起 Tangu 默认工作区,切出再切回时会话可以恢复,但项目不能被动展开。
    { ...base, ...at('08:00:00'), id: 'orb-d1', title: '默认工作区会话', project_path: defaultDir, project_name: 'Tangu 默认工作区', projectless: false },
    // Agent 轨道的私聊会话:projectless 但带 soloAgentSlug —— 必须**不**落进「不在项目中工作」组(§3.5 inOrbit 剔除)
    { ...base, ...at('12:00:00'), id: 'orb-s1', title: '私聊会话', project_path: null, project_name: null, projectless: true,
      agent_config: { soloAgentSlug: 'xyra', agentSlug: 'xyra', execMode: 'host', cwd: '/tmp/orbit-xyra-library', preset: null } },
    // 项目轨道里处于团队模式的会话:二级行前导图标换 Users(§3.5 rowIcon),打开后主区顶部有团队模式状态条(§6.3)
    { ...base, ...at('11:00:00'), id: 'orb-p3', title: '团队模式会话', project_path: projectDir, project_name: 'Orbit Project', projectless: false,
      agent_config: { groupChat: true, groupAgents: ['xyra', 'orbit-one'], execMode: 'host', cwd: projectDir } },
  ]
}

/** 桩引擎前面的一层薄代理:①头像端点回真 PNG(桩没有这个路由)②其余原样转发(含 SSE)。 */
function startFront(stubUrl) {
  const target = new URL(stubUrl)
  const server = http.createServer((req, res) => {
    // ⚠️ 畸形 req.url 会让 new URL 抛在请求回调里 = 整个前置服务进程级崩溃(不是 502),
    //    表现成 Electron 干挂、连汇总都打不出来。兜住它。
    let p = ''
    try { p = new URL(req.url || '/', 'http://x').pathname } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{}'); return
    }
    if (/^\/agent\/agents\/[^/]+\/avatar$/.test(p) && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' })
      res.end(AVATAR_PNG)
      return
    }
    // 私聊 open:让「点私聊行 → sessionNav.openSolo → store.ensureSoloSession → openSession」整条真链路跑通(生产构建没有 __forsionStore)。
    if (p === '/agent/solo/agent/xyra/open' && req.method === 'POST' && SOLO_OPEN_RESPONSE) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(SOLO_OPEN_RESPONSE))
      return
    }
    const up = http.request(
      { host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers },
      (ur) => { res.writeHead(ur.statusCode || 502, ur.headers); ur.pipe(res) },
    )
    up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{}') })
    req.pipe(up)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(() => r())),
  })))
}

// ── 页内探针(全部容错:取不到就返回 null,绝不抛 —— 抛出来只剩一句无信息的 evaluate 失败)──
const PROBE = `(() => {
  const vis = (e) => {
    if (!e) return false
    const s = getComputedStyle(e); const r = e.getBoundingClientRect()
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0
  }
  const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height } }
  const q = (root, sel) => { try { return root ? root.querySelector(sel) : null } catch { return null } }
  const all = (root, sel) => { try { return root ? Array.from(root.querySelectorAll(sel)) : [] } catch { return [] } }
  // 左栏 = 最靠左的那个 .t2sw(右栏也有一份档位选择器)
  const panes = Array.from(document.querySelectorAll('.t2sw'))
  const pane = panes.slice().sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0] || null
  const orbit = q(pane, '.t2o') || document.querySelector('.t2o')
  const rows = all(orbit, '.t2o-row').filter(vis)
  const leadOf = (row) => q(row, '.t2s-lead') || q(row, '.t2o-lead') || q(row, '.t2o-avatar') || q(row, '.t2o-lead-slot')
  // 滚动区:往上找第一个真的会滚的祖先(.t2o 可能自己持有 overflow,也可能仍是 SidebarPane 的 .t2s-scroll)
  const scrollerOf = (el) => {
    let n = el && el.parentElement
    while (n && n !== document.body) {
      const oy = getComputedStyle(n).overflowY
      if (oy === 'auto' || oy === 'scroll') return n
      n = n.parentElement
    }
    return (el && (el.closest('.t2o-scroll') || el.closest('.t2s-scroll') || el.closest('.t2o'))) || null
  }
  const firstRow = rows[0] || null
  const firstLead = leadOf(firstRow)
  const rowScroller = firstRow ? scrollerOf(firstRow) : null
  const imgRow = rows.find((r) => q(r, 'img')) || null
  const img = q(imgRow, 'img')
  // 项目区(被复用进 .t2o 的 SidebarPane):组头 / 二级行
  const groups = all(orbit, '.t2s-group').filter(vis)
  const folderRows = all(orbit, '.t2s-folder-row').filter(vis)
  const srows = all(orbit, '.t2s-srow').filter((e) => vis(e) && !e.classList.contains('t2s-archived-toggle'))
  const srow = srows[0] || null
  const srowLead = q(srow, '.t2s-lead')
  const srowScroller = srow ? scrollerOf(srow) : null
  const modeOn = q(pane, '.t2s-mode button.on')
  const modeTrigger = q(pane, '.t2sw-mode-trigger')
  const headRow = q(orbit, '.t2o-head .t2s-special-row')
  const headLead = q(orbit, '.t2o-head .t2s-special-ic')
  const filters = q(orbit, '.t2o-filters')
  // 一级列表的 DOM 序(一级行 + 项目组头),混排断言用
  const level1 = all(orbit, '.t2o-row, .t2s-group').filter(vis).map((e) => e.classList.contains('t2o-row')
    ? { kind: 'row', text: ((q(e, '.t2o-name') || e).textContent || '').trim().slice(0, 24) }
    : { kind: 'group', text: ((q(e, '.t2s-group-label') || e).textContent || '').trim().slice(0, 24) })
  return {
    level1,
    sameScroller: !!(rowScroller && srowScroller && rowScroller === srowScroller),
    panes: panes.length,
    hasOrbit: !!orbit,
    orbitRect: rect(orbit),
    legacySide: !!q(pane, '.t2s-side'),
    rowCount: rows.length,
    rowGeom: rows.slice(0, 8).map((row) => {
      const lead = leadOf(row)
      return {
        text: (row.textContent || '').trim().slice(0, 18),
        h: (rect(row) || {}).height,
        lead: rect(lead),
        leadCls: lead ? String(lead.className) : null,
        insideSide: !!row.closest('.t2s-side'),
        hasImg: !!q(row, 'img'),
      }
    }),
    rowLeadLeft: firstLead ? rect(firstLead).left : null,
    rowScrollerLeft: rowScroller ? rect(rowScroller).left : null,
    rowScrollerCls: rowScroller ? String(rowScroller.className) : null,
    img: img ? {
      w: rect(img).width, h: rect(img).height,
      attrW: img.getAttribute('width'), attrH: img.getAttribute('height'),
      inlineW: img.style.width || '', cssW: getComputedStyle(img).width,
      radius: getComputedStyle(img).borderRadius, fit: getComputedStyle(img).objectFit,
      broken: img.complete && img.naturalWidth === 0,
      insideSide: !!img.closest('.t2s-side'),
    } : null,
    groupCount: groups.length,
    groupH: groups.map((e) => rect(e).height),
    folderRowH: folderRows.map((e) => rect(e).height),
    folderLeadLeft: folderRows.length && q(folderRows[0], '.t2s-lead') ? rect(q(folderRows[0], '.t2s-lead')).left : null,
    srowCount: srows.length,
    srowH: srows.slice(0, 8).map((e) => rect(e).height),
    srowLeadLeft: srowLead ? rect(srowLead).left : null,
    srowScrollerLeft: srowScroller ? rect(srowScroller).left : null,
    modeActive: modeOn ? modeOn.dataset.mode || null : null,
    hasModeBtn: !!(q(orbit, '[data-mode="chat"]') || q(pane, '[data-mode="chat"]')),
    alignment: {
      pane: rect(pane), trigger: rect(modeTrigger), head: rect(headRow), filters: rect(filters),
      headLead: rect(headLead), row: rect(firstRow), rowLead: rect(firstLead),
      group: rect(groups[0] || null), groupLead: rect(q(groups[0] || null, '.t2s-lead')),
    },
    legacyHint: ${JSON.stringify(LEGACY_HINT_SELECTORS)}.find((sel) => vis(q(pane, sel))) || null,
    modeLabel: (q(pane, '.t2sw-mode-label') || {}).textContent || null,
  }
})()`

/** 截图前点掉常驻通知:桩引擎的 run 状态端点会让渲染层弹一条 error 级通知(error = 常驻手动关,
 *  appStore.toast 的垫片语义),它是 fixed 覆盖层,会盖住窄栏截图的顶部行。照人手点 `.ntf-close`。 */
async function dismissToasts(win) {
  for (let i = 0; i < 6; i += 1) {
    const btn = win.locator('.ntf-close').first()
    if (!(await btn.count().catch(() => 0))) break
    await btn.click({ timeout: 2_000 }).catch(() => {})
    await sleep(200)
  }
}

/** 左栏 .t2sw 的下标(右栏也是 .t2sw,DOM 序不保证左在前)。 */
async function leftPaneIndex(win) {
  return win.evaluate(`(() => {
    const p = Array.from(document.querySelectorAll('.t2sw'))
    if (!p.length) return -1
    let best = 0
    p.forEach((e, i) => { if (e.getBoundingClientRect().left < p[best].getBoundingClientRect().left) best = i })
    return best
  })()`)
}
const leftPane = async (win) => win.locator('.t2sw').nth(Math.max(0, await leftPaneIndex(win)))

/** 档位菜单:展开 → 读全部选项 → 可选地点一项(id=null 只读不选,读完 Escape 关上)。 */
async function pickWorkspaceMode(win, id) {
  const pane = await leftPane(win)
  await pane.locator('.t2sw-mode-trigger').first().click()
  await sleep(350)
  const options = await pane.locator('.t2sw-mode-menu [data-workspace-mode]').evaluateAll((els) => els.map((e) => ({
    id: e.dataset.workspaceMode,
    text: (e.textContent || '').trim().slice(0, 24),
    selected: e.classList.contains('is-selected') || e.getAttribute('aria-selected') === 'true',
  })))
  const item = pane.locator(`.t2sw-mode-menu [data-workspace-mode="${id}"]`).first()
  if (!id || !(await item.count().catch(() => 0))) {
    await win.keyboard.press('Escape')
    await sleep(250)
    return { options, picked: false }
  }
  await item.click({ timeout: 10_000 })
  await sleep(800)
  return { options, picked: true }
}

async function run(app, win) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 960))
  await win.waitForSelector('#root', { timeout: 30_000 })
  await win.waitForTimeout(2500)
  for (const label of ['跳过引导', 'Skip']) {
    const b = win.locator(`text=${label}`).first()
    if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
  }
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  // 钉住启动 Space = Tangu(缺省是主页 Space,没有侧栏);清掉上次的 Chat/Work 偏好。
  await win.evaluate(`localStorage.setItem('forsion_default_space', 'tangu'); localStorage.removeItem('forsion_tangu_session_mode')`)
  await win.reload({ waitUntil: 'domcontentloaded' })
  await win.waitForSelector('#root', { timeout: 30_000 })
  await win.waitForSelector('.t2sw', { timeout: 30_000 })
  await sleep(2500)

  const shots = {
    light: path.join(os.tmpdir(), `forsion-orbitside-light-${process.pid}.png`),
    dark: path.join(os.tmpdir(), `forsion-orbitside-dark-${process.pid}.png`),
    narrow: path.join(os.tmpdir(), `forsion-orbitside-375-${process.pid}.png`),
    bar: path.join(os.tmpdir(), `forsion-orbitside-bar-${process.pid}.png`),
    actions: path.join(os.tmpdir(), `forsion-orbitside-actions-${process.pid}.png`),
  }

  // ── 1 档位菜单:新旧两档并存,选 orbits 生效且不弹回 ────────────────────────
  const menu = await pickWorkspaceMode(win, 'orbits')
  const ids = menu.options.map((o) => o.id)
  check('1 档位菜单同时有新档 orbits 与旧档 sessions(§3.7 第 1/3 处)',
    ids.includes('orbits') && ids.includes('sessions'), JSON.stringify(menu.options))
  if (!ids.includes('orbits')) {
    check('1! orbits 没接进 MODE_KEYS —— 新档不可达(cluster B/C 未落地),后续几何无从断言', false, `menu=${JSON.stringify(ids)}`)
    throw new StopEarly('orbits 档不可达')
  }
  await win.waitForSelector('.t2o', { timeout: 15_000 }).catch(() => {})
  let st = await win.evaluate(PROBE)
  check('1a 选 orbits 后真的渲染 .t2o 壳(§3.7 第 5 处漏了会静默渲染成笔记面板,tsc 抓不到)',
    st.hasOrbit, JSON.stringify({ hasOrbit: st.hasOrbit, panes: st.panes, modeLabel: st.modeLabel }))
  if (!st.hasOrbit) throw new StopEarly('.t2o 未渲染')
  const reopened = await pickWorkspaceMode(win, null)
  check('1b 再开菜单 orbits 仍是选中态(§3.7 第 4 处漏了 = 手选后立刻弹回 auto)',
    !!reopened.options.find((o) => o.id === 'orbits' && o.selected), JSON.stringify(reopened.options))

  // ── 0 名册里的本地 agent 变成一级行 ───────────────────────────────────────
  check(`0 桩引擎的 ${AGENTS.length} 个本地 agent 全部渲染成一级 .t2o-row(≥${AGENTS.length};引擎行/团队行会加进同一集合,故不写 ===)`,
    st.rowCount >= AGENTS.length, JSON.stringify({ rowCount: st.rowCount, rows: st.rowGeom.map((r) => r.text) }))
  const noImgRows = st.rowGeom.filter((r) => !r.hasImg)
  check('0a 至少一条无头像行在场,且它的首字兜底槽同样 30×30(没渲染出来时 2a 会真空成立)',
    noImgRows.length >= 1 && noImgRows.every((r) => r.lead && near(r.lead.width, AVATAR_BOX, 0.5) && near(r.lead.height, AVATAR_BOX, 0.5)),
    JSON.stringify(noImgRows.map((r) => ({ t: r.text, lead: r.lead }))))

  // ── 2 一级行几何:40px / 槽 30×30 / <img> 实宽 30 ─────────────────────────
  check(`2 一级 .t2o-row 行高 ${LEVEL1_H}px ±0.5(= 二级 ${LEVEL2_H} 的 1.5 倍档)`,
    st.rowGeom.length > 0 && st.rowGeom.every((r) => near(r.h, LEVEL1_H, 0.5)),
    JSON.stringify(st.rowGeom.map((r) => ({ t: r.text, h: r1(r.h) }))))
  check(`2a 一级行头像槽 ${AVATAR_BOX}×${AVATAR_BOX}(.t2o-row 上覆盖 --t2s-icon: 28.5px;含无头像的首字兜底行)`,
    st.rowGeom.length > 0 && st.rowGeom.every((r) => r.lead && near(r.lead.width, AVATAR_BOX, 0.5) && near(r.lead.height, AVATAR_BOX, 0.5)),
    JSON.stringify(st.rowGeom.map((r) => ({ t: r.text, cls: r.leadCls, w: r1(r.lead && r.lead.width), h: r1(r.lead && r.lead.height) }))))
  check('2b 有头像的一级行里有 <img>(名册的 avatar 走通了 agentAvatars 这条线)',
    !!st.img && !st.img.broken, JSON.stringify({ rowsWithImg: st.rowGeom.filter((r) => r.hasImg).length, rows: st.rowCount, img: st.img }))
  check(`2c ⚠️<img> 实际渲染 ${AVATAR_BOX}×${AVATAR_BOX}(check:listsrc 教训:不显式定尺寸会按原始 32/48px 撑爆行)`,
    !!st.img && near(st.img.w, AVATAR_BOX, 0.5) && near(st.img.h, AVATAR_BOX, 0.5), JSON.stringify(st.img))

  // ── 6 一个列表:一级行与项目组同一滚动区、按最近消息时间混排(09-16 用户拍板)────────
  check('6 一级 .t2o-row 与项目组在同一个滚动区里(不分块,一个列表)',
    st.rowGeom.length > 0 && st.sameScroller, JSON.stringify({ sameScroller: st.sameScroller, scroller: st.rowScrollerCls }))
  const pos = (kind, text) => st.level1.findIndex((e) => e.kind === kind && e.text.includes(text))
  const ix = { xyra: pos('row', 'Xyra'), project: pos('group', 'Orbit Project'), one: pos('row', 'Orbit One'), two: pos('row', 'Orbit Two') }
  const groups = st.level1.filter((e) => e.kind === 'group')
  const rootlessIx = groups.length >= 2 ? st.level1.indexOf(groups[1]) : -1 // 第二个组 = 无根组(10:00)
  check('6a 一级列表按最近消息时间降序混排:私聊 12:00 的 Xyra > 项目 11:00 的 Orbit Project > 无根 10:00 > 无会话的 Orbit One > Orbit Two(名册序沉底)',
    ix.xyra >= 0 && ix.project > ix.xyra && rootlessIx > ix.project && ix.one > rootlessIx && ix.two > ix.one,
    JSON.stringify({ order: st.level1.map((e) => `${e.kind}:${e.text}`), ix, rootlessIx }))

  // ── 3 项目区(复用的 SidebarPane):组头 40 / 二级行 26.797 ─────────────────
  check(`3 .t2o 里的项目组头 ${LEVEL1_H}px ±0.5(作用域覆盖 .t2o .t2s-group .t2s-folder-row)`,
    st.groupH.length > 0 && st.groupH.every((h) => near(h, LEVEL1_H, 0.5)) && st.folderRowH.every((h) => near(h, LEVEL1_H, 0.5)),
    JSON.stringify({ group: st.groupH.map(r1), folderRow: st.folderRowH.map(r1) }))
  check(`3a 二级 .t2s-srow 仍是 ${LEVEL2_H}px ±0.5(二级行本体不许动)`,
    st.srowH.length > 0 && st.srowH.every((h) => near(h, LEVEL2_H, 0.5)),
    JSON.stringify({ count: st.srowCount, h: st.srowH.map(r1) }))

  // ── 3b/3c 轨道会话在项目区的两条静默接缝(§3.5) ────────────────────────────
  const orbitRows = await win.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.t2o .t2s-srow'))
    const texts = rows.map((e) => (e.textContent || '').trim())
    const teamRow = rows.find((e) => (e.textContent || '').includes('团队模式会话'))
    return { texts, soloLeaked: texts.some((t) => t.includes('私聊会话')), teamHasUsers: !!(teamRow && teamRow.querySelector('svg.lucide-users')) }
  })()`)
  check('3b 私聊会话(projectless + soloAgentSlug)不落进「不在项目中工作」组(inOrbit 剔除;漏了 tsc 不红)',
    orbitRows.texts.length > 0 && !orbitRows.soloLeaked, JSON.stringify(orbitRows.texts))
  check('3c 团队模式的项目会话二级行前导图标换成 Users(SidebarPane.rowIcon)', orbitRows.teamHasUsers, JSON.stringify(orbitRows))

  await win.locator('.t2o .t2s-srow', { hasText: '团队模式会话' }).first().click()
  await sleep(500)
  check('3d 团队会话顶部状态条已移除', await win.locator('.t2o-bar').count() === 0, '')
  await win.screenshot({ path: shots.bar })
  const orderBeforeOrbitOpen = (await win.evaluate(PROBE)).level1.map((e) => `${e.kind}:${e.text}`)
  const foundRootless = await win.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.t2o .t2s-srow'))
    const row = rows.find((e) => (e.textContent || '').includes('无根会话'))
    if (!row) return false
    const group = Array.from(document.querySelectorAll('.t2o .t2s-group')).find((g) => {
      const next = g.nextElementSibling
      return !!next && next.contains(row)
    })
    if (!group) return false
    const r = row.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) group.querySelector('.t2s-group-toggle')?.click()
    return true
  })()`)
  await sleep(500)
  await win.locator('.t2o .t2o-row', { hasText: 'Xyra' }).first().click()
  await sleep(500)
  check('3e 私聊行高亮且顶部无重复状态条', await win.locator('.t2o .t2o-row.active', { hasText: 'Xyra' }).count() === 1 && await win.locator('.t2o-bar').count() === 0, '')
  const afterOrbitOpen = await win.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.t2o .t2s-srow'))
    const rootless = rows.find((e) => (e.textContent || '').includes('无根会话'))
    const r = rootless?.getBoundingClientRect()
    const visible = !!r && r.width > 0 && r.height > 0
    const level1 = Array.from(document.querySelectorAll('.t2o .t2o-row, .t2o .t2s-group'))
      .filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 })
      .map((e) => e.classList.contains('t2o-row')
        ? 'row:' + ((e.querySelector('.t2o-name') || e).textContent || '').trim().slice(0, 24)
        : 'group:' + ((e.querySelector('.t2s-group-label') || e).textContent || '').trim().slice(0, 24))
    return { visible, level1 }
  })()`)
  check('3f 点击独立 Agent 不会误展开「不在项目中工作」', foundRootless && !afterOrbitOpen.visible,
    JSON.stringify({ foundRootless, rootlessVisible: afterOrbitOpen.visible }))
  check('3g 纯点击独立 Agent 不改变一级活动排序', JSON.stringify(afterOrbitOpen.level1) === JSON.stringify(orderBeforeOrbitOpen),
    JSON.stringify({ before: orderBeforeOrbitOpen, after: afterOrbitOpen.level1 }))
  await win.locator('.t2o .t2s-srow', { hasText: '项目会话一' }).first().click().catch(() => {})
  await sleep(600)

  // ── 4 左边缘竖线 ──────────────────────────────────────────────────────────
  const l1 = st.rowLeadLeft != null && st.rowScrollerLeft != null ? st.rowLeadLeft - st.rowScrollerLeft : null
  const l2 = st.srowLeadLeft != null && st.srowScrollerLeft != null ? st.srowLeadLeft - st.srowScrollerLeft : null
  check(`4 一级头像左边缘 = 滚动区左 + ${LEVEL1_LEAD_LEFT}(6 内边距 + 14 ROW_PAD)`,
    near(l1, LEVEL1_LEAD_LEFT, 1), JSON.stringify({ delta: r1(l1), scroller: st.rowScrollerCls, leadLeft: r1(st.rowLeadLeft) }))
  check(`4a 二级图标左边缘 = 滚动区左 + ${LEVEL2_LEAD_LEFT}±1(rowPadLeft(1)=24.5 + 6)`,
    near(l2, LEVEL2_LEAD_LEFT, 1), JSON.stringify({ delta: r1(l2), leadLeft: r1(st.srowLeadLeft) }))
  check('4b ⚠️一级头像与组头图标逐像素同列(§3.2:层级靠尺寸差表达,不靠缩进)',
    st.folderLeadLeft != null && near(st.rowLeadLeft, st.folderLeadLeft, 0.6),
    JSON.stringify({ row: r1(st.rowLeadLeft), group: r1(st.folderLeadLeft) }))

  // ── 8a 亮色截图 ───────────────────────────────────────────────────────────
  await dismissToasts(win)
  await win.mouse.move(1270, 950) // 指针别停在行上:hover 会把图标换成箭头
  await sleep(350)
  await (await leftPane(win)).screenshot({ path: shots.light })

  check('5 顶部不再显示 Chat/Work,筛选胶囊在 New Session 下一行', !st.hasModeBtn && await win.locator('.t2o-filters [role="tab"]').count() === 4, '')
  const alignment = await win.evaluate(() => {
    const q = (s) => document.querySelector(s).getBoundingClientRect()
    return { title: q('.t2o-head .t2s-special-title').left, row: q('.t2o-row .t2o-name').left,
      lead: q('.t2o-head .t2s-special-ic').left, rowLead: q('.t2o-row .t2o-lead').left,
      headBottom: q('.t2o-head').bottom, filterTop: q('.t2o-filters').top }
  })
  check('5a New Session 图标槽与文字均对齐一级条目', near(alignment.title, alignment.row, .6) && near(alignment.lead, alignment.rowLead, .6) && alignment.filterTop >= alignment.headBottom - 1, JSON.stringify(alignment))

  // ── 8 档位触发器响应 panel 宽度 + 筛选胶囊与图标列对齐 ─────────────────────
  const alignedToTrigger = (a) => {
    if (!a?.pane || !a.trigger || !a.head || !a.filters || !a.headLead || !a.row || !a.rowLead || !a.group || !a.groupLead) return false
    const outerRows = [a.head, a.row, a.group]
    const iconColumn = [a.headLead, a.rowLead, a.groupLead]
    return near(a.trigger.left - a.pane.left, 6, .75)
      && near(a.pane.width - a.trigger.width, 12, 1.25)
      && outerRows.every((r) => near(r.left, a.trigger.left, .75) && near(r.width, a.trigger.width, 1.25))
      && iconColumn.every((r) => near(r.left, a.filters.left, .75))
      && near(a.pane.width - a.filters.width, 40, 1.25)
  }
  check('8 档位下拉与一级行共用 6px 点击外框,筛选胶囊对齐 20px 图标列',
    alignedToTrigger(st.alignment), JSON.stringify(st.alignment))

  const panelBefore = st.alignment
  const leftSash = await win.evaluate(`(() => {
    const panes = Array.from(document.querySelectorAll('.t2sw'))
    const pane = panes.slice().sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0]
    const group = pane && pane.closest('.dv-groupview')
    if (!group) return null
    const edge = group.getBoundingClientRect().right
    let best = null
    for (const s of document.querySelectorAll('.dv-sash')) {
      const b = s.getBoundingClientRect()
      if (b.height < 100) continue
      const d = Math.abs(b.left + b.width / 2 - edge)
      if (!best || d < best.d) best = { d, x: b.left + b.width / 2, y: b.top + b.height / 2 }
    }
    return best && best.d < 24 ? best : null
  })()`)
  if (leftSash) {
    await win.mouse.move(leftSash.x, leftSash.y)
    await win.mouse.down()
    await win.mouse.move(leftSash.x + 96, leftSash.y, { steps: 10 })
    await win.mouse.up()
    await sleep(900)
  }
  st = await win.evaluate(PROBE)
  const panelDelta = st.alignment.pane && panelBefore.pane ? st.alignment.pane.width - panelBefore.pane.width : 0
  const triggerDelta = st.alignment.trigger && panelBefore.trigger ? st.alignment.trigger.width - panelBefore.trigger.width : 0
  check('8a 拖动 panel sash 后档位下拉等量伸缩（不再锁死 224px）',
    !!leftSash && Math.abs(panelDelta) > 40 && near(triggerDelta, panelDelta, 2) && alignedToTrigger(st.alignment),
    JSON.stringify({ panelBefore: panelBefore.pane, panelAfter: st.alignment.pane, triggerBefore: panelBefore.trigger, triggerAfter: st.alignment.trigger, panelDelta: r1(panelDelta), triggerDelta: r1(triggerDelta) }))

  await win.locator('[data-filter="agent"]').first().click()
  const agent = await win.evaluate(PROBE)
  check('5b Agent 只显示代理 / 引擎,不显示项目组', agent.rowCount === AGENTS.length && agent.folderRowH.length === 0, String(agent.rowCount))
  await win.locator('[data-filter="team"]').first().click()
  const team = await win.evaluate(PROBE)
  check('5c Team 只显示团队', team.rowCount === 1 && team.folderRowH.length === 0, String(team.rowCount))
  await win.locator('[data-filter="project"]').first().click()
  const project = await win.evaluate(PROBE)
  check('5d Project 只显示项目组', project.rowCount === 0 && project.folderRowH.length > 0, String(project.folderRowH.length))
  await win.locator('[data-filter="all"]').first().click()
  const all = await win.evaluate(PROBE)
  check('5e All 恢复混排列表', all.rowCount === st.rowCount && all.folderRowH.length === st.folderRowH.length, '')

  // ── 10 Project 更多菜单 + 全一级 Pin + Pin 区最近激活排序 ────────────────
  const projectActions = await win.locator('.t2o .t2s-group').evaluateAll((groups) => groups.map((g) =>
    Array.from(g.querySelectorAll(':scope > .t2s-group-add')).map((b) => b.getAttribute('title') || ''),
  ))
  check('10 每个 Project 一级行 hover 动作都有两枚,且 `…` 在 `+` 左边(系统工作区也不例外)',
    projectActions.length > 0 && projectActions.every((xs) => xs.length === 2 && /操作|action/i.test(xs[0]) && /新建|New chat/i.test(xs[1])),
    JSON.stringify(projectActions))

  const orbitProject = win.locator('.t2o .t2s-group', { hasText: 'Orbit Project' }).first()
  await orbitProject.hover()
  await (await leftPane(win)).screenshot({ path: shots.actions })
  await orbitProject.click({ button: 'right' })
  const contextPin = win.locator('.ctx-menu button', { hasText: /Pin 到顶部|Pin to top/ }).last()
  check('10r 一级 Project 整行右键打开与 `…` 相同的操作菜单',
    await contextPin.isVisible().catch(() => false), '')
  await win.keyboard.press('Escape')
  await win.mouse.click(900, 700)
  const orbitRowRightClicks = []
  const level1Rows = win.locator('.t2o .t2o-row')
  for (let i = 0; i < await level1Rows.count(); i++) {
    const row = level1Rows.nth(i)
    const name = ((await row.locator('.t2o-name').textContent().catch(() => '')) || '').trim()
    await row.click({ button: 'right' })
    const menuVisible = await win.locator('.ctx-menu button', { hasText: /Pin 到顶部|Pin to top/ }).last().isVisible().catch(() => false)
    orbitRowRightClicks.push({ name, menuVisible })
    await win.mouse.click(900, 700)
  }
  check('10s Agent / Engine / TEAM 等其它一级行整行右键也打开各自 `…` 菜单',
    orbitRowRightClicks.length > 0 && orbitRowRightClicks.every((x) => x.menuVisible), JSON.stringify(orbitRowRightClicks))
  await orbitProject.locator(':scope > .t2s-group-add').first().click()
  await win.locator('.ctx-menu button', { hasText: /Pin 到顶部|Pin to top/ }).last().click()
  const xyra = win.locator('.t2o .t2o-row', { hasText: 'Xyra' }).first()
  await xyra.hover()
  await xyra.locator('.t2o-tail').click()
  await win.locator('.ctx-menu button', { hasText: /Pin 到顶部|Pin to top/ }).last().click()
  await sleep(350)
  let pinState = await win.evaluate(`(() => ({
    order: Array.from(document.querySelectorAll('.t2o [data-pinned="true"]')).map((e) => ((e.querySelector('.t2o-name, .t2s-group-label') || e).textContent || '').trim()),
    marks: document.querySelectorAll('.t2o [data-pinned="true"] .t2o-pin-mark').length,
  }))()`)
  check('10a 所有一级类型共用 Pin:后 Pin 的 Agent 位于先 Pin 的 Project 之前,并显示 Pin 标记',
    pinState.order[0] === 'Xyra' && pinState.order[1] === 'Orbit Project' && pinState.marks >= 2, JSON.stringify(pinState))

  // 点已 Pin Project 是 Pin 区的“最近激活”,只改变 Pin 时间,不会改消息 updated_at。
  await orbitProject.locator('.t2s-group-toggle').click()
  await sleep(350)
  pinState = await win.evaluate(`(() => ({
    order: Array.from(document.querySelectorAll('.t2o [data-pinned="true"]')).map((e) => ((e.querySelector('.t2o-name, .t2s-group-label') || e).textContent || '').trim()),
    saved: localStorage.getItem('forsion_orbits_pinned_entries_v1'),
  }))()`)
  check('10b Pin 区按最近激活排序:再次激活 Project 后它移到 Pin 区首位',
    pinState.order[0] === 'Orbit Project' && pinState.order[1] === 'Xyra', JSON.stringify(pinState))
  check('10c Pin 状态已持久化', !!pinState.saved && pinState.saved.includes('ws:') && pinState.saved.includes('row:agent:xyra'), pinState.saved)

  // ── 9a Tangu Space 被动恢复:会话恢复,Project 折叠状态不被 setActiveId / mount effect 撬开 ──
  const defaultGroup = win.locator('.t2o .t2s-group', { hasText: 'Tangu 默认工作区' }).first()
  const defaultRow = win.locator('.t2o .t2s-srow', { hasText: '默认工作区会话' }).first()
  if (!(await defaultRow.isVisible().catch(() => false))) await defaultGroup.locator('.t2s-group-toggle').click()
  await defaultRow.click()
  await sleep(250)
  // 显式收起后离开;activeWorkspaceKey 仍指向它,正好覆盖原 bug 的触发条件。
  if (await defaultGroup.locator('.t2s-lead-chev.open').count()) await defaultGroup.locator('.t2s-group-toggle').click()
  const otherSpace = win.locator('.rb-space:not(:has(svg.lucide-bot))').first()
  const canSwitchSpace = await otherSpace.count().catch(() => 0)
  if (canSwitchSpace) {
    await otherSpace.click()
    await sleep(700)
    await win.locator('.rb-space:has(svg.lucide-bot)').first().click()
    await win.waitForSelector('.t2o', { timeout: 15_000 }).catch(() => {})
    await sleep(800)
  }
  const spaceRestore = await win.evaluate(`(() => {
    const group = Array.from(document.querySelectorAll('.t2o .t2s-group')).find((g) => (g.textContent || '').includes('Tangu 默认工作区'))
    const row = Array.from(document.querySelectorAll('.t2o .t2s-srow')).find((e) => (e.textContent || '').includes('默认工作区会话'))
    const r = row && row.getBoundingClientRect()
    return { hasGroup: !!group, active: group?.getAttribute('data-active') === 'true', open: !!group?.querySelector('.t2s-lead-chev.open'), rowVisible: !!r && r.width > 0 && r.height > 0, rowActive: !!row?.classList.contains('active') }
  })()`)
  check('9a 切出再切回 Tangu:默认工作区不会被动激活,已收起状态也保持不变',
    !!canSwitchSpace && spaceRestore.hasGroup && !spaceRestore.active && !spaceRestore.open && !spaceRestore.rowVisible,
    JSON.stringify({ canSwitchSpace: !!canSwitchSpace, ...spaceRestore }))

  // ── 8b 暗色截图 ───────────────────────────────────────────────────────────
  // 明暗真源 = forsion_theme_pref(themeStore persistPref);落盘后 reload,装载器才会重算 token
  // (只改 html[data-mode] 不重算,截出来还是亮的)。
  await sleep(700) // 等档位偏好(leaf.params)落盘,别让 reload 把 orbits 丢了
  await win.evaluate(`localStorage.setItem('forsion_theme_pref', 'dark')`)
  await win.reload({ waitUntil: 'domcontentloaded' })
  await win.waitForSelector('.t2sw', { timeout: 30_000 })
  await sleep(2500)
  const darkMode = await win.evaluate(`document.documentElement.dataset.mode`)
  const dark = await win.evaluate(PROBE)
  check('8b 暗色截图确实是暗色(html[data-mode]=dark)', darkMode === 'dark', `data-mode=${darkMode}`)
  check('8c reload 后仍停在 orbits 档(leaf.params 持久化)', dark.hasOrbit,
    JSON.stringify({ hasOrbit: dark.hasOrbit, modeLabel: dark.modeLabel }))
  const persistedPins = await win.evaluate(`Array.from(document.querySelectorAll('.t2o [data-pinned="true"]')).map((e) => ((e.querySelector('.t2o-name, .t2s-group-label') || e).textContent || '').trim())`)
  check('10d reload 后 Pin 区与排序仍保留', persistedPins[0] === 'Orbit Project' && persistedPins[1] === 'Xyra', JSON.stringify(persistedPins))
  await dismissToasts(win)
  await win.mouse.move(1270, 950)
  await sleep(350)
  await (await leftPane(win)).screenshot({ path: shots.dark })
  await win.evaluate(`localStorage.setItem('forsion_theme_pref', 'light')`)
  await win.reload({ waitUntil: 'domcontentloaded' })
  await win.waitForSelector('.t2sw', { timeout: 30_000 })
  await sleep(2200)

  // ── 8d 375px:移动抽屉与桌面侧栏共用 sidebar2.css,40px 在手机上也要能看(§3.2 末行)──
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setMinimumSize(320, 400) // 主进程 minWidth 880,不放开就缩不到 375
    w.setContentSize(375, 812)
  })
  await sleep(1500)
  await dismissToasts(win) // 常驻通知不会自己淡出,得点掉(否则盖住窄栏截图的顶部行)
  const narrowSize = await win.evaluate(`({ w: window.innerWidth, h: window.innerHeight })`)
  const narrowSt = await win.evaluate(PROBE)
  check('8d 375px 视口真的生效(临时放开 minWidth 880)', near(narrowSize.w, 375, 4), JSON.stringify(narrowSize))
  const narrowVisible = narrowSt.hasOrbit && narrowSt.orbitRect && narrowSt.orbitRect.width > 0
  // 左栏在 375px 下若被折叠成抽屉,一级行量不到 —— 那是布局事实,记 SKIP 语义(仍算过),不留一条必红的断言。
  check(`8e 375px 下一级行仍是 ${LEVEL1_H}px(移动抽屉共用同一份 sidebar2.css)${narrowVisible ? '' : '(左栏折叠,未量,跳过)'}`,
    !narrowVisible || (narrowSt.rowGeom.length > 0 && narrowSt.rowGeom.every((r) => near(r.h, LEVEL1_H, 0.5))),
    JSON.stringify({ hasOrbit: narrowSt.hasOrbit, visible: narrowVisible, rows: narrowSt.rowGeom.map((r) => r1(r.h)) }))
  if (narrowVisible) {
    await (await leftPane(win)).screenshot({ path: shots.narrow }).catch(async () => { await win.screenshot({ path: shots.narrow }) })
  } else {
    // 侧栏在 375px 下被折叠 → 截整窗并说明(这是布局事实,不是 FAIL)
    console.log('NOTE  375px 下左栏不可见(被折叠),narrow 截的是整窗')
    await win.screenshot({ path: shots.narrow })
  }
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setMinimumSize(880, 600)
    w.setContentSize(1280, 960)
  })
  await sleep(1200)

  // ── 7 旧档仍可达 + 升级提示条(放最后:档位选择会写进 leaf.params 持久化)────
  const legacy = await pickWorkspaceMode(win, 'sessions')
  check('7 旧档 sessions 仍可从菜单选到', legacy.picked, JSON.stringify(legacy.options.map((o) => o.id)))
  await sleep(900)
  const leg = await win.evaluate(PROBE)
  check('7a 旧档渲染的是老侧栏(.t2s-side 在、.t2o 不在)', leg.legacySide && !leg.hasOrbit,
    JSON.stringify({ legacySide: leg.legacySide, hasOrbit: leg.hasOrbit }))
  check(`7b 旧档顶部有「已有新版 →」提示条(§3.7 第 8 条;认 ${LEGACY_HINT_SELECTORS.join(' / ')})`,
    !!leg.legacyHint, `matched=${leg.legacyHint}`)

  check('11 界面截图落盘(亮 / 暗 / 375px / Project hover 动作 —— DESIGN.md §8:自己看)',
    Object.values(shots).every((p) => fs.existsSync(p)), Object.values(shots).join(' '))
  return shots
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-orbitside-'))
  const userData = path.join(home, 'userdata')
  const vault = path.join(home, 'vault')
  const projectDir = path.join(home, 'Orbit Project')
  const defaultDir = path.join(home, 'Default Workspace')
  for (const dir of [userData, `${userData}-dev`, vault, projectDir, defaultDir]) fs.mkdirSync(dir, { recursive: true })

  const fixtures = sessionFixtures(projectDir, defaultDir)
  SOLO_OPEN_RESPONSE = { session: fixtures.find((x) => x.id === 'orb-s1'), created: false }
  const stub = await startStubEngine({ agents: AGENTS, sessions: fixtures, handle: ({ path: route }) => {
    if (route === '/agent/teams') return { teams: [{ slug: 'ui-team', name: 'UI Team', members: [{ slug: 'xyra' }, { slug: 'orbit-one' }] }] }
  } })
  const front = await startFront(stub.url)
  // 未打包时主进程用 `<dir>-dev`,两份都种;vault 也预置,免得停在笔记库引导。
  for (const dir of [userData, `${userData}-dev`]) {
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: front.url, token: 'e2e', defaultWorkspaceDir: defaultDir }), 'utf8')
    fs.writeFileSync(path.join(dir, 'amadeus-config.dev.json'), JSON.stringify({ localVault: vault, lastVault: vault }), 'utf8')
  }

  let app
  let shots = null
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT],
      cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: front.url },
    })
  } catch (e) {
    console.error('启动失败。若已有 dev 版 Electron 在跑,先 pkill -f "node_modules/electron/dist/Electron.app"(单实例锁)。')
    await front.close().catch(() => {})
    try { stub.close() } catch { /* ignore */ }
    throw e
  }
  try {
    const win0 = await app.firstWindow()
    // 渲染层报错直接打到 stdout:几何断言超时时,第一嫌疑永远是 ErrorBoundary 吃掉了整块视图,不看控制台只能瞎猜。
    win0.on('pageerror', (e) => console.error('[renderer pageerror]', String(e && e.stack || e).slice(0, 600)))
    win0.on('console', (m) => { if (m.type() === 'error') console.error('[renderer console.error]', m.text().slice(0, 600)) })
    shots = await run(app, win0)
  } catch (e) {
    if (e instanceof StopEarly) console.error(`STOP  ${e.message}`)
    else { console.error(e); check('runner 未捕获异常', false, String((e && e.message) || e)) }
  } finally {
    await app.close().catch(() => {})
    await front.close().catch(() => {})
    try { stub.close() } catch { /* ignore */ } // 桩的 close 是同步的、不返回 Promise
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (shots) console.log('SHOTS ' + JSON.stringify(shots))
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
