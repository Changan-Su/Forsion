/**
 * 「当前主区标签是谁」的两处判定 —— 真 Electron × 真 Space 切换 × 真磁盘。
 * 2026-09-16 两个既有 bug,同一个母题:树行高亮 / 导航历史读到了过期或错位的 mainTabs。
 *  S  切 Space 往返(探针时间线):fromJSON 途中的激活事件把 mainTabs 刷成终态,订阅方当场记下栈底 → applyNamed
 *     的 reset 随即清掉(setActiveSpace 结尾还清一次),之后再没有 mainTabs 变化触发记账,直接补 refreshTabs 也会被
 *     「无变化」短路 → 还原出来的文件视图没有栈底,就地开别的笔记后退不回来。用户在 899e4f98 上还见过往返后
 *     树上亮错行(mainTabs 过期);本机 470a501f 上 S2 修前也是绿的,只作守卫。
 *  T  点左侧栏**自己的标签头**:dockview activePanel 挪进侧栏 → mainTabs[].active 全 false → 树行回落 activePage。
 *
 *   S0 夹具:Alpha-note 占第一个标签,新标签页里从树上开 pic.png
 *   S1 切到 Agent 再切回 Note,pic.png 标签还原且在前台
 *   S2 树上亮的仍是 pic.png(守卫)                        S2b 还原后后退灰(没有从旧布局串来的条目)
 *   S3 ⚠️ 快速查找就地开 Beta-note → 后退可点              S4 ⚠️ 后退回到 pic.png
 *      高亮用图片验:仪表盘自己往 pageStore 里 loadPage,facade 的 activePage 碰巧就是它,回落也亮对行(测不出)。
 *      快速查找用 Beta:Alpha 已被第一个标签认领,openNote 会激活那个标签,不是就地打开。
 *   T1 前提:点左侧栏自己的标签头后活动组真的进了侧栏        T2 ⚠️ 树上仍亮 pic.png
 *   D  用户实报那条原样:新标签页开 Dash-one → 往返 → D1 ⚠️ 就地开 Beta 后后退可点  D2 ⚠️ 后退回到 Dash-one
 *   T3 夹具:分屏,左组 pic2.png、右组 pic.png   T4 ⚠️ 右组聚焦后点侧栏标签头,树上仍亮右组的 pic.png
 *   T5 ⚠️ 右组聚焦后从树上开笔记,开进右组
 *      (Codex 评审:activeMainPanel 在焦点离开主区时回落到 panels 里第一组 = 左组;高亮和「开在哪组」同一个根因。
 *       ⚠️ 点树行时焦点会离开主区,所以夹具只点标签头,否则夹具本身就随修没修而变 —— 实测)
 *
 * 用法:npm run build && node scripts/active-tab.e2e.cjs   (--shot 存截图到 /tmp/forsion-activetab-*.png)
 * 启动骨架照抄 dashboard-nav.e2e.cjs。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const SHOT = process.argv.includes('--shot')
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-activetab-'))
  const userData = path.join(home, 'userdata')
  const vault = path.join(home, 'Vault')
  fs.mkdirSync(vault, { recursive: true })
  fs.writeFileSync(path.join(vault, 'Alpha-note.md'), '# Alpha\n\n正文。\n', 'utf8')
  fs.writeFileSync(path.join(vault, 'Beta-note.md'), '# Beta\n\n正文。\n', 'utf8')
  fs.writeFileSync(path.join(vault, 'Dash-one.dashboard.md'), '---\ntitle: Dash-one\n---\n', 'utf8')
  fs.writeFileSync(path.join(vault, 'pic.png'), Buffer.from(PNG_1PX, 'base64'))
  fs.writeFileSync(path.join(vault, 'pic2.png'), Buffer.from(PNG_1PX, 'base64'))
  // ⚠️ 四份配置全种:未打包时 userData 是 `<dir>-dev`,只种一份会打开本机真 dev 库。
  for (const dir of [userData, `${userData}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) {
      fs.writeFileSync(path.join(dir, f), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2), 'utf8')
    }
  }

  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT],
      cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
    })
    const win = await app.firstWindow()
    const logs = []
    win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
    const shot = async (name) => { if (SHOT) await win.screenshot({ path: `/tmp/forsion-activetab-${name}.png` }).catch(() => {}) }

    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    const space = (title) => win.locator(`.rb-space[title="${title}"]`).first().click({ timeout: 15_000 })
    await space('Note')
    await win.waitForSelector('.t2s-srow:has-text("Dash-one")', { timeout: 20_000 })

    /** 读 DOM,不信 store 自证。箭头取第一组(主区)。 */
    const state = () => win.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
      const btns = [...document.querySelectorAll('.dv-nav-btn')]
      const group = document.querySelector('.dv-groupview.dv-active-group')
      return {
        tabs: [...document.querySelectorAll('.dv-tab')].filter(vis).map((e) => (e.textContent || '').trim()),
        active: [...document.querySelectorAll('.dv-tab.dv-active-tab')].filter(vis).map((e) => (e.textContent || '').trim()),
        row: [...document.querySelectorAll('.t2s-srow.active')].map((e) => (e.textContent || '').trim()),
        back: !!btns[0] && !btns[0].disabled,
        sideGroup: !!group && !!group.querySelector('.t2s-search'),
        groups: [...document.querySelectorAll('.dv-groupview')].filter((g) => g.querySelector('.dv-nav-btn')).length,
      }
    })
    const until = async (pred, ms = 8000) => {
      const end = Date.now() + ms
      let s = await state()
      while (!pred(s) && Date.now() < end) { await win.waitForTimeout(150); s = await state() }
      return s
    }
    const openRow = (name) => win.locator('.t2s-srow', { hasText: name }).first().click()
    const shows = (name) => (s) => s.active.some((x) => x.includes(name))
    const rowIs = (name) => (s) => s.row.length === 1 && s.row[0].includes(name)

    const roundTrip = async () => { await space('Agent'); await win.waitForTimeout(2500); await space('Note') }
    const quickOpen = async (q) => {
      await win.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P')
      await win.waitForSelector('.amx-qf-input', { timeout: 8000 })
      await win.locator('.amx-qf-input').fill(q)
      await win.waitForTimeout(600)
      await win.keyboard.press('Enter')
    }
    const back = () => win.locator('.dv-nav-btn').first().click({ timeout: 3000 }).catch(() => {})

    // ── S 切 Space 往返:还原出来的前台文件视图 ─────────────────────────────
    await openRow('Alpha-note')
    await until((s) => shows('Alpha')(s) && rowIs('Alpha-note')(s), 15_000)
    await win.click('.dv-new-tab')
    await win.waitForTimeout(800)
    await openRow('pic.png')
    const s0 = await until((s) => shows('pic')(s) && rowIs('pic.png')(s), 15_000)
    check('S0 夹具:Alpha-note 占第一个标签,新标签页里从树上开 pic.png,树上亮它', shows('pic')(s0) && rowIs('pic.png')(s0), JSON.stringify(s0))

    await roundTrip()
    const s1 = await until(shows('pic'), 15_000)
    check('S1 切到 Agent 再切回 Note:pic.png 标签还原且在前台', shows('pic')(s1), JSON.stringify(s1))
    await win.waitForTimeout(1500)
    const s2 = await state()
    await shot('s2-after-roundtrip')
    check('S2 往返后树上亮的仍是 pic.png(守卫:mainTabs 过期就会回落 activePage 亮成 Alpha)', rowIs('pic.png')(s2), JSON.stringify(s2))
    check('S2b 还原后后退箭头灰(栈里只有栈底,没有从旧布局串来的条目)', !s2.back, JSON.stringify(s2))

    await quickOpen('Beta')
    const s3 = await until((s) => shows('Beta')(s) && s.back, 8000)
    check('⚠️S3 快速查找就地开 Beta-note → 后退可点(修前:还原出的文件视图没有栈底,后退恒灰)',
      shows('Beta')(s3) && s3.back && s3.tabs.length === s2.tabs.length, JSON.stringify(s3))
    await back()
    const s4 = await until((s) => shows('pic')(s) && rowIs('pic.png')(s), 8000)
    check('⚠️S4 后退回到 pic.png,树行跟着亮', shows('pic')(s4) && rowIs('pic.png')(s4), JSON.stringify(s4))

    // ── T 点左侧栏自己的标签头 ────────────────────────────────────────────
    await openRow('pic.png') // 前提自己备好:S 段修前会停在 Beta,不能让 T2 替 S 背锅
    const t0 = await until((s) => shows('pic')(s) && rowIs('pic.png')(s), 10_000)
    check('T0 夹具:主区前台是 pic.png,树上亮它', shows('pic')(t0) && rowIs('pic.png')(t0), JSON.stringify(t0))
    await win.locator('.dv-groupview:has(.t2s-search) .dv-tab').first().click()
    const t1 = await until((s) => s.sideGroup, 3000)
    check('T1 前提:点侧栏标签头后活动组真的进了侧栏(否则 T2 测不到东西)', t1.sideGroup, JSON.stringify(t1))
    await win.waitForTimeout(800)
    const t2 = await state()
    await shot('t2-sidebar-header')
    check('⚠️T2 树上仍亮 pic.png,主区照旧是 pic.png(修前:回落 activePage 亮成笔记)', rowIs('pic.png')(t2) && shows('pic')(t2), JSON.stringify(t2))

    // ── D 用户实报原样:往返后还原出来的仪表盘 ─────────────────────────────
    await win.click('.dv-new-tab')
    await win.waitForTimeout(800)
    await openRow('Dash-one')
    const d0 = await until((s) => shows('Dash-one')(s) && rowIs('Dash-one')(s), 15_000)
    check('D0 夹具:新标签页里从树上开 Dash-one', shows('Dash-one')(d0) && rowIs('Dash-one')(d0), JSON.stringify(d0))
    await roundTrip()
    await until(shows('Dash-one'), 15_000)
    await win.waitForTimeout(1500)
    const d0b = await state()
    check('D0b 往返后树上亮 Dash-one(仪表盘会把自己 loadPage 进 facade,修前也可能碰巧亮对,只作对照)', rowIs('Dash-one')(d0b), JSON.stringify(d0b))
    await quickOpen('Beta')
    const d1 = await until((s) => shows('Beta')(s) && s.back, 8000)
    check('⚠️D1 往返后在仪表盘标签里就地开 Beta-note → 后退可点', shows('Beta')(d1) && d1.back, JSON.stringify(d1))
    await back()
    const d2 = await until((s) => shows('Dash-one')(s) && rowIs('Dash-one')(s), 8000)
    check('⚠️D2 后退回到 Dash-one,树行跟着亮', shows('Dash-one')(d2) && rowIs('Dash-one')(d2), JSON.stringify(d2))

    // ── T3–T5 分屏:焦点离开主区时认「最后聚焦的主区组」──────────────────────
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    const leftRight = (l, r) => (s) => s.active.includes(l) && s.active.includes(r) && s.active.indexOf(l) < s.active.indexOf(r)
    // ⚠️ 夹具全程只点标签头:分屏期间点树行,焦点会离开主区、落哪组本身就随修没修而变(实测)
    await win.click('.dv-new-tab')
    await win.waitForTimeout(800)
    await openRow('pic2.png') // 单组里新标签开 pic2.png
    await until(shows('pic2.png'), 8000)
    await win.locator('.dv-tab', { hasText: 'pic.png' }).first().click()
    await until(shows('pic.png'), 5000)
    await win.keyboard.press(`${mod}+Backslash`) // 右组 = pic.png 的副本
    await until((s) => s.groups >= 2, 5000)
    await win.locator('.dv-tab', { hasText: 'pic2.png' }).first().click() // 左组前台换成 pic2.png
    const t3 = await until((s) => s.groups >= 2 && leftRight('pic2.png', 'pic.png')(s), 10_000)
    check('T3 夹具:主区分成两组,左组 pic2.png、右组 pic.png', t3.groups >= 2 && leftRight('pic2.png', 'pic.png')(t3), JSON.stringify(t3))
    const focusRight = async () => { await win.locator('.dv-tab', { hasText: 'pic.png' }).last().click(); await win.waitForTimeout(400) }
    await focusRight()
    await until(rowIs('pic.png'), 5000)
    await win.locator('.dv-groupview:has(.t2s-search) .dv-tab').first().click()
    const t4a = await until((s) => s.sideGroup, 3000)
    await win.waitForTimeout(800)
    const t4 = await state()
    await shot('t4-split-sidebar-header')
    check('⚠️T4 分屏时右组聚焦、再点侧栏标签头,树上仍亮右组的 pic.png(修前:回落成 panels 里第一组 = 左组的 pic2.png)',
      t4a.sideGroup && rowIs('pic.png')(t4), JSON.stringify(t4))
    await focusRight()
    await openRow('Beta-note')
    const t5 = await until(leftRight('pic2.png', 'Beta-note'), 8000)
    check('⚠️T5 分屏时右组聚焦,从树上开笔记 → 就地开进右组(修前:同一个回落,开进了左组)', leftRight('pic2.png', 'Beta-note')(t5), JSON.stringify(t5))

    if (logs.length) console.log('LOGS\n' + logs.slice(0, 10).join('\n'))
  } finally {
    await app?.close().catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed} passed / ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
