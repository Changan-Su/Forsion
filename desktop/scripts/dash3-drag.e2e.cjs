/**
 * 仪表盘拖拽启动链的**真 Electron** 探针(用户报「编辑布局下卡片完全拖不动」,web harness 60/60 全绿)。
 *
 * 双路自适应:走真实「新建仪表盘」流程,挂出哪个版本就测哪个版本的拖拽 ——
 *  · dash2(自由画布):解锁 → 罩层拖动 → 断言 data-dragging + 磁盘 dashboard2 矩形变化;
 *  · dash3(结构化网格):模板成型 → 编辑布局 → **整卡罩层**拖动(画布同款,双击才进卡片)→
 *    断言占位/跟手壳/磁盘 dashboard3 顺序变化。
 * 两路都倾倒观测:命中栈(elementFromPoint)、有效 zoom、控制台错误、截图。
 *
 * 背景:blankDashboard 曾种 dashboard2: 出厂键 → 真机新建全部路由进画布版(当时实证 dash3=0
 * dash2=1),已修(出厂空 = 网格默认)。C 支保留作画布回归哨兵:若再走到 C0 必红。
 *
 * 用法:npm run build && node scripts/dash3-drag.e2e.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok }) // ⚠️ !!ok:短路 null 不许算「非失败」(gui-verify §3.1b)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-dash3drag-'))
  const vaultDir = path.join(home, 'vault')
  fs.mkdirSync(vaultDir, { recursive: true })
  const udDev = path.join(home, 'userdata-dev')
  fs.mkdirSync(udDev, { recursive: true })
  fs.writeFileSync(
    path.join(udDev, 'amadeus-config.dev.json'),
    JSON.stringify({ lastVault: vaultDir, localVault: vaultDir }, null, 2),
  )

  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
  })
  try {
    const win = await app.firstWindow()
    const logs = []
    win.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`) })
    win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    await win.waitForTimeout(1500)

    // vaultRoot 要等笔记面首次挂载才落地(daily-template 同款)
    await win.click('.dv-new-tab')
    await win.waitForSelector('.newtab', { timeout: 15_000 })
    await win.waitForTimeout(600)
    await win.locator('.newtab-card', { hasText: /^新建笔记$|^New note$/ }).first().click()
    await win.waitForTimeout(2500)

    // 新建仪表盘(真实用户路径)
    await win.click('.dv-new-tab')
    await win.waitForSelector('.newtab', { timeout: 15_000 })
    await win.waitForTimeout(600)
    const card = win.locator('.newtab-card', { hasText: /^新建仪表盘$|^New dashboard$/ }).first()
    if (!(await card.count().catch(() => 0))) {
      const labels = await win.evaluate(() => [...document.querySelectorAll('.newtab-card-label')].map((e) => e.textContent))
      throw new Error(`启动器里找不到「新建仪表盘」(vaultRoot 没落地?),现有:${JSON.stringify(labels)}`)
    }
    await card.click()
    // createDashboard 先弹命名对话框(askString,默认「未命名仪表盘」)→ 回车接受默认名
    await win.waitForTimeout(800)
    await win.keyboard.press('Enter')
    await win.waitForTimeout(3000)

    const dash3N = await win.locator('.dash3-host').count()
    const dash2N = await win.locator('.dash2-host').count()
    console.log(`ROUTE  新建仪表盘挂载:dash3=${dash3N} dash2=${dash2N}`)
    const diskFile = () => {
      const f = fs.readdirSync(vaultDir).find((n) => n.endsWith('.dashboard.md'))
      return f ? fs.readFileSync(path.join(vaultDir, f), 'utf8') : ''
    }

    if (dash2N > 0) {
      // ── 画布支(现状):测用户此刻真实拿到的东西 ─────────────────────────────
      check('C0 新建仪表盘落在画布版(与「默认结构化网格」的拍板相反 —— 这本身是 bug)', false,
        '路由证据:dashboard2 出厂键')
      const env0 = await win.evaluate(() => {
        const host = document.querySelector('.dash2-host')
        const grid = host
        const zoom = grid && grid.offsetWidth > 0 ? grid.getBoundingClientRect().width / grid.offsetWidth : 1
        return { hostW: host?.clientWidth ?? 0, narrow: (host?.clientWidth ?? 0) < 720, zoom: zoom.toFixed(3), cards: document.querySelectorAll('.dash2-card').length, shields: document.querySelectorAll('.dash2-shield').length }
      })
      console.log('OBS  canvas env:', JSON.stringify(env0))
      check('C1 画布卡片渲染且有罩层(拖动面)', env0.cards >= 2 && env0.shields >= 2, JSON.stringify(env0))
      check('C1b 宿主不窄(narrow 会静默禁拖)', !env0.narrow, `hostW=${env0.hostW}`)

      await win.locator('.amx-toolbar button[title^="解锁编辑"]').click()
      await win.waitForTimeout(600)

      const hit = await win.evaluate(() => {
        const cardEl = [...document.querySelectorAll('.dash2-card')][1] ?? document.querySelector('.dash2-card')
        if (!cardEl) return null
        const r = cardEl.getBoundingClientRect()
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        const top = document.elementFromPoint(cx, cy)
        return {
          key: cardEl.dataset.key, cx, cy,
          shieldOnTop: !!(top && top.classList.contains('dash2-shield')),
          stack: document.elementsFromPoint(cx, cy).slice(0, 4).map((el) => `${el.tagName.toLowerCase()}.${typeof el.className === 'string' ? el.className.split(' ').slice(0, 2).join('.') : ''}`),
        }
      })
      console.log('OBS  canvas hit:', JSON.stringify(hit))
      check('C2 解锁后卡中心命中的是罩层(拖动面没被别的层盖住)', hit && hit.shieldOnTop,
        hit ? hit.stack.join(' > ') : 'no card')

      const before = diskFile()
      await win.mouse.move(hit.cx, hit.cy)
      await win.mouse.down()
      let draggingSeen = false
      for (let i = 1; i <= 12; i++) {
        await win.mouse.move(hit.cx + i * 12, hit.cy + i * 8)
        await win.waitForTimeout(24)
        if (i === 8) {
          draggingSeen = (await win.locator('.dash2-card[data-dragging]').count()) > 0
          await win.screenshot({ path: '/tmp/forsion-dash2drag-mid.png' }).catch(() => {})
        }
      }
      await win.mouse.up()
      await win.waitForTimeout(1500)
      check('C3 画布拖动启动了(data-dragging)', draggingSeen)
      const after = diskFile()
      check('C4 画布拖动落盘(dashboard2 矩形变了)', after !== before && /dashboard2:/.test(after),
        (after.match(/"2": \[[^\]]*\]/) ?? ['?'])[0])
      await win.screenshot({ path: '/tmp/forsion-dash2drag-after.png' }).catch(() => {})
    }

    if (dash3N > 0) {
      // ── 网格支(修复后应走这里)────────────────────────────────────────────
      check('E1 新建仪表盘落在结构化网格版(拍板的默认)', true)
      const tpl = win.locator('.dash3-template', { hasText: '今日' }).first()
      check('E2 空仪表盘给出模板', !!(await tpl.count().catch(() => 0)))
      await tpl.click()
      await win.waitForTimeout(2500)
      const cardsN = await win.locator('.dash3-card').count()
      check('E3 模板成型(卡片落下来了)', cardsN >= 4, `cards=${cardsN}`)

      const editBtn = win.locator('.amx-toolbar button[title^="编辑布局"]')
      if (await editBtn.count()) { await editBtn.click(); await win.waitForTimeout(800) }
      const handles = await win.locator('.dash3-shield').count()
      check('E4 解锁后每张卡都有整卡拖拽罩层(画布同款)', handles >= 4, `shields=${handles}`)

      const probe = await win.evaluate(() => {
        const grid = document.querySelector('.dash3-grid')
        const zoom = grid && grid.offsetWidth > 0 ? grid.getBoundingClientRect().width / grid.offsetWidth : 1
        const hs = [...document.querySelectorAll('.dash3-card .dash3-shield')]
        const out = hs.slice(0, 4).map((h) => {
          const r = h.getBoundingClientRect()
          const cx = r.left + r.width / 2
          const cy = r.top + r.height / 2
          const hitEl = document.elementFromPoint(cx, cy)
          return {
            key: h.closest('.dash3-card')?.dataset.key,
            cx: Math.round(cx), cy: Math.round(cy),
            covered: !(hitEl === h || h.contains(hitEl)),
            stack: document.elementsFromPoint(cx, cy).slice(0, 4).map((el) => `${el.tagName.toLowerCase()}.${typeof el.className === 'string' ? el.className.split(' ').slice(0, 2).join('.') : ''}`),
          }
        })
        return { zoom: zoom.toFixed(3), handles: out }
      })
      console.log('OBS  grid env: zoom=', probe.zoom, JSON.stringify(probe.handles))
      check('E5 罩层没有被别的层盖住(elementFromPoint 命中罩层自身)',
        probe.handles.length > 0 && probe.handles.every((h) => !h.covered),
        probe.handles.filter((h) => h.covered).map((h) => `${h.key}:${h.stack.join('>')}`).join(' | ') || 'clean')

      const pick = await win.evaluate(() => {
        const cards = [...document.querySelectorAll('.dash3-card')].filter((c) => !c.classList.contains('dash3-card--chrome'))
        if (cards.length < 2) return null
        const h = cards[0].querySelector('.dash3-shield')
        const hr = h.getBoundingClientRect()
        const br = cards[1].getBoundingClientRect()
        return { hx: hr.left + hr.width / 2, hy: hr.top + hr.height / 2, tx: br.left + br.width / 2, ty: br.top + br.height / 2 }
      })
      if (!pick) throw new Error('卡片不足两张,拖不成')
      const before = diskFile()
      await win.mouse.move(pick.hx, pick.hy)
      await win.mouse.down()
      let draggingSeen = false
      for (let i = 1; i <= 14; i++) {
        await win.mouse.move(pick.hx + ((pick.tx - pick.hx) * i) / 14, pick.hy + ((pick.ty - pick.hy) * i) / 14)
        await win.waitForTimeout(24)
        if (i === 8) {
          draggingSeen = (await win.locator('.dash3-card[data-dragging]').count()) > 0
          await win.screenshot({ path: '/tmp/forsion-dash3drag-mid.png' }).catch(() => {})
        }
      }
      const overlaySeen = (await win.locator('.dash3-card--lift').count()) > 0
      await win.mouse.up()
      await win.waitForTimeout(1500)
      check('E6 拖动启动了(data-dragging 占位出现)', draggingSeen)
      check('E7 拖动中有跟手壳(DragOverlay)', overlaySeen)
      const after = diskFile()
      check('E8 顺序真的变了且**落进磁盘文件**(不是只有画面动)',
        after !== before && /dashboard3:/.test(after), '')
      await win.screenshot({ path: '/tmp/forsion-dash3drag-after.png' }).catch(() => {})
    }

    if (!dash2N && !dash3N) check('E0 仪表盘视图挂载', false, '两个版本都没挂出来')
    if (logs.length) console.log('CONSOLE(warn/error 前 20 条):\n' + logs.slice(0, 20).join('\n'))
  } finally {
    await app.close().catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
  }

  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
